'use strict';
// Regression tests for defects found in UAT round 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start, chunk, htmlToText } = require('../server.js');

const CORPUS = path.join(__dirname, '..', 'uat', 'corpus');
const H = { 'x-pacrag': '1', 'content-type': 'application/json' };

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-'));
  const app = await start({ port: 0, dataDir: dir, answerer: null });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data };
  };
  const note = (text) => call('POST', '/api/items', { type: 'note', text });
  const ask = (q, history) => call('POST', '/api/ask', { q, history }).then((r) => r.body);
  const upload = (name, buf) => call('POST', `/api/upload?name=${encodeURIComponent(name)}`, buf, { 'x-pacrag': '1' });
  const corpus = async () => { for (const f of fs.readdirSync(CORPUS).filter((n) => n !== 'sample.pdf' && n !== 'ambiguous.txt')) await upload(f, fs.readFileSync(path.join(CORPUS, f))); };
  return { app, call, note, ask, upload, corpus, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const timed = (fn) => { const t = Date.now(); const r = fn(); return [r, Date.now() - t]; };

test('hostile HTML is converted in linear time', () => {
  for (const evil of ['<script '.repeat(30000), '< '.repeat(100000), '<p'.repeat(100000), '<title '.repeat(30000), '<script>'.repeat(30000), '&amp'.repeat(100000)]) {
    const [, ms] = timed(() => htmlToText(evil));
    assert.ok(ms < 500, `took ${ms} ms on ${evil.slice(0, 12)}…`);
  }
  assert.equal(htmlToText('<p>caf&eacute; &euro;5 &#8364; &#x41;</p>').text, 'café €5 € A');
  assert.equal(htmlToText('<style>p{}</style><!-- hidden --><p>shown</p>').text, 'shown');
});

test('chunking splits long paragraphs at spaces, not mid-value', () => {
  const text = `${'word '.repeat(150)}$1,200 ${'word '.repeat(150)}`;
  for (const c of chunk(text)) assert.ok(!/\$1$|^,200/.test(c));
  assert.ok(chunk(text).join(' ').includes('$1,200'));
});

test('an unrelated short question stands alone, a follow-up borrows the last one', async () => {
  const t = await boot();
  try {
    await t.corpus();
    const hist = [{ role: 'user', content: 'When can the tenant break the lease?' }, { role: 'assistant', content: 'ok' }];
    assert.equal((await t.ask('What is the capital of Mongolia?', hist)).mode, 'none');
    const follow = await t.ask('what about the notice period?', hist);
    assert.match(follow.sources[0].title, /^lease-/);
    assert.ok(!follow.sources.some((s) => s.title === 'lisbon-trip.txt'), 'filler word "about" must not pull in the trip');
  } finally { await t.done(); }
});

test('the sentence that best answers leads the local answer', async () => {
  const t = await boot();
  try {
    await t.corpus();
    const r = await t.ask('When can the tenant break the lease?');
    assert.match(r.answer.split('\n')[0], /break the lease on 30 June 2027/);
    assert.ok(Array.isArray(r.terms) && r.terms.includes('break'));
  } finally { await t.done(); }
});

test('extraction handles real-world formats and rejects look-alikes', async () => {
  const t = await boot();
  try {
    await t.note('Dates: 5 Jan 26, 5-Jan-2026, 2026/01/05, Mar 2026, 12.09.2026 and June 30, 2027. Not dates: 13/13/2026, 99/99/99, 2026-13-45.');
    const d = (await t.ask('extract dates')).rows.map((r) => r.value);
    for (const ok of ['5 Jan 26', '5-Jan-2026', '2026/01/05', 'Mar 2026', '12.09.2026', 'June 30, 2027']) assert.ok(d.includes(ok), `${ok} missing from ${d.join('|')}`);
    for (const bad of ['13/13/2026', '99/99/99', '2026-13-45']) assert.ok(!d.includes(bad), `${bad} wrongly accepted`);

    await t.note('Prices: US$5, A$5, 5 USD, ¥500, S$1,200, USD 3.5m, 5%, -$5 and 4 per square foot. Version 1.2.3 is free.');
    const a = (await t.ask('extract amounts')).rows.map((r) => r.value);
    for (const ok of ['US$5', 'A$5', '5 USD', '¥500', 'S$1,200', 'USD 3.5m', '5%', '-$5', '4 per square foot']) assert.ok(a.includes(ok), `${ok} missing from ${a.join('|')}`);

    await t.note('Call (020) 7946 0958, +65 6123 4567, 415-555-2671 or 6123 4567. Not phones: 192.168.1.1, 3.14159265358979, 100 200 300 400, 2026-01-05 12345.');
    const p = (await t.ask('extract phone numbers')).rows.map((r) => r.value);
    for (const ok of ['(020) 7946 0958', '+65 6123 4567', '415-555-2671', '6123 4567']) assert.ok(p.includes(ok), `${ok} missing from ${p.join('|')}`);
    assert.equal(p.length, 4, p.join('|'));

    await t.note('See https://wiki.org/a_(b) and (https://example.com/x), also www.example.org. Mail é@ü.com or bob_smith@example.co.uk.');
    const l = (await t.ask('extract links')).rows.map((r) => r.value);
    assert.ok(l.includes('https://wiki.org/a_(b)') && l.includes('https://example.com/x') && l.includes('www.example.org'), l.join('|'));
    const e = (await t.ask('extract emails')).rows.map((r) => r.value);
    assert.ok(e.includes('é@ü.com') && e.includes('bob_smith@example.co.uk'), e.join('|'));
    const one = await t.ask('extract dates and amounts');
    assert.match(one.note, /only/);
  } finally { await t.done(); }
});

test('extraction scope needs "from", ignores category names that look like kinds, and says when a category is unknown', async () => {
  const t = await boot();
  try {
    const n = (await t.note('amounts total 5 USD for the quarter and the budget is $9')).body;
    await t.call('PATCH', `/api/items/${n.id}`, { category: 'Amount' });
    const all = await t.ask('extract amounts');
    assert.equal(all.rows.length >= 2, true, JSON.stringify(all.rows));
    assert.equal((await t.ask('extract amounts from amount')).category, 'Amount');
    assert.equal((await t.ask('extract amounts from lease')).mode, 'help');
    assert.equal((await t.ask('extract amounts in 2026')).mode, 'extract');
    const one = (await t.ask('extract emails')).answer;
    assert.match(one, /^No emails/);
  } finally { await t.done(); }
});

test('malformed bodies are 400s, never 500s', async () => {
  const t = await boot();
  try {
    for (const body of ['null', '[]', '5', '"x"']) assert.equal((await t.call('POST', '/api/items', body)).status, 400, body);
    assert.equal((await t.call('POST', '/api/ask', 'null')).status, 400);
    assert.equal((await t.call('POST', '/api/items', { type: 'note', text: 'hi there', title: { x: 1 } })).status, 400);
    const ok = await t.call('POST', '/api/items', { type: 'note', text: 'hi there', title: 'Greeting' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.title, 'Greeting');
    assert.equal((await t.call('PATCH', `/api/items/${ok.body.id}`, 'null')).status, 400);
  } finally { await t.done(); }
});

test('duplicates are refused with a clear message, ignoring case and spacing', async () => {
  const t = await boot();
  try {
    assert.equal((await t.note('Same note about gym membership.')).status, 201);
    const dup = await t.note('  same NOTE about   gym membership. ');
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already added/);
  } finally { await t.done(); }
});

test('text encodings: latin-1, utf-16 and trailing-dot filenames are read, not mangled or hidden', async () => {
  const t = await boot();
  try {
    const latin = await t.upload('cafe.txt', Buffer.from('Le café est ouvert. Prix: 5 euros.', 'latin1'));
    assert.match((await t.call('GET', `/api/items/${latin.body.id}`)).body.text, /café est ouvert/);
    const u16 = await t.upload('wide.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Harbour lease clause', 'utf16le')]));
    assert.equal(u16.body.noText, false);
    assert.match((await t.call('GET', `/api/items/${u16.body.id}`)).body.text, /Harbour lease clause/);
    const dotted = await t.upload('trailing.txt.', Buffer.from('plain text body'));
    assert.equal(dotted.body.noText, false);
  } finally { await t.done(); }
});

test('links: charset honoured, slow and endless pages end cleanly, redirects to bad schemes are explained', async () => {
  const site = http.createServer((req, res) => {
    if (req.url === '/latin') { res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }); return res.end(Buffer.from('<title>Café</title><p>Crème brûlée</p>', 'latin1')); }
    if (req.url === '/meta') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><p>', 'latin1'), Buffer.from('Crème', 'latin1')])); }
    if (req.url === '/endless') { res.writeHead(200, { 'content-type': 'text/plain' }); const iv = setInterval(() => res.write('x'.repeat(1 << 20)), 1); res.on('close', () => clearInterval(iv)); return; }
    if (req.url === '/redir') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const t = await boot();
  try {
    const l = await t.call('POST', '/api/items', { type: 'url', url: `${origin}/latin` });
    assert.equal(l.body.title, 'Café');
    assert.match((await t.call('GET', `/api/items/${l.body.id}`)).body.text, /Crème brûlée/);
    const m = await t.call('POST', '/api/items', { type: 'url', url: `${origin}/meta` });
    assert.match((await t.call('GET', `/api/items/${m.body.id}`)).body.text, /Crème/);
    const start = Date.now();
    const big = await t.call('POST', '/api/items', { type: 'url', url: `${origin}/endless` });
    assert.equal(big.status, 413);
    assert.ok(Date.now() - start < 10000);
    const r = await t.call('POST', '/api/items', { type: 'url', url: `${origin}/redir` });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Could not fetch/);
  } finally { await t.done(); site.closeAllConnections(); site.close(); }
});

test('round-2 fixes: impossible dates, junk doctype, scope matching, values at chunk cuts, more phone and currency forms', async () => {
  assert.equal(htmlToText('<!DOCTYPE html>\n<?xml version="1.0"?><p>Hello</p>').text, 'Hello');
  const t = await boot();
  try {
    await t.note('Real: 29 Feb 2024, 12 March 2026. Fake: 31 Feb 2026, 2026-02-30, 29 Feb 2025, 1/2/3456. Words: Market 2025, margin 2025, Decision 2024.');
    const d = (await t.ask('extract dates')).rows.map((r) => r.value);
    assert.deepEqual(d.sort(), ['12 March 2026', '29 Feb 2024']);

    await t.note('Call 020-7946-0958 or 1800 123 4567 but not 8000 2025. Fees: CHF 50, INR 500, ₹500 and [see http://a.com] or {http://b.com}.');
    assert.deepEqual((await t.ask('extract phones')).rows.map((r) => r.value).sort(), ['020-7946-0958', '1800 123 4567']);
    assert.deepEqual((await t.ask('extract amounts')).rows.map((r) => r.value).sort(), ['CHF 50', 'INR 500', '₹500']);
    assert.deepEqual((await t.ask('extract links')).rows.map((r) => r.value).sort(), ['http://a.com', 'http://b.com']);

    const lines = Array.from({ length: 300 }, (_, i) => `mail${i}@ex.com`).join('\n');
    await t.note(lines);
    assert.equal((await t.ask('extract emails')).rows.length, 300, 'no address lost at a chunk boundary');

    const n = (await t.note('Rent and review clauses for the harbour office lease')).body;
    await t.call('PATCH', `/api/items/${n.id}`, { category: 'Small Talk' });
    assert.equal((await t.ask('extract dates from all')).mode, 'help', '"all" must not match "Small Talk"');
    assert.equal((await t.ask('extract dates from "Small Talk" please')).category, 'Small Talk');
    assert.equal((await t.ask('extract dates from talk')).category, 'Small Talk');
  } finally { await t.done(); }
});

test('static files need an exact-case path and no stream suffix', async () => {
  const t = await boot();
  try {
    const base = `http://127.0.0.1:${t.app.port}`;
    assert.equal((await fetch(`${base}/index.html`)).status, 200);
    assert.equal((await fetch(`${base}/INDEX.HTML`)).status, 404);
    assert.equal((await fetch(`${base}/index.html::$DATA`)).status, 404);
  } finally { await t.done(); }
});

test('categories are named from real words, never numbers or file extensions', async () => {
  const t = await boot();
  try {
    const a = await t.upload('ambiguous.txt', fs.readFileSync(path.join(CORPUS, 'ambiguous.txt')));
    assert.doesNotMatch(a.body.category, /txt|\d/i);
    const b = (await t.note('Dentist appointment on 3 May 2027 costs $45 and 120 minutes.')).body;
    assert.doesNotMatch(b.category, /\d/);
    const c = (await t.note('Analysis of campus status reports, bonus analysis and canvas status.')).body;
    assert.doesNotMatch(c.category, /\b(Analysi|Statu|Campu|Bonu|Canva)\b/);
    const long = (await t.note(`${'supercalifragilistic'.repeat(10)} wordy note`)).body;
    assert.ok(long.category.length <= 40);
  } finally { await t.done(); }
});
