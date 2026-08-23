// updater.js — main-process update mechanics (fs / net / electron). Pure decisions
// live in updater-core. Fully disabled in dev (not packaged, or no build-info.json).
const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const core = require('./updater-core');
// Имена папки обновления и её служебных файлов — общие с загрузчиком, чтобы не
// разъехались: одно место пишет, другое читает.
const boot = require('./boot-core');

// `releases/latest/download/…` сам разрешается в свежий релиз, поэтому отдельной
// мутабельной точки входа (путь `apps/latest/` в реестре гитлаба) больше не нужно:
// манифест — обычный ассет каждого релиза. Гитхаб отвечает на это 302, за которым
// httpsGetFollowing ходит сам.
//
// Из выбора «latest» исключены черновики и prerelease — на этом держатся сразу два
// решения: релиз публикуется черновиком, пока CI не доложит в него .exe, а релизы
// whisper помечаются prerelease, чтобы не перебивать собой релизы приложения.
//
// Адрес собирается из package.json, а не вписан здесь: см. core.ghSlug.
function manifestUrl() {
  const slug = core.ghSlug(require('./package.json').repository);
  if (!slug) throw new Error('в package.json нет repository — неизвестно, откуда брать обновления');
  return `https://github.com/${slug}/releases/latest/download/manifest.json`;
}

// Версия, которая СЕЙЧАС выполняется.
//
// Не app.getVersion(): тот читает package.json из бандла, а бандл после переезда кода
// наружу навсегда остаётся на версии, с которой приложение установили. По нему обновлялка
// сравнивала бы манифест со старым числом и предлагала бы одно и то же обновление вечно.
// __dirname ведёт туда, откуда нас на самом деле запустили (см. bootstrap.js).
function runningVersion() {
  try { return require('./package.json').version; }
  catch (_) { return app.getVersion(); }
}

// build-info.json is bundled at the app root (inside app.asar); holds this build's
// runtimeId. Absent in dev → updater is off. (Раньше здесь же лежал read-only токен
// реестра — с публичными релизами качать можно без учётных данных вовсе.)
function readBuildInfo() {
  // От __dirname, а не от app.getAppPath(): сегодня это одно и то же, но когда код
  // переедет из бандла в обновляемый файл рядом с настройками (см. boot-core.js),
  // getAppPath() продолжит указывать на бандл и вернёт версию, которую не запускали.
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); }
  catch (_) { return null; }
}
function enabled() { return app.isPackaged && !!readBuildInfo(); }

// GET, идущий за редиректами: отдаёт готовый поток ответа со статусом 200.
//
// Ассеты гитхаба живут за 302 (`releases/latest/download/…` → тег → CDN), а `https.get`
// за Location сам не ходит. Реестр гитлаба отдавал 200 сразу, поэтому пока жили на нём,
// отсутствие этого кода ничем не проявлялось. Голосовая качалка в main.js на `fetch`
// уперлась в то же самое раньше нас — там про это есть комментарий про HuggingFace.
//
// Заголовков не передаём вовсе: публичный репозиторий отдаёт файлы без учётных данных,
// так что и утекать на CDN при переходе нечему.
function httpsGetFollowing(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (target) => {
      const req = https.get(target, (res) => {
        const hop = core.nextHop(res.statusCode, res.headers.location, target, hops);
        if (hop.kind === 'follow') { res.resume(); hops += 1; go(hop.url); return; }
        if (hop.kind === 'fail') { res.resume(); reject(new Error(hop.message)); return; }
        resolve(res);
      });
      req.on('error', reject);
      // Таймаут остаётся взведённым и после того, как мы отдали поток наружу: если
      // качание встанет, req.destroy уронит res, а его 'error' слушают ниже.
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    };
    go(url);
  });
}

async function httpGet(url) {
  const res = await httpsGetFollowing(url, 15000);
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('error', reject);
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Download url → destPath with optional sha256 verify + progress(percent). Deletes
// the partial file on sha mismatch.
async function download(url, destPath, expectedSha, onProgress) {
  const res = await httpsGetFollowing(url, 120000);
  return new Promise((resolve, reject) => {
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let got = 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(destPath);
    out.on('error', reject);
    res.on('error', reject);
    res.on('data', (c) => {
      got += c.length; hash.update(c);
      if (onProgress && total) onProgress(Math.round((got / total) * 100));
    });
    res.pipe(out);
    out.on('finish', () => out.close(() => {
      const sha = hash.digest('hex');
      if (expectedSha && sha !== String(expectedSha).toLowerCase()) {
        fs.unlink(destPath, () => {});
        reject(new Error('sha256 mismatch'));
        return;
      }
      resolve(destPath);
    }));
  });
}

async function checkForUpdate() {
  if (!enabled()) return { kind: 'none' };
  const info = readBuildInfo();
  const buf = await httpGet(manifestUrl());
  const manifest = JSON.parse(buf.toString('utf8'));
  return core.decideUpdate(runningVersion(), info.runtimeId, manifest);
}

// --- установка обновления ------------------------------------------------------
//
// Обновление НЕ трогает установленное приложение. Новый код кладётся отдельным файлом
// в папку настроек, и переставляется указатель — дальше его подхватывает загрузчик
// (bootstrap.js). Почему так, а не подменой app.asar внутри бандла, подробно написано
// в boot-core.js; коротко: подмена ломала подпись, требовала переподписи на машине
// пользователя, а с ней у приложения менялся отпечаток — и macOS заново спрашивала все
// разрешения. На винде она же упиралась в заблокированный работающим приложением файл.
//
// Отсюда исчезли: хелпер на PowerShell с обходом job object, шелл-скрипт с codesign,
// резервная копия app.asar.bak и отложенный перезапуск. Запуск нового файла — обычный
// app.relaunch(), потому что ничего занятого мы не трогаем.
function payloadDir() { return path.join(app.getPath('userData'), boot.PAYLOAD_DIR); }

// Скачать проверенный по sha256 файл, положить рядом с настройками и переставить
// указатель. Указатель пишется ПОСЛЕДНИМ: пока его нет, недокачанного обновления как бы
// и не существует, и прерванная на середине установка ничего не меняет.
async function applyPayload({ url, sha256, version }, onProgress) {
  if (!enabled()) throw new Error('updater disabled');
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    throw new Error('в обновлении нет внятной версии: ' + version);
  }
  const dir = payloadDir();
  fs.mkdirSync(dir, { recursive: true });

  const name = `${version}.asar`;
  const tmp = path.join(dir, name + '.part');
  const dest = path.join(dir, name);
  try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  // download сам сверяет sha256 и удаляет файл, если он не сошёлся.
  await download(url, tmp, sha256, onProgress);
  try { fs.rmSync(dest, { force: true }); } catch (_) {}
  fs.renameSync(tmp, dest);

  fs.writeFileSync(path.join(dir, boot.POINTER), JSON.stringify({ version, file: name }));
  // Метка неудачного запуска прошлой версии новой не мешает (она сверяется по версии),
  // но и лежать ей теперь незачем.
  try { fs.rmSync(path.join(dir, boot.MARKER), { force: true }); } catch (_) {}
  return { ok: true };
}

// Версия, которая УЖЕ скачана и ждёт запуска: указатель в payload/ показывает на что-то
// новее работающего кода. Так плашка отличает «надо скачать» от «уже готово, применится при
// перезапуске» — и после перезапуска сама гаснет, потому что версии сравняются.
//
// Читаем указатель, а не список файлов: рядом лежат и прошлые asar (страховка загрузчика),
// и «новее всех» из них — не то же самое, что «то, что поднимется».
function pendingVersion() {
  try {
    const raw = fs.readFileSync(path.join(payloadDir(), boot.POINTER), 'utf8');
    return core.pendingFrom(raw, runningVersion());
  } catch (_) { return ''; }  // указателя нет вовсе — обновление никто не ставил
}

async function downloadInstaller(url, filename, onProgress) {
  if (!enabled()) throw new Error('updater disabled');
  const dest = path.join(app.getPath('downloads'), filename);
  await download(url, dest, null, onProgress || null);
  shell.showItemInFolder(dest);
  return { ok: true, path: dest };
}

// --- self-relocation (macOS): приложение, запущенное прямо из смонтированного dmg,
// предлагает переехать в «Программы». Returns true if it kicked off relocation (caller
// must NOT open a window — we exit after copying).
//
// Раньше сюда же приходили те, у кого папка приложения оказалась недоступна для записи:
// без этого не работала подмена app.asar. Теперь обновление пишет только в папку
// настроек, поэтому права на сам бандл никого не волнуют — остаётся единственный
// настоящий повод, диск-образ. Он размонтируется, и приложение исчезнет вместе с ним.
function maybeRelocate() {
  if (!app.isPackaged || process.platform !== 'darwin') return false;
  const bundle = app.getPath('exe').split('/Contents/')[0]; // .../Swarm.app
  if (!bundle.startsWith('/Volumes/')) return false;
  const declinedFlag = path.join(app.getPath('userData'), 'relocate-declined');
  if (fs.existsSync(declinedFlag)) return false;
  const dest = path.join(os.homedir(), 'Applications', path.basename(bundle));
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Не сейчас', 'Переместить'],
    defaultId: 1, cancelId: 0,
    title: 'Установка',
    message: 'Переместить Claude Swarm в «Программы» (~/Applications)?',
    detail: 'Сейчас приложение запущено с диск-образа — он размонтируется, и приложение пропадёт. Оно перезапустится из новой папки.',
  });
  if (choice !== 1) { try { fs.writeFileSync(declinedFlag, '1'); } catch (_) {} return false; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(bundle, dest, { recursive: true });
    try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', dest]); } catch (_) {}
    execFileSync('/usr/bin/open', [dest]);
    app.exit(0);
    return true;
  } catch (_) {
    return false; // relocation failed — keep running from the current location
  }
}

module.exports = {
  checkForUpdate,
  isNetworkError: core.isNetworkError,
  applyPayload,
  pendingVersion,
  downloadInstaller,
  maybeRelocate,
  enabled,
  runningVersion,
};
