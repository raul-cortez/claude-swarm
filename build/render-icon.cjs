// render-icon.cjs — build/icon.svg → build/icon.png (1024×1024, прозрачные углы).
// Запуск: npx electron build/render-icon.cjs, затем python3 build/make-icon.py (ico + icns).
// Рисует сам Chromium из Electron: отдельный растеризатор SVG в зависимости не нужен.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const S = 1024;
  const win = new BrowserWindow({
    show: false, width: S, height: S, useContentSize: true, transparent: true, frame: false,
    webPreferences: { offscreen: true },
  });
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.resize({ width: S, height: S, quality: 'best' }).toPNG());
  console.log('wrote', path.join(__dirname, 'icon.png'), img.getSize());
  app.quit();
});
