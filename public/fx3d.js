// Rendering extras for board3d.js: shaders and helpers for the "max graphics" look.
// Everything here is local (vendored three.js), decorative, and switched by quality tier so slow GPUs keep a smooth frame rate.
import * as THREE from './vendor/three/build/three.module.js';
import { ShaderPass } from './vendor/three/examples/jsm/postprocessing/ShaderPass.js';

// ---- per-room color: each category gets its own hue, stable across sessions ----
export function hueOf(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 360) / 360;
}
const PALETTE = [0.38, 0.5, 0.58, 0.72, 0.84, 0.95, 0.08, 0.14]; // greens, cyans, blues, violet, magenta, red, amber, gold: neon only
export function roomColor(name) {
  const h = PALETTE[Math.floor(hueOf(name) * 1000) % PALETTE.length];
  return new THREE.Color().setHSL(h, 0.85, 0.55);
}

// ---- holographic glass for a room: fresnel rim, a scanline that climbs the walls, brighter at the top ----
export function roomGlass(color, base) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uT: { value: 0 }, uC: { value: color.clone() }, uA: { value: base == null ? 0.38 : base }, uHover: { value: 0 } },
    vertexShader: `varying vec3 vW; varying vec3 vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vW; varying vec3 vN; uniform float uT; uniform vec3 uC; uniform float uA; uniform float uHover;
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float fr = pow(1.0 - abs(dot(normalize(vN), V)), 2.2);
        float g = clamp(vW.y / 1.1, 0.0, 1.0);
        float scan = smoothstep(0.06, 0.0, abs(fract(vW.y * 0.28 - uT * 0.35) - 0.5) - 0.44);
        float grid = smoothstep(0.03, 0.0, abs(fract(vW.x * 0.5) - 0.5) - 0.47) * 0.5 + smoothstep(0.03, 0.0, abs(fract(vW.z * 0.5) - 0.5) - 0.47) * 0.5;
        vec3 c = uC * (0.08 + 0.85 * fr + 0.14 * g + 0.10 * scan + 0.07 * grid + 0.25 * uHover);
        gl_FragColor = vec4(c * uA, 1.0);
      }`,
  });
}

// ---- a light shaft rising from a room; brighter the more it holds ----
export function lightShaft(color, intensity) {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uT: { value: 0 }, uC: { value: color.clone() }, uI: { value: intensity } },
    vertexShader: `varying float vH; varying vec3 vN; varying vec3 vW; void main(){ vH = position.y / 14.0 + 0.5; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying float vH; varying vec3 vN; varying vec3 vW; uniform float uT; uniform vec3 uC; uniform float uI;
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float soft = pow(abs(dot(normalize(vN), V)), 1.5);
        float a = pow(1.0 - vH, 2.4) * soft;
        float flick = 0.88 + 0.12 * sin(uT * 2.0 + vW.x * 3.0 + vH * 9.0);
        gl_FragColor = vec4(uC * a * uI * flick * 0.11, 1.0);
      }`,
  });
  return m;
}

// ---- the far city: instanced towers with lit windows, fading into the dark ----
export function skyline(seed) {
  const N = 220;
  const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uBg: { value: new THREE.Color(0x010a06) } },
    vertexShader: `attribute float aSeed; varying vec3 vW; varying vec3 vL; varying float vSeed; varying vec3 vN;
      void main(){ mat4 m = modelMatrix * instanceMatrix; vec4 w = m * vec4(position, 1.0); vW = w.xyz; vL = position; vSeed = aSeed; vN = normalize(mat3(m) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vW; varying vec3 vL; varying float vSeed; varying vec3 vN; uniform float uT; uniform vec3 uBg;
      float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      void main(){
        float side = 1.0 - abs(vN.y);
        float u = (abs(vN.x) > 0.5 ? vW.z : vW.x) * 0.32;
        vec2 cell = vec2(floor(u), floor(vW.y * 0.28));
        vec2 f = fract(vec2(u, vW.y * 0.28));
        float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
        float r = h21(cell + vSeed * 17.0);
        float lit = step(0.86, r) * (0.65 + 0.35 * sin(uT * 0.6 + r * 60.0));
        vec3 tint = r > 0.93 ? vec3(1.0, 0.55, 0.15) : (r > 0.82 ? vec3(0.9, 0.3, 0.8) : vec3(0.2, 0.9, 0.8));
        float rim = smoothstep(0.02, 0.0, min(f.x, 1.0 - f.x)) * 0.0;
        vec3 body = vec3(0.012, 0.03, 0.04) + vec3(0.0, 0.05, 0.06) * smoothstep(0.0, 40.0, vW.y);
        vec3 c = body + tint * lit * win * side * 1.2;
        c += vec3(0.1, 0.8, 0.7) * smoothstep(0.985, 1.0, vL.y) * 0.8; // lit roof edge
        float d = length(vW.xz - vec2(0.0, 10.0));
        c = mix(c, uBg, smoothstep(190.0, 380.0, d) * 0.75);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  const seeds = new Float32Array(N);
  const rnd = (() => { let s = seed || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const ang = Math.PI * (0.02 + 0.96 * rnd()), R = 140 + rnd() * 160;
    const w = 6 + rnd() * 14, d = 6 + rnd() * 14, h = 40 + Math.pow(rnd(), 2.0) * 170;
    p.set(Math.cos(ang) * R * 1.25, 0, 10 - Math.sin(ang) * R); s.set(w, h, d);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 0.5);
    mesh.setMatrixAt(i, m4.compose(p, q, s)); seeds[i] = rnd();
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  mesh.frustumCulled = false;
  return mesh;
}

// ---- a gradient backdrop: teal haze at the horizon (top of the screen), black below ----
export function skyTexture() {
  const c = document.createElement('canvas'); c.width = 4; c.height = 512;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, '#083a36'); gr.addColorStop(0.12, '#052622'); gr.addColorStop(0.35, '#021510'); gr.addColorStop(1, '#010a06');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---- the final cinematic pass: chromatic aberration at the edges, vignette, film grain, a touch of teal and orange ----
export const CineShader = {
  uniforms: { tDiffuse: { value: null }, uT: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uAb: { value: 0.006 }, uVig: { value: 0.55 }, uGrain: { value: 0.035 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uT; uniform vec2 uRes; uniform float uAb; uniform float uVig; uniform float uGrain;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; float r2 = dot(c, c);
      vec2 off = c * r2 * uAb * 6.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col * vec3(0.94, 1.02, 1.03), col * vec3(1.06, 1.0, 0.94), smoothstep(0.25, 0.8, l)); // shadows cool, highlights warm
      col *= 1.0 - uVig * smoothstep(0.12, 0.62, r2);
      col += (h(vUv * uRes + fract(uT) * 91.7) - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};
export const makeCinePass = () => new ShaderPass(CineShader);

// ---- quality tiers and the adaptive controller (our stand-in for DLSS: render fewer pixels when the frame is late, more when there is headroom) ----
export function parseQuality() {
  const q = new URLSearchParams(location.search);
  const tier = ['low', 'high', 'ultra'].includes(q.get('quality')) ? q.get('quality') : 'ultra';
  return { tier, adaptive: q.get('adaptive') !== '0', hud: q.get('hud') === '1' };
}
export class Adaptive {
  constructor(apply, { min = 0.55, enabled = true } = {}) { this.apply = apply; this.scale = 1; this.min = min; this.enabled = enabled; this.ema = 16; this.n = 0; this.level = 0; }
  // ms: the last frame time. Returns true when something changed.
  tick(ms) {
    if (!this.enabled || ms > 1500) return false; // a hidden tab is not a measurement; a slow frame is, so it counts (capped)
    this.ema += (Math.min(ms, 250) - this.ema) * 0.1;
    this.n += Math.min(ms, 250);
    if (this.n < 1200) return false; // decide about once a second, whatever the frame rate
    this.n = 0;
    if (this.ema > 24) {
      if (this.scale > this.min + 1e-6) { this.scale = Math.max(this.min, +(this.scale - 0.1).toFixed(2)); this.apply(this.scale, this.level); return true; }
      if (this.level < 2) { this.level++; this.apply(this.scale, this.level); return true; } // out of resolution headroom: drop effects
    } else if (this.ema < 13.5) {
      if (this.level > 0) { this.level--; this.apply(this.scale, this.level); return true; }
      if (this.scale < 1) { this.scale = Math.min(1, +(this.scale + 0.05).toFixed(2)); this.apply(this.scale, this.level); return true; }
    }
    return false;
  }
}
