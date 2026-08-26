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
import { realpathSync, readFileSync, readdirSync } from 'node:fs';

// --- «агент зовёт тебя»: теги и фразы ----------------------------------------
// Compiled by the app (ask-phrases.js) and written next to this script as
// swarm-phrases.json, because the user can edit the phrase list in Settings. We only
// APPLY the regexes — no phrase logic here, so there's nothing to drift. If the
// file is missing or broken we fall back to the shipped default (pinned by a test
// against ask-phrases.js DEFAULT_SOURCES).
//
// Основной канал — ТЕГ С НАЧАЛА СТРОКИ: [swarm:вопрос] / [swarm:question] значит «жду
// человека», [swarm:фон] / [swarm:background] — «жду свою фоновую задачу». Приставка и начало
// строки — вдвоём защита от путаницы: агент, который ОБЪЯСНЯЕТ протокол или цитирует доку,
// называет метку внутри фразы, и там она ничего не значит. Фразы («Сейчас от тебя …») понимаются
// наравне, но это путь совместимости: естественную речь приходилось разбирать тремя
// регулярками с русской морфологией, и разница между «жди результата» и «жду замер»
// держалась на лице глагола.
const FALLBACK = {
  mark: '(?:(?:^|\\r?\\n)[ \\t]*(?:[⏺●]\\s*)?[ \\t]*(?:\\*{1,2}|_{1,2}|`)?[ \\t]*(?:\\[\\s*(?:swarm\\s*:\\s*)?(?:вопрос|question|фон|background|готово|done)\\s*\\])|Сейчас от тебя)',
  tagAsk: '^(?:\\r?\\n)?[ \\t]*(?:[⏺●]\\s*)?[ \\t]*(?:\\*{1,2}|_{1,2}|`)?[ \\t]*(?:\\[\\s*(?:swarm\\s*:\\s*)?(?:вопрос|question)\\s*\\])',
  tagWait: '^(?:\\r?\\n)?[ \\t]*(?:[⏺●]\\s*)?[ \\t]*(?:\\*{1,2}|_{1,2}|`)?[ \\t]*(?:\\[\\s*(?:swarm\\s*:\\s*)?(?:фон|background)\\s*\\])',
  tagDone: '^(?:\\r?\\n)?[ \\t]*(?:[⏺●]\\s*)?[ \\t]*(?:\\*{1,2}|_{1,2}|`)?[ \\t]*(?:\\[\\s*(?:swarm\\s*:\\s*)?(?:готово|done)\\s*\\])',
  none: '(?:Сейчас от тебя)[\\s:.\\u2014*_`~-]*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\\s+(?:нужно|требуется|надо))',
  wait: '(?:Сейчас от тебя)[\\s:.,\\u2014*_`~-]*(?:ничего[\\s:.,\\u2014*_`~-]*)?(?:жду|ждём|ждем|дождусь|дожидаюсь|ожидаю)(?![а-яёА-ЯЁa-zA-Z])',
  marker: '[swarm:вопрос]',   // то, чем метку НАЗЫВАЮТ агенту (отказ от коробки, ночное правило)
  doneMarker: '[swarm:готово]', // то, чем НАЗЫВАЮТ агенту метку конца работы (просьба про итог)
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
  // Тег конца работы приехал позже остальных: файл, записанный прежней версией приложения,
  // про него не знает, и тогда берётся заглушка — иначе метка читалась бы как зов.
  const tagDone = (src && typeof src.tagDone === 'string' && src.tagDone) || FALLBACK.tagDone;
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
      tagDone: new RegExp(tagDone, 'i'),
      none: new RegExp(none, 'i'),
      wait: new RegExp(wait, 'i'),
      marker,
    };
  } catch (_) {
    return {
      mark: new RegExp(FALLBACK.mark, 'i'),
      tagAsk: new RegExp(FALLBACK.tagAsk, 'i'),
      tagWait: new RegExp(FALLBACK.tagWait, 'i'),
      tagDone: new RegExp(FALLBACK.tagDone, 'i'),
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
// ничего, но работа продолжается сама (запущена фоновая задача, она и разбудит), 'done' —
// кончилась вся задача, а не ход (метка нужна вкладке с мандатом: см. DONE_TAGS в
// ask-phrases.js), null — закончил. Разбираем хвост от ПОСЛЕДНЕЙ фразы: сообщение бывает длинным, и «ничего» из
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
  // Тег стоит в НАЧАЛЕ хвоста: хвост и начинается с последней метки, то есть с того самого
  // перевода строки, с которого тег и ищется. Он отвечает сам за себя, разбирать после него
  // нечего — в этом вся его польза против естественной фразы.
  // Порядок и смысл повторяют ask-phrases.js callKind, совпадение сверяется тестом.
  if (matcher.tagAsk && matcher.tagAsk.test(tail)) return 'ask';
  if (matcher.tagWait && matcher.tagWait.test(tail)) return 'wait';
  if (matcher.tagDone && matcher.tagDone.test(tail)) return 'done';
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
        // 'done' — тот же «готов»: цвет статуса от конца ЗАДАЧИ не меняется, меняется
        // только вид вкладки с мандатом, а его считает приложение по тексту хода.
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
    // Начало разговора. Статуса не даёт вовсе — и токен тут нужен не ради статуса, а ради
    // ПОЛЕЙ маркера: id разговора и путь стенограммы. Это единственный миг, когда приложение
    // может узнать про /clear.
    //
    // Живьём без него было так: человек чистит вкладку, разговор становится новым — а
    // приложение продолжает читать снимок расхода СТАРОГО (снимки лежат по одному на сессию,
    // см. usageSnapshot). Полоска контекста стоит заполненной на чистой вкладке, и следом
    // приходит просьба о перезапуске по проценту, которого больше нет.
    //
    // Токен `hello` детектор не знает намеренно (HOOK_TOKEN в detector.js): статус вкладки он
    // назначать не должен. SessionStart приходит и на `compact`, где ход идёт дальше, и на
    // `resume`, где вкладка может стоять на вопросе, — любой статус отсюда был бы враньём.
    case 'SessionStart': return isSubagent(p) ? null : 'hello';
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

// --- работа без человека -----------------------------------------------------
// У вкладки есть мандат («авто» на ней самой или общий ночной режим), и вопрос с вариантами —
// не просто недоступный выбор, а потерянные часы: вкладка встанет на нём до возвращения
// человека. Правило то же, что печатает приложение в ждущую вкладку (night.js rule), и текст
// обязан совпадать — агент, получающий разные
// инструкции в зависимости от того, КАК он спросил, ведёт себя случайно. Сверяется тестом.
const nightRuleBody = () => [
  'Эта вкладка работает без человека: он не ответит, интерактивный выбор недоступен.',
  'Реши сам, если решение обратимо или переделка дешёвая: выбери разумный вариант,',
  'назови его вслух в ходе и продолжай работу.',
  'Остановись, если ответ задаёт направление и ошибка стоит дорого: развилка, где не угадать,',
  'что именно нужно человеку; необратимое действие; ломающая совместимость правка.',
  'Тогда сформулируй вопрос обычным текстом с вариантами — человек ответит, когда вернётся.',
  'Не спрашивай второй раз об одном и том же: повторный вопрос сейчас никто не прочитает.',
].join(' ');

// Строка про метку отделена от уклада и дописывается ВСЕГДА — к заготовке и к своему тексту
// одинаково. Метка служебная, и следить за ней должен сворм: пока она стояла внутри текста,
// который человек правит, переписанное под свой уклад правило уносило её с собой, и вкладка
// Итог задачи. Дубликат night.js summaryNote — у хука нет доступа к модулям приложения (та же
// причина, что у правила и порогов), сверяется тестом.
const summaryNote = (doneTag) => [
  `Задача кончилась — начни сообщение отдельной строкой с тегом ${doneTag || FALLBACK.doneMarker}`,
  'и в нём напиши итог: что сделано; что ты решил сам вместо человека и почему;',
  'что осталось и чем это проверять.',
  'Человек прочитает итог, открыв вкладку, — другого рассказа о твоей работе у него нет,',
  'а по тегу вкладка в списке отметится как сдавшая работу.',
].join(' ');

// стояла зелёной с вопросом до утра. Дубликат night.js protocol/withProtocol, сверяется тестом.
const nightProtocol = (tag) => `Когда спрашиваешь человека, начинай сообщение отдельной строкой с тегом ${tag}`
  + ' — иначе сворм не поймёт, что ты ждёшь ответа, и не позовёт его.';

const withNightProtocol = (text, tag) => {
  const t = String(text == null ? '' : text).trim();
  if (!t) return nightProtocol(tag);
  return t.includes(tag) ? t : t + ' ' + nightProtocol(tag);
};

const nightRule = (tag) => withNightProtocol(nightRuleBody(), tag || '[swarm:вопрос]');

// --- перезапуск по своей воле ------------------------------------------------
// Одна строка в контекст свежей сессии: «ты можешь перезапустить себя сам». Умение это в сворме
// было с самого начала (restart.js читает файл-ответ мимо порога, мимо отсрочки и мимо немоты),
// но знал о нём только тот агент, которого УЖЕ спросили на пороге, — просьба и приносила имя
// файла. Агент, до порога не дошедший, честно домалывал большую работу в тупеющей сессии:
// сворм видит проценты, а объём работы впереди знает только он.
//
// Почему здесь, а не в просьбе сворма: это про УМЕНИЕ, а не про решение. Знать о нём надо
// заранее и один раз, а решать — в конкретный миг, и критерии решения живут в тексте просьбы
// (restart.askText), которую сворм печатает на пороге. Здесь коротко: когда стоит, когда нет и
// куда положить файл.
//
// Платит за эти строки каждая сессия, поэтому их мало. Всё длинное — в MANUAL.md.
const selfRestartNote = (file) => [
  '[сворм] Ты можешь перезапустить себя сам, не дожидаясь, пока я спрошу.',
  'Я вижу только проценты заполнения контекста, а объём работы впереди знаешь только ты:',
  'если впереди большой кусок, а окно уже подъедено — начни его свежей сессией, а не тупеющей.',
  'Середина задачи (ревью, чек-лист, серия правок) — не причина ждать, рвать можно и посреди неё.',
  'Как: сначала запиши эстафету (что сделано, на чём стоишь, что дальше, чем проверять) туда,',
  'где у тебя это принято, потом положи в свою рабочую папку файл',
  `${file} с одним JSON-объектом:`,
  '{"restart": true, "prompt": "чем займётся свежая сессия", "handoff": "где лежит эстафета"}',
  'Я подберу его в течение полминуты, дождусь спокойного мига и подниму свежую сессию этим',
  'промптом. Без prompt или без handoff (либо text с самой запиской) перезапуска не будет.',
  'Когда НЕ стоит: работа закончена, до конца осталось одно-два дешёвых действия, или СЕЙЧАС',
  'что-то прервётся вместе с тобой и потеряет токены впустую — работают сабагенты, идёт прогон',
  'команды, теста или сборки. Во всех остальных случаях доделывать здесь незачем.',
].join('\n');

// Имя файла-ответа для ЭТОЙ вкладки — по id разговора, единственному, что хук про неё знает.
// Дубликат restart.answerName из приложения (модулей приложения здесь нет), сверяется тестом.
// Общее имя `.swarm-restart.json` тут не годится: в папке с двумя вкладками сворм его не читает,
// и зов ушёл бы в тишину — предупреждение об этом он пишет на вкладку, а не в разговор. Оно
// остаётся лишь на случай события без id разговора: назвать нечего, а промолчать про дверь хуже.
const SHARED_ANSWER = '.swarm-restart.json';
const restartFileFor = (sid) => {
  const id = String(sid == null ? '' : sid).replace(/[^\w.-]/g, '_');
  return id ? '.swarm-restart-' + id + '.json' : SHARED_ANSWER;
};

// --- дайджест вкладки ---------------------------------------------------------
// Одна строка на старте сессии — как selfRestartNote, и по той же причине один раз: платит
// за неё каждая сессия, значит написана она должна быть коротко. Учит не «что писать», а
// «куда положить» — печатать о СМЫСЛЕ дайджеста агенту незачем, у него он и так есть.
//
// Имя файла — дубликат digest.fileName из приложения (модулей приложения здесь нет), сверяется
// тестом.
const digestFileFor = (sid) => {
  const id = String(sid == null ? '' : sid).replace(/[^\w.-]/g, '_');
  return id ? '.swarm-digest-' + id + '.json' : '';
};

const digestNote = (file) => [
  '[сворм] Веди короткий дайджест вкладки — пару строк о том, чем занят СЕЙЧАС.',
  'Его видит человек в списке вкладок со стороны, не открывая разговор, — другого способа узнать это у него нет.',
  'Обновляй, когда меняется этап работы (не на каждый шаг), перезаписывая в своей рабочей папке файл',
  `${file} с одним JSON-объектом:`,
  '{"digest": "коротко, чем занят сейчас"}',
  'Перезаписывать можно сколько угодно раз — я слежу за файлом и обновляю карточку сам.',
].join('\n');

// Своя формулировка правила: человек вправе сказать ночным агентам своё, и приложение кладёт
// его текст в тот же файл, где лежит «где я» (swarm-tgmode.json). Дубликат подстановки из
// night.js ruleText — по той же причине, что и всё в этом файле: модулей приложения здесь нет.
// Сверяется тестом.
const TAG_SLOT = /\{\s*(?:тег|tag)\s*\}/gi;

const nightRuleText = (custom, tag) => {
  const m = String(tag || '[swarm:вопрос]');
  const t = String(custom == null ? '' : custom).trim();
  return withNightProtocol(t ? t.replace(TAG_SLOT, m) : nightRuleBody(), m);
};

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
//
// С ИМЕНЕМ подписки. Числа агент видел и раньше, но не знал, ЧЕЙ это расход: у человека
// несколько аккаунтов Клода (`CLAUDE_CONFIG_DIR`, алиасы вроде `claude-my`), окна у них разные,
// и «7д 84%» без имени не отвечает на вопрос «а на чём я вообще работаю». Имя даёт человек
// карточке подписки (Настройки → Подписки), приложение кладёт его файлом рядом с этим скриптом
// (subsWriteCards в main.js), и находится оно по КОНФИГУ своей сессии — не по имени команды:
// `claude-glm` и `cld` называются клодово, а лимитов Anthropic у них нет.
//
// Имени может не быть (человек его не дал, карточки нет, файл от прежней версии) — тогда
// молчим о нём: придумать имя аккаунту хуже, чем не назвать его.
function usageNote(usage, nowSec, name) {
  if (!usage) return '';
  const part = (label, l) => {
    if (!l || !Number.isFinite(l.spent)) return '';
    const e = etaOf(l, nowSec);
    return `${label} ${l.spent}%${e ? ` (сброс через ${e})` : ''}`;
  };
  const parts = [part('5ч', usage.five), part('7д', usage.seven)].filter(Boolean);
  if (!parts.length) return '';
  const who = String(name || '').trim();
  return (who ? `Ты работаешь на подписке «${who}». Её расход прямо сейчас: ` : 'Расход подписки прямо сейчас: ')
    + `${parts.join(', ')}.`
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
  + ' Задай тот же вопрос обычным текстом (варианты — списком в тексте), а сообщение начни'
  + ` отдельной строкой с тегом ${marker}.`;
const DENY_REASON = denyReason(FALLBACK.marker);

function deniesPicker(payload, tgSessions, presence, autoSessions) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return false;
  if (payload.tool_name !== 'AskUserQuestion') return false;
  // «Я за телефоном»: выбрать в рамке оттуда нечем. Ночного положения здесь больше нет — ночь
  // живёт мандатами вкладок, и весь ответ про неё даёт список ниже (в него входят все отданные
  // вкладки, хоть одна, хоть все разом).
  if (presence === 'phone') return true;
  const sid = String((payload && payload.session_id) || '');
  if (!sid) return false;
  // Мандат этой вкладки: человек может сидеть рядом и всё равно сказать «эту делай сам».
  if (Array.isArray(autoSessions) && autoSessions.includes(sid)) return true;
  return Array.isArray(tgSessions) && tgSessions.includes(sid);
}

// Почему нельзя открывать рамку — и что делать вместо этого. Два разных текста, потому что
// это две разные обстановки: с телефона человек ОТВЕТИТ на вопрос прозой, а ночью ответа не
// будет вовсе, и агенту надо решать самому по правилу.
function denyReasonFor(presence, marker, nightCustom, auto) {
  const m = marker || FALLBACK.marker;
  return auto ? nightRuleText(nightCustom, m) : denyReason(m);
}

// --- дешёвые команды: что отданная вкладка делает без спроса --------------------
// Запрос разрешения — единственная остановка, которую ночь не умела обойти: рамку рисует Клод,
// и вкладка встаёт в ней до утра. На необратимом так и надо. А на ПРОМЕЖУТОЧНОМ КОММИТЕ это
// потерянная ночь: агент зафиксировал шаг, чтобы идти дальше, и не пошёл никуда.
//
// Поэтому у мандата есть короткий список того, что он разрешает сам, и разрешение выдаётся
// ЗДЕСЬ — ответом хука, до остановки. Дубликат night.js permitDecision (у хука нет доступа к
// модулям приложения — та же причина, что у правила и порогов), сверяется тестом.
const PERMIT_GIT = ['add', 'commit', 'status', 'diff', 'log', 'show'];
const PERMIT_BAD_LONG = ['--all', '--amend', '--force', '--no-verify', '--update'];
const PERMIT_BAD_SHORT = /^-[a-zA-Z]*[aAuf]/;
// Ключи, которые открывают ДИАЛОГ или редактор: `git add -p`, `git commit -e`. Разрешить такую
// команду значит подвесить вкладку изнутри — рамки разрешений нет, а на экране стоит вопрос,
// которого никто не ждёт. Только у add и commit: у log, diff и show `-p` — это «покажи
// патч», и запрещать его незачем.
const PERMIT_WRITES = ['add', 'commit'];
const PERMIT_TALKY_LONG = ['--patch', '--interactive', '--edit'];
const PERMIT_TALKY_SHORT = /^-[a-zA-Z]*[ipe]/;
const PERMIT_SHELL = /[;&|<>\n(){}]/;
const PERMIT_SUBST = /\$\(|\$\{|`/;
const PERMIT_QUOTED = /'[^']*'|"[^"]*"/g;
const PERMIT_HEREDOC = /\$\(\s*cat\s+<<'([A-Za-z_][A-Za-z0-9_]*)'\n[\s\S]*?\n\1\s*\)/g;

function permitDecision(ctx) {
  const c = ctx || {};
  if (!c.auto) return { act: 'stand', why: 'вкладка не в ночном режиме' };
  if (c.tool !== 'Bash') return { act: 'stand', why: 'не команда оболочки' };
  const raw = String(c.command == null ? '' : c.command).trim();
  if (!raw) return { act: 'stand', why: 'нет команды' };
  const noHeredoc = raw.replace(PERMIT_HEREDOC, ' ');
  if (PERMIT_SUBST.test(noHeredoc)) return { act: 'stand', why: 'в команде есть подстановка' };
  const bare = noHeredoc.replace(PERMIT_QUOTED, ' ');
  if (PERMIT_SHELL.test(bare)) return { act: 'stand', why: 'в команде больше одной команды' };
  const words = bare.split(/\s+/).filter(Boolean);
  if (words[0] !== 'git') return { act: 'stand', why: 'не git' };
  const sub = words[1] || '';
  if (!PERMIT_GIT.includes(sub)) return { act: 'stand', why: `git ${sub || '?'} не из дешёвых` };
  for (const w of words.slice(2)) {
    if (PERMIT_BAD_LONG.includes(w)) return { act: 'stand', why: `ключ ${w} решает не за ночь` };
    if (PERMIT_WRITES.includes(sub) && PERMIT_TALKY_LONG.includes(w)) {
      return { act: 'stand', why: `ключ ${w} открыл бы диалог в вкладке` };
    }
    if (w.startsWith('--')) continue;
    if (w.startsWith('-') && PERMIT_BAD_SHORT.test(w)) {
      return { act: 'stand', why: `ключ ${w} решает не за ночь` };
    }
    if (PERMIT_WRITES.includes(sub) && w.startsWith('-') && PERMIT_TALKY_SHORT.test(w)) {
      return { act: 'stand', why: `ключ ${w} открыл бы диалог в вкладке` };
    }
    if (sub === 'add' && (w === '.' || w === ':/' || w === '*')) {
      return { act: 'stand', why: 'add без имён файлов забирает чужое' };
    }
  }
  return { act: 'allow', why: `git ${sub}` };
}

// Разрешаем ли эту команду сами. Мандат обязателен: за клавиатурой человек отвечает сам, а с
// телефона ему приходит кнопка (мост отправляет запрос разрешения в чат) — там решает он.
function permitsCommand(payload, presence, auto) {
  if (!payload || payload.hook_event_name !== 'PreToolUse') return null;
  if (!auto) return null;
  const inp = payload.tool_input || {};
  const d = permitDecision({ auto: true, tool: payload.tool_name, command: inp.command });
  return d.act === 'allow' ? d : null;
}

// Что агент прочитает в ответе на разрешённую команду. Молчать нельзя: пусть в стенограмме
// останется, ПОЧЕМУ разрешение не спрашивали у человека.
const permitReason = (why) => `Вкладка работает без человека, и «${why}» — из дешёвых:`
  + ' посмотреть, добавить в индекс, зафиксировать. Разрешение на это мандат даёт сам, чтобы'
  + ' ночь не стояла на промежуточном коммите. Всё остальное (push, tag, reset и любая не-git'
  + ' команда) по-прежнему ждёт человека.';

// The whole stdout payload for one event. terminalSequence sits at the top level (where
// this hook has always put it) AND inside hookSpecificOutput, because which one a given
// Claude Code version reads is not worth betting a status on — the token is idempotent,
// so being read twice costs nothing, while being read zero times costs a wrong status.
function outputFor(payload, matcher, tgSessions, presence, extra) {
  const ex = extra || {};
  const nowSec = Number.isFinite(ex.nowSec) ? ex.nowSec : Math.floor(Date.now() / 1000);
  const sid = String((payload && payload.session_id) || '');
  // Мандат ИМЕННО ЭТОЙ вкладки: от него зависит не только отказ, но и его причина — правило
  // «решай сам» вместо телефонного «ответь прозой, человек прочитает».
  const auto = !!(sid && Array.isArray(ex.autoSessions) && ex.autoSessions.includes(sid));
  const deny = deniesPicker(payload, tgSessions, presence, ex.autoSessions);
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
  // Разрешение на дешёвую команду. Считается только когда отказывать не за что: отказ и
  // разрешение — одно и то же поле ответа, и спорить им нельзя.
  const permit = (deny || gate) ? null : permitsCommand(payload, presence, auto);
  // Отказ (любой) значит «ход продолжается», а не «агент ждёт»: рамку мы только что
  // запретили, и агент сейчас пойдёт писать прозой или делать шаг сам.
  const seq = markerFor(payload, matcher, (deny || gate) ? 'busy' : null);
  const starts = !!(payload && payload.hook_event_name === 'UserPromptSubmit');
  // Начало хода — единственный миг, когда автономной вкладке можно положить требование в контекст
  // ДО работы. Сказать его в конце нельзя: конец хода мы узнаём тогда, когда агент уже замолчал,
  // и просить у него итог задним числом — значит будить вкладку ради того, что она сделала бы
  // сама, если бы знала. Подагенту не говорим: он живёт внутри чужого хода и итог не пишет.
  const wantsSummary = starts && !isSubagent(payload) && auto;
  const note = [starts ? usageNote(ex.usage, nowSec, subName(ex.subCards, ex.usage && ex.usage.home)) : '',
    wantsSummary ? summaryNote() : '']
    .filter(Boolean).join('\n\n');
  // Про самозвон говорим один раз за сессию — на её старте, — и только если перезапуск включён:
  // галочка человека главнее, и обещать агенту дверь, которую сворм не откроет, нельзя. Подагенту
  // не говорим вовсе: он живёт внутри чужого хода и гасить вкладку ему не за что.
  const isStart = payload && payload.hook_event_name === 'SessionStart' && !isSubagent(payload);
  const restartIntro = (isStart && ex.restart && ex.restart.on)
    ? selfRestartNote(restartFileFor(sid)) : '';
  // Тот же миг, что у самозвона, и по той же причине: галочка человека главнее, обещать агенту
  // файл, который сворм не читает, нельзя. Подагенту не говорим: дайджест — про вкладку целиком,
  // а не про то, чем занят один её сабагент.
  const digestIntro = (isStart && ex.digest && ex.digest.on)
    ? digestNote(digestFileFor(sid)) : '';
  const intro = [restartIntro, digestIntro].filter(Boolean).join('\n\n');
  if (!seq && !deny && !gate && !permit && !note && !intro) return null;
  const out = {};
  if (seq) out.terminalSequence = seq;
  if (deny || gate) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: gate
        ? gate.reason
        : denyReasonFor(presence, matcher && matcher.marker ? matcher.marker : FALLBACK.marker, ex.nightRule, auto),
    };
    if (seq) out.hookSpecificOutput.terminalSequence = seq;
  } else if (permit) {
    out.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: permitReason(permit.why),
    };
    if (seq) out.hookSpecificOutput.terminalSequence = seq;
  } else if (intro) {
    out.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: intro,
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
  // `home` — конфиг, в котором это израсходовано. По нему находится ИМЯ подписки для агента
  // (см. subName): по имени команды его искать нельзя, `claude-glm` и `cld` называются
  // клодово, а окон лимитов Anthropic у них нет.
  return {
    five: fresh.five || null, seven: fresh.seven || null,
    at: Number(fresh.at) || 0, home: String(fresh.home || home || ''),
  };
}

// Имя подписки, которое человек дал карточке (Настройки → Подписки). Приложение пишет их
// рядом с этим скриптом, как и остальное своё состояние (swarm-tgmode.json). Файла нет — версия
// приложения старше этой функции, и агент просто не услышит имени.
function subName(cards, home) {
  const h = String(home || '').trim();
  if (!h) return '';
  for (const c of Array.isArray(cards) ? cards : []) {
    if (String((c && c.home) || '') !== h) continue;
    const name = String((c && c.name) || '').trim();
    if (name) return name;
  }
  return '';
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
  let nightCustom = '';
  let autoSessions = [];
  let restartModes = null;
  let digestModes = null;
  try {
    const tg = await readJsonBeside('swarm-tgmode.json');
    tgSessions = tg.sessions || [];
    // «Где я» лежит в том же файле: приложение переписывает его при каждом переключении.
    // Нет поля (файл от прежней версии) — ведём себя как раньше, по списку сессий.
    presence = String(tg.presence || '');
    // Своя формулировка ночного правила лежит там же: приложение переписывает файл при каждой
    // правке. Нет поля (файл от прежней версии) — берём заготовку.
    nightCustom = String(tg.nightRule || '');
    // Вкладки со своим мандатом «работай без меня». Список сессий, как и у режима телефона:
    // хук знает про вкладку только её id разговора.
    autoSessions = Array.isArray(tg.auto) ? tg.auto.map(String) : [];
    // Включён ли перезапуск. Нет поля (файл от прежней версии) — молчим про самозвон: обещать
    // дверь, которой может не быть, хуже, чем не обещать. Имя файла считаем сами, из id разговора.
    restartModes = (tg.restart && typeof tg.restart === 'object') ? tg.restart : null;
    // Включён ли дайджест вкладки. Та же логика, что у restartModes: файла от прежней версии
    // сворма нет — молчим, обещанная дверь, которую сворм не откроет, хуже, чем не обещать.
    digestModes = (tg.digest && typeof tg.digest === 'object') ? tg.digest : null;
  } catch (_) { /* none */ }
  // Карточки подписок — ради их ИМЁН: агент должен знать не только «7д 84%», но и чья это
  // подписка. Файла нет (приложение старше) — молчим про имя, числа от этого не страдают.
  let subCards = [];
  try {
    const sub = await readJsonBeside('swarm-subs.json');
    subCards = Array.isArray(sub && sub.cards) ? sub.cards : [];
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
      const out = outputFor(payload, matcher, tgSessions, presence,
        { usage, nightRule: nightCustom, autoSessions, restart: restartModes, digest: digestModes, subCards });
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
  nightRule, nightRuleText, summaryNote, gatesSubagent, permitDecision, permitsCommand, permitReason, PERMIT_GIT,
  usageNote, subName, pickUsage, fmtEta, GATE_FIVE, GATE_SEVEN,
  selfRestartNote, restartFileFor, digestNote, digestFileFor };
