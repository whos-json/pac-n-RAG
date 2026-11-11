// The circuit-board maze: rooms are categories, pellets are items, the belly is where things get eaten.
// Purely visual. Everything it shows is also reachable through the DOM lists and the chat.
(function () {
  'use strict';
  const COL = { bg: '#07200f', trace: '#eafff1', glow: 'rgba(120,255,170,.65)', pellet: '#e0a030', orange: '#f5a623', cyan: '#3fc1f0', lilac: '#d9a8ff', gold: '#ffd35c' };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = (mq, fn) => { if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn); }; // old Safari only has addListener
  const TAU = Math.PI * 2;
  const TOP = 60; // room for the title bar and switches that float over the top of the board
  const PAD = 16, BELT = 170, MIN_ROOM = 120, GAP = 14; // BELT: space below the rooms for the bus, the belly and its caption

  function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

  function makeBg(w, h, dpr) {
    const c = document.createElement('canvas');
    c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = COL.bg; g.fillRect(0, 0, w, h);
    const r = rng(7), G = 14;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const traces = Math.floor((w * h) / 2400);
    for (let i = 0; i < traces; i++) {
      let x = Math.floor(r() * (w / G)) * G, y = Math.floor(r() * (h / G)) * G;
      g.strokeStyle = 'rgba(52,140,82,.26)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y);
      const n = 2 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const len = (1 + Math.floor(r() * 5)) * G, d = Math.floor(r() * 8) * Math.PI / 4;
        x += Math.round(Math.cos(d)) * len; y += Math.round(Math.sin(d)) * len; g.lineTo(x, y);
      }
      g.stroke(); g.fillStyle = 'rgba(52,140,82,.4)'; g.beginPath(); g.arc(x, y, 3, 0, TAU); g.fill();
    }
    g.strokeStyle = 'rgba(52,140,82,.35)'; g.lineWidth = 1.5;
    const chips = (w * h) / 38000;
    for (let i = 0; i < chips; i++) {
      const cw = 36 + Math.floor(r() * 3) * 12, ch = 14 + Math.floor(r() * 2) * 8, x = r() * (w - cw), y = r() * (h - ch);
      g.fillStyle = 'rgba(4,20,10,.7)'; g.fillRect(x, y, cw, ch); g.strokeRect(x, y, cw, ch);
      g.fillStyle = 'rgba(52,140,82,.5)';
      for (let p = 6; p < cw - 3; p += 8) { g.fillRect(x + p, y - 4, 3, 4); g.fillRect(x + p, y + ch, 3, 4); }
    }
    const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = v; g.fillRect(0, 0, w, h);
    return c;
  }

  function create(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, pw = 0, ph = 0, dpr = 1, bg = null, cats = [], rooms = [], index = new Map();
    let belly = { x: 0, y: 0, pad: 44, r: 26 }, corridorY = 0;
    const held = new Set(), glow = new Map();
    let actors = [], eating = 0, hungry = false, looping = false, last = 0, motionOn = true, onScreen = true, emptyText = 'The maze is empty. Feed the belly.';
    const narrow = window.matchMedia('(max-width: 820px)');
    let eatPulseUntil = 0;
    const calm = () => reduced.matches || !motionOn; // no continuous or travelling animation; highlights still show

    const needed = (width) => { // rooms never shrink below MIN_ROOM: the board grows and scrolls instead
      const n = Math.max(cats.length, 1), cols = Math.max(1, Math.min(n, Math.floor((width - PAD * 2) / 170))), rows = Math.ceil(n / cols);
      return TOP + rows * MIN_ROOM + (rows - 1) * GAP + BELT;
    };

    function resize() {
      pw = Math.max(240, canvas.parentElement.clientWidth);
      ph = Math.max(240, canvas.parentElement.clientHeight);
      apply();
    }
    function apply() {
      const nd = window.devicePixelRatio || 1, nw = pw;
      const nh = Math.min(Math.max(ph, needed(pw)), Math.max(ph, Math.floor(16e6 / (pw * nd * nd)))); // stay under phone canvas size limits
      if (nw !== w || nh !== h || nd !== dpr || !bg) {
        w = nw; h = nh; dpr = nd;
        canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bg = makeBg(w, h, dpr);
      }
      layout(); draw();
    }

    function layout() {
      const areaX = PAD, areaY = TOP, areaW = w - PAD * 2, areaH = Math.max(MIN_ROOM, h - BELT - TOP);
      corridorY = areaY + areaH + 18;
      belly = { x: w / 2, y: h - 84, pad: 44, r: 26 };
      index = new Map();
      const n = Math.max(cats.length, 1);
      const cols = Math.max(1, Math.min(n, Math.floor(areaW / 170)));
      const rowsN = Math.ceil(n / cols);
      const rw = (areaW - GAP * (cols - 1)) / cols, rh = (areaH - GAP * (rowsN - 1)) / rowsN;
      rooms = cats.map((cat, i) => {
        const room = { name: cat.name, x: areaX + (i % cols) * (rw + GAP), y: areaY + Math.floor(i / cols) * (rh + GAP), w: rw, h: rh };
        room.cx = room.x + rw / 2;
        const perRow = Math.max(1, Math.floor((rw - 28) / 24)), maxRows = Math.max(1, Math.floor((rh - 46) / 24)), cap = perRow * maxRows;
        const shown = cat.items.length > cap ? cap - 1 : cat.items.length;
        room.more = cat.items.length - shown;
        room.pellets = cat.items.slice(cat.items.length - shown).map((it, k) => { // a full room hides its oldest items, never the one just added
          const p = { id: it.id, title: it.title, review: it.review, x: room.x + 24 + (k % perRow) * 24, y: room.y + 42 + Math.floor(k / perRow) * 24, room };
          index.set(it.id, p);
          return p;
        });
        return room;
      });
    }

    function rr(x, y, ww, hh, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, ww, hh, r); else ctx.rect(x, y, ww, hh); }

    function chomper(x, y, r, color, mouth, ang) {
      ctx.save();
      ctx.translate(x, y);
      if (Math.cos(ang) < 0) { ctx.scale(-1, 1); ang = Math.PI - ang; }
      ctx.rotate(ang);
      // "Byte", our own mascot: a chip with a hinged lid, facing +x, hinged at the back. Lid and jaw swing apart by `mouth` (0..1).
      const hh = r * 0.62, sw = Math.max(0.02, mouth) * 0.7;
      const jaw = (upper) => {
        ctx.save(); ctx.translate(-r, 0); ctx.rotate(upper ? -sw : sw * 0.65); ctx.translate(r, 0);
        rr(-r, upper ? -hh : 0.05 * r, r * 2, hh, r * 0.22);
        ctx.shadowColor = color; ctx.shadowBlur = 14; ctx.fillStyle = color; ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff'; // teeth
        for (let i = 0; i < 4; i++) { const tx = r * 0.2 + i * r * 0.2, ty = upper ? 0 : 0.05 * r; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + r * 0.1, ty); ctx.lineTo(tx + r * 0.05, ty + (upper ? 1 : -1) * r * 0.2); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      };
      ctx.fillStyle = '#07200f'; rr(-r, -r * 0.05, r * 2, r * 0.1, 0); ctx.fill(); // the dark inside shows as the seam opens
      jaw(false); jaw(true);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r * 0.3, -hh - r * 0.05, Math.max(2.5, r * 0.2), 0, TAU); ctx.fill(); // eye on the lid
      ctx.fillStyle = '#07200f'; ctx.beginPath(); ctx.arc(r * 0.38, -hh - r * 0.05, Math.max(1.2, r * 0.09), 0, TAU); ctx.fill();
      ctx.fillStyle = color; [-0.6, 0.6].forEach((px) => ctx.fillRect(px * r - r * 0.07, hh + r * 0.05, r * 0.14, r * 0.22)); // pin legs
      ctx.restore();
    }

    function drawCorridors() {
      if (!rooms.length) return;
      ctx.save();
      ctx.strokeStyle = COL.trace; ctx.lineWidth = 3; ctx.shadowColor = COL.glow; ctx.shadowBlur = 10; ctx.globalAlpha = 0.85;
      const xs = rooms.map((r) => r.cx).concat(belly.x);
      ctx.beginPath();
      ctx.moveTo(Math.min.apply(null, xs), corridorY); ctx.lineTo(Math.max.apply(null, xs), corridorY);
      rooms.forEach((r) => { ctx.moveTo(r.cx, r.y + r.h); ctx.lineTo(r.cx, corridorY); });
      ctx.moveTo(belly.x, corridorY); ctx.lineTo(belly.x, belly.y - belly.pad);
      ctx.stroke();
      ctx.fillStyle = COL.trace;
      rooms.forEach((r) => { ctx.beginPath(); ctx.arc(r.cx, corridorY, 4.5, 0, TAU); ctx.fill(); });
      ctx.restore();
    }

    function drawRooms() {
      ctx.save();
      if (!rooms.length) {
        const ah = Math.max(MIN_ROOM, h - BELT - TOP);
        ctx.setLineDash([8, 8]); ctx.strokeStyle = 'rgba(234,255,241,.45)'; ctx.lineWidth = 2;
        rr(PAD, TOP, w - PAD * 2, ah, 14); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(234,255,241,.7)'; ctx.font = '600 14px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center';
        ctx.fillText(emptyText, w / 2, TOP + ah / 2);
        ctx.restore(); return;
      }
      rooms.forEach((r) => {
        rr(r.x, r.y, r.w, r.h, 12);
        ctx.fillStyle = 'rgba(5,25,12,.78)'; ctx.fill();
        ctx.strokeStyle = COL.trace; ctx.lineWidth = 2.5; ctx.shadowColor = COL.glow; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;
        ctx.fillStyle = COL.orange; ctx.font = '700 12px ui-monospace, Consolas, monospace'; ctx.textAlign = 'left';
        let label = r.name;
        while (label.length > 3 && ctx.measureText(label).width > r.w - 28) label = label.slice(0, -2);
        ctx.fillText(label === r.name ? label : label + '…', r.x + 14, r.y + 22);
        if (r.more > 0) { ctx.fillStyle = COL.trace; ctx.fillText('+' + r.more, r.x + r.w - 14 - ctx.measureText('+' + r.more).width, r.y + r.h - 10); }
      });
      ctx.restore();
    }

    function drawPellets(ts) {
      const now = Date.now();
      let anyReview = false;
      rooms.forEach((r) => r.pellets.forEach((p) => {
        if (held.has(p.id)) return;
        const until = glow.get(p.id);
        const lit = until && until > now;
        if (until && !lit) glow.delete(p.id);
        const rad = lit ? 8 + (calm() ? 0 : Math.sin(ts / 120) * 1.5) : 5.5;
        ctx.save();
        if (lit) { ctx.shadowColor = COL.gold; ctx.shadowBlur = 18; }
        const g = ctx.createRadialGradient(p.x - 1.5, p.y - 1.5, 1, p.x, p.y, rad);
        g.addColorStop(0, lit ? '#fff6c8' : '#ffe2a0'); g.addColorStop(1, lit ? COL.gold : COL.pellet);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, TAU); ctx.fill();
        if (p.review) {
          anyReview = true;
          ctx.shadowBlur = 0; ctx.strokeStyle = COL.lilac; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 9 + (calm() ? 0 : Math.sin(ts / 260) * 1.5), 0, TAU); ctx.stroke();
        }
        ctx.restore();
      }));
      if (anyReview) { // legend for the lilac ring
        const ly = corridorY + 14; // just under the bus, clear of the belly caption
        ctx.save(); ctx.strokeStyle = COL.lilac; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(PAD + 6, ly - 4, 6, 0, TAU); ctx.stroke();
        ctx.fillStyle = 'rgba(234,255,241,.75)'; ctx.font = '600 11px ui-monospace, Consolas, monospace'; ctx.textAlign = 'left';
        ctx.fillText('not sure where this belongs', PAD + 18, ly); ctx.restore();
      }
    }

    function drawBelly(ts) {
      const { x, y, pad, r } = belly;
      ctx.save();
      rr(x - pad, y - pad, pad * 2, pad * 2, 10);
      ctx.fillStyle = '#0a3a1c'; ctx.fill();
      ctx.strokeStyle = hungry ? COL.gold : COL.trace; ctx.lineWidth = 3; ctx.shadowColor = hungry ? COL.gold : COL.glow; ctx.shadowBlur = hungry ? 22 : 12; ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(234,255,241,.55)';
      for (let i = -3; i <= 3; i++) {
        ctx.fillRect(x + i * 11 - 2, y - pad - 6, 4, 6); ctx.fillRect(x + i * 11 - 2, y + pad, 4, 6);
        ctx.fillRect(x - pad - 6, y + i * 11 - 2, 6, 4); ctx.fillRect(x + pad, y + i * 11 - 2, 6, 4);
      }
      ctx.restore();
      const m = performance.now() < eatPulseUntil ? Math.abs(Math.sin(ts / 60)) * 0.95 : hungry ? 0.95 : calm() ? (eating ? 0.85 : 0.5) : eating ? Math.abs(Math.sin(ts / 110)) * 0.95 : (0.5 + 0.5 * Math.sin(ts / 500)) * 0.6 + 0.08;
      chomper(x, y, r * 1.05, COL.orange, Math.max(0.04, m), 0);
      ctx.save(); ctx.fillStyle = hungry ? COL.gold : 'rgba(234,255,241,.7)'; ctx.font = '600 11px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center';
      ctx.fillText(hungry ? 'RELEASE TO FEED' : 'DROP FILES, TEXT OR LINKS HERE', x, y + pad + 22);
      ctx.restore();
    }

    function pointAt(a, d) {
      let i = 1;
      while (i < a.cum.length - 1 && a.cum[i] < d) i++;
      const seg = a.cum[i] - a.cum[i - 1] || 1, t = Math.min(1, Math.max(0, (d - a.cum[i - 1]) / seg));
      const p0 = a.pts[i - 1], p1 = a.pts[i];
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t, ang: Math.atan2(p1.y - p0.y, p1.x - p0.x) };
    }

    function drawActors(ts) {
      actors.forEach((a) => {
        const pos = pointAt(a, Math.min(a.d, a.total));
        ctx.save();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (let i = 1; i < a.trail.length; i++) {
          ctx.globalAlpha = (i / a.trail.length) * 0.55; ctx.strokeStyle = a.color; ctx.lineWidth = a.r * 1.1;
          ctx.beginPath(); ctx.moveTo(a.trail[i - 1].x, a.trail[i - 1].y); ctx.lineTo(a.trail[i].x, a.trail[i].y); ctx.stroke();
        }
        ctx.restore();
        if (a.dot) { ctx.save(); ctx.fillStyle = a.color; ctx.shadowColor = a.color; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(pos.x, pos.y, a.r, 0, TAU); ctx.fill(); ctx.restore(); }
        else chomper(pos.x, pos.y, a.r, a.color, Math.abs(Math.sin(ts / 80)) * 0.9 + 0.05, pos.ang);
      });
    }

    function draw(ts) {
      if (!w) return;
      ts = ts || performance.now();
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bg, 0, 0, w, h);
      drawCorridors(); drawRooms(); drawPellets(ts); drawBelly(ts); drawActors(ts);
    }

    function frame(ts) {
      const dt = Math.min(0.05, (ts - last) / 1000 || 0);
      last = ts;
      actors.forEach((a) => {
        a.d += a.speed * dt;
        while (a.stops.length && a.d >= a.stops[0].d) flash([a.stops.shift().id], 2500);
        const p = pointAt(a, Math.min(a.d, a.total));
        a.trail.push({ x: p.x, y: p.y });
        if (a.trail.length > 36) a.trail.shift();
      });
      const finished = actors.filter((a) => a.d >= a.total);
      actors = actors.filter((a) => a.d < a.total);
      finished.forEach((a) => a.done && a.done());
      draw(ts);
      // an idle redraw has nothing to show while the tab is hidden or the board is scrolled off-screen, so the loop pauses and kick() resumes it
      if (actors.length || eating || hungry || (!calm() && !document.hidden && onScreen)) requestAnimationFrame(frame); else looping = false;
    }
    function kick() { if (!looping) { looping = true; last = performance.now(); requestAnimationFrame(frame); } }

    function exitPts(loc) {
      if (loc === 'belly') return [{ x: belly.x, y: belly.y }, { x: belly.x, y: corridorY }];
      const p = index.get(loc);
      return [{ x: p.x, y: p.y }, { x: p.room.cx, y: p.y }, { x: p.room.cx, y: corridorY }];
    }
    function route(from, to) { return exitPts(from).concat(exitPts(to).reverse()); }
    function makeActor(pts, extra) {
      const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
      const cum = [0];
      for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y));
      return Object.assign({ pts: clean, cum, total: cum[cum.length - 1] || 1, d: 0, trail: [], stops: [], speed: 420 }, extra);
    }

    function flash(ids, ms) {
      const until = Date.now() + (ms || 3500);
      ids.forEach((id) => glow.set(id, until));
      draw();
      setTimeout(() => draw(), (ms || 3500) + 60);
    }

    const showBelly = () => { const p = canvas.parentElement; if (p.scrollHeight > p.clientHeight) p.scrollTop = p.scrollHeight; }; // on a phone the belly sits below the fold
    const showRoom = (id) => { // on a phone, bring the first visited room into view instead of hiding it behind the belly
      const p = canvas.parentElement, pt = index.get(id);
      if (pt && p.scrollHeight > p.clientHeight) p.scrollTop = Math.max(0, pt.room.y - 16);
    };
    const api = {
      setData(data) { cats = data; apply(); },
      setHungry(v) { if (hungry === v) return; hungry = v; if (v) kick(); draw(); },
      setMotion(on) { motionOn = on; kick(); draw(); },
      setEmptyText(t) { emptyText = t || 'The maze is empty. Feed the belly.'; draw(); },
      bellyPoint() { const r = canvas.getBoundingClientRect(); return { x: r.left + belly.x, y: r.top + belly.y }; },
      pulse() { eatPulseUntil = performance.now() + 600; kick(); },
      overBelly(clientX, clientY) { // is this screen point on the belly (generous mouth area)?
        const r = canvas.getBoundingClientRect();
        return Math.hypot(clientX - r.left - belly.x, clientY - r.top - belly.y) <= belly.pad + 36;
      },
      hold(id) { held.add(id); },
      release(id) { held.delete(id); draw(); },
      digest(promise) {
        eating++;
        showBelly();
        if (calm()) draw(); else kick();
        const quick = calm() || document.hidden; // background tabs pause animation frames, so do not wait on them
        const min = quick ? Promise.resolve() : new Promise((r) => setTimeout(r, 800));
        return Promise.all([promise, min]).then((v) => v[0]).finally(() => { eating--; draw(); });
      },
      deliver(id) {
        if (calm() || document.hidden || !index.has(id)) { held.delete(id); draw(); return Promise.resolve(); }
        return new Promise((resolve) => {
          let finished = false;
          const fin = () => { if (finished) return; finished = true; held.delete(id); flash([id], 1800); resolve(); };
          actors.push(makeActor(route('belly', id), { color: COL.orange, r: 7, dot: true, speed: 520, done: fin }));
          setTimeout(fin, 4000); // never leave the queue waiting on an animation
          kick();
        });
      },
      run(ids) {
        const targets = ids.filter((id) => index.has(id));
        if (!targets.length) return Promise.resolve();
        if (calm() || document.hidden) { flash(targets); return Promise.resolve(); }
        if (narrow.matches) showRoom(targets[0]); else showBelly();
        let pts = exitPts('belly'), at = 'belly';
        const stopIdx = [];
        targets.forEach((id) => { pts = pts.concat(route(at, id).slice(exitPts(at).length)); stopIdx.push({ id, i: pts.length - 1 }); at = id; });
        pts = pts.concat(exitPts(at).slice(1).concat(exitPts('belly').reverse()));
        const a = makeActor(pts, { color: COL.cyan, r: 11 });
        // makeActor drops zero-length points, so recompute stop distances from the original polyline
        const full = [0];
        for (let i = 1; i < pts.length; i++) full.push(full[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        a.stops = stopIdx.map((s) => ({ id: s.id, d: full[s.i] }));
        a.speed = Math.max(420, a.total / 3.5);
        return new Promise((resolve) => { a.done = resolve; actors.push(a); kick(); });
      },
      flash,
    };

    canvas.addEventListener('mousemove', (e) => {
      let hit = null;
      index.forEach((p) => { if (!held.has(p.id) && Math.hypot(p.x - e.offsetX, p.y - e.offsetY) < 11) hit = p; });
      canvas.title = hit ? `${hit.title} (${hit.room.name})` : '';
      canvas.style.cursor = hit ? 'pointer' : '';
    });
    canvas.addEventListener('click', (e) => {
      index.forEach((p) => { if (!held.has(p.id) && Math.hypot(p.x - e.offsetX, p.y - e.offsetY) < 11 && opts.onPellet) opts.onPellet(p.id); });
    });
    // the canvas is aria-hidden: the library list and chat are the accessible paths to everything it shows
    let pending = false;
    new ResizeObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; resize(); }); }).observe(canvas.parentElement);
    onChange(reduced, () => { kick(); draw(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { kick(); draw(); } });
    if (window.IntersectionObserver) new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; if (onScreen) { kick(); draw(); } }).observe(canvas);
    resize();
    kick();
    return api;
  }

  window.Board = { create };
})();
