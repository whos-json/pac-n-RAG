'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmbedder, createSemantic, sha1 } = require('../embed.js');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('semantic: a delete racing an in-flight batch never persists stale vectors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-emb2-'));
  let texts = ['alpha note'], release, started;
  const gate = new Promise((r) => { release = r; });
  const inFlight = new Promise((r) => { started = r; });
  const embedder = { model: 'fake', async embed(batch) { started(); await gate; return batch.map(() => [1, 0]); } };
  const sem = createSemantic({ dataDir: dir, embedder, getTexts: () => texts });
  try {
    sem.kick();
    await inFlight;
    texts = ['beta note'];
    sem.kick(); // the delete + add: prunes now, but the old batch is still in flight
    release();
    const file = path.join(dir, 'embeddings.json');
    const end = Date.now() + 5000;
    let live = false;
    while (Date.now() < end && !live) {
      await new Promise((r) => setTimeout(r, 20));
      try { live = sem.status().semantic === 'ready' && fs.existsSync(file) && Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).vectors).length > 0; } catch { /* mid-write */ }
    }
    assert.ok(live, 'indexing finished');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).vectors), [sha1('beta note')]);
  } finally { sem.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('embedder: one 404 does not latch; legacy success latches, /api/embed is re-probed after the interval', async () => {
  let clock = 0, newOk = false;
  const calls = [];
  const fetchImpl = async (url) => {
    const ep = new URL(url).pathname;
    calls.push(ep);
    if (ep === '/api/embed') return newOk ? json({ embeddings: [[1, 2]] }) : json({}, 404);
    return json({ embedding: [3, 4] });
  };
  const e = createEmbedder({ model: 'm', fetchImpl, now: () => clock, reprobeMs: 60000 });
  assert.deepEqual(await e.embed(['a']), [[3, 4]]);
  assert.deepEqual(calls, ['/api/embed', '/api/embeddings']);
  calls.length = 0;
  await e.embed(['a']); // latched: legacy only
  assert.deepEqual(calls, ['/api/embeddings']);
  calls.length = 0;
  clock = 61000; newOk = true;
  assert.deepEqual(await e.embed(['a']), [[1, 2]]);
  assert.deepEqual(calls, ['/api/embed']);
  calls.length = 0;
  await e.embed(['a']); // modern endpoint again
  assert.deepEqual(calls, ['/api/embed']);
});

test('embedder: a malformed reply with a failing legacy endpoint does not latch', async () => {
  let legacyOk = false;
  const calls = [];
  const fetchImpl = async (url) => {
    const ep = new URL(url).pathname;
    calls.push(ep);
    if (ep === '/api/embed') return json({ nope: true });
    return legacyOk ? json({ embedding: [1] }) : json({}, 500);
  };
  const e = createEmbedder({ model: 'm', fetchImpl, now: () => 0 });
  await assert.rejects(e.embed(['a']));
  calls.length = 0;
  legacyOk = true;
  await e.embed(['a']);
  await e.embed(['a']);
  assert.deepEqual(calls, ['/api/embed', '/api/embeddings', '/api/embeddings']); // latched only after the success; probe not due yet
});

test('semantic rank: a failed query starts a cooldown with no embedder calls, reset by a later success', async () => {
  let clock = 0, fail = true, calls = 0;
  const embedder = { model: 'fake', async embed() { calls++; if (fail) throw new Error('down'); return [[1, 0]]; } };
  const sem = createSemantic({ embedder, getTexts: () => [], queryCooldownMs: 30000, now: () => clock });
  const origErr = console.error; console.error = () => {};
  try {
    assert.equal(await sem.rank('q', ['t']), null);
    assert.equal(calls, 1);
    clock = 10000;
    assert.equal(await sem.rank('q', ['t']), null);
    assert.equal(calls, 1, 'no embedder call during the cooldown');
    clock = 31000; fail = false;
    assert.deepEqual(await sem.rank('q', ['t']), []); // asks again; nothing cached to rank, but it succeeded
    assert.equal(calls, 2);
    fail = true; clock = 32000;
    await sem.rank('q', ['t']);
    assert.equal(calls, 3, 'cooldown was reset by the success');
  } finally { console.error = origErr; sem.close(); }
});
