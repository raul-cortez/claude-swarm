'use strict';
// The status state machine, kept out of main.js so it's unit-testable in plain
// node (like screen.js / git.js / updater-core.js). main.js owns the headless
// terminal, the tick and IPC; this module owns the "what status is this?" decision
// and the «ждёт» latch. Everything here is pure w.r.t. its arguments — `decide`
// reads `d.lastDataAt`, `applyLatch` reads/mutates the latch fields on `d`, and
// both take the current screen `snap` as a string.

const { inferWaitingKind, asksForInput, waitsForWork, askFingerprint } = require('./screen');

// --- что человек сделал на клавиатуре -----------------------------------------
// Байты из рендерера — это НЕ только печать. Там же приходят стрелки, отчёты мыши и прочие
// escape-последовательности, а мост по этим байтам решает важное: вернулся ли человек за
// компьютер, то есть перестала ли вкладка отвечать в телегу.
//
// Раньше «вернулся» значило «пришёл любой непустой байт», и это было слишком широко. Клод
// умеет включать отчёты о мыши, и тогда КЛИК в терминале — хоть чтобы навести фокус, хоть
// чтобы выделить текст, — уходил в сессию как последовательность и молча выключал отправку в
// телегу. Человек ничего никому не отправлял, а ответ на свой же вопрос с телефона больше не
// получал. Показательно, что отчёты о фокусе рендерер по этой же причине уже вырезает.
//
// Правильная граница — ОТПРАВКА сообщения: напечатал что-то и нажал Enter. Поэтому здесь два
// ответа, и оба нужны, потому что печать и Enter приходят разными событиями:
//   typed  — были ли настоящие печатные символы (последовательности не считаются);
//   submit — был ли перевод строки.
// Enter без печати сообщением не является: он лишь отправляет то, что уже лежит в поле ввода,
// а это обычно ровно текст из телеги, которому не хватило отправки. Снимать режим на нём
// значило бы «помог мосту руками и этим отрезал себе ответ».
const ESC = '\x1b';

// Индекс последнего байта escape-последовательности, начинающейся на i.
function seqEnd(s, i) {
  const next = s[i + 1];
  if (next === '[') {
    // Мышь в старом формате: ESC [ M и ТРИ сырых байта координат следом. Байты бывают
    // печатными, так что не проглотить их — значит принять клик за печать.
    if (s[i + 2] === 'M') return i + 5;
    for (let j = i + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j;       // финальный байт CSI (в т.ч. M/m у SGR-мыши)
    }
    return s.length;
  }
  if (next === 'O') return i + 2;                 // SS3: функциональные клавиши
  return i + 1;                                   // Alt+клавиша и одиночный ESC
}

function keyboardEvent(data) {
  const s = String(data == null ? '' : data);
  let typed = false;
  let submit = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ESC) { i = seqEnd(s, i); continue; }
    if (ch === '\r' || ch === '\n') { submit = true; continue; }
    if (ch >= ' ' && ch !== '\x7f') typed = true;  // печатное; Backspace/DEL — правка, не текст
  }
  return { typed, submit };
}

const ACTIVE_MS = 1200;      // bytes seen this recently => the agent is working
// Once «ждёт» is latched we stop believing transient running/ready reads (repaint
// bursts, half-drawn prompts). We only release when the agent VISIBLY resumed —
// its spinner is back — or the wait chrome has been gone this long with no work
// (a just-answered trivial prompt). Debounce > a repaint blip so it can't flicker.
const LATCH_RELEASE_MS = 900;
// You pressed Enter in a latched-«ждёт» session (main sets `answeredAt`): that's an
// ANSWER, not «work resumed» — a multi-question quiz answers one question and paints
// the next, so Enter alone must never release the latch. It only makes us quicker to
// believe the OTHER evidence: within this window a live prompt box still wins, but a
// stale on-screen «Сейчас от тебя» no longer outvotes fresh output, and the
// release debounce drops to zero. Wide enough to cover the agent's first repaint.
const ANSWER_HINT_MS = 3000;

// Waiting on me: a permission / confirm prompt sits on screen.
// Selection cursor before "1. Yes / 2. No": Claude Code often paints ❯ (heavy
// angle), but Cursor / some terminals use an arrow (→ ▸ ▶) or plain ">".
// Without those glyphs the tab never flips to «ждёт ответа».
const RE_WAIT = /Esc to cancel|Do you want|Enter to confirm|[❯>→➜▸►▶]\s*\d+\.\s|No, and tell Claude/i;
// Strong subset — prompt UI chrome that never appears in normal streamed output
// (numbered options, "Esc to cancel"). We trust these EVERY tick, even while bytes
// are still flowing, so a prompt is caught the instant it renders. The full RE_WAIT
// (with the looser "Do you want") stays gated behind the quiet window to avoid
// matching that phrase mid-sentence in streamed prose.
const RE_WAIT_NOW = /Esc to cancel|Enter to confirm|[❯>→➜▸►▶]\s*\d+\.\s|No, and tell Claude/i;

// Working but momentarily quiet. While Claude thinks or runs a tool it can go
// >ACTIVE_MS without emitting a byte (model call with no repaint, a slow tool),
// yet it is NOT done — its spinner line stays on screen with a LIVE elapsed
// timer: "✶ Cooking… (12s · thinking)" / "…(3s · esc to interrupt)". Idle looks
// different: a past-tense summary "Worked for 12s" (no parens) or the bare input
// box — neither carries a running "(Ns" timer. The spinner GLYPH animates through
// many chars (✶ ✽ ✻ …), so we key off the ellipsis-then-timer text, not the glyph.
// Without this, decide() falls through to "ready" on every silent work pause and
// flashes «готов» — worse, the renderer paints ready instantly but buffers the
// return to running by ~2.5s, so each false idle lingers.
const RE_RUNNING = /(?:…|\.\.\.)\s*\(\d+\s*[smh]\b|\besc to interrupt\b/i;

// Waiting on me WITHOUT prompt chrome: the agent asked in prose and stopped. The
// task skills close such a message with «Сейчас от тебя: …» (see fastio CLAUDE.md),
// so that phrase — not a glyph — is the marker. screen.js's asksForInput owns it
// (and excludes the «ничего, жди» non-requests). Checked LAST, only on the path
// that would otherwise return «готов»: a stale marker must never outvote the spinner.

// Зовут ли меня прозой ПО-НОВОМУ — то есть зовом, который я ещё не закрывал.
//
// Строка «Сейчас от тебя: …» — это переписка, а не живой диалог: ответив, ты уходишь дальше,
// а строка остаётся на экране и продолжает читаться как просьба. Из-за этого вкладка через
// пару секунд после ответа снова поднимала «ждёт ответа» — а если ты успел переключиться,
// то это уже фоновая вкладка, и она честно выкидывала уведомление о зове, на который ты
// только что ответил (с твоим же ответом в тексте — см. USER_LINE_RE в screen.js).
//
// Признак «закрыл» — отпечаток зова, снятый в момент твоего Enter (main ставит d.askAnswered
// там же, где answeredAt). Пока на экране ровно тот же зов, он не считается; изменился или
// добавился новый — считается снова. Когда зов уходит с экрана совсем, память об ответе
// стирается: следующий зов может оказаться слово в слово таким же, и молчать про него нельзя.
function asksNow(d, snap) {
  if (!asksForInput(snap)) {
    if (d) d.askAnswered = '';
    return false;
  }
  if (!d || !d.askAnswered) return true;
  return askFingerprint(snap) !== d.askAnswered;
}

// `box` — есть ли на экране РАМКА, а не только «вкладка ждёт человека». Зовущий прозой агент
// оставляет строку ввода свободной, открытая рамка съедает Enter выбором варианта, и различает
// их только вызывающий: сюда приходят оба случая (см. decide).
function mkWaiting(snap, box) {
  return { status: 'waiting', detail: 'ждёт ответа', kind: inferWaitingKind(snap), box: !!box };
}

// --- ход кончился, а работа нет ------------------------------------------------
// Третье состояние конца хода, и до него вкладка была зелёной. Агент запустил фоновую
// задачу (замер, сборка, фоновый сабагент), закрыл ход и сказал об этом словами: «Сейчас
// от тебя: ничего, жду замер стенда». Все три канала честно читают такой ход как
// законченный — Stop пришёл, в стенограмме последнее слово за агентом, спиннера на экране
// нет, — и вкладка красилась «готов», то есть «свободна, дай ей задачу». Задачу давать
// рано: фон досчитает и разбудит агента сам.
//
// Отличить это от настоящего «готов» может только сам агент: снаружи «я запустил и жду» и
// «я всё сделал» выглядят одинаково. Поэтому признак — его собственная фраза (waitsForWork,
// см. WAIT_TAIL в ask-phrases.js), а не подсчёт живых процессов: агент один знает,
// собирается ли он возвращаться. Заодно это решает вечный `npm run dev` — под него агент
// пишет «ничего», потому что ждать ему нечего.
//
// Статус — «работает»: от человека ничего не нужно, вкладка занята. `bg` несёт это дальше
// (мосту и подписи), потому что «работает в фоне» и «работает» — разные новости.
const BG_DETAIL = 'работает в фоне';

function mkBackground() {
  return { status: 'running', detail: BG_DETAIL, bg: true };
}

// The raw per-tick read from the screen (no latch). `snap` is the bottom rows of
// the emulator; `d.lastDataAt` is when bytes last flowed.
function decide(d, now, snap) {
  // A confirm/permission prompt on screen means "waiting on me" regardless of byte
  // activity — check it EVERY tick, not only when the stream goes quiet. Otherwise a
  // background tab keeps showing "работает" while the prompt renders in bursts, and
  // only flips to "ждёт ответа" once the stream finally falls silent for ACTIVE_MS
  // (a long, ragged lag). Uses the strong prompt-chrome markers, safe mid-stream.
  if (RE_WAIT_NOW.test(snap)) {
    return mkWaiting(snap, true);
  }
  // Active output => working. Only peek for the looser prompt once it goes quiet.
  if (now - d.lastDataAt < ACTIVE_MS) {
    return { status: 'running', detail: 'работает' };
  }
  if (RE_WAIT.test(snap)) {
    return mkWaiting(snap, true);
  }
  // Quiet, but the spinner (with its live timer) is still on screen => the agent
  // is thinking / running a tool, not idle. Keep it "работает" instead of the
  // false "готов" flash. See RE_RUNNING above for why we match the timer text.
  if (RE_RUNNING.test(snap)) {
    return { status: 'running', detail: 'работает' };
  }
  // Quiet, no spinner, no prompt box — but the agent signed off asking for input.
  // asksNow excludes «Сейчас от тебя: ничего, жди …» (not a real request) and the call
  // you already answered (its line just stays on screen).
  // Рамки нет — есть строка на экране. Печатать в такую вкладку можно.
  if (asksNow(d, snap)) {
    return mkWaiting(snap, false);
  }
  // Не зовёт, но и не закончил: «ничего, жду замер стенда». Читаем ПОСЛЕДНЮЮ фразу на
  // экране (tailFrom в ask-phrases.js), поэтому строка прошлого хода сюда не попадает —
  // как только агент допишет «ничего», вкладка станет зелёной.
  if (waitsForWork(snap)) {
    return mkBackground();
  }

  return { status: 'ready', detail: 'готов' };
}

// --- transcript: Claude's own message log, the third channel -----------------
// transcript.js classifies ~/.claude/projects/**.jsonl: an open tool_use means a tool
// is running, a tool_result means the model is thinking, a quiet assistant message
// means the turn ended — and the call phrase in that message means it ended with a
// QUESTION. All of it from structured events, so it doesn't flicker with repaints and
// doesn't lose the question when it scrolls off the visible rows.
//
// What the file CANNOT see is UI state: while a permission dialog waits for your Yes,
// the last entry is an open tool_use — exactly what a long-running tool looks like.
// So a hook's `perm`/`ask` and a live prompt box on screen both outrank it.
function applyTranscript(d, v) {
  d.trState = v
    ? { status: v.status, kind: v.kind || null, at: v.at || 0, text: v.text || '', bg: !!v.bg }
    : null;
}

// Рамки здесь нет и быть не может: файл видит СОБЫТИЯ, а рамка — состояние экрана. Вкладку,
// которая ждёт по стенограмме, распознаём как зов прозой, и это верно — открытую рамку в этом
// же тике добавит либо хук, либо скрёб (см. decideFromTranscript).
function fromTranscript(tr) {
  const kind = tr.status === 'waiting' ? (tr.kind || 'question') : null;
  const out = { status: tr.status, detail: detailFor(tr.status, tr.bg), kind, from: 'transcript' };
  if (tr.bg) out.bg = true;
  return out;
}

// The per-tick read for a session with a bound transcript and no hooks: the file
// decides, except for the one thing it can't see — a live prompt box. That box is
// also the only place «разрешение» can come from when hooks are off.
function decideFromTranscript(tr, snap) {
  if (hasPromptBox(snap)) return mkWaiting(snap, true);
  return fromTranscript(tr);
}

// A LIVE prompt box on screen (permission / options list). Claude Code erases it the
// moment you answer, so its presence is current evidence — unlike the prose marker.
function hasPromptBox(snap) {
  return RE_WAIT.test(snap) || RE_WAIT_NOW.test(snap);
}

// Any on-screen evidence that we're still waiting on the user. When NONE of these
// match, the prompt/question is gone from the visible screen.
function hasWaitChrome(snap) {
  return hasPromptBox(snap) || asksForInput(snap);
}

// Did the user just press Enter into this session? See ANSWER_HINT_MS.
function answeredRecently(d, now) {
  return !!d.answeredAt && now - d.answeredAt < ANSWER_HINT_MS;
}

// The latch: `raw` is decide()'s per-tick read; this holds «ждёт» through screen
// noise and releases only when the agent visibly resumed. NOT released by the user
// typing — a keystroke into an answer field isn't «resumed work». Returns the
// effective { status, detail, kind } and mutates the latch fields on `d`
// (waitLatched, waitKind, chromeGoneSince).
function applyLatch(d, now, snap, raw) {
  if (d.waitLatched) {
    // A live prompt box beats everything, including a spinner left over in the rows
    // above it — that's the quiz case: Enter answered question 1 and question 2 is
    // already painted, so we're still «ждёт».
    if (hasPromptBox(snap)) {
      // Still waiting on screen. Kind can only sharpen (question → permission),
      // never soften, so the label doesn't flip-flop.
      d.chromeGoneSince = 0;
      if (raw.status === 'waiting' && raw.kind === 'permission') d.waitKind = 'permission';
      // Рамка НА ЭКРАНЕ — этого достаточно, что бы ни говорил источник вердикта: печатать
      // в неё нельзя. Как и kind, признак только заостряется: зов, поверх которого нарисовали
      // рамку, — это уже рамка. Увидели — верим сразу, без выдержки (см. boxGone ниже).
      d.waitBox = true;
      d.boxGoneSince = 0;
      return { status: 'waiting', detail: 'ждёт ответа', kind: d.waitKind, box: true };
    }
    // Рамки на экране НЕТ — но это ровно тот тик, на котором скрёб мог и промахнуться: рамку
    // уносит за край, ломает чужая отрисовка, а мигание перерисовки даёт пустой кадр. Ниже
    // (зов прозой) вкладка объявляется свободной для печати, и одного такого кадра хватало,
    // чтобы разрешить двадцать строк просьбы и Enter в живую коробку.
    //
    // Поэтому исчезновению верим с той же выдержкой, что и уходу мебели вообще, а появлению —
    // сразу. Заострять признак навсегда было нельзя: тогда вкладка, у которой рамку закрыли, а
    // ход кончился зовом, оставалась бы «с рамкой» до самого конца ожидания — то есть до
    // бесконечности, ведь зов её и держит.
    if (d.waitBox) {
      if (!d.boxGoneSince) d.boxGoneSince = now;
      if (now - d.boxGoneSince >= LATCH_RELEASE_MS) { d.waitBox = false; d.boxGoneSince = 0; }
    }
    // No box. The agent visibly resumed => release, even though a «Сейчас от тебя»
    // line may still sit in the rows below (it's scrollback text, not live UI, and
    // it lingers for seconds after you answer — it used to pin the tab to «ждёт»
    // while the spinner was already turning). Evidence: the spinner, or fresh output
    // right after you pressed Enter.
    const release = () => {
      d.waitLatched = false; d.waitKind = null; d.waitBox = false; d.boxGoneSince = 0; d.chromeGoneSince = 0;
    };
    // The transcript saying «работает» is the strongest release there is: a new
    // tool_use / tool_result was WRITTEN after the question, so work really resumed.
    // No debounce needed — this isn't a repaint, it's an event.
    if (RE_RUNNING.test(snap) || (raw.from === 'transcript' && raw.status === 'running')
        || (answeredRecently(d, now) && raw.status === 'running')) {
      release();
      return raw;
    }
    // A prose question with no sign of work: nothing has happened yet, keep «ждёт».
    // Skipped when a transcript drives this session — the file already told us whether
    // the turn ended with a question, and a line left on screen is not evidence.
    // asksNow, not asksForInput: the line you just answered pinned the tab to «ждёт»
    // until the agent's spinner finally showed up.
    if (raw.from !== 'transcript' && asksNow(d, snap)) {
      d.chromeGoneSince = 0;
      // Держит нас строка зова, а в неё печатать можно — но только если рамка ушла по-настоящему,
      // а не пропала на один кадр. Решено это выше, выдержкой.
      return { status: 'waiting', detail: 'ждёт ответа', kind: d.waitKind, box: !!d.waitBox };
    }
    // Chrome gone but no spinner: a repaint blip, or a trivial prompt just answered
    // and the turn ended. Debounce — release only after it's been gone a while, so a
    // one-tick repaint can't flicker us out of «ждёт». Right after YOUR Enter there's
    // nothing to protect against: the screen is clean because you answered.
    if (!d.chromeGoneSince) d.chromeGoneSince = now;
    if (now - d.chromeGoneSince >= (answeredRecently(d, now) ? 0 : LATCH_RELEASE_MS)) {
      release();
      return raw;
    }
    // Мебель пропала на один тик — по ней и судим: держим последнее, что знали, включая рамку.
    // Считать её тут исчезнувшей значило бы разрешать печать на каждом мигании перерисовки.
    return { status: 'waiting', detail: 'ждёт ответа', kind: d.waitKind, box: !!d.waitBox };
  }
  if (raw.status === 'waiting') {
    // A NEW prompt: forget the previous Enter, or its hint window would let a
    // one-tick repaint of this fresh prompt release the latch with no debounce.
    d.waitLatched = true; d.waitKind = raw.kind; d.waitBox = !!raw.box; d.chromeGoneSince = 0; d.answeredAt = 0;
  }
  return raw;
}

// --- hooks: the deterministic channel --------------------------------------
// A Claude hook prints a marker (parsed in osc.js) whose token we map to a status
// here — so the meaning lives in tested code, not in the installed hook script.
// Насколько старым должен стать последний сигнал хука, чтобы экрану позволили сказать
// «нет, агент работает». Не меньше пары секунд: сразу после Stop спиннера на экране уже
// нет, а вот перерисовка ещё идёт. Восемь — это заметно дольше любого промежутка между
// маркерами исправного канала (они приходят на каждом инструменте) и достаточно быстро,
// чтобы человек не успел решить, что вкладка врёт. См. arbitrate.
const HOOK_STALE_MS = 8000;

// `box` — рамка на экране, в которую уходит Enter: запрос разрешения и коробка с вариантами.
// Отдельно от статуса, потому что «ждёт» бывает и без рамки: агент кончил ход зовом прозой, и
// строка ввода при этом свободна. Снаружи (перезапуск, который печатает в живую вкладку) разница
// решающая, а по статусу и kind она неразличима — оба «ждёт: вопрос».
// `soft` — сигнал-НАПОМИНАНИЕ: Клод повторяет, что ввода всё нет. Нового он не сообщает ничего, в
// том числе про рамку, а приходит как раз тогда, когда она чаще всего и стоит: минуту без ответа
// рамка переживает легко, а ночью — и час. Поэтому напоминание не отменяет того, что мы уже знаем
// про открытую рамку (см. applyHook); на вкладке без рамки оно значит ровно то, что написано.
const HOOK_TOKEN = {
  busy: { status: 'running' },              // UserPromptSubmit / a normal tool starts
  idle: { status: 'ready' },                // Stop — the turn ended
  perm: { status: 'waiting', kind: 'permission', box: true }, // PermissionRequest
  box:  { status: 'waiting', kind: 'question', box: true },   // AskUserQuestion tool
  ask:  { status: 'waiting', kind: 'question' },    // Stop, а последним словом — зов к человеку
  nag:  { status: 'waiting', kind: 'question', soft: true },   // Notification agent_needs_input
  lull: { status: 'ready', soft: true },                       // Notification idle_prompt
  // Stop, но ход закончился словами «ничего, жду замер стенда»: от человека ничего, а
  // работа идёт. Отдельный токен, а не busy, чтобы подпись и мост знали, что это фон.
  bgw:  { status: 'running', bg: true },
};

// Record a hook signal on `d`. Once ANY signal has arrived, hooksActive flips on
// and this session trusts hooks over the screen (see tickStatus). Returns whether
// the token was known.
// Напоминание (`soft`) про рамку не знает НИЧЕГО: Клод шлёт его, когда человек долго не отвечает,
// то есть чаще всего при ОТКРЫТОЙ рамке — минуту без ответа она переживает легко, а ночью и час.
// Приняв его за «рамки нет», мы бы сами себе разрешили печать в живую коробку, и заодно понизили
// бы «разрешение» до «вопроса», выбив второй источник тоже.
//
// Поэтому пустое знание не затирает добытое: пока мы знаем про открытую рамку, напоминание её не
// отменяет — только освежает время сигнала, потому что подтверждение всё-таки свежее.
//
// А вот настоящие события отменяют, и это важно ровно так же. Рамка уходит не только ответом:
// запрос разрешения можно ОТКЛОНИТЬ, и тогда никакого PostToolUse не будет — агент просто
// заговорит и кончит ход. Держись знание за «пока не придёт busy», такая вкладка осталась бы «с
// рамкой» навсегда: перезапуск её больше не трогает, а мост отказывается принимать текст с
// телефона, предлагая закрыть диалог, которого нет.
// То же самое и с фоном, и живьём это была самая обидная поломка из всех: агент честно
// закрывал ход словами «ничего, жду замер», вкладка честно становилась оранжевой — а через
// минуту сама себя перекрашивала в зелёный. Минута — это ровно срок напоминания: строка
// ввода у фоновой вкладки и правда пустует, Клод присылает idle_prompt, а тот значил
// «готов». Между тем напоминание говорит РОВНО ТО ЖЕ, что уже сказал фон: человека не
// ждут. Новостей в нём нет, и стирать им знание нельзя — как и в случае рамки выше.
function keepsThroughNudge(was) {
  if (!was) return false;
  if (was.status === 'waiting' && was.box) return true;
  return was.status === 'running' && !!was.bg;
}

function applyHook(d, token, now) {
  const m = HOOK_TOKEN[token];
  if (!m) return false;
  d.hooksActive = true;
  const was = d.hookState;
  if (m.soft && keepsThroughNudge(was)) {
    d.hookState = { ...was, at: now };
    return true;
  }
  d.hookState = { status: m.status, kind: m.kind || null, bg: !!m.bg, box: !!m.box, at: now };
  return true;
}

function detailFor(status, bg) {
  if (status === 'running') return bg ? BG_DETAIL : 'работает';
  return status === 'waiting' ? 'ждёт ответа' : 'готов';
}

// Hooks are authoritative about the dialogs only they can see. Between hooks and the
// transcript the NEWER signal wins — a tool that started after Stop (transcript) or a
// Stop that came after the last message (hook) — with ties going to the hook, so an
// open permission can't be cancelled by the tool_use entry of that same moment.
// The screen may still add the one thing an unbound session can't get anywhere else:
// a prose question after the turn ended. It never overrides running / ready / perm.
function arbitrate(d, now, snap) {
  const hs = d.hookState || { status: 'ready', kind: null, at: 0 };
  const tr = d.trState;
  const trNewer = !!tr && tr.at > (hs.at || 0);
  if (hs.status === 'waiting' && !trNewer) {
    return { status: 'waiting', detail: 'ждёт ответа', kind: hs.kind || null, box: !!hs.box };
  }
  if (trNewer) return fromTranscript(tr);
  // Канал хуков ослеп, а агент работает. «Готов» держится на последнем услышанном сигнале
  // и сам по себе не стареет: пропал один маркер (сессия перезапущена без наших настроек,
  // хук упал, событие переименовали в новой версии Клода) — и вкладка остаётся зелёной,
  // пока агент ведёт с человеком разговор. Экран в этом случае знает правду, но в
  // hook-режиме его не слушают вовсе.
  //
  // Слушаем ровно одну его улику и только против «готов»: ЖИВОЙ спиннер с бегущим
  // таймером (RE_RUNNING). Он рисуется, пока ход идёт, и исчезает, как только тот кончился,
  // так что принять за него остаток прошлого хода нельзя. Три ограничения, чтобы эта
  // подстраховка не начала спорить с исправным каналом:
  //   • только из «готов» — «ждёт» (разрешение, вопрос) экран не отменяет, там хук видит
  //     то, чего на экране нет;
  //   • только когда последний сигнал уже несвежий: по живым хукам ход всё равно
  //     подтверждается маркером на каждом инструменте, и спорить не о чем;
  //   • только по живому экрану — отлистанный назад показывает прошлое (см. scrolledBack
  //     в main.js), и спиннер на нём может быть позавчерашним.
  if (hs.status === 'ready' && now - (hs.at || 0) > HOOK_STALE_MS
      && !d.scrolledBack && RE_RUNNING.test(snap)) {
    return { status: 'running', detail: 'работает' };
  }
  // Зов прозой: строка на экране, рамки нет — печатать в такую вкладку можно.
  if (!tr && hs.status === 'ready' && asksNow(d, snap)) {
    return { status: 'waiting', detail: 'ждёт ответа', kind: 'question', box: false };
  }
  // Та же дырка, что и у зова прозой, только с другим ответом: ход закончился словами
  // «ничего, жду замер». Апгрейд только из «готов», как и всё остальное, что здесь могут
  // сказать каналы послабее.
  //
  // «Фон» — это ОТМЕТКА на конце хода, а не отдельный статус, и терять её в споре каналов
  // нельзя. Хук про фразу знает сам (токен bgw), но узнать может и не он: у вкладки,
  // поднятой до обновления скрипта, приходит обычный idle, а фразу видит стенограмма. Спор
  // при этом всегда решался в пользу зелёного — сигнал хука приходит по концу хода, то есть
  // ПОЗЖЕ последней записи в файле, и побеждал по свежести. Спорить тут, однако, не о чем:
  // оба канала согласны, что ход кончился, и расходятся только в том, почему.
  //
  // Стенограмма важнее экрана, когда она есть: `tr.bg` — это последняя запись файла прямо
  // сейчас (заговорил агент — признака нет), а строка на экране живёт и после того, как
  // фон досчитал. Без файла остаётся экран — он и держал этот случай до сих пор.
  if (hs.status === 'ready' && (tr ? tr.bg : waitsForWork(snap))) {
    return mkBackground();
  }
  const out = { status: hs.status, detail: detailFor(hs.status, hs.bg), kind: hs.status === 'waiting' ? hs.kind : null,
    box: hs.status === 'waiting' && !!hs.box };
  if (hs.bg && hs.status === 'running') out.bg = true;
  return out;
}

// The single entry point main's tick calls. Three channels, in order of how much they
// actually know: hooks (see the dialogs), the transcript (sees the events), the screen
// (sees pixels). The latch stays under the screen — and under the transcript, where it
// still guards the one screen read that survives: the live prompt box.
function tickStatus(d, now, snap) {
  if (d.hooksActive) return arbitrate(d, now, snap);
  if (d.trState) return applyLatch(d, now, snap, decideFromTranscript(d.trState, snap));
  return applyLatch(d, now, snap, decide(d, now, snap));
}

module.exports = {
  ACTIVE_MS, LATCH_RELEASE_MS, ANSWER_HINT_MS, HOOK_STALE_MS, BG_DETAIL,
  RE_WAIT, RE_WAIT_NOW, RE_RUNNING,
  decide, hasWaitChrome, hasPromptBox, asksNow, applyLatch, keyboardEvent,
  applyHook, applyTranscript, fromTranscript, decideFromTranscript, arbitrate, tickStatus,
};
