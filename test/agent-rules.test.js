// Pins the rule we teach the agent (agent-rules.js). Two classes of bug here, both
// invisible at runtime: a rule that names a MARKER the matcher doesn't look for (the
// status silently never flips to «ждёт ответа»), and a rule that breaks the launch
// command line it's embedded into (the tab dies before claude starts).
// Run: node test/agent-rules.test.js
const assert = require('assert');
const AR = require('../agent-rules');
const AP = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('the default marker is the phrase the matcher ships with', () => {
  // Duplicated constant (agent-rules is also loaded as a plain script, no require),
  // so it has to be pinned: teaching a phrase nobody matches breaks the status.
  assert.strictEqual(AR.DEFAULT_MARKER, AP.DEFAULT_ASK_PHRASES[0]);
});

test('теги в правиле — те же, что понимает сопоставитель', () => {
  // Дублированные константы (agent-rules подключается и простым <script>, там нет
  // require), поэтому прибиты: учить тегу, которого никто не ищет, — молчащая вкладка.
  assert.strictEqual(AR.ASK_TAG, AP.ASK_TAG);
  assert.strictEqual(AR.WAIT_TAG, AP.WAIT_TAG);
});

test('оба правила учат метке, которую сопоставитель считает зовом', () => {
  // Чужие фразы в настройках на это влиять не должны: тег — протокол, он в правиле всегда
  // один и работает при любом списке фраз.
  for (const phrases of [[], ['Твой ход'], ['  Нужен ответ  ', 'Твой ход']]) {
    const m = AP.buildAskMatcher(phrases);
    const sample = `Сделал то и это.\n\nЧто ставим — заливку или точку? ${AR.ASK_TAG}`;
    assert.ok(AP.asksWith(m, sample), 'зовёт при ' + JSON.stringify(phrases));
    for (const rule of [AR.systemPromptRule(), AR.claudeMdRule()]) {
      assert.ok(rule.includes(AR.ASK_TAG), 'правило называет тег зова');
      assert.ok(/AskUserQuestion/.test(rule), 'rule asks for the tool too');
    }
  }
});

test('старая подпись всё ещё зов: сломать её переходом на теги нельзя', () => {
  const m = AP.buildAskMatcher([]);
  assert.ok(AP.asksWith(m, `Готово.\n\n${AR.DEFAULT_MARKER}: путь к схеме`));
});

test('the «ничего, жди» escape hatch we document is really not a call', () => {
  const m = AP.buildAskMatcher([]);
  assert.ok(!AP.asksWith(m, `${AR.DEFAULT_MARKER}: ничего, жди результата`));
});

test('тег фона даёт ровно «работает в фоне», а не зов', () => {
  // Третье состояние: от человека ничего, но работа не кончилась. Если тег разъедется с
  // сопоставителем, вкладка с живой фоновой задачей станет зелёной — то есть «дай задачу», —
  // и увидеть это можно будет только вживую: тесты по обе стороны останутся зелёными.
  for (const phrases of [[], ['Твой ход'], ['Нужен ответ', 'Твой ход']]) {
    const m = AP.buildAskMatcher(phrases);
    const sample = `Запустил замер стенда. ${AR.WAIT_TAG}`;
    assert.ok(AP.waitsWith(m, sample), 'фон с ' + JSON.stringify(phrases));
    assert.ok(!AP.asksWith(m, sample), 'и это не зов: ' + JSON.stringify(phrases));
    for (const rule of [AR.systemPromptRule(), AR.claudeMdRule()]) {
      assert.ok(rule.includes(AR.WAIT_TAG), 'правило называет тег фона');
    }
  }
});

test('старая подпись про фон тоже ещё понимается', () => {
  const m = AP.buildAskMatcher([]);
  const sample = `Запустил замер.\n\n${AR.DEFAULT_MARKER}: ничего, жду замер стенда`;
  assert.ok(AP.waitsWith(m, sample));
  assert.ok(!AP.asksWith(m, sample));
});

test('the system-prompt rule is one line and safe inside a shell "…"', () => {
  // Main normally passes it through the environment, but for a shell whose syntax it
  // doesn't know it spells the value inline on a command line it WRITES INTO AN
  // INTERACTIVE SHELL — there a newline would end the command and a quote/$/`/! would
  // swallow the rest of it. Теперь в правиле нет пользовательского текста вообще, так что
  // проверять нечего, кроме самого правила — и это ровно то, чего мы добивались.
  const rule = AR.systemPromptRule();
  assert.ok(!/\n/.test(rule), 'single line');
  assert.ok(!/["'`$\\!]/.test(rule), 'no shell metacharacters');
});

test('правило не зависит от того, что человек написал в настройках', () => {
  // Раньше в правило подставлялась первая фраза из настроек, и её приходилось чистить от
  // кавычек и `$`. Теперь это константа: пользовательский текст на командную строку не
  // попадает вообще — проверяем, что подстановки не вернулись.
  assert.strictEqual(AR.systemPromptRule(), AR.systemPromptRule(['ой "кавычки" и $HOME']));
  assert.strictEqual(AR.claudeMdRule(), AR.claudeMdRule(["it's `date`"]));
});

test('the CLAUDE.md block is fenced so it can be replaced whole', () => {
  const md = AR.claudeMdRule();
  assert.ok(md.startsWith(AR.MD_BEGIN), 'starts with the begin marker');
  assert.ok(md.trimEnd().endsWith(AR.MD_END), 'ends with the end marker');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' agent-rules tests passed');
