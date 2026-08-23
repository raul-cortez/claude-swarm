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
import { realpathSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';

// --- «агент зовёт тебя»: теги и фразы ----------------------------------------
// Compiled by the app (ask-phrases.js) and written next to this script as
// swarm-phrases.json, because the user can edit the phrase list in Settings. We only
// APPLY the regexes — no phrase logic here, so there's nothing to drift. If the
// file is missing or broken we fall back to the shipped default (pinned by a test
// against ask-phrases.js DEFAULT_SOURCES).
//
// Основной канал — ТЕГ в конце сообщения: [вопрос] / [question] значит «жду человека»,
// [фон] / [background] — «жду свою фоновую задачу». Фразы («Сейчас от тебя …») понимаются
// наравне, но это путь совместимости: естественную речь приходилось разбирать тремя
// регулярками с русской морфологией, и разница между «жди результата» и «жду замер»
// держалась на лице глагола.
const FALLBACK = {
  mark: '(?:(?:\\[\\s*вопрос\\s*\\]|\\[\\s*question\\s*\\]|\\[\\s*фон\\s*\\]|\\[\\s*background\\s*\\])|Сейчас от тебя)',
  tagAsk: '^(?:\\[\\s*вопрос\\s*\\]|\\[\\s*question\\s*\\])',
  tagWait: '^(?:\\[\\s*фон\\s*\\]|\\[\\s*background\\s*\\])',
  none: '(?:Сейчас от тебя)[\\s:.\\u2014*_`~-]*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\\s+(?:нужно|требуется|надо))',
  wait: '(?:Сейчас от тебя)[\\s:.,\\u2014*_`~-]*(?:ничего[\\s:.,\\u2014*_`~-]*)?(?:жду|ждём|ждем|дождусь|дожидаюсь|ожидаю)(?![а-яёА-ЯЁa-zA-Z])',
  marker: '[вопрос]',   // то, чем метку НАЗЫВАЮТ агенту (отказ от коробки, ночное правило)
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
  // Теги — своя заглушка по той же причине, но с обратным смыслом: файл рядом мог быть
  // записан версией приложения, которая про теги не знала, и тогда в нём НЕТ ни tagAsk,
  // ни тегов внутри mark. Заглушка вернёт и то и другое, так что тег понимается всегда —
  // он протокол, а не пользовательская настройка.
  const tagAsk = (src && typeof src.tagAsk === 'string' && src.tagAsk) || FALLBACK.tagAsk;
  const tagWait = (src && typeof src.tagWait === 'string' && src.tagWait) || FALLBACK.tagWait;
  // Старый файл не знает про теги и в mark их не перечисляет — тогда берём заглушку
  // целиком: потерять тег хуже, чем потерять чужую фразу, потому что тегам мы УЧИМ.
  const markSrc = (src && typeof src.tagAsk === 'string') ? mark : FALLBACK.mark;
  // Метка, которую иногда приходится называть агенту обратно (см. denyReason).
  const marker = FALLBACK.marker;
  try {
    return {
      mark: new RegExp(markSrc, 'i'),
      tagAsk: new RegExp(tagAsk, 'i'),
      tagWait: new RegExp(tagWait, 'i'),
      none: new RegExp(none, 'i'),
      wait: new RegExp(wait, 'i'),
      marker,
    };
  } catch (_) {
    return {
      mark: new RegExp(FALLBACK.mark, 'i'),
      tagAsk: new RegExp(FALLBACK.tagAsk, 'i'),
      tagWait: new RegExp(FALLBACK.tagWait, 'i'),
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
  // Тег стоит в НАЧАЛЕ хвоста: хвост и начинается с последней метки. Он отвечает сам за
  // себя, разбирать после него нечего — в этом вся его польза против естественной фразы.
  // Порядок и смысл повторяют ask-phrases.js callKind, совпадение сверяется тестом.
  if (matcher.tagAsk && matcher.tagAsk.test(tail)) return 'ask';
  if (matcher.tagWait && matcher.tagWait.test(tail)) return 'wait';
  if (matcher.wait && matcher.wait.test(tail)) return 'wait';
  if (matcher.none && matcher.none.test(tail)) return null;
  return 'ask';
}

// Did the agent's closing message actually ask for something?
function callsUser(matcher, text) {
  return closingKind(matcher, text) === 'ask';
}

// --- шаг ПОДАГЕНТА — это не ход вкладки ---------------------------------------
// Инструменты, которые запускает подагент (Task/Agent), приходят в те же хуки той же
// сессии: тот же session_id, тот же терминал, те же PreToolUse/PostToolUse. Отличает их
// одна пара полей — agent_id / agent_type, — которую Клод кладёт только в события
// подагента (проверено на 2.1.229; у главного хода их нет).
//
// Считать такой шаг за «работает» нельзя. Живьём это выглядело так: агент отправил
// разведку фоновым подагентом, следом открыл вопрос с вариантами и остановился — а
// вкладка светилась оранжевым, «работает». Человек мимо неё проходит: занята. На самом
// деле на экране стояла коробка с вариантами, и каждый шаг разведки затирал её `busy`,
// раз в несколько секунд, всё время, пока та ходила по репозиторию.
//
// Про ГЛАВНЫЙ ход шаг подагента не говорит ничего: тот может в это время работать, ждать
// ответа или вовсе быть законченным. Поэтому у таких шагов свой токен `sub` — «подагент
// жив», — и статуса вкладки он не назначает вовсе: приложение поднимает им только зелёную
// вкладку до «работает в фоне» и никогда не трогает «ждёт» (см. HOOK_TOKEN в detector.js).
// Потерять этот сигнал совсем было бы жалко: вкладка, отправившая разведку и закрывшая ход,
// светилась бы «готов», то есть «дай мне задачу», пока разведка ходит по репозиторию.
function isSubagent(p) {
  return !!(p && (p.agent_id || p.agent_type));
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
      // Эти два — не события, а НАПОМИНАНИЯ: Клод шлёт их, когда человек долго не отвечает.
      // Нового про вкладку они не говорят ничего, в том числе про открытую рамку, а приходят как
      // раз тогда, когда она чаще всего и стоит: минуту без ответа рамка переживает легко, а
      // ночью — и час. Поэтому у них свои токены, и добытое знание они не затирают (см. HOOK_TOKEN
      // в detector.js). Общий с прощанием зовом токен `ask` здесь стоять не может: тот значит
      // «ход кончен, рамки нет», и напоминание отменяло бы рамку ровно в тот миг, когда она есть.
      if (p.notification_type === 'idle_prompt') return 'lull';
      if (p.notification_type === 'agent_needs_input') return 'nag';
      return null;
    case 'PreToolUse':
      // The AskUserQuestion tool is a real question; any other tool starting just
      // reasserts «working».
      //
      // 'box', а не 'ask': вкладка ждёт человека одинаково, а вот РАМКА на экране есть только
      // здесь. Зов прозой (Stop с фразой) печати не мешает — в строку ввода можно набирать что
      // угодно, — а в открытую коробку Enter уходит выбором варианта. Разделять их приходится
      // здесь, потому что дальше это уже не отличить ничем: статус у них один.
      //
      // Вопрос — исключение из правила про подагента: РАМКА на экране одна на всех. Кто бы
      // её ни открыл, Enter уходит в неё, и человек нужен здесь и сейчас.
      if (p.tool_name === 'AskUserQuestion') return 'box';
      return isSubagent(p) ? 'sub' : 'busy';
    // A tool finished => work is flowing again. Without this the app stays «ждёт»
    // after you approve a permission, until the NEXT tool starts or the turn ends.
    case 'PostToolUse': return isSubagent(p) ? 'sub' : 'busy';
    // Подагент закончил. Отдельный токен, потому что молчание «жив» отличить от смерти
    // нечем: шаги приходят по инструментам, а между ними подагент может думать минутами.
    case 'SubagentStop': return 'subend';
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

// --- ночной режим ------------------------------------------------------------
// Ночью человека у компьютера нет, и вопрос с вариантами — не просто недоступный выбор, а
// потерянная ночь: вкладка встанет на нём до утра. Правило то же, что печатает приложение в
// ждущую вкладку (night.js rule), и текст обязан совпадать — агент, получающий разные
// инструкции в зависимости от того, КАК он спросил, ведёт себя случайно. Сверяется тестом.
const nightRule = (tag) => [
  'Человека нет у компьютера: ночной режим, ответа не будет до утра.',
  'Интерактивный выбор недоступен.',
  'Реши сам, если решение обратимо или переделка дешёвая: выбери разумный вариант,',
  'назови его вслух в ходе и продолжай работу.',
  'Остановись, если ответ задаёт направление и ошибка стоит дорого: развилка, где не угадать,',
  'что именно нужно человеку; необратимое действие; ломающая совместимость правка.',
  'Тогда сформулируй вопрос обычным текстом с вариантами и закончи ход тегом',
  `${tag} в самом конце сообщения — утром на него ответят.`,
  'Не спрашивай второй раз об одном и том же: повторный вопрос ночью никто не прочитает.',
].join(' ');

// Что агент СОБИРАЛСЯ спросить. Единственное место во всей системе, где развилка видна
// дословно — с вопросом и вариантами, до всякого разбора прозы: дальше по цепочке остаётся
// только то, что агент сам решил сказать вслух. Отсюда её и берёт утренняя сводка.
function askedQuestion(payload) {
  const inp = (payload && payload.tool_input) || {};
  const qs = Array.isArray(inp.questions) ? inp.questions : [];
  const first = qs[0] || {};
  const text = String(first.question || first.header || '').replace(/\s+/g, ' ').trim();
  const options = (Array.isArray(first.options) ? first.options : [])
    .map((o) => String((o && (o.label || o.description)) || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6);
  return { text: text.slice(0, 600), options };
}

// --- ворота на подагентов ----------------------------------------------------
// Живой случай: расход у подписки на пределе, сессия запускает пятерых подагентов, и все
// они умирают через пять минут. Агент об этом знать не может — числа расхода Клод отдаёт
// строке статуса, то есть другому процессу, и в контекст модели они не попадают вовсе.
//
// Пороги дублируют night.js (GATE_FIVE / GATE_SEVEN) и сверяются тестом: этот скрипт
// запускается сам по себе, модулей приложения ему не видно.
const GATE_FIVE = 90;
const GATE_SEVEN = 97;

// «2ч14м» / «18м». Своя копия по той же причине, что и пороги.
function fmtEta(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}д${h}ч` : `${d}д`;
  if (h > 0) return m > 0 ? `${h}ч${m}м` : `${h}ч`;
  return `${m}м`;
}

function etaOf(limit, nowSec) {
  const r = limit && Number.isFinite(limit.resetsAt) ? limit.resetsAt : null;
  return r != null && r > nowSec ? fmtEta(r - nowSec) : '';
}

// Запускать ли подагента. null — можно (в том числе когда данных нет: свежая сессия ещё не
// получила ни одного ответа API, и rate_limits в ней пусты — отказать здесь значило бы
// запретить первого же подагента в каждой новой вкладке).
//
// Недельное окно проверяется ПЕРВЫМ и отказ у него другой по смыслу: пятичасовое сбросится
// вечером, и «подожди» там осмысленный совет, а недельное — через дни, ждать нечего.
function gatesSubagent(payload, usage, nowSec) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return null;
  if (payload.tool_name !== 'Task') return null;
  if (!usage) return null;
  const five = usage.five;
  const seven = usage.seven;
  if (seven && Number.isFinite(seven.spent) && seven.spent >= GATE_SEVEN) {
    const e = etaOf(seven, nowSec);
    return { reason: `Недельное окно подписки израсходовано на ${seven.spent}%`
      + (e ? ` (сброс через ${e})` : '') + '. Ждать бессмысленно, а подагенты умрут на середине:'
      + ' делай шаги сам и экономно, без Task.' };
  }
  if (five && Number.isFinite(five.spent) && five.spent >= GATE_FIVE) {
    const e = etaOf(five, nowSec);
    return { reason: `Пятичасовое окно подписки израсходовано на ${five.spent}%`
      + (e ? `, сброс через ${e}` : '') + '. Подагенты не успеют прогнаться и умрут на середине:'
      + ' сделай следующий шаг сам или дождись сброса, а потом запускай.' };
  }
  return null;
}

// Строка расхода в начало хода: то же знание, но мягко — агент сам решает, звать ли пятерых.
// Ворота ловят край, а это лечит причину: агент, который видит числа, до края не доходит.
function usageNote(usage, nowSec) {
  if (!usage) return '';
  const part = (label, l) => {
    if (!l || !Number.isFinite(l.spent)) return '';
    const e = etaOf(l, nowSec);
    return `${label} ${l.spent}%${e ? ` (сброс через ${e})` : ''}`;
  };
  const parts = [part('5ч', usage.five), part('7д', usage.seven)].filter(Boolean);
  if (!parts.length) return '';
  return `Расход подписки прямо сейчас: ${parts.join(', ')}.`
    + ' Учитывай это, прежде чем запускать подагентов: на пределе они умрут на середине.';
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
  + ` поставив в самом конце сообщения тег ${marker}.`;
const DENY_REASON = denyReason(FALLBACK.marker);

function deniesPicker(payload, tgSessions, presence) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return false;
  if (payload.tool_name !== 'AskUserQuestion') return false;
  // Ночь — третий признак, и самый весомый: с телефона выбрать нельзя, а ночью НЕКОМУ
  // выбирать вовсе, и вкладка встанет на этой рамке до утра.
  if (presence === 'phone' || presence === 'night') return true;
  const sid = String((payload && payload.session_id) || '');
  return !!sid && Array.isArray(tgSessions) && tgSessions.includes(sid);
}

// Почему нельзя открывать рамку — и что делать вместо этого. Два разных текста, потому что
// это две разные обстановки: с телефона человек ОТВЕТИТ на вопрос прозой, а ночью ответа не
// будет вовсе, и агенту надо решать самому по правилу.
function denyReasonFor(presence, marker) {
  const m = marker || FALLBACK.marker;
  return presence === 'night' ? nightRule(m) : denyReason(m);
}

// The whole stdout payload for one event. terminalSequence sits at the top level (where
// this hook has always put it) AND inside hookSpecificOutput, because which one a given
// Claude Code version reads is not worth betting a status on — the token is idempotent,
// so being read twice costs nothing, while being read zero times costs a wrong status.
function outputFor(payload, matcher, tgSessions, presence, extra) {
  const ex = extra || {};
  const nowSec = Number.isFinite(ex.nowSec) ? ex.nowSec : Math.floor(Date.now() / 1000);
  const deny = deniesPicker(payload, tgSessions, presence);
  // Отказ значит «ход продолжается», а не «агент ждёт». Тот же PreToolUse на
  // AskUserQuestion обычно и есть вопрос человеку — но не здесь: коробку с вариантами мы
  // только что запретили, и агент сейчас пойдёт писать вопрос прозой.
  //
  // Пока отсюда уходило «ждёт», в тему улетал вопрос из ТЕКСТА ОТКАЗА: приложение считало
  // вкладку ждущей, брало вопрос с экрана — а на экране в этот миг наше же объяснение,
  // почему коробка запрещена. Настоящий вопрос приходил секунд через пятнадцать и не
  // отправлялся вовсе: про эту вкладку мост уже отчитался.
  // Ворота на подагентов. Тот же приём, что у рамки: отказ приходит агенту результатом
  // инструмента, внутри хода, и работа продолжается — просто без пятерых, которые всё равно
  // умерли бы на середине. Круглосуточно, а не только ночью: умирают они одинаково.
  const gate = deny ? null : gatesSubagent(payload, ex.usage, nowSec);
  // Отказ (любой) значит «ход продолжается», а не «агент ждёт»: рамку мы только что
  // запретили, и агент сейчас пойдёт писать прозой или делать шаг сам.
  const seq = markerFor(payload, matcher, (deny || gate) ? 'busy' : null);
  const note = (payload && payload.hook_event_name === 'UserPromptSubmit')
    ? usageNote(ex.usage, nowSec) : '';
  if (!seq && !deny && !gate && !note) return null;
  const out = {};
  if (seq) out.terminalSequence = seq;
  if (deny || gate) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: gate
        ? gate.reason
        : denyReasonFor(presence, matcher && matcher.marker ? matcher.marker : FALLBACK.marker),
    };
    if (seq) out.hookSpecificOutput.terminalSequence = seq;
  } else if (note) {
    // Числа расхода в начало хода. Не отказ и ничему не мешает: агент просто ЗНАЕТ, сколько
    // осталось, — раньше это знание жило в строке статуса, то есть в другом процессе.
    out.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: note,
    };
    if (seq) out.hookSpecificOutput.terminalSequence = seq;
  }
  return out;
}

// --- снимки расхода: где взять числа -----------------------------------------
// Строка статуса Клода кладёт их рядом с этим скриптом, по файлу на сессию (см. usageSnapshot
// в swarm-statusline.js). Три тонкости, и без каждой ворота вредили бы больше, чем помогают:
//
//   • нет снимка своей сессии — НЕ РЕШАЕМ ничего. rate_limits приходят только на подписке и
//     только с первого ответа API, так что у свежей вкладки их нет; отказ здесь запретил бы
//     первого же подагента в каждой новой сессии.
//   • берём самый свежий снимок по ВСЕМ вкладкам: окна общие на аккаунт, а простаивающая
//     вкладка свой файл не обновляет — её проценты получасовой давности.
//   • но только внутри своего АККАУНТА. Конфигов у человека несколько (`CLAUDE_CONFIG_DIR`,
//     алиас вроде `claude-my`), окна у них разные, и смешать их значит запретить подагентов
//     на личном аккаунте из-за расхода рабочего.
function pickUsage(snaps, sessionId) {
  const list = (Array.isArray(snaps) ? snaps : []).filter((s) => s && typeof s === 'object');
  const sid = String(sessionId || '');
  const own = list.find((s) => String(s.session || '') === sid && sid);
  if (!own) return null;
  const home = String(own.home || '');
  const pool = home ? list.filter((s) => String(s.home || '') === home) : [own];
  // Самый свежий из тех, у кого ЕСТЬ числа окон, а не просто самый свежий. Снимок пишется и
  // когда в нём одно заполнение контекста: у сессии, не получившей ещё ни одного ответа API, и
  // у вкладки на ключе вместо подписки. Такой файл, легший последним, обнулял ворота целиком —
  // ровно в тот момент, когда они нужны: рабочая вкладка на 97%, открыл новую, и подагенты
  // снова разрешены всем.
  const fresh = pool
    .filter((s) => s.five || s.seven)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0];
  if (!fresh) return null;
  return { five: fresh.five || null, seven: fresh.seven || null, at: Number(fresh.at) || 0 };
}

function readUsage(sessionId) {
  const dir = new URL('./usage/', import.meta.url);
  let names = [];
  try { names = readdirSync(dir); } catch (_) { return null; }
  const snaps = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { snaps.push(JSON.parse(readFileSync(new URL(n, dir), 'utf8'))); } catch (_) { /* пропускаем */ }
  }
  return pickUsage(snaps, sessionId);
}

// --- ночной журнал -----------------------------------------------------------
// Строка на развилку, которую агент прошёл сам. Пишет ХУК, а не приложение, потому что
// дословный вопрос с вариантами есть только здесь: дальше остаётся лишь то, что агент решил
// сказать вслух. Читает утренняя сводка (night.js parse/digest).
//
// Дописывание одной строкой и без чтения: тот же файл пишут одновременно все вкладки, а
// каждая из них — отдельный процесс. Сломать сводку это не может, битую строку разбор
// пропускает молча.
function logNight(kind, payload, extra) {
  try {
    const e = Object.assign({
      at: Date.now(),
      kind,
      session: String((payload && payload.session_id) || ''),
    }, extra || {});
    appendFileSync(new URL('./night.jsonl', import.meta.url), JSON.stringify(e) + '\n');
  } catch (_) { /* журнал не важнее работы */ }
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
      const payload = JSON.parse(input || '{}');
      // Снимки расхода читаем только там, где они нужны: перед запуском подагента и в начале
      // хода. На каждом PostToolUse обходить папку значило бы читать диск десятки раз за ход.
      const wantsUsage = payload && (payload.hook_event_name === 'UserPromptSubmit'
        || (payload.hook_event_name === 'PreToolUse' && payload.tool_name === 'Task'));
      const usage = wantsUsage ? readUsage(payload.session_id) : null;
      const out = outputFor(payload, matcher, tgSessions, presence, { usage });
      // Ночью запрещённая рамка — это принятое без человека решение. Записываем ЕГО, а не
      // факт отказа: утром в сводке должна стоять развилка дословно.
      if (presence === 'night' && deniesPicker(payload, tgSessions, presence)) {
        const q = askedQuestion(payload);
        logNight('deny-box', payload, { text: q.text, options: q.options });
      }
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

export { tokenFor, markerFor, loadMatcher, callsUser, closingKind, messageText, deniesPicker,
  outputFor, denyReason, denyReasonFor, DENY_REASON, FALLBACK, isDirectRun, isSubagent,
  nightRule, askedQuestion, gatesSubagent, usageNote, pickUsage, fmtEta, GATE_FIVE, GATE_SEVEN };
