'use strict';
// PAC&RAG server: no dependencies. Ingest, categorize, index (BM25), chat, extract.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_NOTE = 1024 * 1024;
const MAX_TEXT = 2_000_000; // characters indexed per item; beyond this the item is flagged truncated
const SAME = 0.25; // similarity at or above: the item joins that category outright
const MAYBE = 0.1; // between MAYBE and SAME: joins it but is flagged for review; below: new category
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml', '.ini', '.html', '.htm', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.sql', '.css']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const STOP = new Set('a about above after again all also an and any are as at be because been before being below between both but by can could did do does down during each for from further had has have he her here him his how i if in into is it its just may me more most my no not of off on once one only or other our out over own same shall she should so some such than that the their them then there these they this those to too under until up very was we were what when where which who whom why will with would you your get gets getting got make makes making made take takes taking took tell tells show shows much long many without excluding except need needs want wants know please way ways thing things something anything'.split(' '));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const dict = () => Object.create(null); // prototype-free lookup table: words like "constructor" or "__proto__" are ordinary keys
const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };
const cpSlice = (s, n) => { let out = '', i = 0; for (const ch of s) { if (i++ >= n) break; out += ch; } return out; }; // never splits a surrogate pair
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (s) => s.replace(LONE_SURROGATE, '\uFFFD');
const nfc = (s) => String(s).normalize('NFC');
const keepExt = (name, max) => { // shorten a file name to max code points but keep a short extension
  if (cpLen(name) <= max) return name;
  const ext = path.extname(name);
  return ext && cpLen(ext) <= 16 && ext.length < name.length ? cpSlice(name.slice(0, -ext.length), max - cpLen(ext)) + ext : cpSlice(name, max);
};

const contentDisposition = (title) => {
  try {
    const enc = encodeURIComponent(wellFormed(String(title))).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename*=UTF-8''${enc}`;
  } catch { return 'attachment'; }
};
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const saveError = (e) => httpError(500, `Could not save to disk (${(e && e.code) || 'error'}). Close anything using the data folder and try again.`);
const LOCAL_ONLY = () => /^(1|true|yes)$/i.test(String(process.env.PACRAG_LOCAL_ONLY || '').trim());

const VERSION = (() => { try { return require('./package.json').version; } catch { return 'unknown'; } })();
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, ''); // café = cafe, März = marz
const pluralStem = (t) => (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t) ? t.slice(0, -1) : t); // what the page's highlighter uses; kept so highlights still line up
const vowelGroups = (s) => (s.match(/[aeiouy]+/g) || []).length;
// Light suffix stripping (plural, -ing, -ed, -ly) applied identically to documents and questions, so baked/baking/bake and lasagne/lasagna meet.
const stem = (t) => {
  if (t.length < 4 || !/^\p{L}+$/u.test(t)) return t;
  let w = t, verb = false;
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (/(?:ch|sh|x|ss)es$/.test(w) || (w.length > 5 && w.endsWith('oes'))) w = w.slice(0, -2);
  else w = pluralStem(w);
  const fix = (base) => { // undo doubled consonants (running) and a dropped e (baking)
    verb = true;
    if (/([bcdfghjkmnpqrtvwx])\1$/.test(base)) return base.slice(0, -1);
    return base.length <= 4 && vowelGroups(base) === 1 && /[^aeiou][aeiouy][^aeiouwxy]$/.test(base) ? base + 'e' : base;
  };
  if (w.length > 5 && w.endsWith('ing') && /[aeiouy]/.test(w.slice(0, -3))) w = fix(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ied')) { w = w.slice(0, -3) + 'y'; verb = true; }
  else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed') && /[aeiouy]/.test(w.slice(0, -2))) w = fix(w.slice(0, -2));
  if (!verb && w.length > 5 && w.endsWith('ly')) w = w.slice(0, -2);
  if (w.endsWith('agne')) w = w.slice(0, -1) + 'a'; // lasagne / lasagna
  return w;
};
const TOKEN = /\p{N}+(?:\.\p{N}+)+|[\p{L}\p{N}]+/gu; // 4.25 stays one token
const tokenize = (s) => (fold(String(s).toLowerCase()).replace(/(\d),(?=\d{3}\b)/g, '$1').match(TOKEN) || []).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
// Decode with the declared charset, a BOM, or a <meta charset>; otherwise UTF-8, falling back to Windows-1252 for legacy files.
const decodeBuf = (buf, hint) => decodeRaw(buf, hint).replace(/\r\n?/g, '\n');
function decodeRaw(buf, hint) {
  if (buf[0] === 0xff && buf[1] === 0xfe) hint = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) hint = 'utf-16be';
  else if (!hint) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i) || head.match(/^<\?xml[^>]+encoding=["']([\w-]+)/i);
    if (m) hint = m[1];
  }
  const strip = (s) => s.replace(/^﻿/, '');
  const attempt = (label, fatal) => { try { return strip(new TextDecoder(label, { fatal }).decode(buf)); } catch { return null; } };
  const label = (hint || '').toLowerCase();
  if (label && !/^utf-?8$/.test(label)) { const s = attempt(label, false); if (s !== null) return s; } // a declared legacy charset wins; an unknown label is ignored
  const s = attempt('utf-8', true); // strict UTF-8 first
  if (s !== null) return s;
  // Stray bytes in otherwise UTF-8 text keep it UTF-8 (they become U+FFFD); Windows-1252 only when no UTF-8 multi-byte sequence occurs at all.
  if (UTF8_MULTIBYTE.test(buf.toString('latin1'))) return attempt('utf-8', false);
  return attempt('windows-1252', false) || strip(buf.toString('utf8'));
}
const hasUtf16Bom = (buf) => (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
const UTF8_MULTIBYTE = /[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2}/; // well-formed UTF-8 sequences, tested on a latin1 string (one char per byte)
const looksLikeText = (buf) => (hasUtf16Bom(buf) || !buf.subarray(0, 4096).includes(0)) && !/[\x00-\x08\x0e-\x1f]/.test(decodeBuf(buf)); // for extensions we do not know
const isBlank = (s) => /^[\s\p{Cf}]*$/u.test(s); // whitespace and invisible format characters (zero-width space, BOM, soft hyphen) are empty
const highSurrogate = (c) => c >= 0xd800 && c <= 0xdbff;
const NAMED = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', deg: '°', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä' };
const fromCode = (n) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '');
const decodeEntities = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, x, n) => (d ? fromCode(+d) : x ? fromCode(parseInt(x, 16)) : n.toLowerCase() === 'amp' ? '&' : (Object.hasOwn(NAMED, n.toLowerCase()) ? NAMED[n.toLowerCase()] : m)));

function chunk(text, max = 800) {
  const out = [];
  let cur = '';
  const pushLong = (para) => { // split an over-long paragraph at whitespace so values are not cut in half
    let rest = para;
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(' ', max), rest.lastIndexOf('\n', max));
      if (cut < max / 2) cut = highSurrogate(rest.charCodeAt(max - 1)) ? max - 1 : max; // never split a surrogate pair
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  };
  for (const p of text.split(/\n\s*\n/)) {
    const para = p.trim();
    if (!para) continue;
    if (cur && (cur + '\n\n' + para).length > max) { out.push(cur); cur = ''; }
    if (para.length > max) pushLong(para);
    else cur = cur ? cur + '\n\n' + para : para;
  }
  if (cur) out.push(cur);
  return out;
}

const BLOCK = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article', 'blockquote', 'ul', 'ol', 'table', 'pre', 'header', 'footer']);
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template']);
// A single linear scan: regex versions of this backtrack quadratically on hostile pages and freeze the server.
function htmlToText(html) {
  const n = html.length;
  let out = '', title = '', i = 0, gt = -2, href = null, hrefAt = 0; // href: target of the <a> being read, appended after its text
  const closeAt = (name, from) => {
    for (let p = html.indexOf('</', from); p !== -1; p = html.indexOf('</', p + 2)) if (html.substr(p + 2, name.length).toLowerCase() === name) return p;
    return -1;
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (gt < lt && gt !== Infinity) { gt = html.indexOf('>', lt); if (gt === -1) gt = Infinity; }
    const m = /^(\/?)([a-z][a-z0-9]*)/i.exec(html.substr(lt + 1, 16));
    if (gt !== Infinity && (html[lt + 1] === '!' || html[lt + 1] === '?')) { i = gt + 1; continue; } // <!DOCTYPE …>, <?xml …?>
    if (!m || gt === Infinity) { out += '<'; i = lt + 1; continue; }
    const name = m[2].toLowerCase(), closing = m[1] === '/';
    i = gt + 1;
    if (!closing && (SKIP.has(name) || name === 'title')) {
      const c = closeAt(name, i);
      if (c === -1) break; // unclosed script/style/title swallows the rest, as in a browser
      if (name === 'title') title = html.slice(i, c);
      const e = html.indexOf('>', c);
      i = e === -1 ? n : e + 1;
    } else {
      if (name === 'a') {
        if (!closing) {
          const hm = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html.slice(lt, gt));
          const target = hm ? (hm[1] ?? hm[2] ?? hm[3]).trim() : '';
          href = /^(?:https?:\/\/|mailto:)\S{1,500}$/i.test(target) ? target : null; // not '#', javascript: or relative links
          hrefAt = out.length;
        } else if (href) {
          const label = out.slice(hrefAt);
          if (!label.includes(href) && !(/^mailto:/i.test(href) && label.includes(href.slice(7)))) out += ` (${href})`;
          href = null;
        }
      }
      out += !closing && name === 'br' ? '\n' : closing && BLOCK.has(name) ? '\n\n' : ' ';
    }
  }
  const text = decodeEntities(out).replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: decodeEntities(title).replace(/\s+/g, ' ').trim(), text };
}

// ---- extraction (local, regex) ----
// Month names in English, Spanish, German and French (with and without accents); row i is month i + 1.
const MONTH_NAMES = [
  ['january', 'enero', 'januar', 'janvier', 'jan', 'ene', 'janv'],
  ['february', 'febrero', 'februar', 'février', 'fevrier', 'feb', 'févr', 'fevr'],
  ['march', 'marzo', 'märz', 'maerz', 'marz', 'mars', 'mar', 'mär', 'mrz'],
  ['april', 'abril', 'avril', 'apr', 'abr', 'avr'],
  ['may', 'mayo', 'mai'],
  ['june', 'junio', 'juni', 'juin', 'jun'],
  ['july', 'julio', 'juli', 'juillet', 'jul', 'juil'],
  ['august', 'agosto', 'août', 'aout', 'aug', 'ago'],
  ['september', 'septiembre', 'setiembre', 'septembre', 'sep', 'sept'],
  ['october', 'octubre', 'oktober', 'octobre', 'oct', 'okt'],
  ['november', 'noviembre', 'novembre', 'nov'],
  ['december', 'diciembre', 'dezember', 'décembre', 'decembre', 'dec', 'dic', 'dez'],
];
const MONTH_NUM = dict();
MONTH_NAMES.forEach((names, i) => names.forEach((n) => { MONTH_NUM[fold(n)] = i + 1; }));
const monthNum = (w) => MONTH_NUM[fold(w.toLowerCase().replace(/\./g, ''))];
const MONTH = `(?:${[...new Set(MONTH_NAMES.flat())].sort((a, b) => b.length - a.length).join('|')})\\.?`;
const DAY = '\\d{1,2}(?:st|nd|rd|th)?\\.?'; // German "14." too
const OF = '(?:(?:of|de|del)\\s+)?'; // "3rd of March", "5 de mayo"
const YEAR = '(?:\\d{4}|\\d{2})';
const NUM_P = '(?:\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?)'; // 1,234.56 | 1.234,56 | 12,50
const NUM_S = '(?:(?<!\\d[.,\\u00a0\\u202f ])\\d{1,3}(?:[.,\\u00a0\\u202f ]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?)'; // also 8 400
const SCALE = '(?:\\s?(?:k|m|bn|million|billion)\\b)';
const UNIT = '(?:USD|SGD|GBP|EUR|AUD|CAD|CHF|dollars?|pounds?|euros?|€|per square foot|psf|sq ?ft|%|percent)';
const CUR = 'US\\$|S\\$|A\\$|C\\$|HK\\$|NZ\\$|[$£€¥₹]|USD|SGD|GBP|EUR|AUD|CAD|RMB|CNY|JPY|HKD|CHF|INR';
const PHONE = '(?:\\+\\d{1,3}[\\s.-]?(?:\\(\\d{1,4}\\)[\\s.-]?)?\\d{1,4}(?:[\\s.-]\\d{2,4}){0,3}[\\s.-]\\d{2,8}'
  + '|\\(\\d{2,5}\\)[\\s.-]?\\d{3,4}[\\s.-]?\\d{3,4}'
  + '|00\\d{1,3}[\\s.-]\\d{1,4}(?:[\\s.-]\\d{2,4}){1,3}'
  + '|0\\d{2,4}[\\s.-]\\d{3,7}(?:[\\s.-]\\d{3,4})?'
  + '|\\d{3,4}[\\s.-]\\d{3,4}[\\s.-]\\d{4}'
  + '|[689]\\d{3}[\\s-]\\d{4})';
// Every pattern is anchored with a lookbehind so each scan stays linear on hostile text.
const EXTRACT = {
  dates: new RegExp(`(?<![\\w./-])(?:${DAY}[\\s-]+${OF}${MONTH}[\\s,.-]+(?:de\\s+)?${YEAR}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|${MONTH}\\s+\\d{4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|${DAY}\\s+${OF}${MONTH})(?![\\w/-])`, 'gi'),
  amounts: new RegExp(`(?<![\\w$£€¥]|\\d[.,])-?(?:(?:${CUR})\\s?${NUM_P}${SCALE}?|${NUM_S}${SCALE}?\\s?${UNIT}(?!\\w))`, 'gi'),
  emails: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  links: /(?:https?:\/\/|(?<![\w.])www\.)[^\s<>"']+/gi,
  phones: new RegExp(`(?<![\\w.])${PHONE}(?:[\\s.]?(?:[eE]xt\\.?|[eE]xtension|x)\\s?\\d{1,5})?(?!\\w)`, 'g'),
};
const PROBE = {}; // the same patterns without the g flag, safe to .test() repeatedly
for (const [k, re] of Object.entries(EXTRACT)) PROBE[k] = new RegExp(re.source, re.flags.replace('g', ''));
const daysIn = (y, m) => [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const okDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y || 2000, m) && (!y || (y >= 1900 && y <= 2100)); // y 0 = two-digit year, not checked
// Reject impossible dates (31 Feb 2026, 13/13/2026, 2026-13-45) and describe the rest: noYear, ambiguous (dd/mm or mm/dd), monthYear.
function parseDate(v) {
  let m;
  if ((m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return { ok: okDate(+m[1], +m[2], +m[3]) };
  if ((m = v.match(/^(\d{1,2})([-/.])(\d{1,2})[-/.](\d{2,4})$/))) {
    const y = m[4].length === 4 ? +m[4] : 0, a = +m[1], b = +m[3];
    const dm = okDate(y, b, a), md = okDate(y, a, b);
    return { ok: dm || md, ambiguous: m[2] !== '.' && dm && md && a !== b }; // 12.09.2026 is read as day.month; 03/04/25 could be either
  }
  if ((m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?\.?[\s-]+(?:(?:of|de|del)\s+)?([^\d\s,.-]+)\.?[\s,.-]+(?:de\s+)?(\d{2,4})$/i))) { const mo = monthNum(m[2]); return { ok: !!mo && okDate(m[3].length === 4 ? +m[3] : 0, mo, +m[1]) }; }
  if ((m = v.match(/^([^\d\s,.-]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i))) { const mo = monthNum(m[1]); return { ok: !!mo && okDate(+m[3], mo, +m[2]) }; }
  if ((m = v.match(/^([^\d\s,.-]+)\.?\s+(\d{4})$/i))) { const mo = monthNum(m[1]); return { ok: !!mo && +m[2] >= 1900 && +m[2] <= 2100, monthYear: true }; }
  if ((m = v.match(/^(\d{1,2})(?:st|nd|rd|th)?\.?\s+(?:(?:of|de|del)\s+)?([^\d\s,.-]+)\.?$/i))) { const mo = monthNum(m[2]); return { ok: !!mo && okDate(2000, mo, +m[1]) && m[2] !== 'may', noYear: true }; } // a lowercase "may" after a number is the verb
  return { ok: true };
}
const validDate = (v) => parseDate(v).ok;
const KINDS = [
  ['dates', /\b(dates?|deadlines?)\b/],
  ['amounts', /\b(amounts?|rents?|costs?|prices?|money|fees?|charges?|figures?)\b/],
  ['emails', /\be-?mails?\b/],
  ['links', /\b(links?|urls?|websites?)\b/],
  ['phones', /\b(phones?|telephones?)\b/],
];
const SINGULAR = { dates: 'date', amounts: 'amount', emails: 'email', links: 'link', phones: 'phone number' };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FOLLOW_UP = /\b(it|its|that|this|they|them|their|those|these|also|more|else|same|there|then|and|about)\b/i;
const KIND_WHOLE = KINDS.map(([, re]) => new RegExp(`^(?:${re.source})$`));
const QUALIFIER = /\d|\b(?:over|under|above|below|more|less|greater|fewer|after|before|since|until|between|larger|smaller|bigger|higher|lower|than)\b/;
const DETERMINERS = /^(?:(?:all|the|my|every|any|some|each|of|me|please)\s+)+/;
const SCOPE_FILLER = /\b(?:documents?|docs?|files?|notes?|items?|stuff|things?|folders?)\b/g;
// "extract ...", or the gentler "list / show / find / get / give me / what are ..." when what follows is plainly a kind ("list all the dates in my lease documents").
function parseExtract(q, categories) {
  const m = q.match(/^\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(extract|list|show|find|get|give|what\s+are)\b(?:\s+me\b)?(.*)$/i);
  if (!m) return null;
  const strict = m[1].toLowerCase() !== 'extract'; // these verbs also start ordinary questions, so only a clear "<verb> <kind>" counts
  let rest = m[2].toLowerCase().replace(/\s+/g, ' ').trim(); // collapsing whitespace keeps the scope regex below linear
  let category, unknownScope, ambiguous, qualifier;
  const scope = rest.match(/\b(?:from|in|within)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:category|room))?\s*[?.!]*$/); // a category counts only after "from" / "in"
  if (scope) {
    const plain = scope[1].replace(/["“”']/g, '').replace(/\s+please$/, '').trim();
    const asked = plain.replace(/^(?:(?:all|the|my|every|any)\s+)+/, '').replace(SCOPE_FILLER, ' ').replace(/\s+/g, ' ').trim(); // "the lease documents" means the lease category
    const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const lookup = (name) => {
      const ws = [...words(name)];
      // exact name first, then a category containing every word asked as a whole word ("from lease" finds "Lease & Rent", but never "all" in "Small Talk")
      const exact = categories.find((c) => c.toLowerCase() === name);
      if (exact) return exact;
      const subset = ws.length ? categories.filter((c) => { const w = words(c); return ws.every((a) => w.has(a)); }) : [];
      if (subset.length > 1) ambiguous = subset; // several rooms fit: say so rather than pick the first one
      return subset[0];
    };
    const found = (asked && lookup(asked)) || lookup(plain);
    if (found) { category = found; rest = rest.slice(0, scope.index); }
    else if (!asked) rest = rest.slice(0, scope.index); // "in my documents" names no category
    else if (/^\d/.test(asked)) qualifier = scope[0].trim(); // "in 2026" or "over 1000" style filters are not supported
    else if (!KINDS.some(([, re]) => re.test(asked))) unknownScope = asked;
  }
  const hits = KINDS.map(([k, re]) => [k, rest.search(re)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  const kinds = hits.map(([k]) => k);
  if (ambiguous && !category) return { kind: undefined, kinds: [], extraKinds: false, ambiguous };
  // "what are the amounts over 1000" is a question, so only the list-style verbs and "extract" are told about unsupported filters
  const qualified = (qualifier || QUALIFIER.test(rest)) && !(strict && /^what\s+are$/i.test(m[1]));
  if (qualified && (hits.length || qualifier)) return { kind: kinds[0], kinds, extraKinds: false, qualifier: qualifier || rest.trim() };
  const parts = rest.replace(/[?.!]+$/, '').trim().split(/\s*(?:,|&|\band\b)\s*/);
  const plainKinds = parts.every((p) => { p = p.replace(DETERMINERS, '').replace(/\s+(?:numbers?|addresses|address)$/, '').trim(); return KIND_WHOLE.some((re) => re.test(p)); });
  if (strict && (unknownScope || !hits.length || !plainKinds)) return null;
  if (!strict && hits.length && !plainKinds) return { kind: undefined, kinds: [], extraKinds: false }; // "extract the cost of …" is a question, not a table
  return { kind: kinds[0], kinds, extraKinds: hits.length > 1, category, unknownScope: hits.length ? unknownScope : undefined };
}

// ---- answer selection ----
const TIME_RE = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;
const NAME_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/;
// What kind of fact the question wants, as tests a sentence can pass: amounts for "how much", dates for "when", and so on.
function wantedFacts(q) {
  const s = q.toLowerCase(), want = [];
  if (/\b(how much|costs?|prices?|fees?|premium|charges?)\b/.test(s)) want.push((x) => PROBE.amounts.test(x));
  if (/\b(when|what date|what day|deadline|due)\b/.test(s)) want.push((x) => PROBE.dates.test(x));
  if (/\b(how many|what time|how long|what number)\b/.test(s)) want.push((x) => /\d/.test(x) || TIME_RE.test(x));
  if (/\b(who|e-?mail|contact)\b/.test(s)) want.push((x) => PROBE.emails.test(x) || NAME_RE.test(x));
  if (/\b(phone|call|telephone)\b/.test(s)) want.push((x) => PROBE.phones.test(x));
  return want;
}
const simplePlan = (q) => ({ text: q, typeQ: q, groups: [...new Set(tokenize(q))].map((t) => ({ t, w: 1, alts: [] })) });

// Pick the best sentence from each source and lead with the strongest. Headings, title echoes and tiny lines are skipped; query words that are
// also in the source title count less; weights (3x for the current question in a follow-up), synonyms and the kind of fact asked for all adjust the score.
function extractive(plan, sources, df, N) {
  if (typeof plan === 'string') plan = simplePlan(plan);
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const mass = plan.groups.reduce((a, g) => a + g.w * idf(g.t), 0);
  const want = wantedFacts(plan.typeQ);
  const picked = sources.map((s) => {
    const lines = s.text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const headings = lines.filter((x) => /^#{1,6}\s/.test(x));
    const titleToks = new Set([...tokenize(String(s.title).replace(/\.[a-z0-9]{1,8}$/i, '')), ...headings.flatMap((h) => tokenize(h))]);
    const sents = [];
    lines.forEach((line) => { if (!/^#{1,6}\s/.test(line)) line.split(/(?<=[.!?])\s+/).forEach((x) => { if (x.trim()) sents.push(x.trim()); }); });
    const words = (x) => (x.match(/[\p{L}\p{N}]+/gu) || []).length;
    const titleLike = (x) => { const t = tokenize(x); return t.length > 0 && t.every((w) => titleToks.has(w)); };
    let pool = sents.filter((x) => words(x) >= 4 && !titleLike(x));
    if (!pool.length) pool = sents.filter((x) => !titleLike(x));
    if (!pool.length) pool = sents;
    let best = null;
    pool.forEach((x, pos) => {
      const have = new Set(tokenize(x));
      let k = 0, raw = 0;
      for (const g of plan.groups) {
        let c = 0, r = 0;
        if (have.has(g.t)) { r = g.w * idf(g.t); c = r * (titleToks.has(g.t) ? 0.4 : 1); }
        else for (const [a, f] of g.alts) if (have.has(a) && g.w * f * idf(a) > c) { c = g.w * f * idf(a); r = c; }
        k += c; raw += r;
      }
      if (k > 0 && want.some((w) => w(x))) k += 0.5 * mass;
      if (!best || k > best.k + 1e-9 || (Math.abs(k - best.k) <= 1e-9 && raw > best.raw + 1e-9)) best = { x, k, raw, pos };
    });
    return { n: s.n, k: best ? best.k : 0, line: best ? best.x : s.text };
  });
  const useful = picked.filter((p) => p.k > 0); // a passage sharing no word with the question is not an answer
  return useful.sort((a, b) => b.k - a.k || a.n - b.n).slice(0, 3)
    .map((p) => `${p.line.length > 300 ? p.line.slice(0, 300) + '…' : p.line} [${p.n}]`).join('\n');
}

const llmMod = require('./llm');
const workflow = require('./workflow');
const docs = require('./docs');
const embedMod = require('./embed');

function createApp(dataDir, opts = {}) {
  const FILES = path.join(dataDir, 'files');
  const DBF = path.join(dataDir, 'items.json');
  const PUB = path.join(__dirname, 'public');
  fs.mkdirSync(FILES, { recursive: true });

  let items = [];
  let hadDb = false;
  let repaired = 0;
  let orphaned = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(DBF, 'utf8'));
    hadDb = true;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the file is not a PAC&RAG library (expected an object with an "items" list)');
    const stored = parsed.items;
    if (!Array.isArray(stored)) throw new Error('"items" is not a list');
    const repairs = stored.map(workflow.repair);
    items = repairs.filter(Boolean).map(sanitiseStored);
    if (stored.length && !items.length) throw new Error('none of its records have the expected shape');
    const changed = stored.filter((raw, n) => repairs[n] && JSON.stringify(raw) !== JSON.stringify(repairs[n])).length;
    repaired = changed + stored.length - items.length;
    if (repaired) {
      const bak = `${DBF}.${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.bak`;
      fs.copyFileSync(DBF, bak); // the next save writes the repaired records over items.json, so the original is kept first, every time
      console.error(`Repaired or dropped ${repaired} record(s) in ${DBF}. The original is kept as ${bak}.`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${DBF} (${e.message}). Fix or move it; it was not overwritten.`);
  }
  // Files with no record (a crash between writing the file and saving the record) are set aside, never deleted.
  // Only done when a database exists, so a missing items.json can never cause the files to be moved.
  if (hadDb) {
    const known = new Set(items.map((i) => i.fileName).filter(Boolean));
    const strays = fs.readdirSync(FILES).filter((f) => !known.has(f) && fs.statSync(path.join(FILES, f)).isFile());
    orphaned = strays.length;
    if (strays.length) {
      const dest = path.join(dataDir, 'orphans');
      fs.mkdirSync(dest, { recursive: true });
      strays.forEach((f) => fs.renameSync(path.join(FILES, f), path.join(dest, f)));
      console.error(`Moved ${strays.length} file(s) with no library record to ${dest}.`);
    }
  }
  // ---- written answers: llama.cpp / OpenAI-compatible / Anthropic, chosen in the app and stored in settings.json ----
  const llmStore = llmMod.createStore(dataDir);
  let settings = 'llm' in opts ? llmMod.normalise(opts.llm) : llmStore.exists() ? llmStore.get() : llmMod.fromEnv();
  let llm = null;
  let answerer = null;
  const forced = 'answerer' in opts;
  const localOnly = () => LOCAL_ONLY();
  const applySettings = (s) => {
    settings = s;
    llm = localOnly() ? null : llmMod.createLlm(s, { fetchImpl: opts.llmFetch, timeoutMs: opts.llmTimeoutMs });
    answerer = forced ? opts.answerer : llm ? llm.answer : null;
  };
  applySettings(settings);
  const llmState = () => ({ active: forced ? 'custom' : llm ? llm.provider : 'local', remote: !!(llm && llm.remote) });

  // Write a temp file then rename it over items.json. Windows can refuse the rename briefly (antivirus, indexers), so retry a few times.
  const save = () => {
    const tmp = DBF + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ items }));
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(tmp, DBF); break; } catch (e) {
          if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          sleepMs(50);
        }
      }
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw saveError(e);
    }
  };

  const sem = embedMod.createSemantic({
    dataDir, embedder: 'embedder' in opts ? opts.embedder : embedMod.fromEnv(), queryTimeoutMs: opts.embedQueryTimeoutMs,
    getTexts: () => items.flatMap((i) => i.chunks),
  });
  sem.kick(); // background; never blocks startup

  // ---- BM25 index, rebuilt lazily after any change ----
  let idx = null;
  const getIdx = () => {
    if (idx) return idx;
    const chunks = [];
    const df = new Map();
    for (const it of items) {
      it.chunks.forEach((text, n) => {
        const toks = tokenize(`${it.title} ${text}`);
        const tf = new Map();
        toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
        tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
        chunks.push({ it, n, text, tf, len: toks.length });
      });
    }
    idx = { chunks, df, avg: chunks.reduce((s, c) => s + c.len, 0) / (chunks.length || 1) };
    return idx;
  };
  // ---- query plan: weighted terms, query-only synonyms, typo fallbacks and "without X" ----
  const SYN = new Map();
  [['degree', 'msc', 'bsc', 'diploma'], ['salary', 'pay', 'wage'], ['depart', 'leave', 'departure'], ['leave', 'holiday', 'vacation'], ['cost', 'price', 'fee', 'charge'],
    ['buy', 'purchase'], ['car', 'vehicle'], ['phone', 'telephone', 'mobile'], ['doctor', 'physician'], ['job', 'employment', 'position']].forEach((set) => {
    const terms = set.map((w) => tokenize(w)[0]).filter(Boolean);
    terms.forEach((t) => { const o = SYN.get(t) || new Set(); terms.forEach((x) => { if (x !== t) o.add(x); }); SYN.set(t, o); });
  });
  // Words that name the kind of fact asked for rather than the topic; when the library lacks them the question can still be answered ("deadline for the break notice").
  const SOFT = new Set(['deadline', 'date', 'due', 'cost', 'price', 'fee', 'amount', 'time', 'total', 'phone', 'telephone', 'call', 'email', 'contact'].map((w) => tokenize(w)[0]).filter(Boolean));
  const withinOne = (a, b) => { // edit distance of at most one (insert, delete or substitute)
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
  };
  const QUERY_FILLER = new Set(['find', 'list', 'show', 'extract', 'tell', 'give', 'get', 'please']); // request verbs say nothing about the topic
  // With prev (a follow-up borrowing the last question) the current question's words weigh 3x.
  function buildPlan(q, prev) {
    const { df } = getIdx();
    const neg = new Set();
    for (const m of fold(`${prev || ''} ${q}`.toLowerCase()).matchAll(/\b(?:without|no|excluding|except)\s+(?:an?\s+|the\s+|any\s+)?([a-z0-9]+)/g)) tokenize(m[1]).forEach((t) => neg.add(t));
    const weights = new Map();
    if (prev) tokenize(prev).forEach((t) => weights.set(t, 1));
    tokenize(q).filter((t) => !QUERY_FILLER.has(t)).forEach((t) => weights.set(t, prev ? 3 : 1));
    for (const t of neg) if (weights.size > 1) weights.delete(t);
    const groups = [...weights].map(([t, w]) => {
      const alts = [...(SYN.get(t) || [])].filter((s) => df.has(s)).map((s) => [s, 0.5]);
      if (!df.has(t) && /^[a-z]{4,}$/.test(t)) {
        [...df.keys()].filter((v) => /^[a-z]+$/.test(v) && withinOne(t, v)).sort((a, b) => df.get(b) - df.get(a)).slice(0, 3).forEach((v) => alts.push([v, 0.7]));
      }
      return { t, w, alts };
    });
    return { text: q, typeQ: q, groups, neg, prev: !!prev };
  }
  // Returns the best chunks. The array also carries (non-enumerable) `info` about the top chunk: how many query words and how much of their weight it matched.
  function search(q, k = 5) {
    const { chunks, df, avg } = getIdx();
    const plan = typeof q === 'string' ? buildPlan(q) : q;
    if (!plan.groups.length) return [];
    const N = chunks.length, K1 = 1.5, B = 0.75;
    const idfOf = (t) => { const d = df.get(t) || 0; return Math.log(1 + (N - d + 0.5) / (d + 0.5)); };
    const gs = plan.groups.map((g) => ({ ...g, all: [[g.t, 1], ...g.alts], idf: idfOf(g.t) }));
    const mass = gs.reduce((a, g) => a + g.w * g.idf, 0);
    const present = gs.filter((g) => df.has(g.t)).length;
    const hits = [];
    for (const c of chunks) {
      let s = 0, matched = 0, got = 0, skipped = 0, skippedMass = 0;
      const seen = [];
      for (const g of gs) {
        let best = 0, hit = false;
        for (const [t, f] of g.all) {
          const tf = c.tf.get(t);
          if (!tf) continue;
          hit = true;
          const v = g.w * f * idfOf(t) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * c.len / avg));
          if (v > best) best = v;
        }
        if (hit) { matched++; got += g.w * g.idf; seen.push(g.t); }
        else if (SOFT.has(g.t)) { skipped++; skippedMass += g.w * g.idf; }
        s += best;
      }
      if (s <= 0) continue;
      if (plan.neg.size && [...plan.neg].some((t) => c.tf.has(t))) s *= 0.25; // "without eggs" demotes passages that mention eggs
      hits.push({ c, s, matched, coverage: mass - skippedMass > 0 ? got / (mass - skippedMass) : 1, seen, skipped });
    }
    hits.sort((a, b) => b.s - a.s);
    const top = hits[0];
    const out = hits.filter((x, i) => i === 0 || (x.s >= top.s * 0.5 && (gs.length < 2 || x.coverage >= 0.5))).slice(0, k) // drop weak tail matches
      .map(({ c, s }, i) => ({ n: i + 1, itemId: c.it.id, title: c.it.title, category: c.it.category, text: c.text, score: +s.toFixed(3) }));
    if (top) Object.defineProperty(out, 'info', { value: { matched: top.matched, coverage: top.coverage, present, groups: gs.length - top.skipped, seen: top.seen, missing: gs.map((g) => g.t).filter((t) => !top.seen.includes(t) && !SOFT.has(t)), title: top.c.it.title } });
    return out;
  }

  // ---- optional semantic retrieval (embed.js): BM25 + vector ranks fused by RRF; exactly BM25 when off or unavailable ----
  async function searchHybrid(q, k = 5) {
    if (!sem.enabled) return search(q, k);
    const qs = typeof q === 'string' ? q : q.text;
    const bm = search(q, 30);
    const { chunks } = getIdx();
    const vec = await sem.rank(qs, chunks.map((c) => c.text), 30);
    if (!vec || !vec.length) return search(q, k);
    const live = new Set(items.map((i) => i.id)); // an item deleted while the embedding ran must not be cited
    const key = (itemId, text) => `${itemId}\0${text}`;
    const bmLive = bm.filter((s) => live.has(s.itemId));
    const bmKeys = new Set(bm.map((s) => key(s.itemId, s.text)));
    const byKey = new Map();
    bmLive.forEach((s) => byKey.set(key(s.itemId, s.text), s));
    // A passage found only by meaning must rank near the top to be used at all.
    const vecKeys = vec.filter((i, r) => live.has(chunks[i].it.id) && (r < 3 || bmKeys.has(key(chunks[i].it.id, chunks[i].text)))).map((i) => { const c = chunks[i]; const kk = key(c.it.id, c.text); if (!byKey.has(kk)) byKey.set(kk, { itemId: c.it.id, title: c.it.title, category: c.it.category, text: c.text }); return kk; });
    const fused = embedMod.rrf([bmLive.map((s) => key(s.itemId, s.text)), vecKeys]).slice(0, k)
      .map(({ key: kk, score }, i) => ({ ...byKey.get(kk), n: i + 1, score: +(score * 100).toFixed(3) }));
    if (bm.info) fused.info = bm.info; // the weak-match guard and the history retry read it; without it hybrid mode answered anything
    return fused;
  }

  // ---- categorizer: cosine similarity between an item's key terms and each category's centroid ----
  const termsOf = (text) => {
    const tf = new Map();
    tokenize(text.slice(0, 20000)).forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    const o = dict();
    for (const [t, x] of [...tf].map(([t, f]) => [t, 1 + Math.log(f)]).sort((a, b) => b[1] - a[1]).slice(0, 40)) o[t] = x;
    return o;
  };
  // Stored records come from a file the user may have edited: keep only finite numbers, in a prototype-free table.
  function sanitiseStored(it) {
    if (it.terms !== undefined) {
      if (it.terms && typeof it.terms === 'object' && !Array.isArray(it.terms)) {
        const o = dict();
        for (const [t, x] of Object.entries(it.terms)) if (typeof x === 'number' && Number.isFinite(x) && x > 0) o[t] = x;
        it.terms = o;
      } else delete it.terms;
    }
    if (typeof it.fileName !== 'string' || !/^[\w.-]+$/.test(it.fileName)) delete it.fileName;
    it.autoRoom = it.autoRoom === true; // records from before this flag existed are never renamed automatically
    return it;
  }
  const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (const [t, x] of Object.entries(a)) { na += x * x; if (b[t]) dot += x * b[t]; }
    for (const x of Object.values(b)) nb += x * x;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };
  const surface = (text, term) => { // the word as written, so "analysis" is not named "Analysi"
    for (const w of text.toLowerCase().match(/\p{L}+/gu) || []) if (!STOP.has(fold(w)) && stem(fold(w)) === term) return w;
    return term;
  };
  // Words that say nothing about a topic: markup, link boilerplate and generic filler.
  const GENERIC = new Set('http https www com org net html url title minutes minute day days item items name names note notes text file files document documents doc page pages untitled new one two three data info list example sample thing things use used using time date week year years'.split(' '));
  // Name a room after its most distinctive terms, preferring words that are in the title/file names and skipping generic ones; a weak second term is dropped.
  const nameFrom = (v, text, label = '') => {
    const inLabel = new Set(tokenize(label));
    const ranked = Object.entries(v).filter(([t]) => /^\p{L}{3,}$/u.test(t) && !GENERIC.has(t)).map(([t, x]) => [t, x * (inLabel.has(t) ? 1.6 : 1)]).sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (ranked.length === 2 && ranked[1][1] < ranked[0][1] * 0.6) ranked.pop();
    return nfc(ranked.map(([t]) => { const s = surface(text.slice(0, 20000), t); return s[0].toUpperCase() + s.slice(1); }).join(' & ') || 'Misc'); // capped below
  };
  // tf-idf vectors over the library's key terms
  const vectorizer = () => {
    const others = items.filter((i) => i.terms);
    const N = others.length;
    const df = dict();
    others.forEach((i) => Object.keys(i.terms).forEach((t) => { df[t] = (df[t] || 0) + 1; }));
    return { others, vec: (m) => { const o = dict(); for (const [t, x] of Object.entries(m)) o[t] = x * Math.log(1 + (N + 1) / ((df[t] || 0) + 1)); return o; } };
  };
  const LOW_CONF = 0.2; // an item filed with less confidence than this teaches the categorizer less, even once the user has pressed Keep
  function categorize(terms, text, label = '') {
    const { others, vec } = vectorizer();
    const vecs = new Map(others.map((i) => [i, vec(i.terms)]));
    const cents = new Map(), nearest = new Map();
    const v = vec(terms);
    for (const i of others) {
      if (!cents.has(i.category)) cents.set(i.category, dict());
      const c = cents.get(i.category);
      const weak = i.confidence < LOW_CONF;
      for (const [t, x] of Object.entries(vecs.get(i))) c[t] = (c[t] || 0) + x * (weak ? 0.3 : 1);
      if (!weak) nearest.set(i.category, Math.max(nearest.get(i.category) || 0, cosine(v, vecs.get(i)))); // short related notes match one member, not the average
    }
    let best = null, sim = 0;
    for (const [cat, c] of cents) { const s = Math.max(cosine(v, c), 0.9 * (nearest.get(cat) || 0)); if (s > sim) { sim = s; best = cat; } }
    if (best && sim >= SAME) return { category: best, confidence: sim, needsReview: false, autoRoom: true };
    if (best && sim >= MAYBE) return { category: best, confidence: sim, needsReview: true, autoRoom: true };
    return { category: nameFrom(v, text, label), confidence: 1, needsReview: false, autoRoom: true };
  }
  // Once an automatically named room reaches three members its name is recomputed from all of them, unless someone has put an item there by hand.
  function renameRoom(it) {
    const room = items.filter((i) => i.category === it.category);
    if (room.length !== 3 || !room.every((i) => i.autoRoom === true && i.terms)) return null;
    const { vec } = vectorizer();
    const sum = dict();
    room.forEach((i) => { for (const [t, x] of Object.entries(vec(i.terms))) sum[t] = (sum[t] || 0) + x * (i.confidence < LOW_CONF ? 0.3 : 1); });
    const label = room.map((i) => (i.type === 'file' ? i.title.replace(/\.[a-z0-9]{1,8}$/i, '') : i.title)).join(' ');
    const name = cpSlice(nameFrom(sum, `${label} ${room.map((i) => i.chunks[0] || '').join(' ')}`, label), 40);
    if (!name || name === it.category || items.some((i) => i.category.toLowerCase() === name.toLowerCase())) return null;
    return { room, was: room.map((i) => i.category), name };
  }

  function addItem({ id = crypto.randomUUID(), type, title, text = '', source, requested, fileName, mime, size }) {
    let truncated = false;
    if (text.length > MAX_TEXT) { text = text.slice(0, highSurrogate(text.charCodeAt(MAX_TEXT - 1)) ? MAX_TEXT - 1 : MAX_TEXT); truncated = true; }
    const reason = isBlank(text) ? 'no-text' : tokenize(text).length ? undefined : 'no-words'; // no-words: text with no index terms ("I a") is kept unread, never searchable
    const noText = reason !== undefined;
    const cleanTitle = nfc(title || '').trim();
    const it = {
      id, type, source, requested, fileName, mime, size, added: Date.now(), noText, reason, truncated, needsReview: false, confidence: 1,
      title: (type === 'file' ? keepExt(cleanTitle, 120) : cpSlice(cleanTitle, 120)).trim() || nfc(cpSlice(text.trim().split(/\n/)[0], 60)) || 'Untitled',
      chunks: noText ? [] : chunk(text),
    };
    if (noText) it.category = canonical(mime && mime.startsWith('image/') ? 'Images' : 'Unread files');
    else {
      const label = it.type === 'file' ? it.title.replace(/\.[a-z0-9]{1,8}$/i, '') : it.title; // "notes.txt" must not teach the categorizer the word "txt"
      it.terms = termsOf(`${label} ${text}`);
      Object.assign(it, categorize(it.terms, `${label} ${text}`, label));
      it.category = cpSlice(it.category, 40);
      const same = items.find((i) => i.category.toLowerCase() === it.category.toLowerCase());
      if (same) it.category = same.category; // an auto-named room never duplicates one the user already spelled differently
    }
    items.push(it);
    const ren = it.terms ? renameRoom(it) : null;
    if (ren) ren.room.forEach((i) => { i.category = ren.name; });
    idx = null;
    try { save(); } catch (e) { items.pop(); if (ren) ren.room.forEach((i, n) => { i.category = ren.was[n]; }); throw e; } // memory must never get ahead of disk
    sem.kick();
    return it;
  }

  const view = (it) => ({
    id: it.id, type: it.type, title: it.title, category: it.category, needsReview: it.needsReview, confidence: +it.confidence.toFixed(2),
    source: it.source, fileName: it.fileName, mime: it.mime, size: it.size, added: it.added, noText: it.noText, reason: it.noText ? it.reason || 'no-text' : undefined, truncated: it.truncated,
    chunks: it.chunks.length, preview: (it.chunks[0] || '').slice(0, 160),
    state: workflow.stateOf(it), actions: workflow.allowedEvents(it),
  });
  // Reuse the spelling of an existing category, so "dinner" and "Dinner" never become two rooms.
  const canonical = (name, self) => {
    const c = workflow.cleanCategory(name); // the single definition of a valid name; throws 400
    const k = c.toLowerCase();
    const hit = items.find((i) => i !== self && i.category.toLowerCase() === k);
    return hit ? hit.category : c;
  };
  const categoryNames = () => [...new Set(items.map((i) => i.category))];

  function extractRows(kind, category) {
    const re = EXTRACT[kind];
    const rows = [], seen = new Set();
    const IBANISH = /\b(?:IBAN|ISBN(?:-1[03])?)\b[:#\s-]*(?:[A-Za-z0-9-]{1,5} )*$|\b[A-Z]{2}\d{2} (?:[A-Z0-9]{2,4} )*$/; // text that ends in the start of an IBAN or after an IBAN/ISBN label
    for (const it of items) {
      if (category && it.category !== category) continue;
      const text = it.chunks.join('\n\n').normalize('NFC');
      const cands = [];
      if (kind === 'links' && it.type === 'url' && /^https?:\/\//i.test(it.source || '')) cands.push({ value: it.source, start: -1, end: -1, context: `Link added as “${it.title}”` });
      for (const m of text.matchAll(re)) {
        let value = m[0].trim();
        if (kind === 'links') {
          if (value.length > 2048) continue; // not a real link, and the clean-up below is quadratic on absurd lengths
          value = value.replace(/[.,;:!?'"\]}]+$/, '');
          while (value.endsWith(')') && (value.match(/\(/g) || []).length < (value.match(/\)/g) || []).length) value = value.slice(0, -1);
        } else value = value.replace(/[.,;:]+$/, '');
        const end = m.index + m[0].length;
        let note;
        if (kind === 'dates') {
          const d = parseDate(value);
          if (!d.ok) continue;
          if (d.noYear) note = 'no year';
          else if (d.ambiguous) note = 'ambiguous: dd/mm or mm/dd';
        }
        if (kind === 'phones') {
          const d = value.replace(/\s?(?:ext\.?|extension|x)\s?\d{1,5}$/i, '').replace(/\D/g, '').length;
          if (d < 8 || d > 15 || /^[689]\d{3}[\s-](19|20)\d{2}$/.test(value)) continue; // "8000 2025" is a number and a year
          if (IBANISH.test(text.slice(Math.max(0, m.index - 60), m.index))) continue; // bank and book numbers are not phones
        }
        cands.push({ value, start: m.index, end, raw: m[0], note });
      }
      const keep = kind !== 'dates' ? cands : cands.filter((c) => { // "June 2027" next to "30 June 2027" in the same sentence is the same date, not a second one
        if (!parseDate(c.value).monthYear) return true;
        const v = c.value.toLowerCase();
        return !cands.some((o) => o !== c && o.value.length > c.value.length && o.value.toLowerCase().includes(v) && !/[.!?]\s/.test(text.slice(Math.min(c.end, o.end), Math.max(c.start, o.start))));
      });
      for (const c of keep) {
        const key = `${it.id}|${c.value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let context = c.context;
        if (context === undefined) {
          const cutL = c.start > 50, cutR = c.end + 50 < text.length; // trim the padding back to whole words
          const lead = text.slice(Math.max(0, c.start - 50), c.start), tail = text.slice(c.end, c.end + 50);
          context = `${cutL ? '…' : ''}${(cutL ? lead.replace(/^\S*\s/, '') : lead) + c.raw + (cutR ? tail.replace(/\s\S*$/, '') : tail)}${cutR ? '…' : ''}`.replace(/\s+/g, ' ').trim();
        }
        if (c.note) context += ` [${c.note}]`; // the page table has no spare column, so the flag rides in the context (and the CSV)
        rows.push({ value: c.value, itemId: it.id, title: it.title, category: it.category, context, ...(c.note && { note: c.note }) });
        if (rows.length > 500) return rows;
      }
    }
    return rows;
  }

  // A link as typed, checked before any request. The #fragment is dropped: the same page with another fragment is the same link.
  function linkUrl(raw) {
    let url;
    // "example.com/page" has no scheme: if it looks like a hostname, try https://
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|localhost)(?::\d+)?(?:[/?#]|$)/i.test(raw)) raw = `https://${raw}`;
    try { url = new URL(raw); } catch { throw httpError(400, 'That is not a valid link.'); }
    if (!/^https?:$/.test(url.protocol)) throw httpError(400, 'Only http and https links are supported.');
    if (url.username || url.password) throw httpError(400, 'Links that contain a username or password are not supported. Remove the credentials and try again.');
    url.hash = '';
    return url;
  }
  // Returns the page text. source is the final address after any redirects, without a fragment.
  async function fetchPage(url) {
    const failed = (e) => (e.name === 'TimeoutError' || e.name === 'AbortError'
      ? httpError(504, 'That page took too long to answer.')
      : /credentials|cross origin not allowed/i.test(`${e.message} ${e.cause && e.cause.message}`) ? httpError(502, 'That link redirects to an address with a username or password, which is not supported.')
      : httpError(502, `Could not fetch that page (${String((e.cause && (e.cause.code || e.cause.message)) || e.message).replace(/\/\/[^/@\s]+@/g, '//')}).`)); // never echo user:pass@
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'pac-rag/0.1 (local knowledge base)' } }); }
    catch (e) { throw failed(e); }
    let final = url;
    try { final = new URL(r.url); final.hash = ''; if (final.username || final.password) throw 0; } catch (e) { if (e === 0) throw httpError(502, 'That link redirects to an address with a username or password, which is not supported.'); }
    if (!r.ok) throw httpError(502, `That page answered ${r.status}.`);
    const type = r.headers.get('content-type') || '';
    if (!/text\/|html|xml|json/i.test(type)) throw httpError(415, `Links to ${type.split(';')[0] || 'unknown'} content are not supported. Download the file and drop it in instead.`);
    const parts = [];
    let got = 0;
    try { // stream with a running cap so a huge or endless page cannot fill memory (the byte count is after decompression)
      for await (const c of r.body) {
        got += c.length;
        if (got > MAX_UPLOAD) throw httpError(413, 'That page is too large.');
        parts.push(c);
      }
    } catch (e) { throw e.status ? e : failed(e); }
    const raw8 = Buffer.concat(parts);
    if (raw8.subarray(0, 4096).includes(0) && !hasUtf16Bom(raw8)) throw httpError(415, 'That link looks like binary data, not text.');
    const body = decodeBuf(raw8, (type.match(/charset=["']?([\w-]+)/i) || [])[1]);
    const isHtml = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body);
    const { title, text } = isHtml ? htmlToText(body) : { title: '', text: body };
    return { title: title || `${final.hostname}${final.pathname === '/' ? '' : final.pathname}`, text, source: final.href };
  }

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(httpError(413, 'That is too large.')); // refuse before buffering anything
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= limit) parts.push(c); });
    req.on('end', () => (n > limit ? reject(httpError(413, 'That is too large.')) : resolve(Buffer.concat(parts))));
    req.on('error', () => reject(httpError(400, 'The upload was interrupted.')));
  });
  const readJson = async (req, limit) => {
    let body;
    try { body = JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); }
    catch (e) { if (e.status) throw e; throw httpError(400, 'Invalid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'The request body must be a JSON object.');
    return body;
  };

  async function route(req, res) {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) throw httpError(403, 'Unexpected host.');
    if (typeof req.url !== 'string' || !/^\/(?!\/)/.test(req.url)) throw httpError(400, 'Bad request path.');
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { throw httpError(400, 'Bad request path.'); }
    const p = u.pathname;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD' && req.headers['x-pacrag'] !== '1') throw httpError(403, 'Missing request header.');
    let m;

    if (method === 'GET' && p === '/api/status') {
      const counts = new Map();
      items.forEach((i) => { counts.set(i.category, (counts.get(i.category) || 0) + 1); });
      return json(res, 200, {
        items: items.length, chunks: items.reduce((s, i) => s + i.chunks.length, 0), repaired, orphaned,
        categories: [...counts].map(([name, count]) => ({ name, count })), llm: llmState().active, llmConfigured: llmState().active !== 'local', llmRemote: llmState().remote, llmModel: llm ? llm.model : '', ...sem.status(),
        ...(localOnly() && settings.provider !== 'none' && { llmNote: 'PACRAG_LOCAL_ONLY is set, so the saved AI model is not used.' }),
      });
    }
    if (p === '/api/llm' || p === '/api/llm/test') {
      const view = () => llmMod.publicView(settings, { ...llmState(), localOnly: localOnly() });
      if (method === 'GET' && p === '/api/llm') return json(res, 200, view());
      if (method === 'PUT' && p === '/api/llm') {
        let next;
        try { next = llmMod.normalise(await readJson(req, 16 * 1024), settings); } catch (e) { throw e.status ? e : httpError(400, e.message); }
        llmStore.save(next);
        applySettings(next);
        return json(res, 200, view());
      }
      if (method === 'POST' && p === '/api/llm/test') {
        let cand;
        try { cand = llmMod.normalise(await readJson(req, 16 * 1024), settings); } catch (e) { throw e.status ? e : httpError(400, e.message); }
        if (cand.provider === 'none') throw httpError(400, 'Choose a provider first.');
        if (localOnly()) throw httpError(409, 'PACRAG_LOCAL_ONLY is set, so no AI model will be contacted, not even to test.');
        const t0 = Date.now();
        try { await llmMod.createLlm(cand, { fetchImpl: opts.llmFetch, timeoutMs: 30000 }).test(); return json(res, 200, { ok: true, ms: Date.now() - t0 }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }
      throw httpError(405, 'Method not allowed.');
    }
    if (method === 'GET' && p === '/api/version') return json(res, 200, { version: VERSION, node: process.version, dataDir: path.resolve(dataDir) });
    if (method === 'GET' && p === '/api/items') return json(res, 200, { items: items.map(view).sort((a, b) => b.added - a.added) });
    if (method === 'GET' && (m = p.match(/^\/api\/items\/([\w-]+)$/))) {
      const it = items.find((i) => i.id === m[1]);
      if (!it) throw httpError(404, 'No such item.');
      return json(res, 200, { ...view(it), text: it.chunks.join('\n\n') });
    }
    if (method === 'POST' && p === '/api/items') {
      const b = await readJson(req, 6 * MAX_NOTE + 1024); // a control character is 6 bytes in JSON (\u0001), so the byte check below is the real note limit
      if (b.type === 'note') {
        if (typeof b.text !== 'string' || isBlank(b.text)) throw httpError(400, 'The note is empty.');
        if (Buffer.byteLength(b.text) > MAX_NOTE) throw httpError(413, 'That note is too large.');
        if (b.title !== undefined && typeof b.title !== 'string') throw httpError(400, 'The title must be text.');
        const flat = (s) => nfc(s).toLowerCase().replace(/\s+/g, ' ').trim();
        const same = items.find((i) => i.type === 'note' && flat(i.chunks.join(' ')) === flat(b.text));
        if (same) throw httpError(409, `You already added that note (“${same.title}”).`);
        return json(res, 201, view(addItem({ type: 'note', text: b.text, title: typeof b.title === 'string' ? b.title : undefined })));
      }
      if (b.type === 'url') {
        if (typeof b.url !== 'string') throw httpError(400, 'Missing link.');
        const link = linkUrl(b.url.trim());
        const dupOf = (href) => items.find((i) => i.type === 'url' && (i.source === href || i.requested === href));
        const before = dupOf(link.href); // checked before fetching, so a link already in the library costs no request
        if (before) throw httpError(409, `That link is already in the belly (“${before.title}”).`);
        const page = await fetchPage(link);
        const dup = dupOf(page.source); // the final address after redirects
        if (dup) throw httpError(409, `That link is already in the belly (“${dup.title}”).`);
        if (isBlank(page.text)) throw httpError(422, 'That page had no readable text.');
        return json(res, 201, view(addItem({ type: 'url', ...page, requested: link.href })));
      }
      throw httpError(400, 'Unknown item type.');
    }
    if (method === 'POST' && p === '/api/upload') {
      const name = keepExt(nfc(path.basename(u.searchParams.get('name') || '')).replace(/[. ]+$/, ''), 200); // Windows ignores trailing dots and spaces; a long name keeps its extension
      if (!name) throw httpError(400, 'Missing file name.');
      const buf = await readBody(req, MAX_UPLOAD);
      if (!buf.length) throw httpError(400, 'That file is empty.');
      const ext = path.extname(name).toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
      // Other extensions are read as text when they look like text; documents and images keep their own readers.
      const isText = TEXT_EXT.has(ext) ? hasUtf16Bom(buf) || !buf.subarray(0, 4096).includes(0) : !docs.DOC_EXT.has(ext) && !IMAGE_EXT.has(ext) && looksLikeText(buf);
      let text = '';
      if (isText) text = decodeBuf(buf);
      else if (docs.DOC_EXT.has(ext)) text = docs.readDocument(buf, ext); // PDF, Word, PowerPoint, Excel, OpenDocument; '' when unreadable
      if (isText && /\.html?$/.test(ext)) text = htmlToText(text).text;
      const id = crypto.randomUUID();
      const fileName = id + safeExt;
      try { fs.writeFileSync(path.join(FILES, fileName), buf); } catch (e) { fs.rmSync(path.join(FILES, fileName), { force: true }); throw saveError(e); }
      try {
        const it = addItem({ id, type: 'file', title: name, text, fileName, size: buf.length, mime: IMAGE_EXT.has(ext) ? MIME[ext] : undefined });
        return json(res, 201, view(it));
      } catch (e) { fs.rmSync(path.join(FILES, fileName), { force: true }); throw e; }
    }
    if (method === 'PATCH' && (m = p.match(/^\/api\/items\/([\w-]+)$/))) {
      const b = await readJson(req, 4096);
      const it = items.find((i) => i.id === m[1]); // looked up after the body arrives: it may have been deleted meanwhile
      if (!it) throw httpError(404, 'No such item.');
      const unknown = Object.keys(b).filter((k) => k !== 'category' && k !== 'reviewed');
      if (unknown.length) throw httpError(400, `Unknown field: ${unknown[0]}.`);
      if (b.reviewed !== undefined && b.reviewed !== true) throw httpError(400, '"reviewed" can only be set to true.');
      if (b.category === undefined && b.reviewed === undefined) throw httpError(400, 'Nothing to change. Send "category" or "reviewed".');
      // Validate everything before touching the item, so a refused request changes nothing.
      const event = b.category !== undefined ? workflow.EVENTS.SORT : workflow.EVENTS.KEEP;
      const move = workflow.transition(it, event, { category: b.category === undefined ? undefined : canonical(b.category, it) });
      const before = { category: it.category, needsReview: it.needsReview, confidence: it.confidence, autoRoom: it.autoRoom };
      const moved = event === workflow.EVENTS.SORT && move.patch.category !== it.category;
      Object.assign(it, move.patch, moved ? { autoRoom: false } : {}); // moving an item into a room makes it theirs: its name is never recomputed (re-sending the same category is not a move)
      try { save(); } catch (e) { Object.assign(it, before); throw e; }
      return json(res, 200, view(it));
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/items\/([\w-]+)$/))) {
      const it = items.find((i) => i.id === m[1]);
      if (!it) throw httpError(404, 'No such item.');
      workflow.transition(it, workflow.EVENTS.DELETE);
      const kept = items;
      items = items.filter((i) => i !== it);
      idx = null;
      try { save(); } catch (e) { items = kept; throw e; }
      sem.kick();
      // The record is already gone, so a locked file (Windows keeps it open while it downloads) must not turn this into an error; the startup sweep sets it aside.
      if (it.fileName) { try { fs.rmSync(path.join(FILES, it.fileName), { force: true }); } catch (e) { console.error(`Could not remove ${it.fileName}: ${e.message}`); } }
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/ask') {
      const b = await readJson(req, 64 * 1024);
      const q = typeof b.q === 'string' ? b.q.trim() : '';
      if (!q || q.length > 1000) throw httpError(400, 'Ask a question of 1 to 1000 characters.');
      const history = (Array.isArray(b.history) ? b.history : [])
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-6).map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
      const t0 = Date.now();
      const done = (o) => json(res, 200, { sources: [], ...o, ms: Date.now() - t0 });

      const ex = parseExtract(q, categoryNames());
      if (ex) {
        if (ex.ambiguous) return done({ mode: 'help', answer: `More than one room matches that name: ${ex.ambiguous.map((c) => `“${c}”`).join(', ')}. Name one, for example “extract amounts from ${ex.ambiguous[0]}”.` });
        if (ex.qualifier) return done({ mode: 'help', answer: `Extraction lists every match and cannot filter by “${ex.qualifier}”. Filter by category instead (“extract amounts from <category>”), or ask your question in plain words.` });
        if (!ex.kind) return done({ mode: 'help', answer: 'I can extract dates, amounts, emails, links and phone numbers. Try “extract dates” or “extract amounts from <category>”. To look something else up, ask it as a question.' });
        if (ex.unknownScope) return done({ mode: 'help', answer: `There is no category called “${ex.unknownScope}”. Categories: ${categoryNames().join(', ') || 'none yet'}.` });
        const all = extractRows(ex.kind, ex.category);
        const rows = all.slice(0, 500);
        const where = ex.category ? ` in “${ex.category}”` : '';
        const plural = ex.kind === 'phones' ? 'phone numbers' : ex.kind;
        const what = rows.length === 1 ? SINGULAR[ex.kind] : plural;
        const also = ex.extraKinds ? ex.kinds.slice(1).map((k) => { const r = extractRows(k, ex.category); return { kind: k, rows: r.slice(0, 500), truncated: r.length > 500 }; }) : undefined;
        return done({
          mode: 'extract', kind: ex.kind, category: ex.category || null, rows, truncated: all.length > 500,
          answer: rows.length ? `Found ${rows.length} ${what}${where}.` : `No ${plural} found${where}.`,
          ...(also && { also, note: `You named more than one kind, so the table shows ${ex.kind} only. The others were also found (${also.map((a) => `${a.rows.length} ${a.kind}`).join(', ')}); ask for them one at a time, for example “extract ${also[0].kind}”.` }),
        });
      }

      // A short question that points back ("and the notice period?") borrows the previous question, with the new words weighing 3x; an unrelated short one stands alone.
      // If the new question has a rare word the library knows and answers by itself, it is used on its own.
      const lastUser = [...history].reverse().find((h) => h.role === 'user');
      let follow = !!lastUser && tokenize(q).length < 4 && FOLLOW_UP.test(q);
      let plan = follow ? buildPlan(q, lastUser.content) : buildPlan(q);
      if (follow) {
        const solo = buildPlan(q), { df, chunks } = getIdx();
        const rare = solo.groups.some((g) => { const d = df.get(g.t) || 0; return d > 0 && d <= Math.max(2, chunks.length * 0.2); });
        const alone = rare ? search(solo) : [];
        if (alone.length && alone.info.matched >= alone.info.present) plan = solo;
      }
      let sources = await searchHybrid(plan);
      const hint = 'To pull values out of everything, type “extract dates” (or amounts, emails, links, phones).';
      const stuck = items.filter((i) => i.noText);
      const unread = stuck.length ? ` ${stuck.length} ${stuck.length === 1 ? 'file (e.g. ' : 'files (e.g. '}${stuck[0].title}) ${stuck.length === 1 ? 'is stored but has' : 'are stored but have'} no readable text.` : '';
      if (!items.length) return done({ mode: 'none', answer: 'Your library is empty — add something first.' });
      if (!sources.length) return done({ mode: 'none', answer: `Nothing in the belly matches that yet. Try different words, or feed me the document that has the answer.${unread} ${hint}` });
      const info = sources.info; // present for keyword retrieval only; with embeddings on, the vectors decide
      const weak = (s) => s.info && s.info.groups >= 2 && (s.info.matched < 2 || s.info.coverage < 0.5); // matching one stray word such as "number" is not an answer
      if (!follow && weak(sources) && lastUser && tokenize(q).length < 4) { // a short question right after another may lean on it even without a pointer word
        const lean = buildPlan(q, lastUser.content), s2 = await searchHybrid(lean);
        if (s2.length && s2.info && s2.info.matched >= 2) { plan = lean; sources = s2; follow = true; }
      }
      const words = ((follow ? `${lastUser.content} ${q}` : q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !STOP.has(w)).map(pluralStem); // the page highlights with its own plural-only stemmer
      const terms = [...new Set([...plan.groups.map((g) => g.t), ...words])];
      if (weak(sources)) { // a follow-up is checked too: it may borrow a topic that does not answer the new words
        const si = sources.info;
        const via = follow ? ' I read that as a follow-up to your last question, so try asking it in full.' : '';
        const phones = /\b(?:phones?|telephones?|numbers?)\b/i.test(q) ? ' To list phone numbers, try “extract phones from <category>”.' : '';
        return done({ mode: 'none', answer: `I couldn't find that. The closest passage (“${si.title}”) only matches ${si.seen.map((t) => `“${t}”`).join(', ')}, not ${si.missing.map((t) => `“${t}”`).join(', ')}, so I won't guess.${via}${phones}${unread} ${hint}` });
      }
      const quoted = extractive(plan, sources, getIdx().df, getIdx().chunks.length);
      if (answerer) {
        try { return done({ mode: 'llm', answer: await answerer(q, sources, history), sources, terms }); }
        catch (e) { return done({ mode: 'extractive', answer: quoted || 'None of these passages quotes your words directly.', sources, terms, note: `The AI model was unavailable (${e.message}), so these are quoted passages.` }); }
      }
      if (!quoted) return done({ mode: 'none', answer: `I found passages that may be related, but none of them quotes your words, so I won't guess. Try the exact words from your document, or connect an AI model for written answers.${unread} ${hint}` });
      return done({
        mode: 'extractive', answer: quoted, sources, terms,
        llmMissing: true,
        note: localOnly() && settings.provider !== 'none'
          ? 'PACRAG_LOCAL_ONLY is set, so no AI model is used. These are the passages found, quoted as they are.'
          : 'No AI model is connected, so I can only show the passages I found, quoted as they are. Connect a llama.cpp server or a cloud API key (AI model…) to get written answers.',
      });
    }
    if (method === 'GET' && (m = p.match(/^\/files\/([\w.-]+)$/))) {
      const it = items.find((i) => i.fileName === m[1]);
      if (!it) throw httpError(404, 'Not found.');
      const ext = path.extname(it.fileName);
      const inline = IMAGE_EXT.has(ext);
      const fp = path.join(FILES, it.fileName);
      let st;
      try { st = fs.statSync(fp); if (!st.isFile()) throw new Error('not a file'); } catch { throw httpError(404, 'That file is missing from the data folder.'); }
      res.writeHead(200, {
        ...SEC, 'content-type': inline ? MIME[ext] : 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': 'sandbox',
        'content-length': st.size,
        'content-disposition': inline ? 'inline' : contentDisposition(it.title),
      });
      // pipeline handles a read error (file vanished mid-request) by destroying the response instead of crashing
      return pipeline(fs.createReadStream(fp), res, () => { if (!res.writableEnded) res.destroy(); });
    }
    if (p.startsWith('/api/')) throw httpError(404, 'Not found.');
    if (method === 'GET') {
      let rel;
      try { rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)); } catch { throw httpError(400, 'Bad path.'); }
      const file = path.resolve(PUB, rel);
      let real = '', expect = file;
      try { const realPub = fs.realpathSync.native(PUB); expect = path.resolve(realPub, path.relative(PUB, file)); real = fs.realpathSync.native(file); } catch { /* missing */ }
      // exact-case match only: NTFS is case-insensitive and treats "name:stream" as an alternate data stream
      if (!file.startsWith(PUB + path.sep) || rel.includes(':') || real !== expect || !fs.statSync(file).isFile()) throw httpError(404, 'Not found.');
      res.writeHead(200, { ...SEC, 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    }
    throw httpError(405, 'Method not allowed.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      if (e.status === 413) res.setHeader('connection', 'close'); // we did not read the body, so do not reuse the connection
      json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.', ...(e.allowed && { allowed: e.allowed }) });
    });
  });
  server.maxConnections = 256;
  return { server, search, items: () => items };
}

async function start({ port = 4747, dataDir = path.join(__dirname, 'data'), ...opts } = {}) {
  const app = createApp(dataDir, opts); // throws (as a rejection) if items.json is unreadable
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', () => resolve({
      ...app, port: app.server.address().port, dataDir: path.resolve(dataDir),
      close: () => new Promise((r) => { app.server.closeAllConnections(); app.server.close(r); }),
    }));
  });
}

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`PAC&RAG: a local knowledge base.

Usage: node server.js [--help]

Environment:
  PORT                 port to listen on, 1-65535 (default 4747)
  DATA_DIR             where items.json and files/ live (default: data/ next to server.js; a relative path is resolved against the current directory)
  PACRAG_LLM_URL       default llama.cpp / OpenAI-compatible server for written answers (also settable in the app: Settings)
  ANTHROPIC_API_KEY    default Anthropic key (also settable in the app); CLAUDE_MODEL picks the model
  PACRAG_LOCAL_ONLY    1, true or yes: never call any LLM, even if one is configured`);
    process.exit(0);
  }
  const rawPort = process.env.PORT;
  const port = rawPort === undefined || rawPort === '' ? 4747 : /^\d+$/.test(rawPort.trim()) ? Number(rawPort.trim()) : NaN;
  if (!(port >= 1 && port <= 65535)) { console.error(`Invalid PORT "${rawPort}". Use a whole number from 1 to 65535.`); process.exit(1); }
  start({ port, dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined })
    .then(({ port, close, dataDir }) => {
      console.log(`PAC&RAG is running at http://127.0.0.1:${port}`);
      console.log(`Data folder: ${dataDir}`);
      // Writes are synchronous, so nothing is half-written when we stop; just close connections and leave.
      let stopping = false;
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (stopping) return; stopping = true; close().then(() => { console.log('Stopped'); process.exit(0); }); });
    })
    .catch((e) => {
      console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT=<other> or stop the other PAC&RAG.` : e.message);
      process.exit(1);
    });
}

module.exports = { start, chunk, tokenize, htmlToText };
