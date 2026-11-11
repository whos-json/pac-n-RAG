'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const wf = require('../workflow.js');
const { start } = require('../server.js');

const H = { 'x-pacrag': '1', 'content-type': 'application/json' };
async function boot(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'))) {
  const app = await start({ port: 0, dataDir: dir, answerer: null });
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(`http://127.0.0.1:${app.port}${p}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const t = await r.text();
    let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, body: data };
  };
  return { app, call, dir, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const note = (t, text) => t.call('POST', '/api/items', { type: 'note', text });
const backupsIn = (dir) => fs.readdirSync(dir).filter((f) => /^items\.json\..+\.bak$/.test(f));

// ---- the pure state machine: every state x every event ----
const ITEMS = {
  filed: { noText: false, needsReview: false },
  review: { noText: false, needsReview: true },
  unread: { noText: true, needsReview: false },
};
const EXPECT = {
  filed: { keep: 'filed', sort: 'filed', delete: 'deleted' },
  review: { keep: 'filed', sort: 'filed', delete: 'deleted' },
  unread: { sort: 'unread', delete: 'deleted' }, // keep is refused: there is nothing to review
};

test('stateOf derives exactly one state per item', () => {
  for (const [state, item] of Object.entries(ITEMS)) assert.equal(wf.stateOf(item), state);
  assert.equal(wf.stateOf({ noText: true, needsReview: true }), 'unread'); // contradictory data resolves one way, never two
});

test('every state/event pair either moves to the documented state or is refused', () => {
  for (const [state, item] of Object.entries(ITEMS)) {
    for (const ev of ['keep', 'sort', 'delete']) {
      if (!(ev in EXPECT[state])) {
        assert.throws(() => wf.transition(item, ev, { category: 'X' }), (e) => e.status === 409 && !e.allowed.includes(ev), `${state} + ${ev}`);
        continue;
      }
      const r = wf.transition(item, ev, { category: 'X' });
      assert.equal(r.to, EXPECT[state][ev], `${state} + ${ev}`);
    }
    for (const ev of ['', 'nope', 'constructor', '__proto__', undefined, null, 'KEEP']) {
      assert.throws(() => wf.transition(item, ev), (e) => e.status === 409 && Array.isArray(e.allowed), `${state} + ${String(ev)}`);
    }
  }
});

test('sort needs a valid category and clears the ghost flag; keep clears it too', () => {
  const ghost = { noText: false, needsReview: true, confidence: 0.3 };
  for (const bad of [undefined, null, '', '   ', 5, {}, 'x'.repeat(41), '\u0000\u200b', '\u{1F600}'.repeat(41)]) {
    assert.throws(() => wf.transition(ghost, 'sort', { category: bad }), (e) => e.status === 400, String(bad));
  }
  assert.equal(wf.cleanCategory('a\u0000b\u200b c'), 'ab c'); // invisible characters are dropped, not rejected
  assert.equal(wf.cleanCategory('\u{1F600}'.repeat(40)).length, 80); // the limit counts characters, not UTF-16 units
  assert.deepEqual(wf.transition(ghost, 'sort', { category: ' New   Room ' }).patch, { category: 'New Room', needsReview: false, confidence: 1 });
  assert.deepEqual(wf.transition(ghost, 'keep').patch, { needsReview: false });
  assert.equal(wf.transition(ghost, 'delete').patch, null);
});

test('repair fixes or drops damaged records instead of letting them break every request', () => {
  assert.equal(wf.repair(null), null);
  assert.equal(wf.repair('x'), null);
  assert.equal(wf.repair({}), null);
  assert.equal(wf.repair({ id: '../evil' }), null);
  const r = wf.repair({ id: 'a', chunks: 'nope', needsReview: true, confidence: 'hi', title: ' ', category: 7 });
  assert.deepEqual([r.chunks, r.noText, r.needsReview, r.confidence, r.title, r.category], [[], true, false, 1, 'Untitled', 'Unread files']);
  assert.equal(wf.repair({ id: 'b', chunks: ['t'], confidence: 9 }).confidence, 1);
});

// ---- the same machine, enforced by the API ----
test('items report their state and the actions the UI may offer', async () => {
  const t = await boot();
  try {
    const n = (await note(t, 'Remember to water the plants on Friday')).body;
    assert.equal(n.state, 'filed');
    assert.deepEqual(n.actions, ['sort', 'delete']); // keep is accepted (idempotent) but only offered to ghosts
    const pdf = await t.call('POST', '/api/upload?name=a.pdf', Buffer.from('%PDF-1.4 \u0000\u0001'), { 'x-pacrag': '1', 'content-type': 'application/octet-stream' });
    assert.equal(pdf.body.state, 'unread');
  } finally { await t.done(); }
});

test('PATCH: refused requests change nothing and say why', async () => {
  const t = await boot();
  try {
    const n = (await note(t, 'Dentist appointment on 3 March at 9am')).body;
    const url = `/api/items/${n.id}`;
    for (const body of [{}, { reviewed: false }, { reviewed: 'yes' }, { color: 'red' }, { category: 'Ok', color: 'red' }, { category: '' }, { category: 7 }]) {
      assert.equal((await t.call('PATCH', url, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await t.call('GET', url)).body.category, n.category);
    assert.equal((await t.call('PATCH', '/api/items/does-not-exist', { reviewed: true })).status, 404);
  } finally { await t.done(); }
});

test('PATCH is idempotent: keeping or sorting twice gives the same result', async () => {
  const t = await boot();
  try {
    const n = (await note(t, 'Invoice 4411 for 250 USD is due 1 May')).body;
    const url = `/api/items/${n.id}`;
    const a = await t.call('PATCH', url, { reviewed: true });
    const b = await t.call('PATCH', url, { reviewed: true });
    assert.equal(a.status, 200); assert.deepEqual(a.body, b.body);
    const c = await t.call('PATCH', url, { category: 'Money' });
    const d = await t.call('PATCH', url, { category: 'Money' });
    assert.deepEqual(c.body, d.body);
  } finally { await t.done(); }
});

test('category spelling is canonical: "money" joins the existing "Money" room', async () => {
  const t = await boot();
  try {
    const a = (await note(t, 'Invoice 4411 for 250 USD is due 1 May')).body;
    const b = (await note(t, 'Bring the green umbrella to the picnic')).body;
    await t.call('PATCH', `/api/items/${a.id}`, { category: 'Money' });
    const moved = await t.call('PATCH', `/api/items/${b.id}`, { category: '  money ' });
    assert.equal(moved.body.category, 'Money');
    const cats = (await t.call('GET', '/api/status')).body.categories.map((c) => c.name);
    assert.equal(cats.filter((c) => c.toLowerCase() === 'money').length, 1);
  } finally { await t.done(); }
});

test('delete is terminal: the item, its file and every later action on it are gone', async () => {
  const t = await boot();
  try {
    const f = (await t.call('POST', '/api/upload?name=n.txt', Buffer.from('plain text about gardening tools and soil'), { 'x-pacrag': '1', 'content-type': 'application/octet-stream' })).body;
    assert.equal((await t.call('DELETE', `/api/items/${f.id}`)).status, 200);
    assert.equal((await t.call('DELETE', `/api/items/${f.id}`)).status, 404);
    assert.equal((await t.call('PATCH', `/api/items/${f.id}`, { reviewed: true })).status, 404);
    assert.equal((await t.call('GET', `/api/items/${f.id}`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(t.dir, 'files')), []);
  } finally { await t.done(); }
});

// ---- defensive storage ----
test('a failed save rolls back, so memory and disk never disagree', async () => {
  const t = await boot();
  try {
    const keep = (await note(t, 'First note about quarterly planning')).body;
    // Make saving impossible: a directory where the temp file must go.
    const tmp = path.join(t.dir, 'items.json.tmp');
    fs.rmSync(tmp, { force: true }); fs.mkdirSync(tmp);
    assert.equal((await note(t, 'Second note that cannot be saved')).status, 500);
    assert.equal((await t.call('GET', '/api/items')).body.items.length, 1);
    assert.equal((await t.call('PATCH', `/api/items/${keep.id}`, { category: 'Planning' })).status, 500);
    assert.equal((await t.call('GET', `/api/items/${keep.id}`)).body.category, keep.category);
    assert.equal((await t.call('DELETE', `/api/items/${keep.id}`)).status, 500);
    assert.equal((await t.call('GET', '/api/items')).body.items.length, 1);
    const up = await t.call('POST', '/api/upload?name=x.txt', Buffer.from('text that cannot be saved either'), { 'x-pacrag': '1', 'content-type': 'application/octet-stream' });
    assert.equal(up.status, 500);
    assert.deepEqual(fs.readdirSync(path.join(t.dir, 'files')), []); // no orphan file left behind
    fs.rmSync(tmp, { recursive: true });
    assert.equal((await note(t, 'Third note, saved after recovery')).status, 201); // and the app recovers by itself
  } finally { await t.done(); }
});

test('startup sets aside files with no record, repairs bad records, and never touches files when there is no database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  fs.writeFileSync(path.join(dir, 'files', 'precious.txt'), 'x');
  let t = await boot(dir); // no items.json yet: nothing may be moved
  assert.ok(fs.existsSync(path.join(dir, 'files', 'precious.txt')));
  await t.app.close();

  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items: [{ id: 'ok1', chunks: ['hello world'], title: 'T', category: 'C', added: 1 }, { nope: true }, null] }));
  t = await boot(dir);
  try {
    const list = (await t.call('GET', '/api/items')).body.items;
    assert.deepEqual(list.map((i) => i.id), ['ok1']);
    assert.ok(!fs.existsSync(path.join(dir, 'files', 'precious.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'orphans', 'precious.txt')));
  } finally { await t.done(); }
});

test('an item whose file vanished does not crash the server', async () => {
  const t = await boot();
  try {
    const f = (await t.call('POST', '/api/upload?name=n.txt', Buffer.from('some text about birdwatching in spring'), { 'x-pacrag': '1', 'content-type': 'application/octet-stream' })).body;
    const name = fs.readdirSync(path.join(t.dir, 'files'))[0];
    fs.rmSync(path.join(t.dir, 'files', name));
    await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${t.app.port}/files/${name}`, (r) => { r.resume(); r.on('end', resolve); r.on('error', resolve); r.on('close', resolve); }).on('error', resolve);
    });
    assert.equal((await t.call('GET', '/api/status')).status, 200); // still alive
    assert.equal((await t.call('DELETE', `/api/items/${f.id}`)).status, 200); // and the dangling record can be removed
  } finally { await t.done(); }
});

// ---- findings from the combined review ----
test('ghosts are offered keep; other states are not', () => {
  assert.deepEqual(wf.allowedEvents({ noText: false, needsReview: true }), ['keep', 'sort', 'delete']);
  assert.deepEqual(wf.allowedEvents({ noText: false, needsReview: false }), ['sort', 'delete']);
  assert.deepEqual(wf.allowedEvents({ noText: true, needsReview: false }), ['sort', 'delete']);
  assert.throws(() => wf.transition({ noText: true, needsReview: false }, 'keep'), (e) => e.status === 409 && e.allowed.join() === 'sort,delete');
});

test('one category rule everywhere: an existing 40-emoji room can be chosen again, and stored odd names are repaired at load', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const rec = (id, category) => ({ id, chunks: ['hello world text'], title: id, category, added: 1 });
  const emoji = '\u{1F600}'.repeat(40);
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items: [rec('a', emoji), rec('b', 'Two  Spaces'), rec('c', 'Plain')] }));
  const t = await boot(dir);
  try {
    const cats = Object.fromEntries((await t.call('GET', '/api/items')).body.items.map((i) => [i.id, i.category]));
    assert.equal(cats.b, 'Two Spaces');
    assert.equal((await t.call('PATCH', '/api/items/c', { category: emoji })).status, 200);
    assert.equal((await t.call('PATCH', '/api/items/c', { category: 'two spaces' })).body.category, 'Two Spaces');
  } finally { await t.done(); }
});

test('damaged records are backed up on load, and deleting a record with no file still succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const original = JSON.stringify({ items: [{ id: 'ok', chunks: ['some text here'], title: 'T', category: 'C', added: 1 }, { broken: true }] });
  fs.writeFileSync(path.join(dir, 'items.json'), original);
  const t = await boot(dir);
  try {
    const [bak] = backupsIn(dir);
    assert.equal(fs.readFileSync(path.join(dir, bak), 'utf8'), original);
    await t.call('PATCH', '/api/items/ok', { category: 'Other' }); // a save drops the broken record from items.json, not from the backup
    assert.equal(fs.readFileSync(path.join(dir, bak), 'utf8'), original);
    assert.equal((await t.call('DELETE', '/api/items/ok')).status, 200);
  } finally { await t.done(); }
});

test('every startup that repairs or drops a record keeps its own backup; the first is never overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const ok = { id: 'ok', chunks: ['some text here'], title: 'T', category: 'C', added: 1 };
  const first = JSON.stringify({ items: [ok, { broken: true }] });
  const second = JSON.stringify({ items: [ok, { also: 'broken' }] });
  fs.writeFileSync(path.join(dir, 'items.json'), first);
  let t = await boot(dir);
  await t.app.close();
  fs.writeFileSync(path.join(dir, 'items.json'), second);
  t = await boot(dir);
  try {
    const contents = backupsIn(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
    assert.deepEqual(contents, [first, second].sort());
  } finally { await t.done(); }
});

test('auto-named categories reuse the spelling the user already chose', async () => {
  const t = await boot();
  try {
    const a = (await note(t, 'Invoice 4411 for 250 USD is due 1 May')).body;
    await t.call('PATCH', `/api/items/${a.id}`, { category: 'Dentist & Appointment' });
    const b = (await note(t, 'Dentist appointment on 3 March at 9am')).body;
    const cats = (await t.call('GET', '/api/status')).body.categories.map((c) => c.name);
    assert.equal(cats.filter((c) => c.toLowerCase() === 'dentist & appointment').length, 1);
    assert.ok(b.category);
  } finally { await t.done(); }
});

test('a stored source is kept only when it is a web link', async () => {
  assert.equal(wf.repair({ id: 'a', chunks: ['x'], source: 'javascript:alert(1)' }).source, undefined);
  assert.equal(wf.repair({ id: 'b', chunks: ['x'], source: 'file:///C:/secret.txt' }).source, undefined);
  assert.equal(wf.repair({ id: 'c', chunks: ['x'], source: 'not a link' }).source, undefined);
  assert.equal(wf.repair({ id: 'd', chunks: ['x'], source: 'https://example.com/page' }).source, 'https://example.com/page');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items: [{ id: 'bad', chunks: ['hello world text'], title: 'T', category: 'C', added: 1, source: 'javascript:alert(1)' }] }));
  const t = await boot(dir);
  try {
    const [it] = (await t.call('GET', '/api/items')).body.items;
    assert.ok(!('source' in it));
  } finally { await t.done(); }
});

test('keep is refused on an unread item and is a no-op on a filed one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items: [{ id: 'scan', chunks: [], title: 'scan.png', category: 'Images', mime: 'image/png', added: 1 }] }));
  const t = await boot(dir);
  try {
    const n = (await note(t, 'Remember to water the plants on Friday')).body;
    const refused = await t.call('PATCH', '/api/items/scan', { reviewed: true });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.allowed, ['sort', 'delete']);
    assert.equal((await t.call('GET', '/api/items/scan')).body.category, 'Images');
    assert.equal((await t.call('PATCH', `/api/items/${n.id}`, { reviewed: true })).status, 200);
    assert.equal((await t.call('PATCH', `/api/items/${n.id}`, { reviewed: true })).status, 200);
    assert.equal((await t.call('PATCH', '/api/items/scan', { category: 'Pictures' })).body.category, 'Pictures'); // sort stays allowed on unread
  } finally { await t.done(); }
});

test('status counts the records startup repaired or dropped and the files it set aside', async () => {
  const fresh = await boot();
  try {
    const s = (await fresh.call('GET', '/api/status')).body;
    assert.deepEqual([s.repaired, s.orphaned], [0, 0]);
  } finally { await fresh.done(); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-wf-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const clean = { id: 'clean', chunks: ['some text here'], noText: false, needsReview: false, confidence: 1, title: 'T', category: 'C', added: 1, autoRoom: false };
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items: [clean, { ...clean, id: 'damaged', confidence: 9 }, { broken: true }] }));
  fs.writeFileSync(path.join(dir, 'files', 'stray.txt'), 'x');
  const t = await boot(dir);
  try {
    const s = (await t.call('GET', '/api/status')).body;
    assert.deepEqual([s.repaired, s.orphaned], [2, 1]);
  } finally { await t.done(); }
});

test('re-sending an item\'s own category does not stop its room from being renamed', async () => {
  const t = await boot();
  try {
    const a = (await note(t, 'Physio appointment for my knee on Tuesday')).body;
    const b = (await note(t, 'Knee exercises from the physio, twice a day')).body;
    assert.equal(a.category, b.category);
    assert.equal((await t.call('PATCH', `/api/items/${a.id}`, { category: a.category })).status, 200);
    const c = (await note(t, 'Physio invoice for the knee treatment')).body;
    const cats = (await t.call('GET', '/api/items')).body.items.map((i) => i.category);
    assert.equal(new Set(cats).size, 1, JSON.stringify(cats));
    assert.notEqual(c.category, a.category);
  } finally { await t.done(); }
});

test('an image joins a room the user named "images" instead of making a second one', async () => {
  const t = await boot();
  try {
    const n = (await note(t, 'Bring the green umbrella to the picnic')).body;
    await t.call('PATCH', `/api/items/${n.id}`, { category: 'images' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const img = await t.call('POST', '/api/upload?name=dot.png', png, { 'x-pacrag': '1', 'content-type': 'application/octet-stream' });
    assert.equal(img.status, 201);
    assert.equal(img.body.category, 'images');
    const rooms = (await t.call('GET', '/api/status')).body.categories.filter((c) => c.name.toLowerCase() === 'images');
    assert.deepEqual(rooms, [{ name: 'images', count: 2 }]);
  } finally { await t.done(); }
});

test('"extract links" stays fast on absurdly long link-like text', async () => {
  const t = await boot();
  try {
    await note(t, `see http://x.example/${'.'.repeat(60000)}x and http://y.example/${')'.repeat(30000)} and https://ok.example/page).`);
    const t0 = Date.now();
    const r = await t.call('POST', '/api/ask', { q: 'extract links' });
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
    assert.ok(r.body.rows.some((x) => x.value === 'https://ok.example/page'));
  } finally { await t.done(); }
});
