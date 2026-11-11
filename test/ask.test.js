'use strict';
// Question answering: refusals, follow-ups, extraction grammar and semantic guard rails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server.js');

const CORPUS = path.join(__dirname, '..', 'uat', 'corpus');
const H = { 'x-pacrag': '1', 'content-type': 'application/json' };

async function boot(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-ask-'));
  const app = await start({ port: 0, dataDir: dir, answerer: null, embedder: null, ...opts });
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${app.port}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const ask = async (q, history) => (await call('POST', '/api/ask', history ? { q, history } : { q })).body;
  const note = async (text, title) => (await call('POST', '/api/items', { type: 'note', text, title })).body;
  const corpus = async () => {
    for (const f of fs.readdirSync(CORPUS).filter((n) => n !== 'sample.pdf' && n !== 'ambiguous.txt')) {
      await fetch(`http://127.0.0.1:${app.port}/api/upload?name=${encodeURIComponent(f)}`, { method: 'POST', headers: { 'x-pacrag': '1' }, body: fs.readFileSync(path.join(CORPUS, f)) });
    }
  };
  return { app, call, ask, note, corpus, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const prior = (q) => [{ role: 'user', content: q }, { role: 'assistant', content: 'ok' }];

test('a follow-up is refused when its new words appear in no passage', async () => {
  const t = await boot();
  try {
    await t.corpus();
    const gym = await t.ask('and the gym membership?', prior('When can the tenant break the lease?'));
    assert.equal(gym.mode, 'none');
    assert.match(gym.answer, /read that as a follow-up/);
    const notice = await t.ask('what about the notice period?', prior('When can the tenant break the lease?'));
    assert.notEqual(notice.mode, 'none');
    assert.match(notice.sources[0].title, /^lease-/);
  } finally { await t.done(); }
});

test('passages that share no word with the question are not quoted as answers', async () => {
  const t = await boot();
  try {
    await t.note('Staff must submit forms by Friday. Guests pay at the gate.', 'Visitor parking');
    const r = await t.ask('visitor badges?');
    assert.equal(r.mode, 'none');
    assert.doesNotMatch(r.answer, /Staff must submit/);
  } finally { await t.done(); }
});

test('a question about a topic that is in the text is answered by quoting it', async () => {
  const t = await boot();
  try {
    await t.note('Dentist appointment on 3 March at 9am. Bring the insurance card.', 'Dentist');
    const r = await t.ask('find the dates for the dentist');
    assert.notEqual(r.mode, 'none', 'the word "find" must not block the answer');
    assert.match(r.answer, /3 March/);
  } finally { await t.done(); }
});

test('extract refuses topic-restricted requests with help, and never returns an unfiltered table for them', async () => {
  const t = await boot();
  try {
    await t.note('The dentist quoted 1,200 dollars for the cleaning.', 'Dentist');
    const r = await t.ask('extract the cost of the dentist appointment');
    assert.equal(r.mode, 'help');
    assert.equal(r.rows, undefined);
    const plain = await t.ask('extract the rent amounts');
    assert.equal(plain.mode, 'extract', 'a plain modifier is still a table');
  } finally { await t.done(); }
});

test('qualifiers a table cannot apply are explained, for extract and for the list verbs', async () => {
  const t = await boot();
  try {
    await t.note('Invoice 4411 for 250 USD is due 1 May 2026.', 'Invoice');
    for (const q of ['list amounts over 1000', 'extract amounts over 1000', 'extract dates in 2026']) {
      const r = await t.ask(q);
      assert.equal(r.mode, 'help', q);
      assert.match(r.answer, /cannot filter/, q);
    }
    assert.equal((await t.ask('extract amounts')).mode, 'extract');
  } finally { await t.done(); }
});

test('a scope that matches several rooms asks which one, rather than picking the first', async () => {
  const t = await boot();
  try {
    const a = await t.note('Monthly service charge is 50 dollars for the admin office.', 'Admin');
    const b = await t.note('Annual rent is 1,200 dollars for the flat.', 'Rent');
    await t.call('PATCH', `/api/items/${a.id}`, { category: 'Lease Admin' });
    await t.call('PATCH', `/api/items/${b.id}`, { category: 'Lease & Rent' });
    const r = await t.ask('extract amounts from lease');
    assert.equal(r.mode, 'help');
    assert.match(r.answer, /Lease Admin/);
    assert.match(r.answer, /Lease & Rent/);
  } finally { await t.done(); }
});

test('the refusal names the missing words without blaming request verbs or "number"', async () => {
  const t = await boot();
  try {
    await t.note('Call the surgery on 020 7946 0958 for an appointment.', 'Dentist');
    const r = await t.ask('what are the phone numbers for the dentist');
    assert.equal(r.mode, 'none');
    assert.doesNotMatch(r.answer, /“number”|“find”|“list”/);
    assert.match(r.answer, /extract phones/);
  } finally { await t.done(); }
});

// Deterministic: one dimension per synonym group, so 'doctor' and 'dentist' share a dimension.
const MEANING = [['health', 'dentist', 'doctor', 'gym', 'clinic'], ['food', 'pasta', 'carbonara', 'dinner']];
const byMeaning = { model: 'meaning', async embed(texts) { return texts.map((t) => { const w = t.toLowerCase().match(/[a-z]+/g) || []; return MEANING.map((g) => w.filter((x) => g.includes(x)).length); }); } };
async function waitReady(t) { for (let i = 0; i < 200; i++) { if ((await t.call('GET', '/api/status')).body.semantic === 'ready') return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('semantic index never became ready'); }

test('a passage found only by meaning is quoted, with a note saying so', async () => {
  const t = await boot({ embedder: byMeaning });
  try {
    await t.note('Dentist appointment on 3 March at 9am.', 'Dentist');
    await t.note('Pasta carbonara with guanciale.', 'Pasta');
    await waitReady(t);
    const r = await t.ask('doctor visit?');
    assert.match(r.answer, /3 March/);
    assert.match(r.note, /matched by meaning/);
  } finally { await t.done(); }
});

test('a one-note library still finds a passage by meaning (a single score is not a flat ranker)', async () => {
  const t = await boot({ embedder: byMeaning });
  try {
    await t.note('Dentist appointment on 3 March at 9am.', 'Dentist');
    await waitReady(t);
    assert.match((await t.ask('doctor visit?')).answer, /3 March/);
  } finally { await t.done(); }
});

test('semantic results cannot switch off the refusal for questions with no lexical match', async () => {
  // Scores every passage alike, the worst case for a semantic ranker. Passages found by meaning alone may be quoted,
  // but only when they say something; a sentence with no shared word is not invented into an answer.
  const flat = { model: 'flat', async embed(texts) { return texts.map(() => [1, 0, 0]); } };
  const t = await boot({ embedder: flat });
  try {
    await t.note('Staff must submit forms by Friday.', 'Office');
    await t.note('Guests pay at the gate.', 'Gate');
    for (let i = 0; i < 50; i++) { if ((await t.call('GET', '/api/status')).body.semantic === 'ready') break; await new Promise((r) => setTimeout(r, 50)); }
    const r = await t.ask('gym membership?');
    assert.equal(r.mode, 'none');
    assert.doesNotMatch(r.answer || '', /Staff must submit/);
  } finally { await t.done(); }
});
