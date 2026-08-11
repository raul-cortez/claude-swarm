// launch-word.js — «а это вообще запуск агента?» и «чем открывать вкладку заново».
// Dual-mode: window.SWARM_LAUNCH в окне, module.exports под Node для тестов.
// Только чистые функции — ни DOM, ни состояния.
//
// Живёт отдельным модулем, потому что цена ошибки здесь не видна в ревью и громко
// слышна в работе: вкладка, запомнившая не тот лончер, после перезапуска возвращается
// ДРУГИМ аккаунтом — с чужими лимитами, чужими плагинами и чужим разговором.
(function (root, factory) {
  const resume = (typeof module !== 'undefined' && module.exports)
    ? require('./resume')
    : root.SWARM_RESUME;
  const api = factory(resume);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_LAUNCH = api;
})(typeof self !== 'undefined' ? self : this, function (resume) {
  // Флаги в хвосте команды. Три формы, и все три встречаются у Клода:
  //   --fork-session            (без значения)
  //   --model=opus              (со значением через =)
  //   --permission-mode auto    (значение отдельным словом)
  // Третья добавлена не для красоты: без неё набранное руками
  // `claude-my --permission-mode auto` не считалось запуском вовсе, вкладка не
  // привязывалась к алиасу и после перезапуска открывалась рабочим аккаунтом.
  // Значение — «слово без кавычек и пробелов»: так `claude -p "сделай X"` намеренно
  // не считается запуском вкладки (это одноразовый прогон, а не агент в терминале),
  // и любая фраза с пробелами не рискует сойти за флаг со значением.
  const FLAG_TAIL = '(?:\\s+--?[\\w-]+(?:=\\S+)?(?:\\s+[\\w./:@~,+=-]+)?)*';
  // Известные ИМЕНА лончеров (стем, не любое слово), чтобы `ls` и `git commit` не
  // сходили за запуск. `cursor-agent`/`agent` — это Cursor; одним словом в строке
  // терминала «agent» ничем другим и не бывает.
  const STEMS = 'claude|cld|glm|deepseek|codex|gemini|aider|qwen|kimi|opencode|crush'
    + '|amp|droid|cursor|cursor-agent|agent';
  const AGENT_CMD_RE = new RegExp('^\\s*(?:' + STEMS + ')[\\w-]*' + FLAG_TAIL + '\\s*$', 'i');
  // Хвост из одних флагов — чтобы «agent --resume» считалось запуском, а «agent smith» нет.
  const AGENT_FLAGS_RE = new RegExp('^' + FLAG_TAIL + '\\s*$');

  // Первое слово строки, если строка похожа на запуск агента; иначе null.
  //
  // Команды из СПИСКА АГЕНТОВ пользователя (Настройки → Запуск) — тоже маркеры запуска,
  // и это главный из двух путей: список ведёт он сам, а зашитый набор имён неизбежно
  // отстаёт от того, чем человек пользуется.
  function launchWordFrom(line, launchList) {
    const t = String(line || '').trim();
    const word = t.split(/\s+/)[0] || '';
    if (!word) return null;
    const list = Array.isArray(launchList) ? launchList : [];
    const listed = list.some((a) => String((a && a.cmd) || '').trim() === word)
      && AGENT_FLAGS_RE.test(t.slice(word.length));
    return (listed || AGENT_CMD_RE.test(t)) ? word : null;
  }

  // Алиас РАЗВЁРНУЛСЯ: вкладка помнит `claude-my`, а в процессах крутится `claude`.
  // Смысл: `alias claude-my='CLAUDE_CONFIG_DIR=~/.claude-my command claude'` — шелл
  // подменяет слово ещё до exec, поэтому ps честно показывает `claude`, и наблюдатель
  // за процессом (session:proc) затирал вкладке лончер на менее точный. Вкладка теряла
  // личный аккаунт: возвращалась рабочим, без --settings со строкой статуса Swarm,
  // без лимитов подписки в ней и с чужим разговором в --resume.
  //
  // Проверка узкая — не «оба Клоды», а «запомненное имя НАЧИНАЕТСЯ с увиденного»:
  // ровно то, что бывает при разворачивании обёртки (claude-my, claude-glm → claude).
  // Смену агента внутри вкладки (claude → cursor, claude → cld) это не задевает,
  // так что главный путь наблюдателя работает как работал.
  function isAliasExpansion(remembered, reported) {
    if (!remembered || !reported) return false;
    if (!resume.supports(remembered) || !resume.supports(reported)) return false;
    const mine = resume.stemOf(remembered);
    const theirs = resume.stemOf(reported);
    return mine !== theirs && mine.startsWith(theirs);
  }

  // Ярлык команды в списке и в меню: `cmd` вместе со своими флагами.
  function agentLabel(a) {
    const cmd = String((a && a.cmd) || '').trim();
    const flags = String((a && a.flags) || '').trim();
    return (cmd + (flags ? ' ' + flags : '')).trim();
  }

  // Пункт «открыть вкладку без команды» — он же подпись такой вкладки в меню.
  const BLANK_LABEL = 'Чистый терминал';

  // Пункты меню названы ДЕЙСТВИЕМ, а не именем команды: человек, открывающий вкладку, думает
  // «ещё одну такую же» или «эту же папку, но другим режимом», а не `claude-my`.
  const NEW_TAB = 'Новая вкладка';
  const OTHER_SUB = 'Новая вкладка с выбором режима';

  // Пункты меню, которое разворачивает «+» на папке. null — меню не нужно, открывай сразу.
  //
  // Здесь, а не в рендерере, потому что цена ошибки — вопрос, заданный человеку зря, или
  // молча унаследованный аккаунт, которого он не выбирал:
  //   mode 'blank'      — вкладки открываются чистым терминалом, выбирать нечего;
  //   pick 'always'     — спросит сам resolveLaunch, и меню было бы вторым вопросом подряд;
  //   одна команда      — выбирать не из чего;
  //   папка пуста       — в режиме 'folder' спросит resolveLaunch (первая вкладка папки).
  // Первым пунктом всегда сегодняшнее поведение — как открывались соседи по папке, — чтобы
  // привычный путь остался кликом по «+» и следующим кликом по верхнему пункту, без раздумий.
  // Вторым — то же окно выбора, каким встречает первая вкладка новой папки.
  //
  // Пунктов РОВНО два, без подсказок справа и без вариантов. Ни имя наследуемой команды, ни
  // имя единственной «другой» под кнопкой не показываются: человек в этот момент решает «так
  // же или выбрать», а не читает `claude-my --permission-mode auto`. Какой именно режим —
  // спрашивает окно выбора, и оно же остаётся единственным местом, где команды перечислены.
  //
  // `inherited`: { cmd, flags } | { blank: true } | null — чем открылась первая вкладка папки.
  function launchMenuEntries({ mode, pick, list, inherited } = {}) {
    if (mode !== 'agent' || pick !== 'folder' || !inherited) return null;
    const agents = (Array.isArray(list) ? list : []).filter((a) => a && a.cmd);
    if (agents.length <= 1) return null;
    return [
      { label: NEW_TAB, val: {} },
      { label: OTHER_SUB, val: { pick: true } },
    ];
  }

  return {
    launchWordFrom, isAliasExpansion, agentLabel, launchMenuEntries,
    BLANK_LABEL, NEW_TAB, OTHER_SUB,
    AGENT_CMD_RE, AGENT_FLAGS_RE,
  };
});
