'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start, chunk, tokenize, htmlToText } = require('../server.js');

const CORPUS = path.join(__dirname, '..', 'uat', 'corpus');
const H = { 'x-pacrag': '1', 'content-type': 'application/json' };

async function boot(opts = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-'))) {
  const app = await start({ port: 0, dataDir: dir, answerer: null, embedder: null, ...opts });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data, headers: r.headers };
  };
  const feedFile = (name) => call('POST', `/api/upload?name=${encodeURIComponent(name)}`, fs.readFileSync(path.join(CORPUS, name)), { 'x-pacrag': '1', 'content-type': 'application/octet-stream' });
  const done = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, base, call, feedFile, done, dir };
}
const feedAll = async (t) => { const out = {}; for (const f of fs.readdirSync(CORPUS).filter((n) => n !== 'sample.pdf' && n !== 'ambiguous.txt')) out[f] = (await t.feedFile(f)).body; return out; };

test('chunk, tokenize and htmlToText behave', () => {
  assert.deepEqual(chunk('a\n\nb'), ['a\n\nb']);
  assert.equal(chunk('x'.repeat(2000)).length, 3);
  assert.deepEqual(chunk('   \n\n  '), []);
  assert.deepEqual(tokenize('The Leases, and the tenants!'), ['lease', 'tenant']);
  const { title, text } = htmlToText('<html><head><title>Hi &amp; bye</title><script>x()</script></head><body><p>One</p><p>Two &lt;3</p></body></html>');
  assert.equal(title, 'Hi & bye');
  assert.equal(text, 'One\n\nTwo <3');
});

test('files are categorized by topic and similar ones land together', async () => {
  const t = await boot();
  try {
    const it = await feedAll(t);
    const cat = (n) => it[n].category;
    assert.equal(cat('lease-clause.txt'), cat('lease-notes.md'), 'lease docs together');
    assert.equal(cat('js-closures.md'), cat('js-promises.txt'), 'javascript docs together');
    assert.equal(cat('pasta-recipe.txt'), cat('sourdough.md'), 'recipes together');
    assert.equal(new Set([cat('lease-clause.txt'), cat('js-closures.md'), cat('pasta-recipe.txt'), cat('lisbon-trip.txt')]).size, 4, 'four topics, four categories');
  } finally { await t.done(); }
});

test('ask finds the right passage, cites it, and admits when nothing matches', async () => {
  const t = await boot();
  try {
    await feedAll(t);
    const r = await t.call('POST', '/api/ask', { q: 'When can the tenant break the lease?' });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'extractive');
    assert.match(r.body.sources[0].title, /^lease-/);
    assert.match(r.body.answer, /\[1\]/);
    const j = await t.call('POST', '/api/ask', { q: 'how do closures keep private state' });
    assert.equal(j.body.sources[0].title, 'js-closures.md');
    const none = await t.call('POST', '/api/ask', { q: 'quantum chromodynamics' });
    assert.equal(none.body.mode, 'none');
    assert.deepEqual(none.body.sources, []);
    assert.equal((await t.call('POST', '/api/ask', { q: '   ' })).status, 400);
    assert.equal((await t.call('POST', '/api/ask', { q: 'x'.repeat(1001) })).status, 400);
  } finally { await t.done(); }
});

test('a short follow-up reuses the previous question for retrieval', async () => {
  const t = await boot();
  try {
    await feedAll(t);
    const r = await t.call('POST', '/api/ask', { q: 'notice period?', history: [{ role: 'user', content: 'break option in the lease' }, { role: 'assistant', content: 'ok' }] });
    assert.match(r.body.sources[0].title, /^lease-/);
  } finally { await t.done(); }
});

test('extract returns dates, amounts, emails and scopes by category', async () => {
  const t = await boot();
  try {
    const it = await feedAll(t);
    const dates = (await t.call('POST', '/api/ask', { q: 'extract dates' })).body;
    assert.equal(dates.mode, 'extract');
    const values = dates.rows.map((r) => r.value);
    assert.ok(values.includes('30 June 2027') && values.includes('31 December 2026') && values.includes('12 September 2026'), values.join('|'));
    const scoped = (await t.call('POST', '/api/ask', { q: `Extract dates from ${it['lease-clause.txt'].category}` })).body;
    assert.deepEqual(scoped.rows.map((r) => r.value).sort(), ['30 June 2027', '31 December 2026', 'June 2027']);
    const amounts = (await t.call('POST', '/api/ask', { q: 'extract the rent amounts' })).body.rows.map((r) => r.value);
    assert.ok(amounts.includes('£48,000') && amounts.includes('$12,000'), amounts.join('|'));
    const emails = (await t.call('POST', '/api/ask', { q: 'extract emails' })).body.rows.map((r) => r.value);
    assert.ok(emails.includes('leasing@harbourpoint.example'));
    const help = (await t.call('POST', '/api/ask', { q: 'extract the vibes' })).body;
    assert.equal(help.mode, 'help');
    const unknown = (await t.call('POST', '/api/ask', { q: 'extract phones from Nonexistent' })).body;
    assert.equal(unknown.mode, 'help');
    assert.match(unknown.answer, /no category called/i);
  } finally { await t.done(); }
});

test('uploads: text indexed, pdf and image stored honestly, files served safely', async () => {
  const t = await boot();
  try {
    const pdf = await t.feedFile('sample.pdf');
    assert.equal(pdf.status, 201);
    assert.equal(pdf.body.noText, true);
    assert.equal(pdf.body.category, 'Unread files');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const img = await t.call('POST', '/api/upload?name=dot.png', png, { 'x-pacrag': '1', 'content-type': 'application/octet-stream' });
    assert.equal(img.body.category, 'Images');
    const served = await fetch(`${t.base}/files/${img.body.fileName}`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('content-disposition'), 'inline');
    const dl = await fetch(`${t.base}/files/${pdf.body.fileName}`);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
    assert.equal((await fetch(`${t.base}/files/nope.txt`)).status, 404);
    assert.equal((await fetch(`${t.base}/files/..%2f..%2fserver.js`)).status, 404);
    assert.equal((await t.call('POST', '/api/upload?name=empty.txt', Buffer.alloc(0), { 'x-pacrag': '1' })).status, 400);
    assert.equal((await t.call('POST', '/api/upload', Buffer.from('x'), { 'x-pacrag': '1' })).status, 400);
    const html = await t.call('POST', '/api/upload?name=page.html', '<p>hello <b>world</b></p><script>evil()</script>', { 'x-pacrag': '1' });
    assert.equal((await t.call('GET', `/api/items/${html.body.id}`)).body.text, 'hello world');
  } finally { await t.done(); }
});

test('local-only protections: host check, request header, static traversal, body limits', async () => {
  const t = await boot();
  try {
    const raw = (headers) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: t.app.port, path: '/api/status', headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(await raw({ host: 'evil.example' }), 403);
    assert.equal(await raw({}), 200);
    assert.equal((await t.call('POST', '/api/items', { type: 'note', text: 'x' }, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await fetch(`${t.base}/..%2fserver.js`)).status, 404);
    assert.equal((await fetch(`${t.base}/%E0%A4%A`)).status, 400);
    assert.equal((await t.call('POST', '/api/items', 'not json')).status, 400);
    assert.equal((await t.call('POST', '/api/items', { type: 'note', text: 'x'.repeat(1024 * 1024 + 10) })).status, 413);
    assert.equal((await t.call('POST', '/api/items', { type: 'note', text: '   ' })).status, 400);
    assert.equal((await t.call('POST', '/api/items', { type: 'bogus' })).status, 400);
    const page = await fetch(t.base + '/');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  } finally { await t.done(); }
});

test('links: fetched, converted to text, titled; bad links explained', async () => {
  const site = http.createServer((req, res) => {
    if (req.url === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end('x'); }
    if (req.url === '/missing') { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Trams</title><script>nope()</script></head><body><p>Tram 28 crosses Alfama.</p></body></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const t = await boot();
  try {
    const ok = await t.call('POST', '/api/items', { type: 'url', url: origin + '/page' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.title, 'Trams');
    assert.equal(ok.body.source, origin + '/page');
    const full = (await t.call('GET', `/api/items/${ok.body.id}`)).body.text;
    assert.match(full, /Tram 28/);
    assert.doesNotMatch(full, /nope/);
    assert.equal((await t.call('POST', '/api/items', { type: 'url', url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await t.call('POST', '/api/items', { type: 'url', url: 'not a url' })).status, 400);
    assert.equal((await t.call('POST', '/api/items', { type: 'url', url: origin + '/bin' })).status, 415);
    assert.equal((await t.call('POST', '/api/items', { type: 'url', url: origin + '/missing' })).status, 502);
    assert.equal((await t.call('POST', '/api/items', { type: 'url', url: 'http://127.0.0.1:1/' })).status, 502);
  } finally { await t.done(); site.close(); }
});

test('move, keep, delete, and persistence across a restart', async () => {
  const t = await boot();
  try {
    const a = (await t.call('POST', '/api/items', { type: 'note', text: 'Harbour lease rent review clause for the tenant.' })).body;
    const b = (await t.call('POST', '/api/items', { type: 'note', text: 'Pasta carbonara with guanciale and pecorino.' })).body;
    assert.notEqual(a.category, b.category);
    const moved = await t.call('PATCH', `/api/items/${b.id}`, { category: '  Dinner  ' });
    assert.equal(moved.body.category, 'Dinner');
    assert.equal((await t.call('PATCH', `/api/items/${b.id}`, { category: '' })).status, 400);
    assert.equal((await t.call('PATCH', `/api/items/${b.id}`, { category: 'x'.repeat(41) })).status, 400);
    assert.equal((await t.call('PATCH', '/api/items/nope', { category: 'A' })).status, 404);
    const up = (await t.feedFile('sample.pdf')).body;
    const filePath = path.join(t.dir, 'files', up.fileName);
    assert.ok(fs.existsSync(filePath));
    await t.app.close();
    const again = await start({ port: 0, dataDir: t.dir, answerer: null });
    const list = await (await fetch(`http://127.0.0.1:${again.port}/api/items`)).json();
    assert.equal(list.items.length, 3);
    assert.ok(list.items.find((i) => i.id === b.id && i.category === 'Dinner'));
    const del = await fetch(`http://127.0.0.1:${again.port}/api/items/${up.id}`, { method: 'DELETE', headers: { 'x-pacrag': '1' } });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(filePath), 'file removed with its item');
    await again.close();
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a corrupt items.json stops startup and is not overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-'));
  fs.writeFileSync(path.join(dir, 'items.json'), '{broken');
  await assert.rejects(() => start({ port: 0, dataDir: dir, answerer: null }), /Cannot read/);
  assert.equal(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'), '{broken');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('answerer: used when present, falls back to quoted passages when it fails', async () => {
  let seen;
  const good = await boot({ answerer: async (q, sources, history) => { seen = { q, n: sources.length, h: history.length }; return `Answer [${sources[0].n}]`; } });
  try {
    await good.feedFile('lease-clause.txt');
    const r = await good.call('POST', '/api/ask', { q: 'break option', history: [{ role: 'user', content: 'hi' }, { role: 'bogus', content: 'x' }] });
    assert.equal(r.body.mode, 'llm');
    assert.equal(r.body.answer, 'Answer [1]');
    assert.deepEqual(seen, { q: 'break option', n: 1, h: 1 });
    assert.equal((await good.call('GET', '/api/status')).body.llm, 'custom');
  } finally { await good.done(); }
  const bad = await boot({ answerer: async () => { throw new Error('boom'); } });
  try {
    await bad.feedFile('lease-clause.txt');
    const r = await bad.call('POST', '/api/ask', { q: 'break option' });
    assert.equal(r.body.mode, 'extractive');
    assert.match(r.body.note, /boom/);
    assert.match(r.body.answer, /\[1\]/);
  } finally { await bad.done(); }
});

test('an ambiguous note is flagged as a ghost with a low-confidence guess, and Keep clears the flag', async () => {
  const t = await boot();
  try {
    await feedAll(t);
    const r = (await t.feedFile('ambiguous.txt')).body;
    assert.equal(r.type, 'file');
    assert.equal(r.needsReview, true, 'borderline notes go to Ghosts (README Design: categorizer)');
    assert.equal(r.category, 'Lease');
    assert.ok(r.confidence < 0.2, `confidence ${r.confidence}`);
    assert.equal(r.state, 'review');
    assert.deepEqual(r.actions, ['keep', 'sort', 'delete']);
    assert.equal((await t.call('GET', `/api/items/${r.id}`)).status, 200, 'never lost');
    const kept = await t.call('PATCH', `/api/items/${r.id}`, { reviewed: true });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.needsReview, false);
    assert.equal(kept.body.state, 'filed');
    assert.ok(!kept.body.actions.includes('keep'));
  } finally { await t.done(); }
});
