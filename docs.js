'use strict';
// Text extraction for documents the server cannot read as plain text. No dependencies.
// readDocument() never throws: anything it cannot read (scanned, encrypted, damaged, unsupported) yields '',
// and the caller then files the upload as "no text extracted", exactly as before.
//
// This runs synchronously inside the HTTP server, so every scanner here must be linear in its input and every
// output must be capped: no regex with unbounded nested/adjacent quantifiers on attacker-controlled text.
const zlib = require('zlib');

const MAX_STREAM = 16 * 1024 * 1024; // inflated bytes per stream (zip-bomb guard)
const MAX_TOTAL = 64 * 1024 * 1024; // inflated bytes per document
const MAX_ENTRIES = 20000;
const MAX_NAME = 512; // zip entry names longer than this are ignored
const MAX_TEXT = 4000000; // extracted characters per document
const MAX_OBJECTS = 200000; // PDF objects
const MAX_PAGES = 5000;
const MAX_FONTS = 256; // PDF fonts decoded per document
const MAX_CMAP_ENTRIES = 200000; // code -> text entries per ToUnicode CMap
const MAX_CMAP_TRIPLES = 100000; // bfchar pairs / bfrange triples examined per CMap
const MAX_CMAP_BYTES = 32 * 1024 * 1024; // ToUnicode bytes parsed per document
const MAX_OBJSTM_CHARS = 32 * 1024 * 1024; // characters sliced out of object streams per document

// ---------- shared helpers ----------
const XML_NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const fromCode = (n) => { try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch { return ''; } };
const decodeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return fromCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return XML_NAMED[e.toLowerCase()] ?? m;
});
const tidy = (s) => s.replace(/\r/g, '').replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------- zip (docx, pptx, xlsx, odt, ods, odp) ----------
function zipEntries(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (p > e) throw new Error('bad central directory');
  const out = new Map();
  for (let n = 0; n < Math.min(count, MAX_ENTRIES); n++) {
    if (p + 46 > e || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > e) break;
    // an entry whose local header or data lies outside the file cannot be read: leave it out
    if (nameLen <= MAX_NAME && local + 30 <= buf.length && local + 30 + csize <= buf.length) {
      out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method, csize, usize, local });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(buf, entry, budget) {
  const { method, csize, usize, local } = entry;
  if (usize > MAX_STREAM || csize > MAX_STREAM && method === 0) throw new Error('part too large');
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  if (start + csize > buf.length) throw new Error('truncated zip entry');
  const data = buf.subarray(start, start + csize);
  let out;
  if (method === 0) out = data;
  else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: MAX_STREAM });
  else throw new Error('unsupported zip method');
  budget.left -= out.length;
  if (budget.left < 0) throw new Error('document too large when unpacked');
  return out.toString('utf8');
}
const numberIn = (name) => Number((name.match(/(\d+)\.xml$/) || [0, 0])[1]);

// Walk every <...> tag exactly once. cb(tag, after) gets the text between the brackets and the index after '>';
// it may return a new scan position. An unclosed '<' ends the scan (it cannot be a tag), so this is linear.
function eachTag(xml, cb) {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) return;
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return;
    const next = cb(xml.slice(lt + 1, gt), gt + 1);
    pos = typeof next === 'number' ? next : gt + 1;
  }
}
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
// <name> or <name attr...> (but not <namex>)
const isTag = (tag, name) => tag === name || (tag.length > name.length && tag.startsWith(name) && isSpace(tag[name.length]));
const WORD_BREAK = /^w:(tab|br|cr)\s*\/$/;

function wordText(xml) {
  let out = '', dead = false;
  eachTag(xml, (tag, after) => {
    if (out.length > MAX_TEXT) return xml.length;
    if (tag === '/w:p') out += '\n\n';
    else if (isTag(tag, 'w:t')) {
      if (dead) return undefined;
      const e = xml.indexOf('</w:t>', after);
      if (e < 0) { dead = true; return undefined; } // no closing tag anywhere ahead: do not search again
      out += decodeXml(xml.slice(after, e));
      return e + 6;
    } else {
      const m = WORD_BREAK.exec(tag);
      if (m) out += m[1] === 'tab' ? '\t' : '\n';
    }
    return undefined;
  });
  return out;
}
function slideText(xml) {
  let out = '', dead = false;
  eachTag(xml, (tag, after) => {
    if (out.length > MAX_TEXT) return xml.length;
    if (tag === '/a:p') out += '\n';
    else if (isTag(tag, 'a:t')) {
      if (dead) return undefined;
      const e = xml.indexOf('</a:t>', after);
      if (e < 0) { dead = true; return undefined; }
      out += decodeXml(xml.slice(after, e));
      return e + 6;
    }
    return undefined;
  });
  return out;
}
// ---- xlsx: shared strings (index-preserving) and worksheets (one line per row) ----
const attrOf = (tag, name) => {
  const m = new RegExp('(?:^|\\s)' + name.replace(/[:.]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(tag);
  return m ? decodeXml(m[1] ?? m[2] ?? '') : null;
};

function sharedList(xml) {
  const list = [];
  let s = '', inSi = false, dead = false, size = 0;
  eachTag(xml, (tag, after) => {
    if (size > MAX_TEXT) return xml.length;
    if (tag === 'si') { inSi = true; s = ''; } else if (tag === '/si') {
      if (inSi) { list.push(s); size += s.length + 1; }
      inSi = false;
    } else if (tag === 'si/') { list.push(''); } else if (inSi && isTag(tag, 't') && !tag.endsWith('/')) {
      if (dead) return undefined;
      const e = xml.indexOf('</t>', after);
      if (e < 0) { dead = true; return undefined; }
      s += decodeXml(xml.slice(after, e));
      return e + 4;
    }
    return undefined;
  });
  return list;
}
function sheetRows(xml, shared) {
  const lines = [];
  let cells = [], size = 0, inC = false, type = '', val = '', inIs = false, deadT = false, deadV = false;
  const endCell = () => {
    let v = val.trim();
    if (type === 's') v = /^\d+$/.test(v) && shared[Number(v)] !== undefined ? shared[Number(v)].trim() : '';
    else if (type === 'b') v = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
    else if (type === 'e') v = '';
    if (v) { cells.push(v); size += v.length + 3; }
    inC = false; inIs = false; val = '';
  };
  eachTag(xml, (tag, after) => {
    if (size > MAX_TEXT) return xml.length;
    if (isTag(tag, 'c')) {
      if (inC) endCell();
      if (tag.endsWith('/')) return undefined;
      inC = true; val = ''; type = attrOf(tag, 't') || 'n';
    } else if (tag === '/c') { if (inC) endCell(); }
    else if (tag === '/row') {
      if (inC) endCell();
      if (cells.length) lines.push(cells.join(' | '));
      cells = [];
    } else if (inC && tag === 'is') inIs = true;
    else if (inC && tag === '/is') inIs = false;
    else if (inC && isTag(tag, 'v') && !tag.endsWith('/')) {
      if (deadV) return undefined;
      const e = xml.indexOf('</v>', after);
      if (e < 0) { deadV = true; return undefined; }
      val += decodeXml(xml.slice(after, e));
      return e + 4;
    } else if (inC && inIs && isTag(tag, 't') && !tag.endsWith('/')) {
      if (deadT) return undefined;
      const e = xml.indexOf('</t>', after);
      if (e < 0) { deadT = true; return undefined; }
      val += decodeXml(xml.slice(after, e));
      return e + 4;
    }
    return undefined;
  });
  if (inC) endCell();
  if (cells.length) lines.push(cells.join(' | '));
  return lines.join('\n');
}
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
function workbookText(entries, read) {
  const shared = entries.has('xl/sharedStrings.xml') ? sharedList(read('xl/sharedStrings.xml')) : [];
  const sheetFiles = [...entries.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort(natural);
  if (!sheetFiles.length) return shared.map((x) => x.trim()).filter(Boolean).join('\n');
  const names = new Map(); // file -> sheet name
  const order = [];
  try {
    if (entries.has('xl/workbook.xml') && entries.has('xl/_rels/workbook.xml.rels')) {
      const targets = new Map();
      eachTag(read('xl/_rels/workbook.xml.rels'), (tag) => {
        if (!isTag(tag, 'Relationship')) return;
        const id = attrOf(tag, 'Id'), t = attrOf(tag, 'Target');
        if (id && t) targets.set(id, t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''));
      });
      eachTag(read('xl/workbook.xml'), (tag) => {
        if (!isTag(tag, 'sheet')) return;
        const f = targets.get(attrOf(tag, 'r:id'));
        if (f && entries.has(f) && !names.has(f)) { names.set(f, attrOf(tag, 'name') || ''); order.push(f); }
      });
    }
  } catch { /* fall back to file-name order */ }
  const files = [...order, ...sheetFiles.filter((f) => !names.has(f))];
  const out = [];
  let size = 0;
  for (const f of files) {
    const rows = sheetRows(read(f), shared);
    if (!rows) continue;
    const name = names.get(f);
    const t = name ? name + '\n' + rows : rows;
    out.push(t);
    size += t.length;
    if (size > MAX_TEXT) break;
  }
  return out.join('\n\n');
}

const ODF_SPACE = /^text:s(?:\s[\s\S]*)?\/$/;
function odfText(xml) {
  let out = '', pos = 0;
  while (pos < xml.length && out.length <= MAX_TEXT) {
    const lt = xml.indexOf('<', pos);
    const gt = lt < 0 ? -1 : xml.indexOf('>', lt + 1);
    if (gt < 0) { out += xml.slice(pos); break; } // no more complete tags: the rest is plain text
    out += xml.slice(pos, lt);
    const tag = xml.slice(lt + 1, gt);
    if (!tag) out += '<>';
    else if (/^text:tab\s*\/$/.test(tag)) out += '\t';
    else if (ODF_SPACE.test(tag)) out += ' ';
    else if (/^text:line-break\s*\/$/.test(tag)) out += '\n';
    else if (tag === '/text:p' || tag === '/text:h' || tag === '/table:table-row') out += '\n';
    else if (tag === '/table:table-cell') out += '\t';
    pos = gt + 1;
  }
  return decodeXml(out);
}

function zipDocument(buf, ext) {
  const entries = zipEntries(buf);
  const budget = { left: MAX_TOTAL };
  const read = (name) => zipRead(buf, entries.get(name), budget);
  const named = (re) => [...entries.keys()].filter((n) => re.test(n)).sort((a, b) => numberIn(a) - numberIn(b) || a.localeCompare(b));
  if (ext === '.docx') {
    if (!entries.has('word/document.xml')) return '';
    const parts = ['word/document.xml', ...named(/^word\/(?:footnotes|endnotes)\.xml$/), ...named(/^word\/header\d*\.xml$/), ...named(/^word\/footer\d*\.xml$/)];
    return parts.map((n) => wordText(read(n))).join('\n\n');
  }
  if (ext === '.pptx') {
    const out = [];
    let size = 0;
    for (const n of [...named(/^ppt\/slides\/slide\d+\.xml$/), ...named(/^ppt\/notesSlides\/notesSlide\d+\.xml$/)]) {
      const t = slideText(read(n));
      out.push(t);
      size += t.length;
      if (size > MAX_TEXT) break;
    }
    return out.join('\n\n');
  }
  if (ext === '.xlsx') return workbookText(entries, read);
  if (ext === '.odt' || ext === '.ods' || ext === '.odp') return entries.has('content.xml') ? odfText(read('content.xml')) : '';
  return '';
}

// ---------- PDF ----------
const unescapeLiteral = (s) => s.replace(/\\(?:([0-7]{1,3})|(\r\n|\r|\n)|(.))/gs, (m, oct, nl, ch) => {
  if (oct) return String.fromCharCode(parseInt(oct, 8) & 255);
  if (nl !== undefined) return '';
  return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[ch] ?? ch;
});
const hexBytes = (h) => { h = h.replace(/\s+/g, ''); if (h.length % 2) h += '0'; return Buffer.from(h, 'hex').toString('latin1'); };
const utf16be = (hex) => { let s = ''; for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16)); return s; };

// "12 0 R" with every run bounded, so a long run of digits or blanks costs O(1) per start, not O(n)
const REF_SRC = '(?<!\\d)(\\d{1,10})\\s{1,8}\\d{1,5}\\s{1,8}R(?![A-Za-z])';
const newRefs = () => new RegExp(REF_SRC, 'g');
const refCache = new Map();
const refOf = (dict, key) => {
  let re = refCache.get(key);
  if (!re) { re = new RegExp(`/${key}\\s{1,8}(\\d{1,10})\\s{1,8}\\d{1,5}\\s{1,8}R`); refCache.set(key, re); }
  const m = re.exec(dict);
  return m ? Number(m[1]) : null;
};

const cc = (s, i) => s.charCodeAt(i);
const isDigitCode = (c) => c >= 48 && c <= 57;
const isSpaceCode = (c) => c === 32 || (c >= 9 && c <= 13) || c === 160;
const isWordCode = (c) => isDigitCode(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

// Find "<num> <gen> obj" by hopping between occurrences of the word "obj" and reading the number backwards.
// Returns { num, start } (start = index after "obj") or null.
function objHeader(s, at) {
  if (isWordCode(cc(s, at + 3))) return null;
  let j = at - 1, k = 0;
  while (j >= 0 && k < 8 && isSpaceCode(cc(s, j))) { j--; k++; }
  if (!k) return null;
  k = 0;
  while (j >= 0 && k < 5 && isDigitCode(cc(s, j))) { j--; k++; }
  if (!k) return null;
  let w = 0;
  while (j >= 0 && w < 8 && isSpaceCode(cc(s, j))) { j--; w++; }
  if (!w) return null;
  const end = j + 1;
  k = 0;
  while (j >= 0 && k < 10 && isDigitCode(cc(s, j))) { j--; k++; }
  if (!k || (j >= 0 && isDigitCode(cc(s, j)))) return null;
  return { num: Number(s.slice(j + 1, end)), start: at + 3 };
}

// What the /Filter entry of a stream dictionary says: { flate, other, any }
function filterInfo(dict) {
  const at = dict.indexOf('/Filter');
  if (at < 0) return { any: false, flate: false, other: false };
  let p = at + 7;
  while (p < dict.length && isSpaceCode(cc(dict, p))) p++;
  let body;
  if (dict[p] === '[') {
    const close = dict.indexOf(']', p);
    body = dict.slice(p, close < 0 ? p + 1024 : close);
  } else body = dict.slice(p, p + 64);
  const flate = /^\[?\s*\/FlateDecode/.test(body);
  const other = /\/(?:ASCII85|ASCIIHex|LZW|DCT|JPX|CCITT|RunLength)/.test(body);
  return { any: true, flate, other: dict[p] === '[' && other };
}

function inflate(data) {
  try { return zlib.inflateSync(data, { maxOutputLength: MAX_STREAM, finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
}

function parsePdf(buf) {
  const s = buf.toString('latin1');
  const objs = new Map(); // number -> { dict: string, data: Buffer | null }
  let total = 0;
  let nextEnd; // memoised indexOf results: undefined = unknown, -1 = none left in the file
  let nextStream;
  let from = 0;
  for (;;) {
    const at = s.indexOf('obj', from);
    if (at < 0) break;
    from = at + 3;
    const h = objHeader(s, at);
    if (!h) continue;
    const { num, start } = h;
    if (nextEnd === undefined || (nextEnd !== -1 && nextEnd < start)) nextEnd = s.indexOf('endobj', start);
    if (nextStream === undefined || (nextStream !== -1 && nextStream < start)) nextStream = s.indexOf('stream', start);
    const end = nextEnd, st = nextStream;
    if (st !== -1 && (end === -1 || st < end) && s.slice(st - 3, st) !== 'end') {
      let ds = st + 6;
      if (s[ds] === '\r') ds++;
      if (s[ds] === '\n') ds++;
      let de = s.indexOf('endstream', ds);
      if (de === -1) de = buf.length;
      objs.set(num, { dict: s.slice(start, st), data: buf.subarray(ds, de) });
      from = Math.max(de, from);
    } else if (end !== -1) {
      objs.set(num, { dict: s.slice(start, end), data: null });
      from = Math.max(end, from);
    } else break;
    if (objs.size > MAX_OBJECTS) break;
  }
  // decode streams lazily, but object streams now: they hold ordinary objects (often the page tree)
  const cache = new Map();
  const stream = (num) => {
    if (cache.has(num)) return cache.get(num);
    const o = objs.get(num);
    let out = null;
    if (o && o.data) {
      const f = filterInfo(o.dict);
      if (f.flate && !f.other) {
        out = inflate(o.data);
        if (out) { total += out.length; if (total > MAX_TOTAL) throw new Error('document too large when unpacked'); }
      } else if (!f.any) out = o.data;
    }
    cache.set(num, out);
    return out;
  };
  let sliced = 0;
  for (const [num, o] of [...objs]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const body = stream(num);
    if (!body) continue;
    const n = Number((o.dict.match(/\/N\s+(\d+)/) || [])[1]), first = Number((o.dict.match(/\/First\s+(\d+)/) || [])[1]);
    if (!n || !first) continue;
    const txt = body.toString('latin1');
    const count = Math.min(n, 100000);
    const nums = txt.slice(0, Math.min(first, count * 24 + 24)).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count && 2 * i + 1 < nums.length; i++) {
      if (objs.size > MAX_OBJECTS) break;
      const a = first + nums[2 * i + 1], to = 2 * i + 3 < nums.length ? first + nums[2 * i + 3] : txt.length;
      if (!(to > a)) { if (!objs.has(nums[2 * i])) objs.set(nums[2 * i], { dict: '', data: null }); continue; }
      sliced += to - a;
      if (sliced > MAX_OBJSTM_CHARS) break; // overlapping offsets could otherwise copy the same bytes endlessly
      if (!objs.has(nums[2 * i])) objs.set(nums[2 * i], { dict: txt.slice(a, to), data: null });
    }
  }
  return { s, objs, stream, cmaps: new Map(), cmapBytes: 0 };
}

function balanced(str, from) { // the "<<...>>" starting at or after `from`
  const a = str.indexOf('<<', from);
  if (a < 0) return '';
  let depth = 0;
  for (let i = a; i < str.length - 1; i++) {
    if (str[i] === '<' && str[i + 1] === '<') { depth++; i++; }
    else if (str[i] === '>' && str[i + 1] === '>') { depth--; i++; if (!depth) return str.slice(a, i + 1); }
  }
  return '';
}
function valueDict(pdf, dict, key) { // a dictionary value that may be inline or a reference
  const r = refOf(dict, key);
  if (r !== null) return pdf.objs.has(r) ? pdf.objs.get(r).dict : '';
  const k = dict.search(new RegExp(`/${key}\\s*<<`));
  return k < 0 ? '' : balanced(dict, k);
}

const BFCHAR = /<([0-9a-fA-F]{1,8})>\s{0,64}<([0-9a-fA-F]{0,256})>/g;
const BFRANGE_HEAD = /<([0-9a-fA-F]{1,8})>\s{0,64}<([0-9a-fA-F]{1,8})>\s{0,64}/y;
const BFRANGE_DEST = /<([0-9a-fA-F]{0,256})>/y;
// call cb(sectionText) for each begin...end pair, scanning forward once
function eachSection(text, begin, end, cb) {
  let pos = 0;
  for (;;) {
    const a = text.indexOf(begin, pos);
    if (a < 0) return;
    const b = text.indexOf(end, a + begin.length);
    if (b < 0) return;
    if (cb(text.slice(a + begin.length, b)) === false) return;
    pos = b + end.length;
  }
}
function parseCMap(text) {
  const map = new Map();
  const cs = text.match(/begincodespacerange\s{0,64}<([0-9a-fA-F]{1,8})>/);
  const bytes = cs ? Math.max(1, Math.min(4, cs[1].length / 2)) : 1;
  let entries = 0, triples = 0;
  eachSection(text, 'beginbfchar', 'endbfchar', (sec) => {
    BFCHAR.lastIndex = 0;
    let p;
    while ((p = BFCHAR.exec(sec))) {
      if (++triples > MAX_CMAP_TRIPLES || ++entries > MAX_CMAP_ENTRIES) return false;
      map.set(parseInt(p[1], 16), utf16be(p[2]));
    }
    return true;
  });
  eachSection(text, 'beginbfrange', 'endbfrange', (sec) => {
    let pos = 0;
    while (pos < sec.length) {
      const lt = sec.indexOf('<', pos);
      if (lt < 0) break;
      BFRANGE_HEAD.lastIndex = lt;
      const m = BFRANGE_HEAD.exec(sec);
      if (!m) { pos = lt + 1; continue; }
      const q = BFRANGE_HEAD.lastIndex;
      pos = q;
      if (sec[q] !== '[' && sec[q] !== '<') continue;
      if (++triples > MAX_CMAP_TRIPLES) return false;
      const lo = parseInt(m[1], 16), hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (sec[q] === '[') {
        const close = sec.indexOf(']', q);
        if (close < 0) return false; // unclosed array: nothing sensible follows
        let i = 0;
        for (const d of sec.slice(q, close).matchAll(/<([0-9a-fA-F]*)>/g)) {
          if (lo + i > hi || ++entries > MAX_CMAP_ENTRIES) break;
          map.set(lo + i, utf16be(d[1]));
          i++;
        }
        pos = close + 1;
      } else {
        BFRANGE_DEST.lastIndex = q;
        const d = BFRANGE_DEST.exec(sec);
        if (!d) continue;
        pos = BFRANGE_DEST.lastIndex;
        const base = utf16be(d[1]);
        if (!base) continue;
        const head = base.slice(0, -1), last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) {
          if (++entries > MAX_CMAP_ENTRIES) return false;
          map.set(c, head + String.fromCharCode(last + (c - lo)));
        }
      }
      if (entries > MAX_CMAP_ENTRIES) return false;
    }
    return true;
  });
  return { map, bytes };
}

function fontFor(pdf, num, fonts) {
  if (fonts.has(num)) return fonts.get(num);
  if (fonts.size >= MAX_FONTS) return { cmap: null, unreadable: true };
  const o = pdf.objs.get(num);
  let f = { cmap: null, unreadable: false };
  if (o) {
    const tu = refOf(o.dict, 'ToUnicode');
    const body = tu !== null ? pdf.stream(tu) : null;
    if (body) {
      if (pdf.cmaps.has(tu)) f.cmap = pdf.cmaps.get(tu);
      else if (pdf.cmapBytes + body.length > MAX_CMAP_BYTES) f.unreadable = true;
      else {
        pdf.cmapBytes += body.length;
        f.cmap = parseCMap(body.toString('latin1'));
        pdf.cmaps.set(tu, f.cmap);
      }
    } else if (/\/Subtype\s*\/Type0/.test(o.dict)) f.unreadable = true; // composite font with no way to map codes to characters
  }
  fonts.set(num, f);
  return f;
}

function contentText(pdf, c, fontMap, fonts, limit) {
  let font = null, out = '', i = 0;
  const n = c.length;
  const show = (raw) => {
    if (!font || font.unreadable) return;
    if (!font.cmap) { out += raw; return; }
    const { map, bytes } = font.cmap;
    for (let k = 0; k + bytes <= raw.length; k += bytes) {
      let code = 0;
      for (let b = 0; b < bytes; b++) code = code * 256 + raw.charCodeAt(k + b);
      out += map.get(code) ?? '';
    }
  };
  const readString = () => { // at '('
    let depth = 0, j = i;
    for (; j < n; j++) {
      const ch = c[j];
      if (ch === '\\') j++;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    const raw = unescapeLiteral(c.slice(i + 1, j));
    i = j + 1;
    return raw;
  };
  const readHex = () => { const j = c.indexOf('>', i); const raw = hexBytes(c.slice(i + 1, j < 0 ? n : j)); i = j < 0 ? n : j + 1; return raw; };
  const readArray = () => {
    const items = [];
    i++;
    while (i < n && c[i] !== ']') {
      const ch = c[i];
      if (ch === '(') items.push({ s: readString() });
      else if (ch === '<' && c[i + 1] !== '<') items.push({ s: readHex() });
      else if (/[-+.\d]/.test(ch)) { const m = /^[-+]?\d*\.?\d+/.exec(c.slice(i, i + 24)); if (m) { items.push({ n: Number(m[0]) }); i += m[0].length; } else i++; }
      else i++;
    }
    i++;
    return items;
  };
  // BI ... EI (inline image data): jump past the next whitespace-delimited "EI" without slicing; none means skip the rest
  const skipInlineImage = () => {
    let p = c.indexOf('EI', i);
    while (p >= 0) {
      if (p > i && /\s/.test(c[p - 1]) && (p + 2 >= n || /\s/.test(c[p + 2]))) { i = p + 2; return; }
      p = c.indexOf('EI', p + 1);
    }
    i = n;
  };
  let stack = [];
  while (i < n && out.length < limit) {
    const ch = c[i];
    if (stack.length > 4096) stack = []; // operands without an operator: junk
    if (ch === '(') stack.push({ s: readString() });
    else if (ch === '<' && c[i + 1] !== '<') stack.push({ s: readHex() });
    else if (ch === '[') stack.push({ a: readArray() });
    else if (ch === '/') { const m = /^\/[^\s\/<>\[\]()]*/.exec(c.slice(i, i + 200)); stack.push({ name: m[0].slice(1) }); i += m[0].length; }
    else if (ch === '%') { while (i < n && c[i] !== '\n' && c[i] !== '\r') i++; }
    else if (/[-+.\d]/.test(ch)) { const m = /^[-+]?\d*\.?\d+/.exec(c.slice(i, i + 24)); if (m) { stack.push({ n: Number(m[0]) }); i += m[0].length; } else i++; }
    else if (/[A-Za-z'"*]/.test(ch)) {
      const m = /^[A-Za-z'"*0-9]+/.exec(c.slice(i, i + 16));
      const op = m[0];
      i += op.length;
      const last = stack[stack.length - 1];
      switch (op) {
        case 'Tf': { const nm = stack.find((x) => x.name !== undefined); font = nm && fontMap.has(nm.name) ? fontFor(pdf, fontMap.get(nm.name), fonts) : { cmap: null, unreadable: false }; break; }
        case 'Tj': if (last && last.s !== undefined) show(last.s); break;
        case "'": out += '\n'; if (last && last.s !== undefined) show(last.s); break;
        case '"': out += '\n'; if (last && last.s !== undefined) show(last.s); break;
        case 'TJ': if (last && last.a) for (const it of last.a) { if (it.s !== undefined) show(it.s); else if (it.n < -250) out += ' '; } break;
        case 'Td': case 'TD': { const ty = stack.length >= 1 ? stack[stack.length - 1].n : 0; out += ty ? '\n' : ' '; break; }
        case 'T*': case 'Tm': case 'ET': out += '\n'; break;
        case 'BI': skipInlineImage(); break;
        default: break;
      }
      stack = [];
    } else i++;
  }
  return out;
}

function pdfDocument(buf) {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF')) return '';
  const pdf = parsePdf(buf);
  if (/\/Encrypt\b/.test(pdf.s.slice(-4096)) || [...pdf.objs.values()].some((o) => o.data && /\/Type\s*\/XRef/.test(o.dict) && /\/Encrypt\b/.test(o.dict))) return '';

  // collect pages in reading order by walking the page tree; fall back to object order for damaged files
  const pages = [];
  const walk = (num, inherited, depth, seen) => {
    const o = pdf.objs.get(num);
    if (!o || depth > 40 || seen.has(num) || pages.length >= MAX_PAGES) return;
    seen.add(num);
    const own = /\/Resources\b/.test(o.dict) ? o.dict : null;
    const res = own || inherited;
    if (/\/Type\s*\/Pages\b/.test(o.dict) || /\/Kids\s*\[/.test(o.dict)) {
      const kids = (o.dict.match(/\/Kids\s*\[([^\]]*)\]/) || [, ''])[1];
      for (const k of kids.matchAll(newRefs())) {
        if (pages.length >= MAX_PAGES) break;
        walk(Number(k[1]), res, depth + 1, seen);
      }
    } else pages.push({ dict: o.dict, res });
  };
  let root = null;
  for (const [num, o] of pdf.objs) if (/\/Type\s*\/Catalog\b/.test(o.dict)) { root = refOf(o.dict, 'Pages'); if (root !== null) break; }
  if (root !== null) walk(root, null, 0, new Set());
  if (!pages.length) {
    for (const [, o] of [...pdf.objs].sort((a, b) => a[0] - b[0])) {
      if (pages.length >= MAX_PAGES) break;
      if (/\/Type\s*\/Page(?![A-Za-z])/.test(o.dict)) pages.push({ dict: o.dict, res: o.dict });
    }
  }

  const fonts = new Map();
  const fontMaps = [new Map(), new Map()]; // resources are usually inherited by every page: resolve each once
  const fontMapFor = (pg) => {
    const own = pg.res === pg.dict;
    const cached = fontMaps[own ? 1 : 0].get(pg.res);
    if (cached) return cached;
    const fontMap = new Map();
    const resDict = own || /\/Resources\s*<</.test(pg.res) || refOf(pg.res, 'Resources') !== null ? valueDict(pdf, pg.res, 'Resources') : pg.res;
    const fd = valueDict(pdf, resDict, 'Font');
    for (const f of fd.matchAll(/\/([^\s\/<>\[\]()]{1,127})\s{1,8}(\d{1,10})\s{1,8}\d{1,5}\s{1,8}R/g)) fontMap.set(f[1], Number(f[2]));
    fontMaps[own ? 1 : 0].set(pg.res, fontMap);
    return fontMap;
  };
  const texts = [];
  let size = 0, processed = 0;
  pageLoop:
  for (const pg of pages) {
    const fontMap = pg.res ? fontMapFor(pg) : new Map();
    const cont = (pg.dict.match(/\/Contents\s*(\[[^\]]*\]|(?<!\d)\d{1,10}\s{1,8}\d{1,5}\s{1,8}R)/) || [, ''])[1];
    let text = '', used = 0;
    for (const r of cont.matchAll(newRefs())) {
      if (++used > 1000) break;
      const body = pdf.stream(Number(r[1]));
      if (!body) continue;
      processed += body.length;
      if (processed > MAX_TOTAL) break pageLoop;
      text += contentText(pdf, body.toString('latin1'), fontMap, fonts, MAX_TEXT - size) + '\n';
      if (size + text.length >= MAX_TEXT) break;
    }
    if (text.trim()) { texts.push(text); size += text.length; }
    if (size >= MAX_TEXT) break;
  }
  return texts.join('\n\n');
}

// ---------- entry point ----------
const ZIP_EXT = new Set(['.docx', '.pptx', '.xlsx', '.odt', '.ods', '.odp']);
const DOC_EXT = new Set(['.pdf', ...ZIP_EXT]);

function readDocument(buf, ext) {
  try {
    let raw = ext === '.pdf' ? pdfDocument(buf) : ZIP_EXT.has(ext) ? zipDocument(buf, ext) : '';
    if (raw.length > MAX_TEXT) raw = raw.slice(0, MAX_TEXT);
    const text = tidy(raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, ''));
    // mostly-symbol output means an unmappable font, which is worse than honestly reporting "no text"
    const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
    return text && letters / text.replace(/\s/g, '').length >= 0.5 ? text : '';
  } catch { return ''; }
}

module.exports = { readDocument, DOC_EXT };