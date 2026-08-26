// preload.js — the only bridge between the sandboxed renderer and Node/main.
//
// With contextIsolation on, the renderer has no `require`. We expose a tiny,
// explicit API on window.swarm. Nothing else leaks in. Keep this surface small.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  // The host OS ('darwin' | 'win32' | 'linux'), so the UI can drop mac-only
  // chrome (traffic-light gaps) on Windows/Linux.
  platform: process.platform,

  // Open a native folder picker (opens at defaultPath if given).
  // Returns the chosen path, or null if cancelled.
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),

  // List custom slash commands for a project dir (+ global). [{name, hint, arg, scope}]
  listCommands: (cwd) => ipcRenderer.invoke('commands:list', cwd),

  // Ask main to spawn a session. Returns { id, cwd, claudeSessionId }, where
  // claudeSessionId is the conversation this tab runs (main pins it with --session-id) —
  // the renderer saves it so the next launch can resume exactly that dialogue.
  // opts: { cwd?, cols?, rows?, command?, tabKey?, name?, resumeId? }
  // resumeId — set when `command` is a `--resume <id>`: the id being restored, so main
  // binds the transcript exactly instead of guessing by folder.
  createSession: (opts) => ipcRenderer.invoke('session:create', opts),

  // Is that conversation still on disk? Checked before restoring a tab with --resume,
  // so a deleted dialogue starts fresh instead of dropping into Claude's picker.
  canResumeSession: (cwd, sessionId) => ipcRenderer.invoke('session:canResume', cwd, sessionId),
  // То же про имя swarm-* (вкладки, сохранённые до того, как мы стали помнить id разговора).
  canResumeName: (cwd, name) => ipcRenderer.invoke('session:canResumeName', cwd, name),

  // A tab's Claude conversation changed (/clear, `claude` typed by hand, /resume in the
  // terminal). cb({ id, claudeSessionId }). Returns an unsubscribe fn.
  onClaudeSession: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:claude', handler);
    return () => ipcRenderer.removeListener('session:claude', handler);
  },

  // Чем вкладка занята на самом деле: имя команды, которая крутится в её шелле (main
  // подсматривает его в дереве процессов). Рендерер решает, агент это или нет, и если да —
  // запоминает как команду вкладки. cb({ id, cmd }). Возвращает отписку.
  onTabProcess: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:proc', handler);
    return () => ipcRenderer.removeListener('session:proc', handler);
  },

  // Send user keystrokes to a session's pty.
  sendInput: (id, data) => ipcRenderer.send('session:input', { id, data }),

  // Tell main the terminal grid changed size.
  resize: (id, cols, rows) => ipcRenderer.send('session:resize', { id, cols, rows }),

  // Close a session.
  killSession: (id) => ipcRenderer.send('session:kill', { id }),

  // В этой вкладке запустили ДРУГОГО агента руками — строка запуска, которой её открыл
  // сворм, больше не про неё (см. session:forgetLaunch).
  forgetLaunch: (id) => ipcRenderer.send('session:forgetLaunch', { id }),

  // Bring the app window forward (used when a notification is clicked).
  focusApp: () => ipcRenderer.send('app:focus'),

  // Tell main a UI action (tab switch / layout change) is about to repaint the
  // terminals — so their focus/redraw burst isn't mistaken for real activity.
  uiRepaint: () => ipcRenderer.send('ui:repaint'),

  // На какую вкладку человек смотрит прямо сейчас: активная вкладка плюс фокус окна. Знает
  // это только окно, а нужно оно main — там решают, можно ли гасить вкладку с непрочитанным
  // ответом (см. unread.js).
  reportViewing: (id, focused) => ipcRenderer.send('tabs:viewing', { id, focused }),

  // Opt-in «precise status via Claude hooks». Renderer pushes the saved pref on
  // startup and on toggle; main adds/removes the hooks block in swarm-settings.json
  // (scoped to swarm sessions). Takes effect on sessions started after the change.
  setHooksEnabled: (on) => ipcRenderer.send('settings:hooks', on),

  // «Новые вкладки стартуют в режиме»: main добавляет --permission-mode к команде запуска.
  // Пусто = не вмешиваться. Применяется к новым вкладкам, режим остаётся переключаемым.
  setPermissionMode: (mode) => ipcRenderer.send('settings:permissionMode', mode),
  // Режимы и их подписи приходят из main (screen.js — их единственный источник), чтобы
  // список в панели не разошёлся с тем, что читается с экрана. [{ id, title }]
  listModes: () => ipcRenderer.invoke('settings:modes'),

  // The tab's visible name. main keeps it only to title this tab's Telegram topic and
  // to sign its messages — pushed on create and on rename.
  setTabName: (id, name) => ipcRenderer.send('tabs:name', { id, name }),

  // Голос из телеги: main присылает байты OGG, рендерер декодирует их силами Chromium
  // (ffmpeg не нужен) и отдаёт моно 16 кГц обратно.
  onDecodeAudio: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('audio:decode', handler);
    return () => ipcRenderer.removeListener('audio:decode', handler);
  },
  audioDecoded: (reqId, samples, error) => ipcRenderer.send('audio:decoded', { reqId, samples, error }),

  // Голос одной кнопкой: main качает распознаватель и модель в профиль пользователя и
  // сам прописывает пути. Все три возвращают состояние Телеграма — панель рисуется из него.
  voiceInstall: (modelId) => ipcRenderer.invoke('voice:install', modelId),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
  voiceRemove: () => ipcRenderer.invoke('voice:remove'),

  // Показать журнал моста в Finder: «пришли журнал» не должно означать «открой терминал».
  showTgLog: () => ipcRenderer.invoke('telegram:showLog'),

  // Самоперезапуск вкладки, когда её контекст заполнился (restart.js). Порог в процентах,
  // отмеренных от точки автосжатия — то же число, что на полоске контекста.
  setRestart: (opts) => ipcRenderer.send('settings:restart', opts),
  // main дал добро на перезапуск (агент разрешил и прислал промпт). Ярлык разговора заводит
  // рендерер: он же его хранит и восстанавливает вкладку после перезапуска приложения.
  onRestartAgent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:restartAgent', handler);
    return () => ipcRenderer.removeListener('app:restartAgent', handler);
  },
  // Погасить прежнего агента и стартовать свежую сессию в той же вкладке. Возвращает id
  // нового разговора — его вкладке и хранить.
  relaunchSession: (opts) => ipcRenderer.invoke('session:relaunch', opts),
  // Перезапуск случился — строка в журнал вкладки.
  onRestarted: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:restarted', handler);
    return () => ipcRenderer.removeListener('session:restarted', handler);
  },
  // Что держит уже полученное разрешение — для подписи на карточке. Пустая строка значит
  // «ничто не держит»: подпись снимается тем же событием, которым встала.
  onRestartHold: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:restartHold', handler);
    return () => ipcRenderer.removeListener('session:restartHold', handler);
  },
  // Всё остальное про перезапуск, что стоит увидеть в журнале: «не сейчас», нет ответа, отмена.
  onRestartNote: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:restartNote', handler);
    return () => ipcRenderer.removeListener('session:restartNote', handler);
  },

  // main просит открыть вкладку (это /new из телеги: main не умеет делать xterm и DOM).
  onCreateTab: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:createTab', handler);
    return () => ipcRenderer.removeListener('app:createTab', handler);
  },

  // Тему переименовали в телеге — имя едет на вкладку. Вкладки живут в рендерере, поэтому
  // main может только попросить; обратно в телегу это уже не поедет (там имя и так новое).
  onRenameTab: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:renameTab', handler);
    return () => ipcRenderer.removeListener('app:renameTab', handler);
  },

  // Закрыть вкладку по кнопке из телеги. Тем же путём, что и крестик на вкладке, — иначе
  // остались бы xterm и DOM закрытой сессии.
  onCloseTab: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:closeTab', handler);
    return () => ipcRenderer.removeListener('app:closeTab', handler);
  },

  // Telegram bridge (Settings → Телеграм). The token itself only ever travels ONE way:
  // into main, which stores it encrypted. Everything coming back is masked state —
  // `state` never carries the token, so the renderer can't leak what it doesn't have.
  telegram: {
    state:     ()      => ipcRenderer.invoke('telegram:state'),
    setToken:  (token) => ipcRenderer.invoke('telegram:setToken', token),
    forget:    ()      => ipcRenderer.invoke('telegram:forget'),
    unpair:    ()      => ipcRenderer.invoke('telegram:unpair'),
    pair:      ()      => ipcRenderer.invoke('telegram:pair'),
    check:     ()      => ipcRenderer.invoke('telegram:check'),
    // Поднять опрос после фатальной ошибки (не тот токен, «токен уже читает кто-то другой»):
    // раньше из этого состояния выходили только перезапуском приложения.
    reconnect: ()      => ipcRenderer.invoke('telegram:reconnect'),
    setPrompt: (text)  => ipcRenderer.invoke('telegram:setPrompt', text),
    // «Кратко или полностью» — какими просить агента отвечать в телегу.
    setDetail: (d)     => ipcRenderer.invoke('telegram:setDetail', d),
    keepAwake: (on)    => ipcRenderer.invoke('telegram:setKeepAwake', on),
    // «Где я» — выбор в строке состояния, а не настройка: 'desk' | 'phone'. Решает, едут ли
    // в группу итоги ВСЕХ ходов и можно ли маку спать. Один выключатель на этот вопрос:
    // галка «писать всегда» жила рядом и прятала кнопку, оставляя положение включённым
    // втихую (см. TG_PRESENCE в main.js).
    setPresence: (p)   => ipcRenderer.invoke('telegram:setPresence', p),
    setWhisper: (bin, model) => ipcRenderer.invoke('telegram:setWhisper', { bin, model }),
    onState:   (cb)    => ipcRenderer.on('telegram:state', (_e, s) => cb(s)),
  },

  // Ночной режим — своя сущность, а не положение «где я»: тем отвечают на вопрос, где ЧЕЛОВЕК,
  // а этим — каким ВКЛАДКАМ разрешено работать без него. Двери две, вкладочная и общая, и обе
  // ведут к одному и тому же мандату.
  night: {
    state:    ()  => ipcRenderer.invoke('night:state'),
    setTexts: (t)  => ipcRenderer.invoke('night:setTexts', t),
    // Мандат вкладки «работает без меня»: меню карточки (родное меню системы) и прямой
    // переключатель — им пользуется гейт ввода, когда человек забирает вкладку себе.
    tabMenu:  (id) => ipcRenderer.invoke('tab:menu', { id }),
    setTab:   (id, auto) => ipcRenderer.invoke('tab:setAuto', { id, auto }),
    // Все вкладки разом — луна в нижней панели.
    setAll:   (auto) => ipcRenderer.invoke('night:setAll', { auto }),
    onTab:    (cb) => ipcRenderer.on('tab:auto', (_e, s) => cb(s)),
    onState:  (cb) => ipcRenderer.on('night:state', (_e, s) => cb(s)),
  },

  // Git plumbing for the branch status bar. Each call targets a folder path
  // (the active session's cwd). info → { isRepo, branch, ahead, behind, dirty };
  // branches → string[]; fetch/pull/checkout → { ok, error };
  // diffstat → { added, removed, files[] }; difftext → unified diff of one file.
  git: {
    info:     (cwd)         => ipcRenderer.invoke('git:info', cwd),
    branches: (cwd)         => ipcRenderer.invoke('git:branches', cwd),
    fetch:    (cwd)         => ipcRenderer.invoke('git:fetch', cwd),
    pull:     (cwd)         => ipcRenderer.invoke('git:pull', cwd),
    checkout: (cwd, branch) => ipcRenderer.invoke('git:checkout', cwd, branch),
    diffstat: (cwd)         => ipcRenderer.invoke('git:diffstat', cwd),
    difftext: (cwd, path)   => ipcRenderer.invoke('git:difftext', cwd, path),
  },

  // Open a file in the OS' default editor (the diff overlay's way out to an IDE).
  // cwd + relative path — main joins them platform-correctly.
  openPath: (cwd, rel) => ipcRenderer.invoke('shell:openPath', cwd, rel),

  // Subscribe to pty output. cb({ id, data }). Returns an unsubscribe fn.
  onData: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:data', handler);
    return () => ipcRenderer.removeListener('session:data', handler);
  },

  // Subscribe to session exit. cb({ id, code }). Returns an unsubscribe fn.
  onExit: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:exit', handler);
    return () => ipcRenderer.removeListener('session:exit', handler);
  },

  // Subscribe to inferred status changes. cb({ id, status, detail }).
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('session:status', handler);
    return () => ipcRenderer.removeListener('session:status', handler);
  },

  // Native "Справка" menu item (main) asks the renderer to open the help overlay.
  onOpenHelp: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('open-help', handler);
    return () => ipcRenderer.removeListener('open-help', handler);
  },

  // Copy a string to the system clipboard via Electron (correct UTF-8 encoding).
  // Used for ⌘C so a terminal/modal selection with Cyrillic doesn't get mangled.
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),

  // Open a clicked terminal link in the default browser. Main validates the
  // scheme (http/https only) before handing it to the OS.
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),

  // Native Edit → Copy (⌘C) asks the renderer to copy the current selection.
  onMenuCopy: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('menu:copy', handler);
    return () => ipcRenderer.removeListener('menu:copy', handler);
  },

  // Main-process errors, forwarded so they land in the in-app log viewer.
  // cb({ ts, source, level, msg }). Returns an unsubscribe fn.
  onAppError: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.removeListener('app:error', handler);
  },

  // --- auto-update ---
  getVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: (url, sha256, version) => ipcRenderer.invoke('update:apply', { url, sha256, version }),
  updateDownloadInstaller: (url, filename) => ipcRenderer.invoke('update:installer', { url, filename }),
  updatePending: () => ipcRenderer.invoke('update:pending'),
  updateRelaunch: () => ipcRenderer.send('update:relaunch'),
  onUpdateProgress: (cb) => {
    const handler = (_e, pct) => cb(pct);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
});
