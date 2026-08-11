// End-to-end test of the shipped Claude hook: feed it an event JSON on stdin, then
// round-trip its terminalSequence through the app's own parser (osc.js) — exactly
// what happens at runtime. Runs the real script so the wiring is what ships.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { extractHookSignals } = require('../osc');
const { DEFAULT_SOURCES, DEFAULT_ASK_PHRASES, phraseSources } = require('../ask-phrases');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const SCRIPT = path.join(__dirname, '..', 'hooks', 'swarm-signal.mjs');

// The hook is ESM; its pure helpers are imported once below and used as H.*. Importing it
// does NOT run it — main() is gated on being invoked directly.
let H = null;

// Run the hook with `payload` on stdin; return the parsed signal (or null if the
// hook emitted nothing), by feeding its terminalSequence back through osc.js.
function runHook(payload) {
  const out = execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (!out.trim()) return null;
  const seq = JSON.parse(out).terminalSequence;
  const { signals } = extractHookSignals(seq);
  return signals[0] || null;
}

test('UserPromptSubmit → busy', () => {
  assert.deepStrictEqual(runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'abc' }),
    { token: 'busy', sessionId: 'abc', transcript: null });
});

test('Stop with nothing to say → idle', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Stop', session_id: 's1' }).token, 'idle');
});

// Адрес разговора приложение обязано УЗНАВАТЬ, а не складывать. Складывало оно его из
// ~/.claude/projects, и у вкладки, запущенной с другим CLAUDE_CONFIG_DIR (алиас `claude-my`),
// файл не находился никогда: статус держался на экране, а в телегу вместо ответа агента
// уезжали статуслайн, имя ветки и обрывок команды. Клод сообщает путь в каждом событии —
// хук обязан его передавать, каким бы конфигом вкладка ни пользовалась.
test('хук передаёт адрес стенограммы из события', () => {
  const file = '/Users/x/.claude-my/projects/-Users-x-proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl';
  const sig = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'abc', transcript_path: file });
  assert.strictEqual(sig.transcript, file);
});

// The whole point of reading last_assistant_message: a turn that ENDED and a turn
// that ended WITH A QUESTION are the same event, so the closing text decides.
test('Stop whose last message calls the user → ask', () => {
  const p = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Готово.\n\nСейчас от тебя: путь к схеме' };
  assert.strictEqual(runHook(p).token, 'ask');
});

test('Stop with «Сейчас от тебя: ничего, жди …» → idle (not a question)', () => {
  const p = { hook_event_name: 'Stop', last_assistant_message: 'Сейчас от тебя: ничего, жди результата' };
  assert.strictEqual(runHook(p).token, 'idle');
});

test('PostToolUse → busy (the approved tool finished, work resumed)', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }).token, 'busy');
});

test('Notification agent_needs_input → ask', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }).token, 'ask');
});

test('PermissionRequest → perm', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's1' }).token, 'perm');
});

test('Notification permission_prompt → perm', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).token, 'perm');
});

test('Notification idle_prompt → idle', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).token, 'idle');
});

// Коробка с вариантами — не то же самое, что зов прозой, хотя вкладка в обоих случаях ждёт
// человека. Разница видна только здесь: дальше у них один статус и один kind. А цена её —
// перезапуск, который печатает в живую вкладку: в строку ввода можно, в открытую коробку Enter
// уходит выбором варианта, то есть ответом за человека.
test('PreToolUse AskUserQuestion → box (рамка, а не просто ожидание)', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'q' }).token, 'box');
});

// А это — обычное прощание вкладки сворма, и рамки за ним нет никакой. Токен тот же «ждёт», но
// печатать в такую вкладку можно, иначе перезапуск не сработал бы у неё ни разу.
test('Stop с зовом и Notification agent_needs_input — ожидание без рамки', () => {
  const p = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Сейчас от тебя: путь к схеме' };
  assert.strictEqual(runHook(p).token, 'ask');
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }).token, 'ask');
});

test('PreToolUse for a normal tool → busy', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).token, 'busy');
});

test('an event we do not care about emits nothing', () => {
  assert.strictEqual(runHook({ hook_event_name: 'SessionStart' }), null);
});

test('a generic Notification (no type) emits nothing', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification' }), null);
});

// --- the user's own call phrases ---------------------------------------------
// The app compiles them (ask-phrases.js) into swarm-phrases.json next to the script.
// Here we stage a copy of the hook with such a file and check it picks it up.

test('the hook fallback phrases are exactly ask-phrases.js defaults', () => {
  const code = `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => console.log(JSON.stringify(m.FALLBACK)))`;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  const fb = JSON.parse(out);
  assert.deepStrictEqual({ mark: fb.mark, none: fb.none, wait: fb.wait }, DEFAULT_SOURCES);
  // The plain marker is a THIRD copy of the default phrase (app, hook regexes, hook
  // text) — it's the one the deny reason names back to the agent, so pin it too.
  assert.strictEqual(fb.marker, DEFAULT_ASK_PHRASES[0]);
});

test('a custom phrase file replaces the default marker', () => {
  // Никакого realpath: на маке os.tmpdir() — это симлинк /var → /private/var, и скрипт
  // обязан узнавать себя ЧЕРЕЗ него сам (см. isDirectRun). Разрешать путь за него здесь
  // значило бы прятать от теста ровно ту проверку, которая однажды всё и выключила.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-'));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  const phrases = ['Твой ход (важно)'];
  fs.writeFileSync(path.join(dir, 'swarm-phrases.json'),
    JSON.stringify(Object.assign({ phrases }, phraseSources(phrases))));
  const run = (msg) => {
    const out = execFileSync(process.execPath, [staged], {
      input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: msg }),
      encoding: 'utf8',
    });
    return extractHookSignals(JSON.parse(out).terminalSequence).signals[0].token;
  };
  assert.strictEqual(run('Всё готово. Твой ход (важно)'), 'ask', 'the user phrase must call');
  assert.strictEqual(run('Готово. Сейчас от тебя: путь'), 'idle', 'the default no longer applies');
  assert.strictEqual(run('Твой ход (важно): ничего, жди'), 'idle', 'the «ничего/жди» rule still holds');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- хук должен запускаться ОТТУДА, КУДА ЕГО КЛАДЁТ ПРИЛОЖЕНИЕ -----------------
// А кладёт оно его в userData, то есть на маке — в «~/Library/Application Support/…».
// Пробел в пути ломал проверку «меня запустили напрямую» (склейка `file://` + путь против
// import.meta.url, где пробел записан как %20): main() не вызывался, хук печатал пустоту,
// приложение не получало ни одного маркера — и весь «точный статус через хуки» был
// выключен у КАЖДОЙ установленной копии, оставаясь исправным в разработке, где путь
// репозитория без пробелов. Поэтому тест ставит скрипт именно в такую папку.

test('запуск из папки с пробелом в имени всё равно даёт маркер', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-'));
  const dir = path.join(base, 'Application Support');
  fs.mkdirSync(dir);
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  const out = execFileSync(process.execPath, [staged], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'abc' }),
    encoding: 'utf8',
  });
  assert.ok(out.trim(), 'хук из пути с пробелом обязан что-то напечатать');
  const { signals } = extractHookSignals(JSON.parse(out).terminalSequence);
  assert.deepStrictEqual(signals[0], { token: 'busy', sessionId: 'abc', transcript: null });
  fs.rmSync(base, { recursive: true, force: true });
});

test('isDirectRun сравнивает адреса, а не строки', () => {
  const spaced = path.join(os.tmpdir(), 'Application Support', 'swarm-signal.mjs');
  assert.strictEqual(H.isDirectRun(pathToFileURL(spaced).href, spaced), true,
    'пробел в пути — это %20 в адресе, и это ОДИН и тот же файл');
  assert.strictEqual(H.isDirectRun(`file://${spaced}`, spaced), false,
    'старая склейка адресом не является — так проверка и не срабатывала');
  assert.strictEqual(H.isDirectRun(pathToFileURL(spaced).href, ''), false, 'запуска нет — argv пуст');
  assert.strictEqual(H.isDirectRun(pathToFileURL(spaced).href,
    path.join(os.tmpdir(), 'other.mjs')), false, 'другой файл — не мы');
});

// --- last_assistant_message comes in more than one shape ----------------------

test('messageText unwraps a string, an object and content blocks alike', () => {
  assert.strictEqual(H.messageText('готово'), 'готово');
  assert.strictEqual(H.messageText({ type: 'text', text: 'готово' }), 'готово');
  assert.strictEqual(H.messageText({ content: [{ type: 'text', text: 'готово' }] }), 'готово');
  assert.strictEqual(H.messageText([{ type: 'text', text: 'а' }, { type: 'text', text: 'б' }]), 'а\nб');
  assert.strictEqual(H.messageText(null), '');
  assert.strictEqual(H.messageText({ nope: 1 }), '', 'no text anywhere → empty, never "[object Object]"');
});

test('the call phrase is found in an OBJECT last_assistant_message', () => {
  const m = H.loadMatcher(() => null);   // shipped default
  assert.strictEqual(H.callsUser(m, { type: 'text', text: 'Сейчас от тебя: путь' }), true);
  assert.strictEqual(H.tokenFor({ hook_event_name: 'Stop', last_assistant_message: { type: 'text', text: 'Сейчас от тебя: путь' } }, m), 'ask');
});

// --- Stop бывает трёх видов, а не двух ----------------------------------------
// «Всё сделал», «спросил и остановился» и «запустил фон и жду его» — одно и то же
// событие. Различает их только текст, которым агент закрыл ход.

test('Stop с «ничего, жду …» — это bgw: работает, но человека не зовёт', () => {
  const m = H.loadMatcher(() => null);   // shipped default
  const stop = (text) => H.tokenFor({ hook_event_name: 'Stop', last_assistant_message: text }, m);
  assert.strictEqual(stop('Сейчас от тебя: ничего, жду замер стенда'), 'bgw');
  assert.strictEqual(stop('Сейчас от тебя: ничего, ждём сборку'), 'bgw');
  assert.strictEqual(stop('Сейчас от тебя: ничего, жди результата'), 'idle', 'жди — это «я закончил»');
  assert.strictEqual(stop('Сейчас от тебя: путь к схеме'), 'ask');
  assert.strictEqual(stop('Готово.'), 'idle');
});

test('closingKind судит по ПОСЛЕДНЕЙ фразе сообщения', () => {
  const m = H.loadMatcher(() => null);
  // Длинный отчёт со своим «ничего» в середине не должен отменять зов в конце.
  assert.strictEqual(H.closingKind(m, 'Сейчас от тебя: ничего\n\nСейчас от тебя: путь'), 'ask');
  assert.strictEqual(H.closingKind(m, 'Сейчас от тебя: ничего, жду фон\n\nСейчас от тебя: ничего'), null);
});

// --- refusing the interactive picker while driven from Telegram ----------------

test('deniesPicker only fires for AskUserQuestion in a listed session', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' };
  assert.strictEqual(H.deniesPicker(ask, ['s1']), true);
  assert.strictEqual(H.deniesPicker(ask, ['other']), false, 'another tab is not affected');
  assert.strictEqual(H.deniesPicker(ask, []), false);
  assert.strictEqual(H.deniesPicker({ ...ask, tool_name: 'Bash' }, ['s1']), false, 'only the picker');
  assert.strictEqual(H.deniesPicker({ ...ask, session_id: '' }, ['']), false, 'no session id, no deny');
});

// «Где я» — второй, более широкий признак. Список сессий узок: вкладка попадает в него,
// только когда человек УЖЕ ответил в неё с телефона. Живой тупик был ровно в зазоре: человек
// спросил агента за компьютером, ушёл с телефоном, а тот открыл вопрос с вариантами — выбрать
// нечем, прозу в открытый диалог мост не печатает, выхода нет. Ручное «за телефоном» и есть
// согласие человека обходиться без интерактивного выбора везде.
test('за телефоном коробка запрещена в любой вкладке, а не только в списке', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's9' };
  assert.strictEqual(H.deniesPicker(ask, [], 'phone'), true, 'вкладки нет в списке — всё равно запрет');
  assert.strictEqual(H.deniesPicker({ ...ask, session_id: '' }, [], 'phone'), true, 'даже без id сессии');
  assert.strictEqual(H.deniesPicker({ ...ask, tool_name: 'Bash' }, [], 'phone'), false, 'только коробка');
  assert.strictEqual(H.deniesPicker(ask, [], 'desk'), false, 'за компом выбор остаётся');
  assert.strictEqual(H.deniesPicker(ask, [], ''), false, 'поля нет (файл прежней версии) — как раньше');
});

test('the deny payload carries the status marker AND the decision', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, ['s1']);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(/с телефона/.test(out.hookSpecificOutput.permissionDecisionReason));
  assert.ok(out.terminalSequence, 'status must still be reported while denying');
});

test('a denied picker reports «работает», not «ждёт»', () => {
  // The same PreToolUse normally means «the agent is asking you something». Not when we
  // refuse the box: the turn goes on, and the prose question is seconds away. Reporting
  // «ждёт» here made the bridge send a question whose text was our own refusal — and the
  // real question, when it came, was never sent: this tab had already been reported.
  const m = H.loadMatcher(() => null);
  const denied = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, ['s1']);
  assert.match(denied.terminalSequence, /;busy;/);
  const allowed = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's2' }, m, ['s1']);
  // Не запретили — коробка откроется, и это ожидание С РАМКОЙ: печатать в такую вкладку нельзя
  // ничем, включая перезапуск. Запретили — рамки не будет вовсе, поэтому там и «работает».
  assert.match(allowed.terminalSequence, /;box;/);
});

test('the deny reason names the marker, in the user\'s own wording', () => {
  // Otherwise the agent re-asks in prose with no sign-off: the turn reads as «готов»,
  // the bridge stays silent, and the question waits in a terminal nobody is watching.
  const phrases = ['Твой ход'];
  const m = H.loadMatcher(() => Object.assign({ phrases }, phraseSources(phrases)));
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, ['s1']);
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes('Твой ход'), 'reason names the configured phrase: ' + reason);
  // And what it tells the agent to write must be what the matcher then accepts.
  assert.ok(H.callsUser(m, 'Сделал.\n\nТвой ход: что дальше'), 'the taught sign-off calls');
});

test('without Telegram mode the payload is exactly what it was before', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, []);
  assert.deepStrictEqual(Object.keys(out), ['terminalSequence']);
});

test('an event we do not care about still produces nothing', () => {
  const m = H.loadMatcher(() => null);
  assert.strictEqual(H.outputFor({ hook_event_name: 'SessionStart' }, m, ['s1']), null);
});

test('end to end: «за телефоном» на диске запрещает коробку любой вкладке', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-ph-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'),
    JSON.stringify({ sessions: [], presence: 'phone' }));
  const out = JSON.parse(execFileSync(process.execPath, [staged], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'кто-угодно' }),
    encoding: 'utf8',
  }));
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.terminalSequence, /;busy;/, 'отказ — это продолжение хода, а не ожидание');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end to end: the script denies the picker for a session listed on disk', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-tg-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'), JSON.stringify({ sessions: ['sid-1'] }));
  const run = (sid) => JSON.parse(execFileSync(process.execPath, [staged], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid }),
    encoding: 'utf8',
  }));
  assert.strictEqual(run('sid-1').hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(run('sid-2').hookSpecificOutput, undefined, 'a tab at the keyboard keeps its picker');
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  H = await import(pathToFileURL(SCRIPT).href);
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' hook tests passed');
})();
