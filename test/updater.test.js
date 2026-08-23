// Pure-logic tests for the updater (no fs/net). Run: node test/updater.test.js
const assert = require('assert');
const core = require('../updater-core');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const RID = core.computeRuntimeId('29.4.6', '0.13.1'); // a stable id for tests

function manifest(over) {
  return Object.assign({
    version: '0.4.0',
    runtimeId: RID,
    asar: { url: 'https://x/app.asar', sha256: 'ABCD' },
    installers: { dmg: 'https://x/a.dmg', exe: 'https://x/a.exe' },
    notes: 'note', pubDate: '2026-07-09',
  }, over || {});
}

test('compareVersions orders semver', () => {
  assert.strictEqual(core.compareVersions('0.4.0', '0.3.9'), 1);
  assert.strictEqual(core.compareVersions('0.3.0', '0.3.1'), -1);
  assert.strictEqual(core.compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(core.compareVersions('0.10.0', '0.9.0'), 1); // numeric, not lexical
});

test('computeRuntimeId is deterministic and input-sensitive', () => {
  assert.strictEqual(core.computeRuntimeId('29.4.6', '0.13.1'), core.computeRuntimeId('29.4.6', '0.13.1'));
  assert.notStrictEqual(core.computeRuntimeId('29.4.6', '0.13.1'), core.computeRuntimeId('30.0.0', '0.13.1'));
});

test('validateManifest normalizes and lowercases sha', () => {
  const m = core.validateManifest(manifest());
  assert.strictEqual(m.asar.sha256, 'abcd');
  assert.strictEqual(m.version, '0.4.0');
});

test('validateManifest throws on bad input', () => {
  assert.throws(() => core.validateManifest(null));
  assert.throws(() => core.validateManifest(manifest({ version: 'x' })));
  assert.throws(() => core.validateManifest(manifest({ asar: { url: 'u' } }))); // no sha256
});

test('decideUpdate: none when not newer', () => {
  assert.strictEqual(core.decideUpdate('0.4.0', RID, manifest()).kind, 'none');
  assert.strictEqual(core.decideUpdate('0.5.0', RID, manifest()).kind, 'none');
});

test('decideUpdate: asar when newer and runtimeId matches', () => {
  const d = core.decideUpdate('0.3.0', RID, manifest());
  assert.strictEqual(d.kind, 'asar');
  assert.strictEqual(d.version, '0.4.0');
  assert.strictEqual(d.asar.sha256, 'abcd');
});

test('decideUpdate: installer when newer but runtimeId differs', () => {
  const d = core.decideUpdate('0.3.0', 'DIFFERENT', manifest());
  assert.strictEqual(d.kind, 'installer');
  assert.ok(d.installers.dmg);
});

// Указатель payload/ пишут ПРОШЛЫЕ версии приложения, поэтому вход тут — что угодно, и
// каждая порча должна давать «ничего не ждёт», а не падение: на этом ответе висит плашка,
// которая иначе предложила бы качать уже скачанное.
test('pendingFrom: ждёт только то, что новее работающего', () => {
  const ptr = (v) => JSON.stringify({ version: v, file: v + '.asar' });
  assert.strictEqual(core.pendingFrom(ptr('0.40.0'), '0.36.4'), '0.40.0');
  assert.strictEqual(core.pendingFrom(ptr('0.36.4'), '0.36.4'), '');
  assert.strictEqual(core.pendingFrom(ptr('0.9.0'), '0.40.0'), '');
});

test('pendingFrom: любой мусор в указателе — это «ничего не ждёт»', () => {
  for (const raw of ['', 'not json', '{}', '{"version":""}', '{"version":"latest"}', 'null', undefined]) {
    assert.strictEqual(core.pendingFrom(raw, '0.36.4'), '', 'на входе: ' + String(raw));
  }
});

// owner/repo из package.json — одно место на всё приложение. Тест на все три формы записи
// сразу: переименование аккаунта должно править одну строку, а не четыре файла.
test('ghSlug понимает все формы поля repository', () => {
  assert.strictEqual(core.ghSlug('github:owner/repo'), 'owner/repo');
  assert.strictEqual(core.ghSlug('https://github.com/owner/repo.git'), 'owner/repo');
  assert.strictEqual(core.ghSlug('https://github.com/owner/repo'), 'owner/repo');
  assert.strictEqual(core.ghSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.strictEqual(core.ghSlug({ type: 'git', url: 'https://github.com/owner/repo.git' }), 'owner/repo');
});

test('ghSlug возвращает null, а не мусор, когда взять неоткуда', () => {
  assert.strictEqual(core.ghSlug(undefined), null);
  assert.strictEqual(core.ghSlug(''), null);
  assert.strictEqual(core.ghSlug('https://gitlab.example/owner/repo.git'), null);
});

// Живое package.json: без repository обновления просто не найдут, куда идти, поэтому
// проверяем не форму, а что оно на месте и разбирается.
test('repository в package.json разбирается в owner/repo', () => {
  const pkg = require('../package.json');
  assert.ok(core.ghSlug(pkg.repository), 'repository в package.json не разбирается: ' + pkg.repository);
});

// Редиректы. Ассеты гитхаба лежат за 302, и без прохода по Location обновление не
// работает вообще — поэтому решение вынесено в чистую функцию и покрыто здесь.
const GH = 'https://github.com/owner/repo/releases/latest/download/manifest.json';

test('nextHop: 200 — приехали', () => {
  assert.strictEqual(core.nextHop(200, undefined, GH, 0).kind, 'ok');
});

test('nextHop: идёт за Location на всех редиректных статусах', () => {
  for (const code of [301, 302, 303, 307, 308]) {
    const h = core.nextHop(code, 'https://objects.githubusercontent.com/x', GH, 0);
    assert.strictEqual(h.kind, 'follow', 'статус ' + code);
    assert.strictEqual(h.url, 'https://objects.githubusercontent.com/x');
  }
});

test('nextHop: относительный Location разрешается от текущего адреса', () => {
  const h = core.nextHop(302, '/owner/repo/releases/download/v0.22.0/app.asar', GH, 0);
  assert.strictEqual(h.kind, 'follow');
  assert.strictEqual(h.url, 'https://github.com/owner/repo/releases/download/v0.22.0/app.asar');
});

test('nextHop: петля обрывается на лимите', () => {
  const at = (count) => core.nextHop(302, 'https://x/y', GH, count, 5);
  assert.strictEqual(at(4).kind, 'follow');   // пятый переход ещё разрешён
  assert.strictEqual(at(5).kind, 'fail');     // шестой — уже нет
  assert.match(at(5).message, /редирект/);
});

test('nextHop: редирект без Location и битый Location — ошибка, не переход', () => {
  assert.strictEqual(core.nextHop(302, '', GH, 0).kind, 'fail');
  assert.strictEqual(core.nextHop(302, 'http://[', GH, 0).kind, 'fail');
});

test('nextHop: прочие статусы — ошибка с кодом в тексте', () => {
  const h = core.nextHop(404, undefined, GH, 0);
  assert.strictEqual(h.kind, 'fail');
  assert.match(h.message, /404/);
});

test('isNetworkError: обрыв связи отделён от нашей поломки', () => {
  const withCode = (code) => Object.assign(new Error('boom'), { code });
  assert.strictEqual(core.isNetworkError(new Error('timeout')), true); // req.setTimeout в updater.js
  assert.strictEqual(core.isNetworkError(withCode('ENOTFOUND')), true);
  assert.strictEqual(core.isNetworkError(withCode('ECONNRESET')), true);
  assert.strictEqual(core.isNetworkError(new Error('HTTP 404')), false); // нет манифеста в релизе
  assert.strictEqual(core.isNetworkError(new Error('bad version')), false);
  assert.strictEqual(core.isNetworkError(null), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
