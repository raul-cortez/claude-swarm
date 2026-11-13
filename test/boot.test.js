// Тесты выбора «бандл или обновлённый код» (boot-core). Без fs и electron.
// Запуск: node test/boot.test.js
const assert = require('assert');
const core = require('../boot-core');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const BUNDLE = '0.30.0';
const state = (over) => Object.assign({ pointer: null, marker: null, bundleVersion: BUNDLE }, over || {});
const pointer = (over) => Object.assign({ version: '0.31.0', file: '0.31.0.asar' }, over || {});

test('без указателя запускается код из бандла', () => {
  const d = core.decideBoot(state());
  assert.strictEqual(d.kind, 'bundle');
});

test('свежее обновление запускается вместо бандла', () => {
  const d = core.decideBoot(state({ pointer: pointer() }));
  assert.deepStrictEqual(
    { kind: d.kind, file: d.file, version: d.version },
    { kind: 'payload', file: '0.31.0.asar', version: '0.31.0' }
  );
});

test('обновление не новее бандла игнорируется — приложение переставили', () => {
  // Человек скачал dmg 0.30.0 поверх, а рядом лежит обновление 0.30.0 от прошлого раза.
  assert.strictEqual(core.decideBoot(state({ pointer: pointer({ version: '0.30.0' }) })).kind, 'bundle');
  assert.strictEqual(core.decideBoot(state({ pointer: pointer({ version: '0.29.1' }) })).kind, 'bundle');
});

test('битый указатель не роняет запуск', () => {
  for (const p of [{}, { version: '0.31.0' }, { file: 'x.asar' }, { version: 1, file: 'x.asar' }]) {
    assert.strictEqual(core.decideBoot(state({ pointer: p })).kind, 'bundle');
  }
});

test('указатель не уводит загрузку из своей папки', () => {
  for (const file of ['../../evil.asar', '/etc/passwd', '..', 'sub\\evil.asar', '']) {
    assert.strictEqual(core.decideBoot(state({ pointer: pointer({ file }) })).kind, 'bundle');
  }
});

test('одна неудачная попытка версию не хоронит — так выходит вторая копия Svarmo', () => {
  const d = core.decideBoot(state({ pointer: pointer(), marker: { version: '0.31.0', attempts: 1 } }));
  assert.strictEqual(d.kind, 'payload');
  assert.strictEqual(d.attempt, 2);           // считаем дальше
});

test('после предела неудач подряд версия бракуется', () => {
  const marker = { version: '0.31.0', attempts: core.ATTEMPT_LIMIT };
  const d = core.decideBoot(state({ pointer: pointer(), marker }));
  assert.strictEqual(d.kind, 'bundle');
  assert.strictEqual(d.bad, '0.31.0.asar');   // файл убирается с дороги
  assert.match(d.reason, /не дошла/);
});

test('счётчик попыток начинается заново для каждой версии', () => {
  // Прошлое обновление падало, следующее приехало с исправлением — оно должно поехать.
  const marker = { version: '0.31.0', attempts: 9 };
  const d = core.decideBoot(state({ pointer: pointer({ version: '0.32.0', file: '0.32.0.asar' }), marker }));
  assert.strictEqual(d.kind, 'payload');
  assert.strictEqual(d.attempt, 1);
  assert.strictEqual(d.bad, undefined);
});

test('метка без счётчика читается как одна попытка', () => {
  // Файл от версии, которая писала метку без счётчика.
  const d = core.decideBoot(state({ pointer: pointer(), marker: { version: '0.31.0' } }));
  assert.strictEqual(d.kind, 'payload');
  assert.strictEqual(d.attempt, 2);
});

test('в папке остаётся только запускаемая версия и улики', () => {
  const names = ['0.30.0.asar', '0.31.0.asar', '0.31.0.asar.part', '0.29.0.asar.broken', 'current.json', 'loading.json'];
  assert.deepStrictEqual(
    core.stalePayloads(names, '0.31.0.asar').sort(),
    ['0.30.0.asar', '0.31.0.asar.part']
  );
});

test('идём из бандла — обновлений рядом держать незачем', () => {
  const names = ['0.30.0.asar', '0.31.0.asar.part', '0.29.0.asar.broken', 'current.json'];
  assert.deepStrictEqual(
    core.stalePayloads(names, null).sort(),
    ['0.30.0.asar', '0.31.0.asar.part']
  );
});

test('safeName пропускает только простые имена', () => {
  assert.strictEqual(core.safeName('0.31.0.asar'), true);
  assert.strictEqual(core.safeName('a/b'), false);
  assert.strictEqual(core.safeName('..'), false);
  assert.strictEqual(core.safeName(null), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
