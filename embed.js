'use strict';
// Optional semantic retrieval for PAC&RAG: talks to a LOCAL Ollama-style embedding server (no dependencies).
// Disabled unless PACRAG_EMBED_MODEL is set. When disabled or failing, callers fall back to plain BM25.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function isLoopbackUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function createEmbedder({ url = 'http://127.0.0.1:11434', model, fetchImpl, timeoutMs = 30000, allowRemote = false, now = Date.now, reprobeMs = 60000 } = {}) {
  if (!model) throw new Error('An embedding model name is required.');
  if (!isLoopbackUrl(url) && !allowRemote) {
    throw new Error(`Refusing to send documents to non-local embedding server ${url}. Set PACRAG_EMBED_ALLOW_REMOTE=1 to allow it.`);
  }
  const base = String(url).replace(/\/+$/, '');
  const doFetch = fetchImpl || globalThis.fetch;
  let perText = false; // learned: server only has the legacy /api/embeddings endpoint (re-probed after reprobeMs)
  let perTextAt = 0;

  async function post(endpoint, body, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await doFetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      if (!r.ok) { const e = new Error(`embedding server answered ${r.status}`); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) {
      if (ac.signal.aborted) throw new Error('embedding server timed out');
      throw e;
    } finally { clearTimeout(timer); }
  }

  async function embed(texts, { timeoutMs: ms = timeoutMs } = {}) {
    if (!texts.length) return [];
    if (!perText || now() - perTextAt >= reprobeMs) {
      try {
        const d = await post('/api/embed', { model, input: texts }, ms);
        if (Array.isArray(d && d.embeddings) && d.embeddings.length === texts.length) return d.embeddings;
        throw Object.assign(new Error('unexpected /api/embed response'), { status: 0 });
      } catch (e) {
        if (!perText && e.status !== 404 && e.status !== 0) throw e;
      }
    }
    const out = [];
    for (const t of texts) {
      const d = await post('/api/embeddings', { model, prompt: t }, ms);
      if (!Array.isArray(d && d.embedding)) throw new Error('unexpected /api/embeddings response');
      out.push(d.embedding);
    }
    // only latch once the legacy endpoint has actually worked
    perText = true; perTextAt = now();
    return out;
  }
  return { embed, model, url: base };
}

// Returns an embedder from the environment, or null when semantic search is off or misconfigured.
function fromEnv(env = process.env, fetchImpl) {
  if (!env.PACRAG_EMBED_MODEL) return null;
  try {
    return createEmbedder({ url: env.OLLAMA_URL || 'http://127.0.0.1:11434', model: env.PACRAG_EMBED_MODEL, fetchImpl, allowRemote: env.PACRAG_EMBED_ALLOW_REMOTE === '1' });
  } catch (e) {
    console.error(`Semantic search disabled: ${e.message}`);
    return null;
  }
}

const normalise = (v) => {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : null;
};

// The most common length among these vectors: the model's dimension.
const modeLength = (vs) => {
  const counts = new Map();
  for (const v of vs) if (v) counts.set(v.length, (counts.get(v.length) || 0) + 1);
  let best = 0, most = 0;
  for (const [len, c] of counts) if (c > most) { best = len; most = c; }
  return best;
};

// Reciprocal rank fusion over any number of ranked key lists. Returns [{ key, score }] best first.
function rrf(lists, k = 60) {
  const s = new Map();
  for (const list of lists) list.forEach((key, i) => s.set(key, (s.get(key) || 0) + 1 / (k + i + 1)));
  return [...s].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

// Vector cache + background indexer. `getTexts()` returns the current chunk texts.
function createSemantic({ dataDir, embedder, getTexts, queryTimeoutMs = 3000, batchSize = 16, minCosine = 0.3, queryCooldownMs = 30000, invalidRetryMs = 600000, now = Date.now }) {
  const enabled = !!embedder;
  const FILE = dataDir && path.join(dataDir, 'embeddings.json');
  const vecs = new Map(); // sha1(text) -> normalised vector, for chunks whose vector is usable
  const invalidAt = new Map(); // sha1(text) -> when the embedder last gave an unusable answer; retried after invalidRetryMs
  const hashMemo = new Map();
  const hashOf = (t) => {
    let h = hashMemo.get(t);
    if (!h) { if (hashMemo.size > 100000) hashMemo.clear(); h = sha1(t); hashMemo.set(t, h); }
    return h;
  };
  let queryFailedAt = null;
  let running = false, again = false, timer = null, backoff = 0, failed = false, warned = false, retry = null, closed = false;
  let dim = 0, invalidTimer = null; // dim: the model's vector length, 0 until a usable vector is seen
  const usable = (v) => !!v && v.length === dim;
  const due = (t) => { const h = hashOf(t); return !usable(vecs.get(h)) && (!invalidAt.has(h) || now() - invalidAt.get(h) >= invalidRetryMs); };

  if (enabled && FILE) {
    try {
      const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (d && d.model === embedder.model && d.vectors && typeof d.vectors === 'object') {
        const loaded = [];
        for (const [h, v] of Object.entries(d.vectors)) { const n = normalise(v); if (n && /^[0-9a-f]{40}$/.test(h)) loaded.push([h, n]); }
        dim = modeLength(loaded.map(([, n]) => n));
        for (const [h, n] of loaded) if (n.length === dim) vecs.set(h, n);
      }
    } catch { /* no cache yet, or unreadable: start empty */ }
  }

  function persist() {
    if (!FILE) return;
    const tmp = FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ model: embedder.model, vectors: Object.fromEntries([...vecs].filter(([, v]) => v)) }));
      fs.renameSync(tmp, FILE);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }
  function prune() {
    const live = new Set(getTexts().map(hashOf));
    let changed = false;
    for (const h of [...vecs.keys()]) if (!live.has(h)) { vecs.delete(h); changed = true; }
    for (const h of [...invalidAt.keys()]) if (!live.has(h)) invalidAt.delete(h);
    if (changed) persist();
    return live;
  }
  const warn = (e) => { if (!warned) { warned = true; console.error(`Semantic search: embedding server unavailable (${e.message}); using keyword search. Will keep retrying.`); } };

  async function run() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        let sinceSave = 0;
        for (;;) {
          const texts = [...new Set(getTexts())];
          const missing = texts.filter(due);
          if (!missing.length || closed) break;
          const batch = missing.slice(0, batchSize);
          const out = await embedder.embed(batch);
          if (!Array.isArray(out) || out.length !== batch.length) throw new Error('embedding count mismatch');
          const norm = out.map(normalise);
          if (!dim) dim = modeLength(norm);
          batch.forEach((t, i) => {
            const h = hashOf(t), n = usable(norm[i]) ? norm[i] : null;
            if (n) { vecs.set(h, n); invalidAt.delete(h); } else { vecs.delete(h); invalidAt.set(h, now()); }
          });
          // a delete may have raced this batch: never keep (or persist) vectors for chunks that are gone
          const live = new Set(getTexts().map(hashOf));
          for (const h of [...vecs.keys()]) if (!live.has(h)) vecs.delete(h);
          // chunks without a usable vector are left out of the cache and retried after invalidRetryMs
          if (++sinceSave >= 10) { persistNonNull(); sinceSave = 0; }
        }
        persistNonNull();
        failed = false; backoff = 0; warned = false;
        scheduleInvalidRetry();
      } while (again && !closed);
    } catch (e) {
      failed = true; warn(e);
      backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
      if (!closed) { clearTimeout(retry); retry = setTimeout(() => { retry = null; kick(); }, backoff); retry.unref && retry.unref(); }
    } finally { running = false; }
  }
  const persistNonNull = persist;

  // Call after any change to the library: prunes stale vectors now and embeds new chunks in the background.
  function kick() {
    if (!enabled || closed) return;
    try { prune(); } catch { /* never break a request */ }
    if (retry || timer) return;
    timer = setTimeout(() => { timer = null; run(); }, 0);
    timer.unref && timer.unref();
  }

  // Unusable chunks are retried by a timer once their backoff has passed, so they do not wait for the next library change.
  function scheduleInvalidRetry() {
    clearTimeout(invalidTimer); invalidTimer = null;
    if (closed) return;
    const live = new Set(getTexts().map(hashOf));
    let soonest = Infinity;
    for (const [h, at] of invalidAt) if (live.has(h)) soonest = Math.min(soonest, at);
    if (soonest === Infinity) return;
    invalidTimer = setTimeout(() => { invalidTimer = null; kick(); }, Math.max(1, soonest + invalidRetryMs - now()));
    invalidTimer.unref && invalidTimer.unref();
  }

  function status() {
    if (!enabled) return { semantic: 'off' };
    const live = new Set(getTexts().map(hashOf));
    let embedded = 0;
    live.forEach((h) => { if (usable(vecs.get(h))) embedded++; });
    const total = live.size;
    const semantic = failed && embedded < total ? 'unavailable' : embedded < total ? 'indexing' : 'ready';
    return { semantic, embedded, total };
  }

  // Ranks chunk indices (into `texts`) by cosine similarity to the query. Returns null if unavailable.
  async function rank(q, texts, limit = 30) {
    if (!enabled || !texts.length) return null;
    if (queryFailedAt !== null && now() - queryFailedAt < queryCooldownMs) return null;
    let qv;
    try {
      let to;
      const timeout = new Promise((_, rej) => { to = setTimeout(() => rej(new Error('query embedding timed out')), queryTimeoutMs); });
      try { [qv] = await Promise.race([embedder.embed([q], { timeoutMs: queryTimeoutMs }), timeout]); } finally { clearTimeout(to); }
      qv = normalise(qv);
    } catch (e) { warn(e); queryFailedAt = now(); return null; }
    if (!qv) { queryFailedAt = now(); return null; }
    queryFailedAt = null;
    const scored = [], all = [];
    texts.forEach((t, i) => {
      const v = vecs.get(hashOf(t));
      if (!v || v.length !== qv.length) return;
      let s = 0;
      for (let j = 0; j < v.length; j++) s += v[j] * qv[j];
      all.push(s);
      if (s >= minCosine) scored.push({ i, s });
    });
    // A ranker that scores every passage alike cannot say which one is relevant, so it contributes nothing.
    if (all.length > 1 && Math.max(...all) - Math.min(...all) < 1e-6) return [];
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.i);
  }

  return { enabled, kick, status, rank, close() { closed = true; clearTimeout(timer); clearTimeout(retry); clearTimeout(invalidTimer); } };
}

module.exports = { createEmbedder, createSemantic, fromEnv, isLoopbackUrl, rrf, sha1 };
