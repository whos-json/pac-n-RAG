(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kids.flat().filter((x) => x != null && x !== false));
    return n;
  };
  const JSON_H = { 'content-type': 'application/json' };
  const URLRE = /^https?:\/\/\S+$/i;
  const MODE = { claude: 'Claude', extractive: 'Local, quoted from your sources', extract: 'Local extraction', none: 'No match', help: 'Help' };
  const stem = (t) => (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t) ? t.slice(0, -1) : t); // keep in step with server.js
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: the preference just will not persist */ } },
  };

  const api = async (url, opts) => {
    opts = opts || {};
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ 'x-pacrag': '1' }, opts.headers) })); }
    catch (e) { throw new Error('Cannot reach the server. Is it still running?'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  };

  let items = [];
  const closed = new Set();
  const history = [];
  const errors = [];
  let convo = 0;
  const board = window.Board.create($('#canvas'), { onPellet: focusItem });

  // ---- messages ----
  const say = (m) => { $('#status').textContent = m; };
  const fail = (m) => { if (errors[errors.length - 1] !== m) errors.push(m); $('#alert').textContent = errors.slice(-5).join('\n'); $('#alert-x').hidden = false; };
  $('#alert-x').addEventListener('click', () => { errors.length = 0; $('#alert').textContent = ''; $('#alert-x').hidden = true; $('#msg').focus(); });
  const feedLog = [];
  function logFeed(msg, flagged) {
    feedLog.unshift({ msg, flagged });
    feedLog.length = Math.min(feedLog.length, 6);
    $('#feedlog').replaceChildren(...feedLog.map((x) => el('li', { class: x.flagged ? 'flag' : '' }, x.msg)));
  }
  const announce = (m) => { const sr = $('#sr'); sr.textContent = ''; setTimeout(() => { sr.textContent = m; }, 60); };

  // ---- animation preference ----
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = $('#motion');
  function applyMotion(on) {
    board.setMotion(on);
    motion.setAttribute('aria-checked', String(on));
  }
  function syncMotion() { // follows the system setting live, not just at load
    if (reducedQuery.matches) { motion.setAttribute('aria-checked', 'false'); motion.disabled = true; motion.title = 'Your system asks for reduced motion'; board.setMotion(false); }
    else { motion.disabled = false; motion.removeAttribute('title'); applyMotion(store.get('pacrag.motion') !== 'off'); }
  }
  syncMotion();
  reducedQuery.addEventListener('change', syncMotion);
  motion.addEventListener('click', () => {
    const on = motion.getAttribute('aria-checked') !== 'true';
    store.set('pacrag.motion', on ? 'on' : 'off');
    applyMotion(on);
    say(on ? 'Animation on.' : 'Animation off.');
  });

  // ---- data ----
  function groups() { // rooms keep the order they were created in, so the board does not shuffle
    const m = new Map();
    for (const it of items) { if (!m.has(it.category)) m.set(it.category, []); m.get(it.category).push(it); }
    for (const l of m.values()) l.sort((a, b) => a.added - b.added);
    return [...m].sort((a, b) => a[1][0].added - b[1][0].added);
  }

  function keepFocus(render) { // re-rendering the lists must not drop a keyboard user's place
    const a = document.activeElement;
    const li = a && a.closest ? a.closest('#library li[id], #review li[id]') : null;
    const sum = !li && a && a.closest ? a.closest('#library summary') : null;
    const key = li && { id: li.id, label: a.getAttribute('aria-label') || a.textContent };
    const head = sum && sum.firstChild.textContent;
    render();
    if (head) { const again = [...document.querySelectorAll('#library summary')].find((s) => s.firstChild.textContent === head); (again || $('#lib-h')).focus(); return; }
    if (!key) return;
    const again = document.getElementById(key.id);
    const target = again && ([...again.querySelectorAll('button, a')].find((b) => (b.getAttribute('aria-label') || b.textContent) === key.label) || again);
    (target || ($('#review-sec').hidden ? $('#lib-h') : $('#review-h'))).focus();
  }

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    const [list, st] = await Promise.all([api('/api/items'), api('/api/status')]);
    if (seq !== refreshSeq) return; // a newer refresh is already on its way; do not let this stale one overwrite it
    items = list.items;
    board.setData(groups().map(([name, l]) => ({ name, items: l.map((i) => ({ id: i.id, title: i.title, review: i.needsReview })) })));
    keepFocus(() => { renderLibrary(); renderReview(); });
    $('#llm').textContent = st.llm === 'claude'
      ? 'Answers by Claude. Retrieved passages are sent to Anthropic.'
      : 'Answers run locally. Your documents stay on this machine (links you add are fetched from the web).';
  }

  // ---- library ----
  const kindOf = (it) => (it.type === 'url' ? 'link' : it.type === 'file' ? (it.mime && it.mime.startsWith('image/') ? 'image' : 'file') : 'note');

  function renderLibrary() {
    const box = $('#library');
    box.replaceChildren();
    if (!items.length) { box.append(el('p', { class: 'empty' }, 'Nothing here yet. Add a note, a link or a file above, or drop one on the maze.')); return; }
    for (const [cat, list] of groups()) {
      const d = el('details', { open: !closed.has(cat) }, el('summary', {}, cat, el('span', { class: 'count' }, ` (${list.length})`)), el('ul', {}, list.map(itemRow)));
      d.addEventListener('toggle', () => { if (d.open) closed.delete(cat); else closed.add(cat); });
      box.append(d);
    }
  }

  function itemRow(it) {
    const title = it.type === 'url' && it.source ? el('a', { href: it.source, target: '_blank', rel: 'noopener noreferrer' }, it.title) : el('span', {}, it.title);
    const flags = [it.noText && 'no text extracted', it.truncated && 'truncated'].filter(Boolean).join(', ');
    return el('li', { id: `item-${it.id}`, tabindex: '-1' },
      el('div', { class: 'item-main' }, el('span', { class: 'badge' }, kindOf(it)), title, flags && el('span', { class: 'flag' }, `(${flags})`)),
      kindOf(it) === 'image' && it.fileName && el('img', { class: 'thumb', src: `/files/${it.fileName}`, alt: '', loading: 'lazy' }),
      el('div', { class: 'item-actions' },
        el('button', { type: 'button', class: 'small', 'aria-label': `View ${it.title}`, onclick: () => openView(it) }, 'View'),
        el('button', { type: 'button', class: 'small', 'aria-label': `Move ${it.title}`, onclick: () => openMove(it) }, 'Move'),
        deleteBtn(it)));
  }

  function deleteBtn(it) {
    const b = el('button', { type: 'button', class: 'small danger', 'aria-label': `Delete ${it.title}` }, 'Delete');
    let timer;
    const revert = () => { clearTimeout(timer); delete b.dataset.armed; b.textContent = 'Delete'; b.setAttribute('aria-label', `Delete ${it.title}`); };
    b.addEventListener('click', async () => {
      if (!b.dataset.armed) {
        b.dataset.armed = '1'; b.textContent = 'Confirm delete'; b.setAttribute('aria-label', `Confirm delete ${it.title}`);
        say(`Press Confirm delete again within 6 seconds to delete “${it.title}”.`);
        timer = setTimeout(() => { revert(); say(`Delete of “${it.title}” cancelled.`); }, 6000);
        return;
      }
      clearTimeout(timer);
      try { await api(`/api/items/${it.id}`, { method: 'DELETE' }); say(`Deleted “${it.title}”.`); await refresh(); $('#lib-h').focus(); }
      catch (e) { revert(); fail(e.message); }
    });
    return b;
  }

  function renderReview() {
    const list = items.filter((i) => i.needsReview);
    $('#review-sec').hidden = !list.length;
    $('#review').replaceChildren(...list.map((it) => el('li', { id: `review-${it.id}`, tabindex: '-1' },
      el('div', { class: 'item-main' }, el('span', { class: 'badge' }, kindOf(it)), el('span', {}, it.title)),
      el('p', { class: 'ghost-line' }, `Best guess: ${it.category}`),
      el('div', { class: 'item-actions' },
        el('button', { type: 'button', class: 'small', 'aria-label': `Keep ${it.title} in ${it.category}`, onclick: () => keepGuess(it) }, 'Keep'),
        el('button', { type: 'button', class: 'small', 'aria-label': `Sort ${it.title} into another category`, onclick: () => openMove(it) }, 'Sort…')))));
  }
  async function keepGuess(it) {
    try { await api(`/api/items/${it.id}`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ reviewed: true }) }); say(`Kept “${it.title}” in ${it.category}.`); await refresh(); }
    catch (e) { fail(e.message); }
  }

  // ---- dialogs ----
  let moving = null;
  function openMove(it) {
    moving = it;
    const dlg = $('#move');
    dlg.returnValue = '';
    $('#move-title').textContent = it.title;
    $('#cat-list').replaceChildren(...[...new Set(items.map((i) => i.category))].sort().map((c) => el('option', { value: c })));
    $('#move-cat').value = it.category;
    dlg.showModal();
    $('#move-cat').select();
  }
  $('#move-cancel').addEventListener('click', () => $('#move').close('cancel'));
  $('#move').addEventListener('close', async () => {
    if ($('#move').returnValue !== 'ok' || !moving) return;
    const category = $('#move-cat').value.trim();
    if (!category) return;
    const it = moving;
    try { await api(`/api/items/${it.id}`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ category }) }); say(`Moved “${it.title}” to ${category}.`); await refresh(); focusItem(it.id); }
    catch (e) { fail(e.message); }
  });
  async function openView(it) {
    try {
      const full = await api(`/api/items/${it.id}`);
      $('#view-h').textContent = full.title;
      $('#view-meta').textContent = [full.category, kindOf(full), full.source, full.noText && 'no text could be extracted', full.truncated && 'truncated at 2,000,000 characters'].filter(Boolean).join(' · ');
      $('#view-text').textContent = full.text || '(no text)';
      $('#view').showModal();
    } catch (e) { fail(e.message); }
  }
  $('#view-close').addEventListener('click', () => $('#view').close());

  function focusItem(id) {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    if (closed.delete(it.category)) renderLibrary();
    const li = document.getElementById(`item-${id}`);
    if (li) { li.scrollIntoView({ block: 'center' }); li.focus(); li.classList.add('hit'); setTimeout(() => li.classList.remove('hit'), 2500); }
    board.flash([id]);
  }

  // ---- feeding the belly ----
  const queue = [];
  let busy = false;
  const filed = (it) => `Filed “${it.title}” under ${it.category}.`
    + (it.needsReview ? ' Not sure about this one. Check the ghosts list.' : '')
    + (it.noText ? ' No text could be extracted, so it is stored but cannot be searched by content.' : '')
    + (it.truncated ? ' Very long, so only the first 2,000,000 characters are indexed.' : '');

  function enqueue(label, send, onOk) { queue.push({ label, send, onOk }); if (!busy) pump(); }
  async function pump() {
    busy = true;
    while (queue.length) {
      const { label, send, onOk } = queue.shift();
      say(`Digesting ${label}…`);
      let id = null;
      try {
        const it = await board.digest(send());
        id = it.id;
        board.hold(id);
        await refresh();
        await board.deliver(id);
        if (onOk) onOk();
        say(filed(it));
        logFeed(filed(it), it.needsReview || it.noText);
      } catch (e) { if (id) board.release(id); say(`Could not add ${label}.`); fail(e.message); }
    }
    busy = false;
  }
  const sendNote = (text) => () => api('/api/items', { method: 'POST', headers: JSON_H, body: JSON.stringify({ type: 'note', text }) });
  const sendUrl = (url) => () => api('/api/items', { method: 'POST', headers: JSON_H, body: JSON.stringify({ type: 'url', url }) });
  const sendFile = (f) => () => api(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });

  $('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#note').value.trim();
    if (!t) { $('#note').setAttribute('aria-invalid', 'true'); $('#note').focus(); return fail('The note is empty. Type something first.'); }
    enqueue('note', sendNote(t), () => { if ($('#note').value.trim() === t) $('#note').value = ''; });
  });
  $('#url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const u = $('#url').value.trim();
    if (!u) { $('#url').setAttribute('aria-invalid', 'true'); $('#url').focus(); return fail('The link is empty. Paste a link first.'); }
    enqueue(u, sendUrl(u), () => { if ($('#url').value.trim() === u) $('#url').value = ''; });
  });
  ['#note', '#url'].forEach((s) => $(s).addEventListener('input', () => $(s).removeAttribute('aria-invalid')));
  $('#pick').addEventListener('click', () => $('#files').click());
  $('#files').addEventListener('change', (e) => {
    [...e.target.files].forEach((f) => enqueue(f.name, sendFile(f)));
    e.target.value = '';
  });

  const isEditable = (t) => t instanceof Element && t.closest('input, textarea');
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].indexOf('Files') >= 0;
  let hungryTimer;
  const setHungry = (v) => { board.setHungry(v); $('#board').classList.toggle('hungry', v); };
  addEventListener('dragover', (e) => {
    if (isEditable(e.target) && !hasFiles(e)) return; // text dragged into a field is just typing; files are always ours
    e.preventDefault();
    setHungry(true);
    clearTimeout(hungryTimer);
    hungryTimer = setTimeout(() => setHungry(false), 450);
  });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) setHungry(false); });
  addEventListener('drop', (e) => {
    if (isEditable(e.target) && !hasFiles(e)) return;
    e.preventDefault();
    clearTimeout(hungryTimer);
    setHungry(false);
    feed(e.dataTransfer);
  });
  function feed(dt) {
    if (dt.files && dt.files.length) {
      const entries = [...(dt.items || [])].map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
      [...dt.files].forEach((f, i) => {
        if (entries[i] && entries[i].isDirectory) return fail(`“${f.name}” is a folder. Drop the files inside it instead.`);
        enqueue(f.name, sendFile(f));
      });
      return;
    }
    const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim();
    if (!text) return;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length && lines.every((l) => URLRE.test(l))) lines.forEach((u) => enqueue(u, sendUrl(u)));
    else enqueue('dropped text', sendNote(text));
  }

  // ---- chat ----
  function bubble(role, ...kids) {
    const li = el('li', { class: `msg ${role}` }, el('span', { class: 'who' }, role === 'user' ? 'You' : 'Chomp'), el('div', { class: 'body' }, ...kids));
    const log = $('#log');
    log.append(li);
    log.scrollTop = role === 'bot' && li.previousElementSibling ? li.previousElementSibling.offsetTop : log.scrollHeight; // show the question with its answer
    return li;
  }
  const greeting = () => bubble('bot', 'Feed me files, notes or links, then ask a question. Try “extract dates”, “extract amounts”, or “extract emails from <category>”.');

  function highlight(text, terms) {
    const snippet = text.length > 320 ? text.slice(0, 320) + '…' : text;
    const set = new Set(terms || []);
    if (!set.size) return [snippet];
    const out = [];
    let i = 0;
    for (const m of snippet.matchAll(/[\p{L}\p{N}]+/gu)) {
      if (!set.has(stem(m[0].toLowerCase()))) continue;
      out.push(snippet.slice(i, m.index), el('mark', {}, m[0]));
      i = m.index + m[0].length;
    }
    out.push(snippet.slice(i));
    return out;
  }
  function withCites(text, sources, mode) {
    const cite = (n) => {
      const s = sources.find((x) => x.n === n);
      return s ? el('button', { type: 'button', class: 'cite', 'aria-label': `[${n}] ${s.title}`, onclick: () => focusItem(s.itemId) }, `[${n}]`) : `[${n}]`;
    };
    if (mode === 'extractive') { // only the citation we appended to each quoted line is a citation; a "[2]" inside a quote is just text
      return text.split('\n').flatMap((line, i, all) => {
        const m = line.match(/^(.*) \[(\d+)\]$/s);
        const parts = m ? [m[1] + ' ', cite(Number(m[2]))] : [line];
        return i < all.length - 1 ? parts.concat('\n') : parts;
      });
    }
    return text.split(/(\[\d+\])/g).map((part) => { const m = part.match(/^\[(\d+)\]$/); return m ? cite(Number(m[1])) : part; });
  }
  function csvOf(rows) {
    const q = (v) => { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; // the apostrophe stops spreadsheets running values as formulas
    return '﻿' + [['Value', 'Source', 'Category', 'Context']].concat(rows.map((r) => [r.value, r.title, r.category, r.context])).map((r) => r.map(q).join(',')).join('\r\n');
  }
  function downloadCsv(r) {
    const url = URL.createObjectURL(new Blob([csvOf(r.rows)], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: `${r.kind}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function extractTable(r) {
    const shown = r.rows.slice(0, 200);
    const what = `${r.kind}${r.category ? ` from ${r.category}` : ''}`;
    const table = el('table', { class: `kind-${r.kind}` },
      el('caption', { class: 'sr' }, `Extracted ${what}`),
      el('thead', {}, el('tr', {}, ['Value', 'From', 'Context'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, shown.map((x) => el('tr', {}, el('td', {}, x.value), el('td', {}, x.title, el('br'), el('span', { class: 'muted' }, x.category)), el('td', { class: 'ctx' }, x.context)))));
    return el('div', { class: 'table-wrap' },
      el('div', { class: 'scroll', tabindex: '0', role: 'region', 'aria-label': `Extracted ${what}` }, table),
      r.rows.length > shown.length && el('p', { class: 'meta' }, `Showing ${shown.length} of ${r.rows.length}. The CSV has them all.`),
      r.truncated && el('p', { class: 'note' }, 'Capped at 500 results.'),
      el('button', { type: 'button', class: 'small', 'aria-label': `Download ${what} as CSV`, onclick: () => downloadCsv(r) }, 'Download CSV'));
  }
  function sourcesList(r) {
    return el('details', { class: 'sources' }, el('summary', {}, `Sources (${r.sources.length})`),
      el('ol', {}, r.sources.map((s) => el('li', { id: `src-${s.n}` },
        el('button', { type: 'button', class: 'small', 'aria-label': `[${s.n}] ${s.title}, show in library`, onclick: () => focusItem(s.itemId) }, `[${s.n}] ${s.title}`),
        el('span', { class: 'muted' }, ` ${s.category}`),
        el('blockquote', {}, ...highlight(s.text, r.terms))))));
  }
  function renderAnswer(r) {
    const out = [el('p', { class: 'answer' }, ...withCites(r.answer, r.sources || [], r.mode))];
    if (r.mode === 'extract' && r.rows.length) out.push(extractTable(r));
    if (r.note) out.push(el('p', { class: 'note' }, r.note));
    if (r.sources && r.sources.length) out.push(sourcesList(r));
    out.push(el('p', { class: 'meta' }, `${MODE[r.mode] || r.mode} · ${r.ms} ms`));
    return out;
  }
  const spoken = (r) => (r.mode === 'extract'
    ? r.answer + (r.rows.length ? ' The table is in the conversation.' : '')
    : r.answer.replace(/\[\d+\]/g, '').slice(0, 400) + (r.sources && r.sources.length ? ` ${r.sources.length} sources listed.` : ''));

  const setBusy = (v) => { $('#send').disabled = v; document.querySelectorAll('.chips button').forEach((b) => { b.disabled = v; }); };
  async function ask(q) {
    const mine = convo;
    bubble('user', q);
    const pending = bubble('bot', 'Hunting…');
    setBusy(true);
    try {
      const r = await api('/api/ask', { method: 'POST', headers: JSON_H, body: JSON.stringify({ q, history: history.slice(-6) }) });
      if (mine !== convo) return; // "New chat" was pressed while this was in flight
      pending.remove();
      bubble('bot', ...renderAnswer(r));
      history.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
      announce(spoken(r));
      const ids = [...new Set(r.mode === 'extract' ? r.rows.map((x) => x.itemId) : (r.sources || []).map((s) => s.itemId))].slice(0, 8);
      if (ids.length) board.run(ids);
    } catch (e) {
      if (mine !== convo) return;
      pending.remove();
      bubble('bot', el('span', { class: 'err' }, e.message));
      announce(`Error: ${e.message}`);
      if (!$('#msg').value) $('#msg').value = q; // give the question back so it is not lost
    } finally {
      if (mine === convo) {
        setBusy(false);
        const a = document.activeElement; // only pull focus back if it was not moved on purpose
        if (!a || a === document.body || a === $('#msg') || a === $('#send') || (a.closest && a.closest('.chips'))) $('#msg').focus();
      }
    }
  }
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#msg').value.trim();
    if (!q) return;
    $('#msg').value = '';
    ask(q);
  });
  document.querySelectorAll('.chips button').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('#clear').addEventListener('click', () => { convo++; setBusy(false); $('#log').replaceChildren(); history.length = 0; greeting(); $('#msg').focus(); });

  greeting();
  refresh().then(() => say('Ready.')).catch((e) => fail(e.message));
})();
