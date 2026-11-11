// UAT helper: starts the app on a throwaway data folder, optionally seeds it with uat/corpus, and screenshots the page
// with a locally installed Chrome/Edge (headless, software WebGL).
// Usage: node uat/shoot.js <out.png> [--empty] [--size=1440x900] [--view=2d|3d] [--wait=ms] [--dbg]
// --dbg prints the page title instead of taking a screenshot (board3d.js writes projection numbers there when the URL hash is #dbg).
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { start } = require('../server.js');

const flag = (n) => process.argv.includes(`--${n}`);
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const out = path.resolve(process.argv[2] || 'shot.png');
const [W, H] = arg('size', '1440x900').split('x');
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-shot-'));
  // No model or embedder: a shell with ANTHROPIC_API_KEY or PACRAG_EMBED_MODEL set must not send UAT questions or text elsewhere.
  const app = await start({ port: 0, dataDir: dir, answerer: null, embedder: null });
  const base = `http://127.0.0.1:${app.port}`;
  if (!flag('empty')) {
    const cdir = path.join(__dirname, 'corpus');
    for (const f of fs.readdirSync(cdir)) {
      await fetch(`${base}/api/upload?name=${encodeURIComponent(f)}`, { method: 'POST', headers: { 'x-pacrag': '1', 'content-type': 'application/octet-stream' }, body: fs.readFileSync(path.join(cdir, f)) });
    }
  }
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  if (!exe) throw new Error('No Chrome or Edge found');
  const args = [flag('dbg') ? '--dump-dom' : '--headless', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    `--window-size=${W},${H}`, `--virtual-time-budget=${arg('wait', '6000')}`];
  if (!flag('dbg')) args.push(`--screenshot=${out}`);
  args.push(`${base}/?view=${arg('view', '3d')}${flag('dbg') ? '#dbg' : ''}`);
  if (flag('dbg')) args.unshift('--headless');
  await new Promise((ok) => {
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let html = '';
    p.stdout.on('data', (d) => { html += d; });
    p.stderr.resume();
    const t = setTimeout(() => p.kill(), 90000);
    p.on('close', () => { clearTimeout(t); if (flag('dbg')) console.log((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1]); ok(); });
  });
  if (!flag('dbg')) console.log(fs.existsSync(out) ? `wrote ${out}` : 'no screenshot');
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
