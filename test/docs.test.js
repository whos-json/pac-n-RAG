'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { readDocument } = require('../docs.js');
const { start } = require('../server.js');

// ---- tiny builders, so the tests need no binary fixtures except one real PDF ----
function zip(files, { stored = false } = {}) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = stored ? raw : zlib.deflateRawSync(raw);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); central.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const W = (body) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;

function pdf(objects, trailer = '/Root 1 0 R') { // objects: [{ n, dict, stream? }]
  let out = '%PDF-1.4\n';
  for (const o of objects) {
    out += `${o.n} 0 obj\n${o.stream !== undefined ? `<< ${o.dict} /Length ${o.stream.length} >>\nstream\n` : `${o.dict}\n`}`;
    out += o.stream !== undefined ? `${o.stream.toString('latin1')}\nendstream\nendobj\n` : 'endobj\n';
  }
  return Buffer.from(`${out}trailer\n<< ${trailer} >>\n%%EOF\n`, 'latin1');
}
const simple = (content, extra = '') => pdf([
  { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  { n: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { n: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
  { n: 4, dict: '', stream: Buffer.from(content, 'latin1') },
  { n: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
]);

test('real browser-made PDF (subset fonts, compressed streams) is read in page order', () => {
  const text = readDocument(fs.readFileSync(path.join(__dirname, 'fixtures', 'report.pdf')), '.pdf');
  assert.match(text, /^Quarterly Report/);
  assert.match(text, /renovation budget is \$12,500 and the contractor starts on 14 March 2026/);
  assert.match(text, /builder@example\.com/);
  assert.ok(text.indexOf('Second page') > text.indexOf('Contact'));
});

test('PDF: literal and hex strings, TJ arrays with kerning gaps, escapes, line operators', () => {
  const t = readDocument(simple('BT /F1 12 Tf 72 700 Td (Hello \\(brave\\) new) Tj 0 -14 Td [(wor) -20 (ld) -400 (again)] TJ 0 -14 Td <48656C6C6F> Tj T* (caf\\351 \\\\ ok) Tj ET'), '.pdf');
  assert.equal(t, 'Hello (brave) new\nworld again\nHello\ncafé \\ ok');
});

test('PDF: ToUnicode maps (bfchar and bfrange) decode custom two-byte fonts', () => {
  const cmap = '/CIDInit begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar 1 beginbfrange <0003> <0005> <0061> endbfrange endcmap';
  const file = pdf([
    { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { n: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
    { n: 4, dict: '', stream: Buffer.from('BT /F1 12 Tf <000100020003000400050001> Tj ET') },
    { n: 5, dict: '<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>' },
    { n: 6, dict: '', stream: Buffer.from(cmap) },
  ]);
  assert.equal(readDocument(file, '.pdf'), 'HiabcH'); // codes 1,2 via bfchar; 3..5 via bfrange; 1 again
});

test('PDF: compressed content, an object stream holding the page tree, and inherited resources', () => {
  const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf (From an object stream) Tj ET'));
  const inner = ['<< /Type /Catalog /Pages 11 0 R >>', '<< /Type /Pages /Kids [12 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>', '<< /Type /Page /Parent 11 0 R /Contents 4 0 R >>'];
  const header = '10 0 11 ' + inner[0].length + ' 12 ' + (inner[0].length + 1 + inner[1].length) + ' ';
  const body = zlib.deflateSync(Buffer.from(header + inner.join(' ')));
  const file = pdf([
    { n: 20, dict: `/Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode`, stream: body },
    { n: 4, dict: '/Filter /FlateDecode', stream: content },
    { n: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ], '/Root 10 0 R');
  assert.equal(readDocument(file, '.pdf'), 'From an object stream');
});

test('PDF: encrypted, scanned (no text), garbage and truncated files give "" and never throw', () => {
  const plain = simple('BT /F1 12 Tf (secret) Tj ET');
  assert.equal(readDocument(plain, '.pdf'), 'secret'); // control: the same file unencrypted is readable
  const locked = Buffer.from(plain.toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'), 'latin1');
  assert.equal(readDocument(locked, '.pdf'), '');
  assert.equal(readDocument(simple('q 100 0 0 100 0 0 cm /Im0 Do Q'), '.pdf'), '');
  assert.equal(readDocument(Buffer.from('%PDF-1.4\n% Not a real PDF.'), '.pdf'), '');
  assert.equal(readDocument(Buffer.from('not a pdf at all'), '.pdf'), '');
  assert.equal(readDocument(Buffer.alloc(0), '.pdf'), '');
  const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'report.pdf'));
  assert.doesNotThrow(() => readDocument(real.subarray(0, real.length >> 1), '.pdf'));
  assert.doesNotThrow(() => readDocument(Buffer.concat([real.subarray(0, 3000), Buffer.alloc(500, 255), real.subarray(3500)]), '.pdf'));
});

test('PDF: unmappable composite fonts are reported as no text, not as gibberish', () => {
  const file = pdf([
    { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { n: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
    { n: 4, dict: '', stream: Buffer.from('BT /F1 12 Tf <0102030405060708> Tj ET') },
    { n: 5, dict: '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H >>' },
  ]);
  assert.equal(readDocument(file, '.pdf'), '');
});

test('DOCX: paragraphs, tabs, breaks, entities, footnotes; field codes are ignored', () => {
  const doc = zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': W('<w:p><w:r><w:t>Lease &amp; Rent</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Pay </w:t><w:tab/><w:t>250 &#8364;</w:t><w:br/><w:t>by Friday</w:t></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>'),
    'word/footnotes.xml': W('<w:footnote><w:p><w:r><w:t>See clause 4</w:t></w:r></w:p></w:footnote>'),
  });
  assert.equal(readDocument(doc, '.docx'), 'Lease & Rent\n\nPay 250 €\nby Friday\n\nSee clause 4');
  assert.equal(readDocument(zip({ 'word/document.xml': W('<w:p><w:r><w:t>Stored</w:t></w:r></w:p>') }, { stored: true }), '.docx'), 'Stored');
});

test('PPTX slides in numeric order, XLSX shared strings, ODT paragraphs', () => {
  const slide = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  assert.equal(readDocument(zip({ 'ppt/slides/slide10.xml': slide('Ten'), 'ppt/slides/slide2.xml': slide('Two'), 'ppt/slides/slide1.xml': slide('One') }), '.pptx'), 'One\n\nTwo\n\nTen');
  assert.equal(readDocument(zip({ 'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><r><t>Ann</t></r><r><t> Lee</t></r></si></sst>' }), '.xlsx'), 'Name\nAnn Lee');
  assert.equal(readDocument(zip({ 'content.xml': '<office:text><text:h>Title</text:h><text:p>Hello<text:s/>there<text:tab/>x &amp; y</text:p></office:text>' }), '.odt'), 'Title\nHello there x & y');
});

test('zip: damaged archives, missing parts, and zip bombs give "" quickly and never throw', () => {
  assert.equal(readDocument(Buffer.from('PK\u0003\u0004 nonsense'), '.docx'), '');
  assert.equal(readDocument(zip({ 'other.xml': '<x/>' }), '.docx'), '');
  assert.equal(readDocument(Buffer.alloc(0), '.docx'), '');
  const good = zip({ 'word/document.xml': W('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>') });
  assert.equal(readDocument(good.subarray(0, good.length - 10), '.docx'), '');
  const t0 = Date.now();
  const bomb = zip({ 'word/document.xml': W(`<w:p><w:r><w:t>${'a'.repeat(80 * 1024 * 1024)}</w:t></w:r></w:p>`) });
  assert.equal(readDocument(bomb, '.docx'), '');
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(readDocument(Buffer.from('x'), '.exe'), '');
});

test('symbol soup is not mistaken for text', () => {
  assert.equal(readDocument(simple('BT /F1 12 Tf (\\001\\002 ~~~ ### @@@ %%% ^^^) Tj ET'), '.pdf'), '');
});

// ---- hostile inputs: each used to cost seconds of CPU or GBs of RAM inside the HTTP server ----
const LIMIT_MS = 1000;
function hostile(t, label, fn) {
  const t0 = process.hrtime.bigint();
  let result;
  assert.doesNotThrow(() => { result = fn(); }, label);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.diagnostic(`${label}: ${ms.toFixed(0)} ms`);
  assert.ok(ms < LIMIT_MS, `${label} took ${ms.toFixed(0)} ms`);
  assert.equal(typeof result, 'string');
  return result;
}
const pageDoc = (pageExtra, content, font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', more = []) => pdf([
  { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  { n: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { n: 3, dict: `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> ${pageExtra} >>` },
  { n: 4, dict: '', stream: Buffer.from(content, 'latin1') },
  { n: 5, dict: font },
  ...more,
]);

test('hostile PDF: long digit runs in object headers and references', (t) => {
  assert.equal(hostile(t, 'pdf 80k digits before obj', () => readDocument(Buffer.from(`%PDF-1.4\n${'1'.repeat(80000)} 0 obj\n<< >>\nendobj\n`, 'latin1'), '.pdf')), '');
  assert.equal(hostile(t, 'pdf 80k digits, no obj', () => readDocument(Buffer.from(`%PDF-1.4\n${'1'.repeat(80000)}`, 'latin1'), '.pdf')), '');
  assert.equal(hostile(t, 'pdf 80k digit runs in Kids/Contents/Font refs', () => readDocument(pdf([
    { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, dict: `<< /Type /Pages /Kids [${'7'.repeat(40000)} 0 R ${'1 '.repeat(20000)}] /Count 1 >>` },
    { n: 3, dict: `<< /Type /Page /Contents ${'4'.repeat(80000)} 0 R /Resources << /Font << /F1 ${'5'.repeat(80000)} 0 R >> >> >>` },
  ]), '.pdf')), '');
  assert.equal(hostile(t, 'pdf 80k digit /Parent and blanks', () => readDocument(pageDoc(`/X ${'9'.repeat(80000)} ${' '.repeat(80000)} /Y`, 'BT /F1 12 Tf (still readable) Tj ET'), '.pdf')), 'still readable');
});

test('hostile PDF: 100k tiny objects and a truncated object are linear', (t) => {
  const many = `%PDF-1.4\n${'1 0 obj<<>>endobj\n'.repeat(100000)}`;
  assert.equal(hostile(t, 'pdf 100k objects without any stream', () => readDocument(Buffer.from(many, 'latin1'), '.pdf')), '');
  assert.equal(hostile(t, 'pdf 100k unterminated obj', () => readDocument(Buffer.from(`%PDF-1.4\n${'1 0 obj '.repeat(100000)}`, 'latin1'), '.pdf')), '');
});

test('hostile PDF: inline image BI without EI, junk operands and unclosed strings', (t) => {
  assert.equal(hostile(t, 'pdf 300k BI without EI', () => readDocument(simple(`BT /F1 12 Tf (before) Tj ET ${'BI '.repeat(300000)}`), '.pdf')), 'before');
  assert.equal(hostile(t, 'pdf 300k BI EI pairs', () => readDocument(simple(`BT /F1 12 Tf (x) Tj ET ${'BI /W 1 ID ab EI '.repeat(30000)}`), '.pdf')), 'x');
  assert.equal(hostile(t, 'pdf 1M operands, no operator', () => readDocument(simple('1 '.repeat(500000)), '.pdf')), '');
  assert.equal(hostile(t, 'pdf 200k unclosed <', () => readDocument(simple('< '.repeat(200000)), '.pdf')), '');
  assert.equal(hostile(t, 'pdf 200k unclosed (', () => readDocument(simple('( '.repeat(200000)), '.pdf')), '');
});

test('hostile PDF: ToUnicode with thousands of max-size bfranges is capped', (t) => {
  const ranges = '<1000> <FFFF> <0041>\n'.repeat(3000);
  const cmap = `/CIDInit begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar ${ranges.length} beginbfrange\n${ranges}endbfrange endcmap`;
  const file = pageDoc('', 'BT /F1 12 Tf <00010002> Tj ET', '<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>', [{ n: 6, dict: '', stream: Buffer.from(cmap) }]);
  assert.equal(hostile(t, 'pdf 3000 x 61440-code bfranges', () => readDocument(file, '.pdf')), 'Hi');
  const rep = (s, n) => s.repeat(n);
  for (const [label, body] of [
    ['pdf 80k unclosed bfrange arrays', `begincodespacerange <0000> <FFFF> endcodespacerange beginbfrange ${rep('<0001> <0002> [', 80000)}`],
    ['pdf 80k beginbfchar without end', rep('beginbfchar ', 80000)],
    ['pdf 80k beginbfrange without end', rep('beginbfrange <0001> <0002> <0041> ', 40000)],
    ['pdf 40k bfrange arrays', `beginbfrange ${rep('<0000> <FFFF> [<0041>] ', 40000)} endbfrange`],
    ['pdf long hex runs in cmap', `beginbfchar <${'a'.repeat(200000)}> <${'b'.repeat(200000)}> endbfchar beginbfrange ${rep('<', 100000)} endbfrange`],
  ]) {
    const f = pageDoc('', 'BT /F1 12 Tf <00010002> Tj ET', '<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>', [{ n: 6, dict: '', stream: Buffer.from(body) }]);
    hostile(t, label, () => readDocument(f, '.pdf'));
  }
  // many distinct fonts sharing one big ToUnicode are decoded at most once each / capped
  const fontObjs = [];
  for (let i = 0; i < 2000; i++) fontObjs.push({ n: 100 + i, dict: '<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >>' });
  const fontRes = Array.from({ length: 2000 }, (_, i) => `/F${i} ${100 + i} 0 R`).join(' ');
  const content = Array.from({ length: 2000 }, (_, i) => `/F${i} 1 Tf <00010002> Tj`).join(' ');
  const many = pdf([
    { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { n: 3, dict: `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${fontRes} >> >> >>` },
    { n: 4, dict: '', stream: Buffer.from(content) },
    { n: 6, dict: '', stream: Buffer.from(cmap) },
    ...fontObjs,
  ]);
  hostile(t, 'pdf 2000 fonts sharing a hostile ToUnicode', () => readDocument(many, '.pdf'));
});

test('hostile PDF: self-referencing, cyclic and very deep page trees', (t) => {
  const content = { n: 4, dict: '', stream: Buffer.from('BT /F1 12 Tf (page text) Tj ET') };
  const font = { n: 5, dict: '<< /Type /Font /Subtype /Type1 >>' };
  const page = { n: 3, dict: '<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' };
  const root = { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' };
  const selfKids = pdf([root, { n: 2, dict: '<< /Type /Pages /Kids [2 0 R 2 0 R 3 0 R] >>' }, page, content, font]);
  assert.equal(hostile(t, 'pdf Kids referencing itself', () => readDocument(selfKids, '.pdf')), 'page text');
  const ring = pdf([root, { n: 2, dict: '<< /Type /Pages /Kids [6 0 R 3 0 R] >>' }, { n: 6, dict: '<< /Type /Pages /Kids [2 0 R] >>' }, page, content, font]);
  assert.equal(hostile(t, 'pdf two-node cycle', () => readDocument(ring, '.pdf')), 'page text');
  const chain = [root, page, content, font];
  for (let i = 0; i < 20000; i++) chain.push({ n: 10 + i, dict: `<< /Type /Pages /Kids [${11 + i} 0 R] >>` });
  chain.push({ n: 2, dict: '<< /Type /Pages /Kids [10 0 R] >>' });
  // the walk gives up at depth 40; the damaged-file fallback then still finds the page by its /Type
  assert.equal(hostile(t, 'pdf 20000-deep page tree', () => readDocument(pdf(chain), '.pdf')), 'page text');
  const wide = [root, { n: 2, dict: `<< /Type /Pages /Kids [${Array.from({ length: 60000 }, () => '3 0 R').join(' ')}] >>` }, page, content, font];
  assert.equal(hostile(t, 'pdf 60000 kids all the same page', () => readDocument(pdf(wide), '.pdf')), 'page text');
  const shared = `<< /Type /Pages /Kids [${Array.from({ length: 6000 }, (_, i) => `${20 + i} 0 R`).join(' ')}] /Resources << /Font << /F1 5 0 R >> >> /Junk (${'x'.repeat(2000000)}) >>`;
  const pagesMany = [root, { n: 2, dict: shared }, content, font];
  for (let i = 0; i < 6000; i++) pagesMany.push({ n: 20 + i, dict: '<< /Type /Page /Contents 4 0 R >>' });
  hostile(t, 'pdf 6000 pages inheriting a 2 MB resource dict', () => readDocument(pdf(pagesMany), '.pdf'));
});

test('hostile PDF: output is capped at about 4 million characters', (t) => {
  const line = 'BT /F1 12 Tf (' + 'word '.repeat(190000) + ') Tj ET\n'; // ~1 MB of text per use of this stream
  const objs = [
    { n: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { n: 2, dict: `<< /Type /Pages /Kids [${Array.from({ length: 40 }, (_, i) => `${10 + i} 0 R`).join(' ')}] >>` },
    { n: 4, dict: '', stream: Buffer.from(line) },
    { n: 5, dict: '<< /Type /Font /Subtype /Type1 >>' },
  ];
  for (let i = 0; i < 40; i++) objs.push({ n: 10 + i, dict: '<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' });
  const text = hostile(t, 'pdf 40 x 1 MB pages', () => readDocument(pdf(objs), '.pdf'));
  assert.ok(text.length > 1000000 && text.length <= 4000100, `length ${text.length}`);
});

test('hostile OOXML/ODF: unclosed tags are scanned once, not once per tag', (t) => {
  assert.equal(hostile(t, 'docx 200k unclosed <w:t>', () => readDocument(zip({ 'word/document.xml': W('<w:t>'.repeat(200000)) }), '.docx')), '');
  assert.equal(hostile(t, 'docx unclosed <w:t> after real text', () => readDocument(zip({ 'word/document.xml': W(`<w:p><w:r><w:t>Real text</w:t></w:r></w:p>${'<w:t>x'.repeat(100000)}`) }), '.docx')), 'Real text');
  assert.equal(hostile(t, 'docx 80k bare <', () => readDocument(zip({ 'word/document.xml': W('<'.repeat(80000)) }), '.docx')), '');
  assert.equal(hostile(t, 'docx 80k <w:t ', () => readDocument(zip({ 'word/document.xml': W('<w:t '.repeat(80000)) }), '.docx')), '');
  assert.equal(hostile(t, 'odt 80k bare <', () => readDocument(zip({ 'content.xml': `<office:text><text:p>Hello</text:p>${'<'.repeat(80000)}` }), '.odt')), '');
  assert.ok(hostile(t, 'odt 80k <text:s', () => readDocument(zip({ 'content.xml': '<text:p>Hello world</text:p>' + '<text:s '.repeat(80000) }), '.odt')).startsWith('Hello world'));
  assert.equal(hostile(t, 'pptx 200k unclosed <a:t>', () => readDocument(zip({ 'ppt/slides/slide1.xml': '<a:t>'.repeat(200000) }), '.pptx')), '');
  assert.equal(hostile(t, 'xlsx 200k unclosed <si><t>', () => readDocument(zip({ 'xl/sharedStrings.xml': '<si><t>'.repeat(100000) }), '.xlsx')), '');
  assert.equal(hostile(t, 'xlsx 100k unclosed <si>', () => readDocument(zip({ 'xl/sharedStrings.xml': '<sst><si>'.repeat(100000) }), '.xlsx')), '');
  hostile(t, 'docx 100k entities without ;', () => readDocument(zip({ 'word/document.xml': W(`<w:t>${'&amp'.repeat(100000)}</w:t>`) }), '.docx'));
});

test('hostile zip: XML larger than the 16 MB part cap, bogus directories and sizes', (t) => {
  assert.equal(hostile(t, 'docx xml inflating to 20 MB', () => readDocument(zip({ 'word/document.xml': W(`<w:p><w:r><w:t>${'a'.repeat(20 * 1024 * 1024)}</w:t></w:r></w:p>`) }), '.docx')), '');
  assert.equal(hostile(t, 'docx 20 MB stored part', () => readDocument(zip({ 'word/document.xml': W(`<w:t>${'a'.repeat(20 * 1024 * 1024)}</w:t>`) }, { stored: true }), '.docx')), '');
  // just under the cap still reads, and a 4M+ character result is truncated rather than rejected
  const big = hostile(t, 'docx 8 MB of text', () => readDocument(zip({ 'word/document.xml': W(`<w:t>${'abc '.repeat(2 * 1024 * 1024)}</w:t>`) }), '.docx'));
  assert.ok(big.length > 3000000 && big.length <= 4000000);
  const good = zip({ 'word/document.xml': W('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>') });
  assert.equal(readDocument(good, '.docx'), 'Hello');
  const central = good.indexOf(Buffer.from('PK\x01\x02', 'latin1'));
  const eocd = good.length - 22;
  const patched = (fn) => { const b = Buffer.from(good); fn(b); return b; };
  assert.equal(hostile(t, 'zip bogus entry count', () => readDocument(patched((b) => { b.writeUInt16LE(65535, eocd + 8); b.writeUInt16LE(65535, eocd + 10); }), '.docx')), 'Hello');
  assert.equal(hostile(t, 'zip central directory offset past EOF', () => readDocument(patched((b) => b.writeUInt32LE(0xfffffff0, eocd + 16)), '.docx')), '');
  assert.equal(hostile(t, 'zip csize past EOF', () => readDocument(patched((b) => b.writeUInt32LE(0xfffffff0, central + 20)), '.docx')), '');
  assert.equal(hostile(t, 'zip local offset past EOF', () => readDocument(patched((b) => b.writeUInt32LE(0xfffffff0, central + 42)), '.docx')), '');
  assert.equal(hostile(t, 'zip declared size over cap', () => readDocument(patched((b) => b.writeUInt32LE(0xfffffff0, central + 24)), '.docx')), '');
  assert.equal(hostile(t, 'zip name length past EOF', () => readDocument(patched((b) => b.writeUInt16LE(65535, central + 28)), '.docx')), '');
  assert.equal(hostile(t, 'zip 30k bogus entries', () => {
    const names = {};
    for (let i = 0; i < 30000; i++) names[`junk/${i}`] = '';
    return readDocument(zip({ ...names, 'word/document.xml': W('<w:t>Hi there</w:t>') }, { stored: true }), '.docx');
  }), '');
});

// ---- end to end: upload, search, citation ----
test('uploads of PDF and Word files are indexed, searchable and not flagged as unread', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-docs-'));
  const app = await start({ port: 0, dataDir: dir, answerer: null });
  const call = async (method, p, body, headers = { 'x-pacrag': '1', 'content-type': 'application/json' }) => {
    const r = await fetch(`http://127.0.0.1:${app.port}${p}`, { method, headers, body: body && typeof body !== 'string' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
    return { status: r.status, body: await r.json() };
  };
  const up = (name, buf) => call('POST', `/api/upload?name=${encodeURIComponent(name)}`, buf, { 'x-pacrag': '1', 'content-type': 'application/octet-stream' });
  try {
    const p = await up('report.pdf', fs.readFileSync(path.join(__dirname, 'fixtures', 'report.pdf')));
    assert.equal(p.status, 201);
    assert.equal(p.body.noText, false);
    assert.equal(p.body.state === 'unread', false);
    const d = await up('plan.docx', zip({ 'word/document.xml': W('<w:p><w:r><w:t>The scaffolding inspection happens every Tuesday morning.</w:t></w:r></w:p>') }));
    assert.equal(d.body.noText, false);
    const a1 = await call('POST', '/api/ask', { q: 'How long does the warranty last?' });
    assert.equal(a1.body.mode, 'extractive');
    assert.match(a1.body.answer, /five years/);
    assert.equal(a1.body.sources[0].title, 'report.pdf');
    const a2 = await call('POST', '/api/ask', { q: 'When is the scaffolding inspection?' });
    assert.match(a2.body.answer, /Tuesday/);
    const ex = await call('POST', '/api/ask', { q: 'extract amounts' });
    assert.ok(ex.body.rows.some((r) => /12,500/.test(r.value)));
    const fake = await up('sample.pdf', fs.readFileSync(path.join(__dirname, '..', 'uat', 'corpus', 'sample.pdf')));
    assert.equal(fake.body.noText, true); // unreadable files are still stored and flagged honestly
    assert.equal(fake.body.state, 'unread');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
