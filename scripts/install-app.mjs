#!/usr/bin/env node
// scripts/install-app.mjs — собрать приложение из исходников и положить в «Программы».
//
//   npm run install-app
//
// Зачем: у собранного на своей машине приложения нет карантина, поэтому оно открывается
// без вопросов Gatekeeper и без команд в терминале. Это бесплатная альтернатива
// заверению у Apple для тех, у кого уже стоит нода.
//
// Собираем БЕЗ dmg (`--mac dir`): образ нужен только чтобы что-то куда-то везти, а нам
// везти некуда — приложение остаётся на этой же машине. Это вдвое быстрее и не оставляет
// после себя файл на сотню мегабайт.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function step(msg) { console.log('▸ ' + msg); }
function sh(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit' }); }
function writable(p) { try { accessSync(p, constants.W_OK); return true; } catch { return false; } }

if (process.platform !== 'darwin') {
  die('пока только для macOS. На Windows: npm run dist:win и запустить .exe из dist/');
}

// Работающее приложение подменять нельзя — оно прямо сейчас выполняется из этих файлов.
try {
  execFileSync('/usr/bin/pgrep', ['-x', 'Svarmo'], { stdio: 'ignore' });
  die('Svarmo сейчас запущен — закройте его и повторите');
} catch (e) {
  if (e && e.status !== 1) throw e;   // status 1 у pgrep = «не найдено», это и нужно
}

step('собираю приложение (первый раз дольше — качается Electron)');
sh('npx', ['electron-builder', '--mac', 'dir']);

const outDir = ['dist/mac-arm64', 'dist/mac', 'dist/mac-universal'].find((d) => existsSync(d));
if (!outDir) die('сборка не найдена в dist/ — посмотрите вывод выше');
const appName = readdirSync(outDir).find((f) => f.endsWith('.app'));
if (!appName) die('в ' + outDir + ' нет .app');

// SWARM_DEST — та же переменная, что у scripts/install.sh: пригождается и для проверок,
// и тем, кто держит программы не там, где принято.
const dest = process.env.SWARM_DEST
  || (writable('/Applications') ? '/Applications' : path.join(os.homedir(), 'Applications'));
mkdirSync(dest, { recursive: true });
const target = path.join(dest, appName);

step('ставлю в ' + dest);
rmSync(target, { recursive: true, force: true });
// ditto, а не cp: сохраняет подпись и права внутри бандла как есть.
sh('/usr/bin/ditto', [path.join(outDir, appName), target]);

console.log(`\n✔ Готово: ${target}`);
console.log(`  Открыть: open "${target}"`);
console.log('  Карантина на нём нет — Gatekeeper ничего не спросит.');
