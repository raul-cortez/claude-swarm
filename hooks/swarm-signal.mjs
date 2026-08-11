#!/usr/bin/env node
'use strict';
// Claude Code hook for Swarm. Normalises the current event to a status
// token and emits it as an INVISIBLE OSC 777 marker in the session terminal; the
// app parses it out of the pty (see osc.js) for a deterministic status, no screen
// scraping. Opt-in — installed only when the user enables «Точный статус через
// хуки». Self-contained on purpose (no app imports): it's run as a standalone
// script by Claude Code, possibly from an unpacked resources dir.
//
// Contract: read the event JSON on stdin, print {"terminalSequence": "<OSC>"} on
// stdout and exit 0. It prints nothing else and never blocks or returns a decision,
// so it can't interfere with Claude's own prompt / permission flow.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

// --- the «agent is calling you» phrases --------------------------------------
// Compiled by the app (ask-phrases.js) and written next to this script as
// swarm-phrases.json, because the user can edit the phrase list in Settings. We only
// APPLY the two regexes — no phrase logic here, so there's nothing to drift. If the
// file is missing or broken we fall back to the shipped default (pinned by a test
// against ask-phrases.js DEFAULT_SOURCES).
const FALLBACK = {
  mark: '(?:Сейчас от тебя)',
  none: '(?:Сейчас от тебя)[\\s:.\\u2014*_`~-]*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\\s+(?:нужно|требуется|надо))',
  wait: '(?:Сейчас от тебя)[\\s:.,\\u2014*_`~-]*(?:ничего[\\s:.,\\u2014*_`~-]*)?(?:жду|ждём|ждем|дождусь|дожидаюсь|ожидаю)(?![а-яёА-ЯЁa-zA-Z])',
  marker: 'Сейчас от тебя',   // phrases[0], for the deny reason below
};

function loadMatcher(readJson) {
  let src = null;
  try { src = readJson(); } catch (_) { /* missing / unreadable → defaults */ }
  const mark = (src && typeof src.mark === 'string' && src.mark) || FALLBACK.mark;
  const none = (src && typeof src.none === 'string' && src.none) || FALLBACK.none;
  // Третий хвост появился позже двух других, и файл рядом со скриптом мог быть записан
  // прошлой версией приложения. Своя заглушка на каждый источник, а не общий откат:
  // потерять из-за отсутствующего `wait` пользовательские фразы в `mark` — значит
  // перестать узнавать зов вообще.
  const wait = (src && typeof src.wait === 'string' && src.wait) || FALLBACK.wait;
  // The plain first phrase, carried in the same file: we don't just MATCH the marker
  // here, we sometimes have to name it back to the agent (see denyReason).
  const first = src && Array.isArray(src.phrases) ? src.phrases[0] : null;
  const marker = (typeof first === 'string' && first.trim()) || FALLBACK.marker;
  try {
    return { mark: new RegExp(mark, 'i'), none: new RegExp(none, 'i'), wait: new RegExp(wait, 'i'), marker };
  } catch (_) {
    return {
      mark: new RegExp(FALLBACK.mark, 'i'),
      none: new RegExp(FALLBACK.none, 'i'),
      wait: new RegExp(FALLBACK.wait, 'i'),
      marker,
    };
  }
}

// Stop's `last_assistant_message` is not reliably a plain string: depending on the Claude
// Code version it's the text, an object `{ type, text }`, or the message's content blocks.
// String()ing an object yields "[object Object]", which silently never matches a phrase —
// so unwrap all three shapes instead of trusting one.
function messageText(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(messageText).filter(Boolean).join('\n');
  if (typeof m === 'object') {
    if (typeof m.text === 'string') return m.text;
    if (m.content != null) return messageText(m.content);
    if (m.message != null) return messageText(m.message);
  }
  return '';
}

// Чем кончился ход, по словам самого агента: 'ask' — зовёт человека, 'wait' — от человека
// ничего, но работа продолжается сама (запущена фоновая задача, она и разбудит), null —
// закончил. Разбираем хвост от ПОСЛЕДНЕЙ фразы: сообщение бывает длинным, и «ничего» из
// середины не должно отменять зов в конце (та же tailFrom в ask-phrases.js).
function closingKind(matcher, text) {
  const t = messageText(text);
  if (!matcher || !matcher.mark) return null;
  const re = new RegExp(matcher.mark.source, 'gi');
  let idx = -1;
  let m;
  while ((m = re.exec(t)) !== null) {
    idx = m.index;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (idx < 0) return null;
  const tail = t.slice(idx);
  if (matcher.wait && matcher.wait.test(tail)) return 'wait';
  if (matcher.none && matcher.none.test(tail)) return null;
  return 'ask';
}

// Did the agent's closing message actually ask for something?
function callsUser(matcher, text) {
  return closingKind(matcher, text) === 'ask';
}

// event JSON → one of: busy | idle | perm | ask | box | bgw (see detector.js HOOK_TOKEN). null
// => emit nothing (event we don't care about).
function tokenFor(p, matcher) {
  switch (p && p.hook_event_name) {
    case 'UserPromptSubmit': return 'busy';           // you sent a prompt → working
    case 'Stop':
      // The turn ended — but «done», «I asked you something and stopped» and «I'm
      // waiting on a background task» are the SAME event. The payload carries the
      // closing text, so decide from it: a call phrase makes this «ждёт», a first-person
      // «жду …» makes it «работает в фоне», and only the rest is «готов». This is the
      // signal that used to be scraped off the screen, where a stale line kept the tab
      // yellow for seconds.
      switch (matcher ? closingKind(matcher, p.last_assistant_message) : null) {
        case 'ask': return 'ask';
        case 'wait': return 'bgw';
        default: return 'idle';
      }
    case 'PermissionRequest': return 'perm';          // approval prompt → разрешение
    case 'Notification':
      if (p.notification_type === 'permission_prompt') return 'perm';
      if (p.notification_type === 'idle_prompt') return 'idle';
      if (p.notification_type === 'agent_needs_input') return 'ask';
      return null;
    case 'PreToolUse':
      // The AskUserQuestion tool is a real question; any other tool starting just
      // reasserts «working».
      //
      // 'box', а не 'ask': вкладка ждёт человека одинаково, а вот РАМКА на экране есть только
      // здесь. Зов прозой (Stop с фразой) печати не мешает — в строку ввода можно набирать что
      // угодно, — а в открытую коробку Enter уходит выбором варианта. Разделять их приходится
      // здесь, потому что дальше это уже не отличить ничем: статус у них один.
      return p.tool_name === 'AskUserQuestion' ? 'box' : 'busy';
    // A tool finished => work is flowing again. Without this the app stays «ждёт»
    // after you approve a permission, until the NEXT tool starts or the turn ends.
    case 'PostToolUse': return 'busy';
    default: return null;
  }
}

// Build the marker osc.js expects: a valid OSC 777 «notify» carrying our payload —
// ESC ] 777 ; notify ; swarm ; <token> ; <sessionId> ; <transcriptPath> BEL.
// sessionId is a cross-check only (routing is by pty). JSON.stringify encodes the
// control bytes ( / ) for us.
//
// transcript_path Клод сообщает в КАЖДОМ событии — и это единственный надёжный способ
// сказать приложению, где лежит разговор. Складывать путь самому нельзя: вкладка с другим
// CLAUDE_CONFIG_DIR (у человека это алиас `claude-my`) пишет разговор в другой конфиг, а
// приложение искало файл только в ~/.claude — и не находило никогда. Точку с запятой из
// пути НЕ вырезаем: он идёт последним полем, а разбор режет по первой (см. osc.js).
// Управляющие байты вырезаем — они порвали бы саму последовательность.
function markerFor(payload, matcher, override) {
  const token = override || tokenFor(payload, matcher);
  if (!token) return null;
  const sid = String((payload && payload.session_id) || '').replace(/[\x07\x1b;]/g, '');
  const tr = String((payload && payload.transcript_path) || '').replace(/[\x07\x1b]/g, '');
  return `\x1b]777;notify;swarm;${token};${sid};${tr}\x07`;
}

// --- refusing the picker while the user is on a phone -------------------------
// AskUserQuestion paints an interactive «choose 1/2/3» box in the terminal. Over Telegram
// that's a dead end: there's no way to press a key in a box that only exists on a screen
// nobody is looking at. So we DENY the tool. Claude gets the reason and asks in prose
// instead — which the bridge can deliver and answer.
// The sign-off matters as much as the refusal: a prose question that ends the turn
// WITHOUT the marker reads as «готов» to the app, so the bridge never says the agent is
// waiting — the question would just sit in a terminal nobody is looking at. That's the
// exact failure this mode exists to prevent, so we name the phrase right here.
//
// Запрещаем по ДВУМ признакам, и второй появился по живому тупику:
//
//   • сессия ведётся из телеги (приложение перечисляет такие в swarm-tgmode.json рядом с
//     этим скриптом) — это узко: вкладка попадает в список, только когда человек УЖЕ ответил
//     в неё с телефона;
//   • человек сам сказал, что он за телефоном («где я» в приложении, /phone в чате) — тогда
//     недоступен выбор в ЛЮБОЙ вкладке, и неважно, писал он в неё оттуда или нет.
//
// Второго и не хватило: человек спросил агента за компьютером, ушёл с телефоном, а агент к
// тому времени открыл вопрос с вариантами. На телефоне выбирать нечем, а прозу в открытый
// диалог мост не печатает — из этого не было выхода вообще. Признак ручной: человек
// переключил «где я» сам и тем самым согласился, что интерактивный выбор ему сейчас не нужен.
const denyReason = (marker) => 'Пользователь отвечает с телефона: интерактивный выбор ему недоступен.'
  + ' Задай тот же вопрос обычным текстом (варианты — списком в тексте) и заверши ход,'
  + ` закончив сообщение строкой «${marker}: …».`;
const DENY_REASON = denyReason(FALLBACK.marker);

function deniesPicker(payload, tgSessions, presence) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return false;
  if (payload.tool_name !== 'AskUserQuestion') return false;
  if (presence === 'phone') return true;
  const sid = String((payload && payload.session_id) || '');
  return !!sid && Array.isArray(tgSessions) && tgSessions.includes(sid);
}

// The whole stdout payload for one event. terminalSequence sits at the top level (where
// this hook has always put it) AND inside hookSpecificOutput, because which one a given
// Claude Code version reads is not worth betting a status on — the token is idempotent,
// so being read twice costs nothing, while being read zero times costs a wrong status.
function outputFor(payload, matcher, tgSessions, presence) {
  const deny = deniesPicker(payload, tgSessions, presence);
  // Отказ значит «ход продолжается», а не «агент ждёт». Тот же PreToolUse на
  // AskUserQuestion обычно и есть вопрос человеку — но не здесь: коробку с вариантами мы
  // только что запретили, и агент сейчас пойдёт писать вопрос прозой.
  //
  // Пока отсюда уходило «ждёт», в тему улетал вопрос из ТЕКСТА ОТКАЗА: приложение считало
  // вкладку ждущей, брало вопрос с экрана — а на экране в этот миг наше же объяснение,
  // почему коробка запрещена. Настоящий вопрос приходил секунд через пятнадцать и не
  // отправлялся вовсе: про эту вкладку мост уже отчитался.
  const seq = markerFor(payload, matcher, deny ? 'busy' : null);
  if (!seq && !deny) return null;
  const out = {};
  if (seq) out.terminalSequence = seq;
  if (deny) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyReason(matcher && matcher.marker ? matcher.marker : FALLBACK.marker),
    };
    if (seq) out.hookSpecificOutput.terminalSequence = seq;
  }
  return out;
}

// The files the app writes beside this script (all three live in userData).
async function readJsonBeside(name) {
  const { readFileSync } = await import('node:fs');
  return JSON.parse(readFileSync(new URL('./' + name, import.meta.url), 'utf8'));
}

async function main() {
  let phrases = null;
  try { phrases = await readJsonBeside('swarm-phrases.json'); } catch (_) { /* → FALLBACK */ }
  let tgSessions = [];
  let presence = '';
  try {
    const tg = await readJsonBeside('swarm-tgmode.json');
    tgSessions = tg.sessions || [];
    // «Где я» лежит в том же файле: приложение переписывает его при каждом переключении.
    // Нет поля (файл от прежней версии) — ведём себя как раньше, по списку сессий.
    presence = String(tg.presence || '');
  } catch (_) { /* none */ }
  const matcher = loadMatcher(() => phrases);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try {
      const out = outputFor(JSON.parse(input || '{}'), matcher, tgSessions, presence);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (_) { /* malformed payload → emit nothing */ }
    process.exit(0);
  });
}

// Запущены ли мы НАПРЯМУЮ (а не импортированы тестом ради чистых функций)?
//
// Сравнивать надо два адреса одного файла, и оба нуждаются в приведении, иначе проверка
// молча не срабатывает — а «молча» здесь значит, что хук не печатает НИЧЕГО и весь
// точный статус выключен, хотя в настройках он включён и в settings всё прописано:
//
//   • путь → URL только через pathToFileURL. Склейка `file://` + путь ломается на первом
//     же пробеле: живёт этот скрипт в «~/Library/Application Support/claude-swarm-lite»,
//     то есть на маке ВСЕГДА. import.meta.url пишет пробел как %20, склейка — как пробел,
//     строки не равны, main() не вызывается. Именно так канал хуков и был мёртв у всех
//     установленных копий, а в разработке (путь репозитория без пробелов) работал.
//   • симлинки. Модульный адрес у ESM уже разрешён до реального файла, а argv[1] — нет
//     (на маке os.tmpdir() это /var → /private/var). realpath приводит их к одному виду.
function isDirectRun(moduleUrl, argvPath) {
  if (!argvPath) return false;
  let p = String(argvPath);
  try { p = realpathSync(p); } catch (_) { /* нет файла — сравним как есть */ }
  try { return moduleUrl === pathToFileURL(p).href; } catch (_) { return false; }
}

if (isDirectRun(import.meta.url, process.argv[1])) main();

export { tokenFor, markerFor, loadMatcher, callsUser, closingKind, messageText, deniesPicker, outputFor, denyReason, DENY_REASON, FALLBACK, isDirectRun };
