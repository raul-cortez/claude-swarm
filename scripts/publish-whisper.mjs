#!/usr/bin/env node
// scripts/publish-whisper.mjs — выложить сборки whisper.cpp в релизы гитхаба, откуда их
// берёт кнопка «Включить голосовые».
//
// Запуск:  node scripts/publish-whisper.mjs [версия]      (по умолчанию 1.9.1)
// Нужно:   gh CLI, залогиненный; на macOS — cmake (brew install cmake) и Xcode CLT.
// Итог:    файлы в релизе `whisper-<версия>`, манифест — ассетом релиза `whisper`.
//
// Почему так, а не вложить бинарник в приложение: обновления ходят свопом app.asar, и
// вложенный распознаватель дорожал бы каждое обновление ВСЕМ, включая тех, кому голос не
// нужен. Поэтому он лежит отдельно и качается только по нажатию кнопки.
//
// Почему манифест, а не константы в voice.js: новую версию whisper.cpp можно выложить, не
// выпуская версию приложения — приложение читает манифест и берёт то, что там описано.
//
// Два тега, а не один: версионный `whisper-<версия>` держит сами файлы (он неизменяемый,
// поэтому клиент не может скачать половину одной версии и половину другой), а
// фиксированный `whisper` держит только whisper.json, который перезаписывается. Это ровно
// та мутабельная точка входа, которой раньше был путь `apps/latest/` в реестре гитлаба.
//
// ОБА релиза обязаны быть prerelease. `latest` у гитхаба — самый свежий релиз вообще, и
// обычный релиз распознавателя стал бы им, после чего обновление приложения начало бы
// получать 404 вместо своего манифеста. Ассеты prerelease качаются как обычные, из выбора
// «latest» такой релиз просто исключён.
//
// macOS: готового CLI в релизах whisper.cpp нет, собираем сами — статически
// (BUILD_SHARED_LIBS=OFF), с встроенными шейдерами Metal (GGML_METAL_EMBED_LIBRARY=ON),
// иначе бинарник ищет .metal рядом с собой и молча остаётся на CPU. Результат зависит
// только от системных фреймворков — проверяется через otool.
// Windows: берём официальный whisper-bin-x64.zip. Кладём ВСЕ ggml-cpu-*.dll: ggml выбирает
// подходящий под процессор в рантайме, и «не нашёл бэкенд» у пользователя дороже 6 МБ.
// Linux: собирается в CI (.github/workflows/whisper-linux.yml) — честно его собрать можно
// только на Linux. Скрипт запускает тот workflow последним шагом, и он сам дописывает
// linux-x64 в манифест.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = process.argv[2] || '1.9.1';
// Одно место на всё приложение — поле repository в package.json (см. updater-core.ghSlug).
const { ghSlug } = await import('../updater-core.js').then((m) => m.default || m);
const REPO = ghSlug(JSON.parse(fs.readFileSync('package.json', 'utf8')).repository);
if (!REPO) fail('в package.json нет repository — некуда публиковать');
const ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/v${VERSION}/whisper-bin-x64.zip`;
const WIN_KEEP = ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll'];

try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); }
catch { fail('gh не залогинен — `gh auth login`'); }
if (process.platform !== 'darwin') fail('mac-бинарник собирается только на macOS');

function fail(m) { console.error('✗ ' + m); process.exit(1); }
function step(m) { console.log('▸ ' + m); }
function sh(cmd, args, opts) { execFileSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {})); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-pub-'));
const pub = path.join(work, 'pub');
fs.mkdirSync(pub);

// --- macOS: собрать -----------------------------------------------------------
step(`клонирую whisper.cpp v${VERSION}`);
const src = path.join(work, 'src');
sh('git', ['clone', '--depth', '1', '--branch', `v${VERSION}`, 'https://github.com/ggml-org/whisper.cpp.git', src]);
step('собираю whisper-cli (статически, Metal внутри)');
sh('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
  '-DWHISPER_BUILD_TESTS=OFF', '-DGGML_METAL_EMBED_LIBRARY=ON',
  '-DCMAKE_OSX_ARCHITECTURES=arm64'], { cwd: src });
sh('cmake', ['--build', 'build', '--config', 'Release', '--target', 'whisper-cli', '-j8'], { cwd: src });
const built = path.join(src, 'build', 'bin', 'whisper-cli');
if (!fs.existsSync(built)) fail('whisper-cli не собрался');
// Ни одной посторонней динамической библиотеки: иначе на чужой машине он не запустится.
const libs = execFileSync('otool', ['-L', built], { encoding: 'utf8' }).split('\n').slice(1)
  .map((l) => l.trim().split(' ')[0]).filter(Boolean)
  .filter((l) => !l.startsWith('/System/') && !l.startsWith('/usr/lib/'));
if (libs.length) fail('бинарник тянет посторонние библиотеки: ' + libs.join(', '));
fs.copyFileSync(built, path.join(pub, 'whisper-cli'));
fs.chmodSync(path.join(pub, 'whisper-cli'), 0o755);

// --- Windows: взять готовое ---------------------------------------------------
step('качаю официальный whisper-bin-x64.zip');
const zip = path.join(work, 'w.zip');
sh('curl', ['-sL', '-o', zip, ZIP]);
sh('unzip', ['-j', '-o', zip, ...WIN_KEEP.map((n) => `Release/${n}`), 'Release/ggml-cpu-*.dll',
  '-d', pub], { stdio: 'ignore' });
const winFiles = [...WIN_KEEP, ...fs.readdirSync(pub).filter((f) => f.startsWith('ggml-cpu-')).sort()];
for (const n of winFiles) if (!fs.existsSync(path.join(pub, n))) fail('в архиве нет ' + n);

// --- манифест -----------------------------------------------------------------
const entry = (name) => {
  const b = fs.readFileSync(path.join(pub, name));
  return { name, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
};
const manifest = {
  version: VERSION,
  note: `whisper.cpp v${VERSION} — mac собран статически (Metal встроен), win из официального релиза`,
  runtimes: {
    'darwin-arm64': { bin: 'whisper-cli', files: [entry('whisper-cli')] },
    'win32-x64': { bin: 'whisper-cli.exe', files: winFiles.map(entry) },
  },
};
// Linux-запись дописывает CI, и её нельзя терять ни на минуту: иначе кнопка «Включить
// голосовые» на Linux говорит «распознавателя нет», пока CI не соберёт новый, — а если он
// упадёт, то и дольше. Та же версия: файл уже лежит в этом релизе, запись берём как есть.
// Новая версия: переносим в новый релиз прежний бинарник (он самодостаточен и с моделями
// совместим), CI потом заменит его свежим.
let prevLinux = null;
try {
  const prev = JSON.parse(execFileSync('gh', ['release', 'download', 'whisper', '--repo', REPO,
    '--pattern', 'whisper.json', '--output', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const e = prev.runtimes && prev.runtimes['linux-x64'];
  if (e) {
    manifest.runtimes['linux-x64'] = e;
    if (prev.version !== VERSION) prevLinux = { version: prev.version, files: e.files };
  }
} catch { /* манифеста ещё нет — первая публикация */ }
if (prevLinux) {
  step(`переношу Linux-сборку из whisper-${prevLinux.version}, пока CI собирает новую`);
  for (const f of prevLinux.files) {
    sh('gh', ['release', 'download', `whisper-${prevLinux.version}`, '--repo', REPO,
      '--pattern', f.name, '--dir', pub, '--clobber']);
  }
}
for (const [k, v] of Object.entries(manifest.runtimes)) {
  step(`${k}: ${v.files.length} файлов, ${(v.files.reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(1)} МБ`);
}

// --- выложить -----------------------------------------------------------------
// Создаём релиз, если его ещё нет; --prerelease обязателен (см. шапку файла).
function ensureRelease(tag, title, notes) {
  try { execFileSync('gh', ['release', 'view', tag, '--repo', REPO], { stdio: 'ignore' }); return; }
  catch { /* нет — создаём */ }
  sh('gh', ['release', 'create', tag, '--repo', REPO, '--prerelease',
    '--title', title, '--notes', notes]);
}

step(`выкладываю файлы в релиз whisper-${VERSION}`);
ensureRelease(`whisper-${VERSION}`, `whisper.cpp ${VERSION}`, manifest.note);
sh('gh', ['release', 'upload', `whisper-${VERSION}`, '--repo', REPO, '--clobber',
  ...fs.readdirSync(pub).map((n) => path.join(pub, n))]);

// Манифест — последним: пока он не обновлён, приложения продолжают брать прошлую версию,
// а не половину выложенной новой.
const manifestPath = path.join(work, 'whisper.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
ensureRelease('whisper', 'whisper.cpp — точка входа',
  'Здесь лежит только whisper.json: он говорит приложению, какую версию распознавателя'
  + ' брать. Сами файлы — в релизах whisper-<версия>.');
sh('gh', ['release', 'upload', 'whisper', '--repo', REPO, '--clobber', manifestPath]);

fs.rmSync(work, { recursive: true, force: true });

// Linux — после манифеста: workflow дописывает в него свою запись и проверяет, что
// манифест описывает ровно эту версию.
step('запускаю сборку под Linux в CI');
sh('gh', ['workflow', 'run', 'whisper-linux.yml', '--repo', REPO, '--ref', 'main',
  '-f', `version=${VERSION}`, '-f', 'publish=true']);
console.log(`\n✔ whisper.cpp ${VERSION} выложен для мака и Windows. Linux допишется сам через`);
console.log(`  несколько минут: https://github.com/${REPO}/actions/workflows/whisper-linux.yml`);
