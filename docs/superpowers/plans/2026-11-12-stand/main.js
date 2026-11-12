const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const REPO = '/Users/evgeniy/WebstormProjects/claude-swarm-lite';
app.setPath('userData', path.join(__dirname, 'ud'));
const script = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 780, titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, zoomFactor: 1 } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('[page]', msg); });
  await win.loadFile(path.join(REPO, 'renderer/index.html'));
  const run = require(path.resolve(script));
  try { await run(win, { shot: async (name, rect) => {
    const img = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(__dirname, name), img.toPNG());
  }, js: (code) => win.webContents.executeJavaScript(code), wait: (ms) => new Promise((r) => setTimeout(r, ms)) }); }
  catch (e) { console.error(e); }
  app.quit();
});
