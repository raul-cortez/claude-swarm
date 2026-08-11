'use strict';
// Parse the invisible status markers our Claude hooks print into the pty. A hook
// returns { terminalSequence } and Claude Code emits it as an OSC 777 sequence;
// xterm (real and headless) consumes it — the user never sees it — and we sniff it
// out of the raw pty chunk here. Kept pure so it's unit-testable in plain node.
//
// Marker format (see hooks/swarm-signal.mjs):
//   ESC ] 777 ; notify ; swarm ; <token> ; <sessionId> ; <transcriptPath> BEL
// It's a valid OSC 777 «notify» (title = "swarm") so Claude Code's terminalSequence
// allowlist passes it; xterm doesn't implement 777 and just consumes it, so nothing
// shows. token ∈ busy | idle | perm | ask | box | nag | lull | bgw — the hook normalises events to
// these; their meaning (→ status/kind) lives in detector.js. sessionId is optional
// and only a cross-check: routing is by pty, since each agent has its own.
//
// transcriptPath — АДРЕС РАЗГОВОРА, названный самим Клодом. Он нужен потому, что вычислять
// его было нельзя: приложение складывало его как ~/.claude/projects/<слаг>/<id>.jsonl, а
// вкладка, запущенная с другим CLAUDE_CONFIG_DIR (у человека это алиас `claude-my`), пишет
// разговор в ДРУГОЙ конфиг. Файл не находился никогда, и с такой вкладки в телегу уезжал
// текст, соскобленный с картинки терминала, — статуслайн, ветка, обрывок команды. Здесь он
// идёт последним полем и режется по ПЕРВОЙ точке с запятой, чтобы точка с запятой внутри
// пути (бывает) не ломала разбор.
//
// Terminated by BEL (\x07) or ST (ESC \). Not anchored — a chunk may hold several.
const MARKER_RE = /\x1b\]777;notify;swarm;([a-z]+)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
// Хвост, который переносим в следующий кусок, чтобы маркер, разрезанный по границе чтения,
// собрался. Раньше хватало 128 байт: в маркере были только слово-токен и uuid. С адресом
// стенограммы маркер стал длиной пути — а недособранный маркер это потерянный статус.
const CARRY_CAP = 640;

// Extract every complete marker from `buf` (a chunk, optionally prefixed with the
// leftover tail from last time). Returns the signals plus the `rest` to carry: the
// text after the last complete marker, capped so non-marker output can't grow
// unbounded while still letting a marker cut at a chunk boundary finish assembling.
function extractHookSignals(buf) {
  const text = String(buf == null ? '' : buf);
  const signals = [];
  let lastEnd = 0;
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const extra = m[2] || '';
    const cut = extra.indexOf(';');
    signals.push({
      token: m[1],
      sessionId: (cut < 0 ? extra : extra.slice(0, cut)) || null,
      transcript: (cut < 0 ? '' : extra.slice(cut + 1)) || null,
    });
    lastEnd = MARKER_RE.lastIndex;
  }
  let rest = text.slice(lastEnd);
  if (rest.length > CARRY_CAP) rest = rest.slice(-CARRY_CAP);
  return { signals, rest };
}

module.exports = { extractHookSignals };
