'use strict';
// Regression tests for the quality UAT: answer selection, retrieval, extraction formats and categorisation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start, tokenize, htmlToText } = require('../server.js');

const CORPUS = path.join(__dirname, '..', 'uat', 'corpus');
const H = { 'x-pacrag': '1', 'content-type': 'application/json' };
const BIN = { 'x-pacrag': '1', 'content-type': 'application/octet-stream' };

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-q-'));
  const app = await start({ port: 0, dataDir: dir, answerer: null, embedder: null });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async (method, p, body, headers = H) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, body: data };
  };
  const note = async (text, title) => (await call('POST', '/api/items', { type: 'note', text, title })).body;
  const upload = async (name, content) => (await call('POST', `/api/upload?name=${encodeURIComponent(name)}`, Buffer.isBuffer(content) ? content : Buffer.from(content), BIN)).body;
  const corpus = async () => { for (const f of fs.readdirSync(CORPUS).filter((n) => n !== 'sample.pdf' && n !== 'ambiguous.txt')) await upload(f, fs.readFileSync(path.join(CORPUS, f))); };
  const ask = async (q, history) => (await call('POST', '/api/ask', { q, history })).body;
  const items = async () => (await call('GET', '/api/items')).body.items;
  const done = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, call, note, upload, corpus, ask, items, done };
}
const lines = (r) => r.answer.split('\n');
const values = (r) => r.rows.map((x) => x.value);
const prior = (q) => [{ role: 'user', content: q }, { role: 'assistant', content: 'ok' }];

const GYM = '# Membership terms\n\nGym membership agreement. Fees can change with 30 days notice. The monthly fee is $39.99 and is charged on the first of each month. You can cancel your gym membership at any time by giving 30 days written notice at the front desk.';
const PANCAKES = '# Pancakes\n\nPancake recipe. Whisk flour, milk and eggs into a smooth batter. Rest the batter for ten minutes, then fry thin pancakes in a hot buttered pan, flipping once.';
const BANK = 'Current account terms. The overdraft limit is £500 and can be changed on request. The interest rate on the overdraft is 19.9% EAR. The monthly account fee is £4.';
const INSURANCE = 'Home insurance policy. Policy number HX-48213. Cover renews each March. Call the claims line on 0800 111 222.';

test('answers skip headings, title echoes and tiny lines', async () => {
  const t = await boot();
  try {
    await t.corpus();
    await t.upload('gym-membership.md', GYM);
    await t.upload('pancakes.md', PANCAKES);
    const closure = await t.ask('What is a closure?');
    assert.match(lines(closure)[0], /^A closure is a function that remembers variables/);
    assert.ok(!/^#/.test(lines(closure)[0]));
    const gym = await t.ask('How do I cancel my gym membership?');
    assert.match(lines(gym)[0], /cancel your gym membership at any time by giving 30 days written notice/);
    assert.ok(!lines(gym).some((l) => /^Membership terms|^#/.test(l)), gym.answer);
    const pasta = await t.ask('Which ingredients for carbonara?');
    assert.match(lines(pasta)[0], /^Ingredients: spaghetti, guanciale/);
    const pancakes = await t.ask('How do I make pancakes?');
    assert.match(lines(pancakes)[0], /fry thin pancakes|Whisk flour/);
    assert.ok(!/^# Pancakes|^Pancake recipe\./.test(lines(pancakes)[0]), pancakes.answer);
  } finally { await t.done(); }
});

test('the kind of fact asked for steers the sentence', async () => {
  const t = await boot();
  try {
    await t.corpus();
    await t.upload('gym-membership.md', GYM);
    assert.match(lines(await t.ask('How much is the gym fee?'))[0], /\$39\.99/, 'how much -> the amount, not the other fee sentence');
    assert.match((await t.ask('What is the deadline for the break notice?')).answer, /31 December 2026/, 'deadline -> the date');
    assert.match(lines(await t.ask('Who do I contact about lease queries?'))[0], /leasing@harbourpoint\.example/);
    assert.match(lines(await t.ask('What phone number do I call about lease queries?'))[0], /\+44 20 7946 0958/);
  } finally { await t.done(); }
});

test('follow-ups weigh the new question 3x and use it alone when it has a rare word', async () => {
  const t = await boot();
  try {
    await t.corpus();
    await t.upload('bank.txt', BANK);
    const lisbon = await t.ask('What about Lisbon?', prior('What is the annual rent in the lease?'));
    assert.equal(lisbon.sources[0].title, 'lisbon-trip.txt');
    const pasta = await t.ask('and the pasta?', prior('What is the annual rent?'));
    assert.equal(pasta.sources[0].title, 'pasta-recipe.txt');
    const rate = await t.ask('and the interest rate?', prior('What is my overdraft limit?'));
    assert.match(lines(rate)[0], /interest rate on the overdraft is 19\.9%/);
    assert.ok(!/limit is £500/.test(lines(rate)[0]), rate.answer);
    // when the new question has no distinctive word of its own, the old one still supplies the topic
    const related = await t.ask('and the notice period?', prior('break option in the lease'));
    assert.match(related.sources[0].title, /^lease-/);
  } finally { await t.done(); }
});

test('a weak match is not an answer', async () => {
  const t = await boot();
  try {
    await t.corpus();
    await t.upload('insurance.txt', INSURANCE);
    const passport = await t.ask('What is my passport number?');
    assert.equal(passport.mode, 'none');
    assert.deepEqual(passport.sources, []);
    assert.ok(!/HX-48213/.test(passport.answer) && /extract dates/.test(passport.answer), passport.answer);
    const policy = await t.ask('What is my policy number?');
    assert.equal(policy.mode, 'extractive');
    assert.match(lines(policy)[0], /HX-48213/);
    const sintra = await t.ask('How do I get to Sintra?');
    assert.equal(sintra.sources[0].title, 'lisbon-trip.txt');
    assert.ok(!sintra.sources.some((s) => s.title === 'js-closures.md'), 'the word "gets" in the closure note must not match');
    for (const w of ['get', 'make', 'take', 'tell', 'show', 'much', 'long', 'many']) assert.deepEqual(tokenize(w), [], `${w} is a stop word`);
    const lease = await t.ask('When can the tenant break the lease?');
    assert.ok(lease.sources.every((s) => /^lease-/.test(s.title)), lease.sources.map((s) => s.title).join(','));
  } finally { await t.done(); }
});

test('empty library and unreadable files get an honest message', async () => {
  const t = await boot();
  try {
    assert.match((await t.ask('anything at all')).answer, /Your library is empty — add something first\./);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await t.upload('sample.png', png);
    const r = await t.ask('what is in the contract');
    assert.equal(r.mode, 'none');
    assert.match(r.answer, /1 file \(e\.g\. sample\.png\) is stored but has no readable text\./);
    assert.match(r.answer, /extract dates/);
    await t.upload('other.png', png.subarray(0, png.length));
    await t.note('Totally unrelated note about gardening and tomatoes.');
    assert.match((await t.ask('what is in the contract')).answer, /2 files \(e\.g\. \S+\.png\) are stored but have no readable text\./);
  } finally { await t.done(); }
});

test('search: stemming, accents, decimals, typos, synonyms and "without"', async () => {
  assert.deepEqual(['baked', 'baking', 'bakes', 'bake'].map((w) => tokenize(w)[0]), ['bake', 'bake', 'bake', 'bake']);
  assert.equal(tokenize('lasagne')[0], tokenize('lasagna')[0]);
  assert.equal(tokenize('berries')[0], tokenize('berry')[0]);
  assert.equal(tokenize('running')[0], tokenize('run')[0]);
  assert.deepEqual(tokenize('Café'), tokenize('cafe'));
  assert.deepEqual(tokenize('Rate 4.25% and 1,000'), ['rate', '4.25', '1000']);
  assert.deepEqual(tokenize('The Leases, and the tenants!'), ['lease', 'tenant']);
  const t = await boot();
  try {
    await t.corpus();
    await t.note('Bake the focaccia for twenty minutes until golden.', 'Focaccia');
    await t.note('The corner café opens at eight. Try the lasagne.', 'Cafe tips');
    await t.note('Savings account interest is 4.25% a year, added monthly.', 'Savings');
    await t.note('Education: MSc in Chemistry from Leeds, 2019. Annual pay: £52,000.', 'CV');
    await t.note('Classic pancakes: flour, eggs and milk.', 'Classic pancakes');
    await t.note('Vegan pancakes: flour, oat milk and banana.', 'Vegan pancakes');
    assert.equal((await t.ask('I was baking focaccia')).sources[0].title, 'Focaccia');
    assert.equal((await t.ask('cafe with lasagna')).sources[0].title, 'Cafe tips');
    assert.equal((await t.ask('which account has 4.25')).sources[0].title, 'Savings');
    assert.equal((await t.ask('when can the tennant break the lease')).sources[0].title.slice(0, 6), 'lease-', 'one-letter typo');
    assert.equal((await t.ask('what degree did she get')).sources[0].title, 'CV', 'degree ~ MSc');
    assert.equal((await t.ask('what is the salary')).sources[0].title, 'CV', 'salary ~ pay');
    assert.equal((await t.ask('pancakes without eggs')).sources[0].title, 'Vegan pancakes');
    assert.equal((await t.ask('pancakes')).sources.length, 2);
  } finally { await t.done(); }
});

test('extract phrasing: list/show/find/what are, filler words in the scope, several kinds', async () => {
  const t = await boot();
  try {
    await t.corpus();
    for (const it of await t.items()) if (/^lease-/.test(it.title)) await t.call('PATCH', `/api/items/${it.id}`, { category: 'Lease' });
    const lease = await t.ask('extract the dates in the lease documents');
    assert.equal(lease.mode, 'extract');
    assert.equal(lease.category, 'Lease');
    assert.ok(values(lease).includes('30 June 2027'));
    assert.equal((await t.ask('please list all the dates from my lease files')).category, 'Lease');
    assert.equal((await t.ask('Show me the emails')).mode, 'extract');
    assert.equal((await t.ask('what are the phone numbers?')).kind, 'phones');
    assert.equal((await t.ask('give me every amount in the lease notes')).category, 'Lease');
    assert.equal((await t.ask('get my links')).mode, 'extract');
    // ordinary questions that start with the same verbs stay questions
    for (const q of ['find the lease clause about repairs', 'show the break option', 'what are the rent review dates for the tenant', 'list the steps to bake bread']) assert.notEqual((await t.ask(q)).mode, 'help', q);
    assert.notEqual((await t.ask('what are the rent review dates for the tenant')).mode, 'extract');
    const both = await t.ask('extract dates and amounts');
    assert.equal(both.kind, 'dates');
    assert.equal(both.also[0].kind, 'amounts');
    assert.ok(both.also[0].rows.length > 0);
    assert.match(both.note, /dates only/);
    assert.equal((await t.ask('extract amounts in my documents')).mode, 'extract');
    assert.equal((await t.ask('extract dates from the nothing files')).mode, 'help');
  } finally { await t.done(); }
});

test('dates: ordinals, other languages, no-year, ambiguity and month-year duplicates', async () => {
  const t = await boot();
  try {
    await t.note('Signed on the 3rd of March 2025. Kickoff 5 de mayo de 2025, party 4 juillet 2025 and 14. März 2025. Pay by 14 Mar or 3 March. Maybe 03/04/25. The break is 30 June 2027, so tell us by June 2027. Also 12.09.2026 and 2026-01-05.');
    const r = await t.ask('extract dates');
    const v = values(r);
    for (const ok of ['3rd of March 2025', '5 de mayo de 2025', '4 juillet 2025', '14. März 2025', '14 Mar', '3 March', '03/04/25', '30 June 2027', '12.09.2026', '2026-01-05']) assert.ok(v.includes(ok), `${ok} missing from ${v.join(' | ')}`);
    assert.ok(!v.includes('March 2025'), 'the ordinal date is one date');
    assert.ok(!v.includes('June 2027'), 'month-year inside a longer date is not a second row');
    const row = (x) => r.rows.find((y) => y.value === x);
    assert.match(row('03/04/25').context, /ambiguous/);
    assert.equal(row('03/04/25').note, 'ambiguous: dd/mm or mm/dd');
    assert.match(row('14 Mar').context, /no year/);
    assert.ok(!row('2026-01-05').note && !row('12.09.2026').note);
    for (const x of r.rows) assert.ok(!/\n/.test(x.context + x.value), 'one line per row keeps CSV columns intact');
    await t.note('Standalone: the lease runs to June 2028. Nothing else. You may 5 times.');
    assert.ok(values(await t.ask('extract dates')).includes('June 2028'), 'a month-year on its own is kept');
    assert.ok(!values(await t.ask('extract dates')).includes('5 times'));
  } finally { await t.done(); }
});

test('amounts: European formats are never cut', async () => {
  const t = await boot();
  try {
    await t.note('Fees: 1.234,56 EUR, then 1.234,56 €, 389,90 €, 8 400 €, 12€, EUR 12,50, £5k and 2.4 million euros. Also $1,234.56, 5% and 4.25%.');
    const v = values(await t.ask('extract amounts'));
    for (const ok of ['1.234,56 EUR', '1.234,56 €', '389,90 €', '8 400 €', '12€', 'EUR 12,50', '£5k', '2.4 million euros', '$1,234.56', '5%', '4.25%']) assert.ok(v.includes(ok), `${ok} missing from ${v.join(' | ')}`);
    assert.ok(!v.some((x) => x.startsWith('234,56')), v.join(' | '));
    assert.equal(v.filter((x) => x === '1.234,56 EUR').length, 1);
  } finally { await t.done(); }
});

test('phones: more formats, extensions, and no IBAN or ISBN fragments', async () => {
  const t = await boot();
  try {
    await t.note('Call +44 7700 900123, 07911 123456, 01632 960 123, +49 (0)30 1234567, +49 30 1234567 or 0032 2 555 0123. Desk: +1 415 555 2671 ext. 456 and 020 7946 0958 x22. IBAN BE68 5390 0754 7034 and GB29 NWBK 6016 1331 9268 19, ISBN 978-3-16-148410-0. Not phones: 2026-01-05, 12.09.2026, 1234567890 and $4,500,000.');
    const r = await t.ask('extract phone numbers');
    const v = values(r);
    for (const ok of ['+44 7700 900123', '07911 123456', '01632 960 123', '+49 (0)30 1234567', '+49 30 1234567', '0032 2 555 0123', '+1 415 555 2671 ext. 456', '020 7946 0958 x22']) assert.ok(v.includes(ok), `${ok} missing from ${v.join(' | ')}`);
    assert.equal(v.length, 8, v.join(' | '));
    assert.equal(r.answer, 'Found 8 phone numbers.');
    await t.note('Ring 415-555-2671 or 415-555-2672.');
    assert.equal((await t.ask('extract phones from nothing-here')).mode, 'help');
    const two = await t.ask('extract phones');
    assert.ok(two.rows.length >= 2);
    const one = await t.note('Just 415-555-9999 here.');
    assert.ok(one.id);
  } finally { await t.done(); }
});

test('htmlToText keeps link targets, and link items contribute their own address', async () => {
  const t0 = htmlToText('<p>See <a href="https://example.com/x?a=1&amp;b=2">the docs</a>, <a href="#top">top</a>, <a href="javascript:void(0)">js</a>, <a href=\'mailto:a@b.co\'>mail</a>, <a href="/rel">rel</a> and <a href="https://same.org">https://same.org</a>.</p>').text;
  assert.match(t0, /the docs \(https:\/\/example\.com\/x\?a=1&b=2\)/);
  assert.match(t0, /mail \(mailto:a@b\.co\)/);
  assert.ok(!/#top|javascript|\/rel\)/.test(t0), t0);
  assert.equal(t0.split('https://same.org').length, 2, 'text that already is the address is not repeated');
  const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Docs</title><p>Read <a href="https://example.com/guide">the guide</a> before you start. Plenty of words here.</p>'); });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const t = await boot();
  try {
    const url = `http://127.0.0.1:${page.address().port}/`;
    const added = await t.call('POST', '/api/items', { type: 'url', url });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const v = values(await t.ask('extract links'));
    assert.ok(v.includes('https://example.com/guide'), v.join(' | '));
    assert.ok(v.includes(url), `the page's own address: ${v.join(' | ')}`);
  } finally { await t.done(); page.close(); }
});

test('room names: real words, a single strong term, rename at three members unless the user chose', async () => {
  const t = await boot();
  try {
    const a = await t.note('http url title minutes day item name. Budget budget forecast spreadsheet budget.', 'Meeting minutes');
    assert.ok(/Budget/.test(a.category) && !/http|url|title|minute|day|item|name/i.test(a.category), a.category);
    const b = await t.note('sourdough sourdough sourdough sourdough sourdough sourdough sourdough sourdough starter', 'Bread');
    assert.equal(b.category, 'Sourdough');
  } finally { await t.done(); }
});

test('a room name is recomputed when it reaches three members, unless a person sorted into it', async () => {
  const mk = async (sortFirst) => {
    const t = await boot();
    try {
      const n1 = await t.note('Dentist appointment on Tuesday about a filling. Bring the insurance card.', 'Tuesday');
      if (sortFirst) await t.call('PATCH', `/api/items/${n1.id}`, { category: 'My Teeth' });
      await t.note('Dentist checkup: cleaning and a filling, ask about the dentist insurance.', 'Reminder');
      const n3 = await t.note('Dentist filling follow-up, dentist cleaning, dentist insurance claim.', 'Claim');
      const all = await t.items();
      return { cats: new Set(all.map((i) => i.category)), first: n1.category, third: n3.category, rooms: all.map((i) => i.category) };
    } finally { await t.done(); }
  };
  const auto = await mk(false);
  assert.equal(auto.cats.size, 1, auto.rooms.join(' | '));
  assert.notEqual([...auto.cats][0], auto.first, `renamed from "${auto.first}"`);
  assert.match([...auto.cats][0], /Dentist/);
  const manual = await mk(true);
  assert.deepEqual([...manual.cats], ['My Teeth']);
});

test('a low-confidence ghost does not make its look-alikes join outright', async () => {
  const t = await boot();
  try {
    await t.note('Pasta carbonara with guanciale, pecorino, egg yolks and black pepper. Cook the spaghetti in salted water and toss with the guanciale.', 'Carbonara');
    await t.note('Sourdough bread recipe: flour, water, salt and starter. Fold the dough, proof overnight, bake in a hot Dutch oven.', 'Sourdough');
    const ghost = await t.note('Pasta night with friends: invite the neighbours, buy wine and cheese, set the table, light candles, put on some music for the evening, cook spaghetti.', 'Pasta night');
    assert.equal(ghost.needsReview, true);
    assert.ok(ghost.confidence < 0.2, `confidence ${ghost.confidence}`);
    await t.call('PATCH', `/api/items/${ghost.id}`, { reviewed: true }); // the user keeps it, which must not turn it into a strong example
    const wine = await t.note('Wine and cheese tasting evening with friends and neighbours, candles on the table, music, pick a red wine.', 'Wine night');
    assert.equal(wine.needsReview, true, `joined outright with confidence ${wine.confidence}`);
  } finally { await t.done(); }
});

test('short related notes join the room of their nearest member', async () => {
  const t = await boot();
  try {
    const trips = [
      ['Lisbon trip plan: fly Friday, stay in Alfama, ride tram 28, eat pastel de nata in Belem, train to Sintra palaces, dinner in Bairro Alto, Gulbenkian museum on Sunday.', 'Lisbon trip'],
      ['Berlin hotel booking: Kreuzberg hotel, breakfast included, check in after three, U-Bahn pass, museum island ticket, Brandenburg gate walking tour.', 'Berlin hotel'],
      ['Tokyo visa checklist: passport validity, return flight proof, hotel confirmation, travel insurance, entry card, rail pass voucher.', 'Tokyo visa'],
      ['Rome weekend: Colosseum tickets, trattoria near the Pantheon, gelato, Vatican museums early slot, train from Fiumicino.', 'Rome weekend'],
      ['Iceland road trip: rent a four wheel drive, Ring Road, Blue Lagoon booking, waterfalls, northern lights tour, warm layers.', 'Iceland'],
      ['Lima food tour: ceviche lunch, pisco sour class, market visit in Miraflores, anticuchos, altitude pills for Cusco.', 'Lima'],
    ];
    for (const [text, title] of trips) { const n = await t.note(text, title); await t.call('PATCH', `/api/items/${n.id}`, { category: 'Travel' }); }
    // one member is a close match, but the average of six different trips is not
    const short = await t.note('Berlin hotel breakfast starts at seven.', 'Hotel breakfast');
    assert.equal(short.category, 'Travel');
    assert.equal(short.needsReview, false, `confidence ${short.confidence}`);
  } finally { await t.done(); }
});
