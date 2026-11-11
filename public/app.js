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
  const EMPTY_TEXT = 'Nothing here yet. Add a note, a link or a file.'; // the one empty-library sentence: the list and both boards show it
  const MODE = { llm: 'AI model', claude: 'AI model', extractive: 'Local, quoted from your sources', extract: 'Local extraction', none: 'No match', help: 'Help' };
  const stem = (t) => (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t) ? t.slice(0, -1) : t); // keep in step with server.js
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: the preference just will not persist */ } },
  };

  const timeout = (ms) => (window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  const onChange = (mq, fn) => { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); }; // old Safari only has addListener
  let tick = 0; // orders requests and errors, so a success only clears errors that were raised before it started
  const api = async (url, opts) => {
    opts = opts || {};
    const mark = ++tick;
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ 'x-pacrag': '1' }, opts.headers) })); }
    catch (e) {
      const timedOut = !!e && (e.name === 'TimeoutError' || e.name === 'AbortError'); // flagged so an add can say the item may already be there
      throw Object.assign(new Error(timedOut ? 'The server took too long to answer. Try again.' : 'Cannot reach the server. Is it still running?'), { timedOut });
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    clearErrors(mark);
    return data;
  };

  let items = [];
  let labels = new Map(); // unique accessible names for items, even when titles repeat
  const closed = new Set();
  const history = [];
  const errors = [];
  let convo = 0;
  const board = window.Board.create($('#canvas'), { onPellet: focusItem });
  window.pacBoard = board; // read by feedback.js for the core's position and its arrival pulse

  // ---- messages ----
  const say = (m) => { $('#status').textContent = m; };
  // The alert is a non-atomic live region: each message is its own child, so a screen reader speaks only the newest one.
  function syncDismiss() {
    const x = $('#alert-x');
    if (!errors.length && document.activeElement === x) $('#msg').focus();
    x.hidden = !errors.length;
  }
  const fail = (m) => {
    const last = errors[errors.length - 1];
    if (last && last.m === m) return;
    const x = { m, t: ++tick, node: el('span', {}, m) };
    errors.push(x);
    $('#alert').append(x.node); // appended alone, never re-created, so only this one is announced
    if (errors.length > 5) errors.shift().node.remove();
    syncDismiss();
  };
  function clearErrors(before) { // errors raised before this request began are stale once it succeeds
    const gone = errors.filter((x) => x.t < before);
    if (!gone.length) return;
    gone.forEach((x) => { x.node.remove(); errors.splice(errors.indexOf(x), 1); });
    syncDismiss();
  }
  $('#alert-x').addEventListener('click', () => { errors.splice(0).forEach((x) => x.node.remove()); syncDismiss(); $('#msg').focus(); });
  const feedLog = [];
  function logFeed(it) { // short entries, newest first, three at most
    feedLog.unshift({ msg: `${it.title} → ${it.category}`, flagged: it.needsReview || it.noText });
    feedLog.length = Math.min(feedLog.length, 3);
    $('#feedlog').hidden = !feedLog.length;
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
    const r = reducedQuery.matches;
    $('#motion-note').hidden = !r;
    if (r) { motion.setAttribute('aria-checked', 'false'); motion.disabled = true; motion.title = 'Your system asks for reduced motion'; board.setMotion(false); }
    else { motion.disabled = false; motion.removeAttribute('title'); applyMotion(store.get('pacrag.motion') !== 'off'); }
  }
  syncMotion();
  onChange(reducedQuery, syncMotion);
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

  function makeLabels() { // repeated titles get their category, then a number, so every button name is unique
    const byTitle = new Map(), byFull = new Map();
    for (const it of items) byTitle.set(it.title, (byTitle.get(it.title) || 0) + 1);
    const seen = new Map();
    labels = new Map();
    for (const it of items) {
      let l = it.title;
      if (byTitle.get(it.title) > 1) {
        l = `${it.title} (${it.category})`;
        byFull.set(l, (byFull.get(l) || 0) + 1);
      }
      labels.set(it.id, l);
    }
    for (const it of items) {
      const l = labels.get(it.id);
      if (byFull.get(l) > 1) { const n = (seen.get(l) || 0) + 1; seen.set(l, n); labels.set(it.id, `${l} #${n}`); }
    }
  }
  const labelOf = (it) => labels.get(it.id) || it.title;

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    const [list, st] = await Promise.allSettled([api('/api/items'), api('/api/status')]);
    if (seq !== refreshSeq) return; // a newer refresh is already on its way; do not let this stale one overwrite it
    if (list.status === 'rejected') throw list.reason;
    items = list.value.items;
    makeLabels();
    if (armed && !items.some((i) => i.id === armed.id)) disarm(false);
    board.setData(groups().map(([name, l]) => ({ name, items: l.map((i) => ({ id: i.id, title: i.title, review: i.state === 'review' })) })));
    board.setEmptyText(EMPTY_TEXT);
    keepFocus(() => { renderLibrary(); renderReview(); });
    if (st.status === 'fulfilled') {
      window.pacLlmApply(st.value);
    }
  }

  // ---- library ----
  const kindOf = (it) => (it.type === 'url' ? 'link' : it.type === 'file' ? (it.mime && it.mime.startsWith('image/') ? 'image' : 'file') : 'note');

  const filterBox = $('#lib-filter');

  let filterTimer;
  filterBox.addEventListener('input', () => { // debounced: re-rendering on every keystroke flickers thumbnails and chatters at screen readers
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { keepFocus(renderLibrary); if (filterBox.value.trim()) announce($('#lib-count').textContent); }, 250); // the count is only spoken while filtering, never on ordinary re-renders
  });
  const matches = (it, q) => q.split(/\s+/).every((tok) => [it.title, it.category, kindOf(it)].some((s) => String(s || '').toLowerCase().includes(tok)));

  function renderLibrary() {
    const box = $('#library');
    box.replaceChildren();
    $('#lib-filter-wrap').hidden = !items.length;
    if (loadFailed) {
      box.append(el('p', { class: 'empty' }, 'Could not load your library.'), el('button', { type: 'button', id: 'retry', class: 'small', onclick: load }, 'Retry'));
      return;
    }
    if (!items.length) { $('#lib-count').textContent = ''; box.append(el('p', { class: 'empty' }, EMPTY_TEXT)); return; }
    const q = filterBox.value.trim().toLowerCase();
    let shown = 0;
    for (const [cat, all] of groups()) {
      const list = q ? all.filter((it) => matches(it, q)) : all;
      if (!list.length) continue;
      shown += list.length;
      const count = q && list.length !== all.length ? ` (${list.length} of ${all.length})` : ` (${list.length})`;
      const d = el('details', { open: q ? true : !closed.has(cat) }, el('summary', {}, cat, el('span', { class: 'count' }, count)), el('ul', {}, list.map(itemRow)));
      if (q) { box.append(d); continue; } // while filtering, open/closed is not the user's choice, so do not remember it
      d.addEventListener('toggle', () => { if (d.open) closed.delete(cat); else closed.add(cat); });
      box.append(d);
    }
    const countText = q ? (shown ? `${shown} of ${items.length} items match.` : `No items match “${filterBox.value.trim()}”.`) : `${items.length} ${items.length === 1 ? 'item' : 'items'} in ${groups().length} ${groups().length === 1 ? 'room' : 'rooms'}.`;
    if ($('#lib-count').textContent !== countText) $('#lib-count').textContent = countText;
    if (q && !shown) box.append(el('p', { class: 'empty' }, 'Nothing matches that filter. Clear it to see everything.'));
  }

  const can = (it, action) => Array.isArray(it.actions) && it.actions.includes(action); // the server decides what may be offered

  function itemRow(it) {
    const title = it.type === 'url' && it.source ? el('a', { href: it.source, target: '_blank', rel: 'noopener noreferrer' }, it.title) : el('span', {}, it.title);
    const flags = [it.noText && 'no text extracted', it.truncated && 'truncated'].filter(Boolean).join(', ');
    return el('li', { id: `item-${it.id}`, tabindex: '-1' },
      el('div', { class: 'item-main' }, el('span', { class: 'badge' }, kindOf(it)), title, flags && el('span', { class: 'flag' }, `(${flags})`)),
      kindOf(it) === 'image' && it.fileName && el('img', { class: 'thumb', src: `/files/${it.fileName}`, alt: '', loading: 'lazy' }),
      el('div', { class: 'item-actions' },
        el('button', { type: 'button', class: 'small', 'aria-label': `View ${labelOf(it)}`, onclick: () => openView(it) }, 'View'),
        can(it, 'sort') && el('button', { type: 'button', class: 'small', 'aria-label': `Move ${labelOf(it)}`, onclick: () => openMove(it) }, 'Move'),
        can(it, 'delete') && deleteBtn(it)));
  }

  // Only one delete can be armed at a time. The armed id outlives re-renders, so a refresh does not silently disarm it.
  const CONFIRM_MS = 12000;
  let armed = null; // { id, name, hint, timer }
  function paintDelete(b) {
    const on = armed && armed.id === b.dataset.del;
    b.textContent = on ? 'Confirm delete' : 'Delete';
    b.setAttribute('aria-label', `${on ? 'Confirm delete' : 'Delete'} ${b.dataset.name}`);
  }
  const paintDeletes = () => document.querySelectorAll('button[data-del]').forEach(paintDelete);
  function disarm(announceTimeout) {
    if (!armed) return;
    const a = armed;
    armed = null;
    clearTimeout(a.timer);
    paintDeletes();
    if (!announceTimeout || $('#status').textContent !== a.hint) return; // something newer is in the status line; leave it
    const cancelled = `Delete of “${a.name}” cancelled.`;
    say(cancelled);
    setTimeout(() => { if ($('#status').textContent === cancelled) say(''); }, 3000);
  }
  function deleteBtn(it) {
    const name = labelOf(it);
    const b = el('button', { type: 'button', class: 'small danger', 'data-del': it.id, 'data-name': name }, 'Delete');
    paintDelete(b);
    b.addEventListener('click', async () => {
      if (b.dataset.busy) return;
      if (!armed || armed.id !== it.id) {
        disarm(false); // arming another item cancels the first without a stray message
        const hint = `Press Confirm delete again within ${CONFIRM_MS / 1000} seconds to delete “${name}”.`;
        armed = { id: it.id, name, hint, timer: setTimeout(() => disarm(true), CONFIRM_MS) };
        paintDeletes();
        say(hint);
        return;
      }
      disarm(false);
      const li = document.getElementById(`item-${it.id}`);
      const near = li && (li.nextElementSibling || li.previousElementSibling);
      const nearId = near && near.id;
      b.dataset.busy = '1';
      try { await api(`/api/items/${it.id}`, { method: 'DELETE' }); }
      catch (e) { // it may already be gone elsewhere: resync first (a successful refresh clears older errors), then report
        delete b.dataset.busy;
        await refresh().catch(() => {});
        if (e.message === 'No such item.') say(`“${name}” was already deleted elsewhere, so it has been removed from the list.`);
        else fail(e.message);
        return;
      }
      say(`Deleted “${name}”.`);
      const had = document.activeElement === b || document.activeElement === document.body;
      try {
        await refresh();
        const next = nearId && document.getElementById(nearId);
        const view = next && next.querySelector('button');
        if (had || document.activeElement === document.body || !document.activeElement.isConnected || document.activeElement === $('#lib-h') || document.activeElement === $('#review-h')) (view || $('#lib-h')).focus();
      } catch (e) { refreshFailed(e); }
    });
    return b;
  }

  function renderReview() {
    const list = items.filter((i) => i.state === 'review');
    $('#review-sec').hidden = !list.length;
    $('#review').replaceChildren(...list.map((it) => el('li', { id: `review-${it.id}`, tabindex: '-1' },
      el('div', { class: 'item-main' }, el('span', { class: 'badge' }, kindOf(it)), el('span', {}, it.title)),
      el('p', { class: 'ghost-line' }, `Best guess: ${it.category}`),
      el('div', { class: 'item-actions' },
        can(it, 'keep') && el('button', { type: 'button', class: 'small', 'aria-label': `Keep ${it.title} in ${it.category}`, onclick: () => keepGuess(it) }, 'Keep'),
        can(it, 'sort') && el('button', { type: 'button', class: 'small', 'aria-label': `Sort ${it.title} into another category`, onclick: () => openMove(it) }, 'Sort…')))));
  }
  // The change itself succeeded but the lists could not be reloaded: say so (not that the action failed) and offer the Retry button.
  function refreshFailed(e) {
    loadFailed = true;
    board.setEmptyText('Could not load your library.');
    renderLibrary();
    fail(`Could not refresh the list: ${e.message}. Use Retry in the library.`);
  }
  async function keepGuess(it) {
    try { await api(`/api/items/${it.id}`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ reviewed: true }) }); }
    catch (e) { await refresh().catch(() => {}); fail(e.message); return; } // the item may have changed or gone elsewhere: resync first, then report
    say(`Kept “${it.title}” in ${it.category}.`);
    try { await refresh(); } catch (e) { refreshFailed(e); }
  }

  // ---- dialogs ----
  let moving = null;
  let opener = null; // which list row opened a dialog, so focus can go back even if the lists were re-rendered meanwhile
  const noteOpener = () => {
    const a = document.activeElement, li = a && a.closest ? a.closest('#library li[id], #review li[id]') : null;
    opener = li ? { li: li.id, label: a.getAttribute('aria-label') || a.textContent } : null;
  };
  function restoreFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const li = opener && document.getElementById(opener.li);
    const btn = li && [...li.querySelectorAll('button, a')].find((b) => (b.getAttribute('aria-label') || b.textContent) === opener.label);
    (btn || li || $('#lib-h')).focus();
  }
  function openMove(it) {
    const dlg = $('#move');
    if (dlg.open) return;
    noteOpener();
    moving = it;
    dlg.returnValue = '';
    $('#move-title').textContent = it.title;
    $('#cat-list').replaceChildren(...[...new Set(items.map((i) => i.category))].sort().map((c) => el('option', { value: c })));
    $('#move-cat').value = it.category;
    dlg.showModal();
    $('#move-cat').select();
  }
  $('#move-cancel').addEventListener('click', () => $('#move').close('cancel'));
  $('#move').addEventListener('close', async () => {
    if ($('#move').returnValue !== 'ok' || !moving) return restoreFocus();
    const category = $('#move-cat').value.trim();
    if (!category) return restoreFocus();
    const it = moving;
    if ((items.find((i) => i.id === it.id) || it).category === category) { say(`No change: “${it.title}” is already in ${category}.`); return restoreFocus(); }
    try { await api(`/api/items/${it.id}`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ category }) }); say(`Moved “${it.title}” to ${category}.`); await refresh(); focusItem(it.id); }
    catch (e) { restoreFocus(); await refresh().catch(() => {}); fail(e.message); }
  });
  async function openView(it) {
    const dlg = $('#view');
    if (dlg.open) return;
    noteOpener();
    const mine = opener;
    try {
      const full = await api(`/api/items/${it.id}`);
      if (dlg.open || $('#move').open) return; // another dialog won the race
      opener = mine;
      $('#view-h').textContent = full.title;
      $('#view-meta').textContent = [full.category, kindOf(full), full.source, full.noText && 'no text could be extracted', full.truncated && 'truncated at 2,000,000 characters'].filter(Boolean).join(' · ');
      $('#view-text').textContent = full.text || '(no text)';
      dlg.showModal();
    } catch (e) { await refresh().catch(() => {}); fail(e.message); } // a 404 means another tab removed it: resync first, then report
  }
  $('#view-close').addEventListener('click', () => $('#view').close());
  $('#view').addEventListener('close', restoreFocus);

  function focusItem(id) {
    const it = items.find((i) => i.id === id);
    if (!it) return;
    const q = filterBox.value.trim().toLowerCase();
    const hidden = q && !matches(it, q); // a filtered-out item cannot be shown, so drop the filter
    if (hidden) { filterBox.value = ''; say('Filter cleared to show that item.'); }
    if (closed.delete(it.category) || hidden) renderLibrary();
    if (window.PacUI) window.PacUI.show('lib'); // the item lives in the Library tab
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

  let current = null;
  let batchTotal = 0, batchDone = 0; // "2 of 5": counts items in the current run of the queue
  const progress = () => {
    const bar = $('#progress');
    bar.hidden = batchTotal < 2;
    $('#progress-bar').style.width = batchTotal ? `${Math.round((batchDone / batchTotal) * 100)}%` : '0%';
  };
  const pendingOf = (kind) => queue.concat(current ? [current] : []).filter((x) => x.kind === kind).length;
  function syncSubmits() { // aria-disabled, not disabled: a keyboard user's focus stays on the button
    [['note', '#note-form'], ['url', '#url-form']].forEach(([kind, f]) => $(`${f} button[type="submit"]`).setAttribute('aria-disabled', String(pendingOf(kind) > 0)));
  }
  function enqueue(label, send, onOk, key, kind, shown) { // shown: the text the filed flyer shows, when it is not the label
    key = key || label;
    if ((current && current.key === key) || queue.some((x) => x.key === key)) { say(`${label} is already queued.`); return false; }
    queue.push({ label, send, onOk, key, kind, shown });
    batchTotal++; progress();
    syncSubmits();
    if (busy) say(`Queued ${label}, behind ${queue.length} other${queue.length === 1 ? '' : 's'}.`);
    else pump();
    return true;
  }
  async function pump() {
    busy = true;
    try {
      while (queue.length) {
        current = queue.shift();
        try {
          const { label, send, onOk, kind, shown } = current;
          say(`Digesting ${label}${batchTotal > 1 ? ` (${batchDone + 1} of ${batchTotal})` : ''}…`);
          let it;
          try { it = await board.digest(send()); }
          catch (e) {
            say('');
            if (!e.timedOut) { fail(`Could not add ${label}: ${e.message}`); continue; }
            fail('The server took too long to answer. The item may already have been added, so the library is being checked.');
            await refresh().catch(() => {}); continue;
          }
          if (onOk) onOk(); // the server accepted it, so the field is cleared even if the refresh below fails
          window.dispatchEvent(new CustomEvent('pacrag:filed', { detail: { kind, shown: shown || label } })); // only accepted items fly (feedback.js)
          board.hold(it.id);
          try {
            await refresh();
            await board.deliver(it.id);
          } catch (e) { board.release(it.id); say(''); fail(`Added ${label}, but the library could not be refreshed: ${e.message}`); continue; }
          say(filed(it));
          logFeed(it);
        } catch (e) { fail(`Something went wrong while adding an item: ${e.message}`); }
        finally { current = null; batchDone++; progress(); syncSubmits(); }
      }
    } finally { busy = false; current = null; setTimeout(() => { if (!busy) { batchTotal = batchDone = 0; progress(); } }, 900); }
  }
  const sendNote = (text) => () => api('/api/items', { method: 'POST', headers: JSON_H, body: JSON.stringify({ type: 'note', text }), signal: timeout(60000) });
  const sendUrl = (url) => () => api('/api/items', { method: 'POST', headers: JSON_H, body: JSON.stringify({ type: 'url', url }), signal: timeout(90000) });
  const sendFile = (f) => () => api(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f, signal: timeout(300000) });
  const MAX_FILE = 25 * 1024 * 1024; // the server's upload limit; refused here so nothing is sent that would be cut off
  const enqueueFile = (f) => {
    if (f.size > MAX_FILE) return fail(`“${f.name}” is larger than the 25 MiB limit per file, so it was not added.`);
    enqueue(f.name, sendFile(f), null, `file:${f.name}:${f.size}:${f.lastModified}`, 'file');
  };
  window.PacUI.isBusy = () => busy || queue.length > 0; // one busy check for the other scripts, instead of matching status text
  window.PacUI.addPasted = (text) => { // text pasted outside any field is queued directly, never through the note box or its draft
    const t = text.trim().slice(0, 100000); // the note box's limit
    if (!t) return;
    if (URLRE.test(t)) enqueue(t, sendUrl(t), null, `url:${t}`, 'url');
    else enqueue('note', sendNote(t), null, `note:${t}`, 'note', t);
  };

  $('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#note').value.trim();
    const link = URLRE.test(t); // a lone link goes down the link path; anything else is a note
    if (pendingOf(link ? 'url' : 'note')) return say(`A ${link ? 'link' : 'note'} is still being added. Wait for it to finish.`);
    if (!t) { $('#note').setAttribute('aria-invalid', 'true'); $('#note').focus(); return fail('The note is empty. Type something first.'); }
    const clear = () => { if ($('#note').value.trim() === t) $('#note').value = ''; }; // the server accepted it, so the field is cleared
    if (link) enqueue(t, sendUrl(t), clear, `url:${t}`, 'url');
    else enqueue('note', sendNote(t), clear, `note:${t}`, 'note', t);
  });
  $('#url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (pendingOf('url')) return say('A link is still being added. Wait for it to finish.');
    const u = $('#url').value.trim();
    if (!u) { $('#url').setAttribute('aria-invalid', 'true'); $('#url').focus(); return fail('The link is empty. Paste a link first.'); }
    enqueue(u, sendUrl(u), () => { if ($('#url').value.trim() === u) $('#url').value = ''; }, `url:${u}`, 'url');
  });
  [['#note', 'note'], ['#msg', 'question']].forEach(([s, what]) => $(s).addEventListener('paste', (e) => { // the browser silently cuts pasted text at maxlength, so say so
    const f = $(s), t = e.clipboardData && e.clipboardData.getData('text');
    if (t && f.maxLength > 0 && t.length > f.maxLength - (f.value.length - (f.selectionEnd - f.selectionStart))) fail(`The pasted text is longer than the ${f.maxLength.toLocaleString('en-US')} character limit for a ${what}, so the end was cut off.`);
  }));
  ['#note', '#url'].forEach((s) => $(s).addEventListener('input', () => $(s).removeAttribute('aria-invalid')));
  $('#note').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.repeat) { e.preventDefault(); $('#note-form').requestSubmit(); } });
  $('#pick').addEventListener('click', () => $('#files').click());
  $('#files').addEventListener('change', (e) => {
    [...e.target.files].forEach(enqueueFile);
    e.target.value = '';
  });

  const isEditable = (t) => t instanceof Element && t.closest('input, textarea');
  const hasType = (e, t) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].indexOf(t) >= 0;
  const hasFiles = (e) => hasType(e, 'Files');
  const dialogOpen = () => !!document.querySelector('dialog[open]');
  let hungryTimer;
  const setHungry = (v) => { board.setHungry(v); $('#board').classList.toggle('hungry', v); };
  addEventListener('dragover', (e) => {
    if (isEditable(e.target) && !hasFiles(e)) return; // text dragged into a field is just typing; files are always ours
    e.preventDefault(); // always cancelled, so a stray file drop never navigates away from the app
    if (dialogOpen()) { if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; return; }
    const onBelly = board.overBelly(e.clientX, e.clientY);
    const wanted = hasFiles(e) || hasType(e, 'text/uri-list') || onBelly; // plain text only gets the hungry glow over the belly
    if (e.dataTransfer) e.dataTransfer.dropEffect = wanted || hasType(e, 'text/plain') ? 'copy' : 'none';
    if (!wanted) return;
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
    if (dialogOpen()) return;
    feed(e.dataTransfer, board.overBelly(e.clientX, e.clientY));
  });
  function feed(dt, onBelly) {
    if (dt.files && dt.files.length) {
      const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
      [...dt.files].forEach((f, i) => {
        if (entries.length === dt.files.length && entries[i] && entries[i].isDirectory) return fail(`“${f.name}” is a folder. Drop the files inside it instead.`);
        enqueueFile(f);
      });
      return;
    }
    const text = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim();
    if (!text) return;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length && lines.every((l) => URLRE.test(l))) lines.forEach((u) => enqueue(u, sendUrl(u), null, `url:${u}`, 'url'));
    else if (onBelly) enqueue('dropped text', sendNote(text), null, `note:${text}`, 'note', text);
    else say('Dropped text ignored. Drop text on the belly to save it as a note, or drop a link or file anywhere.');
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
  function downloadCsv(r, what) {
    const url = URL.createObjectURL(new Blob([csvOf(r.rows)], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: `${r.kind}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Downloaded ${r.kind}.csv with ${r.rows.length} ${r.rows.length === 1 ? 'row' : 'rows'} (${what}).`);
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
      r.rows.length > shown.length && el('p', { class: 'meta' }, `Showing ${shown.length} of ${r.rows.length}. ${r.truncated ? `The CSV has the first ${r.rows.length}.` : 'The CSV has them all.'}`),
      r.truncated && el('p', { class: 'note' }, 'Capped at 500 results.'),
      el('button', { type: 'button', class: 'small', 'aria-label': `Download CSV, ${what}`, onclick: () => downloadCsv(r, what) }, 'Download CSV'));
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
  const clip = (s, max) => { // cut at a sentence end if there is one, else a word boundary, never mid-word
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (sentence > max / 3) return head.slice(0, sentence + 1);
    const space = head.lastIndexOf(' ');
    return (space > max / 3 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '') + '…';
  };
  const spoken = (r) => (r.mode === 'extract'
    ? clip(r.answer, 400) + (r.rows.length ? ' The table is in the conversation.' : '')
    : clip(r.answer.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim(), 400) + (r.sources && r.sources.length ? ` ${r.sources.length} sources listed.` : ''));

  const setBusy = (v) => { $('#send').disabled = v; document.querySelectorAll('.chips button').forEach((b) => { b.disabled = v; }); };
  async function ask(q, from) {
    const mine = convo;
    bubble('user', q);
    const pending = bubble('bot', 'Hunting…');
    setBusy(true);
    announce('Searching…');
    try {
      const r = await api('/api/ask', { method: 'POST', headers: JSON_H, body: JSON.stringify({ q, history: history.slice(-6) }), signal: timeout(110000) }); // longer than the server's 90 s model timeout, so a slow local model can finish
      if (mine !== convo) return; // "New chat" was pressed while this was in flight
      pending.remove();
      bubble('bot', ...renderAnswer(r));
      history.push({ role: 'user', content: q }, { role: 'assistant', content: String(r.answer || '').slice(0, 2000) });
      if (history.length > 6) history.splice(0, history.length - 6);
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
        if (!a || a === document.body || a === $('#msg') || a === $('#send') || (a.closest && a.closest('.chips'))) (from && from.isConnected ? from : $('#msg')).focus(); // a chip user stays on the chips
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
  document.querySelectorAll('.chips button').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q, b)));
  $('#clear').addEventListener('click', () => { convo++; setBusy(false); $('#log').replaceChildren(); history.length = 0; greeting(); announce('Chat cleared'); $('#msg').focus(); });

  let loadFailed = false;
  function load() { // first load and Retry: a failed items request must not look like an empty library
    const hadFocus = document.activeElement && document.activeElement.id === 'retry';
    say('Loading your library…');
    board.setEmptyText('Loading…');
    loadFailed = false;
    return refresh().then(() => {
      say('Ready.');
      if (hadFocus) $('#lib-h').focus();
    }).catch((e) => {
      loadFailed = true;
      board.setEmptyText('Could not load your library.');
      renderLibrary();
      say('');
      fail(e.message);
      if (hadFocus) $('#retry').focus();
    });
  }

  greeting();
  load();
})();
