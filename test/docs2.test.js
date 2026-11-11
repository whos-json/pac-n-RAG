'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { readDocument } = require('../docs.js');
const { start } = require('../server.js');

function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content), data = zlib.deflateRawSync(raw), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); central.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const sheet = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

test('xlsx: numbers, inline/str/bool cells, one line per row, sheets in workbook order with names', () => {
  const t = readDocument(zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Second" sheetId="2" r:id="rId2"/><sheet name="First" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Rent</t></si><si><t>Total</t></si></sst>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1250.5</v></c><c r="C1"/></row><row r="2"/><row r="3"><c r="A3" t="inlineStr"><is><t>platypus</t></is></c><c r="B3" t="b"><v>1</v></c></row>'),
    'xl/worksheets/sheet2.xml': sheet('<row><c t="s"><v>1</v></c><c t="str"><v>x &amp; y</v></c><c><v>42</v></c></row>'),
  }), '.xlsx');
  assert.equal(t, 'Second\nTotal | x & y | 42\n\nFirst\nRent | 1250.5\nplatypus | TRUE');
});

test('xlsx: numbers-only workbook has text; sheet10 sorts after sheet2 without a workbook.xml', () => {
  const t = readDocument(zip({
    'xl/worksheets/sheet10.xml': sheet('<row><c><v>10</v></c></row>'),
    'xl/worksheets/sheet2.xml': sheet('<row><c><v>2</v></c><c><v>3</v></c></row>'),
  }), '.xlsx');
  assert.equal(t, '2 | 3\n\n10');
});

test('xlsx: garbage returns an empty string', () => {
  assert.equal(readDocument(Buffer.from('not a zip at all'), '.xlsx'), '');
  assert.equal(readDocument(zip({ 'xl/worksheets/sheet1.xml': '<row><c t="inlineStr"><is><t>never closed' }), '.xlsx'), '');
});

test('docx headers/footers and pptx speaker notes are read after the main content', () => {
  const W = (b) => `<w:document><w:body>${b}</w:body></w:document>`;
  const d = readDocument(zip({
    'word/footer1.xml': W('<w:p><w:t>FooterText</w:t></w:p>'),
    'word/header1.xml': W('<w:p><w:t>HeaderText</w:t></w:p>'),
    'word/document.xml': W('<w:p><w:t>BodyText</w:t></w:p>'),
  }), '.docx');
  assert.ok(d.indexOf('BodyText') >= 0 && d.indexOf('HeaderText') > d.indexOf('BodyText') && d.indexOf('FooterText') > d.indexOf('HeaderText'));
  const p = readDocument(zip({
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:t>SpeakerNote</a:t></a:p></p:notes>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:t>SlideText</a:t></a:p></p:sld>',
  }), '.pptx');
  assert.ok(p.includes('SlideText') && p.indexOf('SpeakerNote') > p.indexOf('SlideText'));
});

test('a word found only in an inlineStr xlsx cell is searchable after upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-docs2-'));
  const app = await start({ port: 0, dataDir: dir, answerer: null });
  try {
    const r = await fetch(`http://127.0.0.1:${app.port}/api/upload?name=zoo.xlsx`, { method: 'POST', headers: { 'x-pacrag': '1', 'content-type': 'application/octet-stream' },
      body: zip({ 'xl/worksheets/sheet1.xml': sheet('<row><c t="inlineStr"><is><t>The platypus enclosure opens Friday</t></is></c><c><v>7</v></c></row>') }) });
    const up = await r.json();
    assert.equal(r.status, 201);
    assert.equal(up.noText, false);
    const a = await (await fetch(`http://127.0.0.1:${app.port}/api/ask`, { method: 'POST', headers: { 'x-pacrag': '1', 'content-type': 'application/json' }, body: JSON.stringify({ q: 'platypus' }) })).json();
    assert.notEqual(a.mode, 'none');
    assert.ok(a.sources.some((s) => /platypus/.test(s.text)));
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
