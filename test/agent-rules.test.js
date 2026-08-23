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

test('метка и теги в правиле — ровно те, что понимает сопоставитель', () => {
  // Раньше эти константы стояли в agent-rules.js копией (модуль подключался в рендерере
  // простым <script>, без require), и тест был единственной защитой от расхождения. Теперь
  // они требуются из ask-phrases.js, так что тест сторожит уже не копию, а сам импорт:
  // учить не тому тегу, который ищут, стало нельзя, и вот это «нельзя» и проверяется.
  assert.strictEqual(AR.DEFAULT_MARKER, AP.DEFAULT_ASK_PHRASES[0]);
  assert.strictEqual(AR.TAG_NS, AP.TAG_NS);
  assert.strictEqual(AR.ASK_TAG, AP.ASK_TAG);
  assert.strictEqual(AR.WAIT_TAG, AP.WAIT_TAG);
});

// Правило называет МЕСТО тега, и назвать его неверно — та же молчащая вкладка, что и неверный
// тег: агент послушается, а сопоставитель не найдёт. Проверяем не текст, а поведение: то, чему
// правило учит буквально, должно считаться зовом.
test('правило учит месту, с которого тег и правда считается', () => {
  const m = AP.buildAskMatcher([]);
  const rule = AR.systemPromptRule();
  assert.ok(/начни сообщение/.test(rule), 'правило называет начало сообщения: ' + rule.slice(0, 80));
  assert.ok(/с начала строки/.test(rule), 'и предупреждает, что внутри фразы тег не считается');
  // Буквально по правилу: тег отдельной строкой в начале сообщения.
  assert.ok(AP.asksWith(m, `${AR.ASK_TAG}\n\nЧто ставим?`));
  // И то, от чего правило предостерегает, зовом действительно не считается.
  assert.ok(!AP.asksWith(m, `Пишу про тег ${AR.ASK_TAG} внутри фразы.`));
});

test('правило учит метке, которую сопоставитель считает зовом', () => {
  // Список фраз на это влиять не должен: тег — протокол, он в правиле всегда один и
  // работает при любом списке. Списком приложение больше не крутит (настройка снята,
  // main всегда отдаёт зашитую фразу), но матчер список принимает — и независимость тега
  // от него проверяется здесь, чтобы её не потеряли, если список снова начнёт меняться.
  for (const phrases of [[], ['Твой ход'], ['  Нужен ответ  ', 'Твой ход']]) {
    const m = AP.buildAskMatcher(phrases);
    const sample = `${AR.ASK_TAG}\n\nСделал то и это.\n\nЧто ставим — заливку или точку?`;
    assert.ok(AP.asksWith(m, sample), 'зовёт при ' + JSON.stringify(phrases));
    const rule = AR.systemPromptRule();
    assert.ok(rule.includes(AR.ASK_TAG), 'правило называет тег зова');
    assert.ok(/AskUserQuestion/.test(rule), 'rule asks for the tool too');
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
    const sample = `${AR.WAIT_TAG}\n\nЗапустил замер стенда.`;
    assert.ok(AP.waitsWith(m, sample), 'фон с ' + JSON.stringify(phrases));
    assert.ok(!AP.asksWith(m, sample), 'и это не зов: ' + JSON.stringify(phrases));
    assert.ok(AR.systemPromptRule().includes(AR.WAIT_TAG), 'правило называет тег фона');
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

test('правило не принимает пользовательский текст даже подсунутым', () => {
  // Раньше в правило подставлялась первая фраза из настроек, и её приходилось чистить от
  // кавычек и `$`: правило попадает прямо в командную строку. Теперь это константа, и
  // аргумент игнорируется — проверяем, что подстановки не вернулись.
  assert.strictEqual(AR.systemPromptRule(), AR.systemPromptRule(['ой "кавычки" и $HOME']));
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' agent-rules tests passed');
