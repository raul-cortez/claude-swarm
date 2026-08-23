// Plain-node tests for the tab card style settings (no framework: run
// `node test/tabstyle.test.js`). tabstyle.js is dual-mode (browser global +
// CommonJS), so it can be required straight into Node.
const assert = require('assert');
const T = require('../renderer/tabstyle');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HEX = /^#[0-9a-fA-F]{6}$/;

test('exposes three densities with unique ids and names', () => {
  assert.strictEqual(T.DENSITIES.length, 3);
  const ids = T.DENSITIES.map((d) => d.id);
  assert.deepStrictEqual(ids, ['compact', 'normal', 'roomy']);
  for (const d of T.DENSITIES) assert.ok(d.name && typeof d.name === 'string', d.id);
});

test('COLORS describes exactly the keys of DEFAULT_TABSTYLE.colors', () => {
  const listed = T.COLORS.map((c) => c.key).sort();
  const actual = Object.keys(T.DEFAULT_TABSTYLE.colors).sort();
  assert.deepStrictEqual(listed, actual);
  for (const c of T.COLORS) assert.ok(c.name && typeof c.name === 'string', c.key);
});

test('default colors mirror the hardcoded :root palette (regression)', () => {
  // styles.css:10-22 — если правишь палитру там, правь и здесь.
  assert.deepStrictEqual(T.DEFAULT_TABSTYLE.colors, {
    run:     '#e0a53f',
    ready:   '#4ade80',
    waiting: '#3fd0c9',
    danger:  '#e05a5a',
  });
});

test('every default color is a valid hex', () => {
  for (const k of Object.keys(T.DEFAULT_TABSTYLE.colors)) {
    assert.ok(HEX.test(T.DEFAULT_TABSTYLE.colors[k]), k);
  }
});

test('normalizeTabStyle fills defaults from empty/garbage input', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const s = T.normalizeTabStyle(bad);
    assert.strictEqual(s.density, 'normal', String(bad));
    assert.strictEqual(s.status, 'both', String(bad));
    assert.deepStrictEqual(s.show, { ctx: true, sub: true });
    assert.deepStrictEqual(s.colors, T.DEFAULT_TABSTYLE.colors);
  }
});

test('STATUS_STYLES: три способа показать статус, ни одного «никак»', () => {
  assert.deepStrictEqual(T.STATUS_STYLES.map((x) => x.id), ['dot', 'fill', 'both']);
  for (const x of T.STATUS_STYLES) assert.ok(x.name && typeof x.name === 'string', x.id);
});

test('normalizeTabStyle keeps a known status and falls back on a bogus one', () => {
  assert.strictEqual(T.normalizeTabStyle({ status: 'fill' }).status, 'fill');
  assert.strictEqual(T.normalizeTabStyle({ status: 'dot' }).status, 'dot');
  assert.strictEqual(T.normalizeTabStyle({ status: 'nope' }).status, 'both');
});

// Переезд со старой формы: точка и заливка были двумя галочками. Настройки людей
// лежат в localStorage в ней, и потерять их выбор нельзя.
test('normalizeTabStyle переносит старые show.dot / show.statusFill в status', () => {
  const cases = [
    [{ dot: true, statusFill: true }, 'both'],
    [{ dot: false, statusFill: true }, 'fill'],
    [{ dot: true, statusFill: false }, 'dot'],
    [{ dot: false, statusFill: false }, 'dot'],  // «без цвета» больше нельзя — точка тише всего
  ];
  for (const [show, want] of cases) {
    assert.strictEqual(T.normalizeTabStyle({ show }).status, want, JSON.stringify(show));
  }
});

test('новое поле status побеждает старые галочки, если есть и то и то', () => {
  assert.strictEqual(T.normalizeTabStyle({ status: 'dot', show: { dot: false, statusFill: true } }).status, 'dot');
});

test('снятые настройки больше не возвращаются из нормализации', () => {
  const s = T.normalizeTabStyle({ show: { agents: false, agentOrange: false }, labelSize: 15, subSize: 9 });
  assert.deepStrictEqual(Object.keys(s.show), ['ctx', 'sub'], 'значок и оранжевый сабагент сняты');
  assert.strictEqual(s.labelSize, undefined, 'размеры несёт пресет плотности');
  assert.strictEqual(s.subSize, undefined);
});

test('normalizeTabStyle falls back on unknown density', () => {
  assert.strictEqual(T.normalizeTabStyle({ density: 'bogus' }).density, 'normal');
  assert.strictEqual(T.normalizeTabStyle({ density: 'compact' }).density, 'compact');
});

test('normalizeTabStyle keeps valid booleans and fills missing ones', () => {
  const s = T.normalizeTabStyle({ show: { ctx: false, sub: 'yes' } });
  assert.strictEqual(s.show.ctx, false);
  assert.strictEqual(s.show.sub, true, 'non-boolean falls back to default');
});

test('normalizeTabStyle rejects a bad hex and lowercases a good one', () => {
  const s = T.normalizeTabStyle({ colors: { ready: 'red', run: '#ABCDEF' } });
  assert.strictEqual(s.ready, undefined, 'colors live under .colors');
  assert.strictEqual(s.colors.ready, T.DEFAULT_TABSTYLE.colors.ready);
  assert.strictEqual(s.colors.run, '#abcdef');
});

// Акцент интерфейса ушёл из настроек: он не статус, им покрашены кнопки и фокус,
// а открытую вкладку обводит цвет её собственного статуса (--tab-c в styles.css).
// Тест держит границу: пипетки красят только состояния работы.
test('accent is no longer a настраиваемый цвет — ни в списке, ни в хранимом', () => {
  assert.ok(!T.COLORS.some((c) => c.key === 'accent'), 'нет пипетки «активная»');
  assert.strictEqual(T.DEFAULT_TABSTYLE.colors.accent, undefined);
  const s = T.normalizeTabStyle({ colors: { accent: '#ff0000', run: '#e0a53f' } });
  assert.strictEqual(s.colors.accent, undefined, 'старое значение из localStorage отбрасывается');
  assert.strictEqual(T.toCssVars(s)['--accent'], undefined, 'хром не перекрашивается настройкой');
});

test('normalizeTabStyle deep-copies: mutating the result leaves input alone', () => {
  const input = T.normalizeTabStyle(null);
  const copy = T.normalizeTabStyle(input);
  copy.show.ctx = false;
  copy.colors.ready = '#000000';
  assert.strictEqual(input.show.ctx, true);
  assert.strictEqual(input.colors.ready, T.DEFAULT_TABSTYLE.colors.ready);
});

test('toCssVars returns exactly the four status vars', () => {
  const v = T.toCssVars(T.normalizeTabStyle(null));
  assert.deepStrictEqual(Object.keys(v).sort(), [
    '--danger', '--ready', '--run', '--waiting',
  ]);
  assert.strictEqual(v['--waiting'], '#3fd0c9');
  assert.strictEqual(v['--tab-label-size'], undefined, 'размеры текста несёт пресет плотности');
});

test('toCssVars normalizes garbage instead of emitting it', () => {
  const v = T.toCssVars({ colors: { danger: 'oops' } });
  assert.strictEqual(v['--danger'], T.DEFAULT_TABSTYLE.colors.danger);
});

test('bodyClasses always names the density and nothing else by default', () => {
  assert.deepStrictEqual(T.bodyClasses(T.normalizeTabStyle(null)), ['tabs-normal']);
  assert.deepStrictEqual(T.bodyClasses({ density: 'compact' }), ['tabs-compact']);
});

test('bodyClasses adds one tab-no-* class per hidden element', () => {
  const all = T.bodyClasses({ status: 'dot', show: { ctx: false, sub: false } });
  assert.deepStrictEqual(all, ['tabs-normal', 'tab-no-fill', 'tab-no-ctx', 'tab-no-sub']);
  assert.deepStrictEqual(T.bodyClasses({ show: { sub: false } }), ['tabs-normal', 'tab-no-sub']);
});

// Ни одно значение status не гасит оба канала сразу: карточка без статуса — это
// дырка, из-за которой две галочки и превратились в один выбор.
test('bodyClasses: каждый способ гасит ровно противоположный канал', () => {
  assert.deepStrictEqual(T.bodyClasses({ status: 'both' }), ['tabs-normal']);
  assert.deepStrictEqual(T.bodyClasses({ status: 'dot' }), ['tabs-normal', 'tab-no-fill']);
  assert.deepStrictEqual(T.bodyClasses({ status: 'fill' }), ['tabs-normal', 'tab-no-dot']);
  for (const x of T.STATUS_STYLES) {
    const cls = T.bodyClasses({ status: x.id });
    assert.ok(!(cls.includes('tab-no-dot') && cls.includes('tab-no-fill')), x.id);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
