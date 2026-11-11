// Desktop shell: runs the local server in-process on a free loopback port and shows it in a window.
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');

let server = null;
let win = null;
let dataDir = null;

app.setAppUserModelId('local.pacrag.app');

if (!app.requestSingleInstanceLock()) {
  // Another PAC&RAG already owns the data folder; tell the user instead of vanishing.
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({ type: 'info', title: 'PAC&RAG', message: 'PAC&RAG is already running.', detail: 'Switch to its window (check the taskbar). Only one copy can use the library at a time.' });
    app.quit();
  });
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(boot).catch(fail);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (!server) return;
    e.preventDefault();
    const s = server;
    server = null;
    s.close().finally(() => app.quit());
  });
  process.on('uncaughtException', (err) => { console.error(err); });
}

function fail(err) {
  const msg = String((err && err.message) || err);
  const r = dialog.showMessageBoxSync({ type: 'error', title: 'PAC&RAG could not start', message: 'PAC&RAG could not start.', detail: msg, buttons: ['Close', 'Open data folder'], defaultId: 0, cancelId: 0 });
  if (r === 1 && dataDir) shell.openPath(dataDir);
  app.exit(1);
}

async function boot() {
  // Portable builds unpack to a temp folder on every run, so the data must live outside it: next to the exe if
  // electron-builder tells us where that is, otherwise in the per-user app data folder.
  dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR)
    : process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'PAC-RAG-data')
      : path.join(app.getPath('userData'), 'data');
  const { start } = require('./server.js');
  server = await start({ port: 0, dataDir });
  const origin = `http://127.0.0.1:${server.port}`;

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PAC&&RAG', submenu: [
      { label: 'Open data folder', click: () => shell.openPath(dataDir) },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 360, minHeight: 480,
    title: 'PAC&RAG', backgroundColor: '#0b0e14', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });

  // Only the local app may load in this window; anything else opens in the default browser.
  const guard = (e, url) => { if (!url.startsWith(origin + '/')) { e.preventDefault(); openExternal(url); } };
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.on('closed', () => { win = null; });

  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit' || !win) return;
    const r = dialog.showMessageBoxSync(win, { type: 'error', message: 'The PAC&RAG window crashed.', detail: 'Your library is safe. Reload to continue.', buttons: ['Reload', 'Quit'], defaultId: 0 });
    if (r === 0) win.webContents.reload(); else app.quit();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) dialog.showErrorBox('PAC&RAG could not load its page', `${desc} (${code})`);
  });

  await win.loadURL(origin + '/');
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}
