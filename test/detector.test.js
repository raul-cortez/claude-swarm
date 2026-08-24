// Plain-node tests for the status state machine + «ждёт» latch (detector.js).
const assert = require('assert');
const D = require('../detector');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const NOW = 1_000_000;
const quietAt = () => NOW - D.ACTIVE_MS - 1; // lastDataAt old enough to count as quiet

// Screen fixtures.
const PERMISSION = [
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. No, and tell Claude what to do      │',
  '  Esc to cancel',
].join('\n');
const QUESTION = ['Какой цвет иконки?', '❯ 1. Синий', '  2. Серый'].join('\n');
const ASK = 'Сейчас от тебя: путь к схеме';
const SPINNER = '✻ Cooking… (12s · esc to interrupt)';
const QUIET = '> \n';

function mkD(over) {
  return Object.assign(
    { lastDataAt: quietAt(), waitLatched: false, waitKind: null, chromeGoneSince: 0 },
    over,
  );
}

// --- decide: the raw per-tick read -----------------------------------------

test('decide: permission chrome wins even while bytes flow', () => {
  const r = D.decide(mkD({ lastDataAt: NOW }), NOW, PERMISSION);
  assert.strictEqual(r.status, 'waiting');
  assert.strictEqual(r.kind, 'permission');
});

test('decide: recent bytes with no chrome → running', () => {
  const r = D.decide(mkD({ lastDataAt: NOW }), NOW, QUIET);
  assert.strictEqual(r.status, 'running');
});

test('decide: quiet spinner → running (not a false готов)', () => {
  const r = D.decide(mkD(), NOW, SPINNER);
  assert.strictEqual(r.status, 'running');
});

test('decide: quiet prose question → waiting + question', () => {
  const r = D.decide(mkD(), NOW, ASK);
  assert.strictEqual(r.status, 'waiting');
  assert.strictEqual(r.kind, 'question');
});

// Проза со стрелкой — НЕ рамка. Живой случай: агент закрыл ход тегом [swarm:фон], оба
// честных канала сказали «фон», а вкладка встала «ждёт ответа: вопрос» — шаблон строки
// выбора («❯ 1. Yes») ловил «→ 9515.» и «→ 9300.» посреди отчёта. Держала её потом защёлка:
// пока текст на экране, рамка «стоит», и снять её нечем.
const PROSE_ARROWS = [
  '⏺ [swarm:фон] Прогон пошёл (~11 мин). Пока идёт — короткий итог.',
  '',
  '  Запаса было 115 токенов, и четыре коммита съели его целиком —',
  '  9385 → 9447 → 9494 → 9500 (ровно в потолок) → 9515. Виноватого коммита нет.',
  '  Ядро 9515 → 9300.',
].join('\n');

test('рамки нет: стрелка с числом посреди прозы не читается как строка выбора', () => {
  assert.strictEqual(D.hasPromptBox(PROSE_ARROWS), false);
  assert.strictEqual(D.RE_WAIT_NOW.test(PROSE_ARROWS), false);
  assert.notStrictEqual(D.decide(mkD(), NOW, PROSE_ARROWS).status, 'waiting');
});

test('рамка есть: тот же шаблон ловит настоящий выбор в начале строки', () => {
  assert.strictEqual(D.hasPromptBox(QUESTION), true);
  assert.strictEqual(D.RE_WAIT_NOW.test(PERMISSION), true);
  assert.strictEqual(D.RE_WAIT_NOW.test(' ❯ 1. Yes, I trust this folder'), true);
});

test('decide: quiet empty screen → ready', () => {
  assert.strictEqual(D.decide(mkD(), NOW, QUIET).status, 'ready');
});

test('decide: «Сейчас от тебя: ничего, жди …» stays ready (not a false «ждёт»)', () => {
  const r = D.decide(mkD(), NOW, 'Сейчас от тебя: ничего, жди результата ревью');
  assert.strictEqual(r.status, 'ready');
});

test('arbitrate: a hook «ready» is NOT upgraded by a «ничего, жди» sign-off', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  assert.strictEqual(D.tickStatus(d, NOW, 'Сейчас от тебя: ничего, жди').status, 'ready');
});

// --- applyLatch: hold «ждёт» through noise ----------------------------------

test('latch: engages when raw goes waiting', () => {
  const d = mkD();
  const eff = D.applyLatch(d, NOW, PERMISSION, D.decide(d, NOW, PERMISSION));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: holds «ждёт» through a one-tick repaint blip (no chrome, no spinner)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  // Blip: screen momentarily has neither chrome nor spinner, and it's quiet.
  const eff = D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));
  assert.strictEqual(eff.status, 'waiting', 'must not flicker to ready');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: a repaint blip then chrome back resets the debounce', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));           // blip → chromeGoneSince set
  assert.notStrictEqual(d.chromeGoneSince, 0);
  const eff = D.applyLatch(d, NOW + 300, PERMISSION, D.decide(d, NOW + 300, PERMISSION));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(d.chromeGoneSince, 0, 'chrome back → debounce cleared');
});

// Признак рамки решает, можно ли печатать в живую вкладку (перезапуск это делает сам), и цена
// ошибки — двадцать строк просьбы с Enter в открытую коробку, то есть выбор в ней за человека.
// Ветка ниже — «держит строка зова, печатать можно» — срабатывает ровно на том кадре, где скрёб
// рамку не нашёл, а это и есть его обычный промах: рамку уносит за край, ломает чужая отрисовка.
test('latch: пропавшая на кадр рамка не открывает печать в неё', () => {
  const d = mkD();
  // Коробка с вариантами открыта, а над ней висит строка прошлого зова — обычный экран.
  const box = QUESTION + '\n' + ASK;
  assert.strictEqual(D.applyLatch(d, NOW, box, D.decide(d, NOW, box)).box, true);
  // Кадр без рамки. Ожидание остаётся, но объявить вкладку свободной для печати нельзя.
  const blip = D.applyLatch(d, NOW + 300, ASK, D.decide(d, NOW + 300, ASK));
  assert.strictEqual(blip.status, 'waiting');
  assert.strictEqual(blip.box, true, 'один кадр без рамки — это не «рамки нет»');
  // Рамка вернулась — верим сразу и выдержку обнуляем.
  assert.strictEqual(D.applyLatch(d, NOW + 600, box, D.decide(d, NOW + 600, box)).box, true);
  // А когда её нет по-настоящему, признак снимается, не снимая ожидания: держит зов, и в строку
  // ввода печатать можно. Иначе вкладка, у которой рамку закрыли, осталась бы «с рамкой» навсегда.
  const t = NOW + 700;
  D.applyLatch(d, t, ASK, D.decide(d, t, ASK));
  const late = D.applyLatch(d, t + D.LATCH_RELEASE_MS, ASK, D.decide(d, t + D.LATCH_RELEASE_MS, ASK));
  assert.strictEqual(late.status, 'waiting', 'зов держит ожидание');
  assert.strictEqual(late.box, false);
});

test('latch: releases the instant the spinner returns (agent resumed)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'question' });
  const eff = D.applyLatch(d, NOW, SPINNER, D.decide(d, NOW, SPINNER));
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: releases to ready only after the debounce window (trivial prompt answered, quiet)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));           // t0: start debounce, held
  assert.strictEqual(d.waitLatched, true);
  const t1 = NOW + D.LATCH_RELEASE_MS;
  const eff = D.applyLatch(d, t1, QUIET, D.decide(d, t1, QUIET)); // window elapsed → release
  assert.strictEqual(eff.status, 'ready');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: typing keeps the prompt on screen, so it stays «ждёт» (not released by input)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission' });
  // A keystroke echoes as recent bytes, but the permission chrome is still there.
  const eff = D.applyLatch(d, NOW, PERMISSION, D.decide(mkD({ lastDataAt: NOW }), NOW, PERMISSION));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(d.waitLatched, true);
});

// --- applyLatch: answering (Enter) -------------------------------------------
// main sets `answeredAt` when you press Enter in a session. It's a HINT: it never
// releases the latch on its own, it only stops stale evidence from outvoting work.

test('latch: Enter in a quiz keeps «ждёт» while the next question is on screen', () => {
  const d = mkD({ waitLatched: true, waitKind: 'question', answeredAt: NOW, lastDataAt: NOW });
  const eff = D.applyLatch(d, NOW, QUESTION, D.decide(d, NOW, QUESTION));
  assert.strictEqual(eff.status, 'waiting', 'a live prompt box still wins');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: a stale «Сейчас от тебя» no longer pins «ждёт» once the spinner turns', () => {
  const d = mkD({ waitLatched: true, waitKind: 'question' });
  const snap = ASK + '\n' + SPINNER;   // answered; the ask line is still in scrollback
  const eff = D.applyLatch(d, NOW, snap, D.decide(d, NOW, snap));
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: «Сейчас от тебя» with no sign of work stays «ждёт»', () => {
  const d = mkD({ waitLatched: true, waitKind: 'question' });
  const eff = D.applyLatch(d, NOW, ASK, D.decide(d, NOW, ASK));
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(d.waitLatched, true);
});

test('latch: Enter + fresh output beats a stale «Сейчас от тебя» (no spinner yet)', () => {
  const d = mkD({ waitLatched: true, waitKind: 'question', answeredAt: NOW, lastDataAt: NOW });
  const eff = D.applyLatch(d, NOW, ASK, D.decide(d, NOW, ASK));
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: Enter on a cleared screen releases without the debounce wait', () => {
  const d = mkD({ waitLatched: true, waitKind: 'permission', answeredAt: NOW, lastDataAt: NOW });
  const eff = D.applyLatch(d, NOW, QUIET, D.decide(d, NOW, QUIET));
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('latch: a NEW prompt clears the Enter hint (next prompt gets the full debounce)', () => {
  const d = mkD({ answeredAt: NOW });
  D.applyLatch(d, NOW, PERMISSION, D.decide(d, NOW, PERMISSION));   // engage on a new prompt
  assert.strictEqual(d.answeredAt, 0);
  const eff = D.applyLatch(d, NOW + 1, QUIET, D.decide(d, NOW + 1, QUIET));
  assert.strictEqual(eff.status, 'waiting', 'a repaint blip must not release it');
});

test('latch: a stale answeredAt does not shortcut the debounce', () => {
  const t = NOW + D.ANSWER_HINT_MS;       // hint window has expired
  const d = mkD({ waitLatched: true, waitKind: 'permission', answeredAt: NOW });
  const eff = D.applyLatch(d, t, QUIET, D.decide(d, t, QUIET));
  assert.strictEqual(eff.status, 'waiting', 'back to the normal repaint debounce');
  assert.strictEqual(d.waitLatched, true);
});

// --- зов прозой, на который уже ответили --------------------------------------
// Живой случай: вкладка спросила прозой, я ответил и переключился на другую. Строка «Сейчас
// от тебя: …» осталась в переписке, вкладка через пару секунд снова прочитала её как просьбу
// — и, будучи уже фоновой, выкинула уведомление о зове, на который я только что ответил.
// Признак «этот зов закрыт» — отпечаток строк зова, снятый в момент Enter (main.markAnswered).
const S = require('../screen');
const ASK_ANSWERED = [ASK, '', '> да, гоняй', '', '> '].join('\n');
const answered = (snap, over) => mkD(Object.assign({ askAnswered: S.askFingerprint(snap) }, over));

test('asksNow: тот же зов после ответа не зовёт, а новый — зовёт', () => {
  const d = answered(ASK);
  assert.strictEqual(D.asksNow(d, ASK_ANSWERED), false, 'на этот зов я ответил');
  assert.strictEqual(D.asksNow(d, 'Сейчас от тебя: а теперь путь к схеме'), true, 'зов другой');
});

test('asksNow: без отметки об ответе зов считается (обычный случай)', () => {
  assert.strictEqual(D.asksNow(mkD(), ASK), true);
});

test('asksNow: ушедший с экрана зов стирает память об ответе', () => {
  const d = answered(ASK);
  assert.strictEqual(D.asksNow(d, QUIET), false);
  assert.strictEqual(d.askAnswered, '', 'зова на экране нет — забыли, что отвечали');
  assert.strictEqual(D.asksNow(d, ASK), true, 'тот же текст, но это уже новый зов');
});

test('decide: отвеченный зов не поднимает «ждёт» заново (тишина → готов)', () => {
  const d = answered(ASK);
  assert.strictEqual(D.decide(d, NOW, ASK_ANSWERED).status, 'ready');
  assert.strictEqual(D.decide(mkD(), NOW, ASK_ANSWERED).status, 'waiting', 'без отметки — по-прежнему зов');
});

test('latch: отвеченный зов больше не пиннит «ждёт» без спиннера', () => {
  // Раньше строка в переписке держала вкладку в «ждёт» до тех пор, пока не завертится
  // спиннер, — то есть после ответа она секунды висела «ждёт ответа».
  const d = answered(ASK, { waitLatched: true, waitKind: 'question', answeredAt: NOW, lastDataAt: NOW });
  const eff = D.applyLatch(d, NOW, ASK_ANSWERED, D.decide(d, NOW, ASK_ANSWERED));
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('arbitrate: хук «готов» + отвеченный зов на экране = готов, а не «ждёт»', () => {
  const d = answered(ASK);
  D.applyHook(d, 'idle', NOW);
  assert.strictEqual(D.tickStatus(d, NOW, ASK_ANSWERED).status, 'ready');
});

test('latch: kind sharpens question → permission', () => {
  const d = mkD();
  D.applyLatch(d, NOW, QUESTION, D.decide(d, NOW, QUESTION));     // latch as question
  assert.strictEqual(d.waitKind, 'question');
  const eff = D.applyLatch(d, NOW + 300, PERMISSION, D.decide(d, NOW + 300, PERMISSION));
  assert.strictEqual(eff.kind, 'permission');
});

test('latch: kind never softens permission → question', () => {
  const d = mkD();
  D.applyLatch(d, NOW, PERMISSION, D.decide(d, NOW, PERMISSION));  // latch as permission
  assert.strictEqual(d.waitKind, 'permission');
  const eff = D.applyLatch(d, NOW + 300, QUESTION, D.decide(d, NOW + 300, QUESTION));
  assert.strictEqual(eff.kind, 'permission');
});

// --- hooks + arbitration ----------------------------------------------------

test('hook: applyHook flips hooksActive and records status/kind', () => {
  const d = mkD();
  assert.strictEqual(D.applyHook(d, 'perm', NOW), true);
  assert.strictEqual(d.hooksActive, true);
  assert.strictEqual(d.hookState.status, 'waiting');
  assert.strictEqual(d.hookState.kind, 'permission');
});

// «Ждёт» бывает двух совсем разных сортов, и статус у них один. Рамка (запрос разрешения,
// коробка с вариантами) съедает Enter выбором варианта; зов прозой оставляет строку ввода
// свободной. Различает их только сам Клод — отдельным событием, — а нужно это тому, кто печатает
// в живую вкладку сам: перезапуску. Спутай их в любую сторону, и получится либо ответ за
// человека, либо вкладки сворма, не перезапускаемые никогда: они прощаются зовом всегда.
test('hook: рамка и зов прозой — разные ожидания', () => {
  for (const token of ['perm', 'box']) {
    const d = mkD();
    D.applyHook(d, token, NOW);
    assert.strictEqual(d.hookState.box, true, `${token} — рамка`);
    assert.strictEqual(D.arbitrate(d, NOW, '').box, true, `${token} доезжает до вердикта`);
  }
  const d = mkD();
  D.applyHook(d, 'ask', NOW);
  assert.strictEqual(d.hookState.status, 'waiting', 'зов — тоже ожидание');
  assert.strictEqual(d.hookState.box, false, 'но рамки за ним нет');
  assert.strictEqual(D.arbitrate(d, NOW, '').box, false);
  // И признак снимается вместе с ожиданием, а не живёт своей жизнью.
  D.applyHook(d, 'busy', NOW + 1);
  assert.strictEqual(D.arbitrate(d, NOW + 1, '').box, false);
});

// Notification «агенту нужен ввод» Клод шлёт, когда человек с минуту не отвечает, — то есть чаще
// всего при ОТКРЫТОЙ рамке, и ночью до этой минуты доживает каждая. Токен у него общий с зовом
// прозой, а про рамку он не знает ничего; затри он ею добытое знание — и мы сами себе разрешили бы
// печать в живую коробку, да ещё понизили бы «разрешение» до «вопроса», выбив второй источник.
test('hook: напоминание про неотвеченный ввод не отменяет открытую рамку', () => {
  for (const nudge of ['nag', 'lull']) {
    const d = mkD();
    D.applyHook(d, 'perm', NOW);
    D.applyHook(d, nudge, NOW + 60_000);
    const eff = D.arbitrate(d, NOW + 60_000, '');
    assert.strictEqual(eff.box, true, `${nudge}: рамка на месте`);
    assert.strictEqual(eff.kind, 'permission', `${nudge}: и это по-прежнему разрешение`);
    // Подтверждение свежее самого сигнала — иначе стенограмма, старше рамки, перебила бы её.
    assert.strictEqual(d.hookState.at, NOW + 60_000);
  }
  // А на вкладке без рамки напоминание значит ровно то, что написано.
  const clean = mkD();
  D.applyHook(clean, 'lull', NOW);
  assert.strictEqual(D.arbitrate(clean, NOW, '').status, 'ready');
  D.applyHook(clean, 'nag', NOW + 1);
  assert.strictEqual(D.arbitrate(clean, NOW + 1, '').status, 'waiting');
  assert.strictEqual(D.arbitrate(clean, NOW + 1, '').box, false);
});

// Рамка уходит не только ответом: запрос разрешения можно ОТКЛОНИТЬ, и тогда никакого PostToolUse
// не будет — агент просто заговорит и кончит ход. Держись знание о рамке за «пока не придёт busy»,
// такая вкладка осталась бы «с рамкой» навсегда: перезапуск её больше не трогает, а мост
// отказывается принимать текст с телефона, предлагая закрыть диалог, которого нет.
test('hook: отклонённое разрешение не оставляет вкладку «с рамкой» навсегда', () => {
  const d = mkD();
  D.applyHook(d, 'perm', NOW);
  // Человек отказал, агент ответил прозой и кончил ход зовом. PostToolUse не приходил.
  D.applyHook(d, 'ask', NOW + 5000);
  const eff = D.arbitrate(d, NOW + 5000, '');
  assert.strictEqual(eff.status, 'waiting', 'вкладка по-прежнему зовёт человека');
  assert.strictEqual(eff.box, false, 'но рамки на ней нет');
  assert.strictEqual(eff.kind, 'question', 'и это вопрос, а не разрешение');
  // И час спустя тоже — иначе перезапуск обходил бы эту вкладку до конца её дней.
  assert.strictEqual(D.arbitrate(d, NOW + 3600_000, '').box, false);
});

test('hook: an unknown token is ignored', () => {
  const d = mkD();
  assert.strictEqual(D.applyHook(d, 'bogus', NOW), false);
  assert.strictEqual(d.hooksActive, undefined);
});

test('tickStatus: hooks drive status once active — screen cannot override', () => {
  const d = mkD();
  D.applyHook(d, 'busy', NOW);                    // hook says running
  // Screen shows a permission prompt, but the hook is authoritative → running.
  const eff = D.tickStatus(d, NOW, PERMISSION);
  assert.strictEqual(eff.status, 'running');
});

test('tickStatus: permission from a hook shows «ждёт» + permission', () => {
  const d = mkD();
  D.applyHook(d, 'perm', NOW);
  const eff = D.tickStatus(d, NOW, QUIET);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
});

test('arbitrate: screen upgrades a hook «ready» to a prose question', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);                    // hook says ready (turn ended)
  const eff = D.tickStatus(d, NOW, ASK);          // but «Сейчас от тебя» on screen
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'question');
});

test('arbitrate: a hook «ready» with a quiet screen stays ready', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  assert.strictEqual(D.tickStatus(d, NOW, QUIET).status, 'ready');
});

// --- канал хуков ослеп, а агент работает --------------------------------------
// «Готов» от хука не стареет сам: пропал один маркер — и вкладка зелёная, пока агент
// ведёт разговор. Живой спиннер на экране — единственная улика, которой в этом случае
// верят, и только против «готов».

test('arbitrate: замолчавший хук «готов» + живой спиннер = работает', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  const late = NOW + D.HOOK_STALE_MS + 1;
  assert.strictEqual(D.tickStatus(d, late, SPINNER).status, 'running');
});

test('arbitrate: свежий хук «готов» спиннером не отменяется', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + 1000, SPINNER).status, 'ready',
    'сразу после Stop экран ещё перерисовывается — верим хуку');
});

test('arbitrate: спиннер на отлистанном экране ничего не отменяет', () => {
  const d = mkD({ scrolledBack: true });
  D.applyHook(d, 'idle', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, SPINNER).status, 'ready',
    'отлистанный экран — прошлое, спиннер на нём может быть от прошлого хода');
});

// --- шаг подагента статуса не назначает ---------------------------------------
// Живьём: агент отправил разведку фоновым подагентом, следом открыл вопрос с вариантами и
// остановился. Вкладка светилась оранжевым — «занята», человек мимо неё проходит, — потому
// что каждый шаг разведки приходил как «работает» и затирал открытую рамку.

test('шаг подагента не отменяет «ждёт»', () => {
  const d = mkD();
  D.applyHook(d, 'box', NOW);
  D.applyHook(d, 'sub', NOW + 100);
  const eff = D.tickStatus(d, NOW + 200, QUESTION);
  assert.strictEqual(eff.status, 'waiting', 'разведка ходит, а вопрос ждёт человека');
  assert.strictEqual(eff.box, true);
});

test('шаг подагента поднимает «готов» до «работает в фоне»', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  D.applyHook(d, 'sub', NOW + 100);
  const eff = D.tickStatus(d, NOW + 200, QUIET);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(eff.bg, true, 'ход кончился, но задачу давать рано — фон разбудит');
});

test('подагент закончил — вкладка снова «готов»', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  D.applyHook(d, 'sub', NOW + 100);
  D.applyHook(d, 'subend', NOW + 200);
  assert.strictEqual(D.tickStatus(d, NOW + 300, QUIET).status, 'ready');
});

test('конца от подагента не пришло — отметка сама стареет', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  D.applyHook(d, 'sub', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + D.SUB_STALE_MS - 1, QUIET).status, 'running');
  assert.strictEqual(D.tickStatus(d, NOW + D.SUB_STALE_MS + 1, QUIET).status, 'ready',
    'иначе упавший подагент оставил бы вкладку занятой навсегда');
});

// Обратная сторона той же слепоты, и она дороже: канал замолчал на «работает», а на
// экране живая рамка. Оранжевая вкладка значит «занята» — человек мимо неё проходит,
// а она его ждёт.

test('arbitrate: замолчавший хук «работает» + живая рамка = ждёт ответа', () => {
  const d = mkD();
  D.applyHook(d, 'busy', NOW);
  const eff = D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, QUESTION);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.box, true, 'Enter уйдёт в коробку — печатать в такую вкладку нельзя');
});

test('arbitrate: свежий хук «работает» рамкой не отменяется', () => {
  const d = mkD();
  D.applyHook(d, 'busy', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + 1000, QUESTION).status, 'running',
    'исправный канал сам скажет про рамку — ждать его, а не читать экран');
});

test('arbitrate: рамка на отлистанном экране «работает» не отменяет', () => {
  const d = mkD({ scrolledBack: true });
  D.applyHook(d, 'busy', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, QUESTION).status, 'running');
});

test('arbitrate: проза на экране никогда не делает из «работает» — «ждёт»', () => {
  const d = mkD();
  D.applyHook(d, 'busy', NOW);
  // Строка зова живёт на экране и ПОСЛЕ ответа, рамки за ней нет — верить ей против
  // сигнала хука нельзя. Само «работает» при этом уже не держится (см. hookRunStuck:
  // сигнал несвежий, спиннера нет, байты не идут), так что вкладка свободна, но не зовёт.
  const eff = D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, ASK);
  assert.notStrictEqual(eff.status, 'waiting', 'зов прозой тут не голосует');
  assert.strictEqual(eff.status, 'ready');
});

test('arbitrate: «ждёт» от хука спиннером не сбивается', () => {
  const d = mkD();
  D.applyHook(d, 'perm', NOW);
  const eff = D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, SPINNER);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
});

test('tickStatus: without hooks it falls back to the latch', () => {
  const d = mkD();
  const eff = D.tickStatus(d, NOW, PERMISSION);   // no hooks → screen decides
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(d.waitLatched, true);        // and the latch engaged
});

// --- the transcript channel -------------------------------------------------

const tr = (over) => Object.assign({ status: 'running', kind: null, at: NOW, text: '' }, over);

test('transcript: applyTranscript records the verdict, null clears it', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'ready' }));
  assert.strictEqual(d.trState.status, 'ready');
  D.applyTranscript(d, null);
  assert.strictEqual(d.trState, null);
});

test('transcript: without hooks the file decides, not the screen', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'running' }));
  // The screen is quiet and byte-silent — the old scraper would have said «готов».
  assert.strictEqual(D.tickStatus(d, NOW, QUIET).status, 'running');
});

test('transcript: a quiet turn that ended with a question → ждёт + question', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question', text: 'Сейчас от тебя: путь' }));
  const eff = D.tickStatus(d, NOW, QUIET);          // nothing on screen anymore
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'question');
});

test('transcript: a live prompt box still wins — the file cannot see dialogs', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'running' })); // open tool_use == waiting for Yes
  const eff = D.tickStatus(d, NOW, PERMISSION);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
});

test('transcript: «работает» releases the latch at once (a stale marker cannot pin it)', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question' }));
  assert.strictEqual(D.tickStatus(d, NOW, ASK).status, 'waiting');
  assert.strictEqual(d.waitLatched, true);
  // A tool_use was written after the question => work resumed, even though the
  // «Сейчас от тебя» line is still sitting on screen.
  D.applyTranscript(d, tr({ status: 'running' }));
  const eff = D.tickStatus(d, NOW + 300, ASK);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(d.waitLatched, false);
});

test('transcript: a stale screen phrase does not hold «ждёт» once the file says ready', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question' }));
  D.tickStatus(d, NOW, ASK);                        // latched
  D.applyTranscript(d, tr({ status: 'ready' }));    // answered, turn ended quietly
  // The phrase itself no longer votes, so the release debounce starts ticking even
  // though the line is still on screen — and then we're ready, not «ждёт» forever.
  assert.strictEqual(D.tickStatus(d, NOW + 300, ASK).status, 'waiting', 'debounce still runs');
  assert.strictEqual(D.tickStatus(d, NOW + 300 + D.LATCH_RELEASE_MS + 1, ASK).status, 'ready');
});

test('arbitrate: a hook permission is not cancelled by the transcript of that moment', () => {
  const d = mkD();
  D.applyHook(d, 'perm', NOW);
  D.applyTranscript(d, tr({ status: 'running', at: NOW })); // same instant, open tool_use
  const eff = D.tickStatus(d, NOW, QUIET);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
});

test('arbitrate: a newer transcript entry beats an older hook signal', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);                              // Stop: turn ended
  D.applyTranscript(d, tr({ status: 'running', at: NOW + 500 })); // then a tool started
  assert.strictEqual(D.tickStatus(d, NOW + 600, QUIET).status, 'running');
});

test('arbitrate: an older transcript entry loses to a newer hook signal', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'running', at: NOW }));
  D.applyHook(d, 'idle', NOW + 500);                        // Stop came after
  assert.strictEqual(D.tickStatus(d, NOW + 600, QUIET).status, 'ready');
});

test('arbitrate: with a transcript bound, the screen phrase no longer upgrades ready', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW + 500);
  D.applyTranscript(d, tr({ status: 'ready', at: NOW }));    // the file saw no question
  // The line on screen is scrollback from an earlier turn; both real channels say ready.
  assert.strictEqual(D.tickStatus(d, NOW + 600, ASK).status, 'ready');
});

// --- замолчавшее «работает» от хука ---------------------------------------------
// «Работает» у хука не стареет: пришёл busy — держится до следующего маркера. Оборвался
// канал посреди хода — вкладка оранжевая навсегда. См. hookRunStuck.

test('arbitrate: «работает» от оборвавшегося хука снимается чистым экраном', () => {
  const d = mkD();
  D.applyHook(d, 'busy', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + 1000, QUIET).status, 'running', 'свежему верим');
  assert.strictEqual(D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, QUIET).status, 'ready');
});

test('arbitrate: спиннер на экране держит «работает» сколько угодно', () => {
  const d = mkD();
  D.applyHook(d, 'busy', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + D.HOOK_STALE_MS * 10, SPINNER).status, 'running');
});

test('arbitrate: свежие байты держат «работает» — агент печатает прямо сейчас', () => {
  const d = mkD({ lastDataAt: NOW + D.HOOK_STALE_MS });
  D.applyHook(d, 'busy', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, QUIET).status, 'running');
});

test('arbitrate: «работает в фоне» экраном не отменяется — так сказал сам агент', () => {
  const d = mkD();
  D.applyHook(d, 'bgw', NOW);
  const eff = D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, QUIET);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(eff.detail, D.BG_DETAIL);
});

test('arbitrate: отлистанному экрану снимать «работает» нельзя', () => {
  const d = mkD({ scrolledBack: true });
  D.applyHook(d, 'busy', NOW);
  assert.strictEqual(D.tickStatus(d, NOW + D.HOOK_STALE_MS + 1, QUIET).status, 'running');
});

// --- замолчавшее «работает» из стенограммы --------------------------------------
// Файл, в который перестали писать на «инструмент пошёл», держал вкладку оранжевой вечно:
// перечитывать нечего, а экран в этой ветке не спрашивают. Так выглядит вкладка, привязанная
// к чужому (или брошенному) разговору. См. trRunStale.

const STALE = D.TR_RUN_STALE_MS + 1;

test('transcript: «работает» из файла, в который давно не писали, больше не голосует', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'running', at: NOW }));
  assert.strictEqual(D.tickStatus(d, NOW + 1000, QUIET).status, 'running', 'свежему верим');
  // Экран чист: спиннера нет, рамки нет, зова нет — значит вкладка свободна.
  assert.strictEqual(D.tickStatus(d, NOW + STALE, QUIET).status, 'ready');
});

test('transcript: долгий инструмент остаётся «работает» — по спиннеру на экране', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'running', at: NOW }));
  const eff = D.tickStatus(d, NOW + STALE, SPINNER);
  assert.strictEqual(eff.status, 'running', 'голос потерял файл, а не вкладка');
});

test('transcript: протухает только «работает» — вопрос живёт сколько угодно', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question', at: NOW }));
  const eff = D.tickStatus(d, NOW + STALE, QUIET);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'question');
});

test('arbitrate: протухшее «работает» из файла не перебивает «готов» от хука', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  // Запись в файле СВЕЖЕЕ сигнала хука по времени, но с тех пор прошёл час: по одной
  // свежести она выигрывала спор и красила законченную вкладку оранжевым.
  D.applyTranscript(d, tr({ status: 'running', at: NOW + 500 }));
  assert.strictEqual(D.tickStatus(d, NOW + 500 + STALE, QUIET).status, 'ready');
});

// --- что человек сделал на клавиатуре -----------------------------------------
// По этим байтам мост решает, вернулся ли человек за компьютер, то есть перестала ли вкладка
// отвечать в телегу. Живая беда: Клод умеет включать отчёты о мыши, и КЛИК в терминале уходил
// в сессию как последовательность — режим снимался, человек ничего не отправлял, а ответ на
// свой же вопрос с телефона больше не получал. Поэтому «вернулся» = напечатал И отправил.

test('печать — это печать, Enter — это отправка', () => {
  assert.deepStrictEqual(D.keyboardEvent('п'), { typed: true, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\r'), { typed: false, submit: true });
  assert.deepStrictEqual(D.keyboardEvent('да\r'), { typed: true, submit: true });
  assert.deepStrictEqual(D.keyboardEvent(''), { typed: false, submit: false });
});

test('клик мышью не считается печатью — ни в новом формате, ни в старом', () => {
  // SGR (?1006): ESC [ < кнопка ; x ; y M — цифры и «M» не должны сойти за набранный текст.
  assert.deepStrictEqual(D.keyboardEvent('\x1b[<0;12;5M'), { typed: false, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x1b[<0;12;5m'), { typed: false, submit: false });
  // Старый формат (?1000): ESC [ M и ТРИ сырых байта координат. Байты печатные, и если их не
  // проглотить, клик читается как набранный текст — ровно этот случай и ломал мост.
  assert.deepStrictEqual(D.keyboardEvent('\x1b[M !!'), { typed: false, submit: false });
  // Два клика подряд одним куском.
  assert.deepStrictEqual(D.keyboardEvent('\x1b[M !!\x1b[M#$%'), { typed: false, submit: false });
});

test('стрелки, функциональные клавиши и Alt тоже не печать', () => {
  assert.deepStrictEqual(D.keyboardEvent('\x1b[A'), { typed: false, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x1b[1;5D'), { typed: false, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x1bOP'), { typed: false, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x1bb'), { typed: false, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x1b'), { typed: false, submit: false });
});

test('Backspace — правка, а не текст: пустой Enter после него сообщением не станет', () => {
  assert.deepStrictEqual(D.keyboardEvent('\x7f'), { typed: false, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x7f\x7f\r'), { typed: false, submit: true });
});

test('текст после последовательности всё-таки видно', () => {
  // Иначе «стрелка вверх, поправил, отправил» перестало бы считаться своим сообщением.
  assert.deepStrictEqual(D.keyboardEvent('\x1b[Aда'), { typed: true, submit: false });
  assert.deepStrictEqual(D.keyboardEvent('\x1b[M !!нет\r'), { typed: true, submit: true });
});

// --- «ничего, жду замер стенда»: занята, но не зовёт ----------------------------
// Третий исход конца хода. До него вкладка с живой фоновой задачей была зелёной, то есть
// выглядела свободной — а давать ей работу рано: фон досчитает и разбудит агента сам.

const BG = 'Сейчас от тебя: ничего, жду замер стенда';
const DONE_WAIT = 'Сейчас от тебя: ничего, жди результата';

test('экран: фраза «жду …» = работает в фоне, а не «готов»', () => {
  const raw = D.decide(mkD(), NOW, BG);
  assert.strictEqual(raw.status, 'running');
  assert.strictEqual(raw.bg, true);
  assert.strictEqual(raw.detail, D.BG_DETAIL);
});

test('экран: повелительное «жди результата» — по-прежнему «готов»', () => {
  assert.strictEqual(D.decide(mkD(), NOW, DONE_WAIT).status, 'ready');
});

test('экран: живой запрос сильнее фразы про фон', () => {
  // Разрешение висит на экране под отчётом — отвечать всё-таки надо человеку.
  assert.strictEqual(D.decide(mkD(), NOW, BG + '\n' + PERMISSION).status, 'waiting');
});

test('стенограмма: bg доезжает до статуса вкладки', () => {
  const d = mkD();
  D.applyTranscript(d, { status: 'running', kind: null, at: NOW, text: BG, bg: true });
  const eff = D.tickStatus(d, NOW, BG);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(eff.bg, true);
  assert.strictEqual(eff.detail, D.BG_DETAIL);
});

test('хук: токен bgw — это «работает», с пометкой фона', () => {
  const d = mkD();
  assert.strictEqual(D.applyHook(d, 'bgw', NOW), true);
  const eff = D.tickStatus(d, NOW, BG);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(eff.bg, true);
});

test('хук «готов» + фраза про фон на экране: экран поднимает до «работает»', () => {
  // Вкладка, поднятая до обновления скрипта хука, шлёт обычный idle. Экран — единственный,
  // кто видит фразу, и апгрейд из «готов» ему разрешён (как и для зова прозой).
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  const eff = D.tickStatus(d, NOW, BG);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(eff.bg, true);
});

test('хук «готов» + «жди результата» на экране остаётся «готов»', () => {
  const d = mkD();
  D.applyHook(d, 'idle', NOW);
  assert.strictEqual(D.tickStatus(d, NOW, DONE_WAIT).status, 'ready');
});

// Живьём это выглядело так: агент пишет фразу исправно, вкладка становится оранжевой — и
// через минуту сама зеленеет. Минута — срок напоминания idle_prompt: строка ввода у фоновой
// вкладки и правда пустует. Напоминание не сообщает ничего нового ни про фон, ни про рамку.
test('хук: напоминание про пустую строку ввода не гасит фон', () => {
  for (const nudge of ['lull', 'nag']) {
    const d = mkD();
    D.applyHook(d, 'bgw', NOW);
    D.applyHook(d, nudge, NOW + 60_000);
    const eff = D.tickStatus(d, NOW + 60_000, BG);
    assert.strictEqual(eff.status, 'running', `${nudge}: вкладка занята`);
    assert.strictEqual(eff.bg, true, `${nudge}: и занята именно фоном`);
    assert.strictEqual(d.hookState.at, NOW + 60_000, `${nudge}: подтверждение свежее сигнала`);
  }
  // А настоящее событие фон снимает: агента разбудил фон, он заговорил и кончил ход зовом.
  const d = mkD();
  D.applyHook(d, 'bgw', NOW);
  D.applyHook(d, 'ask', NOW + 60_000);
  assert.strictEqual(D.tickStatus(d, NOW + 60_000, BG).status, 'waiting');
});

test('хук «готов» + фон в стенограмме: отметка про фон не теряется', () => {
  // Сигнал хука всегда свежее последней записи файла, поэтому по свежести спор решался в
  // пользу зелёного — хотя оба канала согласны, что ход кончился, и расходятся только в том,
  // почему. Так зеленела вкладка со старым скриптом хука (обычный idle вместо bgw).
  const d = mkD();
  D.applyTranscript(d, { status: 'running', kind: null, at: NOW, text: BG, bg: true });
  D.applyHook(d, 'idle', NOW + 1000);
  const eff = D.tickStatus(d, NOW + 1000, BG);
  assert.strictEqual(eff.status, 'running');
  assert.strictEqual(eff.bg, true);
  assert.strictEqual(eff.detail, D.BG_DETAIL);
});

test('хук «готов» + вопрос в стенограмме: вкладка ждёт, а не «работает в фоне»', () => {
  // Та же дырка, что и с фоном выше, и цена ошибки больше: у вкладки открыт вопрос, а
  // подагент внутри ещё ходит — и «готов» поднимался до фона (subWorking), то есть вкладка
  // с вопросом красилась «занята, не подходи».
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question', at: NOW }));
  D.applyHook(d, 'idle', NOW + 1000);
  D.applyHook(d, 'sub', NOW + 1000);              // подагент работает
  const eff = D.tickStatus(d, NOW + 1000, QUIET); // строка зова уже уехала с экрана
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'question');
});

test('хук «готов» + вопрос в стенограмме: рамка на экране доезжает как рамка', () => {
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question', at: NOW }));
  D.applyHook(d, 'idle', NOW + 1000);
  const eff = D.tickStatus(d, NOW + 1000, PERMISSION);
  assert.strictEqual(eff.status, 'waiting');
  assert.strictEqual(eff.kind, 'permission');
  assert.strictEqual(eff.box, true);
});

test('хук «работает» новее вопроса в стенограмме: агент снова работает', () => {
  // Обратная сторона: вопрос в файле старый, а хук говорит, что ход уже пошёл.
  const d = mkD();
  D.applyTranscript(d, tr({ status: 'waiting', kind: 'question', at: NOW }));
  D.applyHook(d, 'busy', NOW + 1000);
  assert.strictEqual(D.tickStatus(d, NOW + 1000, QUIET).status, 'running');
});

test('хук «готов» + законченный ход в стенограмме: по-прежнему «готов»', () => {
  // Обратная сторона: файл говорит «ход закончен», и оранжевого тут быть не должно —
  // даже если фраза про фон висит на экране с прошлого хода.
  const d = mkD();
  D.applyTranscript(d, { status: 'ready', kind: null, at: NOW, text: 'Готово.', bg: false });
  D.applyHook(d, 'idle', NOW + 1000);
  assert.strictEqual(D.tickStatus(d, NOW + 1000, BG).status, 'ready');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' detector tests passed');
