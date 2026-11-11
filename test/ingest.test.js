'use strict';
// Ingest rules: text decoding, plain-text formats, links, empty input, index terms, body limits and surrogate pairs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start, chunk } = require('../server.js');

const H = { 'x-pacrag': '1', 'content-type': 'application/json' };
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-ingest-'));
  const app = await start({ port: 0, dataDir: dir, answerer: null });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data };
  };
  const note = (text) => call('POST', '/api/items', { type: 'note', text });
  const upload = (name, buf) => call('POST', `/api/upload?name=${encodeURIComponent(name)}`, buf, { 'x-pacrag': '1' });
  const ask = (q) => call('POST', '/api/ask', { q }).then((r) => r.body);
  const item = (id) => call('GET', `/api/items/${id}`).then((r) => r.body);
  return { app, call, note, upload, ask, item, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// A local site that redirects /start and /alias to /final, and counts every request it receives.
async function linkSite() {
  const hits = new Map();
  const srv = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) || 0) + 1);
    if (req.url === '/final') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<html><head><title>Final page</title></head><body><p>The redirected page says hello.</p></body></html>');
    }
    if (req.url === '/start' || req.url === '/alias') { res.writeHead(302, { location: '/final' }); return res.end(); }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    total: () => [...hits.values()].reduce((a, b) => a + b, 0),
    close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
  };
}

test('stray bytes in UTF-8 text do not turn it into Windows-1252 (I1)', async () => {
  const t = await boot();
  try {
    const buf = Buffer.concat([Buffer.from('Le café ouvre à 9 h. '), Buffer.from([0xe9]), Buffer.from(' Merci.\n', 'utf8')]);
    const r = await t.upload('horaires.txt', buf);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok((await t.item(r.body.id)).text.includes('Le café ouvre'));
    const found = (await t.ask('café')).sources;
    assert.ok(found.some((s) => s.itemId === r.body.id), 'café is not found by search');
  } finally { await t.done(); }
});

test('a genuine Windows-1252 file still decodes correctly (I1)', async () => {
  const t = await boot();
  try {
    const r = await t.upload('prix.txt', Buffer.from('Prix : 5 \x80 pour le caf\xe9 \x93ici\x94\n', 'latin1'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await t.item(r.body.id)).text, 'Prix : 5 € pour le café “ici”');
  } finally { await t.done(); }
});

test('UTF-16LE with a byte-order mark still decodes (I1)', async () => {
  const t = await boot();
  try {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Vélo électrique à Lyon', 'utf16le')]);
    const r = await t.upload('velo.txt', buf);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await t.item(r.body.id)).text, 'Vélo électrique à Lyon');
  } finally { await t.done(); }
});

test('unknown plain-text formats are searchable; documents, images and binaries are not sniffed as text (I2)', async () => {
  const t = await boot();
  try {
    const srt = await t.upload('movie.srt', Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nThe lighthouse keeper climbs the stairs.\n'));
    const toml = await t.upload('config.toml', Buffer.from('title = "Bakery invoices"\n\n[owner]\nname = "Mara"\n'));
    assert.equal(srt.status, 201, JSON.stringify(srt.body));
    assert.equal(toml.status, 201, JSON.stringify(toml.body));
    assert.equal(srt.body.noText, false);
    assert.equal(toml.body.noText, false);
    assert.ok((await t.ask('lighthouse keeper')).sources.some((s) => s.itemId === srt.body.id), 'movie.srt is not searchable');
    assert.ok((await t.ask('bakery invoices')).sources.some((s) => s.itemId === toml.body.id), 'config.toml is not searchable');

    const png = await t.upload('photo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('Bakery invoices scanned by hand')]));
    assert.equal(png.status, 201, JSON.stringify(png.body));
    assert.equal(png.body.category, 'Images');
    assert.equal(png.body.noText, true);
    assert.equal(png.body.state, 'unread');

    const bin = await t.upload('archive.xyz', Buffer.from([0x50, 0x00, 0x03, 0x04, 0x41, 0x42]));
    assert.equal(bin.body.noText, true);
    assert.equal(bin.body.category, 'Unread files');
  } finally { await t.done(); }
});

test('a link is stored by its final address; repeats are refused before any second fetch (I3)', async () => {
  const t = await boot();
  const site = await linkSite();
  try {
    const added = await t.call('POST', '/api/items', { type: 'url', url: `${site.base}/start#intro` });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.source, `${site.base}/final`);
    assert.equal(site.total(), 2, 'one request to /start and one to the redirect target');

    const again = await t.call('POST', '/api/items', { type: 'url', url: `${site.base}/start` });
    assert.equal(again.status, 409);
    const direct = await t.call('POST', '/api/items', { type: 'url', url: `${site.base}/final` });
    assert.equal(direct.status, 409);
    assert.equal(site.total(), 2, 'a repeated link must not fetch again');

    const alias = await t.call('POST', '/api/items', { type: 'url', url: `${site.base}/alias` });
    assert.equal(alias.status, 409, 'a new link whose final address is already stored is refused');
    assert.equal(site.total(), 4);
  } finally { await site.close(); await t.done(); }
});

test('whitespace, zero-width and format characters count as empty (I4)', async () => {
  const t = await boot();
  try {
    const n = await t.note('\u200b\u200b');
    assert.equal(n.status, 400);
    assert.equal(n.body.error, 'The note is empty.');
    assert.equal((await t.note(' \ufeff\u00ad \n')).status, 400);

    const f = await t.upload('blank.txt', Buffer.from('\u200b\u200b\u200b', 'utf8'));
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal(f.body.state, 'unread');
    assert.equal(f.body.noText, true);
    assert.equal(f.body.reason, 'no-text');
    assert.equal(f.body.category, 'Unread files');
  } finally { await t.done(); }
});

test('text with no index terms is unread with reason no-words (I5)', async () => {
  const t = await boot();
  try {
    const r = await t.note('I a');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.reason, 'no-words');
    assert.equal(r.body.state, 'unread');
    assert.equal(r.body.noText, true);
    assert.equal(r.body.category, 'Unread files');
    assert.equal(r.body.chunks, 0);
  } finally { await t.done(); }
});

test('the note body limit counts escaped characters, and the note message names the size (I6)', async () => {
  const t = await boot();
  try {
    // 600,000 newlines are 1.2 MB of JSON, more than the old 1 MiB body limit; the note has words, so it is not blank.
    const ok = await t.note(`${'\n'.repeat(600000)}Grocery list: eggs and milk.`);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const big = await t.note('word '.repeat(220000)); // 1.1 MB of text
    assert.equal(big.status, 413);
    assert.equal(big.body.error, 'That note is too large.');
  } finally { await t.done(); }
});

test('truncation and chunking never split a surrogate pair (I7)', async () => {
  // Chunk 0 would end on the high half of the emoji without the fix.
  const parts = chunk(`${'a'.repeat(799)}😀${'b'.repeat(900)}`);
  for (const p of parts) assert.ok(!LONE_SURROGATE.test(p), 'lone surrogate in a chunk');
  assert.equal(parts[0], 'a'.repeat(799));

  const t = await boot();
  try {
    // 2,000,001 code units: the emoji straddles the MAX_TEXT cut at 2,000,000.
    const r = await t.upload('long.txt', Buffer.from(`${'a'.repeat(1_999_999)}😀`, 'utf8'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.truncated, true);
    assert.ok(!LONE_SURROGATE.test(r.body.preview), 'lone surrogate in chunk 0');
    const full = await t.item(r.body.id);
    assert.ok(!LONE_SURROGATE.test(full.text), 'lone surrogate in the stored text');
  } finally { await t.done(); }
});
