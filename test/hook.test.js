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
const { DEFAULT_SOURCES, DEFAULT_ASK_PHRASES, ASK_TAG, DONE_TAG, phraseSources } = require('../ask-phrases');

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

// Тег конца работы — третья метка, и по цвету статуса она ничего не меняет: работа сдана,
// значит вкладка готова. Ловушка тут в разборе: не проверь хук этот тег среди тегов, он
// упал бы в остаточное правило «метка есть, значит зов», и сдавшая работу вкладка встала бы
// жёлтой «ждёт ответа».
test('Stop с тегом конца работы → idle, а не ask', () => {
  const p = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: '[swarm:готово]\nСдал работу: три файла, тесты зелёные.' };
  assert.strictEqual(runHook(p).token, 'idle');
});

test('PostToolUse → busy (the approved tool finished, work resumed)', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }).token, 'busy');
});

// Напоминания Клода про неотвеченный ввод — свои токены, и это не косметика. Приходят они, когда
// человек долго не отвечает, то есть чаще всего при ОТКРЫТОЙ рамке, а сказать про неё им нечего.
// Через общий токен они отменяли бы рамку ровно в тот миг, когда она есть.
test('напоминания про неотвеченный ввод — отдельные токены', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }).token, 'nag');
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }).token, 'lull');
});

// Шаги подагента приходят в те же хуки той же сессии, и отличают их только agent_id /
// agent_type. Пока они шли как busy, вкладка с открытым вопросом светилась оранжевым —
// «занята», — потому что фоновая разведка затирала рамку своим шагом раз в пару секунд.
test('шаги подагента идут своим токеном, а не «работает»', () => {
  const sub = { session_id: 's1', agent_id: 'a1', agent_type: 'general-purpose' };
  assert.strictEqual(runHook({ ...sub, hook_event_name: 'PreToolUse', tool_name: 'Bash' }).token, 'sub');
  assert.strictEqual(runHook({ ...sub, hook_event_name: 'PostToolUse', tool_name: 'Bash' }).token, 'sub');
  assert.strictEqual(runHook({ ...sub, hook_event_name: 'SubagentStop' }).token, 'subend');
  // Свой Task главный ход запускает сам — это его работа, и она видна.
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1' }).token, 'busy');
  assert.strictEqual(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Agent', session_id: 's1' }).token, 'busy');
  // А рамка на экране одна на всех: кто бы её ни открыл, Enter уходит в неё.
  assert.strictEqual(runHook({ ...sub, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }).token, 'box');
});

test('PermissionRequest → perm', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', session_id: 's1' }).token, 'perm');
});

test('Notification permission_prompt → perm', () => {
  assert.strictEqual(runHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).token, 'perm');
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
test('Stop с зовом — ожидание без рамки', () => {
  const p = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Сейчас от тебя: путь к схеме' };
  assert.strictEqual(runHook(p).token, 'ask');
});

test('PreToolUse for a normal tool → busy', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }).token, 'busy');
});

test('an event we do not care about emits nothing', () => {
  assert.strictEqual(runHook({ hook_event_name: 'PreCompact' }), null);
});

// Старт разговора статуса не даёт, а маркер шлёт: в нём id новой сессии и путь стенограммы.
// Только так приложение узнаёт про /clear — иначе оно продолжает читать расход умершего
// разговора (см. newConversation в main.js).
test('SessionStart называет приложению новый разговор', () => {
  const sig = runHook({ hook_event_name: 'SessionStart', session_id: 'sid-new', transcript_path: '/tmp/sid-new.jsonl' });
  assert.strictEqual(sig.token, 'hello');
  assert.strictEqual(sig.sessionId, 'sid-new');
  assert.strictEqual(sig.transcript, '/tmp/sid-new.jsonl');
});

// А статуса у него нет: детектор такого токена не знает, и вкладка остаётся какой была.
test('токен старта разговора статуса не назначает', () => {
  const { applyHook } = require('../detector');
  const d = { hookState: { status: 'waiting', kind: 'question', box: true, at: 1 } };
  assert.strictEqual(applyHook(d, 'hello', 2), false);
  assert.deepStrictEqual(d.hookState, { status: 'waiting', kind: 'question', box: true, at: 1 });
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
  assert.deepStrictEqual(
    { mark: fb.mark, tagAsk: fb.tagAsk, tagWait: fb.tagWait, tagDone: fb.tagDone, none: fb.none, wait: fb.wait },
    DEFAULT_SOURCES);
  // Метка, которую отказ называет агенту обратно, — третья копия тега (приложение,
  // регулярки хука, текст хука), поэтому прибита тоже.
  assert.strictEqual(fb.marker, ASK_TAG);
  // Метка конца работы — такая же третья копия: приложение, регулярки хука, текст просьбы
  // про итог. Разойтись им нельзя: агент, которого учат одному тегу, а ищут другой, сдаёт
  // работу молча.
  assert.strictEqual(fb.doneMarker, DONE_TAG);
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

test('отказ называет тег — и ровно тот, который потом сам и признаёт', () => {
  // Otherwise the agent re-asks in prose with no sign-off: the turn reads as «готов»,
  // the bridge stays silent, and the question waits in a terminal nobody is watching.
  //
  // Именно тег, а не фразу из настроек: тег понимается всегда, а чужая фраза могла бы
  // остаться в файле от прошлой версии — тогда отказ учил бы одному, а хук искал другое.
  const phrases = ['Твой ход'];
  const m = H.loadMatcher(() => Object.assign({ phrases }, phraseSources(phrases)));
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, ['s1']);
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(ASK_TAG), 'отказ называет тег: ' + reason);
  // And what it tells the agent to write must be what the matcher then accepts — включая
  // МЕСТО: отказ велит начать сообщение строкой с тегом, и ровно так он и должен считаться.
  assert.ok(/начни отдельной строкой/.test(reason), 'отказ называет место: ' + reason);
  assert.ok(H.callsUser(m, ASK_TAG + '\n\nСделал. Что дальше?'), 'таким тегом зов признаётся');
  assert.ok(!H.callsUser(m, 'Сделал. Что дальше? ' + ASK_TAG), 'а тег в конце строки — уже нет');
  // Своя фраза при этом продолжает работать — переход на теги её не отменяет.
  assert.ok(H.callsUser(m, 'Сделал.\n\nТвой ход: что дальше'), 'чужая фраза тоже зовёт');
});

test('without Telegram mode the payload is exactly what it was before', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, []);
  assert.deepStrictEqual(Object.keys(out), ['terminalSequence']);
});

test('an event we do not care about still produces nothing', () => {
  const m = H.loadMatcher(() => null);
  assert.strictEqual(H.outputFor({ hook_event_name: 'PreCompact' }, m, ['s1']), null);
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

// --- ночь и ворота на подагентов ---------------------------------------------

// Ночь — это мандаты вкладок, а не положение человека: отдельного «меня нет» у хука больше
// нет вовсе, и отданной вкладке всё равно, за столом человек или с телефоном.
test('отданной вкладке коробка запрещается, и причина — правило', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' };
  assert.strictEqual(H.deniesPicker(ask, [], 'desk', ['s1']), true);
  const m = H.loadMatcher(() => null);
  const out = H.outputFor(ask, m, [], 'desk', { autoSessions: ['s1'] });
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  // Человека нет — значит правило должно ГОВОРИТЬ, что решать самому, а не «спроси прозой, я
  // отвечу с телефона».
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /работает без человека/i);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Реши сам/);
});

// Мандат вкладки — второй, точечный способ сказать то же самое: человек за столом, положение
// «за компом», но ЭТОЙ вкладке отдана задача. Раньше такого не было вовсе: ночь была одна на
// приложение, и разделить «эту отдал» и «этой занимаюсь сам» было нечем.
test('вкладка со своим мандатом получает то же правило и за компом', () => {
  const ask = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' };
  const m = H.loadMatcher(() => null);
  // Мандата нет — коробка разрешена, человек рядом и ответит кнопками.
  assert.strictEqual(H.deniesPicker(ask, [], 'desk', []), false);
  // Отказа нет — уезжает только метка статуса «вкладка открыла рамку и ждёт человека».
  const free = H.outputFor(ask, m, [], 'desk', { autoSessions: [] });
  assert.ok(free && free.terminalSequence, 'метка статуса должна остаться');
  assert.ok(!free.hookSpecificOutput, 'отказа быть не должно');
  // Мандат есть — коробка запрещена, и причина именно правило «решай сам».
  assert.strictEqual(H.deniesPicker(ask, [], 'desk', ['s1']), true);
  const out = H.outputFor(ask, m, [], 'desk', { autoSessions: ['s1'] });
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Реши сам/);
  // Чужой вкладке мандат соседа ничего не запрещает.
  assert.strictEqual(H.deniesPicker({ ...ask, session_id: 's2' }, [], 'desk', ['s1']), false);
});

test('за телефоном причина остаётся прежней, а не ночной', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 's1' }, m, [], 'phone');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /с телефона/);
});

test('на пределе пятичасового окна подагенты не запускаются', () => {
  const now = 1_000_000;
  const task = { hook_event_name: 'PreToolUse', tool_name: 'Task', session_id: 's1' };
  const g = H.gatesSubagent(task, { five: { spent: 93, resetsAt: now + 2400 }, seven: { spent: 60 } }, now);
  assert.ok(g, 'ворота должны сработать');
  assert.match(g.reason, /Пятичасовое/);
  assert.match(g.reason, /сброс через 40м/, 'человеку и агенту нужен срок, а не только факт');
});

// Ждать недельного сброса бессмысленно — он через дни. Совет там другой, и это не косметика:
// «дождись сброса» ночью означало бы простой до утра и дальше.
test('недельное окно проверяется первым и советует не ждать', () => {
  const g = H.gatesSubagent({ hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { five: { spent: 99 }, seven: { spent: 98 } }, 0);
  assert.match(g.reason, /Недельное/);
  assert.match(g.reason, /Ждать бессмысленно/);
});

test('запас есть — ворота молчат', () => {
  const ok = H.gatesSubagent({ hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { five: { spent: 70 }, seven: { spent: 40 } }, 0);
  assert.strictEqual(ok, null);
});

// rate_limits приходят только на подписке и только с первого ответа API: у свежей сессии их
// нет вовсе. Отказ здесь запретил бы ПЕРВОГО подагента в каждой новой вкладке.
test('нет данных о расходе — подагенты разрешены', () => {
  const task = { hook_event_name: 'PreToolUse', tool_name: 'Task' };
  assert.strictEqual(H.gatesSubagent(task, null, 0), null);
  assert.strictEqual(H.gatesSubagent(task, { five: null, seven: null }, 0), null);
});

test('ворота стоят только на подагентах', () => {
  const usage = { five: { spent: 99 }, seven: { spent: 99 } };
  assert.strictEqual(H.gatesSubagent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, usage, 0), null);
  assert.strictEqual(H.gatesSubagent({ hook_event_name: 'PostToolUse', tool_name: 'Task' }, usage, 0), null);
});

// Окна общие на АККАУНТ, но аккаунтов у человека бывает несколько (CLAUDE_CONFIG_DIR, алиас
// вроде claude-my). Смешать их значит запретить подагентов на личном из-за расхода рабочего.
test('снимок расхода берётся самый свежий, но только своего аккаунта', () => {
  const snaps = [
    { session: 'mine', home: '/h/work', at: 10, five: { spent: 10 } },
    { session: 'other', home: '/h/work', at: 20, five: { spent: 80 } },
    { session: 'personal', home: '/h/my', at: 99, five: { spent: 99 } },
  ];
  assert.strictEqual(H.pickUsage(snaps, 'mine').five.spent, 80, 'свежий из своего аккаунта');
  assert.strictEqual(H.pickUsage(snaps, 'personal').five.spent, 99);
  assert.strictEqual(H.pickUsage(snaps, 'unknown'), null, 'своего снимка нет — не решаем ничего');
});

// Снимок пишется и когда в нём одно заполнение контекста: у сессии, не получившей ещё ни одного
// ответа API, и у вкладки на ключе вместо подписки. Такой файл, легший последним, обнулял ворота
// целиком — ровно тогда, когда они нужны.
test('снимок без чисел окон не отменяет ворота', () => {
  const snaps = [
    { session: 'work', home: '/h', at: 5, five: { spent: 97 } },
    { session: 'fresh', home: '/h', at: 99, ctx: { used: 10 } },
  ];
  assert.strictEqual(H.pickUsage(snaps, 'fresh').five.spent, 97, 'берём свежий из ТЕХ, где числа есть');
  assert.strictEqual(H.pickUsage([{ session: 'x', home: '/h', at: 1, ctx: { used: 1 } }], 'x'), null);
});

test('снимок без аккаунта (строка статуса прежней версии) считается только своим', () => {
  const snaps = [{ session: 'mine', at: 1, five: { spent: 10 } }, { session: 'x', at: 99, five: { spent: 99 } }];
  assert.strictEqual(H.pickUsage(snaps, 'mine').five.spent, 10);
});

test('в начало хода уезжают числа расхода, а не отказ', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { usage: { five: { spent: 93, resetsAt: 100 }, seven: { spent: 61 } }, nowSec: 0 });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /5ч 93%/);
  assert.match(out.hookSpecificOutput.additionalContext, /7д 61%/);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, undefined, 'это не запрет');
  assert.match(out.terminalSequence, /;busy;/, 'статус хода не меняется');
});

// Итог доезжает в НАЧАЛЕ хода, а не в конце: конец хода мы узнаём тогда, когда агент уже
// замолчал, — говорить ему про итог в этот миг поздно.
test('автономной вкладке в начало задачи уезжает просьба про итог', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { autoSessions: ['s1'], nowSec: 0 });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Задача кончилась/);
});

test('вкладке без мандата про итог не говорят', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { autoSessions: [], nowSec: 0 });
  assert.ok(!out || !out.hookSpecificOutput, 'обычной вкладке добавлять нечего');
});

test('вкладка без мандата про итог не слышит', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's9' }, m, [], 'desk',
    { autoSessions: [], nowSec: 0 });
  assert.strictEqual(out && out.hookSpecificOutput, undefined, 'своей вкладке итог не заказывают');
});

test('числа расхода и просьба про итог едут вместе', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk',
    { usage: { five: { spent: 93, resetsAt: 100 }, seven: { spent: 61 } }, autoSessions: ['s1'], nowSec: 0 });
  assert.match(out.hookSpecificOutput.additionalContext, /5ч 93%/);
  assert.match(out.hookSpecificOutput.additionalContext, /Задача кончилась/);
});

test('без снимка расхода начало хода выглядит как раньше', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, []);
  assert.deepStrictEqual(Object.keys(out), ['terminalSequence']);
});

test('end to end: отданные вкладки читаются с диска списком', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-night-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  // «Ночь у всех» на диске выглядит просто как список, в котором эта вкладка есть: отдельного
  // положения «меня нет» больше нет ни в файле, ни в голове у хука.
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'),
    JSON.stringify({ sessions: [], presence: 'desk', auto: ['ночная'] }));
  const out = JSON.parse(execFileSync(process.execPath, [staged], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'ночная',
      tool_input: { questions: [{ question: 'Мигрировать молча?', options: [{ label: 'да' }] }] },
    }),
    encoding: 'utf8',
  }));
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /работает без человека/i);
  // Следа от развилки не остаётся, и это осознанно: рассказывает о своей работе сам агент
  // (night.js summaryNote), а не сворм по своим записям.
  assert.strictEqual(fs.existsSync(path.join(dir, 'night.jsonl')), false, 'журнала больше нет');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Мандат одной вкладки — через тот же файл, что и «где я»: хук отдельный процесс, и другого
// способа узнать про вкладку у него нет. Проверяем весь путь: файл → отказ → правило.
test('end to end: мандат одной вкладки читается с диска', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-auto-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'),
    JSON.stringify({ sessions: [], auto: ['своя'], presence: 'desk' }));
  const run = (sid) => JSON.parse(execFileSync(process.execPath, [staged], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid,
      tool_input: { questions: [{ question: 'Мигрировать молча?', options: [{ label: 'да' }] }] },
    }),
    encoding: 'utf8',
  }) || '{}');
  const mine = run('своя');
  assert.strictEqual(mine.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(mine.hookSpecificOutput.permissionDecisionReason, /Реши сам/);
  // А соседней вкладке за компом рамку никто не запрещает: человек рядом и ответит кнопками.
  const other = execFileSync(process.execPath, [staged], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: 'чужая',
      tool_input: { questions: [{ question: 'Мигрировать молча?' }] },
    }),
    encoding: 'utf8',
  });
  assert.doesNotMatch(other || '', /permissionDecision/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Имя подписки в строке расхода. Числа агент видел и раньше — а чьи они, не знал: аккаунтов у
// человека несколько, окна у них разные, и «7д 84%» без имени не отвечает, на чём агент работает.
test('агент слышит имя своей подписки вместе с числами', () => {
  const m = H.loadMatcher(() => null);
  const out = H.outputFor({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, m, [], 'desk', {
    usage: { five: { spent: 93, resetsAt: 100 }, seven: { spent: 61 }, home: '/h/.claude-my' },
    subCards: [{ line: 'claude', name: 'рабочая', home: '/h/.claude' },
      { line: 'claude-my', name: 'личная', home: '/h/.claude-my' }],
    nowSec: 0,
  });
  const note = out.hookSpecificOutput.additionalContext;
  assert.match(note, /подписке «личная»/, note);
  assert.match(note, /5ч 93%/);
  assert.strictEqual(note.includes('рабочая'), false, 'чужой аккаунт агенту не называем');
});

test('имени нет — про имя молчим, числа остаются', () => {
  const usage = { five: { spent: 40 }, seven: { spent: 50 }, home: '/h/.claude' };
  assert.match(H.usageNote(usage, 0, ''), /^Расход подписки прямо сейчас: 5ч 40%/);
  assert.strictEqual(H.subName([{ line: 'claude', name: '', home: '/h/.claude' }], '/h/.claude'), '');
  assert.strictEqual(H.subName([{ line: 'claude', name: 'рабочая', home: '/h/.claude' }], ''), '');
});

test('снимок несёт конфиг, в котором израсходовано', () => {
  const snaps = [{ session: 'mine', at: 5, home: '/h/.claude-my', five: { spent: 10 } }];
  assert.strictEqual(H.pickUsage(snaps, 'mine').home, '/h/.claude-my');
});

test('end to end: ворота отказывают подагенту по снимку расхода на диске', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-gate-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  fs.mkdirSync(path.join(dir, 'usage'));
  fs.writeFileSync(path.join(dir, 'usage', 'sid.json'), JSON.stringify({
    at: Math.floor(Date.now() / 1000), session: 'sid', home: '/h/work',
    five: { spent: 95, resetsAt: Math.floor(Date.now() / 1000) + 600 }, seven: { spent: 50 },
  }));
  const out = JSON.parse(execFileSync(process.execPath, [staged], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Task', session_id: 'sid' }),
    encoding: 'utf8',
  }));
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Пятичасовое окно/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- самозвон перезапуска ----------------------------------------------------
// Умение перезапустить себя у агента было всегда, а знания о нём — нет: имя файла приносила
// просьба сворма, то есть только тем, кто дошёл до порога. Одна строка на старте сессии закрывает
// дыру, но она обязана быть правдой: имя файла — тем, которое приложение и правда читает, а сама
// строка — только когда функция включена.
test('свежей сессии сворм называет тот файл, который сам читает', () => {
  const restart = require('../restart');
  const sid = '0d7f8c22-3b1a-4d55-9f10-aa1122334455';
  assert.strictEqual(H.restartFileFor(sid), restart.answerName(sid));
  const out = H.outputFor({ hook_event_name: 'SessionStart', session_id: sid, cwd: '/tmp' },
    null, [], 'desk', { restart: { on: true } });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(restart.answerName(sid)),
    'в строке названо имя файла');
  assert.match(out.hookSpecificOutput.additionalContext, /перезапустить себя сам/);
});

test('выключенный перезапуск про самозвон молчит', () => {
  const off = { restart: { on: false } };
  const out = H.outputFor({ hook_event_name: 'SessionStart', session_id: 's1' }, null, [], 'desk', off);
  assert.strictEqual(out.hookSpecificOutput, undefined, 'агенту не сказано ничего');
  // Файла режимов от прежней версии сворма (поля нет вовсе) — то же молчание.
  assert.strictEqual(H.outputFor({ hook_event_name: 'SessionStart', session_id: 's1' },
    null, [], 'desk', {}).hookSpecificOutput, undefined);
  // А приложению — сказано: имя разговора от галочки человека не зависит, оно нужно всегда.
  assert.deepStrictEqual(Object.keys(out), ['terminalSequence']);
});

test('end to end: включённый перезапуск на диске доезжает до свежей сессии', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hook-rs-')));
  const staged = path.join(dir, 'swarm-signal.mjs');
  fs.copyFileSync(SCRIPT, staged);
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'),
    JSON.stringify({ sessions: [], presence: 'desk', restart: { on: true } }));
  const run = () => execFileSync(process.execPath, [staged], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sid-9', cwd: dir }),
    encoding: 'utf8',
  });
  const out = JSON.parse(run());
  assert.match(out.hookSpecificOutput.additionalContext, /\.swarm-restart-sid-9\.json/);
  // Выключили — и строка исчезла с того же диска, без пересборки чего-либо.
  fs.writeFileSync(path.join(dir, 'swarm-tgmode.json'),
    JSON.stringify({ sessions: [], presence: 'desk', restart: { on: false } }));
  assert.strictEqual(JSON.parse(run()).hookSpecificOutput, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Подагенту не рассказывают ни про перезапуск (гасить вкладку ему не за что), ни маркером
// про новый разговор: его старт — не смена разговора вкладки, а шаг внутри чужого хода.
test('подагенту про перезапуск вкладки не рассказывают', () => {
  assert.strictEqual(H.outputFor({ hook_event_name: 'SessionStart', session_id: 's1', agent_id: 'a1' },
    null, [], 'desk', { restart: { on: true } }), null);
});

(async () => {
  H = await import(pathToFileURL(SCRIPT).href);
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
  }
  console.log(passed + '/' + tests.length + ' hook tests passed');
})();
