'use strict';
// The phrases an agent uses to CALL the user — «Сейчас от тебя: …» and whatever else
// the user teaches their agents to sign off with. This is the ONE thing neither the
// hooks nor the screen can tell us on their own: Claude ending its turn looks
// identical whether the work is done or a question was asked in prose. So the phrase
// is the marker, and since it's a convention from the user's own CLAUDE.md (not a
// Claude Code feature), it has to be configurable — hence this module.
//
// Three consumers, one source of truth:
//   • screen.js — scraping the terminal (sessions without hooks);
//   • hooks/swarm-signal.mjs — reading Stop's `last_assistant_message`;
//   • the settings UI — the live «позовёт / не позовёт» check, which MUST agree with
//     the real thing, so it runs this same matcher (window.SWARM_ASK_PHRASES).
// The hook is a standalone ESM script with no app imports, so it can't require this.
// Instead the app COMPILES the matcher here and writes the two regex sources into
// swarm-phrases.json (see main.js); the hook only applies them. That way the phrase
// logic lives in one tested place and the hook stays dumb.
//
// Dual-mode like renderer/tabstyle.js: module.exports under Node (main, screen.js,
// tests), window.SWARM_ASK_PHRASES in the renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_ASK_PHRASES = api;
})(typeof self !== 'undefined' ? self : this, function () {

// --- ТЕГИ: основной канал ------------------------------------------------------
// Метка в тексте нужна потому, что событие «ход кончился» приходит одинаковым во всех
// трёх случаях: сделал дело, спросил прозой, ждёт свою фоновую задачу. Различить их
// можно только по тому, что агент написал.
//
// Теги, а не фраза, потому что фраза — естественная речь, и понимать её приходилось
// тремя регулярками с русской морфологией: сама метка, хвост «ничего/жди» («мне от тебя
// ничего не надо») и хвост «жду» в первом лице («ждёт агент, работа идёт»). Разница
// между «жди результата» и «жду замер» — в лице глагола, и это единственный признак.
// Тег снимает всю эту морфологию: он либо есть, либо нет.
//
// Обе формы, русская и английская, зашиты и НЕ настраиваются: это протокол, а не вкус,
// и человеку, который пишет агенту по-английски, не нужно за этим идти в настройки.
//
// Невидимые символы тут не годятся, хотя хук читает строку и ему всё равно: модель должна
// каждый раз воспроизвести точный невидимый кодпоинт, и ни markdown-рендер, ни обрезка
// пробелов, ни копипаста, ни телега не должны его нормализовать — а когда это ломается,
// никто не видит, ПОЧЕМУ: сообщение выглядит правильным, вкладка молчит. Видимый тег
// отлаживается глазами.
const ASK_TAGS = ['вопрос', 'question'];        // жду человека
const WAIT_TAGS = ['фон', 'background'];        // жду свою фоновую задачу; человек не нужен
// Третья метка, и она про КОНЕЦ РАБОТЫ, а не про ожидание. Нужна ровно одному: вкладке с
// мандатом «работай без меня». Такая вкладка красится целиком в свой цвет, и по ней не
// отличить «идёт третий час работы» от «всё сдано, можно читать итог»: между ходами агент
// молчит, и молчание выглядит одинаково. Приложение этого знать не может — конец ЗАДАЧИ (а не
// хода) виден только самому агенту, — поэтому он и говорит это сам.
//
// «Ход кончился» тегом не помечают: это событие приходит от хука и так. Здесь про другое —
// «я больше сам не продолжу», то есть про то, чего в событии нет.
const DONE_TAGS = ['готово', 'done'];           // задача кончилась целиком; сам не продолжу

// Приставка. Без неё меткой было любое `[вопрос]` в тексте — и агент, пишущий про сам
// протокол (в доке, в отчёте, в этой самой переписке), звал человека нечаянно. Приставка
// делает метку непохожей ни на что, что встречается в обычной речи и в примерах кода:
// «[swarm:…]» пишут только те, кто пишет сворму.
const TAG_NS = 'swarm';

// Чему УЧИМ агента — одна форма из каждой пары. Понимаем все, но в правиле называем одну:
// выбор из двух написаний в инструкции — это не свобода, а лишнее решение на каждом ходу.
// Отсюда же их берут ночное правило и отказ от коробки с вариантами: текст, который агент
// получает, обязан называть ту самую метку, которую мы потом ищем.
const ASK_TAG = '[' + TAG_NS + ':' + ASK_TAGS[0] + ']';
const WAIT_TAG = '[' + TAG_NS + ':' + WAIT_TAGS[0] + ']';
const DONE_TAG = '[' + TAG_NS + ':' + DONE_TAGS[0] + ']';

// Метка стоит В НАЧАЛЕ СТРОКИ, и это не косметика, а вторая половина защиты от путаницы.
// Приставка спасает от случайного слова, место — от НАМЕРЕННОГО упоминания: агент, который
// объясняет протокол или цитирует доку, называет метку внутри фразы, и там она не значит
// ничего. Позиция работает одинаково во всех трёх каналах, в том числе на экране, где границ
// сообщения нет вовсе и «начало сообщения» спросить не у кого.
//
// Требовать метку ОДНУ на строке было бы строже, но дороже: агент, написавший
// «[swarm:вопрос] что ставим?» одной строкой, остался бы незамеченным — вкладка позеленела бы,
// хотя ждёт ответа. Молчание дороже лишнего зова, поэтому хватает начала строки.
//
// Приставку в скобках терпим и без неё: короткую форму `[вопрос]` агенты уже могли выучить из
// чужих CLAUDE.md и старых эстафет, и перестать её узнавать значит молча потерять зов. Путаницы
// от неё теперь нет — за это отвечает начало строки.
//
// Внутри скобок терпим пробелы и любой регистр: [swarm:вопрос], [ Swarm : Вопрос ], [QUESTION].
function tagAlt(words) {
  return '(?:\\[\\s*(?:' + TAG_NS + '\\s*:\\s*)?(?:' + words.join('|') + ')\\s*\\])';
}
// Начало строки — с двумя поправками, и каждая закрывает свой канал.
//
// РАЗМЕТКА: агент выделяет метку жирным или кодом, и в стенограмме это `**[swarm:вопрос]**`.
// Экран разметки не видит (терминалу она достаётся уже разобранной), а стенограмма и хук
// читают исходный текст — без этой поправки метка терялась бы ровно у половины каналов.
//
// МАРКЕР ⏺: это ЭКРАН, и без него правило «с начала строки» ломалось бы ровно там, куда мы
// метку и просим ставить. Claude Code печатает первую строку своего сообщения как «⏺ текст»,
// продолжение — с отступом. Значит тег ПЕРВОЙ строкой достаётся экрану как «⏺ [swarm:вопрос]»,
// и без поправки он находился бы только в середине и в конце сообщения — то есть вкладка без
// хуков молча не звала бы. Проверять снимок построчно нельзя: зов ищется по всей переписке
// сразу (screen.js asksForInput), и мебель оттуда не вычищена.
const TAG_BULLET = '(?:[⏺●]\\s*)?';
const TAG_DECOR = '[ \\t]*' + TAG_BULLET + '[ \\t]*(?:\\*{1,2}|_{1,2}|`)?[ \\t]*';
const LINE_LEAD = '(?:^|\\r?\\n)' + TAG_DECOR;   // для поиска метки в тексте
const TAIL_LEAD = '(?:\\r?\\n)?' + TAG_DECOR;    // хвост начинается РОВНО с этого места

function tagLine(words) { return LINE_LEAD + tagAlt(words); }

const ASK_TAG_SRC = tagAlt(ASK_TAGS);
const WAIT_TAG_SRC = tagAlt(WAIT_TAGS);
const DONE_TAG_SRC = tagAlt(DONE_TAGS);
// Голая форма, без привязки к строке: ею метку ВЫЧИЩАЮТ из выжимки для подсказки и телеги,
// а там неважно, где она стояла.
const ALL_TAGS = ASK_TAGS.concat(WAIT_TAGS, DONE_TAGS);
const ANY_TAG_SRC = tagAlt(ALL_TAGS);
const ANY_TAG_LINE_SRC = tagLine(ALL_TAGS);

// --- ФРАЗЫ: путь совместимости --------------------------------------------------
// Соглашение, которое было до тегов. Оставлено и поддерживается наравне: у людей эта
// фраза лежит в своих CLAUDE.md и в привычках, и молча перестать её понимать значит
// сломать вкладки у тех, кто ничего не менял.
//
// What ships out of the box. Matches the sign-off the task skills use.
const DEFAULT_ASK_PHRASES = ['Сейчас от тебя'];

// A phrase alone isn't a request: «Сейчас от тебя: ничего, жди результата» is the
// OPPOSITE — the agent says it needs nothing. So every phrase gets this tail check,
// and a hit here cancels the call. Not user-editable: it's about Russian wording,
// not about the marker, and getting it wrong would silently kill the signal.
//
// Между фразой и словом «ничего» пропускаем и пробелы, и знаки, и РАЗМЕТКУ: агент выделяет
// зов жирным, и в стенограмме это `**Сейчас от тебя:** ничего`. Экран такого не видел —
// терминалу разметка достаётся уже разобранной, звёздочек в нём нет, — а стенограмма и хук
// читают исходный текст, и на звёздочках проверка обрывалась: «ничего» переставало
// находиться, и вкладка честного «мне ничего не нужно» красилась как «ждёт ответа».
const NONE_TAIL = '[\\s:.\\u2014*_`~-]*(?:ничего|жд[иёе]|ждать|ждите|подожди(?:те)?|дождись|дождитесь|не\\s+(?:нужно|требуется|надо))';

// Третий случай, и он не про человека, а про АГЕНТА: «Сейчас от тебя: ничего, жду замер
// стенда». От тебя правда ничего не нужно — но и работа не кончилась: агент запустил
// фоновую задачу, ход закрыл, и его разбудит её завершение. Вкладка при этом красилась
// зелёной, то есть «свободна, дай задачу», хотя давать ей нечего.
//
// Отличие от NONE_TAIL — В ЛИЦЕ глагола, и это не придирка, а единственный признак,
// который есть в самой фразе: «жди результата» — повелительное, обращено к тебе и
// значит «я закончил»; «жду замер» — первое лицо, ждёт агент, значит работа идёт.
// Поэтому здесь только формы первого лица, и проверяются они РАНЬШЕ NONE_TAIL: «ничего,
// жду сборку» начинается со слова «ничего», и без порядка этот случай уходил бы в
// «готов» по первому же слову.
//
// Между фразой и глаголом пропускаем только «ничего» и знаки — не произвольные слова.
// Иначе «Сейчас от тебя: решение по схеме, жду ответа» (настоящий зов!) читалось бы как
// фоновая работа, и вкладка молчала бы вместо того, чтобы звать.
// Конец слова здесь пишется как «дальше не буква», а НЕ как \b: границу слова JS считает
// по [A-Za-z0-9_], кириллица в неё не входит, и «жду» с \b на конце не находилось вообще.
const WAIT_GAP = '[\\s:.,\\u2014*_`~-]*';
const WAIT_END = '(?![а-яёА-ЯЁa-zA-Z])';
const WAIT_TAIL = `${WAIT_GAP}(?:ничего${WAIT_GAP})?(?:жду|ждём|ждем|дождусь|дожидаюсь|ожидаю)${WAIT_END}`;

const MAX_PHRASES = 12;   // a sane ceiling; the regex is run on every tick
const MAX_LEN = 60;       // one phrase, not a paragraph

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Clean whatever came from the settings box: trim, drop empties, cap length and
// count, de-dupe case-insensitively. Empty input => the defaults (never no marker).
function normalizePhrases(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_PHRASES) break;
  }
  return out.length ? out : DEFAULT_ASK_PHRASES.slice();
}

// The regex SOURCES (strings, so they survive JSON on the way to the hook):
//   mark    — ЛЮБАЯ метка: тег с начала строки или фраза. По ней ищется последнее вхождение;
//   tagAsk  — тег зова, привязанный к началу хвоста;
//   tagWait — тег фоновой работы, там же;
//   tagDone — тег «задача кончилась», там же;
//   none    — фраза с хвостом «ничего/жди»;
//   wait    — фраза с хвостом «жду …» в первом лице (см. WAIT_TAIL).
// Теги идут в mark вместе с фразами: иначе последним вхождением оказалась бы фраза из
// позапрошлого хода, а свежий тег остался бы незамеченным.
//
// В mark тег привязан к началу строки, а в tagAsk/tagWait — к началу хвоста, и это одно и то
// же место: хвост берётся РОВНО от найденной метки, то есть начинается с того самого перевода
// строки. Врозь эти два источника разъехаться не могут — их собирает одна пара LINE_LEAD /
// TAIL_LEAD.
function phraseSources(list) {
  const alt = normalizePhrases(list).map(escapeRe).join('|');
  return {
    mark: `(?:${ANY_TAG_LINE_SRC}|${alt})`,
    tagAsk: `^${TAIL_LEAD}${ASK_TAG_SRC}`,
    tagWait: `^${TAIL_LEAD}${WAIT_TAG_SRC}`,
    tagDone: `^${TAIL_LEAD}${DONE_TAG_SRC}`,
    none: `(?:${alt})${NONE_TAIL}`,
    wait: `(?:${alt})${WAIT_TAIL}`,
  };
}

// Compiled form for in-process use.
function buildAskMatcher(list) {
  const src = phraseSources(list);
  return {
    mark: new RegExp(src.mark, 'i'),
    tagAsk: new RegExp(src.tagAsk, 'i'),
    tagWait: new RegExp(src.tagWait, 'i'),
    tagDone: new RegExp(src.tagDone, 'i'),
    none: new RegExp(src.none, 'i'),
    wait: new RegExp(src.wait, 'i'),
  };
}

// Хвост текста от ПОСЛЕДНЕГО вхождения фразы — и разбирать надо именно его.
//
// Экран — это переписка целиком: над свежим «Сейчас от тебя: ничего» вполне висит
// позавчерашнее «Сейчас от тебя: путь к схеме», и проверка «фраза есть, а хвоста
// „ничего“ где-то нет» отвечала по СМЕСИ двух ходов. Живьём это выглядело как вкладка,
// которая молчит про новый зов, потому что в старом было «ничего». Последнее вхождение —
// это то, что агент сказал последним, и только оно описывает текущее положение дел.
function tailFrom(matcher, text) {
  const t = String(text == null ? '' : text);
  if (!matcher || !matcher.mark) return null;
  const re = new RegExp(matcher.mark.source, 'gi');
  let idx = -1;
  let m;
  while ((m = re.exec(t)) !== null) {
    idx = m.index;
    if (m.index === re.lastIndex) re.lastIndex++;   // пустое совпадение не должно зациклить
  }
  return idx < 0 ? null : t.slice(idx);
}

// Что означает последняя фраза агента:
//   'ask'  — зовёт: нужен ответ, выбор или решение;
//   'wait' — от человека ничего, но работа продолжается сама (фоновая задача);
//   'done' — задача кончилась целиком: агент сам не продолжит и ничего не ждёт;
//   null   — фразы нет, либо она говорит «мне ничего не нужно» (ход закончен).
function callKind(matcher, text) {
  const tail = tailFrom(matcher, text);
  if (tail == null) return null;
  // Тег стоит В НАЧАЛЕ хвоста — хвост и начинается с последней метки. Тег отвечает сам
  // за себя и разбора хвоста не требует: в этом вся его польза.
  if (matcher.tagAsk && matcher.tagAsk.test(tail)) return 'ask';
  if (matcher.tagWait && matcher.tagWait.test(tail)) return 'wait';
  // Тег конца работы проверяем среди тегов, а не в конце: последней меткой он и стоит, а
  // упасть в разбор фраз ниже значило бы вернуть 'ask' по правилу «метка есть, хвост не
  // „ничего“» — то есть покрасить сдавшую работу вкладку в «ждёт ответа».
  if (matcher.tagDone && matcher.tagDone.test(tail)) return 'done';
  if (matcher.wait && matcher.wait.test(tail)) return 'wait';
  if (matcher.none && matcher.none.test(tail)) return null;
  return 'ask';
}

// True only for a REAL call: a phrase is present and it isn't a «ничего/жди/жду» one.
function asksWith(matcher, text) {
  return callKind(matcher, text) === 'ask';
}

// True when the agent said it keeps working without you.
function waitsWith(matcher, text) {
  return callKind(matcher, text) === 'wait';
}

// Агент сказал, что ЗАДАЧА кончилась: не ход, а вся работа — сам он больше не продолжит.
// Смысл есть только у вкладки с мандатом: по этому и отличают «работает без меня» от
// «отработала». См. DONE_TAGS.
function saysDone(matcher, text) {
  return callKind(matcher, text) === 'done';
}

// Агент сказал ПРЯМО, что от человека ничего не нужно: подпись есть, и она не зов — всё равно,
// «ничего» это или «ничего, жду фиксы». Отличается от `callKind(...) !== 'ask'` тем, что молчание
// подписью не считает: ход без неё вообще ничего не сообщает о том, ждут ли ответа, и обращаться с
// ним надо как с обычным ответом человеку.
//
// Нужно перезапуску: строгая пометка «человек этого не видел» держится до ОТВЕТА человека, а
// отвечать на «от тебя ничего» он не станет — см. unread.onTurnEnd.
function saysNone(matcher, text) {
  const tail = tailFrom(matcher, text);
  return tail != null && callKind(matcher, text) !== 'ask';
}

// WHAT the agent is asking, as text — for the pult tooltip, the notification and
// the Telegram bridge. Collapses blank lines and caps the length: a chip tooltip is
// not a place for a page of text.
//
// Откуда резать — зависит от того, ЧЕМ агент позвал, и это не придирка.
//   • Фраза («Сейчас от тебя: путь к схеме») сама и есть просьба, поэтому режем ОТ неё:
//     отчёт выше человеку в уведомлении не нужен.
//   • Тег просьбы не содержит — он только говорит «я жду». Сам вопрос стоит в КОНЦЕ
//     сообщения (агент дописывает его последним абзацем), поэтому здесь берём хвост.
// Раньше обе ветки резали от начала найденного места, и на теге в уведомление уезжало
// начало отчёта — то есть ровно то, чего человеку знать не надо, чтобы ответить.
function askExcerpt(matcher, text, max) {
  // Тег из выжимки вычищаем — человеку нужен вопрос, а не служебная метка. Вычищаем ГОЛОЙ
  // формой, без привязки к строке: неважно, где тег стоял, из текста он уходит весь.
  const t = String(text == null ? '' : text).replace(new RegExp(ANY_TAG_SRC, 'gi'), ' ')
    .replace(/[ \t]{2,}/g, ' ').trim();
  if (!t) return '';
  const cap = max || 500;
  // Тег из текста уже вычищен, так что здесь совпасть может только ФРАЗА — и это то, что
  // нам и нужно знать: есть фраза — режем от неё, нет — значит звали тегом.
  const hit = matcher && matcher.mark ? t.match(matcher.mark) : null;
  const flatten = (s) => s.replace(/\s*\n\s*\n\s*/g, ' — ').replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
  if (hit && hit.index != null) {
    const flat = flatten(t.slice(hit.index));
    return flat.length > cap ? flat.slice(0, cap - 1).trimEnd() + '…' : flat;
  }
  const flat = flatten(t);
  if (flat.length <= cap) return flat;
  // Многоточие СПЕРЕДИ — оно и говорит «текст обрезан слева». Первое слово в срезе почти
  // всегда разрублено пополам, поэтому его выбрасываем: половина слова читается как опечатка.
  return '…' + flat.slice(flat.length - (cap - 1)).replace(/^\S*\s+/, '');
}

// The default sources, so the hook's own fallback can be pinned against them.
const DEFAULT_SOURCES = phraseSources(DEFAULT_ASK_PHRASES);

return {
  DEFAULT_ASK_PHRASES, DEFAULT_SOURCES, MAX_PHRASES, MAX_LEN,
  TAG_NS, ASK_TAGS, WAIT_TAGS, DONE_TAGS, ASK_TAG, WAIT_TAG, DONE_TAG,
  normalizePhrases, phraseSources, buildAskMatcher, callKind, asksWith, waitsWith, saysDone, saysNone,
  askExcerpt,
};

});
