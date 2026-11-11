'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start } = require('../server.js');
const { createEmbedder, createSemantic, fromEnv, isLoopbackUrl } = require('../embed.js');

const H = { 'x-pacrag': '1', 'content-type': 'application/json' };

// Deterministic fake: one dimension per synonym group, so 'dentist' and 'gym' land near 'health'.
const GROUPS = [
  ['health', 'dentist', 'doctor', 'gym', 'clinic', 'physio'],
  ['food', 'pasta', 'carbonara', 'recipe', 'dinner'],
  ['property', 'lease', 'rent', 'tenant', 'harbour'],
];
function fakeEmbedder() {
  const f = {
    model: 'fake', calls: 0,
    async embed(texts) {
      f.calls += texts.length;
      return texts.map((t) => {
        const words = t.toLowerCase().match(/[a-z]+/g) || [];
        return GROUPS.map((g) => words.filter((w) => g.includes(w)).length);
      });
    },
  };
  return f;
}

const NOTES = [
  'Dentist appointment on Tuesday at three.',
  'Gym membership renewal due in March.',
  'Pasta carbonara with guanciale and pecorino.',
  'Harbour lease rent review clause for the tenant.',
];

async function boot(opts = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-emb-'))) {
  const app = await start({ port: 0, dataDir: dir, answerer: null, ...opts });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data };
  };
  const ask = async (q) => (await call('POST', '/api/ask', { q })).body;
  const addNotes = async (notes = NOTES) => { const out = []; for (const text of notes) out.push((await call('POST', '/api/items', { type: 'note', text })).body); return out; };
  const waitFor = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = (await call('GET', '/api/status')).body;
      if (pred(s)) return s;
      if (Date.now() > end) throw new Error('timed out waiting; last status ' + JSON.stringify(s));
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const done = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, call, ask, addNotes, waitFor, done, dir };
}

test('semantic search finds a note BM25 alone misses', async () => {
  const sem = await boot({ embedder: fakeEmbedder() });
  const plain = await boot();
  try {
    await sem.addNotes(); await plain.addNotes();
    await sem.waitFor((s) => s.semantic === 'ready');
    const q = 'doctor visit';
    assert.equal((await plain.ask(q)).mode, 'none', 'BM25 alone misses');
    const r = await sem.ask(q);
    assert.notEqual(r.mode, 'none');
    assert.ok(r.sources.some((s) => /Dentist appointment/.test(s.text)));
    assert.ok(r.sources.some((s) => /Gym membership/.test(s.text)));
    assert.ok(!r.sources.some((s) => /carbonara|lease/.test(s.text)), 'unrelated notes stay out');
  } finally { await sem.done(); await plain.done(); }
});

test('a failing or hanging embedder gives exactly the BM25 results and a healthy server', async () => {
  const plain = await boot();
  const bad = await boot({ embedder: { model: 'bad', embed: async () => { throw new Error('connection refused'); } } });
  const hang = await boot({ embedder: { model: 'hang', embed: () => new Promise(() => {}) }, embedQueryTimeoutMs: 100 });
  try {
    for (const t of [plain, bad, hang]) await t.addNotes();
    await bad.waitFor((s) => s.semantic === 'unavailable');
    for (const q of ['lease rent', 'dentist appointment', 'doctor visit']) {
      const want = await plain.ask(q);
      for (const t of [bad, hang]) {
        const got = await t.ask(q);
        assert.equal(got.mode, want.mode);
        const strip = (ss) => (ss || []).map(({ itemId, ...rest }) => rest); // ids differ between apps
        assert.deepEqual(strip(got.sources), strip(want.sources));
      }
    }
    assert.equal((await hang.call('GET', '/api/status')).status, 200);
    assert.equal((await hang.call('GET', '/api/items')).body.items.length, NOTES.length);
  } finally { await plain.done(); await bad.done(); await hang.done(); }
});

test('non-loopback embedding URLs are refused unless explicitly allowed', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackUrl('http://localhost:11434'), true);
  assert.equal(isLoopbackUrl('http://[::1]:11434'), true);
  assert.equal(isLoopbackUrl('http://example.com:11434'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com'), false);
  assert.throws(() => createEmbedder({ url: 'http://example.com', model: 'm' }), /non-local/);
  assert.doesNotThrow(() => createEmbedder({ url: 'http://example.com', model: 'm', allowRemote: true }));
  const err = console.error; console.error = () => {};
  try {
    assert.equal(fromEnv({ PACRAG_EMBED_MODEL: 'm', OLLAMA_URL: 'http://10.0.0.5:11434' }), null);
  } finally { console.error = err; }
  assert.ok(fromEnv({ PACRAG_EMBED_MODEL: 'm', OLLAMA_URL: 'http://10.0.0.5:11434', PACRAG_EMBED_ALLOW_REMOTE: '1' }));
  assert.ok(fromEnv({ PACRAG_EMBED_MODEL: 'm' }));
  assert.equal(fromEnv({}), null);
});

test('vector cache persists across a restart and is pruned after delete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-emb-'));
  const FILE = path.join(dir, 'embeddings.json');
  const first = await boot({ embedder: fakeEmbedder() }, dir);
  const items = await first.addNotes();
  await first.waitFor((s) => s.semantic === 'ready' && s.embedded === NOTES.length);
  await first.app.close();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).vectors).length, NOTES.length);

  const again = fakeEmbedder();
  const second = await boot({ embedder: again }, dir);
  try {
    const s = (await second.call('GET', '/api/status')).body;
    assert.equal(s.semantic, 'ready');
    assert.equal(s.embedded, NOTES.length);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(again.calls, 0, 'nothing re-embedded after restart');
    assert.ok((await second.ask('doctor visit')).sources.length > 0);

    assert.equal((await second.call('DELETE', `/api/items/${items[0].id}`)).status, 200);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).vectors).length, NOTES.length - 1);
    assert.equal(fs.existsSync(FILE + '.tmp'), false);
  } finally { await second.done(); }
});

test('/api/status reports semantic state and chunk counts', async () => {
  const off = await boot();
  const on = await boot({ embedder: fakeEmbedder() });
  const bad = await boot({ embedder: { model: 'bad', embed: async () => { throw new Error('down'); } } });
  try {
    const s0 = (await off.call('GET', '/api/status')).body;
    assert.equal(s0.semantic, 'off');
    assert.ok('items' in s0 && 'chunks' in s0 && 'categories' in s0 && 'llm' in s0, 'existing fields intact');
    assert.equal((await on.call('GET', '/api/status')).body.semantic, 'ready', 'empty library is ready');
    await on.addNotes(); await bad.addNotes();
    const s = await on.waitFor((x) => x.semantic === 'ready' && x.embedded === NOTES.length);
    assert.equal(s.total, NOTES.length);
    const b = await bad.waitFor((x) => x.semantic === 'unavailable');
    assert.equal(b.embedded, 0);
    assert.equal(b.total, NOTES.length);
  } finally { await off.done(); await on.done(); await bad.done(); }
});

test('hybrid results have no duplicates and never include deleted items', async () => {
  const t = await boot({ embedder: fakeEmbedder() });
  try {
    const items = await t.addNotes();
    await t.waitFor((s) => s.semantic === 'ready' && s.embedded === NOTES.length);
    const r = await t.ask('dentist appointment doctor');
    const keys = r.sources.map((s) => `${s.itemId}|${s.text}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(r.sources.map((s) => s.n), r.sources.map((_, i) => i + 1));
    assert.equal(r.sources[0].itemId, items[0].id, 'matched by both rankers, so first');
    await t.call('DELETE', `/api/items/${items[0].id}`);
    const r2 = await t.ask('dentist appointment doctor');
    assert.ok(!r2.sources.some((s) => s.itemId === items[0].id));
    assert.ok(r2.sources.some((s) => s.itemId === items[1].id), 'semantic neighbours remain');
  } finally { await t.done(); }
});

test('real createEmbedder talks to a mock Ollama server (/api/embed and legacy fallback)', async () => {
  const seen = [];
  const mk = (legacy) => http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body);
      seen.push([req.url, b]);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/embed' && !legacy) return res.end(JSON.stringify({ embeddings: b.input.map((t) => [t.length, 1]) }));
      if (req.url === '/api/embeddings') return res.end(JSON.stringify({ embedding: [b.prompt.length, 1] }));
      res.statusCode = 404; res.end('{}');
    });
  });
  for (const legacy of [false, true]) {
    const srv = mk(legacy);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const e = createEmbedder({ url: `http://127.0.0.1:${srv.address().port}/`, model: 'nomic' });
      assert.deepEqual(await e.embed(['ab', 'cde']), [[2, 1], [3, 1]]);
      assert.deepEqual(await e.embed([]), []);
    } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  }
  assert.deepEqual(seen[0], ['/api/embed', { model: 'nomic', input: ['ab', 'cde'] }]);
  assert.ok(seen.some(([u, b]) => u === '/api/embeddings' && b.prompt === 'cde' && b.model === 'nomic'));

  // timeout: server that never answers
  const slow = http.createServer(() => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    const e = createEmbedder({ url: `http://127.0.0.1:${slow.address().port}`, model: 'm', timeoutMs: 100 });
    await assert.rejects(e.embed(['x']), /timed out/);
  } finally { slow.closeAllConnections(); await new Promise((r) => slow.close(r)); }
});

test('app wired to a mock Ollama server end to end', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const f = fakeEmbedder();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: await f.embed(JSON.parse(body).input) }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const t = await boot({ embedder: createEmbedder({ url: `http://127.0.0.1:${srv.address().port}`, model: 'fake' }) });
  try {
    await t.addNotes();
    await t.waitFor((s) => s.semantic === 'ready' && s.embedded === NOTES.length);
    assert.ok((await t.ask('doctor visit')).sources.some((s) => /Dentist/.test(s.text)));
  } finally { await t.done(); srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
});

test('a chunk with a zero or wrong-length vector is not counted as embedded and is retried after the backoff', async () => {
  for (const bad of [[0, 0, 0], [1, 2]]) {
    let clock = 0, broken = true;
    const texts = ['Gym membership renewal due in March.', 'Dentist appointment on Tuesday at three.', 'Pasta carbonara with guanciale and pecorino.'];
    const base = fakeEmbedder();
    const seen = new Map();
    const embedder = {
      model: 'fake',
      async embed(batch) {
        for (const t of batch) seen.set(t, (seen.get(t) || 0) + 1);
        const vecs = await base.embed(batch);
        return vecs.map((v, i) => (batch[i] === texts[0] && broken ? bad : v));
      },
    };
    const s = createSemantic({ embedder, getTexts: () => texts, now: () => clock, invalidRetryMs: 600000 });
    const settle = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };
    try {
      s.kick();
      await settle(() => s.status().embedded === 2);
      assert.deepEqual(s.status(), { semantic: 'indexing', embedded: 2, total: 3 });
      s.kick();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(seen.get(texts[0]), 1, 'not retried before the backoff');
      clock = 600000; broken = false;
      s.kick();
      await settle(() => s.status().semantic === 'ready');
      assert.equal(seen.get(texts[0]), 2, 'retried once the backoff has passed');
      assert.deepEqual(s.status(), { semantic: 'ready', embedded: 3, total: 3 });
    } finally { s.close(); }
  }
});
