// UAT helper: drives the real page in headless Chrome/Edge over the DevTools protocol (no dependencies; needs Node 22+ for global WebSocket).
// Starts the app on a throwaway data folder seeded with uat/corpus, then runs the steps in the script file.
// Usage: node uat/drive.js <steps.json | inline JSON> [--size=1440x900] [--empty]
// Steps: {"eval": "js"} | {"wait": ms} | {"shot": "uat/out/name.png"} | {"log": "js expression to print"}
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const { start } = require('../server.js');

const flag = (n) => process.argv.includes(`--${n}`);
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = process.argv[2] || '[]';
  const steps = JSON.parse(src.trim().startsWith('[') ? src : fs.readFileSync(src, 'utf8'));
  const [W, H] = arg('size', '1440x900').split('x').map(Number);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-drive-'));
  // No model or embedder: a shell with ANTHROPIC_API_KEY or PACRAG_EMBED_MODEL set must not send UAT questions or text elsewhere.
  const app = await start({ port: 0, dataDir: dir, answerer: null, embedder: null });
  const base = `http://127.0.0.1:${app.port}`;
  if (!flag('empty')) {
    const cdir = path.join(__dirname, 'corpus');
    for (const f of fs.readdirSync(cdir)) await fetch(`${base}/api/upload?name=${encodeURIComponent(f)}`, { method: 'POST', headers: { 'x-pacrag': '1', 'content-type': 'application/octet-stream' }, body: fs.readFileSync(path.join(cdir, f)) });
  }
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  const port = 9300 + Math.floor(Math.random() * 500);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pacrag-prof-'));
  const chrome = spawn(exe, ['--headless', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', ...(flag('nogl') ? ['--disable-gpu', '--disable-3d-apis', '--disable-webgl'] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let tabs;
    for (let i = 0; i < 60 && !tabs; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
    const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((ok) => { ws.onopen = ok; });
    let id = 0; const waiting = new Map(); const logs = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
      else if (d.method === 'Runtime.consoleAPICalled') logs.push(`${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      else if (d.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION: ${d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text}`);
    };
    const send = (method, params) => new Promise((ok) => { const i = ++id; waiting.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: Number(arg('scale', '1')), mobile: W < 600 });
    await send('Page.navigate', { url: `${base}/?view=${arg('view', '3d')}${arg('q', '') ? '&' + arg('q', '') : ''}` });
    await sleep(2500);
    for (const s of steps) {
      if (s.wait) await sleep(s.wait);
      if (s.eval) { const r = await send('Runtime.evaluate', { expression: s.eval, awaitPromise: true }); if (r.result && r.result.exceptionDetails) logs.push(`EVAL ERROR: ${r.result.exceptionDetails.exception.description}`); }
      if (s.log) { const r = await send('Runtime.evaluate', { expression: s.log, awaitPromise: true, returnByValue: true }); console.log('log:', JSON.stringify(r.result.result.value)); }
      if (s.shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(path.resolve(s.shot)), { recursive: true }); fs.writeFileSync(s.shot, Buffer.from(r.result.data, 'base64')); console.log('wrote', s.shot); }
    }
    console.log(logs.length ? `console:\n  ${logs.join('\n  ')}` : 'console: clean');
    ws.close();
  } finally { chrome.kill(); await app.close(); setTimeout(() => { fs.rmSync(dir, { recursive: true, force: true }); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(0); }, 800); }
})().catch((e) => { console.error(e); process.exit(1); });
