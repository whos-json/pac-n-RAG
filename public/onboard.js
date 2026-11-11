// First-run guidance and paste-anywhere, layered on top of app.js through the DOM so it never touches the feed logic.
//  - Empty library: a short three-step card over the board, with the two things a new user needs (choose files, try a sample).
//  - Paste anywhere (outside a text field): files, a link or text are fed in as if they had been dropped.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const board = $('#board'), root = document.documentElement;
  if (!board) return;

  const SAMPLE = 'Dentist appointment with Dr. Rivera on 14 March 2027 at 9:30. The check-up costs about $120. Call 555-123-4567 or email rivera@example.com to move it. Remember to bring the insurance card.';

  const card = document.createElement('section');
  card.id = 'welcome'; card.className = 'welcome'; card.setAttribute('aria-labelledby', 'welcome-h'); card.hidden = true;
  card.innerHTML = '<h2 id="welcome-h">Start here</h2>'
    + '<ol class="steps">'
    + '<li><b>Feed it.</b> Drop files anywhere, or paste a note or a link.</li>'
    + '<li><b>Watch it file itself.</b> Each item lands in a room on the grid, grouped by topic.</li>'
    + '<li><b>Ask.</b> Questions get answers with sources. “Extract dates” builds a table you can download.</li>'
    + '</ol>'
    + '<div class="welcome-actions"><button type="button" id="welcome-files">Choose files…</button><button type="button" id="welcome-sample" class="ghost">Try a sample note</button></div>'
    + '<p class="help">Everything stays on this computer.</p>';
  board.append(card);

  $('#welcome-files').addEventListener('click', () => $('#pick').click());
  $('#welcome-sample').addEventListener('click', () => {
    const note = $('#note');
    note.value = SAMPLE;
    note.dispatchEvent(new Event('input', { bubbles: true }));
    $('#note-form').requestSubmit();
  });

  // "empty" means: the library has rendered and says there is nothing in it (not a failed load, not still loading)
  function sync() {
    const lib = $('#library');
    const loaded = lib && lib.children.length > 0;
    const empty = loaded && !$('#retry') && $('#lib-filter-wrap') && $('#lib-filter-wrap').hidden;
    card.hidden = !empty;
    root.classList.toggle('is-empty', !!empty);
    if (empty && window.PacUI) window.PacUI.suggest('add'); // nothing to ask yet: open on the Add tab
  }
  new MutationObserver(sync).observe($('#library'), { childList: true });
  new MutationObserver(sync).observe($('#lib-filter-wrap'), { attributes: true, attributeFilter: ['hidden'] });
  sync();


  // Toasts fade after a few seconds; the text stays in the live region and the sidebar keeps no copy.
  const status = $('#status');
  let fadeTimer;
  new MutationObserver(() => {
    status.classList.remove('fade'); clearTimeout(fadeTimer);
    if (status.textContent) { status.classList.remove('pop'); void status.offsetWidth; status.classList.add('pop'); } // arrives whole from above, never pops
    if (window.PacUI && window.PacUI.isBusy()) return; // keep progress messages up while work is running
    fadeTimer = setTimeout(() => status.classList.add('fade'), 6000);
  }).observe(status, { childList: true, characterData: true, subtree: true });
  addEventListener('paste', (e) => {
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable], dialog')) return; // a normal paste into a field
    const dt = e.clipboardData;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      e.preventDefault();
      const input = $('#files');
      try { input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) { /* browser refuses to set files: nothing was lost, the user can drop them instead */ }
      return;
    }
    const text = (dt.getData('text/plain') || '').trim();
    if (!text) return;
    e.preventDefault();
    window.PacUI.addPasted(text); // queued directly by app.js: the note box and its unsent draft are left alone
  });
})();
