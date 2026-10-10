#!/usr/bin/env node
// scripts/release.mjs — cut a release and publish it to GitHub.
//
// Usage:  npm run release -- patch|minor|major       (default: patch)
// Needs:  gh CLI, logged in (`gh auth status`). Никаких токенов в окружении.
// Run on: macOS (this builds the .dmg locally; подпись у нас ad-hoc, так что мак
//         собирается за клавиатурой, а не на раннере).
//
// What it does, in order:
//   1. sanity: clean tree, on `main`, gh залогинен
//   2. npm test — a red suite stops the release before anything is written
//   3. bump version in package.json
//   4. prepend a CHANGELOG.md section from commits since the last tag
//   5. refresh the download links block in README.md
//   6. commit "release: vX.Y.Z" + annotated tag vX.Y.Z (tag message = changelog)
//   7. build the .dmg  (npm run dist)
//   8. собрать ассеты: app.asar (без нативных мака) + manifest.json для обновлялки
//   9. push main + the tag
//  10. gh release create --draft с тремя ассетами
//
// Релиз создаётся ЧЕРНОВИКОМ, и это несущее решение, а не осторожность. `latest` у
// гитхаба игнорирует черновики, а обновлялка ходит именно за
// releases/latest/download/manifest.json. Пока .exe и .AppImage не доложены из CI, релиз не должен
// становиться latest: иначе несколько минут манифест обещает установщик, которого ещё
// нет, и пришедший в это окно виндовый пользователь получает 404. Черновик снимает CI
// последним шагом — ровно когда обещание становится правдой.
//
// Так что этот скрипт owns the Mac half; CI owns Windows, Linux и публикацию.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Одно место на всё приложение — поле repository в package.json (см. updater-core.ghSlug).
const { ghSlug } = await import('../updater-core.js').then((m) => m.default || m);
const REPO = ghSlug(JSON.parse(readFileSync('package.json', 'utf8')).repository);
if (!REPO) fail('в package.json нет repository — некуда публиковать');

const bump = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) fail('argument must be patch | minor | major');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function step(msg) { console.log('▸ ' + msg); }
function sh(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit' }); }

// 1. sanity ------------------------------------------------------------------
if (git(['status', '--porcelain'])) fail('working tree is not clean — commit or stash first');
if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail("switch to the 'main' branch first");
// Проверяем ЗДЕСЬ, а не в момент публикации: там уже собран .dmg, сделан коммит и
// проставлен тег, и «не залогинен» стоил бы разбора полузавершённого релиза руками.
try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); }
catch { fail('gh не залогинен — `gh auth login` (нужны scope repo и workflow)'); }

// 2. tests -------------------------------------------------------------------
// BEFORE the bump on purpose: everything below writes to the repo (package.json,
// CHANGELOG.md, README.md, a commit, a tag), and a release that dies halfway leaves a
// tree that has to be cleaned up by hand. Failing here leaves nothing to undo.
//
// A green suite was a habit until now, which means it was optional exactly when it
// mattered — in a hurry. The suite is pure Node and takes seconds, so there's no
// reason to make this skippable.
step('tests …');
try {
  sh('npm', ['test']);
} catch {
  fail('tests failed — release stopped (the run is printed above)');
}

// 3. bump --------------------------------------------------------------------
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const version = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
step(`version ${pkg.version} → ${version}`);
pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// 4. changelog ---------------------------------------------------------------
// CHANGELOG читает ПОЛЬЗОВАТЕЛЬ, а не тот, кто ведёт репозиторий. Поэтому внутренние типы
// коммитов сюда не попадают: «chore(release): красная сюита останавливает выпуск» — правка
// инструмента выпуска, и в списке изменений приложения она выглядит как обещание, которого
// никто не давал.
//
// В списке НЕТ refactor, хотя по названию он внутренний: в этом дереве им помечают как раз
// видимые вещи («действия в нижний бар», «убрать дубль 🔔 из сайдбара»). Отбрасывать его
// значило бы терять настоящие изменения — так что судим по тому, как тип используется здесь,
// а не по тому, что он значит вообще.
//
// И принцип для незнакомого: если тип не в этом списке — строка ОСТАЁТСЯ. Потерять из
// changelog настоящую правку хуже, чем оставить в нём лишнюю строку: лишнюю видно и её можно
// убрать руками, а пропавшую не видно вообще.
const INTERNAL_TYPES = ['chore', 'test', 'docs', 'build', 'ci', 'style', 'release'];
const INTERNAL_RE = new RegExp(`^- (?:${INTERNAL_TYPES.join('|')})(?:\\([^)]*\\))?!?:`, 'i');

let lastTag = '';
// --match 'v[0-9]*' обязателен, а не аккуратность: в репозитории есть теги, не имеющие
// к версиям приложения отношения — `whisper` и `whisper-<версия>` держат релизы
// распознавателя. Без фильтра describe находит ближайший ЛЮБОЙ тег, а он у нас стоит на
// том же HEAD, и весь changelog выходит пустым: диапазон `whisper..HEAD` — ничто.
try { lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']); }
catch { /* first release */ }
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const allLines = (git(['log', range, '--no-merges', '--pretty=- %s']) || '').split('\n').filter(Boolean);
const shown = allLines.filter((l) => !INTERNAL_RE.test(l));
// Релиз, в котором ВСЁ внутреннее, — это не пустой раздел: пустой выглядел бы как сломанный
// скрипт, да ещё и ушёл бы в сообщение тега (оно и есть этот текст). Тогда показываем всё как
// было — честнее сказать «менялись только внутренности» этими же строками, чем ничего.
const commits = (shown.length ? shown : allLines).join('\n') || '- начальный релиз';
if (shown.length && shown.length !== allLines.length) {
  step(`changelog: ${allLines.length - shown.length} внутренних коммитов не показаны`);
}
const today = new Date().toISOString().slice(0, 10);
const entry = `## ${version} — ${today}\n\n${commits}\n`;
const clHeader = '# Changelog\n\n';
let clBody = '';
try { clBody = readFileSync('CHANGELOG.md', 'utf8').replace(/^# Changelog\s*/, ''); } catch { /* new file */ }
writeFileSync('CHANGELOG.md', clHeader + entry + '\n' + clBody.replace(/^\n+/, ''));
step('CHANGELOG.md updated');

// 5. README download links ---------------------------------------------------
const dmgFile = `swarm-${version}-arm64.dmg`;
const exeFile = `swarm-${version}-x64.exe`;
// Имена линуксовых файлов задаёт linux.artifactName в package.json — держать их в согласии.
const appImageFile = `swarm-${version}-x64.AppImage`;
const debFile = `swarm-${version}-x64.deb`;
const base = `https://github.com/${REPO}/releases/download/v${version}`;
const dl = [
  '<!--DL-->',
  `**Последняя версия: ${version}** · [все релизы](https://github.com/${REPO}/releases)`,
  '',
  `- **macOS** (Apple Silicon): [\`${dmgFile}\`](${base}/${dmgFile})`,
  `- **Windows**: [\`${exeFile}\`](${base}/${exeFile}) — собирается в CI после тега`,
  `- **Linux** (x64): [\`${appImageFile}\`](${base}/${appImageFile}) или [\`${debFile}\`](${base}/${debFile}) для Debian/Ubuntu/Kubuntu — собираются в CI после тега`,
  '<!--/DL-->',
].join('\n');
// Кнопки скачивания в самой шапке — второе место с теми же файлами. Держать его руками
// нельзя: разъехавшись, оно предложит с первого экрана версию, которой уже нет.
const dlTop = [
  '<!--DLTOP-->',
  `  <a href="${base}/${dmgFile}"><b>⬇&nbsp;&nbsp;Скачать для macOS</b></a>`,
  '  &nbsp;·&nbsp;',
  `  <a href="${base}/${exeFile}"><b>⬇&nbsp;&nbsp;Скачать для Windows</b></a>`,
  '  &nbsp;·&nbsp;',
  `  <a href="LINUX.md"><b>⬇&nbsp;&nbsp;Скачать для Linux</b></a>`,
  '  <br>',
  `  <sub>v${version} · Apple Silicon · <a href="#установка">macOS: один шаг после скачивания</a></sub>`,
  '  <!--/DLTOP-->',
].join('\n');
let readme = readFileSync('README.md', 'utf8');
readme = readme.includes('<!--DL-->')
  ? readme.replace(/<!--DL-->[\s\S]*?<!--\/DL-->/, dl)
  : readme.replace(/\n## /, `\n## Скачать\n\n${dl}\n\n## `); // insert before the first section
if (!/<!--DLTOP-->[\s\S]*?<!--\/DLTOP-->/.test(readme)) {
  fail('в README.md нет блока <!--DLTOP--> — кнопки скачивания в шапке остались бы от прошлой версии');
}
readme = readme.replace(/<!--DLTOP-->[\s\S]*?<!--\/DLTOP-->/, dlTop);
writeFileSync('README.md', readme);
step('README.md download links updated');

// 6. commit + tag ------------------------------------------------------------
sh('git', ['add', 'package.json', 'CHANGELOG.md', 'README.md']);
sh('git', ['commit', '-m', `release: v${version}`]);
sh('git', ['tag', '-a', `v${version}`, '-m', entry.trim()]);
step(`committed + tagged v${version}`);

// 7. build the dmg -----------------------------------------------------------
// electron-builder re-verifies the Electron dist against GitHub on every build;
// when GitHub's asset CDN is slow that download times out even though the zip is
// already cached. If we find the cached zip, hand it to electron-builder via
// electronDist so the build never touches the network for Electron.
function cachedElectronDist() {
  try {
    const ver = readFileSync('node_modules/electron/dist/version', 'utf8').trim();
    const zip = `electron-v${ver}-darwin-${process.arch}.zip`;
    const root = path.join(os.homedir(), 'Library', 'Caches', 'electron');
    for (const d of readdirSync(root)) {
      if (existsSync(path.join(root, d, zip))) return path.join(root, d);
    }
  } catch { /* no cache — fall back to a normal download */ }
  return null;
}
// build-info.json — this build's runtimeId, bundled into the asar.
// runtimeId = sha256(electronVersion|nodePtyVersion); if it changes between releases,
// app.asar isn't swap-safe and a full installer is required — то есть каждому придётся
// переставить приложение руками. Поднимать Electron или node-pty в одном релизе с чем-то
// ещё поэтому не стоит: бамп сам по себе стоит людям ручной установки.
const here = path.dirname(fileURLToPath(import.meta.url));
sh('node', [path.join(here, 'write-build-info.mjs')]);
const runtimeId = JSON.parse(readFileSync('build-info.json', 'utf8')).runtimeId;
step(`build-info.json (runtimeId ${runtimeId.slice(0, 12)}…)`);
step('building .dmg (npm run dist) …');
const distDir = cachedElectronDist();
if (distDir) step(`using cached Electron (offline-safe): ${distDir}`);
sh('npm', distDir ? ['run', 'dist', '--', `-c.electronDist=${distDir}`] : ['run', 'dist']);
const dmg = readdirSync('dist').find((f) => f === dmgFile) || readdirSync('dist').find((f) => f.endsWith('.dmg'));
if (!dmg) fail('no .dmg found in dist/ after build');

// 8. assets: app.asar + manifest.json ----------------------------------------
// Кладём рядом с .dmg в dist/: `gh release upload` берёт имя ассета из имени файла, а
// asar лежит глубоко внутри .app и назвался бы правильно только случайно.
const asarSrc = path.join('dist', 'mac-arm64', 'Swarm.app', 'Contents', 'Resources', 'app.asar');
if (!existsSync(asarSrc)) fail('app.asar not found at ' + asarSrc);
// Drop darwin natives packed into the asar — Windows must keep using its own
// app.asar.unpacked/conpty.node after an asar-swap (see scripts/strip-asar-natives.mjs).
sh('node', [path.join(here, 'strip-asar-natives.mjs'), asarSrc]);
const asarPath = path.join('dist', 'app.asar');
copyFileSync(asarSrc, asarPath);
const asarBytes = readFileSync(asarPath);
const asarSha = createHash('sha256').update(asarBytes).digest('hex');
step(`app.asar готов (${(asarBytes.length / 1e6).toFixed(1)} MB)`);

// Notes = the changelog section we just generated for this version.
const manifest = {
  version,
  runtimeId,
  asar: { url: `${base}/app.asar`, sha256: asarSha },
  installers: {
    dmg: `${base}/${dmgFile}`,
    exe: `${base}/${exeFile}`,
    appimage: `${base}/${appImageFile}`,
    deb: `${base}/${debFile}`,
  },
  notes: commits,
  pubDate: today,
};
const manifestPath = path.join('dist', 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
step('manifest.json готов');

// 9. push --------------------------------------------------------------------
// Тег уходит ДО создания релиза: gh привязывает релиз к существующему тегу, а иначе
// создал бы свой легковесный вместо нашего аннотированного (в его сообщении — changelog).
step('pushing main + tag …');
sh('git', ['push', 'origin', 'main']);
sh('git', ['push', 'origin', `v${version}`]);

// 10. draft release ----------------------------------------------------------
step('создаю черновик релиза …');
sh('gh', [
  'release', 'create', `v${version}`,
  '--repo', REPO,
  '--draft',
  '--title', `v${version}`,
  '--notes', entry.trim(),
  path.join('dist', dmgFile),
  asarPath,
  manifestPath,
]);

console.log(`\n✔ v${version} собран и выложен черновиком. Дальше CI собирает .exe и Linux,`);
console.log('  доливает его в релиз и снимает черновик — до этого момента');
console.log('  обновлялка новую версию не видит, и это нарочно.');
console.log(`  https://github.com/${REPO}/actions`);
