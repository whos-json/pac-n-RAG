'use strict';
// Regression tests for defects found in UAT round 3.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { start } = require('../server.js');

const H = { 'x-pacrag': '1', 'content-type': 'application/json' };
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag3-'));
const WELL_FORMED = /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/; // no lone surrogates; same check as String#isWellFormed, which needs Node 20+

async function boot(dir = mkdir(), opts = {}) {
  const app = await start({ port: 0, dataDir: dir, answerer: null, embedder: null, ...opts });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data, headers: r.headers };
  };
  const note = (text, title) => call('POST', '/api/items', { type: 'note', text, title });
  const upload = (name, buf) => call('POST', `/api/upload?name=${encodeURIComponent(name)}`, buf, { 'x-pacrag': '1' });
  const raw = (reqPath, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: reqPath, headers: extra.headers, method: extra.method }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  return { app, call, note, upload, raw, dir, base, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('GET /files/<id> with the file missing on disk returns 404 and the server survives', async () => {
  const t = await boot();
  try {
    const up = await t.upload('gone.bin', Buffer.from([1, 2, 3, 4]));
    assert.equal(up.status, 201);
    fs.rmSync(path.join(t.dir, 'files', up.body.fileName));
    assert.equal((await t.call('GET', `/files/${up.body.fileName}`)).status, 404);
    assert.equal((await t.call('GET', '/api/status')).status, 200);
  } finally { await t.done(); }
});

test('a failed save rolls back memory and the uploaded file, and reports a clear error', async () => {
  const t = await boot();
  try {
    const keep = await t.note('the first note stays put in the library');
    assert.equal(keep.status, 201);
    fs.mkdirSync(path.join(t.dir, 'items.json.tmp')); // makes every save fail

    const n = await t.note('a second note that can never be saved');
    assert.equal(n.status, 500);
    assert.match(n.body.error, /Could not save to disk \(\w+\)\. Close anything using the data folder and try again\./);
    const up = await t.upload('x.txt', Buffer.from('some text that cannot be saved'));
    assert.equal(up.status, 500);
    assert.equal(fs.readdirSync(path.join(t.dir, 'files')).length, 0, 'a failed upload must not leave its file behind');

    assert.equal((await t.call('GET', '/api/items')).body.items.length, 1);
    const before = keep.body.category;
    const patch = await t.call('PATCH', `/api/items/${keep.body.id}`, { category: 'Elsewhere' });
    assert.equal(patch.status, 500);
    assert.equal((await t.call('GET', `/api/items/${keep.body.id}`)).body.category, before);
    assert.equal((await t.call('DELETE', `/api/items/${keep.body.id}`)).status, 500);
    assert.equal((await t.call('GET', '/api/items')).body.items.length, 1);

    fs.rmSync(path.join(t.dir, 'items.json.tmp'), { recursive: true });
    assert.equal((await t.note('a note that saves fine now')).status, 201);
  } finally { await t.done(); }
});

test('a save retries a rename refused with EPERM and succeeds once it is allowed', async () => {
  const t = await boot();
  const realRename = fs.renameSync;
  let refused = 0;
  try {
    const n = await t.note('a note whose save is refused twice by the OS');
    assert.equal(n.status, 201);
    fs.renameSync = (from, to, ...rest) => {
      if (String(from).endsWith('items.json.tmp') && refused < 2) { refused++; throw Object.assign(new Error('EPERM: simulated lock'), { code: 'EPERM' }); }
      return realRename(from, to, ...rest);
    };
    const p = await t.call('PATCH', `/api/items/${n.body.id}`, { category: 'Retried' });
    assert.equal(p.status, 200);
    assert.equal(refused, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'items.json'), 'utf8')).items.find((i) => i.id === n.body.id).category, 'Retried');
  } finally { fs.renameSync = realRename; await t.done(); }
});

test('request targets that are not a single-slash path get 400, not 500', async () => {
  const t = await boot();
  try {
    for (const p of ['//', '//?x', '///', 'http://example.com/', '//evil.example/x']) assert.equal(await t.raw(p), 400, p);
    assert.equal(await t.raw('/api/status'), 200);
  } finally { await t.done(); }
});

test('truncation is by code point: titles stay well-formed and downloads never 500', async () => {
  const t = await boot();
  try {
    const emoji = '😀'.repeat(10);
    const n = await t.note('body text for an emoji titled note', 'a'.repeat(119) + emoji);
    assert.equal(n.status, 201);
    assert.match(n.body.title, WELL_FORMED);
    assert.equal([...n.body.title].length, 120);

    const up = await t.upload('b'.repeat(119) + emoji + '.bin', Buffer.from([1, 2, 3]));
    assert.equal(up.status, 201);
    assert.match(up.body.title, WELL_FORMED);
    assert.ok(up.body.title.endsWith('.bin'));
    const dl = await t.call('GET', `/files/${up.body.fileName}`);
    assert.equal(dl.status, 200);

    const odd = await t.upload("it's (a)*.bin", Buffer.from([1]));
    const cd = (await t.call('GET', `/files/${odd.body.fileName}`)).headers.get('content-disposition');
    assert.match(cd, /it%27s%20%28a%29%2A\.bin/);

    const cat = await t.call('PATCH', `/api/items/${n.body.id}`, { category: 'x'.repeat(30) + '😀' });
    assert.equal(cat.status, 200);
    assert.equal((await t.call('PATCH', `/api/items/${n.body.id}`, { category: 'x'.repeat(41) })).status, 400);
  } finally { await t.done(); }
});

test('a long file name keeps its extension and is still read as text', async () => {
  const t = await boot();
  try {
    const up = await t.upload('a'.repeat(250) + '.txt', Buffer.from('hello from a long named file about gardening'));
    assert.equal(up.status, 201);
    assert.notEqual(up.body.category, 'Unread files');
    assert.equal(up.body.noText, false);
    assert.ok(up.body.title.endsWith('.txt'));
    assert.ok(up.body.fileName.endsWith('.txt'));
  } finally { await t.done(); }
});

test('words like constructor and __proto__ are ordinary words and ordinary category names', async () => {
  const t = await boot();
  try {
    const a = await t.note('constructor toString __proto__ hasOwnProperty valueOf constructor prototype');
    const b = await t.note('constructor toString hasOwnProperty valueOf isPrototypeOf constructor');
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.ok(Number.isFinite(b.body.confidence));
    const p = await t.call('PATCH', `/api/items/${a.body.id}`, { category: '__proto__' });
    assert.equal(p.status, 200);
    assert.equal(p.body.category, '__proto__');
    assert.equal((await t.call('PATCH', `/api/items/${b.body.id}`, { category: 'constructor' })).status, 200);
    const c = await t.note('toString constructor valueOf more words about nothing');
    assert.equal(c.status, 201);
    const st = (await t.call('GET', '/api/status')).body;
    assert.ok(st.categories.some((x) => x.name === '__proto__' && x.count === 1));
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
    assert.equal((await t.call('POST', '/api/ask', { q: 'extract dates from __proto__' })).status, 200);
  } finally { await t.done(); }
});

test('category names are normalised and matched case-insensitively', async () => {
  const t = await boot();
  try {
    const a = (await t.note('first note about pasta and tomatoes')).body;
    const b = (await t.note('second note about a lighthouse keeper')).body;
    const set = async (id, category) => t.call('PATCH', `/api/items/${id}`, { category });
    assert.equal((await set(a.id, 'Recipes')).body.category, 'Recipes');
    assert.equal((await set(b.id, 'recipes')).body.category, 'Recipes');
    assert.equal((await set(b.id, 'Re\u200bci\u00adpes\u2028  ')).body.category, 'Recipes');
    assert.equal((await set(b.id, 'Cafe\u0301   au \t lait')).body.category, 'Café au lait');
    assert.equal((await set(b.id, '\u200b \u2029 \u007f')).status, 400);
    assert.equal((await set(b.id, '   ')).status, 400);
  } finally { await t.done(); }
});

test('note duplicates are detected across Unicode normalisation forms', async () => {
  const t = await boot();
  try {
    assert.equal((await t.note('a caf\u00e9 note')).status, 201);
    assert.equal((await t.note('a cafe\u0301 note')).status, 409);
    const n = await t.note('another caf\u00e9 thing', 'cafe\u0301 title');
    assert.equal(n.body.title, 'caf\u00e9 title');
  } finally { await t.done(); }
});

test('a 1000-character question made of whitespace does not freeze extraction parsing', async () => {
  const t = await boot();
  try {
    await t.note('rent is $1,200 per month');
    for (const q of ['extract dates from' + ' '.repeat(900) + 'x', 'extract' + ' a'.repeat(450) + ' room', 'extract amounts from' + ' \t'.repeat(450)]) {
      const t0 = Date.now();
      const r = await t.call('POST', '/api/ask', { q });
      assert.ok(r.status === 200 || r.status === 400);
      assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    }
    assert.match((await t.call('POST', '/api/ask', { q: 'extract amounts' })).body.answer, /Found 1/);
  } finally { await t.done(); }
});

test('an items.json with the wrong shape stops startup and is not overwritten', async () => {
  for (const content of ['[]', 'null', '{"items":{}}', '{}', '{"items":[1,2,3]}', '"text"']) {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'items.json'), content);
    await assert.rejects(() => start({ port: 0, dataDir: dir, answerer: null, embedder: null }), /items\.json/, content);
    assert.equal(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'), content);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hostile stored terms and records load safely', async () => {
  const dir = mkdir();
  const rec = (id, terms) => ({ id, type: 'note', title: id, category: '__proto__', chunks: ['alpha beta gamma'], noText: false, confidence: 1, needsReview: false, added: 1, terms });
  fs.writeFileSync(path.join(dir, 'items.json'), '{"items":[' + JSON.stringify(rec('one', {})).replace('"terms":{}', '"terms":{"__proto__":5,"constructor":"x","alpha":2,"bad":null}') + ',' + JSON.stringify(rec('two', [1, 2])) + ',{"nonsense":true}]}');
  const t = await boot(dir);
  try {
    assert.equal((await t.call('GET', '/api/items')).body.items.length, 2);
    assert.equal((await t.note('alpha constructor beta something')).status, 201);
    assert.equal(({}).alpha, undefined);
  } finally { await t.done(); }
});

test('an upload that declares an oversized Content-Length is refused with 413 before any body is sent', async () => {
  const t = await boot();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.app.port, path: '/api/upload?name=big.bin', method: 'POST', headers: { 'x-pacrag': '1', 'content-length': String(30 * 1024 * 1024) } }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.on('error', (e) => reject(e));
      req.flushHeaders();
    });
    assert.equal(status, 413);
    assert.equal((await t.call('GET', '/api/status')).status, 200);
  } finally { await t.done(); }
});

test('/api/version, CRLF normalisation and the ANTHROPIC_API_KEY / PACRAG_LOCAL_ONLY environment defaults', async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, lo: process.env.PACRAG_LOCAL_ONLY };
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
  delete process.env.PACRAG_LOCAL_ONLY;
  const dir = mkdir();
  const app = await start({ port: 0, dataDir: dir, embedder: null });

  try {
    const get = async (p) => (await fetch(`http://127.0.0.1:${app.port}${p}`)).json();
    const v = await get('/api/version');
    assert.equal(v.version, require('../package.json').version);
    assert.equal(v.node, process.version);
    assert.equal(v.dataDir, path.resolve(dir));
    const st = await get('/api/status');
    assert.equal(st.llm, 'anthropic'); // no SDK needed any more: the key alone switches it on
    assert.equal(st.llmRemote, true);
    process.env.PACRAG_LOCAL_ONLY = 'no'; // only 1/true/yes switch local-only on
    const other = await start({ port: 0, dataDir: mkdir(), embedder: null });
    const st2 = await (await fetch(`http://127.0.0.1:${other.port}/api/status`)).json();
    assert.equal(st2.llm, 'anthropic');
    await other.close();
    process.env.PACRAG_LOCAL_ONLY = 'yes';
    const third = await start({ port: 0, dataDir: mkdir(), embedder: null });
    assert.equal((await (await fetch(`http://127.0.0.1:${third.port}/api/status`)).json()).llm, 'local');
    await third.close();

    const r = await fetch(`http://127.0.0.1:${app.port}/api/upload?name=crlf.txt`, { method: 'POST', headers: { 'x-pacrag': '1' }, body: 'line one\r\nline two\r\n' });
    const item = await r.json();
    const full = await (await fetch(`http://127.0.0.1:${app.port}/api/items/${item.id}`)).json();
    assert.ok(!full.text.includes('\r'));
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['PACRAG_LOCAL_ONLY', saved.lo]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('links: credentials are refused, redirects to credentials explained, bare hostnames get https', async () => {
  const t = await boot();
  const target = http.createServer((req, res) => { res.writeHead(302, { location: `http://u:p@127.0.0.1:${target.address().port}/x` }); res.end(); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  try {
    const add = (url) => t.call('POST', '/api/items', { type: 'url', url });
    const cred = await add('http://user:secret@127.0.0.1:1/');
    assert.equal(cred.status, 400);
    assert.match(cred.body.error, /username or password/);
    assert.ok(!JSON.stringify(cred.body).includes('secret'));
    const redirected = await add(`http://127.0.0.1:${target.address().port}/`);
    assert.equal(redirected.status, 502);
    assert.match(redirected.body.error, /username or password/);
    const bare = await add('localhost:1/page'); // becomes https://localhost:1/page, which refuses the connection
    assert.equal(bare.status, 502);
    assert.equal((await add('not a link')).status, 400);
    assert.equal((await add('mailto:a@b.co')).status, 400);
  } finally { target.close(); await t.done(); }
});

test('text beyond the 2,000,000-character index limit is cut, flagged, and not searchable', async () => {
  const t = await boot();
  try {
    const marker = 'zqxtailmarker';
    const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(2_000_000 / 27));
    const text = filler.slice(0, 2_000_000) + ' '.repeat(10) + 'padding '.repeat(40) + marker; // the marker sits about 300 characters past the cut
    assert.ok(text.length > 2_000_000 + 300);
    const up = await t.upload('long-text.txt', Buffer.from(text));
    assert.equal(up.status, 201);
    assert.equal(up.body.truncated, true);
    const full = await t.call('GET', `/api/items/${up.body.id}`);
    assert.ok(!full.body.text.includes(marker));
    const head = await t.call('POST', '/api/ask', { q: 'lorem ipsum dolor sit amet' });
    assert.equal(head.status, 200);
    assert.ok(head.body.sources.length > 0, 'the indexed head is still searchable');
    assert.ok(!JSON.stringify(head.body.sources).includes(marker));
    const tail = await t.call('POST', '/api/ask', { q: marker });
    assert.equal(tail.status, 200);
    assert.deepEqual(tail.body.sources, [], 'the cut text is not searchable');
  } finally { await t.done(); }
});

test('command line: --help, bad PORT and a busy port', async () => {
  const server = path.join(__dirname, '..', 'server.js');
  const dir = path.join(mkdir(), 'should-not-exist');
  const help = spawnSync(process.execPath, [server, '--help'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
  assert.ok(!fs.existsSync(dir));

  for (const PORT of ['abc', '0', '70000', '-1', '12.5']) {
    const r = spawnSync(process.execPath, [server], { env: { ...process.env, PORT, DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1, PORT);
    assert.match(r.stderr, /Invalid PORT/);
  }
  assert.ok(!fs.existsSync(dir));

  const t = await boot();
  try {
    const r = spawnSync(process.execPath, [server], { env: { ...process.env, PORT: String(t.app.port), DATA_DIR: mkdir() }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`Port ${t.app.port} is in use\\. Set PORT=<other> or stop the other PAC&RAG\\.`));
  } finally { await t.done(); }
});
