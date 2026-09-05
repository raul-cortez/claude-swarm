// Plain-node tests for the dead-agent logic (no framework: `node test/deadtab.test.js`).
// deadtab.js is dual-mode (browser global + CommonJS), so it requires straight into Node.
const assert = require('assert');
const D = require('../deadtab');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Живая строка из падения 4 сентября: Claude Code упал внутренней ловушкой, оболочка осталась.
const REAL = 'zsh: killed     CLAUDE_CONFIG_DIR=~/.claude-my command claude --settings "$SWARM_SETTINGS"';

test('shellDeathWord: настоящая строка zsh про убитого агента', () => {
  assert.strictEqual(D.shellDeathWord([REAL]), 'killed');
});

test('shellDeathWord: прочие сигналы, которыми умирает агент', () => {
  assert.strictEqual(D.shellDeathWord(['zsh: terminated  claude']), 'terminated');
  assert.strictEqual(D.shellDeathWord(['zsh: segmentation fault  claude']), 'segmentation fault');
  assert.strictEqual(D.shellDeathWord(['zsh: abort      claude']), 'abort');
});

test('shellDeathWord: bash пишет иначе, но это та же смерть', () => {
  assert.strictEqual(D.shellDeathWord(['run.sh: line 12: 4242 Killed: 9   claude --settings x']), 'killed');
});

test('shellDeathWord: обычная жалоба оболочки — не смерть агента', () => {
  assert.strictEqual(D.shellDeathWord(['zsh: command not found: clade']), '');
  assert.strictEqual(D.shellDeathWord(['zsh: no matches found: *.ts']), '');
  assert.strictEqual(D.shellDeathWord(['zsh: permission denied: ./x.sh']), '');
});

test('shellDeathWord: слово из ПЕРЕПИСКИ выше по экрану не считается', () => {
  // Агент обсуждал этот самый баг и процитировал строку — но она ушла вверх, а внизу
  // спокойное приглашение. Считать это новой смертью значило бы поднимать тревогу на разговоре.
  const rows = [REAL, 'а вот что было дальше', '', '', '', '', '', 'evgeniy@mac fastio %'];
  assert.strictEqual(D.shellDeathWord(rows), '');
});

test('shellDeathWord: снимок экрана приходит ОДНОЙ строкой с переносами', () => {
  // Именно так его отдаёт main.js: screen.snapshotRows склеивает ряды через \n. Массив здесь
  // никогда не приходит — если разбор умеет только массив, функция молчит на всём живом.
  const snap = ['последний ответ агента', '', REAL, '', 'evgeniy@mac fastio %'].join('\n');
  assert.strictEqual(D.shellDeathWord(snap), 'killed');
});

test('shellDeathWord: мусор и пустота не роняют разбор', () => {
  assert.strictEqual(D.shellDeathWord([]), '');
  assert.strictEqual(D.shellDeathWord(null), '');
  assert.strictEqual(D.shellDeathWord(undefined), '');
  assert.strictEqual(D.shellDeathWord('одной строкой без массива'), '');
});

test('leftShell: переход «занято → пусто», и только он', () => {
  assert.strictEqual(D.leftShell(true, false), true);
  assert.strictEqual(D.leftShell(true, true), false);
  assert.strictEqual(D.leftShell(false, false), false);
  // Первый такт после запуска: прошлого значения нет. Пустая оболочка тут — старт, не уход.
  assert.strictEqual(D.leftShell(undefined, false), false);
  // Windows: `ps` недоступен, занятость неизвестна ВСЕГДА — молчим, а не выдумываем падения.
  assert.strictEqual(D.leftShell(undefined, undefined), false);
  assert.strictEqual(D.leftShell(true, undefined), false);
});

test('verdict: без перехода «занято → пусто» ничего не случилось', () => {
  assert.deepStrictEqual(D.verdict({ wasBusy: true, busy: true }), { gone: false, how: null, why: null });
  assert.deepStrictEqual(D.verdict({ wasBusy: false, busy: false }), { gone: false, how: null, why: null });
  // Первый такт после запуска: прошлого значения ещё нет — пустая оболочка это не уход, а старт.
  assert.deepStrictEqual(D.verdict({ wasBusy: undefined, busy: false }), { gone: false, how: null, why: null });
  assert.deepStrictEqual(D.verdict({}), { gone: false, how: null, why: null });
});

test('verdict: слово оболочки — падение, и это твёрдо', () => {
  const v = D.verdict({ wasBusy: true, busy: false, word: 'killed' });
  assert.deepStrictEqual(v, { gone: true, how: 'crash', why: 'signal' });
});

test('verdict: оборванный ход — падение по косвенному признаку', () => {
  const v = D.verdict({ wasBusy: true, busy: false, turnActive: true });
  assert.deepStrictEqual(v, { gone: true, how: 'crash', why: 'midturn' });
});

test('verdict: тихий уход на холостой вкладке — обычный /exit', () => {
  const v = D.verdict({ wasBusy: true, busy: false });
  assert.deepStrictEqual(v, { gone: true, how: 'quit', why: null });
});

test('verdict: ухода ЖДАЛИ мы сами — тревоги нет даже при слове и обрыве', () => {
  // Самоперезапуск сам печатает `/exit` и сам гасит агента. Назвать это падением значит
  // показывать «агент упал» на каждом ночном перезапуске — то есть обесценить сообщение.
  const v = D.verdict({ wasBusy: true, busy: false, word: 'killed', turnActive: true, expected: true });
  assert.deepStrictEqual(v, { gone: true, how: 'quit', why: null });
});

test('goneLabel: человеку на карточку, и только про падение', () => {
  assert.strictEqual(D.goneLabel('crash', 'signal', 'killed'), 'агент убит: killed');
  assert.strictEqual(D.goneLabel('crash', 'midturn', ''), 'агент исчез на ходу');
  assert.strictEqual(D.goneLabel('quit', null, ''), '');
  assert.strictEqual(D.goneLabel(null, null, ''), '');
});

test('RESET_SEQ гасит именно то, чем агент пачкает терминал', () => {
  // Мышиные режимы — то, ради чего всё затевалось: без них каждое движение мыши сыпало
  // `35;57;4M` в приглашение выжившей оболочки.
  for (const mode of ['1000', '1002', '1003', '1005', '1006', '1015']) {
    assert.ok(D.RESET_SEQ.includes('[?' + mode + 'l'), 'нет гашения мыши ' + mode);
  }
  assert.ok(D.RESET_SEQ.includes('[?2004l'), 'нет гашения скобочной вставки');
  assert.ok(D.RESET_SEQ.includes('[?1049l'), 'нет возврата с запасного экрана');
  assert.ok(D.RESET_SEQ.includes('[?25h'), 'курсор остался спрятанным');
  // ⛔ И ни одного ВКЛЮЧЕНИЯ: строка уходит в живой эмулятор, и лишняя `h` тут включила бы
  // ровно то, что мы пришли выключить.
  assert.strictEqual(/\[\?\d+h/.test(D.RESET_SEQ.replace('[?25h', '')), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('FAIL  ' + name + '\n      ' + (e.message || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
})();
