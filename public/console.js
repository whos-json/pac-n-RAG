// The bottom console: Ask / Add / Library as tabs of one panel. Pure DOM; app.js keeps working with the same element ids.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const NAMES = ['ask', 'add', 'lib'];
  let current = 'ask', chosen = false; // chosen: the user picked a tab themselves, so suggestions stop

  function show(name, focus, byUser) {
    if (!NAMES.includes(name)) return;
    if (byUser) chosen = true;
    current = name;
    NAMES.forEach((n) => {
      const on = n === name;
      $(`#tab-${n}`).setAttribute('aria-selected', String(on));
      $(`#tab-${n}`).tabIndex = on ? 0 : -1;
      $(`#pane-${n}`).hidden = !on;
    });
    if (focus) {
      const t = name === 'ask' ? $('#msg') : name === 'add' ? $('#note') : ($('#lib-filter-wrap').hidden ? $('#lib-h') : $('#lib-filter'));
      if (t) t.focus();
    }
  }
  window.PacUI = {
    show: (n, focus) => show(n, focus, true),
    suggest: (n) => { if (!chosen && current !== n) show(n, false, false); }, // first-run nudge, never overrides a choice
    get current() { return current; },
  };

  NAMES.forEach((n) => $(`#tab-${n}`).addEventListener('click', () => show(n, true, true)));
  $('.tabs').addEventListener('keydown', (e) => { // arrow keys move between tabs, like any tab list
    const i = NAMES.indexOf(current);
    let to = null;
    if (e.key === 'ArrowRight') to = NAMES[(i + 1) % NAMES.length];
    else if (e.key === 'ArrowLeft') to = NAMES[(i + NAMES.length - 1) % NAMES.length];
    else if (e.key === 'Home') to = NAMES[0];
    else if (e.key === 'End') to = NAMES[NAMES.length - 1];
    if (!to) return;
    e.preventDefault(); show(to, false, true); $(`#tab-${to}`).focus();
  });
  [['.skip:not(.skip2)', 'ask'], ['.skip2', 'add']].forEach(([sel, to]) => { // skip links: the target pane may be hidden, so show it first
    const a = document.querySelector(sel);
    if (a) a.addEventListener('click', (e) => { e.preventDefault(); show(to, true, true); });
  });
  addEventListener('keydown', (e) => { // Alt+/ asks; ignored while a dialog has the keyboard. One handler only (app.js has none).
    if (e.key !== '/' || !e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return;
    e.preventDefault(); show('ask', true, true);
  }, true);

  // counts on the Library tab
  function badges() {
    $('#lib-badge').textContent = String(document.querySelectorAll('#library li[id]').length);
    const g = document.querySelectorAll('#review li[id]').length;
    const gb = $('#lib-ghosts');
    gb.hidden = !g; gb.textContent = `${g} unsure`;
  }
  new MutationObserver(badges).observe($('#library'), { childList: true, subtree: true });
  new MutationObserver(badges).observe($('#review'), { childList: true });
  badges();
})();
