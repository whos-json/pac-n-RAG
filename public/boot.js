// Loads the board and the app in order. Uses the 3D board when the browser can do WebGL and the user has not opted out,
// and quietly keeps the 2D board otherwise. app.js is unchanged either way: it only calls window.Board.create().
const load = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error(`Could not load ${src}`)); document.body.append(s); });

function webglOk() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}
function wants3d() {
  const q = new URLSearchParams(location.search).get('view');
  if (q === '2d' || q === '3d') { try { localStorage.setItem('pacrag.view', q); } catch (e) { /* preference just will not persist */ } return q === '3d'; }
  try { return localStorage.getItem('pacrag.view') !== '2d'; } catch (e) { return true; }
}

const switchView = (to) => { try { localStorage.setItem('pacrag.view', to); } catch (e) { /* the URL parameter below still works */ } location.search = `?view=${to}`; };
const wire = (is3d, canSwitch) => { // the "View" switch lives in index.html; this only labels and wires it
  const b = document.getElementById('view-toggle');
  if (!b) return;
  b.hidden = !canSwitch;
  b.setAttribute('aria-checked', String(is3d));
  b.addEventListener('click', () => switchView(is3d ? '2d' : '3d'));
};

function showFatal(msg) { // nothing else can render: say so visibly instead of leaving a blank page
  const n = document.createElement('div');
  n.setAttribute('role', 'alert');
  n.style.cssText = 'margin:2rem auto;max-width:36rem;padding:1rem 1.25rem;border:2px solid #b00020;border-radius:8px;background:#fff;color:#111;font:16px/1.4 system-ui,sans-serif';
  n.textContent = `${msg} Check your connection and reload the page (Ctrl+R) to try again.`;
  document.body.prepend(n);
}

try { await load('board.js'); } catch (e) {
  console.error(e);
  showFatal('The app could not start because a required file failed to load.');
  throw e;
}
if (wants3d() && webglOk()) {
  try {
    const { create } = await import('./board3d.js');
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'board3d.css'; document.head.append(link);
    const flat = window.Board.create;
    window.Board = {
      create(canvas, opts) {
        const host = canvas.parentElement;
        try {
          const b = create(host, opts);
          canvas.hidden = true; host.classList.add('is3d'); wire(true, true);
          return b;
        } catch (e) { console.warn('3D board unavailable, using the flat board.', e); wire(false, false); return flat(canvas, opts); }
      },
    };
  } catch (e) { console.warn('3D board failed to load, using the flat board.', e); wire(false, false); }
} else wire(false, webglOk()); // the user chose the flat board: offer the way back
try { await load('console.js'); } catch (e) { // tabs: the Add and Library panes stay hidden without it, so this one is required too
  console.error(e);
  showFatal('The app could not start because a required file failed to load.');
  throw e;
}
try { await load('app.js'); } catch (e) {
  console.error(e);
  showFatal('The app could not start because a required file failed to load.');
  throw e;
}
const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'onboard.css'; document.head.append(css);
await load('onboard.js').catch((e) => console.warn(e.message)); // guidance only: the app works without it
await load('feedback.js').catch((e) => console.warn(e.message)); // drop and add animations, also optional
