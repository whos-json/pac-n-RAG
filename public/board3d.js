// A holographic 3D version of the board. Same API as board.js, rendered with three.js (vendored in ./vendor, so nothing is fetched from the web).
// Decorative only: everything shown here is reachable from the library list and the chat.
import * as THREE from './vendor/three/build/three.module.js';
import { EffectComposer } from './vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from './vendor/three/examples/jsm/postprocessing/SMAAPass.js';
import { Reflector } from './vendor/three/examples/jsm/objects/Reflector.js';
import { roomColor, roomGlass, lightShaft, skyline, skyTexture, makeCinePass, parseQuality, Adaptive } from './fx3d.js';

const C = { bg: 0x010a06, edge: 0x4dffb4, glass: 0x0b5a37, street: 0x22c477, floor: 0x1fd58a, pellet: 0xffd98a, gold: 0xffd35c, orange: 0xf5a623, cyan: 0x3fc1f0, lilac: 0xd9a8ff };
const RW = 9, RD = 6.4, GAP = 1.8, SP = 1.05, RH = 1.1, FLY = 0.9, BELLY_GAP = 7; // world units
const TAU = Math.PI * 2;
const ELEV = 60 * Math.PI / 180;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeBack = (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// "Byte": our own mascot, a chip with a hinged lid. A box split along a seam, hinged at the back, with teeth, two eyes and pin legs.
// It faces +x. open(0..1) swings the lid and the jaw apart.
const BYTE_GEO = {};
function makeChomper(color, r) {
  const group = new THREE.Group();
  const w = r * 2, h = r * 0.62, d = r * 1.7;
  const key = r.toFixed(3);
  const g = BYTE_GEO[key] || (BYTE_GEO[key] = {
    box: new THREE.BoxGeometry(w, h, d), tooth: new THREE.ConeGeometry(r * 0.12, r * 0.3, 4), eye: new THREE.SphereGeometry(r * 0.2, 16, 12),
    pupil: new THREE.SphereGeometry(r * 0.09, 10, 8), pin: new THREE.BoxGeometry(r * 0.16, r * 0.3, r * 0.16),
  });
  if (!g.edges) { g.edges = new THREE.EdgesGeometry(g.box); }
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.32, roughness: 0.5, metalness: 0.1 });
  const inside = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.3) });
  const line = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
  const white = new THREE.MeshBasicMaterial({ color: 0xdde8e0 }), dark = new THREE.MeshBasicMaterial({ color: 0x06140c });
  const hinge = w / 2;
  const tint = new THREE.Color(color);
  const jaw = (upper) => {
    const pivot = new THREE.Group(); pivot.position.x = -hinge;
    const inner = new THREE.Group(); inner.position.x = hinge;
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z. The face on the seam shows the dark inside when the mouth opens.
    const faces = [mat, mat, upper ? mat : inside, upper ? inside : mat, mat, mat];
    const body = new THREE.Mesh(g.box, faces); body.position.y = upper ? h / 2 : -h / 2;
    const edge = new THREE.LineSegments(g.edges, line); edge.position.copy(body.position);
    inner.add(body, edge);
    for (let i = 0; i < 5; i++) { // teeth along the front edge, pointing at the other jaw
      const t = new THREE.Mesh(g.tooth, white);
      t.position.set(w / 2 - r * 0.1, upper ? -r * 0.1 : r * 0.1, (i - 2) * r * 0.3);
      if (upper) t.rotation.z = Math.PI;
      inner.add(t);
    }
    pivot.add(inner); group.add(pivot);
    return { pivot, inner };
  };
  const up = jaw(true), low = jaw(false);
  [-1, 1].forEach((s) => { // eyes on the lid
    const eye = new THREE.Mesh(g.eye, white); eye.position.set(r * 0.3, h + r * 0.12, s * r * 0.45);
    const pupil = new THREE.Mesh(g.pupil, dark); pupil.position.set(r * 0.17, r * 0.03, 0); eye.add(pupil);
    up.inner.add(eye);
    [-1, 1].forEach((t) => { const pin = new THREE.Mesh(g.pin, mat); pin.position.set(t * r * 0.6, -h - r * 0.1, s * r * 0.5); low.inner.add(pin); });
  });
  return {
    group, mat,
    open(a) { up.pivot.rotation.z = a * 0.7; low.pivot.rotation.z = -a * 0.45; },
    color(c) { mat.color.setHex(c); mat.emissive.setHex(c); inside.color.setHex(c).multiplyScalar(0.3); },
  };
}

export function create(host, opts) {
  opts = opts || {};
  const canvas = document.createElement('canvas');
  canvas.className = 'board3d';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); // throws without WebGL; the caller falls back to the 2D board
  const Q = parseQuality(); // ?quality=low|high|ultra, ?adaptive=0, ?hud=1
  if (Q.tier === 'ultra' && matchMedia('(pointer: coarse)').matches) Q.tier = 'high'; // phones and tablets skip the mirror floor
  const MAX_PX = Q.tier === 'ultra' ? 4e6 : 2.4e6; // never render more pixels than this, whatever the screen: huge HDR targets are what lose a GPU context
  const maxPR = Math.min(window.devicePixelRatio || 1, Q.tier === 'ultra' ? 2 : 1.5);
  let basePR = maxPR;
  renderer.setPixelRatio(basePR);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
  host.append(canvas);
  const labels = document.createElement('div'); labels.className = 'b3d-labels'; labels.setAttribute('aria-hidden', 'true');
  const tip = document.createElement('div'); tip.className = 'b3d-tip'; tip.setAttribute('aria-hidden', 'true'); tip.hidden = true;
  host.append(labels, tip);

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 600);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(6, 14, 10); scene.add(sun);

  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: Q.tier === 'low' ? 0 : Q.tier === 'high' ? 2 : 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(basePR);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.55, 0.6, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const cine = makeCinePass(); composer.addPass(cine);
  const smaa = Q.tier === 'low' ? null : new SMAAPass(); if (smaa) composer.addPass(smaa);

  const glowTex = glowTexture();
  const world = new THREE.Group(); scene.add(world);
  const roomsG = new THREE.Group(), streetsG = new THREE.Group(), actorsG = new THREE.Group(), fxG = new THREE.Group();
  world.add(streetsG, roomsG, actorsG, fxG);

  // ---- floor grid with a radar sweep ----
  const floorMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 }, uC: { value: new THREE.Color(C.floor) }, uO: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `varying vec3 vW; uniform float uT; uniform vec3 uC; uniform vec2 uO;
      float grid(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main(){
        vec2 p = vW.xz; float d = length(p - uO);
        float a = grid(p, 2.0) * 0.30 + grid(p, 10.0) * 0.55;
        float fade = smoothstep(75.0, 6.0, d);
        float sweep = smoothstep(3.0, 0.0, abs(d - mod(uT * 10.0, 100.0)));
        gl_FragColor = vec4(uC * fade * (a * (0.5 + sweep * 1.2) + sweep * 0.10), 1.0);
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2), floorMat);
  floor.position.y = -0.03; floor.frustumCulled = false; floor.renderOrder = 2; scene.add(floor);

  // ---- glossy mirror floor (ultra only): the rooms, the core and the skyline reflect in it ----
  let reflector = null;
  if (Q.tier === 'ultra') {
    reflector = new Reflector(new THREE.PlaneGeometry(420, 420), { color: 0xb4d4c4, textureWidth: 640, textureHeight: 360, clipBias: 0.003, multisample: 0 });
    reflector.rotation.x = -Math.PI / 2; reflector.position.y = -0.08; reflector.frustumCulled = false; scene.add(reflector);
  }

  // ---- the far city and its haze ----
  const city = skyline(7); scene.add(city);
  const roomMats = [], shafts = [];
  const orbitN = 140, orbitPos = new Float32Array(orbitN * 3), orbitGeo = new THREE.BufferGeometry();
  orbitGeo.setAttribute('position', new THREE.BufferAttribute(orbitPos, 3));
  let halo = null, haloCol = null;
  let shake = 0;

  // ---- ambient dust ----
  const DUST = 260, dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) { dustPos[i * 3] = (Math.random() - 0.5) * 90; dustPos[i * 3 + 1] = Math.random() * 14; dustPos[i * 3 + 2] = (Math.random() - 0.5) * 70; }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.16, map: glowTex, color: C.edge, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
  dust.frustumCulled = false; scene.add(dust);

  // ---- shared geometry and materials ----
  const boxGeo = new THREE.BoxGeometry(RW, RH, RD);
  const edgeGeo = new THREE.EdgesGeometry(boxGeo);
  const fillMat = new THREE.MeshBasicMaterial({ color: C.glass, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const fillGhost = fillMat.clone(); fillGhost.opacity = 0.07;
  const edgeMat = new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.95 });
  const edgeGhost = new THREE.LineBasicMaterial({ color: C.edge, transparent: true, opacity: 0.3 });
  const streetMat = new THREE.MeshBasicMaterial({ color: C.street, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const pelletGeo = new THREE.IcosahedronGeometry(0.27, 1);
  const pelletMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ringGeo = new THREE.TorusGeometry(0.46, 0.035, 8, 28);
  const ringMat = new THREE.MeshBasicMaterial({ color: C.lilac });
  const burstGeo = new THREE.RingGeometry(0.92, 1, 56);
  const orbGeo = new THREE.SphereGeometry(1, 20, 12);
  const trailMat = new THREE.PointsMaterial({ size: 0.7, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const cPellet = new THREE.Color(C.pellet).multiplyScalar(1.5), cGold = new THREE.Color(C.gold).multiplyScalar(2);
  const haloMat = new THREE.PointsMaterial({ size: 1.5, map: glowTex, vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending });
  const orbit = new THREE.Points(orbitGeo, new THREE.PointsMaterial({ size: 0.34, map: glowTex, color: C.orange, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }));
  orbit.frustumCulled = false;

  // ---- the core ("belly") ----
  const core = new THREE.Group(); scene.add(core);
  const coreChomper = makeChomper(C.orange, 2.1); coreChomper.group.position.y = 2.9; coreChomper.group.rotation.x = 0.2; coreChomper.group.rotation.y = -Math.PI / 2; core.add(coreChomper.group); // mouth toward the viewer
  const hexGeo = new THREE.CylinderGeometry(3.6, 4, 0.35, 6);
  const hexMat = new THREE.MeshBasicMaterial({ color: 0x083a22, transparent: true, opacity: 0.85 });
  const hexEdge = new THREE.LineSegments(new THREE.EdgesGeometry(hexGeo), new THREE.LineBasicMaterial({ color: C.edge }));
  const hex = new THREE.Mesh(hexGeo, hexMat); hex.position.y = 0.17; hexEdge.position.y = 0.17;
  const coreRingMat = new THREE.MeshBasicMaterial({ color: C.orange, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const rings = [2.7, 3.15, 3.6].map((r, i) => { const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.045, 8, 96), coreRingMat); m.position.y = 0.4 + i * 0.32; m.rotation.x = Math.PI / 2; return m; });
  const beamMat = new THREE.MeshBasicMaterial({ color: C.orange, transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 7, 36, 1, true), beamMat); beam.position.y = 3.5;
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: C.orange, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }));
  coreGlow.scale.setScalar(7); coreGlow.position.y = 2.9;
  core.add(hex, hexEdge, ...rings, beam, coreGlow, orbit);

  // ---- state ----
  let W = 0, H = 0, cats = [], rooms = [], pellets = [], index = new Map(), pelletMesh = null, ringMesh = null, reviewList = [];
  let streets = { xs: [], zs: [], bus: 0 }, segs = [], extent = { w: 20, z0: 0, z1: 10 }, belly = { x: 0, z: 0 };
  const held = new Set(), glow = new Map(), seen = new Set();
  let actors = [], fx = [], eating = 0, hungry = false, motionOn = true, raf = 0, last = 0, t = 0, appearUntil = 0, lastSuck = 0, lastBelly = 0;
  const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
  let chompUntil = 0;
  let hover = null;
  const EMPTY_DEFAULT = 'The grid is empty. Feed the core.';
  let emptyText = EMPTY_DEFAULT;
  const calm = () => reduced.matches || !motionOn;
  const nowMs = () => performance.now();

  // ambient energy pulses that run along the streets
  const PULSES = 22, pulsePos = new Float32Array(PULSES * 3), pulses = [];
  const pulseGeo = new THREE.BufferGeometry(); pulseGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
  const pulseObj = new THREE.Points(pulseGeo, new THREE.PointsMaterial({ size: 0.75, map: glowTex, color: 0xaaffd8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  pulseObj.frustumCulled = false; scene.add(pulseObj);
  const newPulse = () => { const s = segs[Math.floor(Math.random() * segs.length)]; return s ? { s, k: Math.random(), v: 5 + Math.random() * 6, dir: Math.random() < 0.5 ? 1 : -1 } : null; };

  // ---- layout ----
  function chooseCols(n) {
    const aspect = Math.max(0.4, W / Math.max(1, H));
    let best = 1, bestScale = -1;
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c), gw = c * (RW + GAP) + GAP, gd = r * (RD + GAP) + GAP + BELLY_GAP + 5;
      const s = Math.min(aspect / gw, 1 / (gd * 0.8));
      if (s > bestScale + 1e-9) { bestScale = s; best = c; }
    }
    return best;
  }

  function layout() {
    const empty = !cats.length, n = Math.max(1, cats.length);
    const cols = chooseCols(n), rowsN = Math.ceil(n / cols);
    const gw = cols * (RW + GAP) + GAP, x0 = -gw / 2;
    streets = { xs: [], zs: [], bus: 0 };
    for (let k = 0; k <= cols; k++) streets.xs.push(x0 + GAP / 2 + k * (RW + GAP));
    for (let k = 0; k <= rowsN; k++) streets.zs.push(GAP / 2 + k * (RD + GAP));
    streets.bus = streets.zs[rowsN];
    belly = { x: 0, z: streets.bus + BELLY_GAP };
    extent = { w: gw, z0: streets.zs[0], z1: belly.z + 5.4 };

    roomsG.clear(); streetsG.clear();
    roomMats.splice(0).forEach((m) => m.dispose()); shafts.length = 0;
    labels.querySelectorAll('.b3d-room').forEach((n) => n.remove());
    segs = [];
    const bar = (x1, z1, x2, z2) => {
      const m = new THREE.Mesh(unitBox, streetMat);
      m.scale.set(Math.abs(x2 - x1) || 0.09, 0.04, Math.abs(z2 - z1) || 0.09); m.position.set((x1 + x2) / 2, 0.02, (z1 + z2) / 2);
      streetsG.add(m); segs.push({ x1, z1, x2, z2, len: Math.hypot(x2 - x1, z2 - z1) });
    };
    const xa = streets.xs[0], xb = streets.xs[cols], za = streets.zs[0];
    streets.zs.forEach((z) => bar(xa, z, xb, z));
    streets.xs.forEach((x) => bar(x, za, x, streets.bus));
    bar(0, streets.bus, 0, belly.z - 2);

    index = new Map(); pellets = []; reviewList = [];
    const perRow = Math.max(1, Math.floor((RW - 1.6) / SP) + 1), maxRows = Math.max(1, Math.floor((RD - 2) / SP) + 1), cap = perRow * maxRows;
    const list = empty ? [{ name: '', items: [] }] : cats;
    rooms = list.map((cat, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const room = { name: cat.name, col, row, x: x0 + GAP + col * (RW + GAP) + RW / 2, z: GAP + row * (RD + GAP) + RD / 2, ghost: empty, pellets: [] };
      room.col3 = empty ? new THREE.Color(C.edge) : roomColor(cat.name);
      let glass = fillGhost, edgeM = edgeGhost;
      if (!empty) {
        glass = roomGlass(room.col3); room.glass = glass; roomMats.push(glass);
        edgeM = new THREE.LineBasicMaterial({ color: room.col3.clone().multiplyScalar(1.6), transparent: true, opacity: 0.95 }); roomMats.push(edgeM);
        const sm = lightShaft(room.col3, 0.5 + Math.min(1, cat.items.length / 8)); roomMats.push(sm); shafts.push(sm);
        const sh = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 3.6, 14, 28, 1, true), sm); sh.position.set(room.x, 7.2, room.z); sh.renderOrder = 3; roomsG.add(sh);
      }
      const m = new THREE.Mesh(boxGeo, glass); m.position.set(room.x, RH / 2, room.z); m.renderOrder = 1;
      const e = new THREE.LineSegments(edgeGeo, edgeM); e.position.copy(m.position);
      roomsG.add(m, e);
      const shown = cat.items.length > cap ? cap - 1 : cat.items.length;
      room.more = cat.items.length - shown;
      const startX = room.x - ((perRow - 1) * SP) / 2, startZ = room.z - RD / 2 + 1.75;
      cat.items.slice(cat.items.length - shown).forEach((it, k) => { // a full room hides its oldest items, never the one just added
        const p = { id: it.id, title: it.title, review: it.review, room, x: startX + (k % perRow) * SP, z: startZ + Math.floor(k / perRow) * SP, ph: Math.random() * TAU, born: 0, lit: false };
        p.col = new THREE.Color(C.pellet).lerp(room.col3, empty ? 0 : 0.4).multiplyScalar(1.5);
        room.pellets.push(p); pellets.push(p); index.set(p.id, p);
        if (p.review) reviewList.push(p);
      });
      if (!empty) {
        const l = document.createElement('div'); l.className = 'b3d-room';
        const nm = document.createElement('span'); nm.textContent = cat.name;
        const ct = document.createElement('b'); ct.textContent = cat.items.length;
        l.style.color = '#' + room.col3.clone().lerp(new THREE.Color(1, 1, 1), 0.35).getHexString();
        l.append(nm, ct); labels.append(l); room.label = l;
      }
      return room;
    });

    // intro: items we have not shown before pop in; on first load they ripple in one after another
    const first = !seen.size, now = nowMs();
    let k = 0;
    pellets.forEach((p) => {
      if (seen.has(p.id)) { p.born = -1e9; return; }
      p.born = calm() ? -1e9 : now + (first ? Math.min(k++ * 18, 900) : 0);
      seen.add(p.id); appearUntil = Math.max(appearUntil, p.born + 700);
    });

    if (pelletMesh) { world.remove(pelletMesh); pelletMesh.dispose(); }
    pelletMesh = new THREE.InstancedMesh(pelletGeo, pelletMat, Math.max(1, pellets.length)); pelletMesh.count = pellets.length; pelletMesh.frustumCulled = false;
    pellets.forEach((p, i) => { pelletMesh.setColorAt(i, p.col); p.lit = false; });
    if (halo) { world.remove(halo); halo.geometry.dispose(); }
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, pellets.length) * 3), 3));
    haloCol = new THREE.BufferAttribute(new Float32Array(Math.max(1, pellets.length) * 3), 3); hg.setAttribute('color', haloCol);
    pellets.forEach((p, i) => haloCol.setXYZ(i, p.col.r * 0.5, p.col.g * 0.5, p.col.b * 0.5));
    hg.setDrawRange(0, pellets.length);
    halo = new THREE.Points(hg, haloMat); halo.frustumCulled = false; world.add(halo);
    if (ringMesh) { world.remove(ringMesh); ringMesh.dispose(); }
    ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, Math.max(1, reviewList.length)); ringMesh.count = reviewList.length; ringMesh.frustumCulled = false;
    world.add(pelletMesh, ringMesh);

    core.position.set(belly.x, 0, belly.z);
    pulses.length = 0;
    for (let i = 0; i < PULSES; i++) { const p = newPulse(); if (p) pulses.push(p); }
    fit();
  }

  // ---- camera ----
  const base = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
  function fit() {
    if (!W || !H) return;
    camera.aspect = W / H; camera.updateProjectionMatrix();
    const hw = Math.max(extent.w / 2 + 0.6, 15), z0 = extent.z0 - 2.4, z1 = Math.max(extent.z1, 19); // a floor on the framed area keeps a one-room library from zooming in on the core
    base.target.set(0, 0.6, (z0 + z1) / 2);
    const corners = [];
    for (const x of [-hw, hw]) for (const y of [0, 4.2]) for (const z of [z0, z1]) corners.push(new THREE.Vector3(x, y, z));
    const place = (d) => { camera.position.set(base.target.x, base.target.y + Math.sin(ELEV) * d, base.target.z + Math.cos(ELEV) * d); camera.lookAt(base.target); camera.updateMatrixWorld(); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); };
    const fits = () => corners.every((c) => { const v = c.clone().project(camera); return Math.abs(v.x) <= 0.94 && Math.abs(v.y) <= 0.9; });
    let lo = 6, hi = 500;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; place(mid); if (fits()) hi = mid; else lo = mid; }
    place(hi); base.pos.copy(camera.position);
  }

  function resize() {
    const w = Math.max(200, host.clientWidth), h = Math.max(200, host.clientHeight);
    if (w === W && h === H) return;
    W = w; H = h;
    basePR = Math.min(maxPR, Math.sqrt(MAX_PX / (W * H)));
    renderer.setPixelRatio(basePR * adaptive.scale); composer.setPixelRatio(basePR * adaptive.scale);
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    cine.uniforms.uRes.value.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
    if (reflector) reflector.getRenderTarget().setSize(Math.round(W * renderer.getPixelRatio() * 0.6), Math.round(H * renderer.getPixelRatio() * 0.6));
    fit(); draw();
  }

  // ---- actors, bursts ----
  function exitPts(loc) {
    if (loc === 'belly') return [{ x: belly.x, z: belly.z }, { x: belly.x, z: streets.bus }];
    const p = index.get(loc), r = p.room;
    const below = streets.zs[r.row + 1], gx = Math.abs(p.x - streets.xs[r.col]) < Math.abs(p.x - streets.xs[r.col + 1]) ? streets.xs[r.col] : streets.xs[r.col + 1];
    return [{ x: p.x, z: p.z }, { x: p.x, z: below }, { x: gx, z: below }, { x: gx, z: streets.bus }];
  }
  const route = (from, to) => exitPts(from).concat(exitPts(to).reverse());

  function makeActor(pts, o) {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.05);
    const cum = [0];
    for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + Math.hypot(clean[i].x - clean[i - 1].x, clean[i].z - clean[i - 1].z));
    const a = Object.assign({ pts: clean, cum, total: cum[cum.length - 1] || 1, d: 0, trail: [], stops: [], speed: 18 }, o);
    a.group = new THREE.Group();
    const col = new THREE.Color(o.color);
    if (o.dot) {
      const m = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(2) })); m.scale.setScalar(o.r); a.group.add(m);
    } else { a.chomper = makeChomper(o.color, o.r); a.group.add(a.chomper.group); }
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: o.color, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(o.r * 7); a.group.add(s);
    const N = 44, geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    a.N = N; a.col = col; a.points = new THREE.Points(geo, trailMat); a.points.frustumCulled = false;
    actorsG.add(a.group, a.points);
    return a;
  }
  function pointAt(a, d) {
    let i = 1;
    while (i < a.cum.length - 1 && a.cum[i] < d) i++;
    const seg = a.cum[i] - a.cum[i - 1] || 1, k = clamp((d - a.cum[i - 1]) / seg, 0, 1), p0 = a.pts[i - 1], p1 = a.pts[i] || p0;
    return { x: p0.x + (p1.x - p0.x) * k, z: p0.z + (p1.z - p0.z) * k, dx: p1.x - p0.x, dz: p1.z - p0.z };
  }
  function dropActor(a) { actorsG.remove(a.group, a.points); a.points.geometry.dispose(); }
  function burst(x, z, color, kind) {
    if (calm() || document.hidden) return;
    const m = new THREE.Mesh(burstGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.14, z); fxG.add(m);
    fx.push({ m, t0: nowMs(), dur: kind === 'in' ? 750 : 900, kind });
    kick();
  }
  function flash(ids, ms) {
    ms = ms || 3500;
    const until = nowMs() + ms;
    ids.forEach((id) => glow.set(id, until));
    draw();
    setTimeout(draw, ms + 60);
  }

  // ---- per-frame update ----
  const tm = new THREE.Matrix4(), tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3(), te = new THREE.Euler();
  function updatePellets(now, anim) {
    let colorDirty = false;
    for (let i = 0; i < pellets.length; i++) {
      const p = pellets[i];
      let s = 1;
      if (held.has(p.id)) s = 0;
      else if (anim && p.born > now - 700) { const k = (now - p.born) / 650; s = k <= 0 ? 0 : easeBack(clamp(k, 0, 1)); }
      const until = glow.get(p.id), lit = !!(until && until > now);
      if (until && !lit) glow.delete(p.id);
      if (lit !== p.lit) { p.lit = lit; pelletMesh.setColorAt(i, lit ? cGold : p.col); if (haloCol) { const k = lit ? 1.6 : 0.5; haloCol.setXYZ(i, (lit ? cGold : p.col).r * k, (lit ? cGold : p.col).g * k, (lit ? cGold : p.col).b * k); haloCol.needsUpdate = true; } colorDirty = true; }
      const bob = anim ? Math.sin(t * 1.6 + p.ph) * 0.12 : 0;
      tp.set(p.x, 0.58 + bob + (lit ? 0.3 : 0), p.z);
      if (halo) halo.geometry.attributes.position.setXYZ(i, p.x, s > 0.05 ? 0.58 + bob + (lit ? 0.3 : 0) : -50, p.z); ts.setScalar(Math.max(0.0001, s * (lit ? 1.8 + (anim ? Math.sin(t * 8) * 0.2 : 0) : 1)));
      tm.compose(tp, tq.identity(), ts); pelletMesh.setMatrixAt(i, tm);
    }
    pelletMesh.instanceMatrix.needsUpdate = true;
    if (halo) halo.geometry.attributes.position.needsUpdate = true;
    if (colorDirty && pelletMesh.instanceColor) pelletMesh.instanceColor.needsUpdate = true;
    reviewList.forEach((p, i) => {
      te.set(anim ? t * 0.9 + p.ph : 0.6, anim ? t * 0.7 : 0.3, 0); tq.setFromEuler(te);
      tp.set(p.x, 0.58 + (anim ? Math.sin(t * 1.6 + p.ph) * 0.12 : 0), p.z); ts.setScalar(held.has(p.id) ? 0.0001 : 1.15 + (anim ? Math.sin(t * 3 + p.ph) * 0.12 : 0));
      tm.compose(tp, tq, ts); ringMesh.setMatrixAt(i, tm);
    });
    ringMesh.instanceMatrix.needsUpdate = true;
  }

  function updateCore(now, anim, dt) {
    const gold = hungry, tint = gold ? C.gold : C.orange;
    if (gold !== lastBelly) { lastBelly = gold; coreChomper.color(tint); coreRingMat.color.setHex(tint); beamMat.color.setHex(tint); coreGlow.material.color.setHex(tint); }
    const open = now < chompUntil ? Math.abs(Math.sin(t * 16)) * 0.95 : hungry ? 0.95 : calm() ? (eating ? 0.8 : 0.45) : eating ? Math.abs(Math.sin(t * 9)) * 0.95 : (0.5 + 0.5 * Math.sin(t * 1.8)) * 0.55 + 0.06;
    coreChomper.open(Math.max(0.04, open));
    coreChomper.group.position.y = 2.9 + (anim ? Math.sin(t * 1.4) * 0.18 : 0);
    const spin = anim ? (eating ? 6 : hungry ? 3 : 0.7) : 0;
    rings.forEach((r, i) => { r.rotation.z += dt * spin * (i % 2 ? -1 : 1) * (0.8 + i * 0.3); r.scale.setScalar(hungry ? 1.08 + (anim ? Math.sin(t * 8) * 0.04 : 0) : 1); });
    hex.rotation.y = hexEdge.rotation.y = anim ? t * 0.1 : 0;
    beamMat.opacity = hungry ? 0.16 : eating ? 0.12 : 0.07;
    coreGlow.material.opacity = hungry ? 0.4 : eating ? 0.3 : 0.12;
    if (anim && eating && now - lastSuck > 380) { lastSuck = now; burst(belly.x, belly.z, tint, 'in'); }
    if (anim && hungry && now - lastSuck > 520) { lastSuck = now; burst(belly.x, belly.z, tint, 'in'); }
  }

  function update(dt, now) {
    const anim = !calm();
    t += dt;
    const tt = anim ? t : 0;
    floorMat.uniforms.uT.value = tt; floorMat.uniforms.uO.value.set(belly.x, belly.z);
    city.material.uniforms.uT.value = tt; cine.uniforms.uT.value = tt;
    shafts.forEach((m) => { m.uniforms.uT.value = tt; });
    rooms.forEach((r) => { if (r.glass) { r.glass.uniforms.uT.value = tt; const target = hover && hover.room === r ? 1 : 0; r.glass.uniforms.uHover.value += (target - r.glass.uniforms.uHover.value) * Math.min(1, dt * 8 + (dt ? 0 : 1)); } });
    for (let i = 0; i < orbitN; i++) { // data motes spiralling round the core
      const a = (i / orbitN) * TAU * 3 + tt * (eating ? 3.2 : 0.9), r = 3.1 + 0.9 * Math.sin(i * 1.7) + (hungry ? 0.8 : 0), y = 0.4 + ((i * 0.137 + tt * 0.25) % 1) * 5;
      orbitPos[i * 3] = Math.cos(a) * r; orbitPos[i * 3 + 1] = y; orbitPos[i * 3 + 2] = Math.sin(a) * r;
    }
    orbitGeo.attributes.position.needsUpdate = true;
    updatePellets(now, anim); updateCore(now, anim, dt);

    actors.forEach((a) => {
      a.d += a.speed * dt;
      while (a.stops && a.stops.length && a.d >= a.stops[0].d) { const id = a.stops.shift().id; flash([id], 2500); const p = index.get(id); if (p) burst(p.x, p.z, a.color, 'out'); }
      const p = pointAt(a, Math.min(a.d, a.total));
      a.group.position.set(p.x, FLY, p.z);
      if (a.chomper) {
        if (Math.hypot(p.dx, p.dz) > 1e-3) a.group.rotation.y = Math.atan2(-p.dz, p.dx);
        a.chomper.open(Math.abs(Math.sin(t * 14)) * 0.95 + 0.05);
      }
      a.trail.push({ x: p.x, y: FLY, z: p.z }); if (a.trail.length > a.N) a.trail.shift();
      const pos = a.points.geometry.attributes.position, col = a.points.geometry.attributes.color, n = a.trail.length;
      for (let i = 0; i < a.N; i++) {
        const q = a.trail[Math.max(0, i - (a.N - n))] || a.trail[0], f = i < a.N - n ? 0 : Math.pow((i - (a.N - n) + 1) / n, 1.6);
        pos.setXYZ(i, q.x, q.y, q.z); col.setXYZ(i, a.col.r * f * 1.4, a.col.g * f * 1.4, a.col.b * f * 1.4);
      }
      pos.needsUpdate = true; col.needsUpdate = true;
    });
    const done = actors.filter((a) => a.d >= a.total);
    if (done.length) { actors = actors.filter((a) => a.d < a.total); done.forEach((a) => { dropActor(a); if (a.done) a.done(); }); }

    fx = fx.filter((f) => {
      const k = (now - f.t0) / f.dur;
      if (k >= 1) { fxG.remove(f.m); f.m.material.dispose(); return false; }
      const e = 1 - Math.pow(1 - k, 3);
      f.m.scale.setScalar(f.kind === 'in' ? 6 - 5.2 * e : 0.4 + 4.2 * e);
      f.m.material.opacity = 0.85 * (f.kind === 'in' ? Math.sin(k * Math.PI) : 1 - k);
      return true;
    });

    if (anim) {
      pulses.forEach((p, i) => {
        p.k += (p.v * dt * p.dir) / (p.s.len || 1);
        if (p.k > 1 || p.k < 0) { const np = newPulse(); if (np) { Object.assign(p, np); } p.k = p.dir > 0 ? 0 : 1; }
        pulsePos[i * 3] = p.s.x1 + (p.s.x2 - p.s.x1) * p.k; pulsePos[i * 3 + 1] = 0.12; pulsePos[i * 3 + 2] = p.s.z1 + (p.s.z2 - p.s.z1) * p.k;
      });
      pulseGeo.attributes.position.needsUpdate = true; pulseObj.visible = true;
      const dp = dustGeo.attributes.position.array;
      for (let i = 0; i < DUST; i++) { dp[i * 3 + 1] += dt * (0.25 + (i % 7) * 0.05); if (dp[i * 3 + 1] > 14) dp[i * 3 + 1] = 0; }
      dustGeo.attributes.position.needsUpdate = true;
      mouse.sx += (mouse.x - mouse.sx) * Math.min(1, dt * 3); mouse.sy += (mouse.y - mouse.sy) * Math.min(1, dt * 3);
    } else { pulseObj.visible = false; mouse.sx = mouse.sy = 0; }
    shake = Math.max(0, shake - dt * 2.4);
    const sk = anim ? shake * shake * 0.35 : 0;
    camera.position.copy(base.pos).add(tp.set(mouse.sx * 2.2 + (anim ? Math.sin(t * 0.17) * 0.5 : 0) + (Math.random() - 0.5) * sk, -mouse.sy * 1.2 + (Math.random() - 0.5) * sk, 0));
    camera.lookAt(base.target);
    camera.updateMatrixWorld();
  }

  const lp = new THREE.Vector3();
  function project(x, y, z) { lp.set(x, y, z).project(camera); return { x: (lp.x * 0.5 + 0.5) * W, y: (-lp.y * 0.5 + 0.5) * H }; }
  function placeLabels() {
    rooms.forEach((r) => {
      if (!r.label) return;
      const a = project(r.x - RW / 2 + 0.2, 0, r.z + RD / 2 + 0.1), b = project(r.x + RW / 2 - 0.2, 0, r.z + RD / 2 + 0.1);
      const w = Math.max(30, Math.round(b.x - a.x)), key = `${Math.round(a.x)},${Math.round(a.y)},${w}`;
      if (r.key === key) return;
      r.key = key; r.label.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px)`; r.label.style.width = w + 'px';
      r.label.style.fontSize = clamp(w / 9, 9, 14).toFixed(1) + 'px';
    });
    if (!placeLabels.el) { placeLabels.el = document.createElement('div'); placeLabels.el.className = 'b3d-belly'; labels.append(placeLabels.el); }
    if (!placeLabels.empty) { placeLabels.empty = document.createElement('div'); placeLabels.empty.className = 'b3d-empty'; labels.append(placeLabels.empty); }
    placeLabels.empty.hidden = !!cats.length;
    if (!cats.length) {
      const ec = project(0, RH, rooms[0] ? rooms[0].z : 5);
      if (placeLabels.empty.textContent !== emptyText) placeLabels.empty.textContent = emptyText;
      placeLabels.empty.style.transform = `translate(${ec.x.toFixed(1)}px, ${ec.y.toFixed(1)}px)`;
    }
    const bp = project(belly.x, 0, belly.z + 4.9), txt = hungry ? 'RELEASE TO FEED' : 'DROP FILES, TEXT OR LINKS HERE';
    if (placeLabels.el.textContent !== txt) placeLabels.el.textContent = txt;
    placeLabels.el.classList.toggle('hungry', hungry);
    placeLabels.el.style.transform = `translate(${bp.x.toFixed(1)}px, ${bp.y.toFixed(1)}px)`;

  }

  // adaptive resolution (our DLSS-style trade): fewer pixels when frames run late, more when there is headroom; then effects, last
  const applyQuality = (scale, level) => {
    const pr = basePR * scale;
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
    renderer.setSize(W, H, false); composer.setSize(W, H);
    if (smaa) smaa.enabled = level < 1;
    bloom.enabled = level < 2;
    if (reflector) reflector.visible = level < 2;
    if (reflector) reflector.getRenderTarget().setSize(Math.round(W * pr * 0.6), Math.round(H * pr * 0.6));
  };
  const adaptive = new Adaptive(applyQuality, { enabled: Q.adaptive && !reduced.matches });
  let hud = null, fpsEma = 60, hudN = 0;
  if (Q.hud) { hud = document.createElement('div'); hud.className = 'b3d-hud'; hud.setAttribute('aria-hidden', 'true'); host.append(hud); }

  let renderFailed = false;
  function render() { // a throwing render would otherwise leave a black board with no explanation
    try { composer.render(); } catch (e) {
      if (!renderFailed) { renderFailed = true; console.error('3D render failed', e); window.dispatchEvent(new CustomEvent('pacrag:3d-failed', { detail: String(e && e.message || e) })); }
    }
  }

  function draw() {
    if (!W) return;
    update(0, nowMs());
    render();
    placeLabels();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { kick(); } });
  const moving = () => (!calm() && !document.hidden) || nowMs() < chompUntil || actors.length || fx.length || eating || hungry || nowMs() < appearUntil;
  function frame(ts) {
    raf = 0;
    const ms = ts - last; const dt = Math.min(0.05, ms / 1000 || 0); last = ts;
    if (adaptive.tick(ms)) cine.uniforms.uRes.value.set(W * renderer.getPixelRatio(), H * renderer.getPixelRatio());
    if (hud) { fpsEma += ((1000 / Math.max(1, ms)) - fpsEma) * 0.1; if (++hudN % 15 === 0) hud.textContent = `${Q.tier} · ${Math.round(fpsEma)} fps · ${Math.round(W * renderer.getPixelRatio())}x${Math.round(H * renderer.getPixelRatio())} (${adaptive.scale.toFixed(2)}x, fx ${2 - adaptive.level}/2${adaptive.enabled ? '' : ', adaptive off'}, ${Math.round(adaptive.ema)} ms)`; }
    update(dt, nowMs());
    render();
    placeLabels();
    if (moving()) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  // ---- pointer: hover tooltip and click ----
  function pick(e) {
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 18;
    for (const p of pellets) {
      if (held.has(p.id)) continue;
      const s = project(p.x, 0.58, p.z), d = Math.hypot(s.x - mx, s.y - my);
      if (d < bd) { bd = d; best = { p, s }; }
    }
    return best;
  }
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2; mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
    if (!calm()) kick();
    const h = pick(e);
    hover = h && h.p;
    canvas.style.cursor = h ? 'pointer' : '';
    if (h) { tip.hidden = false; tip.textContent = `${h.p.title} (${h.p.room.name})`; tip.style.transform = `translate(${Math.min(h.s.x + 12, W - 220)}px, ${Math.max(4, h.s.y - 34)}px)`; } else tip.hidden = true;
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; mouse.x = mouse.y = 0; hover = null; canvas.style.cursor = ''; });
  canvas.addEventListener('click', (e) => { const h = pick(e); if (h && opts.onPellet) opts.onPellet(h.p.id); });
  // A lost GPU context leaves a black canvas. Give the browser a moment to restore it; if it does not, switch to the flat board for good.
  let lostTimer = 0;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    clearTimeout(lostTimer);
    lostTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('pacrag:3d-failed', { detail: 'context lost' })), 2500);
  });
  canvas.addEventListener('webglcontextrestored', () => { clearTimeout(lostTimer); W = H = 0; resize(); kick(); });

  let pending = false;
  const ro = new ResizeObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; resize(); }); });
  ro.observe(host);
  const onWinResize = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; resize(); }); };
  addEventListener('resize', onWinResize);
  reduced.addEventListener('change', () => { kick(); draw(); });

  // ---- public API (same shape as board.js) ----
  const api = {
    is3d: true,
    setData(data) { cats = data; layout(); draw(); if (moving()) kick(); },
    setHungry(v) { if (hungry === v) return; hungry = v; if (v) kick(); draw(); },
    setMotion(on) { motionOn = on; kick(); draw(); },
    bellyPoint() { const r = canvas.getBoundingClientRect(), c = project(belly.x, 2.4, belly.z); return { x: r.left + c.x, y: r.top + c.y }; },
    pulse() { shake = 1; chompUntil = nowMs() + 700; burst(belly.x, belly.z, C.gold, 'out'); kick(); }, // the core reacts when something arrives
    setEmptyText(txt) { emptyText = txt || EMPTY_DEFAULT; if (!cats.length) placeLabels(); },
    overBelly(clientX, clientY) { // is this screen point on the core (generous mouth area)?
      const r = canvas.getBoundingClientRect(), c = project(belly.x, 1.5, belly.z), e = project(belly.x + 5, 1.5, belly.z);
      return Math.hypot(clientX - r.left - c.x, clientY - r.top - c.y) <= Math.max(60, Math.abs(e.x - c.x) * 1.3);
    },
    hold(id) { held.add(id); },
    release(id) { held.delete(id); draw(); },
    digest(promise) {
      eating++;
      if (calm()) draw(); else kick();
      const quick = calm() || document.hidden;
      const min = quick ? Promise.resolve() : new Promise((r) => setTimeout(r, 800));
      return Promise.all([promise, min]).then((v) => v[0]).finally(() => { eating--; draw(); });
    },
    deliver(id) {
      if (calm() || document.hidden || !index.has(id)) { held.delete(id); draw(); return Promise.resolve(); }
      return new Promise((resolve) => {
        let finished = false;
        const fin = () => { if (finished) return; finished = true; held.delete(id); const p = index.get(id); if (p) burst(p.x, p.z, C.orange, 'out'); flash([id], 1800); resolve(); };
        actors.push(makeActor(route('belly', id), { color: C.orange, r: 0.3, dot: true, speed: 26, done: fin }));
        setTimeout(fin, 4500); // never leave the queue waiting on an animation
        kick();
      });
    },
    run(ids) {
      const targets = ids.filter((id) => index.has(id));
      if (!targets.length) return Promise.resolve();
      if (calm() || document.hidden) { flash(targets); return Promise.resolve(); }
      let pts = exitPts('belly'), at = 'belly';
      const stopIdx = [];
      targets.forEach((id) => { pts = pts.concat(route(at, id).slice(exitPts(at).length)); stopIdx.push({ id, i: pts.length - 1 }); at = id; });
      pts = pts.concat(exitPts(at).slice(1).concat(exitPts('belly').reverse()));
      const a = makeActor(pts, { color: C.cyan, r: 0.62 });
      const full = [0];
      for (let i = 1; i < pts.length; i++) full.push(full[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      a.stops = stopIdx.map((s) => ({ id: s.id, d: full[s.i] }));
      a.speed = Math.max(16, a.total / 3.6);
      return new Promise((resolve) => { a.done = resolve; actors.push(a); kick(); });
    },
    flash,
    destroy() {
      cancelAnimationFrame(raf); raf = 0; ro.disconnect(); removeEventListener('resize', onWinResize);
      actors.forEach(dropActor); actors = [];
      composer.dispose(); renderer.dispose(); rt.dispose(); roomMats.forEach((m) => m.dispose()); if (hud) hud.remove();
      canvas.remove(); labels.remove(); tip.remove();
    },
  };

  api.setData([]); // before resize(): draw() is a no-op until the size is known
  resize();
  kick();
  return api;
}
