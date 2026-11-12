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
    assert.strictEqual(s.statusLane, 'bg', String(bad));
    assert.strictEqual(s.colorLane, 'stripe', String(bad));
    assert.deepStrictEqual(s.show, { ctx: true, sub: true });
    assert.deepStrictEqual(s.colors, T.DEFAULT_TABSTYLE.colors);
  }
});

test('дорожки: статус — фон/рамка/полоска/только точка, цвет — три первые', () => {
  assert.deepStrictEqual(T.STATUS_LANES.map((x) => x.id), ['bg', 'border', 'stripe', 'dot']);
  assert.deepStrictEqual(T.COLOR_LANES.map((x) => x.id), ['bg', 'border', 'stripe']);
  for (const x of T.STATUS_LANES) assert.ok(x.name && typeof x.name === 'string', x.id);
});

test('палитра своего цвета: шесть, валидный hex, не совпадает со статусными', () => {
  assert.strictEqual(T.OWN_COLORS.length, 6);
  const status = Object.values(T.DEFAULT_TABSTYLE.colors);
  for (const c of T.OWN_COLORS) {
    assert.match(c.hex, HEX, c.id);
    assert.ok(!status.includes(c.hex), c.id);
    assert.ok(c.name && c.dot, c.id);
  }
  assert.strictEqual(new Set(T.OWN_COLORS.map((c) => c.id)).size, 6);
  assert.strictEqual(T.ownColorHex('pink'), '#f472b6');
  assert.strictEqual(T.ownColorHex('nope'), null);
});

test('normalizeTabStyle: известные дорожки сохраняются, мусор — умолчание', () => {
  const s = T.normalizeTabStyle({ statusLane: 'border', colorLane: 'bg' });
  assert.strictEqual(s.statusLane, 'border');
  assert.strictEqual(s.colorLane, 'bg');
  const bad = T.normalizeTabStyle({ statusLane: 'zzz', colorLane: 'dot' });
  assert.strictEqual(bad.statusLane, 'bg');
  assert.strictEqual(bad.colorLane, 'stripe', '«точка» — не дорожка для цвета');
});

test('normalizeTabStyle: сохранённое столкновение дорожек разводится', () => {
  const s = T.normalizeTabStyle({ statusLane: 'stripe', colorLane: 'stripe' });
  assert.notStrictEqual(s.statusLane, s.colorLane);
  assert.strictEqual(s.statusLane, 'stripe', 'статус остаётся, цвет уступает');
});

// Миграция localStorage: прежние режимы статуса переезжают на дорожки.
test('normalizeTabStyle переносит прежний status в statusLane', () => {
  const cases = [['both', 'bg'], ['fill', 'bg'], ['dot', 'dot']];
  for (const [old, want] of cases) {
    assert.strictEqual(T.normalizeTabStyle({ status: old }).statusLane, want, old);
  }
});

test('normalizeTabStyle переносит и совсем старые show.dot / show.statusFill', () => {
  const cases = [
    [{ dot: true, statusFill: true }, 'bg'],
    [{ dot: false, statusFill: true }, 'bg'],
    [{ dot: true, statusFill: false }, 'dot'],
    [{ dot: false, statusFill: false }, 'dot'],
  ];
  for (const [show, want] of cases) {
    assert.strictEqual(T.normalizeTabStyle({ show }).statusLane, want, JSON.stringify(show));
  }
});

test('новое поле statusLane побеждает прежние', () => {
  assert.strictEqual(T.normalizeTabStyle({ statusLane: 'stripe', status: 'dot' }).statusLane, 'stripe');
});

// Главное правило: одна дорожка на двоих невозможна, выбор двигает соседа на освободившуюся.
test('setLane: цвет на дорожку статуса — статус переезжает на место цвета', () => {
  const s = T.setLane({ statusLane: 'bg', colorLane: 'stripe' }, 'color', 'bg');
  assert.strictEqual(s.colorLane, 'bg');
  assert.strictEqual(s.statusLane, 'stripe');
});

test('setLane: статус на дорожку цвета — цвет переезжает на место статуса', () => {
  const s = T.setLane({ statusLane: 'bg', colorLane: 'stripe' }, 'status', 'stripe');
  assert.strictEqual(s.statusLane, 'stripe');
  assert.strictEqual(s.colorLane, 'bg');
});

test('setLane: «только точкой» дорожек не занимает; из неё цвет не вытесняется', () => {
  const a = T.setLane({ statusLane: 'bg', colorLane: 'stripe' }, 'status', 'dot');
  assert.deepStrictEqual([a.statusLane, a.colorLane], ['dot', 'stripe']);
  // выходя из «точки» на дорожку цвета, статус не оставляет цвету свободного места «где был» —
  // цвет берёт первую свободную
  const b = T.setLane({ statusLane: 'dot', colorLane: 'bg' }, 'status', 'bg');
  assert.strictEqual(b.statusLane, 'bg');
  assert.notStrictEqual(b.colorLane, 'bg');
});

test('setLane: любой выбор оставляет разные дорожки; мусор ничего не меняет', () => {
  for (const sl of T.STATUS_LANES) for (const cl of T.COLOR_LANES) {
    if (sl.id === cl.id) continue;
    for (const lane of T.STATUS_LANES) {
      const s = T.setLane({ statusLane: sl.id, colorLane: cl.id }, 'status', lane.id);
      assert.strictEqual(s.statusLane, lane.id);
      assert.notStrictEqual(s.statusLane, s.colorLane);
    }
    for (const lane of T.COLOR_LANES) {
      const s = T.setLane({ statusLane: sl.id, colorLane: cl.id }, 'color', lane.id);
      assert.strictEqual(s.colorLane, lane.id);
      assert.notStrictEqual(s.statusLane, s.colorLane);
    }
  }
  const same = T.setLane({ statusLane: 'bg', colorLane: 'stripe' }, 'color', 'dot');
  assert.deepStrictEqual([same.statusLane, same.colorLane], ['bg', 'stripe']);
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

test('bodyClasses: плотность и по классу на каждую дорожку', () => {
  assert.deepStrictEqual(T.bodyClasses(T.normalizeTabStyle(null)),
    ['tabs-normal', 'status-lane-bg', 'color-lane-stripe']);
  assert.deepStrictEqual(T.bodyClasses({ density: 'compact', statusLane: 'dot', colorLane: 'border' }),
    ['tabs-compact', 'status-lane-dot', 'color-lane-border']);
});

test('bodyClasses adds one tab-no-* class per hidden element', () => {
  const all = T.bodyClasses({ show: { ctx: false, sub: false } });
  assert.deepStrictEqual(all, ['tabs-normal', 'status-lane-bg', 'color-lane-stripe', 'tab-no-ctx', 'tab-no-sub']);
});

// --- превью не должно жить по бою -------------------------------------------
// Живой промах: применено «заливкой» (на body стоит tab-no-dot), человек выбирает в настройках
// «точкой» — заливка в превью гаснет, а точка не появляется. Причина не в логике, а в CSS:
// правило висело на `:where(body, #set-tab-preview)`, то есть боевое и превьюшное совпадали до
// буквы, и решал не близость к карточке, а то, какой предок нашёлся. Превью лежит внутри body,
// поэтому бой всегда и выигрывал. Тест держит развод этих двух адресов: правило от body внутрь
// превью не лезет (`:not(#set-tab-preview *)`), у превью своё.
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('вид карточки: боевое правило не достаёт до превью в настройках', () => {
  // Один селектор на оба адреса — ровно та форма, которая ломала предпросмотр. Запрещена она
  // только там, где правило целится в ПОТОМКА (` .tab …`): в блоках, задающих переменные на
  // самом элементе, `:where(body, #set-tab-preview)` безопасен — своё правило на элементе
  // всегда сильнее унаследованного значения.
  for (const line of css.split('\n')) {
    if (!line.includes(':where(body, #set-tab-preview)')) continue;
    assert.doesNotMatch(line, /:where\(body,\s*#set-tab-preview\)[^,{]*\s\.[\w-]/,
      'превью снова живёт по бою, а не по черновику: ' + line.trim());
  }
  for (const cls of ['tab-no-ctx', 'tab-no-sub']) {
    assert.ok(css.includes(`body.${cls} `), cls + ': нет боевого правила');
    assert.ok(css.includes(`#set-tab-preview.${cls} `), cls + ': нет правила для превью');
    // Боевое правило обязано исключать превью — иначе черновик снова нечем перебить.
    const live = css.split('\n').filter((l) => l.includes(`body.${cls} `));
    for (const l of live) {
      assert.match(l, /:not\(#set-tab-preview \*\)/, cls + ': боевое правило лезет в превью — ' + l.trim());
    }
  }
});

// Дорожки: класс на body/превью лишь ставит переменную НА СЕБЕ, а правила карточек спрашивают её
// style-запросом — так превью живёт по черновику без пары селекторов.
test('дорожки: на каждый класс есть переменная и style-запрос', () => {
  for (const l of T.STATUS_LANES) {
    assert.ok(css.includes(`:where(body, #set-tab-preview).status-lane-${l.id} `), 'status-lane-' + l.id);
    assert.ok(css.includes(`@container style(--st-lane: ${l.id})`), 'запрос статуса ' + l.id);
  }
  for (const l of T.COLOR_LANES) {
    assert.ok(css.includes(`:where(body, #set-tab-preview).color-lane-${l.id} `), 'color-lane-' + l.id);
    assert.ok(css.includes(`@container style(--own-lane: ${l.id})`), 'запрос цвета ' + l.id);
  }
});

// --- капсула кнопок на карточке (спека «Меню и кнопки на карточке») ---------
test('default tools — луна и крестик, как было кнопками всегда', () => {
  assert.deepStrictEqual(T.DEFAULT_TABSTYLE.tools, ['moon', 'close']);
});

test('normalizeTabStyle keeps a valid tools list', () => {
  const s = T.normalizeTabStyle({ tools: ['close', 'prorab'] });
  assert.deepStrictEqual(s.tools, ['close', 'prorab']);
});

test('normalizeTabStyle drops unknown keys, dedupes, and caps at three', () => {
  const s = T.normalizeTabStyle({ tools: ['close', 'bogus', 'close', 'moon', 'prorab', 'resume'] });
  assert.deepStrictEqual(s.tools, ['close', 'moon', 'prorab']);
});

test('normalizeTabStyle falls back to default tools on garbage', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepStrictEqual(T.normalizeTabStyle({ tools: bad }).tools, ['moon', 'close'], String(bad));
  }
});

test('normalizeTabStyle allows an empty tools list — потолок «ни одной»', () => {
  assert.deepStrictEqual(T.normalizeTabStyle({ tools: [] }).tools, []);
});

test('orderedTools рисует в фиксированном порядке, а не в порядке выбора', () => {
  assert.deepStrictEqual(T.orderedTools({ tools: ['resume', 'close', 'moon'] }), ['moon', 'resume', 'close']);
});

test('TOOL_DEFS описывает ровно ключи TOOL_KEYS', () => {
  assert.deepStrictEqual(T.TOOL_DEFS.map((t) => t.key).sort(), [...T.TOOL_KEYS].sort());
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
