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
//   mark — any of the phrases;  none — a phrase followed by a «ничего/жди» tail;
//   wait — a phrase followed by a first-person «жду …» tail (see WAIT_TAIL).
function phraseSources(list) {
  const alt = normalizePhrases(list).map(escapeRe).join('|');
  return { mark: `(?:${alt})`, none: `(?:${alt})${NONE_TAIL}`, wait: `(?:${alt})${WAIT_TAIL}` };
}

// Compiled form for in-process use.
function buildAskMatcher(list) {
  const src = phraseSources(list);
  return {
    mark: new RegExp(src.mark, 'i'),
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
//   null   — фразы нет, либо она говорит «мне ничего не нужно» (ход закончен).
function callKind(matcher, text) {
  const tail = tailFrom(matcher, text);
  if (tail == null) return null;
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

// WHAT the agent is asking, as text — for the pult tooltip, the notification and
// (later) the Telegram bridge. The whole closing message is usually a report ending
// with the request, so the useful part starts AT the phrase: «Сейчас от тебя: путь к
// схеме». Falls back to the tail of the message when no phrase matched, because a
// waiting agent still has to show something. Collapses blank lines and caps the
// length — a chip tooltip is not a place for a page of text.
function askExcerpt(matcher, text, max) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  const cap = max || 500;
  const hit = matcher && matcher.mark ? t.match(matcher.mark) : null;
  const from = hit && hit.index != null ? t.slice(hit.index) : t.slice(-cap * 2);
  const flat = from.replace(/\s*\n\s*\n\s*/g, ' — ').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length > cap ? flat.slice(0, cap - 1).trimEnd() + '…' : flat;
}

// The default sources, so the hook's own fallback can be pinned against them.
const DEFAULT_SOURCES = phraseSources(DEFAULT_ASK_PHRASES);

return {
  DEFAULT_ASK_PHRASES, DEFAULT_SOURCES, MAX_PHRASES, MAX_LEN,
  normalizePhrases, phraseSources, buildAskMatcher, callKind, asksWith, waitsWith, askExcerpt,
};

});
