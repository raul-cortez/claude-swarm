'use strict';
// What we ASK THE AGENT to do so the tab can tell «работает» from «ждёт ответа».
//
// The status channels we own are deterministic because the HARNESS emits them: the
// hooks print an invisible OSC marker (see hooks/swarm-signal.mjs, osc.js), the
// screen detector reads the pty. The one thing no harness can know is intent — a
// turn that ended with a question looks exactly like a turn that ended done. That
// part has to come from the agent, so it needs a convention, and a convention only
// works if somebody teaches it. This module is that text, in two shapes:
//
//   systemPromptRule() — one line for `claude --append-system-prompt`, injected by
//     main at launch (see injectAgentRules). Costs the user nothing to set up and
//     touches no file of theirs, but lives only inside command lines SWARM composes:
//     injectAgentRules отступает, если человек передал свой --append-system-prompt,
//     если лончер не распознан как Claude (свой алиас, обёртка, скрипт) — и, конечно,
//     если человек набрал `claude` руками в чистой вкладке.
//   claudeMdRule()     — a markdown block for the user's own CLAUDE.md, offered as
//     a copy button in Settings. Ровно для трёх случаев выше: экран за агентом следят
//     и там, а правило флагом до него не дошло. «Вне сворма» правило не нужно никому:
//     снаружи нет вкладки, которую надо красить.
//
// Both teach the same thing: ТЕГИ (ask-phrases.js ASK_TAG / WAIT_TAG). Метку в тексте
// заменить нечем — событие «ход кончился» приходит одинаковым и когда дело сделано, и
// когда задан вопрос прозой, — но метка теперь не естественная фраза, а тег, и правило
// от этого стало короче: учить нечему, кроме «начни сообщение строкой [swarm:вопрос]».
//
// Место названо ОДНО — начало сообщения, — хотя сопоставитель принимает тег с начала любой
// строки, в том числе последней. Это не рассинхрон, а разница между «что мы понимаем» и «чему
// учим»: выбор из двух равноправных мест — лишнее решение на каждом ходу, а лишняя терпимость
// в разборе бесплатна и спасает того, кто выучил тег из чужой доки.
//
// Побочно и важно: в правиле больше НЕТ пользовательского текста. Раньше в него
// подставлялась первая фраза из настроек, и её приходилось чистить от кавычек, `$` и
// бэктиков — на запасном пути правило попадает прямо в командную строку. Теперь это
// константа, и чистить нечего.
//
// The FIRST rule (ask via AskUserQuestion) is the better one: a tool call gives the
// PreToolUse hook an exact signal plus the question text, with no text matching at
// all. The phrase is the fallback for questions that stay in prose.
//
// Dual-mode like ask-phrases.js: module.exports under Node (main, tests),
// window.SWARM_AGENT_RULES in the renderer (the copy button).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_AGENT_RULES = api;
})(typeof self !== 'undefined' ? self : this, function () {

// Kept in sync with ask-phrases.js DEFAULT_ASK_PHRASES[0] by a test. Duplicated
// rather than required, because this module is also loaded as a plain script in the
// renderer, where there is no require().
const DEFAULT_MARKER = 'Сейчас от тебя';

// Теги — то же дублирование по той же причине: этот модуль подключается в рендерере
// простым <script>, где require недоступен. Совпадение с ask-phrases.js сверяется тестом.
const TAG_NS = 'swarm';
const ASK_TAGS = ['вопрос', 'question'];
const WAIT_TAGS = ['фон', 'background'];
const ASK_TAG = '[' + TAG_NS + ':' + ASK_TAGS[0] + ']';
const WAIT_TAG = '[' + TAG_NS + ':' + WAIT_TAGS[0] + ']';

// The CLAUDE.md block is fenced with markers so it can be found and replaced whole
// instead of piling up copies. The user may edit the text inside; we never write
// this file ourselves — it's theirs — the markers are for THEM (and for a future
// «обновить правило»).
const MD_BEGIN = '<!-- claude-swarm-lite:begin -->';
const MD_END = '<!-- claude-swarm-lite:end -->';

// ONE LINE, on purpose: on the fallback path it goes inside double quotes on a shell
// command line, where a newline would end the command.
function systemPromptRule() {
  return [
    'Ты работаешь внутри Swarm: пользователь видит статус этой вкладки со стороны',
    'и может смотреть на неё из другой вкладки или с телефона, поэтому момент, когда ты ждёшь его,',
    'должен быть виден. Когда тебе нужен ответ, выбор или решение пользователя — задавай вопрос',
    'инструментом AskUserQuestion, а не только текстом. Если вопрос всё-таки остаётся в тексте,',
    `начни сообщение отдельной строкой с тегом ${ASK_TAG} — по нему вкладка становится «ждёт ответа».`,
    'Если ты запустил фоновую задачу и ждёшь её (замер, сборку, фонового агента), а от пользователя',
    `ничего не нужно — начни сообщение строкой ${WAIT_TAG}: вкладка останется занятой и звать не будет.`,
    'Закончил и ничего не ждёшь — не ставь никакого тега, это и значит «готов».',
    'Тег считается только с начала строки: внутри фразы, в рассуждении и в примере кода',
    'он ничего не значит, так что писать о нём можно свободно.',
  ].join(' ');
}

// The same rule as a markdown section for the user's own CLAUDE.md. Free to be
// multi-line and a bit more explicit — nothing here goes through a shell.
function claudeMdRule() {
  return [
    MD_BEGIN,
    '## Как звать меня',
    '',
    'Я смотрю на агентов через Swarm: каждая вкладка показывает статус, и я могу быть',
    'в другой вкладке или в телефоне. Вкладка не может сама понять, закончил ты работу или задал',
    'вопрос — со стороны это выглядит одинаково. Поэтому:',
    '',
    '- Нужен ответ, выбор или решение — спрашивай инструментом `AskUserQuestion`, а не только текстом:',
    '  тогда вкладка сразу покажет, что ты ждёшь, и вопрос с вариантами дойдёт до меня в телефон.',
    `- Если вопрос остаётся в тексте, начни сообщение отдельной строкой с тегом \`${ASK_TAG}\` —`,
    '  по нему вкладка становится «ждёт ответа» и зовёт меня.',
    '- Если ты запустил фоновую задачу и ждёшь её (замер, сборка, фоновый агент), а от меня ничего',
    `  не нужно — начни сообщение строкой \`${WAIT_TAG}\`: вкладка останется занятой, а меня не позовёт.`,
    '- Закончил и ничего не ждёшь — не ставь никакого тега. Это и значит «готов».',
    '',
    'Тег считается только с начала строки. Внутри фразы, в рассуждении, в примере кода и в доке',
    'он ничего не значит — писать о нём можно свободно, себя ты этим не позовёшь.',
    '',
    `По-английски тоже понимаю: \`[${TAG_NS}:${ASK_TAGS[1]}]\` и \`[${TAG_NS}:${WAIT_TAGS[1]}]\` работают так же.`,
    `Старую подпись \`${DEFAULT_MARKER}: …\` приложение тоже ещё понимает, но тег надёжнее:`,
    'его не построишь случайно в обычной фразе.',
    MD_END,
  ].join('\n');
}

return {
  DEFAULT_MARKER, TAG_NS, ASK_TAG, WAIT_TAG, MD_BEGIN, MD_END,
  systemPromptRule, claudeMdRule,
};

});
