// Plain-node tests for the statusline renderer (swarm-statusline.js).
//
// The subscription budget is the part worth pinning down: it comes from Claude Code
// and is OPTIONAL, so every «absent» path has to render nothing rather than a
// misleading zero — and the limit percentages must never reach the line before the
// context one, because the app parses the first % as the context fill.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  renderLine, usedPct, fmtEta, ctxUsed, usageSnapshot, usageReport,
  configRoot, settingsLayers, foreignCommandFrom, isOwnCommand, composeLine, readForeign,
  subNameOf,
} = require('../swarm-statusline');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 1_700_000_000;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// A statusline payload with a context window (so the context bar renders) and,
// optionally, the subscription limits.
function payload(rateLimits) {
  return {
    model: { display_name: 'Opus 5' },
    workspace: { current_dir: '/tmp/some-project' },
    session_id: 'no-such-session',
    context_window: { remaining_percentage: 80, total_tokens: 1_000_000 },
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  };
}

test('reports what is SPENT, the same direction as the site', () => {
  assert.strictEqual(usedPct({ used_percentage: 37 }), 37);
  assert.strictEqual(usedPct({ used_percentage: 0 }), 0);
});

test('rounds spend UP so it never reports less than has gone', () => {
  assert.strictEqual(usedPct({ used_percentage: 0.4 }), 1, 'a sliver spent is not nothing spent');
  assert.strictEqual(usedPct({ used_percentage: 62.1 }), 63);
});

test('a missing or non-numeric percentage yields no number at all', () => {
  assert.strictEqual(usedPct(undefined), null);
  assert.strictEqual(usedPct({}), null);
  assert.strictEqual(usedPct({ used_percentage: '37' }), null);
  assert.strictEqual(usedPct({ used_percentage: NaN }), null);
});

test('clamps a percentage outside 0..100', () => {
  assert.strictEqual(usedPct({ used_percentage: 140 }), 100);
  assert.strictEqual(usedPct({ used_percentage: -20 }), 0);
});

test('formats the reset countdown coarsely, by the largest two units', () => {
  assert.strictEqual(fmtEta(8040), '2ч14м');
  assert.strictEqual(fmtEta(1080), '18м');
  assert.strictEqual(fmtEta(273600), '3д4ч');
  assert.strictEqual(fmtEta(7200), '2ч');
  assert.strictEqual(fmtEta(172800), '2д');
  assert.strictEqual(fmtEta(-5), '0м', 'a reset already due is not negative time');
});

// --- расход подписки в строке БОЛЬШЕ НЕТ --------------------------------------
// Окна лимитов не про вкладку, а про аккаунт: их числа переехали в нижнюю панель приложения
// (одну для всех вкладок), а агенту их кладёт хук вместе с именем подписки. Под тестом теперь
// обратное утверждение: в строке их нет ни при каких числах — иначе они вернулись бы вторым
// местом, где то же самое показывается по-другому.
test('лимитов в строке нет ни при каких числах', () => {
  const line = strip(renderLine(payload({
    five_hour: { used_percentage: 90, resets_at: NOW + 8040 },
    seven_day: { used_percentage: 62, resets_at: NOW + 86400 },
  }), NOW));
  assert.strictEqual(line.includes('5ч'), false, 'пятичасовое окно в строке: ' + line);
  assert.strictEqual(line.includes('7д'), false, 'недельное окно в строке: ' + line);
  assert.strictEqual(line.includes('⚠'), false, 'пометка «почти кончилось» — теперь дело панели');
});

test('снимок расхода при этом пишется как раньше — из него живут все трое', () => {
  // Панель, ворота на подагентов и /usage кормятся снимком, а не строкой (см. usageSnapshot).
  const snap = usageSnapshot(payload({
    five_hour: { used_percentage: 90, resets_at: NOW + 8040 },
    seven_day: { used_percentage: 62, resets_at: NOW + 86400 },
  }), NOW, '/h/.claude');
  assert.deepStrictEqual(snap.five, { spent: 90, resetsAt: NOW + 8040 });
  assert.deepStrictEqual(snap.seven, { spent: 62, resetsAt: NOW + 86400 });
  assert.strictEqual(snap.home, '/h/.claude', 'в каком КОНФИГЕ это израсходовано');
});

test('the context percentage stays the first % in the line', () => {
  // Load-bearing: the app takes the first % as the context fill (renderer updateCtx).
  const line = strip(renderLine(payload({
    five_hour: { used_percentage: 37 },
    seven_day: { used_percentage: 62 },
  }), NOW));
  const first = line.match(/(\d+)\s*%/);
  assert.ok(first, 'the line carries a percentage');
  // 24% used: 80% of the window left, rescaled against the usable region (the
  // window minus the auto-compact buffer). Notably neither 37 nor 62 — the limits.
  assert.strictEqual(first[1], '24', 'the context fill, not a limit');
});

test('без полоски контекста в строке нет ни одного процента', () => {
  // Любой процент, вышедший вперёд полоски, вкладка нарисует КАК контекст.
  const data = payload({ five_hour: { used_percentage: 37 } });
  data.context_window = { remaining_percentage: null };
  const line = strip(renderLine(data, NOW));
  assert.strictEqual(line.includes('%'), false, line);
});

test('the line still renders without limits at all', () => {
  const line = strip(renderLine(payload(), NOW));
  assert.match(line, /Opus 5 │ some-project/);
  assert.match(line, /24%/);
});

// --- имя подписки в строке -----------------------------------------------------
// Только имя, никаких чисел — числа уже в общей панели приложения (см. subNameOf выше).
test('без имени строка не меняется вовсе — старый формат жив', () => {
  const line = strip(renderLine(payload(), NOW, ''));
  assert.match(line, /^Opus 5 │ some-project/, 'нет лишнего разделителя перед │');
});

test('с именем подписки оно встаёт между моделью и каталогом', () => {
  const line = strip(renderLine(payload(), NOW, 'мой личный'));
  assert.match(line, /^Opus 5 · мой личный │ some-project/);
});

test('subNameOf ищет карточку по home и не путает чужие', () => {
  const cards = [
    { home: '/h/.claude', name: 'рабочий' },
    { home: '/h/.claude-my', name: 'личный' },
  ];
  assert.strictEqual(subNameOf(cards, '/h/.claude-my'), 'личный');
  assert.strictEqual(subNameOf(cards, '/h/.claude'), 'рабочий');
});

test('subNameOf молчит, а не врёт, если карточки нет или в ней нет имени', () => {
  assert.strictEqual(subNameOf([], '/h/.claude'), '');
  assert.strictEqual(subNameOf(null, '/h/.claude'), '');
  assert.strictEqual(subNameOf([{ home: '/h/.claude', name: '' }], '/h/.claude'), '');
  assert.strictEqual(subNameOf([{ home: '/h/.claude', name: 'х' }], ''), '', 'пустой home — молчим');
});

// --- /usage: те же числа, но как данные и как текст в чат ---------------------
// Отчёт в телегу обязан говорить то же, что полоска на вкладке: одно направление
// (израсходовано), одно округление, один отсчёт. Поэтому снимок и строка считают
// контекст ОДНОЙ функцией, и это пиняется — расхождение на 16% (буфер автосжатия)
// человек не спишет на округление, он решит, что одно из двух врёт.
test('the snapshot and the line agree on how full the context is', () => {
  const p = payload({ five_hour: { used_percentage: 37, resets_at: NOW + 8040 } });
  const snap = usageSnapshot(p, NOW);
  assert.strictEqual(snap.ctx.used, ctxUsed(p.context_window));
  assert.match(strip(renderLine(p, NOW)), new RegExp(`${snap.ctx.used}%`));
});

test('the snapshot keeps the reset as an absolute time, not a countdown', () => {
  // Снимок может быть минутной давности (простаивающая вкладка не перерисовывает
  // строку), и отсчёт, посчитанный при съёмке, к моменту ответа был бы уже неверным.
  const snap = usageSnapshot(payload({ seven_day: { used_percentage: 62, resets_at: NOW + 300_000 } }), NOW);
  assert.strictEqual(snap.seven.resetsAt, NOW + 300_000);
  assert.strictEqual(snap.seven.spent, 62);
  assert.strictEqual(snap.at, NOW);
});

test('absent limits stay absent in the snapshot — never a bare zero', () => {
  const snap = usageSnapshot(payload(null), NOW);
  assert.strictEqual(snap.five, null);
  assert.strictEqual(snap.seven, null);
  assert.strictEqual(usageSnapshot({}, NOW).ctx, null);
});

test('the report states both windows once and the context per tab', () => {
  // Окна подписки — на аккаунт, а не на вкладку: назвать их дважды значило бы
  // предложить человеку сравнивать два одинаковых числа как разные.
  const snap = (used, at) => ({
    at, session: 's', ctx: { used, total: 1_000_000 },
    five: { spent: 37, resetsAt: NOW + 8040 },
    seven: { spent: 62, resetsAt: NOW + 300_000 },
  });
  const text = usageReport([
    { name: 'api', usage: snap(62, NOW) },
    { name: 'web', usage: snap(18, NOW) },
  ], NOW);
  assert.strictEqual((text.match(/5 часов:/g) || []).length, 1, 'окно 5ч названо один раз');
  assert.match(text, /5 часов: 37% · сброс через 2ч14м/);
  assert.match(text, /7 дней: 62% · сброс через 3д11ч/);
  assert.match(text, /62% из 1M · api/);
  assert.match(text, /18% из 1M · web/);
});

test('the fullest tab comes first, and tabs with no data come last', () => {
  const snap = (used) => ({ at: NOW, session: 's', ctx: { used, total: 1_000_000 }, five: null, seven: null });
  const text = usageReport([
    { name: 'web', usage: snap(18) },
    { name: 'shell', usage: null, why: 'нет данных' },
    { name: 'api', usage: snap(81) },
  ], NOW);
  const order = text.split('\n').filter((l) => / · (api|web|shell)$/.test(l) || / · shell \(/.test(l));
  assert.deepStrictEqual(order.map((l) => l.split(' · ').pop().replace(/ \(.*/, '')), ['api', 'web', 'shell']);
});

test('a nearly spent window is marked with a glyph, not colour', () => {
  const text = usageReport([{
    name: 'api',
    usage: { at: NOW, session: 's', ctx: null, five: { spent: 94, resetsAt: NOW + 600 }, seven: { spent: 40, resetsAt: null } },
  }], NOW);
  assert.match(text, /⚠ 5 часов: 94%/);
  assert.ok(!/⚠ 7 дней/.test(text), 'спокойное окно без пометки');
});

test('a tab without a snapshot is listed with the reason, not skipped', () => {
  // Молча пропущенная вкладка читается как «расход нулевой».
  const text = usageReport([{ name: 'shell', usage: null, why: 'нет данных: это не разговор Claude Code' }], NOW);
  assert.match(text, /— · shell \(нет данных: это не разговор Claude Code\)/);
  assert.match(text, /Лимиты подписки неизвестны/);
});

test('a stale snapshot says so, while its countdown stays exact', () => {
  const text = usageReport([{
    name: 'api',
    usage: { at: NOW - 3600, session: 's', ctx: { used: 40, total: 1_000_000 }, five: { spent: 50, resetsAt: NOW + 600 }, seven: null },
  }], NOW);
  assert.match(text, /сняты 1ч назад/);
  assert.match(text, /сброс через 10м/);   // от абсолютного времени, а не от съёмки
});

test('a past reset drops the countdown instead of counting backwards', () => {
  const text = usageReport([{
    name: 'api',
    usage: { at: NOW, session: 's', ctx: null, five: { spent: 5, resetsAt: NOW - 60 }, seven: null },
  }], NOW);
  assert.match(text, /5 часов: 5%$/m);
});

test('run for real, the script leaves the snapshot beside itself', () => {
  // Ставим копию скрипта в отдельную папку — как это делает приложение
  // (provisionNodeLauncher копирует его в userData) — и запускаем как настоящий
  // статуслайн. Проверяем и то, что строка напечаталась, и то, что рядом лёг файл:
  // без файла /usage молчит, а без строки ломается полоска на вкладке.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-usage-')));
  const staged = path.join(dir, 'swarm-statusline.js');
  fs.copyFileSync(path.join(__dirname, '..', 'swarm-statusline.js'), staged);
  const data = Object.assign(payload({
    five_hour: { used_percentage: 37, resets_at: NOW + 8040 },
    seven_day: { used_percentage: 62, resets_at: NOW + 300_000 },
  }), { session_id: 'sid-42' });
  const out = execFileSync(process.execPath, [staged], { input: JSON.stringify(data), encoding: 'utf8' });
  assert.match(strip(out), /24%/, 'строка статуса печатается по-прежнему');
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'usage', 'sid-42.json'), 'utf8'));
  assert.strictEqual(snap.ctx.used, 24);
  assert.strictEqual(snap.five.spent, 37);
  assert.strictEqual(snap.seven.resetsAt, NOW + 300_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session id with a path in it writes no file at all', () => {
  // Имя файла склеивается из id, поэтому «../» в нём — это запись куда угодно.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-usage-')));
  const staged = path.join(dir, 'swarm-statusline.js');
  fs.copyFileSync(path.join(__dirname, '..', 'swarm-statusline.js'), staged);
  const data = Object.assign(payload({ five_hour: { used_percentage: 5 } }), { session_id: '../escaped' });
  execFileSync(process.execPath, [staged], { input: JSON.stringify(data), encoding: 'utf8' });
  assert.strictEqual(fs.existsSync(path.join(dir, 'usage')), false, 'папка снимков не создана');
  assert.strictEqual(fs.existsSync(path.join(path.dirname(dir), 'escaped.json')), false, 'наружу не записано');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- чужая строка статуса рядом с нашей --------------------------------------

test('наш кусок идёт первым — иначе чужой процент станет контекстом вкладки', () => {
  // Рендерер берёт полоску по ПЕРВОМУ проценту в строке, и на этом же проценте стоит
  // решение о перезапуске. Чужая строка со своим процентом не должна его перебивать.
  const line = composeLine('Opus 5 │ repo ███ 24% 1M', 'моя строка 99% диска');
  assert.match(line, /^Opus 5 │ repo ███ 24% 1M │ /);
  assert.strictEqual(line.match(/(\d+)%/)[1], '24');
});

test('своей строки нет — наша не меняется вовсе', () => {
  assert.strictEqual(composeLine('наш кусок', ''), 'наш кусок');
  assert.strictEqual(composeLine('наш кусок', '   \n  '), 'наш кусок');
  assert.strictEqual(composeLine('наш кусок', null), 'наш кусок');
});

test('чужой кусок, совпавший с нашим, не печатается дважды', () => {
  // У человека в конфиге может лежать ранняя копия этой же строки — тогда склейка напечатала
  // бы одно и то же подряд. Цвет при сравнении не в счёт: копия могла разойтись в оттенках.
  assert.strictEqual(composeLine('Opus 5 │ repo 24%', 'Opus 5 │ repo 24%'), 'Opus 5 │ repo 24%');
  assert.strictEqual(composeLine('\x1b[2mOpus 5\x1b[0m │ repo', 'Opus 5 │ \x1b[32mrepo\x1b[0m'),
    '\x1b[2mOpus 5\x1b[0m │ repo');
  // А разошедшийся хоть чем-то — печатается: судить о «почти том же» нам нечем.
  assert.strictEqual(composeLine('Opus 5 │ repo 24%', 'Opus 5 │ repo 25%'), 'Opus 5 │ repo 24% │ Opus 5 │ repo 25%');
});

test('пока нашего процента нет, чужой со своим процентом не печатаем', () => {
  // До первого ответа модели окна контекста ещё нет, и наш кусок без процента. Чужой «45%»
  // стал бы тогда первым в строке — то есть полоской контекста на карточке.
  assert.strictEqual(composeLine('Opus 5 │ repo', 'диск 45%'), 'Opus 5 │ repo');
  // Чужой без процента не мешает никому и печатается.
  assert.strictEqual(composeLine('Opus 5 │ repo', '🔧 #162'), 'Opus 5 │ repo │ 🔧 #162');
  // А с нашим процентом — печатается и чужой: первым всё равно наш.
  assert.strictEqual(composeLine('Opus 5 │ repo 24%', 'диск 45%'), 'Opus 5 │ repo 24% │ диск 45%');
});

test('от чужой строки берём только первую строку', () => {
  // Многострочный чужой вывод разъехался бы по терминалу поверх диалога Клода.
  assert.strictEqual(composeLine('наш', 'первая\nвторая\nтретья'), 'наш │ первая');
});

test('слои чужих настроек — как у Клода: локальные, проектные, пользовательские', () => {
  const data = { workspace: { project_dir: '/proj', current_dir: '/proj/sub' } };
  assert.deepStrictEqual(settingsLayers(data, { CLAUDE_CONFIG_DIR: '/cfg' }), [
    path.join('/proj', '.claude', 'settings.local.json'),
    path.join('/proj', '.claude', 'settings.json'),
    path.join('/cfg', 'settings.json'),
  ]);
});

test('корень конфига: сначала окружение, потом адрес стенограммы', () => {
  // Алиас `claude-my` уводит в другой конфиг целиком — там своя строка статуса, и взять
  // её из рабочего конфига значит показать человеку чужую.
  assert.strictEqual(configRoot({}, { CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg');
  const t = '/Users/me/.claude-my/projects/-Users-me-repo/abc.jsonl';
  assert.strictEqual(configRoot({ transcript_path: t }, {}), '/Users/me/.claude-my');
  assert.strictEqual(configRoot({}, {}), path.join(os.homedir(), '.claude'));
});

test('верхний слой выигрывает, чужие формы кроме команды пропускаем', () => {
  const cmd = { type: 'command', command: 'my-line' };
  assert.strictEqual(foreignCommandFrom([{ statusLine: cmd }, { statusLine: { type: 'command', command: 'lower' } }]), 'my-line');
  assert.strictEqual(foreignCommandFrom([null, { statusLine: { type: 'static', text: 'hi' } }, { statusLine: cmd }]), 'my-line');
  assert.strictEqual(foreignCommandFrom([{}, null]), '');
  assert.strictEqual(foreignCommandFrom([]), '');
});

test('нашу же команду не зовём — иначе строка зовёт строку без конца', () => {
  assert.strictEqual(isOwnCommand('sh "/x/swarm-statusline.sh"'), true);
  assert.strictEqual(isOwnCommand('node /x/statusline.js'), false);
  const own = { type: 'command', command: 'sh "/x/swarm-statusline.sh"' };
  assert.strictEqual(foreignCommandFrom([{ statusLine: own }]), '');
});

test('чужая команда получает тот же вход и не может подвесить строку', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-foreign-')));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  // Чужой скрипт печатает модель из ВХОДА — значит вход до него доехал целиком.
  const script = path.join(dir, 'mine.sh');
  fs.writeFileSync(script, '#!/bin/sh\ncat | sed -n \'s/.*"display_name":"\\([^"]*\\)".*/чужая: \\1/p\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: `sh ${script}` } }));
  const data = { workspace: { project_dir: proj, current_dir: proj } };
  const input = JSON.stringify({ model: { display_name: 'Opus 5' } });
  assert.strictEqual(readForeign(data, input).trim(), 'чужая: Opus 5');

  // Задумавшаяся команда обязана оборваться по таймауту, а не держать перерисовку.
  fs.writeFileSync(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  assert.strictEqual(readForeign(data, input).trim(), '');
  assert.ok(Date.now() - t0 < 5000, 'ждали не дольше таймаута');
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' statusline tests passed');
