'use strict';
// What we ASK THE AGENT to do so the tab can tell «работает» from «ждёт ответа».
//
// The status channels we own are deterministic because the HARNESS emits them: the
// hooks print an invisible OSC marker (see hooks/swarm-signal.mjs, osc.js), the
// screen detector reads the pty. The one thing no harness can know is intent — a
// turn that ended with a question looks exactly like a turn that ended done. That
// part has to come from the agent, so it needs a convention, and a convention only
// works if somebody teaches it. This module is that text:
//
//   systemPromptRule() — one line for `claude --append-system-prompt`, injected by
//     main at launch (see injectAgentRules). Costs the user nothing to set up and
//     touches no file of theirs, but lives only inside command lines SWARM composes:
//     injectAgentRules отступает, если человек передал свой --append-system-prompt
//     или если лончер не распознан как Claude (свой алиас, обёртка, скрипт).
//
// Раньше рядом жила вторая форма — блок для чужого CLAUDE.md под кнопкой «скопировать
// правило» в настройках. Она ушла вместе со всем блоком «Как агент зовёт вас»: правило
// приложение подставляет само, а настройки, которую нельзя не выбрать правильно, быть не
// должно. Если запасной путь понадобится снова, он вернётся не настройкой, а подсказкой в
// том месте, где сворм УЖЕ знает, что флагом до агента не дошёл.
//
// Правило учит ТЕГАМ (ask-phrases.js ASK_TAG / WAIT_TAG). Метку в тексте
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
// Обычный CommonJS, без двойного режима: рендереру этот модуль больше не нужен —
// единственным его читателем в браузере была кнопка «скопировать правило». А раз
// require() здесь доступен, теги и фраза БЕРУТСЯ из ask-phrases.js, а не дублируются.
// Раньше они стояли копией — модуль подключался простым <script>, — и совпадение
// приходилось прибивать тестом; теперь учить не тому тегу, который ищет сопоставитель,
// стало нельзя по построению.
const { DEFAULT_ASK_PHRASES, TAG_NS, ASK_TAG, WAIT_TAG } = require('./ask-phrases');

const DEFAULT_MARKER = DEFAULT_ASK_PHRASES[0];

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

module.exports = {
  DEFAULT_MARKER, TAG_NS, ASK_TAG, WAIT_TAG,
  systemPromptRule,
};
