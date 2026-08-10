// Plain-node tests for the self-restart helpers (restart.js).
// Цена ошибки здесь выше обычной: неверное «пора» перезапускает вкладку на середине работы,
// а неверный разбор ответа — стартует свежую сессию без задачи. Поэтому проверяем не только
// счастливый путь, но каждую причину НЕ перезапускать.
const assert = require('assert');
const R = require('../restart.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const HOUR = 3600 * 1000;
// Вкладка, которую спрашивать МОЖНО: работает давно, контекст за порогом.
function ready(over) {
  return { pct: 40, status: 'ready', startedAt: 1000, ...over };
}
const OPTS = { enabled: true, threshold: 30, now: 1000 + HOUR };

test('порог зажат диапазоном 15–75', () => {
  assert.strictEqual(R.clampPct(0), 15);
  assert.strictEqual(R.clampPct(14), 15);
  assert.strictEqual(R.clampPct(30), 30);
  assert.strictEqual(R.clampPct(76), 75);
  assert.strictEqual(R.clampPct(1000), 75);
  assert.strictEqual(R.clampPct('нет'), R.DEFAULT_PCT);
  assert.strictEqual(R.clampPct(undefined), R.DEFAULT_PCT);
});

test('спрашиваем, когда контекст за порогом', () => {
  assert.strictEqual(R.shouldAsk(ready(), OPTS), true);
  assert.strictEqual(R.shouldAsk(ready({ pct: 30 }), OPTS), true);
});

test('не спрашиваем, пока функция выключена', () => {
  assert.strictEqual(R.shouldAsk(ready(), { ...OPTS, enabled: false }), false);
});

test('не спрашиваем ниже порога', () => {
  assert.strictEqual(R.shouldAsk(ready({ pct: 29 }), OPTS), false);
  assert.strictEqual(R.shouldAsk(ready({ pct: 40 }), { ...OPTS, threshold: 75 }), false);
});

test('нет расхода — нет вопроса: статуслайн выключен или вкладка не отрисовалась', () => {
  assert.strictEqual(R.shouldAsk(ready({ pct: 0 }), OPTS), false);
  assert.strictEqual(R.shouldAsk(ready({ pct: null }), OPTS), false);
  assert.strictEqual(R.shouldAsk(ready({ pct: NaN }), OPTS), false);
});

test('вкладка ждёт человека — не время просить об эстафете', () => {
  assert.strictEqual(R.shouldAsk(ready({ status: 'waiting' }), OPTS), false);
});

// Защёлка снизу. Свежая сессия читает таск, спеку и пару файлов и на миллионном окне
// оказывается у порога, ничего не сделав: без этой проверки вкладка крутится в перезапусках.
test('свежая сессия не перезапускается сразу', () => {
  const justStarted = { pct: 40, status: 'ready', startedAt: OPTS.now - 60_000 };
  assert.strictEqual(R.shouldAsk(justStarted, OPTS), false);
  const worked = { pct: 40, status: 'ready', startedAt: OPTS.now - R.MIN_UPTIME_MS - 1 };
  assert.strictEqual(R.shouldAsk(worked, OPTS), true);
});

test('спросили и ждём ответа — второй раз не спрашиваем', () => {
  const asked = ready({ askedAt: OPTS.now - 60_000 });
  assert.strictEqual(R.shouldAsk(asked, OPTS), false);
  // Ответа так и нет: молча гасить нельзя, но спросить заново — можно.
  const stale = ready({ askedAt: OPTS.now - R.ANSWER_WAIT_MS - 1 });
  assert.strictEqual(R.shouldAsk(stale, OPTS), true);
});

test('срок «спроси через двадцать минут» уважается', () => {
  assert.strictEqual(R.shouldAsk(ready({ retryAt: OPTS.now + 60_000 }), OPTS), false);
  assert.strictEqual(R.shouldAsk(ready({ retryAt: OPTS.now - 1 }), OPTS), true);
});

test('разбираем ответ в заборчике и с текстом вокруг', () => {
  const raw = 'Хорошо, вот:\n```json\n{"restart": true, "prompt": "продолжи таск 215",'
    + ' "handoff": "#215"}\n```\nготово';
  const a = R.parseAnswer(raw);
  assert.strictEqual(a.restart, true);
  assert.strictEqual(a.prompt, 'продолжи таск 215');
  assert.strictEqual(a.handoff, '#215');
});

test('эстафета текстом — тоже разрешение', () => {
  const a = R.parseAnswer('{"restart":true,"prompt":"читай эстафету","text":"сделано A, дальше B"}');
  assert.strictEqual(a.restart, true);
  assert.strictEqual(a.text, 'сделано A, дальше B');
});

// «Можно» без промпта или без эстафеты — полразрешения. Перезапустить и не сказать свежей
// сессии, что делать, хуже, чем не перезапускать вовсе.
test('«можно» без промпта не перезапускает', () => {
  const a = R.parseAnswer('{"restart":true,"handoff":"#215"}');
  assert.strictEqual(a.restart, false);
  assert.strictEqual(a.reason, 'no-prompt');
  assert.ok(a.retryMs > 0);
});

test('«можно» без эстафеты не перезапускает', () => {
  const a = R.parseAnswer('{"restart":true,"prompt":"продолжай"}');
  assert.strictEqual(a.restart, false);
  assert.strictEqual(a.reason, 'no-handoff');
});

test('«не сейчас» несёт срок переспроса', () => {
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":25}').retryMs, 25 * 60 * 1000);
  // Без срока — умолчание, а не «никогда».
  assert.strictEqual(R.parseAnswer('{"restart":false}').retryMs, R.RETRY_MS);
  // «Через сутки» — это отказ, а не отсрочка: потолок три часа.
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":1440}').retryMs, 3 * HOUR);
  assert.strictEqual(R.parseAnswer('{"restart":false,"retry":-5}').retryMs, R.RETRY_MS);
});

test('мусор вместо ответа — null, а не догадка', () => {
  assert.strictEqual(R.parseAnswer(''), null);
  assert.strictEqual(R.parseAnswer('можно, перезапускай'), null);
  assert.strictEqual(R.parseAnswer('{сломанный json'), null);
  assert.strictEqual(R.parseAnswer(null), null);
});

// Эстафета приходит оттуда, куда пишет не только наш агент (комментарий в чужом таске).
// Поэтому текст от агента становится ОДНИМ аргументом, а не строкой для шелла.
test('промпт уезжает одним аргументом, шелл в него не влезает', () => {
  const line = R.launchLine('claude -n swarm-ab12', 'продолжи; rm -rf ~ && echo `whoami`');
  assert.strictEqual(line, "claude -n swarm-ab12 'продолжи; rm -rf ~ && echo `whoami`'");
  assert.ok(!/^[^']*&&/.test(line), 'команда не должна распадаться на две');
});

test('кавычка в промпте не разрывает аргумент', () => {
  assert.strictEqual(R.launchLine('claude', "файл 'a.js'"), "claude 'файл '\\''a.js'\\'''");
});

test('перевод строки в промпте не превращается в Enter', () => {
  const line = R.launchLine('claude', 'первая строка\nвторая строка');
  assert.ok(!line.includes('\n'), 'иначе половина промпта уедет в шелл отдельной командой');
  assert.strictEqual(line, "claude 'первая строка вторая строка'");
});

test('пустой промпт — просто команда, без пустых кавычек', () => {
  assert.strictEqual(R.launchLine('claude -n swarm-1', ''), 'claude -n swarm-1');
  assert.strictEqual(R.launchLine('', 'что-то'), '');
});

test('в просьбе есть и путь ответа, и процент, и все поля', () => {
  const t = R.askText({ pct: 31, answerFile: '/tmp/swarm/answer.json' });
  assert.ok(t.includes('/tmp/swarm/answer.json'));
  assert.ok(t.includes('31%'));
  for (const key of ['restart', 'retry', 'handoff', 'text', 'prompt']) {
    assert.ok(t.includes(key), `в просьбе не описано поле ${key}`);
  }
});

for (const [name, fn] of tests) {
  try { fn(); passed++; } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exit(1);
  }
}
console.log(`restart: ${passed}/${tests.length} ok`);
