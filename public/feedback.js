// Motion feedback for feeding: whatever the app accepts (dropped, pasted, typed or chosen) flies from where it came from into the core, and the core reacts.
// Purely visual and additive: it listens to events, never changes what the app does, and does nothing when animation is off.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const calm = () => reducedQuery.matches || $('#motion').getAttribute('aria-checked') === 'false' || document.hidden;
  // Lucide (ISC) glyphs, one family and one stroke width, as the design rules ask
  const PATHS = {
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    text: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  };
  const icon = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[kind] || PATHS.file}</svg>`;
  const KIND_COLOR = { file: '#3fc1f0', text: '#d9a8ff', link: '#ffd35c' };
  const board = () => window.pacBoard;

  const corePoint = () => {
    const b = board();
    if (b && b.bellyPoint) { const p = b.bellyPoint(); if (p) return p; }
    const r = $('#board').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.72 };
  };
  const centerOf = (el) => {
    const r = el && el.getBoundingClientRect();
    if (r && r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const c = $('#console').getBoundingClientRect(); // the source is in a hidden tab: start from the top edge of the console
    return { x: c.left + c.width / 2, y: c.top };
  };
  const short = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return short(u, 24); } };

  function ripple(at, kind) {
    for (let i = 0; i < 2; i++) {
      const r = document.createElement('div');
      r.className = 'ring'; r.style.left = at.x + 'px'; r.style.top = at.y + 'px'; r.style.setProperty('--c', KIND_COLOR[kind] || '#f5a623');
      r.style.animationDelay = `${i * 140}ms`;
      document.body.append(r);
      r.addEventListener('animationend', () => r.remove());
    }
    const b = board();
    if (b && b.pulse) b.pulse();
  }

  // delay: stagger for several items at once
  function fly(from, label, kind, delay) {
    if (calm()) return;
    const to = corePoint();
    const dx = to.x - from.x, dy = to.y - from.y;
    const lift = Math.min(140, 40 + Math.abs(dy) * 0.25);
    const frames = (s) => [
      { transform: `translate(${from.x}px, ${from.y}px) translate(-50%, -50%) scale(1)`, opacity: 1 * s, offset: 0 },
      { transform: `translate(${from.x + dx * 0.55}px, ${from.y + dy * 0.45 - lift}px) translate(-50%, -50%) scale(1.06) rotate(-5deg)`, opacity: 1 * s, offset: 0.55 },
      { transform: `translate(${to.x}px, ${to.y}px) translate(-50%, -50%) scale(.12) rotate(8deg)`, opacity: 0.15, offset: 1 },
    ];
    const DUR = 820;
    for (let i = 3; i >= 0; i--) { // the lead flyer plus three fading afterimages
      const el = document.createElement('div');
      el.className = `flyer ${kind}${i ? ' ghost' : ''}`;
      el.style.setProperty('--c', KIND_COLOR[kind] || '#f5a623');
      if (!i) { el.innerHTML = icon(kind); const t = document.createElement('span'); t.textContent = label; el.append(t); }
      el.setAttribute('aria-hidden', 'true');
      document.body.append(el);
      const a = el.animate(frames(i ? 0.35 - i * 0.08 : 1), { duration: DUR, delay: (delay || 0) + i * 55, easing: 'cubic-bezier(0.45, 0, 0.1, 1)', fill: 'backwards' });
      const done = () => { el.remove(); if (!i) ripple(to, kind); };
      a.onfinish = done; a.oncancel = () => el.remove();
    }
  }
  // Where the latest drop, paste, note or file choice came from. The flyer starts there, but only once the app has accepted the item.
  let origin = null;
  addEventListener('drop', (e) => { origin = { x: e.clientX, y: e.clientY }; }, true);
  addEventListener('paste', () => { origin = centerOf($('#note')); }, true);
  addEventListener('submit', (e) => { if (e.target && e.target.id === 'note-form') origin = centerOf($('#note')); }, true);
  $('#files').addEventListener('change', () => { origin = centerOf($('#pick')); });

  // ---- the app accepted an item (duplicates and failures never get here): it flies into the core ----
  const KIND = { note: 'text', url: 'link', file: 'file' };
  addEventListener('pacrag:filed', (e) => {
    const { kind, shown } = e.detail;
    fly(origin || centerOf(null), kind === 'url' ? host(shown) : short(shown, 22), KIND[kind] || 'file');
  });

})();
