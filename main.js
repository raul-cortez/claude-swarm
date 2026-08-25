// main.js — Electron main process.
//
// Responsibilities:
//   1. Open the window.
//   2. Own the pty (pseudo-terminal) sessions. Each session is a login shell
//      that auto-runs `claude`. node-pty is a native module and can only live
//      in the main process, not the sandboxed renderer.
//   3. Bridge data both ways over IPC:
//        renderer -> main : create / input / resize / kill
//        main -> renderer : data / exit
//
// WHY A LOGIN SHELL INSTEAD OF SPAWNING `claude` DIRECTLY:
//   When macOS launches a GUI app, the process PATH is the bare system PATH and
//   usually does NOT contain the directories your shell adds in ~/.zshrc (e.g.
//   ~/.local/bin, homebrew, nvm). Spawning `claude` directly would often fail
//   with "command not found". Spawning `$SHELL -l` (login shell) sources your
//   profile, gives the real PATH, and behaves like a normal terminal. We then
//   just type `claude` into it. Bonus: auth "just works" because it's the same
//   environment you log in from.

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage, shell, safeStorage, powerSaveBlocker } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');   // randomUUID for the pinned Claude session id

// --- ОДНА КОПИЯ НА МАШИНУ -----------------------------------------------------
// Второй сворм — это не «ещё один пульт», а тихая порча первого, потому что профиль у них
// один, и на двух писателей он не рассчитан:
//
//   • у бота Telegram может быть ТОЛЬКО ОДИН читатель. Две копии зовут getUpdates, Telegram
//     отвечает одной из них 409, и её мост гаснет насовсем (так и надо — повторы 409 не
//     лечат, см. telegram.js);
//   • список «эта вкладка отвечает в телегу» (swarm-tgmode.json) каждая копия пишет ЦЕЛИКОМ
//     из своих вкладок, то есть затирает чужой. Его читает хук, чтобы отказывать агенту в
//     интерактивном выборе «1/2/3» — затёрли, и агент снова рисует выбор в терминале, куда
//     никто не смотрит, а в телегу уходит вопрос, на который нельзя ответить;
//   • правило «один разговор Клода — одна вкладка» держится множеством внутри процесса. У
//     второй копии оно своё, поэтому две вкладки могут сесть на один файл и показывать статус
//     чужого агента;
//   • журнал моста дописывают и переливают обе копии, каждая по своему счёту размера.
//
// Плюс сохранённый список вкладок один: вторая копия поднимет тех же агентов в тех же папках.
//
// `return` в CommonJS-модуле законен (модуль обёрнут в функцию) и здесь важен: без него ниже
// продолжила бы исполняться регистрация обработчиков и создание окна, пока app.quit() ещё
// только собирается закрываться.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Приложение зовётся Swarm, а внутренние идентификаторы остались от прежнего имени —
// `name: claude-swarm-lite` в package.json и appId `io.swarm.claude-swarm-lite`. Это не
// недоделанное переименование, а условие сохранности данных, и менять их нельзя:
//
//   • `name` задаёт папку настроек (~/Library/Application Support/claude-swarm-lite) —
//     под новым именем приложение открылось бы пустым, без вкладок и настроенного моста.
//     Пока у кого-то остался незамигрированный telegram.dat, то же имя нужно и для того,
//     чтобы найти в связке ключей ключ от него (см. tgReadStored).
//   • appId — то, по чему установщик Windows узнаёт прежнюю установку. Новый appId даёт
//     вторую запись в «Установленных программах» вместо обновления.
//
// Пользователь ни того, ни другого не видит, так что цена нулевая. (Маркеры
// `<!-- claude-swarm-lite:begin -->` жили в agent-rules.js по той же причине и ушли
// вместе с кнопкой «скопировать правило»: у кого блок уже вставлен в CLAUDE.md, тот
// ничего не теряет — правило внутри учит тем же тегам, а маркеры приложение и не читало.)
//
// Windows taskbar/Start Menu group by AppUserModelID. Must match package.json
// `appId` (NSIS shortcuts use it); without this the shell often shows a generic
// white-document icon even when the .exe has a real icon embedded.
if (process.platform === 'win32') {
  app.setAppUserModelId('io.swarm.claude-swarm-lite');
}
// Native macOS About reads CFBundleShortVersionString from the outer .app
// (installer shell). After an asar-swap that stays stale — pin About to the
// version inside package.json (same source as Settings / updater).
app.setAboutPanelOptions({
  applicationName: 'Swarm',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
});
// Prebuilt fork of node-pty. Load rules (Win vs Mac) live in pty-loader.js —
// Windows stays on plain unpacked require; Unix gets a scoped spawn-helper
// path fix. See that file's contract comment before changing either branch.
const pty = require('./pty-loader').loadPty({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  platform: process.platform,
});
const git = require('./git');
const updater = require('./updater');
const resume = require('./renderer/resume'); // UMD: exports { supports, stemOf, ... } under Node

/** @type {BrowserWindow | null} */
let win = null;
// Set once the user confirms the close dialog, so the re-issued win.close() (or a
// Cmd+Q that follows) passes through instead of re-prompting.
let allowClose = false;
// Приложение уходит совсем: ⌘Q, перезапуск после обновления, закрытие окна. Отдельно от
// allowClose, потому что тот ставится ТОЛЬКО после подтверждения в диалоге, а уход бывает и без
// него. Нужен всему, что различает «вкладка кончилась» и «кончилось приложение»: на выходе
// умирают все pty сразу, и обработчик выхода вкладки видит ровно то же, что при закрытии одной.
let quitting = false;

/** @type {Map<string, import('node-pty').IPty>} sessionId -> pty process */
const sessions = new Map();
let nextId = 1;

// Единственная дорога в pty вкладки. Прямой `p.write(…)` мимо неё запрещён, и это не про
// аккуратность: один синхронный write на несколько килобайт вешает ВСЁ приложение целиком,
// намертво и со 100% CPU — мы упираемся в очередь псевдотерминала, которую сами же и должны
// вычитать, но не можем, потому что стоим внутри своего write. Почему так и почему лечится
// только порциями — в pty-write.js; разбор живого случая — BUG-pty-deadlock-2026-08-11.md.
//
// Заодно очередь держит ПОРЯДОК печатей: Enter, который телеграм отправляет отдельно от текста,
// клавиша из-под руки, Escape по кнопке из чата — всё это иначе встряло бы между порциями, то
// есть в середину чужого слова.
const ptyWrite = require('./pty-write');
const ptyOut = ptyWrite.makeWriter({
  write: (id, chunk) => {
    const p = sessions.get(id);
    if (!p) return false;                 // вкладку закрыли, пока хвост ждал такта
    p.write(chunk);
    return true;
  },
});

// Напечатать вкладке текст, как будто его набрали на клавиатуре. false — печатать было некуда
// или нечего; вызывающие на это смотрят, чтобы не считать напечатанным то, чего нет.
function ptyType(id, data) {
  return ptyOut.push(String(id), data);
}

// The command each new tab runs once its shell is ready. Change to '' if you
// want a plain shell (and type `claude` yourself), or to something like
// 'claude --resume' later.
// Когда запустилось САМО приложение. Нужно ночному режиму: первые полминуты после запуска
// вкладки перерисовывают прошлую переписку, и верить экрану в это время нельзя (night.BOOT_MS).
const BOOT_AT = Date.now();
const START_COMMAND = 'claude';

function pickShell() {
  if (os.platform() === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

// Default working dir for sessions that don't pick a folder. Deliberately NOT
// the home dir: launching claude in ~ makes it touch TCC-protected folders
// (~/Pictures, ~/Music, ~/Documents…), triggering a barrage of macOS permission
// prompts against our unsigned app. A dedicated plain folder isn't protected.
function defaultWorkdir() {
  const dir = path.join(os.homedir(), 'ClaudeSwarm');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  return dir;
}

// --- context progress bar, out of the box -----------------------------------
// The per-tab context bar comes from the numbers our statusline drops beside itself
// (see ctxFillOf, and usageSnapshot in swarm-statusline.js). Stock Claude runs no such
// script, so a fresh install would show no bar. Rather than ask every user to configure `statusLine` by hand, we
// SHIP one (swarm-statusline.js) and inject it into each Claude launch via
// `--settings`. That touches no file in the user's own config and needs no
// separately-installed Node — the script runs under Electron-as-node.
//
// Path to the JSON settings file we hand to `claude --settings`. null if
// provisioning failed (then we simply skip injection and behave as before).
let STATUSLINE_SETTINGS = null;
const { hookSettings } = require('./hook-config');
const { DEFAULT_ASK_PHRASES, ASK_TAG, normalizePhrases, phraseSources, buildAskMatcher, callKind, saysNone, askExcerpt } = require('./ask-phrases');
const { systemPromptRule } = require('./agent-rules');
// Keeps our own flags from filling a fresh tab's screen: long values go through the
// shell's environment, and a `clear` wipes the typed line. See launch-line.js.
const { envPassing, clearPrefix, tabEnv, shellFamily } = require('./launch-line');
const statusline = require('./swarm-statusline');   // числа расхода + текст для /usage
const restart = require('./restart');               // самоперезапуск вкладки: когда пора и что спросить
const unread = require('./unread');                 // «этот ответ человек ещё не видел» — держит перезапуск
const night = require('./night');                   // работа без человека: правило агенту, толчки, отчёт
let STATUSLINE_COMMAND = null; // the provisioned statusline launcher command
let HOOK_COMMAND = null;       // the provisioned hook launcher command
// Opt-in: precise status via Claude hooks. Off by default; the renderer pushes the
// user's saved pref on startup (settings:hooks) and rewrites swarm-settings.json.
// Scoped to swarm sessions via --settings — never the user's global config.
let HOOKS_ENABLED = false;
// Наша строка статуса — БЕЗ настройки, всегда. Галка была нужна, пока слот statusLine
// считался «или наш, или его»: --settings старше конфига, значит своя строка человека в
// свормовских вкладках пропадала, и он выбирал между ней и полоской контекста, цифрами
// /usage и перезапуском по контексту — все трое кормятся только отсюда. Теперь наш скрипт
// сам зовёт чужую команду и печатает оба куска (swarm-statusline.js, readForeign), терять
// человеку нечего, и выбора не осталось — а значит и галки.
// «Вкладки стартуют в режиме» — режим разрешений, с которым запускается вкладка, и новая, и
// восстановленная (иначе перезапуск молча возвращал бы всех в «спрашивать разрешение»).
// Пусто = не вмешиваемся, вкладка начинает как Claude Code сам считает нужным — это и есть
// умолчание: подсовывать всем режим, о котором они не просили, нельзя, цена у режимов разная.
// Это ПЕРВЫЙ режим, а не запертый: Shift+Tab за клавиатурой и кнопки из телеги работают
// дальше как обычно.
let PERMISSION_MODE = '';

// Copy a bundled script onto a real path (fs CAN read inside app.asar, but Node
// can't exec from there) and return a launcher command that runs our own binary as
// Node. Per-OS because inline `VAR=1 cmd` is POSIX-only; cmd.exe needs `set`.
function provisionNodeLauncher(dir, srcName, base) {
  const scriptDst = path.join(dir, path.basename(srcName));
  fs.copyFileSync(path.join(__dirname, srcName), scriptDst);
  const exe = process.execPath;
  if (os.platform() === 'win32') {
    const launcher = path.join(dir, base + '.cmd');
    fs.writeFileSync(launcher, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${scriptDst}"\r\n`);
    return `"${launcher}"`;
  }
  const launcher = path.join(dir, base + '.sh');
  fs.writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "${scriptDst}"\n`, { mode: 0o755 });
  return `sh "${launcher}"`;
}

// (Re)write swarm-settings.json: the statusline and the hooks block, each only when the
// user left it on. Called at startup and whenever either pref changes — new Claude sessions
// read the file at launch, so a change takes effect on the next one.
//
// With both off the file has nothing to say, and STATUSLINE_SETTINGS goes back to null:
// injectStatusline then stops appending --settings entirely. That's the point — a user who
// turned off our statusline wants HIS line in swarm tabs, and an empty --settings would
// still outrank his config.
function writeSwarmSettings() {
  const settings = {};
  if (STATUSLINE_COMMAND) {
    settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND, padding: 0 };
  }
  if (HOOKS_ENABLED && HOOK_COMMAND) settings.hooks = hookSettings(HOOK_COMMAND);
  if (!Object.keys(settings).length) { STATUSLINE_SETTINGS = null; return; }
  const settingsPath = path.join(app.getPath('userData'), 'swarm-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  STATUSLINE_SETTINGS = settingsPath;
}

// Как агент зовёт человека — тегом `[swarm:вопрос]` из ask-phrases.js, плюс одна
// зашитая фраза «Сейчас от тебя» как путь совместимости. Настройкой это больше не
// является: теги — протокол, а не вкус, и добавлять к ним свои фразы было настройкой
// третьего порядка (нужна только тому, кто отказался от тегов И держит свою подпись в
// CLAUDE.md), стоившей всем текстового поля с живым чекером. Список остался списком,
// потому что читателей у него два: экранный детектор в этом процессе и Stop-хук —
// отдельный процесс, который получает СКОМПИЛИРОВАННЫЙ матчер через swarm-phrases.json
// рядом со скриптом хука.
const ASK_PHRASES = DEFAULT_ASK_PHRASES.slice();
let ASK_MATCHER = buildAskMatcher(ASK_PHRASES);     // for the transcript reader

function applyAskPhrases() {
  setAskPhrases(ASK_PHRASES);                       // in-process (screen scraping)
  ASK_MATCHER = buildAskMatcher(ASK_PHRASES);
  const phrases = normalizePhrases(ASK_PHRASES);
  const body = Object.assign({ phrases }, phraseSources(phrases));
  fs.writeFileSync(path.join(app.getPath('userData'), 'swarm-phrases.json'),
    JSON.stringify(body, null, 2));                 // for the hook process
}

function provisionStatusline() {
  const dir = app.getPath('userData');
  // Rewritten every launch so upgrades take.
  STATUSLINE_COMMAND = provisionNodeLauncher(dir, 'swarm-statusline.js', 'swarm-statusline');
  HOOK_COMMAND = provisionNodeLauncher(dir, path.join('hooks', 'swarm-signal.mjs'), 'swarm-signal');
  writeSwarmSettings();
  applyAskPhrases();
  // Файл рядом с хуком переживает выключение, и без этой строчки в нём оставалось бы
  // вчерашнее «за телефоном»: хук запрещал бы агентам коробку с вариантами, хотя человек
  // сидит за маком и ничего такого не выбирал. Переписываем состояние под свежее — как и всё
  // остальное здесь. Ночь при этом восстанавливается из файла настроек (tgLoad), и запись
  // сюда как раз и вернёт хуку ночное правило.
  tgWriteModes();
  pruneUsage();
  pruneNight();
  nightLoadDigest();
  pruneRestart();
}

// --- «сколько израсходовано»: снимки от статуслайна ---------------------------
// Статуслайн кладёт рядом с собой числа по сессии (swarm-statusline.js usageSnapshot):
// заполнение контекста и расход двух окон подписки. Читаем их для /usage, а не парсим
// строку с экрана — в строке числа уже округлены, а отсчёт до сброса скрыт, пока окно не
// поджало. Прочитать-то её можно и у вкладки не на экране (у приложения своя невидимая
// копия каждого терминала, см. extractStatusline) — но кроме округлённого в ней нет ничего.
function usageFile(sessionId) {
  const s = String(sessionId || '');
  if (!s || /[/\\]|\.\./.test(s)) return null;
  return path.join(app.getPath('userData'), statusline.USAGE_DIR, s + '.json');
}

function readUsage(sessionId) {
  const file = usageFile(sessionId);
  if (!file) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    return snap && typeof snap === 'object' ? snap : null;
  } catch (_) { return null; }   // нет файла — вкладка ещё не отрисовала статуслайн
}

// Снимки закрытых разговоров иначе копятся навсегда: каждая вкладка — новый id, а
// /clear и перезапуски рождают их каждый день. Неделя — с запасом больше окна 7д,
// то есть дольше, чем эти числа вообще о чём-то говорят.
const USAGE_TTL_MS = 7 * 24 * 3600 * 1000;

function pruneUsage() {
  try {
    const dir = path.join(app.getPath('userData'), statusline.USAGE_DIR);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > USAGE_TTL_MS) fs.unlinkSync(p);
      } catch (_) { /* исчез сам — тем лучше */ }
    }
  } catch (_) { /* папки ещё нет */ }
}

// The launcher of a command line — first real token, skipping `VAR=value` prefixes.
function launcherOf(cmd) {
  return String(cmd || '').trim().split(/\s+/).find((t) => !/^\w+=/.test(t)) || '';
}

// Append `--settings <ours>` so a launched Claude prints the context statusline.
// Only for Claude launchers (never for aider/codex/… which don't take the flag),
// and never when the command already carries an explicit --settings of its own.
function injectStatusline(cmd, pass) {
  if (!STATUSLINE_SETTINGS || !cmd) return cmd;
  if (/(^|\s)--settings(\s|=)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --settings ${pass.ref('SWARM_SETTINGS', STATUSLINE_SETTINGS)}`;
}

// Append `--append-system-prompt "<rule>"` so the agent knows how to call the user
// (see agent-rules.js). Same guards as the statusline: Claude launchers only, and we
// keep out of the way of a user who set a system prompt themselves — theirs wins,
// silently overriding it would be worse than losing the status hint. The flag is
// spelled inline rather than via --append-system-prompt-file because it has been in
// Claude Code far longer, and an unknown flag doesn't degrade — claude refuses to
// start and the tab is dead. The text itself travels in the environment (envPassing),
// which is what keeps this flag from filling the screen.
function injectAgentRules(cmd, pass) {
  if (!cmd) return cmd;
  if (/(^|\s)--(append-)?system-prompt(-file)?(\s|=)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --append-system-prompt ${pass.ref('SWARM_ASK_RULE', systemPromptRule())}`;
}

// Append `--permission-mode <mode>` so a new tab starts in the mode the user picked
// (Настройки → Запуск). Смысл: «разреши уже всё» — самое частое, что делают руками сразу
// после открытия вкладки, а из телеги это вообще единственный способ, потому что Shift+Tab
// с телефона не нажать.
//
// Те же три оговорки, что у соседей: только лончеры Claude, и СВОЙ `--permission-mode` во
// флажках побеждает — человек, написавший флаг руками, знает, чего хочет. Плюс проверка
// самого значения: неизвестный режим claude не проглатывает, а отказывается стартовать, и
// вкладка встречает человека мёртвой оболочкой вместо агента. Лучше запустить без флага.
function injectPermissionMode(cmd) {
  if (!PERMISSION_MODE || !cmd) return cmd;
  const flag = modeFlag(PERMISSION_MODE);
  if (!flag) return cmd;
  if (/(^|\s)--permission-mode(\s|=)/.test(cmd)) return cmd;
  if (/(^|\s)--dangerously-skip-permissions(\s|$)/.test(cmd)) return cmd;
  if (!resume.supports(launcherOf(cmd))) return cmd;
  return `${cmd} --permission-mode ${flag}`;
}

// Pin the session id Claude will use, so we know EXACTLY which transcript file belongs
// to this tab: ~/.claude/projects/<slug>/<id>.jsonl. Without it the file has to be
// guessed by folder + mtime, which is a coin flip once two tabs share a folder — and a
// wrong guess would show one agent's status on another agent's tab.
//
// Skipped when the command already carries a session flag (--resume / --continue /
// --session-id): then the id isn't ours to choose. Those sessions fall back to the
// hook marker (it reports session_id) or to the folder scan.
function injectSessionId(cmd) {
  if (!cmd || !resume.supports(launcherOf(cmd))) return { cmd, sessionId: null };
  if (/(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/.test(cmd)) return { cmd, sessionId: null };
  const sessionId = crypto.randomUUID();
  return { cmd: `${cmd} --session-id ${sessionId}`, sessionId };
}

// Send to the renderer only if the window/frame is still alive. Late pty chunks
// arriving during quit would otherwise throw "Render frame was disposed".
function safeSend(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// Время во всех наших метках — МЕСТНОЕ, а не UTC, и это не косметика. Писали мы UTC, а `ls`,
// `stat` и часы на стене показывают местное: при разборе инцидента расхождение в часовой пояс
// уводит в сторону — «это вообще та же минута?» — и половина сверки уходит на арифметику (см.
// BUG-pty-deadlock-2026-08-11.md, где семь часов разницы сбивали с толку). Внутри приложения было
// хуже: рендерер клеймит свои строки местным временем (nowClock в renderer.js), и в одном списке
// ошибки главного процесса стояли на семь часов раньше событий, которые их вызвали.
function logStamp(ms, withMs) {
  const t = ms == null ? new Date() : new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  const hms = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  return withMs ? `${hms}.${p(t.getMilliseconds(), 3)}` : hms;
}

// --- error reporting: surface main-process failures in the in-app log viewer ----
// A crash in main (pty spawn, git, an IPC handler) otherwise only prints to the
// terminal we were launched from, which regular users never see. Forward it to the
// renderer's log store so it shows up behind the red "!" in the status bar. We log
// and keep running rather than letting an uncaught error tear the process down.
function reportMainError(err) {
  const msg = (err && err.stack) || (err && err.message) || String(err);
  safeSend('app:error', { ts: logStamp(), source: 'main', level: 'error', msg });
}
process.on('uncaughtException', reportMainError);
process.on('unhandledRejection', (reason) => reportMainError(reason));

// --- status detection --------------------------------------------------------
// Claude Code prints no machine-readable status, so we infer it from the pty
// stream — but simply, not by scraping the TUI text:
//   While Claude works, its spinner animates, so the pty keeps emitting bytes.
//   => "bytes flowing" is a reliable "working" signal (no parsing needed).
//   => a silence gap means the agent stopped: either done, or waiting on me.
// Only in silence do we peek at the screen (a headless terminal emulator) to
// tell "waiting for a prompt" apart from "idle/done". We deliberately do NOT
// surface Claude's token counter or activity words — just the four states.
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { extractQuestion, lastAgentBlock, readMode, modeTitle, modeFlag, countSubagents, contentEnd, snapshotRows, snapshotWrapped, statuslineOf, ctxFromLine, ctxPick, setAskPhrases, askFingerprint, parsePrompt, scrolledBack, limitHit, limitReset, asksForInput, waitsForWork } = require('./screen');
// The status state machine + «ждёт» latch + hook arbitration live in a pure,
// unit-tested module; osc.js sniffs hook markers out of the raw pty stream.
const { tickStatus, applyHook, applyTranscript, keyboardEvent, hasPromptBox, trRunStale, RE_RUNNING } = require('./detector');
const { extractHookSignals } = require('./osc');

const TICK_MS = 300;
const SNAP_ROWS = 16;        // how many bottom screen rows to inspect
// Окно для ОТВЕТА, а не для статуса. Статусу хватает мебели под текстом, а ответ агента —
// это абзацы, и в шестнадцать строк он не влезает: в телегу уезжал хвост сообщения. Больше
// scrollback эмулятора (200) брать всё равно нечего.
const REPLY_ROWS = 200;
// Окно поиска плашки «вернуться вниз» (см. screen.scrolledBack). Шире, чем SNAP_ROWS:
// плашка ложится по нижней кромке вида переписки, а под ней ещё поле ввода с подсказками,
// и в шестнадцать строк она не попадает, стоит человеку набрать многострочный запрос.
const SCROLL_HINT_ROWS = 40;
// Окно для ДИАЛОГА с вариантами — тоже шире, чем для статуса, и по той же причине, что у
// ответа. Запрос разрешения в шестнадцать строк укладывается («Bash command», команда, два
// варианта), а вопрос с вариантами — нет: у каждого варианта своя строка описания, на узком
// окне она переносится, и в снимок попадала половина списка. Номера тогда начинались не с
// единицы, парсер отказывался (это правило защищает от прозаических списков в переписке), и в
// телегу уходило «вариантов не разобрал» — то есть с телефона нельзя было ни выбрать, ни
// написать словами. См. screen.parsePrompt.
const PROMPT_ROWS = 44;
const RESIZE_GRACE_MS = 700; // after a resize, ignore the repaint burst as "activity"
const INPUT_GRACE_MS = 700;  // after a keystroke, ignore the echo/redraw as "activity"

/** @type {Map<string, any>} id -> detector state */
const det = new Map();

function makeDetector(cols, rows) {
  return {
    term: new HeadlessTerminal({ cols: cols || 80, rows: rows || 24, scrollback: 200, allowProposedApi: true }),
    lastDataAt: Date.now(),
    graceUntil: 0,
    // Экран отлистан назад (человек читает историю внутри Клода) и последний снимок,
    // сделанный, пока вид был живым. Пока отлистано, ВСЕ читатели экрана получают этот
    // снимок, а байты перерисовки не считаются работой. См. snapshot() ниже.
    scrolledBack: false, liveSnap: '', livePrompt: '',
    status: '', detail: '', statusline: '', ctxPct: null, question: null, sub: 0, dead: false,
    // Ход кончился словами «ничего, жду замер стенда»: статус «работает», но работает
    // не агент, а фоновая задача, и человеку это докладывают иначе. См. detector.js.
    bg: false,
    // Waiting latch (fallback detection, no hooks): hold «ждёт» through screen
    // noise, release only when the agent genuinely resumed. See detector.js.
    waitLatched: false, waitKind: null, waitingKind: null, chromeGoneSince: 0,
    // Когда вкладка встала (для утренней сводки: «стоит сорок минут» против «стоит шесть часов»)
    // и состояние ночного режима по этой вкладке — толчки, продолжения, будильник по лимиту.
    // См. nightSt: заводится по требованию и обнуляется на включении ночи.
    waitSince: 0, ni: null,
    answeredAt: 0,             // when you last pressed Enter here (see session:input)
    // Отпечаток зова прозой, на который ты ответил этим Enter. Строка «Сейчас от тебя: …»
    // остаётся на экране и после ответа, и без этой отметки вкладка снова поднимала «ждёт» —
    // см. detector.asksNow.
    askAnswered: '',
    // Hooks channel: once a marker arrives, hooksActive drives status; oscCarry
    // reassembles a marker split across pty chunks. See osc.js / detector.js.
    hooksActive: false, hookState: null, oscCarry: '',
    // Transcript channel (see the reader below): the folder this tab runs in, the
    // Claude session id we pinned at launch (or learned from a hook marker), the
    // .jsonl bound to it, and the last verdict read out of it.
    // Identity for the Telegram bridge: the tab's visible name and the key that outlives
    // the process (the forum topic hangs on it). tgTimer debounces the «ждёт» message.
    // tgNotifiedAt — про это ожидание УЖЕ написали (ставится до отправки, снимается при
    // неудаче и когда вкладка перестала ждать): без этой отметки одно и то же разрешение
    // приходило дважды. tgAck — сообщение «получил, думаю…», которое станет ответом. mode —
    // последний увиденный режим разрешений: на экране его строка есть не всегда.
    tabKey: '', name: '', tgTimer: null, tgMode: false, tgPrimed: false, trReply: '',
    // tgAckText — что в заготовке написано сейчас: Telegram отвергает правку, не меняющую
    // текст, поэтому одну и ту же строку второй раз не шлём (см. tgProgressTick). tgAckAt —
    // когда её правили в последний раз, tgAckWhy — почему не правят (для журнала).
    // tgOwes — ход начали из чата, а заготовки под него нет: её заведёт живая строка, если
    // ход затянется (см. tgProgressTick).
    tgNotifiedAt: 0, tgAck: null, tgAckText: '', tgAckAt: 0, tgAckWhy: '', tgOwes: false,
    tgLastSent: '', trFinal: '', mode: null,
    tgTopicLive: false, tgTopicName: '',
    // Текст с телефона, который ждёт закрытия диалога: напечатать его прямо в диалог нельзя,
    // а терять — значит просить набрать заново с телефона. Уходит по кнопке «закрыть диалог»
    // (см. QA_ACTIONS.esc) и сбрасывается, как только вкладка перестала ждать: ответили за
    // компьютером — отложенному сообщению уже некуда идти.
    tgPending: '',
    // Когда спросили «стереть разговор?» — по нему кнопка проверяет, что отвечают на СВЕЖИЙ
    // вопрос, а не на вчерашний, оставшийся в ленте (см. tgClaudeCommand).
    tgClearAsk: 0,
    // Отказы отправки уведомления: сколько подряд и когда пробовать снова. Без откола такт
    // (300 мс) долбил Telegram каждые полторы секунды всё время, пока вкладка ждёт.
    tgFails: 0, tgRetryAt: 0,
    // Итог хода: когда ход начался и на какой момент у нас есть его текст из стенограммы.
    // Второе сравнивается с первым — иначе в чат уезжает ответ на ПРОШЛУЮ задачу (см.
    // tgOnDone: с хуками статус «готов» приходит раньше, чем стенограмма догоняет).
    // turnEndedAt — когда ход кончился У НАС НА ГЛАЗАХ. Ноль значит «вкладка при нас ничего не
    // делала», и это не то же, что «простаивает»: восстановленная и забытая вкладка простаивает
    // честно, и ночному режиму спрашивать её не о чем (см. night.phaseDecision).
    turnStartedAt: 0, turnEndedAt: 0, trReplyAt: 0, tgDoneTimer: null,
    // Что мост про эту вкладку уже доложил (запись стенограммы или сам текст). Тот же итог
    // второй раз — шум: см. tgNotifyDone.
    tgSentKey: '',
    // Печатал ли человек в эту вкладку с последнего Enter. «Вернулся за компьютер» — это
    // отправленное сообщение, а не любое шевеление: см. session:input.
    typedAtKeyboard: false,
    // Мандат вкладки: «работай без меня». Своё у каждой вкладки, и это главное отличие от
    // прежней ночи: та была одна на приложение, а человеку нужно наоборот — одну вкладку отдал,
    // в другой сидит сам. Общий ночной режим мандат не переписывает, а поднимает всем сразу; что
    // в силе для конкретной вкладки, считает autoOn().
    auto: false,
    // Ждёт ли на вкладке ответ, которого человек ещё не видел. Держит перезапуск, и держит без
    // срока: агент судить об этом не может — изнутри разговора «сказано» и «услышано»
    // неразличимы. См. unread.js.
    unread: unread.initial(),
    cwd: '', startedAt: Date.now(), claudeSessionId: null,
    trFile: null, trMtime: 0, trEntries: null, trState: null, trText: '', trWhy: '', trTryAt: 0,
    // trHint — адрес разговора, названный самим Клодом (хук). claudeHome — конфиг, в котором
    // этот разговор лежит: у вкладки, запущенной с CLAUDE_CONFIG_DIR (алиас `claude-my`), он
    // не ~/.claude, и вычислять его нельзя — только узнать. См. configRoots.
    trHint: '', claudeHome: '',
  };
}

// Read the bottom SNAP_ROWS lines of the emulator's current screen. The window is
// anchored to the last row WITH CONTENT, not to buf.length — see screen.js for why
// (a shrinking TUI frame leaves blank rows the buffer never gives back).
//
// И ещё это ЕДИНСТВЕННАЯ дверь к экрану для всех, кто его читает, — поэтому здесь же
// живёт защита от прокрутки. Колесо уходит агенту, тот листает свой вид и рисует на
// экране прошлую переписку; отлистанный экран — не «что происходит сейчас», а чтение
// истории. Пока плашка возврата вниз на экране, отдаём последний ЖИВОЙ снимок: и
// статус, и вопрос, и разрешения, и отпечатки — всё видит вкладку такой, какой она
// была в момент, когда человек полез в историю. Само собой отпускается, как только он
// вернулся вниз и Клод убрал плашку. См. screen.scrolledBack.
function snapshot(d) {
  const buf = d.term.buffer.active;
  d.scrolledBack = scrolledBack(snapshotRows(buf, SCROLL_HINT_ROWS));
  const live = snapshotRows(buf, SNAP_ROWS);
  if (d.scrolledBack) return d.liveSnap || live;
  d.liveSnap = live;
  return live;
}

// Ты ответил в эту вкладку (за клавиатурой или с телефона — путь один, см. tgAnswer).
//
// Кроме времени запоминаем ОТПЕЧАТОК зова прозой, который сейчас на экране: диалог разрешения
// Claude Code стирает сам, а строка «Сейчас от тебя: …» остаётся висеть, и без этой отметки
// вкладка через пару секунд снова читала её как просьбу — со всеми последствиями вплоть до
// уведомления о зове, на который ты только что ответил. См. detector.asksNow.
function markAnswered(d, now) {
  d.graceUntil = 0;
  d.lastDataAt = now;
  d.answeredAt = now;
  try { d.askAnswered = askFingerprint(snapshot(d)); } catch (_) { d.askAnswered = ''; }
}

// Окно для разбора диалога с вариантами (см. PROMPT_ROWS). Отдельная дверь, но с той же
// защитой от прокрутки, что и snapshot(): отпечаток запроса, кнопки под сообщением и проверка
// при нажатии обязаны видеть ОДИН И ТОТ ЖЕ экран, иначе нажатие отвергается как «на экране
// другое». Поэтому все, кто зовёт parsePrompt, ходят сюда.
//
// Переносы НЕ склеиваем: строка описания, приклеенная к строке варианта, уехала бы в подпись
// кнопки целым абзацем.
function promptSnapshot(d) {
  const buf = d.term.buffer.active;
  const live = snapshotRows(buf, PROMPT_ROWS);
  if (d.scrolledBack) return d.livePrompt || live;
  d.livePrompt = live;
  return live;
}

// То же, но настолько высоко, насколько помнит эмулятор, и с СКЛЕЕННЫМИ переносами: из
// этого окна берётся ТЕКСТ ответа, когда стенограммы нет (см. lastAgentBlock). Ширина окна
// терминала — свойство того, кто смотрит; в ответе, который читают с телефона, её быть не
// должно (см. snapshotWrapped).
function replySnapshot(d) {
  return snapshotWrapped(d.term.buffer.active, REPLY_ROWS);
}

// Строка статуса вкладки. Сам поиск живёт в screen.js рядом с прочим чтением экрана — и,
// главное, под тестом: с переносами в нём стало что ломать (см. statuslineOf).
function extractStatusline(d) {
  return statuslineOf(d.term.buffer.active, SNAP_ROWS);
}

// Заполнение контекста для полоски на вкладке. Берём ЧИСЛО из снимка расхода — того
// самого, что статуслайн кладёт файлом рядом с настройками (swarm-statusline.js,
// usageSnapshot), и по которому уже принимается решение о перезапуске (restartPctOf).
// Раньше полоска жила на первом проценте из строки с экрана, и это врало: строка
// приходит склеенной с соседними рядами, так что фраза агента «процессор загружен на
// 80%» становилась «контекст занят на 80%» при живых 15%. Снимок не путается: он
// приходит от самого Клода числами.
//
// Строка остаётся ЗАПАСНЫМ путём — для вкладки, которой наш статуслайн не подставлен
// (в команде уже стоит своё --settings, см. injectStatusline). Там процент берётся
// только вплотную к полоске блоков (ctxFromLine), а не первый попавшийся.
// И ВТОРЫМ МНЕНИЕМ она же: снимки лежат по одному на сессию, а вкладка меняет разговор и без
// нас (/clear). Кому из двух верить, решает ctxPick — там же и почему.
function ctxFillOf(d, line) {
  const u = readUsage(d.claudeSessionId);
  const snap = u && u.ctx && u.ctx.used != null ? { used: u.ctx.used, at: u.at } : null;
  return ctxPick({ snap, line: ctxFromLine(line), now: Date.now() });
}

// Во вкладке начался ДРУГОЙ разговор, и не нашими руками: человек нажал /clear, набрал `claude`
// сам, поднял чужой /resume. Свой перезапуск сюда не попадает — там id новой сессии выбираем мы
// и записываем заранее (см. restartFire), так что маркер приходит уже со «своим» именем.
//
// Всё, что мы знали о вкладке, знали о ПРОШЛОМ разговоре, а он только что кончился:
//
//   • расход контекста. Снимки лежат по одному на сессию (usageSnapshot), у новой своего ещё
//     нет — и без этой строчки полоска стояла бы заполненной на чистой вкладке, а перезапуск
//     просил бы погасить её по проценту, которого больше нет. Ровно это и видел человек после
//     /clear: полная полоска и просьба о перезапуске в чистой вкладке.
//   • автомат перезапуска: висящий вопрос, счётчик молчания, готовое разрешение. Разрешение
//     давал агент прошлого разговора и про свою работу — новому оно не принадлежит.
//   • непрочитанное: долг «человек этого не видел» принадлежит разговору, который умер (та же
//     причина, что и при нашем перезапуске, см. unread.reset там же).
function newConversation(id, d, prev) {
  d.ctxPct = null;
  d.statusline = '';          // пусто ≠ прежней строке, значит следующий такт пересчитает
  restartClearPending(d);
  d.rs = restart.initial();
  d.unread = unread.reset(d.unread);
  // И пометка на карточке, если вкладка стояла с разрешением на руках: причина исчезла вместе с
  // разрешением. Сама она бы не ушла — такт меняет её только вместе с решением автомата, а у
  // чистого автомата решений нет (см. holdWas в restartTick).
  if (d.rsHold) { d.rsHold = ''; safeSend('session:restartHold', { id, hold: '' }); }
  // И уговор «отвечаешь коротко и в телегу»: он живёт в первом сообщении разговора и умирает
  // вместе с ним. Телеграмный /clear это уже снимал у себя (см. forgets в tgTypeClaudeCommand),
  // а тот же /clear с клавиатуры — нет, и следующее сообщение с телефона приходило без уговора.
  d.tgPrimed = false;
  d.tgLastSent = '';
  if (prev) restartLog(`вкладка ${id}: разговор сменился (${prev} → ${d.claudeSessionId})`
    + ' — расход и перезапуск считаю заново');
}

function feedDetector(id, chunk) {
  const d = det.get(id);
  if (!d || d.dead) return;
  d.term.write(chunk);
  // Sniff invisible hook markers out of the raw stream (carry a tail so one split
  // across chunks still assembles). A signal flips this session to hook-driven.
  const { signals, rest } = extractHookSignals(d.oscCarry + chunk);
  d.oscCarry = rest;
  for (const sig of signals) {
    // The marker carries Claude's own session_id. Routing doesn't need it (each agent
    // has its own pty), but the transcript reader does: it's the exact file name. This
    // is how a RESUMED session — where we didn't choose the id — still binds precisely.
    if (sig.sessionId && sig.sessionId !== d.claudeSessionId) {
      const prevSession = d.claudeSessionId || '';
      d.claudeSessionId = sig.sessionId;
      // The tab's conversation changed under us (/clear, a `claude` typed by hand, a
      // /resume inside the terminal). Tell the renderer so the id it saves for the next
      // launch is the conversation you're actually in, not the one we started with.
      safeSend('session:claude', { id, claudeSessionId: sig.sessionId });
      // If this tab is already being driven from Telegram, the hook needs to know its id
      // to refuse the interactive picker — rewrite the list now that we have one. То же и у
      // вкладки с мандатом «работай без меня»: хук знает её только по id разговора, и без
      // перезаписи мандат новой сессии не действовал бы вовсе.
      if (d.tgMode || d.auto) tgWriteModes();
      newConversation(id, d, prevSession);
    }
    // А это АДРЕС разговора, названный самим Клодом. Точнее любых наших вычислений: путь
    // складывался как ~/.claude/projects/<слаг>/<id>.jsonl, и у вкладки с другим
    // CLAUDE_CONFIG_DIR (алиас вида `claude-my`) файл не находился никогда — статус держался
    // на экране, а в телегу вместо ответа агента уезжали статуслайн, имя ветки и обрывок
    // команды. Здесь только запоминаем; кому файл принадлежит, решает bindTranscript.
    if (sig.transcript && sig.transcript !== d.trHint) d.trHint = sig.transcript;
    applyHook(d, sig.token, Date.now());
  }
  // A resize makes Claude repaint the whole screen — a burst of output that is
  // NOT real work. Inside the grace window after a resize we keep feeding the
  // emulator (so the screen stays correct) but don't count it as activity, so an
  // idle agent won't flash "работает" and fire a false notification.
  //
  // Прокрутка — та же история: пока человек листает историю внутри Клода, тот
  // перерисовывает вид на каждый щелчок колеса. Это чтение, а не работа агента, и
  // считать эти байты активностью значит красить спокойную вкладку в «работает» под
  // мышью. Пока экран отлистан, поток не двигает lastDataAt вообще — статус вкладки
  // держится на снимке, сделанном до прокрутки (см. snapshot), и на хуках, которым
  // экран не нужен.
  const now = Date.now();
  if (now >= d.graceUntil && !d.scrolledBack) d.lastDataAt = now;
}

setInterval(() => {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  for (const [id, d] of det) {
    if (d.dead) continue;
    // Mid-resize the screen is repainting and unreliable: a half-drawn prompt box
    // reads as «готов» and would flip a waiting tab green until the next settled
    // tick. That's the "collapse a folder → waiting tab turns green" bug — a
    // collapse resizes the active terminal. Hold the last status through the
    // repaint burst (same grace window feedDetector uses to ignore the bytes).
    if (now < d.graceUntil) continue;
    try {
      const snap = snapshot(d);
      // Status = hooks when this session has spoken through them (arbitration:
      // hook wins, screen only upgrades a «ready» to a prose question); otherwise
      // the screen-scrape + «ждёт» latch fallback (never released by mere typing).
      // Точный сигнал или догадка — это РАЗНЫЕ вещи для рендерера: «работает» он
      // придерживает на RUN_BUFFER_MS, чтобы не мигать жёлтым на всплесках, и такая
      // задержка нужна только шумному источнику. Ветки те же, что выбирает tickStatus:
      // хук (событие Клода) и стенограмма (новая реплика в файле) — факты, скрёб
      // экрана — догадка. Считаем ДО tickStatus: она может сама перевести сессию на
      // экран, и тогда флаг относился бы уже к следующему тику.
      const sure = !!(d.hooksActive || d.trState);
      const next = tickStatus(d, now, snap);
      // Режим разрешений помним: на экране его строка есть не всегда (при открытом запросе
      // её нет вовсе), а /mode должен отвечать «какой сейчас» и в этот момент тоже.
      const mode = readMode(snap);
      if (mode) d.mode = mode;
      const kind = next.status === 'waiting' ? (next.kind || null) : null;
      // Открыта ли РАМКА, а не просто «вкладка ждёт человека». Рендереру это не нужно — на
      // вкладке всё одинаково жёлтое, — а перезапуску нужно: он единственный печатает в живую
      // вкладку сам. Живёт отдельно от рассылки статуса и обновляется каждый тик, потому что
      // рамка появляется и уходит, не меняя ни статуса, ни kind (см. boxOpen в restart.js).
      const wasBox = !!d.waitingBox;
      d.waitingBox = next.status === 'waiting' && !!next.box;
      const statusline = extractStatusline(d);
      // Снимок расхода читаем с диска не каждый такт, а когда строка статуса
      // перерисовалась: снимок пишет тот же перерисованный статуслайн, между
      // перерисовками читать нечего — а такт здесь раз в 300 мс на каждую вкладку.
      if (statusline !== d.statusline) d.ctxPct = ctxFillOf(d, statusline);
      const ctxPct = d.ctxPct;
      // How many sub-agents are running (Claude's Task/agent tool). Sent raw; the
      // renderer decides whether to keep the tab «работает» while they run and
      // whether to show the agent badge — both are toggles in the tab settings.
      const sub = countSubagents(snap);
      // WHAT the agent is asking. Word-for-word from Claude's own transcript when the
      // tab is bound to one (d.trText) — that text is whole even after it scrolls out
      // of the visible rows. The screen scrape stays as the fallback for a permission
      // box (which lives only on screen) and for unbound tabs.
      const question = next.status === 'waiting' ? (d.trText || extractQuestion(snap)) : null;
      if (next.status !== d.status || next.detail !== d.detail
          || statusline !== d.statusline || question !== d.question || sub !== d.sub
          || kind !== d.waitingKind) {
        const prev = d.status;
        const prevDetail = d.detail;
        // «Работает» и «работает в фоне» — один статус, но разные новости, а статус между
        // ними не меняется. Помним прошлое значение отдельно: по переходу в фон мост
        // докладывает итог (ход-то кончился), по выходу из него начинается новый ход.
        const wasBg = !!d.bg;
        const wasSub = d.sub || 0;
        d.bg = !!next.bg;
        d.status = next.status;
        d.detail = next.detail;
        d.statusline = statusline;
        d.question = question;
        d.sub = sub;
        d.waitingKind = kind;
        safeSend('session:status', { id, status: next.status, detail: next.detail, ctxPct, question, sub, waitingKind: kind, sure });
        // Смена цвета — в журнал, вместе с показаниями всех каналов (см. statusWhy).
        if (next.status !== prev || next.detail !== prevDetail) {
          statusLog(`tab=${id}${d.name ? ' (' + d.name + ')' : ''} ${prev || '—'}/${prevDetail || '—'} → ${next.status}/${next.detail} | ${statusWhy(d, now, snap, sub)}`);
        }
        // Вкладка кончила ход — а перезапуск как раз этого и ждал: ответ агента ложится на диск в
        // конце хода, и гасить прежнего агента можно с того же мига. Без этого толчка круг упирался
        // в такт раз в полминуты и стоял на глазах у человека (см. restartKick).
        //
        // Именно КОНЧИЛА, а не «сменила состояние». Сюда попадает всякое шевеление вкладки — сменилась
        // строка статуса, дописался вопрос, — и на живой вкладке это по нескольку раз в секунду.
        // Ждущие фазы живут до двадцати минут, так что такт, задуманный как «раз в полминуты», шёл
        // тысячами: каждый — два снятия экрана и чтение снимка расхода с диска, и ни один из них не
        // мог решить ничего нового. Новость для автомата ровно одна, и она бывает раз в ход.
        const wasOver = restart.turnOver({ status: prev, bg: wasBg });
        const isOver = restart.turnOver({ status: next.status, bg: next.bg });
        if (isOver && !wasOver) {
          d.turnEndedAt = now;
          // Здесь же — а не в `turnEnded` ниже — встаёт пометка «человек этого ещё не видел»
          // (unread.js). Причина в том, ЧТО считать концом хода: телеграму нужен переход
          // работает→готов, потому что он отправляет ТЕКСТ итога, а тексту неоткуда взяться,
          // пока агент ждёт кнопки. Нам же важен сам факт «агент сказал и замолчал», и ход,
          // законченный зовом («Сейчас от тебя: …»), — самый частый его вид: до «готов» такая
          // вкладка не доходит вовсе. Считай мы концом хода только «готов», ответ на прямой
          // вопрос человека — то есть ровно тот случай, ради которого пометка заведена, —
          // остался бы непомеченным.
          //
          // `done` отделяет замолчавшего агента от ушедшего в фон: «ничего, жду замер стенда»
          // человеку тоже сказано, но настоящий ответ будет потом, и ожидание закрывать рано.
          //
          // Служебный ход сворма (просьба о перезапуске) отмечен отдельно — см. unread.onSwarmAsk.
          //
          // `needsYou` — нужно ли от человека что-нибудь. Зов вопросом или разрешением («ждёт») —
          // нужно; уход в фон и прямое «Сейчас от тебя: ничего» — нет. Второе видно только в тексте
          // хода, поэтому берём его же, что и телега (d.trFinal — весь ход, а не последняя реплика).
          // У вкладки без стенограммы текста нет, и такой ход считается обычным ответом: это прежнее
          // поведение, а не потеря — строгость лишь держит пометку до ответа человека.
          d.unread = unread.onTurnEnd(d.unread, {
            now,
            viewing: viewingNow(id),
            done: next.status !== 'running',
            needsYou: next.status === 'waiting'
              || (!next.bg && !saysNone(ASK_MATCHER, d.trFinal || d.trText || '')),
          });
          restartKick(id, d, 'turn');
        }
        // Ход был кончен и раньше, а ушла ПОМЕХА: досчитали сабагенты, закрылась рамка. Статус при
        // этом не меняется вовсе — вкладка всё это время «готова», — но держали перезапуск именно
        // они (см. turnOver и boxOpen в restart.js). Повод одноразовый, поэтому и без выдержки:
        // сабагенты досчитывают один раз, второго такого мига не будет.
        //
        // Рамку, закрывшуюся сама по себе — без единой другой перемены, — сюда не приносит ничто:
        // ветка живёт на смене статуса. Такое ожидание доедет общим тактом, за полминуты.
        else if (isOver && ((sub === 0 && wasSub > 0) || (wasBox && !d.waitingBox))) restartKick(id, d, 'clear');
        // Telegram: an agent starting to wait is the whole point of the bridge. Sent on
        // a delay (see tgOnWaiting) and cancelled if you answer at the keyboard first.
        if (next.status === 'waiting') {
          // Когда встала — нужно утренней сводке: «стоит сорок минут» и «стоит шесть часов»
          // это разные новости, а по журналу их не отличить (запись есть только у толчка).
          if (prev !== 'waiting') d.waitSince = now;
          tgOnWaiting(id);
          nightOnWaiting(id, d);
        } else {
          d.waitSince = 0;
          tgCancelWaiting(d);
          nightCancelWaiting(d);
        }
        // Ход НАЧАЛСЯ. Запоминаем момент, чтобы потом отличить свежий текст хода от текста
        // прошлого — см. tgOnDone, это и есть защита от «ответил не на то, что просили».
        // Фон досчитал и разбудил агента — это НОВЫЙ ход, хотя статус всё это время был
        // «работает». Без второго условия его началом считался бы момент, когда человек
        // отправил задачу час назад, и мост принял бы за свежий текст итог прошлого хода.
        if (next.status === 'running' && (prev !== 'running' || (wasBg && !next.bg))) d.turnStartedAt = now;
        // Turn finished on a task that came from the phone → report back there.
        //
        // `d.tgAck` — ДОЛГ: в чате висит «получил, думаю…», то есть человек с телефона ждёт
        // ответа именно на свой вопрос. Такой долг платится всегда, что бы за маком ни делали:
        // раньше достаточно было напечатать в этой вкладке что угодно, режим снимался, и итог
        // никуда не уезжал — заготовка оставалась с часиками навсегда, а спросивший так и не
        // узнавал, что ему ответили. Спросил из телеги — получи ответ в телегу.
        const owed = !!d.tgAck;
        // Долг платится всегда — на прямой вопрос с телефона надо ответить, где бы человек
        // ни сидел. Всё остальное — только когда мост вообще говорит сам (tgMirrors): «за
        // компом» вкладка молчит, даже если ход начали из телеги.
        //
        // Исключение — ход, который начали МЫ САМИ, спросив агента про перезапуск (rsQuiet):
        // человека он не касается, а в режиме телефона его итог прилетал бы уведомлением в три
        // часа ночи. Долг это не отменяет: на вопрос человека ответить надо.
        // Ход кончился и словами «ничего, жду замер стенда»: статус остался «работает», а
        // рассказывать уже есть что. Для человека с телефона это такой же итог, только с
        // часиками вместо галочки — он получает ответ сразу, а не через двадцать минут, и
        // видит, что отвечать не нужно. Долг за такой доклад считается уплаченным: на
        // вопрос ответили, заготовка «получил, думаю…» превращается в текст.
        // «Готов» — конец хода всегда, в том числе из фона: агент дождался задачи, дописал
        // итог и замолчал. А вход в фон концом хода считается ровно один раз — на переходе,
        // иначе каждое шевеление внутри фонового ожидания слало бы в чат один и тот же текст.
        const turnEnded = prev === 'running' && (next.status === 'ready' || (d.bg && !wasBg));
        const relay = turnEnded && TG.chatId != null && (owed || (tgMirrors() && !d.rsQuiet));
        if (turnEnded) d.rsQuiet = false;
        // В журнал — КАЖДАЯ смена статуса вкладки, за которой следит телеграм, и решение
        // про итог. Без этого «в телегу ничего не пришло» неотличимо от «ход не считался
        // законченным»: журнал показывал входящее сообщение и обрывался, а дальше начинались
        // догадки. Пишем и причину отказа, а не только факт.
        //
        // И `relay` в условии: пока его не было, отчёт «человека нет за маком» уходил вообще
        // без строки о переходе — в журнале итог появлялся из ниоткуда. Именно на этом
        // застрял разбор «молчащая вкладка присылает одно и то же раз в полчаса»: не видно
        // было, СЧИТАЕТ ли приложение, что там был ход.
        if (TG.chatId != null && (owed || d.tgMode || tgMirrors() || relay)) {
          tgLog(`  вкладка ${id}: ${prev} → ${next.status}${kind ? ':' + kind : ''}`
            + ` · итог ${relay ? 'отправляю' : 'нет'}`
            + (relay ? '' : ` (нужен переход работает→готов; долг=${owed ? 'да' : 'нет'}`
              + `, режим тлг=${d.tgMode ? 'да' : 'нет'}, где я=${tgPresence})`));
        }
        // Ход кончился — долг перед чатом кончился вместе с ним. Иначе отметка от кнопки
        // разрешения дожила бы до СЛЕДУЮЩЕГО хода, начатого за клавиатурой, и в теме без
        // повода завелась бы живая строка.
        if (next.status === 'ready') d.tgOwes = false;
        if (relay) tgOnDone(id, d);
      }
      // Уведомление могло не уйти — сеть рвётся ровно тогда, когда мак уснул или сменил
      // вайфай. Пока вкладка ждёт, а отправка не удалась, пробуем снова: потерянный запрос
      // разрешения это тишина в телеге, а человек ждёт именно его. Дребезг гасит tgOnWaiting,
      // а частоту — откол (tgRetryAt): без него это был поток отказов раз в полторы секунды,
      // который к тому же перелистывал журнал моста и стирал собственную диагностику.
      if (d.status === 'waiting' && !d.tgNotifiedAt && TG.chatId != null && !d.tgTimer
          && now >= (d.tgRetryAt || 0)) {
        tgOnWaiting(id);
      }
    } catch (_) {
      // A detector hiccup must never crash the app or freeze the UI.
    }
  }
}, TICK_MS);

// --- transcript reader: Claude's own message log ------------------------------
// Claude appends every message to ~/.claude/projects/<slug>/<session>.jsonl as it
// happens, so the file says what the agent is doing without guessing from pixels:
// an open tool_use → работает, a tool_result → думает, a quiet assistant message →
// конец хода (and the call phrase in it → ждёт-вопрос). transcript.js owns the
// classification; this block owns the file I/O and the tab↔file binding, and hands the
// verdict to the detector as its third channel (see detector.js applyTranscript).
//
// It also gives us the ONE thing the screen can't: the question word for word, whole,
// even after it scrolls out of the visible rows.
const transcript = require('./transcript');
const TR_TICK_MS = 500;
const TR_TAIL_BYTES = 64 * 1024;   // plenty for the last few entries of a big file
const TR_TEXT_MAX = 500;           // question excerpt sent to the renderer
// Предела длины ответа здесь НЕТ, и это осознанно. Настройка подробности («кратко» /
// «полностью») — это просьба к агенту отвечать короче, а не ножницы по готовому тексту:
// обрезать то, что агент уже сказал, значит прислать оборванную мысль и молча решить за
// человека, какая часть ответа ему не нужна. Длинное сообщение Telegram примет частями
// (telegram.chunkText делит по абзацам, tgSend отправляет все).
//
// Естественная граница всё равно есть: TR_TAIL_BYTES — сколько хвоста стенограммы читаем.
// Ход длиннее этого окна попадёт в чат не целиком, но такой ход не бывает ответом, он
// бывает историей с гигантскими выводами инструментов.
const TR_BIND_EVERY_MS = 2000;     // don't rescan a folder on every tick while unbound
// A bound file this quiet, while the pty is clearly talking, means we're reading a dead
// session — /clear starts a NEW one. Long enough that a slow tool (which writes nothing
// until it returns) can't trip it.
const TR_STALE_MS = 90_000;
// Журнал канала стенограммы: привязки и смены вердикта в <userData>/transcript.log. Как и
// журнал моста, пишется ВСЕГДА и ограничен по размеру. Он был за переменной окружения
// SWARM_TRANSCRIPT_LOG — и когда понадобился (в телегу уезжало «✅ готов» без текста
// ответа, потому что вкладка не привязана), его не оказалось, а включить у запущенного
// приложения нельзя. Дважды одна и та же ошибка — уже привычка, поэтому здесь тоже всегда.
const TR_LOG_MAX = 512 * 1024;

function trLog(line) {
  try {
    const file = path.join(app.getPath('userData'), 'transcript.log');
    try {
      if (fs.statSync(file).size > TR_LOG_MAX) fs.renameSync(file, file + '.1');
    } catch (_) { /* файла ещё нет */ }
    fs.appendFileSync(file, logStamp(null, true) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the app */ }
}

// --- журнал статуса: ПОЧЕМУ вкладка такого цвета -------------------------------
// Цвет вкладки складывают три канала (хуки, стенограмма, экран), и наружу выходит одно
// слово: «работает». Когда оно неверно — а неверное «работает» означает «занята, не
// подходи», то есть человек проходит мимо вкладки, которая его ждёт, — по этому слову
// нельзя понять ровным счётом ничего.
//
// Цена известна: разбор одного такого случая («агент написал „Сейчас от тебя: ничего“, а
// вкладка час горела оранжевым») занял вечер раскопок по чужим журналам, стенограммам и
// скриншоту, и всё равно упёрся в вопрос «а что в тот миг говорил каждый канал». Ответ на
// него стоит одной строки в файле — вот она.
//
// Пишем ТОЛЬКО смену статуса или подписи: остальное шевеление (строка статуса, текст
// вопроса) идёт по нескольку раз в секунду и утопило бы журнал. Как и два соседних
// журнала, включён всегда: тот, что «за переменной окружения», в нужный миг оказывается
// выключенным, а включить его у запущенного приложения нельзя.
const STATUS_LOG_MAX = 512 * 1024;

function statusLog(line) {
  try {
    const file = path.join(app.getPath('userData'), 'status.log');
    try {
      if (fs.statSync(file).size > STATUS_LOG_MAX) fs.renameSync(file, file + '.1');
    } catch (_) { /* файла ещё нет */ }
    fs.appendFileSync(file, logStamp(null, true) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the app */ }
}

// Возраст в человеческом виде: «3с», «2м», «1ч14м». Секунды в часовом возрасте не нужны,
// а вот отличить «минуту назад» от «полтора часа назад» — это здесь вся суть.
function agoText(at, now) {
  if (!at) return 'никогда';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return s + 'с';
  const m = Math.round(s / 60);
  if (m < 90) return m + 'м';
  return Math.floor(m / 60) + 'ч' + (m % 60) + 'м';
}

// Показания всех трёх каналов на этот такт — по порядку старшинства (см. tickStatus).
// Читается как ответ на «почему»: у кого спросили, что каждый ответил и когда говорил.
function statusWhy(d, now, snap, sub) {
  const hs = d.hookState;
  const hook = d.hooksActive
    ? `хук=${hs ? hs.status + (hs.bg ? ':фон' : '') + (hs.box ? ':рамка' : '') : 'нет'} ${agoText(hs && hs.at, now)}`
    : 'хук=не подключён';
  const tr = d.trState;
  const file = tr
    ? `файл=${tr.status}${tr.bg ? ':фон' : ''} (${d.trWhy || '?'}) ${agoText(tr.at, now)}`
      + `${trRunStale(tr, now) ? ' — протух, не голосует' : ''} [${d.trFile ? path.basename(d.trFile) : '?'}]`
    : 'файл=не привязан';
  const screen = `экран: спиннер=${RE_RUNNING.test(snap) ? 'да' : 'нет'}`
    + ` рамка=${hasPromptBox(snap) ? 'да' : 'нет'}`
    + ` зов=${asksForInput(snap) ? 'да' : 'нет'}`
    + ` фон=${waitsForWork(snap) ? 'да' : 'нет'}`
    + ` саб=${sub || 0}`
    + ` байты=${agoText(d.lastDataAt, now)}`
    + (d.scrolledBack ? ' ОТЛИСТАН' : '');
  return `${hook} · ${file} · ${screen}`;
}

// Отвязаться от файла — ОДНОЙ функцией, вместе с текстами, которые из него взяты. Раньше
// сброс перечислялся в трёх местах и везде забывал trReply/trFinal: вкладка теряла свой файл
// (/clear, ротация, форк от --resume), а тексты прошлого хода оставались жить — и уезжали в
// чат как итог нового. Худший вид ошибки: правдоподобный ответ не на ту задачу, да ещё с
// пометкой «стенограмма» в журнале, то есть с уверенно неверной причиной.
function trForget(d) {
  d.trFile = null; d.trMtime = 0; d.trEntries = null; d.trWhy = '';
  d.trReply = ''; d.trFinal = ''; d.trText = ''; d.trReplyAt = 0;
}

// Last `bytes` of a file as text, dropping the first (likely partial) line.
function tailText(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

// --- где Клод держит разговоры -------------------------------------------------------
// Домашний конфиг — не один. `CLAUDE_CONFIG_DIR` уводит Клода в другую папку целиком, и
// человек этим пользуется: у него алиасы `claude-my` и `claude-my2` под разные аккаунты. Пока
// здесь стоял один зашитый ~/.claude, такая вкладка не находила своего разговора НИКОГДА — со
// всеми последствиями: текста ответа в телеге нет (уезжает соскоб с экрана), а при
// перезапуске приложение решало, что разговор мёртв, и открывало вкладку с нуля.
//
// Порядок надёжности: адрес от хука (точный, см. d.trHint) → корень, в котором разговор этой
// вкладки уже находили (d.claudeHome) → все конфиги, какие есть в доме. Последнее — сеть
// безопасности для вкладок без хуков; она безопасна ровно потому, что найденное всё равно
// проверяется по папке, записанной ВНУТРИ файла.
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CONFIG_ROOTS_TTL_MS = 60_000;
let configRootsAt = 0;
let configRootsCache = [CLAUDE_HOME];

function configRoots() {
  const now = Date.now();
  if (now - configRootsAt < CONFIG_ROOTS_TTL_MS) return configRootsCache;
  configRootsAt = now;
  const out = [CLAUDE_HOME];
  try {
    for (const name of fs.readdirSync(os.homedir())) {
      if (!/^\.claude([-.].*)?$/.test(name)) continue;
      const root = path.join(os.homedir(), name);
      if (root === CLAUDE_HOME) continue;
      try { if (fs.statSync(path.join(root, 'projects')).isDirectory()) out.push(root); } catch (_) {}
    }
  } catch (_) { /* дома не прочитать — остаёмся с одним корнем */ }
  configRootsCache = out;
  return out;
}

function projectDir(cwd, home) {
  return path.join(home || CLAUDE_HOME, 'projects', transcript.projectSlug(cwd));
}

// Папки этого проекта во ВСЕХ конфигах: сначала та, где разговор уже находили.
function projectDirs(cwd, home) {
  const dirs = [];
  for (const root of [home || CLAUDE_HOME, ...configRoots()]) {
    const dir = projectDir(cwd, root);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}


// Bind this tab to a transcript file. Two ways, and the difference matters:
//
//   • by session id — we pinned it with --session-id at launch, or a hook marker told
//     us. Exact, no guessing.
//   • by folder scan — fallback for sessions whose id isn't ours (a resumed tab with
//     hooks off, or `claude` typed by hand). A candidate must have been written since
//     the tab opened, not be taken by another tab, and record the SAME cwd inside (the
//     folder name is a guess, the recorded cwd is proof). If TWO files still qualify we
//     bind NOTHING: showing one agent's status on another agent's tab is far worse than
//     falling back to the screen scraper.
//
// Returns null until claude actually starts writing.
// Сколько ждём файл с ПРИКРЕПЛЁННЫМ id, прежде чем признать, что разговор идёт под другим
// именем. Секунды: Claude пишет первую запись сразу, как только ему что-то сказали.
const TR_PIN_GRACE_MS = 15_000;

function bindTranscript(d, taken) {
  const dirs = projectDirs(d.cwd, d.claudeHome);
  // Адрес, названный самим Клодом (хук). Сильнее всего остального: он верен при любом
  // CLAUDE_CONFIG_DIR, в worktree и при слаге папки, который мы бы не угадали. Проверяем
  // только занятость и существование — остальное уже проверил тот, кто его прислал.
  if (d.trHint && !taken.has(d.trHint)) {
    try { if (fs.statSync(d.trHint).isFile()) return d.trHint; } catch (_) { /* ещё не создан */ }
  }
  if (d.claudeSessionId) {
    for (const dir of dirs) {
      const file = path.join(dir, d.claudeSessionId + '.jsonl');
      if (!taken.has(file) && fs.existsSync(file)) return file;
    }
    // Файла с этим именем нет — и раньше здесь стоял return null, то есть вкладка
    // оставалась без стенограммы НАВСЕГДА. А id — подсказка, не контракт: `--resume`
    // форкает разговор в новый файл, `/clear` начинает новый, `claude` из терминала
    // берёт свой. Наружу это выглядело так: в телегу уезжает «✅ готов» без единого
    // слова ответа, потому что текст итога берётся только из стенограммы.
    //
    // Поэтому даём прикреплённому id небольшую отсрочку (файл появляется не мгновенно),
    // а потом ищем сканом папки — с теми же защитами, что и для вкладки без id.
    if (Date.now() - (d.startedAt || 0) < TR_PIN_GRACE_MS) return null;
  }
  // Скан ищет файл, имени которого мы НЕ знаем, — то есть по косвенным признакам. Вкладке,
  // в которой не было ни одного хода, он противопоказан: своего разговора у неё пока нет (её
  // только что открыли, или в ней сделали /clear и ничего не сказали), а единственный
  // подходящий по признакам файл в папке — это чужой живой разговор соседней вкладки. Ровно
  // так пустая вкладка и начинала показывать чужой статус, а потом ещё и запоминала чужой id.
  if (!d.turnStartedAt) return null;
  // Скан идёт по ВСЕМ конфигам (см. configRoots): вкладка без хуков своего корня не знает, а
  // без этого её разговор из ~/.claude-my не нашёлся бы вообще. Лишние кандидаты не опасны:
  // ниже каждый проверяется по папке, записанной внутри файла, и при двух подходящих не
  // привязывается никто.
  const names = [];
  for (const dir of dirs) {
    try {
      for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl')) names.push(path.join(dir, n));
    } catch (_) { /* этого конфига нет — не беда */ }
  }
  if (!names.length) return null;
  const cands = [];
  for (const file of names) {
    if (taken.has(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch (_) { continue; }
    // Read the tail only for files young enough to be ours — the cwd check costs I/O.
    if (st.mtimeMs < d.startedAt - transcript.BIND_MTIME_SLACK_MS) continue;
    let cwdInside = null;
    let text = '';
    let userText = '';
    try {
      const entries = transcript.parseEntries(tailText(file, TR_TAIL_BYTES));
      cwdInside = transcript.cwdOf(entries);
      // Kept for the tie-break below: what the agent last SAID is also on its own screen.
      text = transcript.entryText(transcript.lastMain(entries) || {});
      // А это для самого надёжного ключа: реплики ЧЕЛОВЕКА. Если вкладку ведут из телеги,
      // мост знает свой текст дословно и найдёт файл по нему (см. pickByInjected).
      userText = entries.filter((e) => e.type === 'user')
        .map((e) => transcript.entryText(e)).join('\n');
    } catch (_) {}
    cands.push({ file, mtimeMs: st.mtimeMs, cwdInside, text, userText });
  }
  const one = transcript.pickBinding(cands, { startedAt: d.startedAt, cwd: d.cwd, taken });
  if (one) return one;
  const same = cands.filter((c) => c.cwdInside === d.cwd && !taken.has(c.file));
  // Вкладку ведут из телеги? Тогда у нас есть точный ключ — наш собственный текст с меткой
  // [тлг]. Он сильнее и свежести, и экрана, поэтому пробуется первым и работает даже когда
  // в папке три живых разговора (тот случай, где вкладка оставалась без стенограммы вовсе).
  const byInjected = transcript.pickByInjected(same, d.tgLastSent);
  if (byInjected) {
    trLog(`tab=${d.name || '?'} найдена по тексту из телеги → ${path.basename(byInjected)}`);
    return byInjected;
  }
  // Ambiguous by folder — the normal case with several tabs on one repo. Match what's on
  // THIS tab's screen against each candidate's last message.
  if (same.length < 2) return null;
  const byScreen = transcript.pickByScreen(same, snapshot(d));
  if (byScreen) trLog(`tab=${d.name || '?'} разведены по экрану → ${path.basename(byScreen)}`);
  return byScreen;
}

// Is there a transcript in this tab's folder that's newer than the one we're bound to?
// That's the signature of /clear: Claude started a fresh session (a new id, a new file)
// and our file will never be written again.
function newerTranscriptExists(d, taken) {
  for (const dir of projectDirs(d.cwd, d.claudeHome)) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      if (file === d.trFile || taken.has(file)) continue;
      try { if (fs.statSync(file).mtimeMs > d.trMtime + 1000) return true; } catch (_) {}
    }
  }
  return false;
}

// Ход кончился вопросом — по последней записи самого файла. Такой файл МОЛЧИТ ПО ДЕЛУ:
// человек ещё не ответил, писать в разговор нечего, и молчание тут не признак брошенной
// сессии, а её нормальное состояние. Проверка «файл молчит, а pty говорит» этого не
// различает: байты в терминал льёт кто угодно — подагент, перерисовка, чужой вывод, — и
// ждущая вкладка попадала под перепривязку каждые две секунды.
function trWaitingForMe(d) {
  return !!(d.trState && d.trState.status === 'waiting');
}

// Есть ли куда перепривязаться — ДРУГОЙ файл, не тот, что держим сейчас.
//
// Спрашиваем до отвязки, а не после. Раньше вкладка сначала отпускала стенограмму и только
// потом искала новую — и когда искать было нечего, находила ту же самую. Получался холостой
// круг: отвязка, две секунды без файла (TR_BIND_EVERY_MS), привязка обратно, и так минутами.
// Снаружи это выглядело мельканием статуса: без файла вердикт даёт экран, с файлом — файл.
//
// Ищем в тех же условиях, в каких оказалась бы отвязанная вкладка: без адреса от хука и без
// прикреплённого id — оба указывают на умолкший файл и вернули бы его же.
function rebindTarget(d, taken) {
  const busy = new Set(taken);
  busy.delete(d.trFile);
  for (const f of reservedByOthers(d)) busy.add(f);
  const probe = { ...d, trHint: '', claudeSessionId: null };
  const file = bindTranscript(probe, busy);
  return file && file !== d.trFile ? file : null;
}

// Отобрать свой файл у вкладки, которая держит его по устаревшему праву.
//
// Живой случай: вкладка 3 запустилась с `--resume a7c534c7`, Клод форкнул разговор в новый
// файл, а прикреплённый id остался у вкладки 3 — и она заняла собой ЧУЖОЙ файл. Настоящий
// хозяин, вкладка 4, привязаться уже не мог (занято) и присылал в телегу строку с экрана
// вместо ответа; а вкладка 3 показывала статус чужого агента — её вердикты менялись в такт
// ходам вкладки 4. Это худшее, что этот канал умеет делать.
//
// Право сильнее прикреплённого id ровно одно: текст, который мост НАПЕЧАТАЛ сам. Метку
// [тлг] с этой формулировкой никто в другой сессии не набирал, поэтому файл, где она лежит,
// принадлежит этой вкладке — даже если его кто-то занял.
function stealByInjected(id, d, taken) {
  if (!d.tgLastSent || d.trFile) return null;
  const names = [];
  for (const dir of projectDirs(d.cwd, d.claudeHome)) {
    try {
      for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl')) names.push(path.join(dir, n));
    } catch (_) { /* этого конфига нет */ }
  }
  if (!names.length) return null;
  const cands = [];
  for (const file of names) {
    let userText = '';
    try {
      const entries = transcript.parseEntries(tailText(file, TR_TAIL_BYTES));
      if (transcript.cwdOf(entries) !== d.cwd) continue;
      userText = entries.filter((e) => e.type === 'user').map((e) => transcript.entryText(e)).join('\n');
    } catch (_) { continue; }
    cands.push({ file, userText });
  }
  const mine = transcript.pickByInjected(cands, d.tgLastSent);
  if (!mine) return null;
  // Освобождаем прежнего держателя: он остался без стенограммы и найдёт свою сканом.
  for (const [otherId, o] of det) {
    if (o !== d && o.trFile === mine) {
      trLog(`tab=${id} забирает ${path.basename(mine)} у tab=${otherId} (там его текст из телеги)`);
      trForget(o);
      o.claudeSessionId = null;
      applyTranscript(o, null);
      taken.delete(mine);
    }
  }
  return mine;
}

// Чем вкладка ЗАНЯТА на самом деле: имя команды, запущенной в её шелле.
//
// Вкладка помнит, чем её запустили, и этим же восстанавливается — иначе после перезапуска
// она поднимет не того агента. Раньше это знание собиралось из набранных человеком строк, и
// мимо проходило всё остальное: алиас, запуск из скрипта, смена агента внутри вкладки. Живой
// случай — вкладку открыли Клодом, потом запустили в ней Cursor командой `agent`; вкладка
// осталась записанной как claude и им же вернулась после перезапуска.
//
// Здесь мы не угадываем, а смотрим: один `ps` на всё приложение, дети шеллов наших pty — это
// ровно те команды («claude --resume …», «agent»). Что из этого считать агентом, решает
// рендерер: список агентов ведёт он.
//
// НО про НАШ СОБСТВЕННЫЙ запуск смотреть нечего: вкладка и так знает, чем её запустили, а `ps`
// показывает не имя команды, а то, во что её развернул шелл. Алиас `claude-my` (это
// `CLAUDE_CONFIG_DIR=… command claude`, то есть другой аккаунт) виден в `ps` как обычный
// `claude` — и вкладка молча переписывала себе команду запуска на «claude». Дальше это стоило
// двух вещей: следующая вкладка в папке наследовала уже не тот алиас, а после перезапуска и
// сама вкладка возвращалась чужим аккаунтом. Поэтому первый процесс, поднятый нашей же строкой
// запуска, пропускаем — и сообщаем только о том, что человек запустил в шелле сам.
const PROC_EVERY_MS = 5000;
// Не верить первому потомку сразу после нашей строки: в ней есть `clear; `, и он тоже потомок —
// просто живёт миллисекунды. Успеть попасть тиком ровно в него шанс мал, но цена — запомнить
// вкладке «clear» вместо агента.
const PROC_SETTLE_MS = 2000;

function scanTabProcesses() {
  execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 4 << 20 }, (err, out) => {
    if (err) return;                     // ps недоступен — молча живём как раньше
    const kids = new Map();              // ppid -> [{ pid, args }]
    for (const line of String(out).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const list = kids.get(m[2]) || [];
      list.push({ pid: m[1], args: m[3] });
      kids.set(m[2], list);
    }
    for (const [id, child] of sessions) {
      const shellPid = child && child.pid != null ? String(child.pid) : null;
      if (!shellPid) continue;
      // Первый потомок шелла и есть запущенная команда. Глубже не идём: `claude` там уже
      // будет своими node-процессами, а нам нужно имя, которым его зовут.
      const run = (kids.get(shellPid) || [])[0];
      const dd = det.get(id);
      // Пусто ли в оболочке — на этом стоит самоперезапуск: свежий запуск нельзя печатать,
      // пока прежний агент не вышел, иначе строка уедет ему в поле ввода репликой в разговор.
      // Флаг остаётся undefined там, где `ps` недоступен (Windows) — там перезапуск ждёт по
      // часам и по экрану, а не по процессам (см. restart.goneStep).
      if (dd) dd.shellBusy = !!run;
      if (!run) continue;                // в шелле пусто — вкладка помнит прежнее
      const d = dd;
      if (!d) continue;
      // Процесс нашего запуска узнаём по pid: он поднялся первым и никуда не девался. Всё, что
      // человек запустит в этой вкладке потом (`agent`, `codex`), — это уже другой pid.
      if (d.launchAt) {
        if (Date.now() - d.launchAt < PROC_SETTLE_MS) continue;
        if (d.launchPid == null) d.launchPid = run.pid;
        if (d.launchPid === run.pid) continue;
        d.launchAt = 0;                  // наш запуск отжил своё — дальше смотрим как обычно
      }
      const word = path.basename((run.args.trim().split(/\s+/)[0] || ''));
      if (!word || d.runCmd === word) continue;
      d.runCmd = word;
      safeSend('session:proc', { id, cmd: word });
    }
  });
}

setInterval(scanTabProcesses, PROC_EVERY_MS);

// Файлы, закреплённые за ДРУГИМИ вкладками их session id, — для сканирования они заняты,
// даже пока те вкладки к ним не привязались.
//
// Без этого канал сам себя травил, и это видно в журнале: вкладка без своей стенограммы
// (после /clear ничего не сказано, файла ещё нет) уходила в скан папки, находила там
// ЕДИНСТВЕННЫЙ живой разговор — соседней вкладки — и забирала его. Дальше по коду ниже её
// id записывался вкладке в память и уезжал в localStorage. После перезапуска три вкладки
// восстанавливались «по session id» на ОДИН файл: один агент, три статуса, чужие ответы в
// чужих темах.
//
// Свой собственный id из резерва вычитается: если он уже размножен по вкладкам (а у тех,
// кто пострадал, он размножен), право на файл разбирает `taken` — первый привязавшийся
// забирает, остальные остаются на экранном détecteur'е. Показывать чужой статус хуже, чем
// не показывать никакого.
// Резерв считается по ВСЕМ конфигам: чей это разговор, определяет id, а в каком конфиге он
// лежит — вкладка может ещё не знать (см. configRoots). Плюс адрес, названный хуком: он и есть
// самое твёрдое право на файл.
function reservedByOthers(self) {
  const out = new Set();
  for (const d of det.values()) {
    if (d === self || d.dead || !d.cwd) continue;
    if (d.trHint) out.add(d.trHint);
    if (!d.claudeSessionId) continue;
    for (const dir of projectDirs(d.cwd, d.claudeHome)) {
      out.add(path.join(dir, d.claudeSessionId + '.jsonl'));
    }
  }
  if (self.trHint) out.delete(self.trHint);
  if (self.claudeSessionId && self.cwd) {
    for (const dir of projectDirs(self.cwd, self.claudeHome)) {
      out.delete(path.join(dir, self.claudeSessionId + '.jsonl'));
    }
  }
  return out;
}

setInterval(() => {
  const now = Date.now();
  const taken = new Set();
  for (const d of det.values()) if (d.trFile) taken.add(d.trFile);
  for (const [id, d] of det) {
    if (d.dead || !d.cwd) continue;
    try {
      // Прежде всего — не держит ли кто-то файл ЭТОЙ вкладки (см. stealByInjected).
      if (!d.trFile && d.tgLastSent) {
        const mine = stealByInjected(id, d, taken);
        if (mine) {
          d.trFile = mine;
          taken.add(mine);
          d.claudeSessionId = path.basename(mine, '.jsonl');
          safeSend('session:claude', { id, claudeSessionId: d.claudeSessionId });
          if (d.tgMode || d.auto) tgWriteModes();
          trLog(`tab=${id} → ${path.basename(mine)} (по тексту из телеги)`);
        }
      }
      // Bound to a session that's over? Drop it — including the id we pinned at
      // launch, which /clear has just made void — and let the scan (or the next hook
      // marker) find the new file. A frozen status is the worst thing this can do.
      if (d.trFile && now - d.trMtime > TR_STALE_MS && now - d.lastDataAt < 2000
          && !trWaitingForMe(d) && now - (d.trTryAt || 0) >= TR_BIND_EVERY_MS
          && newerTranscriptExists(d, taken)) {
        d.trTryAt = now;
        const other = rebindTarget(d, taken);
        if (other) {
          trLog(`tab=${id} стенограмма ${path.basename(d.trFile)} умолкла`
            + ` — перепривязка на ${path.basename(other)}`);
          taken.delete(d.trFile);
          trForget(d);
          d.claudeSessionId = null;
          // И адрес от хука тоже: он указывает на тот самый умолкший файл, и без сброса вкладка
          // тут же привязалась бы к нему обратно. Новый адрес хук пришлёт с первым же событием.
          d.trHint = '';
          applyTranscript(d, null);
          d.trTryAt = 0;                 // взять найденный файл сразу, а не через такт
        }
      }
      // Клод назвал адрес СВОЕГО разговора, а мы держим другой файл. Раньше подсказку хука
      // спрашивали только у вкладки без файла — и ошибка, сделанная сканом папки до первого
      // хука, оставалась навсегда: перепривязка бывает лишь по молчанию файла, а молчащий
      // файл — это ровно то, чем чужой (или брошенный) разговор и выглядит.
      //
      // Живьём: две вкладки держали ОДНУ стенограмму, дописанную в последний раз до обеда, а
      // разговор одной из них не держал никто. Такая вкладка показывает статус чужого агента
      // и шлёт в телегу чужой текст — это худшее, что этот канал умеет делать.
      //
      // Адрес от Клода сильнее любых догадок по свежести и экрану (см. bindTranscript), так
      // что при расхождении просто отпускаем чужое: привязка ниже возьмёт названный файл.
      if (d.trFile && d.trHint && d.trHint !== d.trFile && !taken.has(d.trHint)) {
        let real = false;
        try { real = fs.statSync(d.trHint).isFile(); } catch (_) { /* ещё не создан */ }
        if (real) {
          trLog(`tab=${id} держали чужой файл ${path.basename(d.trFile)}, хук назвал ${path.basename(d.trHint)} — перепривязка`);
          taken.delete(d.trFile);
          trForget(d);
          applyTranscript(d, null);
          d.trTryAt = 0;                 // взять названный файл прямо сейчас, а не через такт
        }
      }
      if (!d.trFile) {
        if (now - (d.trTryAt || 0) < TR_BIND_EVERY_MS) continue;
        d.trTryAt = now;
        // Занято = привязано кем-то сейчас ИЛИ закреплено за кем-то его id (см. выше).
        const busy = new Set(taken);
        for (const f of reservedByOthers(d)) busy.add(f);
        const file = bindTranscript(d, busy);
        if (!file) continue;
        d.trFile = file;
        taken.add(file);
        const stem = path.basename(file, '.jsonl');
        const byPin = stem === d.claudeSessionId;
        const byHint = file === d.trHint;
        // Запоминаем КОНФИГ, в котором нашёлся разговор: дальше вкладка ищет сначала там —
        // и там же приложение спрашивает, жив ли разговор перед `--resume`.
        const home = transcript.homeOfTranscript(file);
        if (home && home !== d.claudeHome) {
          d.claudeHome = home;
          if (home !== CLAUDE_HOME) trLog(`tab=${id} конфиг Клода: ${home}`);
        }
        trLog(`tab=${id} → ${path.basename(file)}`
          + (byHint ? ' (адрес от хука)' : byPin ? ' (по session id)' : ' (сканом папки)'));
        // Привязались сканом, хотя id был прикреплён — значит разговор идёт под ДРУГИМ
        // именем (форк от --resume, /clear). Прикреплённый id с этого момента врёт: по нему
        // хук не узнает сессию в списке «отвечаем с телефона», а следующее восстановление
        // вкладки попробует возобновить мёртвый разговор. Берём настоящий.
        if (d.claudeSessionId && !byPin) {
          d.claudeSessionId = stem;
          safeSend('session:claude', { id, claudeSessionId: stem });
          if (d.tgMode || d.auto) tgWriteModes();
        }
        // Bound without knowing the id (hooks off, `claude` typed by hand, a tab restored
        // by its old swarm-* name): the FILE NAME is that id. Hand it to the renderer so
        // the tab is saved with an exact handle and the next restore stops relying on a
        // name match. Deliberately not written into d.claudeSessionId — binding must stay
        // free to re-scan; this is only what we persist.
        if (!d.claudeSessionId) {
          safeSend('session:claude', { id, claudeSessionId: path.basename(file, '.jsonl') });
        }
      }
      // Re-read only when the file actually moved, but re-CLASSIFY every tick:
      // «готов» arrives by the ready-debounce expiring, not by a new write.
      const st = fs.statSync(d.trFile);
      if (st.mtimeMs !== d.trMtime) {
        d.trMtime = st.mtimeMs;
        d.trEntries = transcript.parseEntries(tailText(d.trFile, TR_TAIL_BYTES));
        // One message can be longer than the tail (a big tool result). Nothing parsed
        // out of a non-empty file means we cut inside a single line — read wider once.
        if (!d.trEntries.length && st.size > TR_TAIL_BYTES) {
          d.trEntries = transcript.parseEntries(tailText(d.trFile, TR_TAIL_BYTES * 8));
        }
      }
      // Стенограмма из прошлой жизни вкладки вердиктов не даёт — почему, см. isPastLife.
      // Статус в этот момент держит экран, где видно, что агент стоит у приглашения; как
      // только в разговоре появится новая запись, канал заработает сам.
      const pastLife = transcript.isPastLife(d.trEntries || [], d.startedAt);
      const v = pastLife
        ? null
        : transcript.classify(d.trEntries || [], now, (t) => callKind(ASK_MATCHER, t));
      applyTranscript(d, v);
      // The question, word for word — only for a turn that ended asking. Anything else
      // would be quoting streamed prose back at the user.
      d.trText = v && v.status === 'waiting' ? askExcerpt(ASK_MATCHER, v.text, TR_TEXT_MAX) : '';
      // А это — ВЕСЬ текст хода, для телеги: не только последнее сообщение, но и всё, что
      // агент говорил между инструментами (см. transcript.turnText). d.trText намеренно
      // обрезан от фразы-триггера («Сейчас от тебя: …») и годится только в подпись на плашке
      // вкладки: в чат так уезжал огрызок, хотя всё полезное агент сказал ДО этой фразы.
      if (v) d.trFinal = transcript.turnText(d.trEntries || []);
      // Итог хода — то, что мост отправляет как «вот что получилось».
      // Вместе с ним — ВРЕМЯ той записи, из которой он взят. Только по нему видно, этого хода
      // текст или прошлого: статус «готов» приходит от хука на секунду раньше, чем classify
      // отпустит свой отстой и обновит текст (см. tgOnDone).
      // Ход, закрытый словами «ничего, жду замер стенда», для человека такой же итог: агент
      // рассказал, что сделал, и ушёл ждать фон. Не запомнить текст здесь — значит отправить
      // в телегу пустой доклад «⏳ вкладка», хотя всё интересное уже сказано.
      if (v && (v.status === 'ready' || v.bg)) {
        d.trReply = d.trFinal;
        d.trReplyAt = v.at || now;
      }
      const why = v ? v.status + (v.kind ? ':' + v.kind : '') + ' (' + v.why + ')'
        : (pastLife ? 'прошлая жизнь вкладки — статус с экрана' : 'no entries');
      if (why !== d.trWhy) { d.trWhy = why; trLog(`tab=${id} ${why}`); }
    } catch (_) {
      // File rotated, deleted, or unreadable: drop the binding and fall back to the
      // screen until we can bind again.
      trForget(d);
      applyTranscript(d, null);
    }
  }
}, TR_TICK_MS);

// --- Telegram bridge: token, pairing, the poll loop ---------------------------
// The bot belongs to the USER: they paste a token from their own BotFather bot, so every
// install talks to its own bot and nothing goes through anyone else's server.
//
// The token is a secret, so it does NOT live in the renderer's localStorage next to the
// theme and the layout. main owns it, in a file only this account can read (0600 — см.
// tgPath). The UI gets back a MASKED form and never the token itself — so it can't leak
// through a log, a devtools session or a settings export.
//
// telegram.js holds everything protocol-shaped (and is unit-tested); this block is the
// part that has to touch Electron, the disk and the sessions.
const telegram = require('./telegram');
const voice = require('./voice');
// Markdown агента → разметка телеги. Отдельным модулем и со своими тестами: см. md.js.
const md = require('./md');
const { execFile } = require('child_process');
const qrcode = require('qrcode-generator');   // one file, no deps: the pairing QR

// How long a pairing code lives. NOT two minutes: the realistic path is «отправил код →
// бот сказал, что он не админ → пошёл в настройки группы, нашёл бота, выдал права,
// проверил, что включены темы → вернулся», and that takes longer than two minutes. A code
// that dies mid-fix looked exactly like a broken bridge, because an unknown code hits the
// «this chat isn't ours» branch and is dropped in silence.
const TG_PAIR_TTL_MS = 900_000;   // 15 minutes
// Сколько раз отказ проверки продлевает окно (см. tgBindChat). Не безграничное: иначе код
// можно держать живым сколько угодно, присылая его раз в четверть часа.
const TG_PAIR_RENEW_MAX = 2;
// ГДЕ Я СЕЙЧАС — одно положение на всё приложение, выбранное человеком, а не догадка.
// Два, потому что вопрос ровно один: за компом ты или с телефоном.
//
//   desk  «за компом»    — телефон молчит, и В ВКЛАДКИ МОСТ НЕ ПИШЕТ. Ты сидишь перед этими
//                          вкладками и всё видишь сам; жужжать над каждым вопросом, пока
//                          человек смотрит на него в упор, — это не забота, а помеха.
//   phone «за телефоном» — в группу идёт всё: вопросы, запросы разрешений, итоги ходов.
//                          И мак не засыпает — иначе отвечать некому, агенты живут здесь.
//
// Команды («что там у вкладок», «что сказал последним») работают всегда: они ничего не меняют
// и спрошены из чата.
//
// А вот СООБЩЕНИЕ в вкладку — только с телефона, и это граница по живому опыту. Раньше текст
// из чата в режиме компа доезжал до агента, но приезжал в полурежим: ход шёл, ответ на него
// возвращался — и на этом всё. Мак мог уснуть посреди хода (не спать ему велит только «за
// телефоном»), остальные вкладки молчали, а вопрос с вариантами в них было нечем закрыть.
// Понять это, глядя в телефон, невозможно: снаружи полурежим неотличим от полного.
//
// Поэтому дверь одна: в режиме компа сообщение НЕ уходит, а разворачивается кнопкой
// «включить режим телефона» — и уходит сразу после неё (см. tgDeskHold).
//
// Переключается и из приложения, и из телеги (/phone, /comp): ушёл и забыл — включишь с
// телефона, оттуда же и последний ответ спросишь (/last).
//
// Раньше это был выключатель с двумя подписями («отошёл» / «меня нет»), и обе читались как
// объявление об отсутствии — по выключенной кнопке невозможно было понять, включён режим
// или нет.
//
// Раньше здесь стояла догадка — `powerMonitor.getSystemIdleTime() >= 300`, — и она врала в
// обе стороны. Простой считается в момент, когда ход ЗАКОНЧИЛСЯ: загрузил десяток агентов,
// встал и вышел — первые итоги приходят внутри пятиминутного окна, и ровно они, самые
// интересные, никуда не уезжали. Задел трекпад, проходя мимо, — счётчик обнулился. И
// наоборот: сидишь читаешь, мыши не касаешься пять минут — зеркало включилось само, хотя ты
// за столом. Момент, когда человек ушёл, знает только человек.
//
// Снимается тоже руками. Автоснятие по первому вводу было бы той же эвристикой с другого
// конца: разбудил мак будильником или тронул мышь через удалённый доступ — зеркало молча
// выключилось, и узнаёшь об этом по тишине в телеге, когда уже поздно.
//
// На диске НЕ хранится: приложение запустилось — значит ты за компьютером. Иначе «включил
// вчера, забыл выключить» встречало бы утром жужжащим телефоном.
//
// Единственный выключатель, и это стоило отдельного решения. Рядом жила галка «писать
// всегда, даже когда я за компом» — тот же вопрос, заданный второй раз, и с ней вышло
// хуже, чем без неё: галка ПРЯТАЛА иконку (выбирать, мол, нечего), а положение при этом
// продолжало жить и переключаться с телефона. Сказал в дороге /phone, вернулся за стол — и
// мак не спит, а агенты во всех вкладках отказываются показывать варианты выбора (хук
// смотрит именно сюда), причём в приложении об этом ни следа. Одно состояние, одна кнопка.
const TG_PRESENCE = ['desk', 'phone', 'night'];
let tgPresence = 'desk';

// Пишет ли мост в группу ПО СВОЕЙ ИНИЦИАТИВЕ — вопросы, разрешения, итоги ходов. Ответы на
// спрошенное из чата этим правилом не гасятся (см. tgPresence).
function tgMirrors() {
  return tgPresence === 'phone';
}
// Журнал моста: каждое входящее сообщение и что мы с ним сделали — в
// <userData>/telegram.log. Пишется ВСЕГДА, и это осознанно: раньше он включался
// переменной окружения SWARM_TG_LOG, то есть ровно в тот момент, когда журнал нужен —
// «мост повёл себя странно только что» — его и не было, а включить его у уже запущенного
// приложения нельзя. Диагностика, которую надо предусмотреть заранее, не диагностика.
//
// Цена — несколько строк на сообщение из телеги, поэтому файл ограничен по размеру и
// переливается в .1: два файла, дальше старое пропадает. Ни одна ошибка здесь не имеет
// права ронять мост — журнал не важнее работы.
const TG_LOG_MAX = 512 * 1024;

function tgLogPath() { return path.join(app.getPath('userData'), 'telegram.log'); }

// Журнал в файл с той же ротацией. Своё имя файла у каждого дела: мост и самоперезапуск
// разбираются по-отдельности, и мешать их в одну ленту значит читать чужие строки в поисках
// своих. Правило общее и для тех, и для этих — журнал не важнее работы, поэтому всё в try.
function logTo(name, line) {
  try {
    const file = path.join(app.getPath('userData'), name);
    try {
      if (fs.statSync(file).size > TG_LOG_MAX) fs.renameSync(file, file + '.1');
    } catch (_) { /* файла ещё нет — обычное дело */ }
    fs.appendFileSync(file, logStamp(null, true) + ' ' + line + '\n');
  } catch (_) { /* diagnostics must never break the bridge */ }
}

function tgLog(line) {
  logTo('telegram.log', line);
}

// Момент времени в том же виде, что и метка строки журнала (местное, чч:мм:сс). Нужен, чтобы
// решение «текст этого хода или прошлого» можно было проверить по журналу, а не выводить из
// кода: без этих двух отметок «прислал старый ответ» и «прислал новый» в журнале выглядели
// одинаково, и разбор упирался в догадки.
function tgStamp(ms) {
  const t = Number(ms) || 0;
  return t ? logStamp(t) : 'никогда';
}

// What we tell an agent when its input arrives from a phone. Two ready-made wordings
// («кратко» / «полностью», telegram.PROMPTS) plus a free-text override in the panel;
// kept on one line, because it's injected as one line of terminal input.
//
// Именно ЭТА строка и есть настройка «кратко или полностью»: краткость в телеге всегда
// делалась просьбой к агенту, а не обрезкой готового ответа.
let TG_PROMPT = telegram.PROMPTS.short;

function tgPromptDefault() { return telegram.detailPrompt(TG.detail); }

// Своя формулировка перебивает пресет: человек, написавший её руками, знает, чего хочет.
// Что просят у агента, отвечающего в телегу. Своя формулировка действует, только когда она и
// ВЫБРАНА: раньше она перебивала пресет молча, и переключатель «кратко/полностью» ни на что не
// влиял, пока в поле лежал чужой текст. Теперь это одно и то же положение из трёх.
function tgApplyPrompt() {
  TG_PROMPT = (TG.detail === 'custom' && TG.prompt) ? TG.prompt : tgPromptDefault();
}

let TG = { token: '', chatId: null, isForum: false, topics: {} };
let tgPoller = null;
let tgBot = '';        // bot username from getMe — shown in settings, used in the link
let tgPair = null;     // { code, at } while a pairing window is open
let tgError = null;    // last error, verbatim for the settings panel

// Настройки моста (вместе с токеном бота) лежат в файле, который читает только этот
// аккаунт, — не в связке ключей.
//
// Раньше файл шифровался через safeStorage, а тот держит ключ в связке. Связка привязывает
// разрешение к отпечатку подписи приложения; Swarm подписан ad-hoc (без Developer ID —
// осознанное решение), отпечаток меняется с каждой сборкой, и «Разрешить всегда» не
// запоминается. Итог: у всех, кто настроил мост, macOS спрашивала пароль от учётной записи
// при КАЖДОМ запуске — за защиту, которой на деле не было.
//
// Плата за обычный файл: токен видит любой процесс, запущенный от этого пользователя.
// Для токена бота, который умеет только переписываться с вашей же группой, размен честный —
// примерно так же живут конфиги консольных утилит.
function tgPath() { return path.join(app.getPath('userData'), 'telegram.json'); }
// Файл прежнего формата. Расшифровывается ровно один раз — при первом запуске новой
// версии, — и заменяется обычным.
function tgLegacyPath() { return path.join(app.getPath('userData'), 'telegram.dat'); }

function tgBlank() { return { token: '', chatId: null, isForum: false, topics: {}, prompt: '', detail: 'short', detailPick: false, keepAwake: true, night: false, nightRule: '', nightAsk: '', whisperBin: '', whisperModel: '' }; }

// The last result of tgCheckChat(), so the settings panel can show «бот администратор,
// темы доступны» without re-asking Telegram on every render.
let tgCheck = null;

// Anything unreadable — a file copied from another machine, a half-written save — means
// «not configured». Never a crash on launch.
function tgLoad() {
  const d = tgReadStored();
  TG = d ? {
    token: String(d.token || ''),
    chatId: Number.isFinite(d.chatId) ? d.chatId : null,
    isForum: !!d.isForum,
    topics: (d.topics && typeof d.topics === 'object') ? d.topics : {},
    prompt: String(d.prompt || ''),
    // Файл прошлой версии подробности не знает — и это ровно то, чем мост жил до сих пор.
    //
    // Переезд. Раньше своя формулировка перебивала пресет молча: `TG.prompt || пресет`. Теперь
    // она действует только выбранной («своя формулировка» третьим положением), и человек,
    // обновившийся со своим текстом, тихо потерял бы его действие — текст на месте, в поле
    // виден, а мост просит «кратко». Поэтому у файла БЕЗ отметки о выборе (то есть от прежней
    // версии) непустой текст сам поднимает положение до 'custom': это ровно то поведение, с
    // которым человек жил. Отметку detailPick пишут обе двери — setDetail и setPrompt.
    detail: (!d.detailPick && String(d.prompt || '').trim())
      ? 'custom'
      : (telegram.DETAILS.includes(d.detail) ? d.detail : 'short'),
    detailPick: !!d.detailPick,
    keepAwake: d.keepAwake !== false,
    // Ночь — не настройка, а положение дел, но записанное: см. tgSetPresence.
    night: !!d.night,
    nightFrom: Number.isFinite(d.nightFrom) ? d.nightFrom : 0,
    // Свои формулировки ночи. Лежат здесь, потому что здесь же лежит «где я»: ночь — его
    // третье положение, и файл этот хук уже читает (см. tgWriteModes).
    nightRule: String(d.nightRule || ''),
    nightAsk: String(d.nightAsk || ''),
    // `mirrorAll` из файлов прежних версий сюда не переносится и нигде не читается: галку
    // «писать всегда» заменило одно положение «где я» (см. TG_PRESENCE). Поле в старом
    // файле останется лежать до первого сохранения и исчезнет само.
    whisperBin: String(d.whisperBin || ''),
    whisperModel: String(d.whisperModel || ''),
  } : tgBlank();
  tgApplyPrompt();
  // Начало окна отчёта возвращаем ВСЕГДА, а не только вместе с ночным режимом: окно могло начаться
  // с мандата одной вкладки, и такая вкладка вернётся вместе со своей отметкой. Без этой строки
  // отчёт после перезапуска считался бы с мига восстановления — «без тебя 2 минуты» вместо ночи.
  nightFrom = Number.isFinite(TG.nightFrom) ? TG.nightFrom : 0;
  // «Меня нет» возвращаем как было. Остальные положения — нет: «за телефоном», доставшееся от
  // вчерашнего вечера, значило бы, что агенты во всех вкладках отказываются показывать
  // варианты выбора человеку, который сидит перед маком.
  if (TG.night) {
    tgPresence = night.NIGHT;
    if (!nightFrom) nightFrom = Date.now();
    // Хук читает «где я» с диска, а его файл переписали ДО нас (provisionStatusline бежит
    // раньше tgLoad) — там сейчас «за компом». Без этой строчки первую половину ночи агенты
    // получали бы не ночное правило, а обычную рамку с вариантами.
    tgWriteModes();
    tgApplyKeepAwake();
  }
}

// Обычный файл, а если его нет — зашифрованный файл прежних версий, разово.
//
// Миграция стоит одного запроса пароля от связки ключей — последнего. Если его отклонили,
// старый файл остаётся на месте: мост в этот раз не поднимется, но настройки не потеряны и
// попытка повторится при следующем запуске.
function tgReadStored() {
  try {
    if (fs.existsSync(tgPath())) return JSON.parse(fs.readFileSync(tgPath(), 'utf8'));
  } catch (_) { return null; }
  if (!fs.existsSync(tgLegacyPath())) return null;
  let old = null;
  try { old = JSON.parse(safeStorage.decryptString(fs.readFileSync(tgLegacyPath()))); }
  catch (_) { return null; }
  try {
    fs.writeFileSync(tgPath(), JSON.stringify(old), { mode: 0o600 });
    fs.unlinkSync(tgLegacyPath());
  } catch (_) { /* не переписалось — попробуем в следующий раз, данные уже в руках */ }
  return old;
}

function tgSave() {
  fs.writeFileSync(tgPath(), JSON.stringify(TG), { mode: 0o600 });
}

// One call to Telegram. getUpdates holds the request open for ~25 s, so the abort timer
// must be longer than that — but finite, or a half-dead connection hangs the loop.
//
// НЕ БРОСАЕТ. Обрыв связи (сон мака, смена сети, VPN) — штатное событие для моста, а не
// исключение: пока эта функция бросала, «fetch failed» всплывал в логе приложения, а
// уведомление о запросе разрешения просто терялось. Сетевая беда выглядит здесь как обычный
// отказ Telegram (status 0), и все вызывающие, которые и так проверяют ok, ведут себя верно.
async function tgFetchJson(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (telegram.POLL_TIMEOUT_S + 15) * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch (_) { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    const why = (e && e.name === 'AbortError') ? 'таймаут' : ((e && e.message) || String(e));
    return { ok: false, status: 0, body: null, netError: why };
  } finally { clearTimeout(timer); }
}

// Повтор для отправки: сетевой обрыв и 5xx у Telegram — не повод терять сообщение. Три
// попытки с растущей паузой; дальше отказ уходит в журнал и в панель настроек.
const TG_SEND_TRIES = 3;

async function tgFetchWithRetry(url, body) {
  let res = null;
  for (let i = 0; i < TG_SEND_TRIES; i++) {
    res = await tgFetchJson(url, body);
    const transient = res.status === 0 || res.status >= 500;
    if (!transient) return res;
    if (i + 1 < TG_SEND_TRIES) {
      tgLog(`  сеть подвела (${res.netError || 'HTTP ' + res.status}) — повтор ${i + 2}/${TG_SEND_TRIES}`);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  return res;
}

// Send text to the bound chat (or to `chatId` during pairing, before one is bound).
// Splits at Telegram's 4096-char limit and returns the LAST message id — that id is what
// an answer replies to, so it's the routing key tgRemember/tgRoute hang the tabs on.
async function tgSend(opts) {
  const o = opts || {};
  const chatId = o.chatId != null ? o.chatId : TG.chatId;
  if (!TG.token || chatId == null) return null;
  let last = null;
  // Режем ДО разметки, по исходному тексту: предел телеги — 4096 символов готового
  // сообщения, а тэги в него не считаются, так что кусок исходника заведомо влезет.
  const parts = telegram.chunkText(o.text, telegram.MAX_TEXT);
  for (const part of parts) {
    // `rich` — текст агента: markdown в нём превращается в разметку телеги (см. md.js).
    // Возвращаться к нему приходится дважды, поэтому исходный кусок держим рядом: если
    // телега разметку не примет, тот же текст уйдёт без неё.
    const rich = o.rich ? md.toHtml(part) : null;
    const body = { chat_id: chatId, text: rich == null ? part : rich, disable_notification: !!o.silent };
    // Разметка — по явной просьбе: `parseMode` там, где мы строим её сами (/tabs со
    // ссылками на темы), `rich` — где её принёс агент. Без просьбы разметки нет: в чужом
    // тексте полно `<`, и parse_mode превратил бы его в отказ Telegram.
    if (o.parseMode) body.parse_mode = o.parseMode;
    else if (rich != null) body.parse_mode = 'HTML';
    if (o.threadId) body.message_thread_id = o.threadId;
    if (o.replyTo) body.reply_to_message_id = o.replyTo;
    // Buttons go on the LAST chunk: that's the one the answer hangs off.
    if (o.replyMarkup && part === parts[parts.length - 1]) body.reply_markup = o.replyMarkup;
    let res = await tgFetchWithRetry(telegram.apiUrl(TG.token, 'sendMessage'), body);
    // Разметка не понравилась — отправляем тот же текст как есть. Ответ агента важнее его
    // оформления: молчание в чате нельзя объяснить ничем, а звёздочки вместо жирного —
    // можно. Один заход, и только на отказ ИМЕННО про разметку (telegram.entityError).
    if (!res.ok && rich != null && !o.parseMode && telegram.entityError(res.body)) {
      tgLog(`  ⚠ разметку телега не приняла (${(res.body && res.body.description) || ''}) — отправляю без неё`);
      delete body.parse_mode;
      body.text = part;
      res = await tgFetchWithRetry(telegram.apiUrl(TG.token, 'sendMessage'), body);
    }
    // The user deleted the topic we remembered. Don't swallow the message: forget the
    // mapping (a fresh topic gets made next time) and deliver this one to General.
    if (!res.ok && body.message_thread_id && /thread not found/i.test(
      (res.body && res.body.description) || '')) {
      tgForgetTopic(body.message_thread_id);
      delete body.message_thread_id;
      res = await tgFetchJson(telegram.apiUrl(TG.token, 'sendMessage'), body);
    }
    if (!res.ok || !res.body || res.body.ok !== true) {
      tgError = telegram.classifyError(res.status, res.body).message;
      // Отказ Telegram — самая важная строка в журнале: без неё «в чат ничего не пришло»
      // выглядит как «приложение не пыталось», хотя оно пыталось и получило отлуп.
      tgLog(`  ✗ не отправлено (тема ${body.message_thread_id == null ? 'общая' : body.message_thread_id}):`
        + ` HTTP ${res.status} ${(res.body && res.body.description) || ''}`);
      tgPush();
      return last;
    }
    last = res.body.result && res.body.result.message_id;
    tgLog(`  → отправлено ${last} в тему ${body.message_thread_id == null ? 'общую' : body.message_thread_id}`
      + `: ${JSON.stringify(part.slice(0, 50))}`);
  }
  return last;
}

// Бинарник whisper: путь из настроек, иначе поиск в PATH (имена и .exe — в voice.js).
function tgWhisperBin() {
  return voice.findBinary({
    configured: TG.whisperBin || '',
    pathEnv: process.env.PATH || '',
    isWin: process.platform === 'win32',
    join: path.join,
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } },
  });
}

// --- Голос: установка одной кнопкой -------------------------------------------
// Пользователь не ставит ничего руками и не вбивает путей: кнопка тянет распознаватель из
// нашего же реестра (там, откуда ходят обновления) и модель с HuggingFace. В сборке нет ни
// того, ни другого — кому голос не нужен, тот не платит за него ни размером приложения, ни
// весом обновления. Ручные поля остаются для тех, у кого whisper.cpp уже стоит.
// Ассеты релизов гитхаба, публично — без токенов и учётных данных.
//
// Почему не `releases/latest/download/…`, как у обновлялки: «latest» у гитхаба — это
// самый свежий релиз ВООБЩЕ, а он почти всегда релиз приложения, и whisper.json в нём
// не лежит. Поэтому распознаватель живёт на фиксированном теге `whisper`, чей
// whisper.json перезаписывается при каждой публикации — ровно та мутабельная точка
// входа, которой раньше был путь `apps/latest/` в реестре гитлаба.
//
// И обратное требование, которое легко забыть: релизы whisper обязаны помечаться
// prerelease. Иначе свежеопубликованный распознаватель станет «latest», и обновление
// приложения начнёт получать 404 вместо манифеста. Ассеты у prerelease качаются как
// обычно, из выбора «latest» такой релиз просто исключён.
//
// Владелец и репозиторий — из package.json, одним местом на всё приложение
// (см. updaterCore.ghSlug): переименование аккаунта не должно означать правку в четырёх
// файлах, из которых один забудут.
const GH_REPO = `https://github.com/${require('./updater-core').ghSlug(require('./package.json').repository)}`;
const VOICE_REG = `${GH_REPO}/releases/download`;
const VOICE_MANIFEST_URL = `${VOICE_REG}/whisper/whisper.json`;
const VOICE_PROGRESS_MS = 200;      // как часто обновлять полосу, а не на каждый пакет

let voiceJob = null;                // идущая установка; одна за раз
let voiceError = null;

function voiceDir() { return path.join(app.getPath('userData'), voice.RUNTIME_DIRNAME); }

// Свой загрузчик, а не тот, что внутри updater.js: здесь нужен прогресс по байтам через
// несколько файлов и отмена. Редиректы `fetch` проходит сам — и модели с CDN HuggingFace,
// и ассеты гитхаба, которые тоже отдаются через 302.
async function voiceFetchFile(url, dest, opts) {
  const o = opts || {};
  const res = await fetch(url, { signal: o.signal });
  if (!res.ok || !res.body) throw new Error(`не ответил сервер (HTTP ${res.status})`);
  // Пишем в .part и переименовываем в конце: недокачанный файл никогда не должен
  // выглядеть готовым — иначе следующий запуск сочтёт его моделью и «ничего не разберёт».
  const part = dest + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (o.onBytes) o.onBytes(chunk.length);
      if (!out.write(chunk)) await new Promise((r, j) => { out.once('drain', r); out.once('error', j); });
    }
    await new Promise((r, j) => { out.end(); out.once('finish', r); out.once('error', j); });
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(part); } catch (_) {}
    throw e;
  }
  const got = hash.digest('hex');
  if (o.sha256 && got !== String(o.sha256).toLowerCase()) {
    try { fs.unlinkSync(part); } catch (_) {}
    throw new Error('файл скачался битым (sha256 не совпал)');
  }
  fs.renameSync(part, dest);
}

// План установки с учётом того, что уже лежит: повторное нажатие после обрыва не тянет
// заново 148 МБ. Целость по размеру, а не по хешу: хешировать модель при каждом открытии
// настроек — ощутимая пауза, а битое отсекается при скачивании.
async function voicePlan(modelId) {
  const res = await fetch(VOICE_MANIFEST_URL);
  if (!res.ok) throw new Error(`список сборок распознавателя недоступен (HTTP ${res.status})`);
  const manifest = await res.json();
  const args = {
    dir: voiceDir(), platform: process.platform, arch: process.arch, modelId, manifest,
    base: `${VOICE_REG}/whisper-${manifest.version}`, join: path.join,
  };
  const full = voice.installPlan(args);
  if (!full.ok) return full;
  const have = new Set();
  for (const it of full.items) {
    try { if (fs.statSync(it.target).size === it.bytes) have.add(it.name); } catch (_) {}
  }
  return voice.installPlan(Object.assign({ have }, args));
}

let voicePushAt = 0;
function voicePush(force) {
  const now = Date.now();
  if (!force && now - voicePushAt < VOICE_PROGRESS_MS) return;
  voicePushAt = now;
  tgPush();
}

async function voiceInstall(modelId) {
  if (voiceJob) return;
  voiceError = null;
  const ctl = new AbortController();
  voiceJob = { total: 0, done: 0, what: 'подготовка', ctl };
  voicePush(true);
  try {
    const plan = await voicePlan(modelId);
    if (!plan.ok) {
      throw new Error('для этой системы готовой сборки распознавателя нет —'
        + ' поставьте whisper.cpp сами и укажите пути кнопкой «Уже есть whisper.cpp»');
    }
    voiceJob.total = plan.bytes;
    fs.mkdirSync(voiceDir(), { recursive: true });
    for (const it of plan.items) {
      voiceJob.what = it.kind === 'model' ? 'модель' : 'распознаватель';
      voicePush(true);
      await voiceFetchFile(it.url, it.target, {
        sha256: it.sha256,
        signal: ctl.signal,
        onBytes: (n) => { voiceJob.done += n; voicePush(); },
      });
      // Без +x скачанный бинарник просто не запустится, а «whisper не отработал» —
      // бесполезная диагностика для того, кто ничего руками не делал.
      if (it.exec) { try { fs.chmodSync(it.target, 0o755); } catch (_) {} }
    }
    TG.whisperBin = plan.bin;
    TG.whisperModel = plan.model;
    try { tgSave(); } catch (e) { reportMainError(e); }
  } catch (e) {
    voiceError = ctl.signal.aborted ? 'Установка отменена.'
      : 'Не получилось установить голос: ' + ((e && e.message) || e);
  } finally {
    voiceJob = null;
    voicePush(true);
  }
}

// Вернуть мегабайты: удалить скачанное и забыть пути. Ровно то, чего не хватает, когда
// функцию попробовали и решили, что она не нужна.
function voiceRemove() {
  if (voiceJob) { voiceJob.ctl.abort(); }
  try { fs.rmSync(voiceDir(), { recursive: true, force: true }); } catch (e) { reportMainError(e); }
  // Ручные пути (whisper из PATH) не трогаем — удаляем только то, что установили сами.
  if (String(TG.whisperBin || '').startsWith(voiceDir())) TG.whisperBin = '';
  if (String(TG.whisperModel || '').startsWith(voiceDir())) TG.whisperModel = '';
  voiceError = null;
  try { tgSave(); } catch (e) { reportMainError(e); }
}

// Сколько места занято скачанным — чтобы кнопка «Удалить» называла цифру.
function voiceDiskBytes() {
  let sum = 0;
  try {
    for (const f of fs.readdirSync(voiceDir())) {
      try { sum += fs.statSync(path.join(voiceDir(), f)).size; } catch (_) {}
    }
  } catch (_) { /* папки нет — ноль */ }
  return sum;
}

// Какая модель установлена: узнаём по имени файла, отдельного состояния не держим.
function voiceInstalledModel() {
  const m = /ggml-([a-z0-9.-]+)\.bin$/.exec(String(TG.whisperModel || ''));
  return m ? m[1] : null;
}

function voiceState() {
  return {
    busy: !!voiceJob,
    what: voiceJob ? voiceJob.what : '',
    done: voiceJob ? voiceJob.done : 0,
    total: voiceJob ? voiceJob.total : 0,
    error: voiceError,
    model: voiceInstalledModel(),
    managed: String(TG.whisperModel || '').startsWith(voiceDir()),
    diskBytes: voiceDiskBytes(),
    models: voice.MODELS.map((m) => ({ id: m.id, label: m.label, bytes: m.bytes, note: m.note,
      recommended: !!m.recommended })),
  };
}

ipcMain.handle('voice:install', (_e, modelId) => { voiceInstall(String(modelId || 'base')).catch(reportMainError); return tgState(); });
ipcMain.handle('voice:cancel', () => { if (voiceJob) voiceJob.ctl.abort(); return tgState(); });
ipcMain.handle('voice:remove', () => { voiceRemove(); return tgState(); });

// Показать журнал моста в Finder/Проводнике. Нужно, чтобы «пришли журнал» не означало
// «открой терминал и найди папку профиля приложения».
ipcMain.handle('telegram:showLog', () => {
  const file = tgLogPath();
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'журнал пуст — мост ещё ничего не делал\n');
    shell.showItemInFolder(file);
    return true;
  } catch (e) { reportMainError(e); return false; }
});

// Декодирование Opus живёт в рендерере: Chromium умеет это сам, поэтому ffmpeg не нужен ни
// на маке, ни на винде. Здесь только мостик «отправил байты — получил моно 16 кГц».
let tgDecodeSeq = 1;
const tgDecodeWaiting = new Map();

ipcMain.on('audio:decoded', (_e, { reqId, samples, error } = {}) => {
  const done = tgDecodeWaiting.get(reqId);
  if (!done) return;
  tgDecodeWaiting.delete(reqId);
  done(error ? { error } : { samples });
});

function tgDecodeAudio(bytes) {
  return new Promise((resolve) => {
    const reqId = tgDecodeSeq++;
    tgDecodeWaiting.set(reqId, resolve);
    safeSend('audio:decode', { reqId, bytes });
    // Окно может быть закрыто или занято — не держим голос вечно.
    setTimeout(() => {
      if (tgDecodeWaiting.delete(reqId)) resolve({ error: 'декодирование не ответило' });
    }, 20000);
  });
}

// Дольше этого голосовое не берём. Двухминутная запись — это уже не «сказал на ходу», а
// монолог: распознавание займёт больше, чем есть терпения, и почти всегда это случайно
// зажатая кнопка. Отказ приходит сразу, ДО скачивания, поэтому стоит он ноль.
const TG_VOICE_MAX_S = 120;
// Больше самой длинной допустимой записи с запасом: реальная фраза успевает, а зависший
// бинарник (не та модель, битый файл) всё равно будет убит и ответит ошибкой.
const TG_WHISPER_TIMEOUT_MS = 180000;

// Голосовое → текст. Возвращает { text } или { error } — текст ошибки уходит в чат как
// есть, потому что человек с телефоном должен понимать, что чинить. Ни один путь отсюда не
// имеет права бросить: голосовое, на которое не пришло НИЧЕГО, выглядит как сдохший мост.
async function tgVoiceToText(fileId) {
  const bin = tgWhisperBin();
  if (!bin || !TG.whisperModel) {
    return { error: 'Голос не настроен: «Настройки → Телеграм» → «Включить голосовые» (одна кнопка,'
      + ' распознаватель скачается сам).' };
  }
  let wav = null;
  try {
    // Сеть здесь рвётся штатно (телефон в метро, мак ушёл в сон): fetch в этом случае не
    // возвращает ошибку, а БРОСАЕТ, и без try весь ответ на голосовое сводился к записи в
    // лог main-процесса — в чате тишина.
    const info = await tgFetchJson(telegram.apiUrl(TG.token, 'getFile'), { file_id: fileId });
    const fpath = info.ok && info.body && info.body.ok === true && info.body.result && info.body.result.file_path;
    if (!fpath) return { error: 'Не смог забрать файл у Telegram.' };
    const res = await fetch(`${telegram.API_HOST}/file/bot${TG.token}/${fpath}`);
    if (!res.ok) return { error: 'Не смог скачать голосовое.' };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const decoded = await tgDecodeAudio(bytes);
    if (decoded.error || !decoded.samples || !decoded.samples.length) {
      return { error: 'Не смог декодировать запись: ' + (decoded.error || 'пусто') };
    }
    wav = path.join(os.tmpdir(), `swarm-voice-${Date.now()}.wav`);
    fs.writeFileSync(wav, voice.wavFromFloat32(decoded.samples, voice.SAMPLE_RATE));
    const out = await new Promise((resolve, reject) => {
      execFile(bin, voice.whisperArgs({ model: TG.whisperModel, wav }),
        { timeout: TG_WHISPER_TIMEOUT_MS, maxBuffer: 4 << 20 },
        (err, stdout, stderr) => {
          // Убит по таймауту или по переполнению буфера — то, что успело напечататься,
          // это ОБРЕЗАННАЯ фраза. Отдать её как результат хуже, чем ошибка: агент начнёт
          // работать по половине задачи, и никто не заметит, по какой именно.
          if (err && (err.killed || err.signal)) {
            reject(new Error(err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'напечатал слишком много — похоже, это не тот бинарник'
              : `не уложился в ${Math.round(TG_WHISPER_TIMEOUT_MS / 1000)} с — проверь модель и путь к бинарнику`));
            return;
          }
          // Ненулевой код при живом выводе терпим: некоторые сборки whisper.cpp ругаются
          // в stderr и всё равно печатают текст.
          if (err && !stdout) { reject(new Error(String(stderr || err.message).slice(0, 200))); return; }
          resolve(stdout);
        });
    });
    const text = voice.parseOutput(out);
    return text ? { text } : { error: 'Ничего не разобрал — тишина или слишком коротко.' };
  } catch (e) {
    return { error: 'Голосовое не получилось расшифровать: ' + ((e && e.message) || e) };
  } finally {
    if (wav) { try { fs.unlinkSync(wav); } catch (_) {} }
  }
}

function tgQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr.createDataURL(6, 8);   // a GIF data URL: no canvas, no renderer work
}

// The bridge only works in a FORUM supergroup, and that's a hard requirement, not a
// preference: the swarm is many tabs at once, so «one tab = one topic» is the only shape
// where a phone can tell them apart, address them and count unread per agent. A single
// linear chat would need the user to remember who they're talking to on every message.
//
// Two of the three ways this can be misconfigured are silent, which is why we check
// instead of hoping: a non-admin bot can't create topics, and — the nasty one — Telegram's
// privacy mode means a non-admin bot in a group never even receives plain messages, only
// replies to its own. «Бот молчит» is not a diagnosis a user should have to reach alone.
// Результат — СПИСОК пунктов, а не одна фраза. Раньше проверка возвращала первую же
// найденную беду («в группе не включены темы»), и что там с правами бота, человек узнавал
// только починив темы и нажав «проверить» снова: настройка вслепую, шаг за шагом. Мастер в
// настройках показывает все пункты разом, поэтому здесь собирается всё, что удалось узнать.
//
// ok у пункта троичный: true — сделано, false — не сделано, null — проверить не удалось
// (предыдущий пункт не пройден, дальше спрашивать бесполезно). Врать галочкой там, где мы
// не знаем, нельзя: человек пойдёт чинить не то.
// soft — пункт, без которого мост всё-таки работает: он не отменяет привязку, но и молчать
// о нём нельзя, иначе «почему закрытые темы копятся» станет загадкой.
function tgChk(id, label, ok, hint, soft) { return { id, label, ok, hint: hint || '', soft: !!soft }; }

// Одна фраза для тех мест, где список не нарисовать: отказ при привязке уходит В ЧАТ, и там
// нужно ровно одно предложение — что чинить прямо сейчас.
function tgCheckNote(checks, title) {
  const bad = checks.find((c) => c.ok === false && !c.soft);
  if (bad) return bad.hint;
  const soft = checks.find((c) => c.ok === false && c.hint);
  return `«${title}»: бот администратор, темы доступны.` + (soft ? ' ' + soft.hint : '');
}

async function tgCheckChat(chatId) {
  const target = chatId != null ? chatId : TG.chatId;
  if (!TG.token || target == null) return null;
  const chat = await tgFetchJson(telegram.apiUrl(TG.token, 'getChat'), { chat_id: target });
  if (!chat.ok || !chat.body || chat.body.ok !== true) {
    const why = telegram.classifyError(chat.status, chat.body).message;
    return { ok: false, title: '', isForum: false, note: why,
      checks: [tgChk('group', 'Группа доступна боту', false, why)] };
  }
  const info = chat.body.result || {};
  const title = info.title || info.username || 'чат';
  const isForum = !!info.is_forum;
  const isGroup = info.type === 'group' || info.type === 'supergroup';
  const checks = [tgChk('group', 'Это группа, а не личный чат', isGroup,
    isGroup ? '' : 'Личный чат не подойдёт: вкладок много, и различать их нужно темами.'
      + ' Создай группу, включи в ней «Темы», добавь туда бота администратором — и привяжи её.')];
  checks.push(tgChk('topics', 'В группе включены темы', isGroup ? isForum : null,
    !isGroup || isForum ? '' : `В «${title}» не включены темы. Настройки группы → «Темы» →`
      + ' включить. Обычная группа без тем не подойдёт: каждая вкладка живёт в своей теме.'));

  const me = isGroup && isForum
    ? await tgFetchJson(telegram.apiUrl(TG.token, 'getChatMember'),
      { chat_id: target, user_id: Number(String(TG.token).split(':')[0]) })
    : null;
  const member = (me && me.ok && me.body && me.body.ok === true && me.body.result) || null;
  const status = member ? member.status : '';
  const inChat = member ? !(status === 'left' || status === 'kicked') : null;
  checks.push(tgChk('member', 'Бот добавлен в группу', me ? !!inChat : null,
    !me || inChat ? '' : `Бота нет в «${title}» — добавь его в группу.`));

  const admin = inChat ? (status === 'administrator' || status === 'creator') : (inChat === null ? null : false);
  checks.push(tgChk('admin', 'Бот — администратор', admin,
    admin !== false ? '' : `В «${title}» бот не администратор. Без этого Телеграм не покажет ему`
      + ' обычные сообщения в темах (режим приватности) и не даст создавать темы.'));

  const manage = admin ? member.can_manage_topics !== false : (admin === null ? null : false);
  checks.push(tgChk('manage', 'Право «Управление темами»', manage,
    manage !== false ? '' : `В «${title}» у бота нет права «Управление темами» — вкладки не`
      + ' получат своих тем. Включите это право в его админ-настройках.'));

  // Право на удаление — не гейт: без него мост работает, просто закрытые вкладки оставляют
  // за собой тему с замочком.
  const del = admin ? member.can_delete_messages !== false : (admin === null ? null : false);
  checks.push(tgChk('delete', 'Право «Удаление сообщений»', del,
    del !== false ? '' : 'Добавь боту право «Удаление сообщений» — иначе темы закрытых вкладок'
      + ' останутся в списке с замочком вместо того, чтобы исчезать.', true));

  const ok = !!(isGroup && isForum && inChat && admin && manage);
  return { ok, title, isForum, checks, note: tgCheckNote(checks, title) };
}

function tgState() {
  return {
    configured: !!TG.token,
    masked: telegram.maskToken(TG.token),
    bot: tgBot,
    chatId: TG.chatId,
    isForum: TG.isForum,
    live: !!(tgPoller && tgPoller.alive),
    error: tgError,
    prompt: TG.prompt || '',
    // Что подставится, если своя формулировка пуста, — оно же и подсказка в поле.
    promptDefault: tgPromptDefault(),
    detail: TG.detail || 'short',
    keepAwake: !!TG.keepAwake,
    // «Где я» — не настройка, а положение дел прямо сейчас; кнопка в строке состояния
    // рисуется по нему же, поэтому едет вместе с остальным состоянием моста.
    presence: tgPresence,
    whisperBin: TG.whisperBin,
    whisperModel: TG.whisperModel,
    voiceHint: voice.setupHint(process.platform),
    voiceReady: !!(tgWhisperBin() && TG.whisperModel),
    voice: voiceState(),
    check: tgCheck,
    pairing: tgPair ? { code: tgPair.code, until: tgPair.at + TG_PAIR_TTL_MS } : null,
  };
}

function tgPush() { safeSend('telegram:state', tgState()); }

// Не давать системе уснуть — пока человека нет за компьютером. Только «app suspension»:
// экран пусть гаснет, нам важно, чтобы процесс продолжал опрашивать телегу.
//
// Именно «за телефоном», а не круглосуточно при привязанной группе, как было раньше:
// за столом сон никому не мешает — ты рядом и сам разбудишь мак, — а держать батарею
// разряженной весь день ради моста, которым в эту минуту не пользуешься, незачем. И зеркало
// на обоих устройствах сна тоже не отменяет: смотреть в телегу, сидя за столом, — не то же
// самое, что уехать и остаться с одним телефоном.
let tgAwakeId = null;

function tgApplyKeepAwake() {
  // Ночь держит мак бодрым БЕЗ всяких условий: ни галка, ни привязанная группа тут не при
  // чём — уснувшая машина просто не работает, а в этом весь смысл ночного прогона. Телефону
  // же нужны и галка, и бот: там сон мешает мосту, а не работе.
  const want = tgPresence === night.NIGHT
    || !!(TG.keepAwake && tgPresence === 'phone' && TG.token && TG.chatId != null);
  if (want && tgAwakeId == null) {
    tgAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!want && tgAwakeId != null) {
    try { powerSaveBlocker.stop(tgAwakeId); } catch (_) {}
    tgAwakeId = null;
  }
}

function tgStop() {
  if (tgPoller) { tgPoller.stop(); tgPoller = null; }
}

// Check the token with getMe, then start polling. getMe first so a wrong token says so
// immediately in the settings panel instead of failing inside the loop.
async function tgConnect() {
  tgStop();
  tgError = null;
  if (!TG.token) { tgBot = ''; tgPush(); return; }
  let me;
  try { me = await tgFetchJson(telegram.apiUrl(TG.token, 'getMe'), {}); }
  catch (e) { tgError = 'Не дозвонились до Telegram: ' + ((e && e.message) || e); tgPush(); return; }
  if (!me.ok || !me.body || me.body.ok !== true) {
    tgError = telegram.classifyError(me.status, me.body).message;
    tgPush();
    return;
  }
  tgBot = (me.body.result && me.body.result.username) || '';
  tgPoller = telegram.createPoller({
    token: TG.token,
    fetchJson: tgFetchJson,
    onUpdate: tgOnUpdate,
    onState: (s) => {
      tgError = s && s.ok ? null : ((s && s.error && s.error.message) || null);
      if (s && s.error && s.error.fatal) tgStop();
      tgPush();
    },
  });
  tgPoller.start();
  tgApplyKeepAwake();
  tgPush();
  // Список команд для кнопки «Меню» у поля ввода: с телефона «/mode auto» набирать неудобно,
  // а в меню это выбор из списка с описанием. Ставится при каждом подключении — дешевле, чем
  // помнить, ставили ли уже, и переживает смену набора команд между версиями.
  tgFetchJson(telegram.apiUrl(TG.token, 'setMyCommands'), {
    commands: telegram.MENU_COMMANDS,
    scope: { type: 'all_group_chats' },
  }).catch(reportMainError);
  // Restored tabs after a relaunch: reopen/create their topics without waiting for one to
  // speak. Delayed a little so the renderer has finished restoring and naming them.
  setTimeout(() => tgEnsureTopics().catch(reportMainError), 4000);
}

// --- routing ------------------------------------------------------------------
// An answer landing in the WRONG session is the failure mode that matters here: «да,
// вариант 2» arriving in the middle of another agent's task. So there are exactly two
// ways to name a session, both explicit, and NO «last active tab» fallback:
//
//   • the forum topic the message sits in — one topic per tab;
//   • the message it replies to — we remember which session each outgoing message was
//     about.
//
// Anything else gets a hint back, not a guess.
const TG_SENT_CAP = 500;             // remembered outgoing messages (id → session)
const tgSent = new Map();            // messageId → session id
const tgTopicSession = new Map();    // threadId → session id (live sessions only)

function tgRemember(messageId, id) {
  if (!messageId) return;
  tgSent.set(messageId, id);
  while (tgSent.size > TG_SENT_CAP) tgSent.delete(tgSent.keys().next().value);
}

// Both maps are keyed by ids that belong to ONE chat, so they have to die with the mapping
// they describe. Telegram numbers topics and messages from small integers inside each
// group, so a fresh group hands out thread 2 and message 3 immediately — and a leftover
// `2 → вкладка 7` from the previous group routes the new group's first message into an
// unrelated tab. Whoever clears TG.topics clears these.
function tgResetRouting() {
  tgTopicSession.clear();
  tgSent.clear();
  // The per-tab memory of «this tab already has a live topic» belongs to the old chat too:
  // without this a tab would skip reopening/renaming its topic in the new group.
  for (const d of det.values()) { d.tgTopicLive = false; d.tgTopicName = ''; }
}

function tgTabName(id) {
  const d = det.get(id);
  return (d && d.name) || `вкладка ${id}`;
}

// The topic for this tab, created on first need. The mapping is keyed by the tab's
// persistent key (not the per-run session id), so after a relaunch the same tab keeps
// writing into the same topic instead of littering the group with new ones.
async function tgTopicFor(id) {
  const d = det.get(id);
  if (!d || !TG.isForum || TG.chatId == null) return null;
  const key = d.tabKey || '';
  if (!key) return null;
  const known = TG.topics[key];
  if (known) {
    tgTopicSession.set(known, id);
    // First use in this run: the topic may have been closed when the tab last went away.
    if (!d.tgTopicLive) {
      d.tgTopicLive = true;
      d.tgTopicName = d.name;
      tgTopicCall('reopenForumTopic', known).catch(reportMainError);
      tgRenameTopic(id);          // the tab may have been renamed while we were away
    }
    return known;
  }
  const res = await tgFetchJson(telegram.apiUrl(TG.token, 'createForumTopic'), {
    chat_id: TG.chatId,
    name: tgTabName(id).slice(0, 128),
  });
  if (!res.ok || !res.body || res.body.ok !== true) {
    // No rights to manage topics, or not a forum after all: fall back to the main chat
    // rather than going silent. Reply-routing still works there.
    tgError = telegram.classifyError(res.status, res.body).message;
    tgPush();
    return null;
  }
  const threadId = res.body.result && res.body.result.message_thread_id;
  if (!threadId) return null;
  TG.topics[key] = threadId;
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgTopicSession.set(threadId, id);
  d.tgTopicLive = true;
  d.tgTopicName = tgTabName(id);
  // Say what this topic is for, and leave a message worth replying to. An empty topic
  // gives you nothing to aim at; this line is the anchor for «пиши сюда».
  const where = d.cwd ? '\n' + d.cwd : '';
  // Под шапкой темы — кнопки частых действий. Смысл: с телефона не надо набирать команды,
  // а шапка всегда наверху темы, то есть это постоянная панель управления вкладкой.
  tgRemember(await tgSend({
    threadId,
    text: `Вкладка «${tgTabName(id)}».${where}\n\nПишите сюда — попадёт в этого агента.`,
    silent: true,
    replyMarkup: telegram.actionKeyboard(String(id)),
  }), id);
  tgLog(`  создана тема ${threadId} для вкладки ${id}`);
  return threadId;
}

// --- topic lifecycle: the group's topic list should BE the tab list ------------
// Created on a tab's first message, renamed when you rename the tab, closed when the tab
// closes (Telegram collapses closed topics, so what's open in the group is what's open in
// the swarm), reopened if that same tab comes back after a relaunch.
function tgForgetTopic(threadId) {
  for (const [key, thread] of Object.entries(TG.topics)) {
    if (thread === threadId) delete TG.topics[key];
  }
  tgTopicSession.delete(threadId);
  try { tgSave(); } catch (e) { reportMainError(e); }
}

async function tgTopicCall(method, threadId, extra) {
  if (!TG.token || TG.chatId == null || !threadId) return;
  const body = Object.assign({ chat_id: TG.chatId, message_thread_id: threadId }, extra || {});
  // Failures here are cosmetic (a title that stayed, a topic that stayed open) — never a
  // reason to interrupt what the app was doing.
  try { await tgFetchJson(telegram.apiUrl(TG.token, method), body); } catch (_) {}
}

function tgTopicOf(d) {
  return (d && d.tabKey && TG.topics[d.tabKey]) || null;
}

// Rename the topic after the tab. Without this «claude» stays «claude» in the group after
// you've renamed the tab to «api», and the list stops matching what you see on screen.
function tgRenameTopic(id) {
  const d = det.get(id);
  const threadId = tgTopicOf(d);
  if (!threadId || !d.name || d.name === d.tgTopicName) return;
  d.tgTopicName = d.name;
  tgTopicCall('editForumTopic', threadId, { name: d.name.slice(0, 128) }).catch(reportMainError);
}

// Everything the bridge has to let go of when a tab ends, in one place BECAUSE there are
// two ways a tab ends: the shell exits on its own (onExit), or you close the tab and we
// kill it (session:kill). The kill path used to drop the detector immediately, so onExit
// found nothing to clean up and none of this ran on the ordinary close — the topic stayed
// open in the group, the tab stayed in «answering from a phone» mode, and a pending notify
// timer went on to post permission buttons for a tab that no longer exists.
//
// Idempotent: whichever path gets here first does the work, the other finds `dead` set.
function tgOnTabGone(d) {
  if (!d || d.dead) return;
  d.dead = true;
  // Ночью закрывшаяся вкладка — отдельная новость: «закончила» и «её больше нет» утром
  // выглядят одинаково тихо, а значат разное. Поднимать её сами не берёмся: процесс упал по
  // неизвестной причине, и будить такое без присмотра — способ проснуться хуже, чем лёг.
  //
  // Но НЕ при выходе из приложения — по той же причине, по какой не сносим темы (см.
  // tgCloseTopic ниже): на закрытии окна умирают все pty разом, и здесь это выглядело ровно как
  // двадцать закрывшихся вкладок. В сводку попадала не вся двадцатка, а одна-две случайных —
  // приложение гасит процессы и до обработчиков доходит не всегда (см. will-quit), — и утром
  // человек читал «вкладка закрылась» про вкладку, которую никто не закрывал: она просто
  // переживала обновление сворма вместе с остальными.
  if (autoOn(d) && !allowClose && !quitting) {
    for (const [id, dd] of det) if (dd === d) { nightLog('died', id, d, {}); break; }
  }
  // Мандат умершей вкладки снимаем: список для хука не должен помнить её сессию, а если она
  // была последней автономной — пора собирать отчёт. Не при выходе приложения: там мандаты
  // переживают перезапуск вместе с вкладками.
  if (d.auto && !allowClose && !quitting) {
    d.auto = false;
    tgWriteModes();
    autoAfterChange(true);
    nightPush();
  }
  nightClear(d);
  tgCancelWaiting(d);
  // Отложенный итог тоже отменяем: докладывать за вкладку, которой уже нет, некому и незачем.
  if (d.tgDoneTimer) { clearTimeout(d.tgDoneTimer); d.tgDoneTimer = null; }
  tgClearMode(d);
  tgCloseTopic(d);             // the topic list mirrors the open tabs
}

// Вкладку закрыли — тему СНОСИМ, а не закрываем. Закрытая тема остаётся в списке группы с
// замочком: список тем должен быть списком открытых вкладок, а не музеем закрытых. Вместе с
// темой пропадает и её переписка — это осознанно, чат здесь зеркало живых вкладок, а не
// архив (история хода целиком есть в самой вкладке и в стенограмме Клода).
//
// ВАЖНО: не при выходе из приложения. На закрытии окна умирают все pty сразу, и снос тут
// стирал бы всю группу при каждом перезапуске, хотя вкладки вернутся и займут свои темы.
function tgCloseTopic(d) {
  const threadId = tgTopicOf(d);
  if (!threadId || TG.chatId == null) return;
  if (allowClose) return;              // приложение закрывается — темы переживут перезапуск
  tgDeleteTopic(threadId).catch(reportMainError);
}

// Снос темы. Требует права «Удаление сообщений»: без него Telegram отвечает отказом, и
// молча оставить тему висеть — значит соврать пользователю, что убрали. Поэтому откат на
// закрытие плюс внятная ошибка в настройках.
async function tgDeleteTopic(threadId) {
  const res = await tgFetchJson(telegram.apiUrl(TG.token, 'deleteForumTopic'),
    { chat_id: TG.chatId, message_thread_id: threadId });
  if (res.ok && res.body && res.body.ok === true) {
    tgLog(`  тема ${threadId} снесена`);
    tgForgetTopic(threadId);           // карта не должна помнить то, чего больше нет
    return;
  }
  const why = (res.body && res.body.description) || `HTTP ${res.status}`;
  tgLog(`  ✗ тему ${threadId} снести не смог: ${why} — закрываю`);
  tgError = 'Чтобы закрытые вкладки исчезали из группы, боту нужно право «Удаление'
    + ' сообщений» в админ-настройках. Пока темы будут просто закрываться.';
  tgPush();
  await tgSend({ threadId, text: '⚪ вкладка закрыта', silent: true });
  await tgTopicCall('closeForumTopic', threadId);
}

// --- синк в обратную сторону: телега → сворм -----------------------------------
// Имя вкладки живёт в двух местах сразу — в списке вкладок на маке и в названии темы, — но
// ехало до сих пор только в одну сторону. А с телефона переименовать тему это ЕДИНСТВЕННЫЙ
// способ навести порядок в группе, и человек, сделавший это в дороге, получал расхождение:
// в телеге «оплата», на маке всё ещё «claude 3», и /tabs называл вкладку старым именем.
//
// Петли здесь нет: наше собственное editForumTopic возвращается тем же событием, но к этому
// моменту имя вкладки уже такое же, и мы ничего не делаем.
async function tgOnService(u) {
  const kind = u.service.kind;
  const id = tgRoute(u);
  const d = id == null ? null : det.get(id);
  if (kind === 'topic-edited') {
    const name = u.service.name;
    if (!d || !name || name === d.name) return;
    tgLog(`  тему ${u.threadId} переименовали в «${name}» — переношу на вкладку ${id}`);
    d.name = name;
    d.tgTopicName = name;          // в телеге это имя уже стоит, ехать обратно нечему
    safeSend('app:renameTab', { id, name });
    return;
  }
  if (kind === 'topic-closed') {
    // Тему закрыли руками, а вкладка на маке жива — может быть, прямо сейчас работает.
    // Молча завершить агента по жесту в чате нельзя: вместе с ним пропадёт незаконченный
    // ход. Молча оставить как есть — тоже плохо: писать в закрытую тему человек больше не
    // может, и мост для этой вкладки выглядит сломанным. Поэтому спрашиваем, двумя кнопками.
    //
    // Наш собственный откат (не удалось снести тему — закрываем её, см. tgDeleteTopic)
    // приходит сюда же, но там вкладки уже нет, и вопрос не задаётся.
    if (!d || d.dead) return;
    tgLog(`  тему ${u.threadId} закрыли руками — спрашиваю, что делать со вкладкой ${id}`);
    tgRemember(await tgSend({
      threadId: u.threadId,
      text: `Тема закрыта, а вкладка «${tgTabName(id)}» на компьютере ещё работает.`
        + '\n\n↩️ вернуть тему — открою её обратно, и продолжим здесь.'
        + '\n✖️ закрыть вкладку — агент завершится, тема исчезнет из группы.',
      replyMarkup: telegram.actionKeyboard(String(id), ['reopen', 'kill']),
    }), id);
    return;
  }
  if (kind === 'topic-reopened' && d) tgLog(`  тему ${u.threadId} открыли обратно`);
}

// Every live tab gets its topic NOW, not when it happens to speak. A topic is the only
// address a phone has: without one you can't start a task from the group at all, and the
// group's topic list is supposed to BE the tab list — including the quiet tabs.
// Sequential on purpose: a burst of createForumTopic on a dozen tabs is exactly what
// Telegram's rate limiter is for.
let tgEnsuring = false;

async function tgEnsureTopics() {
  if (tgEnsuring || TG.chatId == null || !TG.isForum) return;
  tgEnsuring = true;
  try {
    for (const [id, d] of [...det]) {
      if (d.dead || !d.tabKey || !sessions.has(id)) continue;
      if (TG.topics[d.tabKey]) {
        tgTopicSession.set(TG.topics[d.tabKey], id);
        // Заодно подтягиваем название темы под имя вкладки: /sync — это «пусть в группе будет
        // то же, что на машине», и разъехавшиеся имена сюда тоже входят. Вкладки, чьё имя и
        // так совпадает, ничего не стоят — tgRenameTopic на них молчит.
        tgRenameTopic(id);
        continue;
      }
      await tgTopicFor(id);
    }
  } catch (e) { reportMainError(e); } finally { tgEnsuring = false; }
}

// The decision itself is in telegram.js (and unit-tested there); main only supplies the
// live picture: which topics belong to which tabs, what we sent, and who's still alive.
function tgRoute(u) {
  const id = telegram.routeMessage(u, {
    topicSession: tgTopicSession,
    sent: tgSent,
    topics: TG.topics,
    tabs: [...det].map(([sid, d]) => ({ id: sid, tabKey: d.tabKey })),
    alive: (sid) => sessions.has(sid) && !(det.get(sid) || {}).dead,
  });
  // Cache a re-attached topic so the next message skips the scan.
  if (id != null && u && u.threadId != null) tgTopicSession.set(u.threadId, id);
  return id;
}

// Type the answer into the live pty, exactly as if it were typed at the keyboard —
// same path as the app's own input, so there's no second way into a session.
//
// Multi-line text goes in as a bracketed paste (what a terminal sends when you paste
// from the clipboard). Without it the first newline submits, so half the message went to
// the agent and the rest was typed on top as a second one. Single-line text — the common
// case — takes the plain path, so nothing new can break there.
// Пауза между текстом и Enter. Смысл в том, чтобы Enter пришёл ОТДЕЛЬНЫМ чтением stdin, а
// не хвостом вставки — почему это важно, написано у telegram.inputWrites. Достаточно
// маленькая, чтобы человек не заметил, и достаточно большая, чтобы Ink успел разобрать
// первый кусок как ввод, а не склеить оба в один.
const TG_ENTER_DELAY_MS = 90;

function tgAnswer(id, text) {
  const p = sessions.get(id);
  if (!p) return false;
  const [body, enter] = telegram.inputWrites(text);
  if (!body) return false;
  ptyType(id, body);
  // Запоминаем ДОСЛОВНО напечатанное: по этому тексту стенограмма находит файл вкладки,
  // когда в папке несколько живых разговоров и догадки не срабатывают.
  //
  // Только если текст достаточно длинный, чтобы что-то доказывать (та же граница, что у
  // transcript.pickByInjected). Иначе номер варианта, напечатанный кнопкой разрешения, затирал
  // ключ — вкладка отвечала из телеги, а найти свой файл ей было уже нечем.
  const dd = det.get(id);
  const typed = String(text).replace(/\r\n?/g, '\n');
  if (dd && typed.trim().length >= transcript.INJECTED_MIN) dd.tgLastSent = typed.slice(0, 200);
  // Вкладка могла умереть за эти миллисекунды — тогда Enter уже некому, и ptyType это сам
  // увидит. А если текст был длинным и ещё уезжает порциями, Enter встанет за ним в очередь:
  // отдельным чтением stdin он от этого быть не перестаёт (см. telegram.inputWrites).
  setTimeout(() => ptyType(id, enter), TG_ENTER_DELAY_MS);
  const d = det.get(id);
  if (d) {
    markAnswered(d, Date.now());
    // Ответ с телефона — такой же ответ человека, как набранный за клавиатурой: прошлое он
    // прочитал (иначе бы не отвечал), а на новое ждёт ответа. Держать пометку после этого
    // значило бы запереть вкладку у того, кто как раз сидит и разговаривает с ней. См. unread.js.
    d.unread = unread.onHumanSend(d.unread);
    restartWorkAgain(id, d);
    // Ход начат из чата — значит чат вправе видеть, как он идёт. Отметка нужна кнопкам:
    // текст и голосовое заводят заготовку сразу, а нажатие кнопки разрешения — нет, и
    // дальше агент работает молча ровно тогда, когда работает дольше всего. Снимает её
    // либо появившаяся заготовка, либо конец хода.
    d.tgOwes = true;
    // From now on this tab is being driven from a phone: the agent gets told to answer
    // accordingly, and its finished turn is relayed back. Cleared the moment you touch
    // the keyboard here (see the session:input handler) — the mode tracks where YOU are.
    if (!d.tgMode) { d.tgMode = true; tgWriteModes(); }
  }
  return true;
}

// The set of Claude sessions currently driven from Telegram, written next to the hook
// script. The hook is a separate process, so a file is how it learns to refuse the
// interactive AskUserQuestion tool: a «choose 1/2/3» box can't be answered from a chat.
let tgModesWritten = '';

function tgWriteModes() {
  const ids = [];
  for (const d of det.values()) {
    if (d.tgMode && !d.dead && d.claudeSessionId) ids.push(d.claudeSessionId);
  }
  // Вместе со списком — «где я». Хук по нему запрещает агенту коробку с вариантами, пока
  // человек за телефоном: выбрать её оттуда нечем, а прозу в открытый диалог мост не печатает.
  // Список сессий этого не покрывает — вкладка попадает в него, только когда в неё УЖЕ
  // ответили с телефона, а вопрос с вариантами агент открывает и в той, куда не отвечали.
  // См. deniesPicker в hooks/swarm-signal.mjs.
  // Своя формулировка ночного правила уезжает хуку вместе с положением: отказ в рамке он
  // печатает сам, и без этого поля агент получал бы наш текст, а не тот, что написал человек.
  // Вкладки со своим мандатом «работай без меня». Общий ночной режим сюда не входит: его хук
  // видит по presence, а список отвечает на другой вопрос — «этой вкладке разрешили, даже
  // когда человек за столом».
  const auto = [];
  for (const d of det.values()) if (d.auto && !d.dead && d.claudeSessionId) auto.push(d.claudeSessionId);
  // Включён ли перезапуск. По этому полю хук кладёт свежей сессии строку «можешь позвать
  // перезапуск сам» — с именем файла, которое считает сам из id разговора (restart.answerName).
  // Выключенная функция приезжает выключенной: обещать агенту дверь, которую сворм не откроет,
  // хуже, чем молчать.
  const body = JSON.stringify({
    sessions: ids.sort(), auto: auto.sort(), presence: tgPresence, nightRule: TG.nightRule || '',
    restart: { on: RESTART_ENABLED },
  });
  if (body === tgModesWritten) return;         // nothing changed — don't touch the disk
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'swarm-tgmode.json'), body);
    tgModesWritten = body;
  } catch (e) { reportMainError(e); }
}

function tgClearMode(d) {
  if (!d || !d.tgMode) return;
  d.tgMode = false;
  d.tgPrimed = false;
  tgWriteModes();
}

// --- режим компа: сообщение в вкладку не уходит ---------------------------------
// Писать агенту можно только с телефона (почему — см. tgPresence). В режиме компа сообщение
// не доезжает до вкладки, а разворачивается с кнопкой «включить режим телефона».
//
// Разворачивается КАЖДОЕ, а не первое: «спросили один раз и дальше пропускаем» — это ровно тот
// неочевидный полурежим, от которого мы уходим. Правило, которое человек может держать в
// голове, звучит так: в режиме компа мост в вкладки не пишет. Без исключений и памяти о том,
// что кто-то когда-то нажал.
//
// Но текст ЖДЁТ, а не пропадает: заставлять набирать на телефоне второй раз то, что уже
// написано (а голосовое — говорить заново), — та же ловушка, только на шаг длиннее. Держим
// ограниченное время: сообщение, доставленное в разговор через час после того, как его
// написали, приходит уже не в тот разговор.
const TG_HELD_TTL_MS = 30 * 60_000;
// Подтверждение режима должно прийти РАНЬШЕ отложенного текста: иначе в ленте сначала
// «получил, думаю…», а потом «понял, ты с телефоном» — то есть ответ раньше вопроса.
const TG_FLUSH_DELAY_MS = 400;

// Кнопки, нажатие которых ПЕЧАТАЕТ в живую сессию: Escape закрывает диалог, а смена режима
// разрешений — это Shift+Tab. В режиме компа они молчат (см. tgOnAction).
const TG_WRITING_ACTIONS = ['esc', 'auto', 'edits', 'manual', 'clear'];

function tgHeldFresh(d, now) {
  return !!(d && d.tgHeld && d.tgHeld.text && now - (d.tgHeld.at || 0) < TG_HELD_TTL_MS);
}

// Задержать готовую строку и объяснить, почему. true = в вкладку НЕ отправляли.
async function tgDeskHold(id, d, u, tagged) {
  if (tgMirrors()) return false;
  const name = tgTabName(id);
  // Держим ОДНО сообщение на вкладку, и про смену держателя говорим вслух. Слить два в одно
  // нельзя (в каждом своя строка-просьба агенту), а молча выбросить первое — потерять текст,
  // который человек считает отправленным.
  const had = tgHeldFresh(d, Date.now());
  if (d) d.tgHeld = { text: tagged, at: Date.now(), threadId: u.threadId, messageId: u.messageId };
  tgLog(`  режим компа: в вкладку ${id} не пишу`
    + (d ? `, держу ${had ? 'это вместо прежнего' : 'текст'} ${Math.round(TG_HELD_TTL_MS / 60000)} мин`
      : ' и держать нечем — вкладки нет'));
  const mins = Math.round(TG_HELD_TTL_MS / 60000);
  const held = d
    ? `${had ? 'Держу последнее (прежнее забыл)' : 'Сообщение держу'} ${mins} мин: включишь`
      + ` режим телефона — отправлю «${name}» сразу. Не включишь — забуду, напишешь заново.`
    : `Отправить «${name}» мне уже нечем — вкладки нет. Включите режим телефона и напишите снова.`;
  await tgSend({
    threadId: u.threadId, replyTo: u.messageId,
    text: '🖥 Сворм в режиме компа — в вкладки я сейчас не пишу.\n\n'
      + `${held} Тогда же компьютер перестанет засыпать, а остальные вкладки начнут писать сюда`
      + ' о вопросах и разрешениях.',
    replyMarkup: telegram.actionKeyboard(String(id), ['phone']),
  });
  return true;
}

// Режим телефона включили — отпустить всё задержанное. Каждой вкладке своё и в её тему.
async function tgFlushHeld() {
  const now = Date.now();
  for (const [id, d] of det) {
    if (!tgHeldFresh(d, now)) { if (d) d.tgHeld = null; continue; }
    const held = d.tgHeld;
    d.tgHeld = null;
    if (d.dead || !sessions.has(id)) {
      tgLog(`  задержанный текст некому отдать: вкладка ${id} закрыта`);
      continue;
    }
    const u = { threadId: held.threadId, messageId: held.messageId };
    await tgAckSend(id, d, u);
    if (!tgAnswer(id, held.text)) continue;
    d.tgPrimed = true;
    tgLog(`  задержанный текст ушёл в вкладку ${id}`);
  }
}

// --- outbound: an agent is calling ---------------------------------------------
// Debounced: the status flips to «ждёт» a beat before the transcript reader has the
// question text, and a repaint can flicker the status for one tick. Waiting ~1s means
// one message with the real question instead of two with half of it.
const TG_NOTIFY_DELAY_MS = 1200;

// Вкладка только что открылась — молчим, даже если она «ждёт».
//
// Восстановленная вкладка возобновляет разговор (`--resume`), и Клод перерисовывает ПРОШЛУЮ
// переписку. На экране снова стоит вопрос, который человек видел до перезапуска, — а
// стенограммы, из которой берётся текст, в эти секунды ещё нет: привязка занимает секунды.
// Получалось худшее сочетание: уведомление о старом вопросе, да ещё с огрызком экрана
// вместо текста («main», строка усилия, имя сессии).
//
// Отказ здесь не теряется: пока вкладка ждёт, такт зовёт tgOnWaiting снова (см. цикл
// статуса), так что настоящий вопрос уедет, когда у него появится настоящий текст.
const TG_TAB_WARMUP_MS = 12_000;
// Сколько символов должно быть в тексте С ЭКРАНА, чтобы отправить его как вопрос.
const TG_MIN_SCREEN_TEXT = 12;
// Сколько мост молчит после напечатанного `/exit`. Уход занимает секунды: агент прощается сам,
// а на маке и линуксе его ещё и закрывают сигналом. Минуты хватает с запасом на медленное
// закрытие (агент гасит свои подпроцессы), а всё, что дольше, — это уже не уход, а вкладка,
// которая никуда не делась, и молчать про неё нельзя.
const TG_EXIT_MUTE_MS = 60_000;

function tgOnWaiting(id) {
  const d = det.get(id);
  if (!d || TG.chatId == null || !TG.token) return;
  if (Date.now() - (d.startedAt || 0) < TG_TAB_WARMUP_MS) return;
  // «За компом» мост молчит: вопрос и запрос разрешения человек видит на экране, перед
  // которым сидит. Исключение одно — долг: в чате висит «получил, думаю…», и вопрос агента
  // здесь не уведомление, а ответ на заданный оттуда вопрос (см. tgNotifyWaiting → tgAck).
  if (!tgMirrors() && !d.tgAck) return;
  // Уже запланировано ИЛИ уже отправлено — второй раз то же самое не присылаем. Оба условия
  // нужны, потому что дублей было два источника:
  //   • пока сообщение летит (с повторами это секунды), tgTimer уже сброшен, и такт заводил
  //     вторую отправку;
  //   • ожидание перерисовывается — меняется текст вопроса, — и ветка «статус изменился»
  //     звала уведомление снова, хотя вкладка ждёт того же самого.
  // Отметка снимается в tgCancelWaiting, то есть когда вкладка перестала ждать: следующее
  // ожидание — новый повод написать.
  if (d.tgTimer || d.tgNotifiedAt) return;
  // Вкладку гасит перезапуск: `/exit` напечатан, и вопрос, на котором кончился ход, доживает
  // секунды. Объявить его — значит позвать человека отвечать туда, где отвечать уже некому (см.
  // tgOnRestartExit). И проверка нужна именно ЗДЕСЬ, а не только там: снятое уведомление
  // возвращает такт — он видит «ждёт» без отметки об отправке и заводит его заново, а «ждёт»
  // держится, пока агент не ушёл.
  //
  // Но молчим ровно столько, сколько уход занимает, а не всю фазу: та ждёт агента ЧАС. Уход
  // может и не состояться — `/exit` уезжает в строку с чужой заготовкой и не срабатывает,
  // систему не спросить, закрытие не удалось, — и тогда вкладка остаётся живой и разговорчивой,
  // а мост глотал бы этот час всё подряд: и новые вопросы, и запросы разрешения. Это хуже того,
  // от чего мы защищаемся: там один вопрос уходил не туда, здесь их не уходит вовсе.
  if (d.rs && d.rs.phase === 'exiting' && Date.now() - (d.rs.exitAt || 0) < TG_EXIT_MUTE_MS) return;
  d.tgTimer = setTimeout(() => {
    d.tgTimer = null;
    if (d.dead || d.status !== 'waiting') return;   // resolved at the keyboard already
    // Помечаем ДО отправки, иначе такт (каждые 400 мс) успеет начать вторую.
    d.tgNotifiedAt = Date.now();
    tgNotifyWaiting(id, d).catch((e) => { tgNotifyFailed(d); reportMainError(e); });
  }, TG_NOTIFY_DELAY_MS);
}

function tgCancelWaiting(d) {
  if (!d) return;
  if (d.tgTimer) { clearTimeout(d.tgTimer); d.tgTimer = null; }
  // Диалога больше нет — отложенному тексту некуда идти. Держать его до следующего ожидания
  // значило бы напечатать вчерашний ответ в завтрашний вопрос.
  d.tgPending = '';
  // Вкладка больше не ждёт: следующее ожидание — новый повод уведомить, и повод свежий, так
  // что счётчик отказов начинается заново.
  d.tgNotifiedAt = 0;
  d.tgFails = 0;
  d.tgRetryAt = 0;
}

// Вкладку сейчас погасят — перезапуск напечатал `/exit`. Вопрос, которым кончился её ход, умрёт
// вместе с сессией, и мост об этом знать обязан: он и перезапуск смотрят на один и тот же миг
// «вкладка кончила ход» и оба на него срабатывают.
//
// Дальше — гонка, которую мост выигрывал: уведомление уходит с задержкой в секунду с небольшим, а
// `/exit` печатается в тот же тик. Человек получал на телефон вопрос от сессии, которой в этот
// момент уже не было, отвечал на него — и ответ печатался в СВЕЖУЮ, никакого вопроса не задававшую:
// либо в ночную задачу из промпта, либо в пустоту загрузки.
//
// Поэтому заготовленное уведомление снимаем: вопрос не потерян — в просьбе агенту прямо сказано
// перенести незаданный вопрос в записку и задать его заново, поднявшись. А если оно уже улетело
// (`/exit` дождался сабагентов, и к этому мигу вопрос висел в чате давно), то молчать нельзя:
// человек держит его в руках и вот-вот ответит. Пишем прямо, что отвечать сюда больше некому.
//
// Уход может и не состояться: агент не вышел, и через час автомат отменяет запуск. Поправка тогда
// приходит сама — фаза возвращается в исходную, запрет снимается, и такт объявляет тот же вопрос
// заново. Врать этот час неприятно, но выбор был между ним и молчанием в единственный миг, когда
// предупреждение ещё имеет смысл.
function tgOnRestartExit(id, d) {
  if (!d) return;
  const notified = !!d.tgNotifiedAt;
  // Придержанный текст с телефона — та же потеря, только с другой стороны. Он писался ПРОШЛОЙ
  // сессии и лежит до получаса, дожидаясь режима телефона; отдать его после перезапуска значит
  // вклиниться чужой репликой в свежий разговор, который её не ждал и ответить на неё не сможет.
  // Так же поступает и ответ за компьютером (см. tgClearMode на Enter) — по той же причине.
  // Именно СВЕЖИЙ: протухший не доехал бы и без перезапуска (tgFlushHeld его выбрасывает), а
  // человеку про него уже сказано — «держу текст 30 мин». Обещать второй раз то же самое значит
  // прислать уведомление на пустом месте.
  const held = tgHeldFresh(d, Date.now());
  if (d.tgHeld) d.tgHeld = null;
  // Снимает и заготовку уведомления, и отложенный текст: тому тоже некуда идти — напечатать
  // вчерашний ответ в завтрашний вопрос ничем не лучше.
  tgCancelWaiting(d);
  if ((!notified && !held) || TG.chatId == null || !TG.token) return;
  const lines = [`♻️ ${tgTabName(id)} перезапускается.`];
  if (notified) lines.push('Заданный вопрос уехал вместе с сессией: отвечать на него уже некому —'
    + ' вкладка поднимется и спросит заново.');
  if (held) lines.push('Придержанный для неё текст я не передам — он писался прошлой сессии.'
    + ' Напишите заново, когда она поднимется.');
  tgLog(`  вкладка ${id}: перезапуск — предупреждаю в чат${notified ? ' про объявленный вопрос' : ''}`
    + `${held ? ' и придержанный текст' : ''}`);
  tgSend({ threadId: tgTopicOf(d), text: lines.join('\n'), silent: true }).catch(reportMainError);
}

// Отправка уведомления не удалась. Отметку «уже написали» снимаем (такт попробует снова), но
// НЕ сразу: пока здесь не было откола, недоступный Telegram означал поток из трёх запросов
// раз в полторы секунды всё время, пока вкладка ждёт, — и три строки в журнал на каждую
// попытку, то есть журнал моста перелистывался и стирал ровно ту историю, ради которой он
// включён всегда. Шаг тот же, что у опроса (telegram.backoffMs): до минуты и не больше.
function tgNotifyFailed(d) {
  if (!d) return;
  d.tgNotifiedAt = 0;
  d.tgFails = (d.tgFails || 0) + 1;
  const wait = telegram.backoffMs(d.tgFails);
  d.tgRetryAt = Date.now() + wait;
  tgLog(`  ✗ уведомление не ушло (попытка ${d.tgFails}) — следующая через ${Math.round(wait / 1000)} с`);
}

// The agent finished a turn it was given from the phone: send back what it said. Only
// for tabs in Telegram mode — otherwise every turn you run at your own desk would land
// in the chat and the bridge would become a log nobody reads.
// --- одно сообщение на ход: «думаю» → ответ -----------------------------------
// Раньше в тему уезжала стрелочка с именем вкладки, а потом отдельным сообщением итог. По
// стрелочке нельзя было понять, работает агент или всё заглохло, а лента распухала вдвое.
// Теперь подтверждение — это ЗАГОТОВКА ответа: то же сообщение переписывается на итог,
// когда ход закончится. Голосовое присылает расшифровку ОТДЕЛЬНЫМ сообщением до неё —
// его никто не переписывает, поэтому «услышал: RoseVPN» остаётся на месте, что бы ни
// случилось с ответом.
const TG_THINKING = '⏳ получил, думаю…';

async function tgAckSend(id, d, u) {
  // Прислали два сообщения подряд, не дожидаясь ответа: заготовка одна на ход, поэтому старую
  // надо ЗАКРЫТЬ. Иначе она остаётся в ленте с вечным «думаю…» — и человек ждёт ответа на
  // первое сообщение, которого уже никогда не будет.
  if (d && d.tgAck) {
    const old = d.tgAck;
    d.tgAck = null;
    await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'),
      { chat_id: old.chatId, message_id: old.messageId, text: '⏳ принято — отвечу ниже' })
      .catch(reportMainError);
  }
  const msgId = await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: TG_THINKING, silent: true });
  tgRemember(msgId, id);          // ответом на него тоже можно продолжать разговор
  if (d && msgId) {
    d.tgAck = { messageId: msgId, chatId: TG.chatId };
    d.tgAckText = ''; d.tgAckAt = 0; d.tgAckWhy = ''; d.tgOwes = false;
  }
}

// --- заготовка, которая показывает признаки жизни ------------------------------
// Пока идёт ход, «⏳ получил, думаю…» переписывается живыми числами: сколько уже думает,
// каким инструментом занят, сколько написал, насколько полон контекст (см.
// telegram.thinkingLine). С телефона это единственный способ отличить работающего агента от
// уснувшего мака — до вкладки не дотянуться.
//
// Заготовка есть не у каждого хода из чата. Написал текстом — она появляется сразу; нажал
// кнопку разрешения — нет, а прежняя к этому моменту уже стала указателем на кнопки. Такие
// ходы и тянутся дольше всех, поэтому для них заготовка заводится ЛЕНИВО: первой же живой
// строкой, если ход не кончился за пятнадцать секунд.
//
// Цена — один запрос на правку в полминуты на КАЖДУЮ висящую заготовку, а висят они только
// у вкладок, которым человек сам написал с телефона. Все числа уже прочитаны для других
// нужд (стенограмма разбирается тактом, снимок статуслайна лежит файлом), так что считать
// заново нечего. Telegram отвергает правку, не меняющую текст, — поэтому одинаковую строку
// второй раз не отправляем.
const TG_PROGRESS_MS = 30_000;
// Смотреть, не пора ли, надо ЧАЩЕ, чем править. Пока такт был один на оба дела, момент
// правки зависел от того, когда запустили приложение: ход, начавшийся сразу после такта,
// получал первую живую строку через минуту, а ход короче минуты — никогда. Часики, которые
// не сменились ни разу, — это ровно та жалоба, с которой всё началось.
const TG_PROGRESS_STEP_MS = 5_000;
// Первые числа — через пятнадцать секунд, а не через полминуты. Полминуты выбирались из
// «часиков и так достаточно», но с телефона именно первые полминуты и есть вся тревога:
// дошло ли, взялся ли. Пятнадцать секунд — та граница, за которой ход уже не мгновенный.
const TG_PROGRESS_FIRST_MS = 15_000;

function tgClock(now) {
  return new Date(now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Снимок расхода, если он не протух. Статуслайн перерисовывается на каждом ходе, но во
// время долгого инструмента может молчать минутами: показать пятиминутной давности процент
// как текущий — соврать ровно там, где человек ищет признак жизни.
const TG_USAGE_FRESH_MS = 300_000;

function tgCtxOf(d, now) {
  const u = readUsage(d.claudeSessionId);
  if (!u || !u.ctx || now - (u.at || 0) * 1000 > TG_USAGE_FRESH_MS) return null;
  return { pct: u.ctx.used, total: statusline.fmtTok(u.ctx.total) };
}

// Почему заготовка стоит без живой строки. Пустая строка — «всё в порядке, можно править».
//
// Отдельной функцией, потому что это ответ на главный вопрос разбора: часики не меняются —
// приложение не считает вкладку работающей, или считает, а правка не доходит? Раньше у
// этого такта не было НИ ОДНОЙ записи в журнале, и обе причины выглядели одинаково.
function tgProgressWhy(d) {
  if (d.dead) return 'вкладка закрыта';
  if (d.status !== 'running') return `вкладка не работает (${d.status || '—'})`;
  if (!d.turnStartedAt) return 'начало хода неизвестно';
  return '';
}

async function tgProgressTick() {
  if (TG.chatId == null || !TG.token) return;
  const now = Date.now();
  for (const [id, d] of det) {
    if (!d.tgAck && !d.tgOwes) continue;         // ход не из чата — и показывать нечего
    // В журнал пишем ПЕРЕМЕНУ причины, а не каждый такт: иначе одна забытая заготовка
    // засыпала бы журнал одной и той же строкой раз в пять секунд и стёрла бы собой всю
    // остальную диагностику моста. И только про висящую заготовку: человек смотрит на
    // неподвижные часики именно там, а «пока нечего показывать» — не событие.
    const why = tgProgressWhy(d);
    if (why) {
      if (d.tgAck && why !== d.tgAckWhy) { d.tgAckWhy = why; tgLog(`  ⏳ вкладка ${id}: живой строки нет — ${why}`); }
      continue;
    }
    d.tgAckWhy = '';
    const elapsed = now - d.turnStartedAt;
    if (elapsed < TG_PROGRESS_FIRST_MS) continue;            // мгновенный ход обойдётся часиками
    if (d.tgAck && now - (d.tgAckAt || 0) < TG_PROGRESS_MS) continue;   // правим не чаще раза в полминуты
    const text = telegram.thinkingLine({
      elapsedMs: elapsed,
      tool: transcript.currentTool(d.trEntries),
      tokens: transcript.turnTokens(d.trEntries),
      ctx: tgCtxOf(d, now),
      clock: tgClock(now),
    });
    if (text === d.tgAckText) continue;
    // Заготовки нет, а долг перед чатом есть: ход начали кнопкой оттуда (разрешение, «закрыть
    // диалог»), и заготовку с «получил, думаю…» никто не заводил — при первом же запросе
    // разрешения прежняя превратилась в указатель на кнопки. Именно эти ходы и тянутся
    // минутами, и именно в них в чате не было ничего живого. Заводим её ЛЕНИВО, первой живой
    // строкой: цепочка разрешений (жмёшь — секунда работы — снова спрашивает) до пятнадцати
    // секунд не доживает и лишних сообщений не плодит, а долгая работа получает и счётчик, и
    // итог в том же сообщении.
    if (!d.tgAck) {
      d.tgAckAt = now;                           // попытка была: не долбимся каждые пять секунд
      const msgId = await tgSend({ threadId: await tgTopicFor(id), text, silent: true });
      if (!msgId) continue;                      // не ушло — журнал уже написал почему
      tgRemember(msgId, id);                     // ответом на неё тоже можно продолжать разговор
      d.tgAck = { messageId: msgId, chatId: TG.chatId };
      d.tgAckText = text;
      d.tgOwes = false;                          // долг теперь несёт сама заготовка
      continue;
    }
    const ack = d.tgAck;
    d.tgAckAt = now;                             // попытка была — считаем её за такт правки
    const res = await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'),
      { chat_id: ack.chatId, message_id: ack.messageId, text });
    if (res.ok && res.body && res.body.ok === true) {
      d.tgAckText = text;
      tgLog(`  ⏳ ${ack.messageId}: ${text}`);
      continue;
    }
    // Не вписалась. Текст заготовки НЕ запоминаем — следующая попытка должна считать себя
    // первой, иначе одна осечка выключала живую строку до конца хода молча.
    tgLog(`  ✗ живая строка не вписалась в ${ack.messageId}: `
      + `${res.netError || (res.body && res.body.description) || 'HTTP ' + res.status}`);
  }
}

setInterval(() => { tgProgressTick().catch(reportMainError); }, TG_PROGRESS_STEP_MS);

// Переписать сообщение текстом агента — с разметкой и с тем же откатом, что у отправки: не
// приняли разметку, значит идёт тот же текст как есть (см. tgSend). Правка — отдельный метод
// API, поэтому и страховка нужна своя: без неё ответ, вписываемый в заготовку, терялся бы
// целиком из-за одного кривого тэга.
async function tgEditRich(chatId, messageId, text) {
  const url = telegram.apiUrl(TG.token, 'editMessageText');
  const plain = String(text);
  const body = { chat_id: chatId, message_id: messageId, text: md.toHtml(plain), parse_mode: 'HTML' };
  let res = await tgFetchJson(url, body);
  if (!res.ok && telegram.entityError(res.body)) {
    tgLog(`  ⚠ разметку в правке ${messageId} телега не приняла — вписываю без неё`);
    res = await tgFetchJson(url, { chat_id: chatId, message_id: messageId, text: plain });
  }
  return res;
}

// Переписать заготовку. Не вышло (сообщение удалили, прошли сутки, чат сменился) — отправим
// обычным сообщением: тишина вместо ответа хуже лишней записи в ленте.
async function tgAckResolve(id, d, text) {
  const ack = d && d.tgAck;
  const body = String(text);
  if (!ack || ack.chatId !== TG.chatId) {
    const msgId = await tgSend({ threadId: await tgTopicFor(id), text: body, rich: true });
    tgRemember(msgId, id);
    return;
  }
  d.tgAck = null;
  // Слишком длинный ответ в правку не влезет: Telegram режет сообщение на 4096, а правку
  // просто отвергает целиком. Тогда заготовка становится указателем, а сам ответ уходит
  // обычным сообщением — там он разобьётся на части штатно.
  if (body.length > telegram.MAX_TEXT - 64) {
    await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'),
      { chat_id: ack.chatId, message_id: ack.messageId, text: '✅ ответил — ниже' });
    const longId = await tgSend({ threadId: await tgTopicFor(id), text: body, rich: true });
    tgRemember(longId, id);
    return;
  }
  const res = await tgEditRich(ack.chatId, ack.messageId, body);
  if (res.ok && res.body && res.body.ok === true) {
    tgLog(`  → ответ вписан в сообщение ${ack.messageId}`);
    return;
  }
  tgLog(`  ✗ не смог переписать ${ack.messageId}: ${(res.body && res.body.description) || res.status}`);
  const msgId = await tgSend({ threadId: await tgTopicFor(id), text: body, rich: true });
  tgRemember(msgId, id);
}

// Итог хода отправляется НЕ в тот же миг, когда статус стал «готов».
//
// С включёнными хуками Stop прилетает раньше, чем стенограмма догоняет: у classify свой
// отстой (transcript.READY_DEBOUNCE_MS), и до его истечения d.trReply — это текст ПРОШЛОГО
// хода. Отправить его — худшее, что тут можно сделать: в чат уходит правдоподобный ответ не
// на ту задачу, и заметить подмену нельзя ничем. Поэтому ждём, пока текст хода станет свежим
// (его запись позже начала хода), и только потом докладываем. Не дождались — честно берём
// экран, а не выдаём чужой текст за этот ход.
const TG_DONE_STEP_MS = 300;      // как часто переспрашивать стенограмму
const TG_DONE_WAIT_MS = 3000;     // сколько всего ждать; дальше отчёт по экрану

function tgOnDone(id, d) {
  if (d.tgDoneTimer) return;      // этот ход уже ждёт своей очереди
  const endedAt = Date.now();
  const step = () => {
    d.tgDoneTimer = null;
    if (d.dead) return;
    // Вкладка успела снова заработать: этот ход уже не итог, а следующий доложит о себе сам.
    // «Работает в фоне» — не тот случай: там ход как раз кончился, агент лишь сказал, что
    // ждёт фоновую задачу и вернётся сам (d.bg).
    if (d.status !== 'ready' && !d.bg) return;
    const fresh = transcript.belongsToTurn(d.trReplyAt, d.turnStartedAt);
    if (!fresh && Date.now() - endedAt < TG_DONE_WAIT_MS) {
      d.tgDoneTimer = setTimeout(step, TG_DONE_STEP_MS);
      return;
    }
    tgNotifyDone(id, d, fresh).catch(reportMainError);
  };
  d.tgDoneTimer = setTimeout(step, TG_DONE_STEP_MS);
}

async function tgNotifyDone(id, d, fresh) {
  // Текст итога — дословный из стенограммы, а если её нет, последнее сообщение с ЭКРАНА.
  // Пустой отчёт «✅ вкладка — готов.» бесполезен: человек в дороге узнаёт, что ход
  // закончился, но не узнаёт чем. Экран беднее (шире окна эмулятора он не видит и переносы
  // в нём терминальные), зато он есть всегда.
  // `fresh` — принадлежит ли текст стенограммы ЭТОМУ ходу (см. tgOnDone). Не принадлежит —
  // значит его нет, и никакой «почти подходящий» текст его не заменяет.
  const fromTr = fresh ? String(d.trReply || '').trim() : '';
  // Экранный запас — только если это похоже на ответ, а не на огрызок мебели: в чат уезжало
  // «✅ fastio 2 · main» и «✅ fastio 3 · swarm-1a437470». Честное «готов» без текста
  // человеку понятнее, чем слово, которое он должен как-то истолковать. См. TG_MIN_SCREEN_TEXT.
  // lastAgentBlock, а НЕ extractQuestion: вторая берёт нижнюю значимую строку, а внизу стоит
  // поле ввода — из-за этого в чат уезжала то линейка рамки, то собственный вопрос
  // пользователя, отражённый ему же как «ответ агента». И не lastAgentLine: одна строка —
  // это огрызок ответа, а человеку нужен ответ.
  const scraped = String(lastAgentBlock(replySnapshot(d)) || '').trim();
  const text = fromTr || (scraped.length >= TG_MIN_SCREEN_TEXT ? scraped : '');
  // Источник называем ЧЕСТНО, включая «текст стенограммы не от этого хода»: пометка
  // «стенограмма» на чужом тексте однажды уже отправила искать не ту проблему.
  const why = fromTr ? 'стенограмма'
    : !d.trFile ? (text ? 'экран, стенограмма не привязана' : 'ни стенограммы, ни экрана')
      : text ? 'экран, стенограмма не догнала этот ход' : 'стенограмма не догнала, экран пуст';
  // Тот же итог второй раз — это не итог, а шум, и человек в чате отличить его от нового
  // ответа не может. Живой случай: вкладка, в которой ничего не происходит, раз в полчаса
  // присылала один и тот же ответ — Claude Code перерисовывает экран (и дёргает хуки) на
  // своих таймерах, приложение видит короткое «работает → готов», и мост честно докладывает
  // ход, которого не было. Никакая проверка свежести это не лечит: текст-то настоящий, он
  // просто уже отправлен. Поэтому ключ отчёта — запись стенограммы (её время), а без
  // стенограммы сам текст; совпал с прошлым — молчим.
  //
  // Долг (в чате висит «получил, думаю…») сильнее: там человек ЖДЁТ ответа именно на своё
  // сообщение, и оставить его с часиками навсегда — хуже, чем повторить текст.
  const key = fresh ? `tr:${d.trReplyAt}` : `screen:${text}`;
  if (!d.tgAck && key === d.tgSentKey) {
    tgLog(`  → итог вкладки ${id} не изменился (${why}) — не повторяю`);
    return;
  }
  d.tgSentKey = key;
  tgLog(`  → итог вкладки ${id}: ${text ? text.length + ' симв.' : 'текста нет'} (${why};`
    + ` ход с ${tgStamp(d.turnStartedAt)}, текст ${tgStamp(d.trReplyAt)})`);
  // Если ход начался сообщением из телеги, ответ вписывается в ЕГО же сообщение («получил,
  // думаю…» → ответ). Иначе (зеркало итогов, когда человека нет за маком) — обычная запись.
  // Часики вместо галочки, когда агент ушёл ждать фоновую задачу: доклад тот же самый, но
  // человеку с телефона важно знать, что это ещё не конец и отвечать не нужно — агент
  // вернётся сам, когда фон досчитает.
  const bg = !!d.bg;
  const head = `${bg ? '⏳' : '✅'} ${tgTabName(id)}${bg ? ' — жду фоновую задачу' : ''}`;
  await tgAckResolve(id, d, `${head}${text ? '\n\n' + text : bg ? '.' : ' — готов.'}`);
}

async function tgNotifyWaiting(id, d) {
  const permission = d.waitingKind === 'permission';
  const threadId = await tgTopicFor(id);
  tgLog(`  → ${permission ? 'запрос разрешения' : 'вопрос'} вкладки ${id} в тему ${threadId == null ? 'общую' : threadId}`);
  // A permission is answered with BUTTONS carrying Claude's own options — never with free
  // text. You approve what you see: the request (with the command in it) is in the message,
  // and nothing that wasn't on Claude's list can be chosen. Typing «да» here still gets
  // refused, because a word is not a choice from a list.
  const prompt = permission ? parsePrompt(promptSnapshot(d)) : null;
  if (prompt && prompt.options.length) {
    const kb = telegram.inlineKeyboard(prompt.options, String(id), prompt.fingerprint);
    if (kb) {
      // Кнопки — отдельным сообщением: отпечаток строится при отправке, и клавиатура должна
      // висеть на свежей записи. А заготовка «думаю…» превращается в указатель, иначе она
      // осталась бы врать, что агент ещё думает.
      if (d.tgAck) await tgAckResolve(id, d, `🔐 ${tgTabName(id)} просит разрешение — кнопки ниже`);
      // Части запроса — каждая своей строкой: «Bash command · rm -rf build · Do you want to
      // proceed?» одной строкой на телефоне читается как мешанина, а решение по нему
      // принимают за секунды и не разглядывая.
      // Варианты — и списком в тексте, и метками на кнопках. Дублирование намеренное:
      // подпись кнопки Telegram рисует одной строкой и обрезает по ширине экрана, так
      // что длинный вариант («Yes, and don't ask again for rm commands in …») на кнопке
      // не читается совсем. Читают его здесь, а кнопкой только выбирают номер.
      const msgId = await tgSend({
        threadId,
        text: `🔐 ${tgTabName(id)} просит разрешение\n\n${prompt.title.split(' · ').join('\n')}`
          + `\n\n${telegram.optionsList(prompt.options)}`,
        replyMarkup: kb,
        // Текст запроса — это экран Клода: там и пути с подчёркиваниями, и команды с `<`.
        // Разметку он несёт редко, а вот экранирование ему нужно всегда, и rich его даёт.
        rich: true,
      });
      tgRemember(msgId, id);
      // Не приняли (сеть) — снимаем отметку с отколом, и такт попробует снова. Ставится она
      // ДО отправки, в tgOnWaiting: иначе между попыткой и успехом влезает второе уведомление.
      if (!msgId) tgNotifyFailed(d); else { d.tgFails = 0; d.tgRetryAt = 0; }
      return;
    }
  }
  const head = permission ? '🔐 просит разрешение' : '❓ вопрос';
  // Целиком, а не огрызок с «Сейчас от тебя»: человек в дороге читает ход один раз, и
  // выводы агента ему нужны не меньше самого вопроса. Без стенограммы — сообщение с экрана
  // целиком; d.question (одна строка для плашки вкладки) остаётся последним запасом, из-за
  // него в чат уезжало «Jump to bottom (click) ↓» вместо вопроса.
  //
  // И то, что взято с экрана, обязано быть ДЛИННЕЕ огрызка. Строку мебели мы отсеиваем
  // (см. screen.isProse), но мебель Клод обновляет чаще, чем мы успеваем узнавать её виды, а
  // цена ошибки тут прямая: в чат уезжало «main» и «swarm-f81789c0» как вопрос агента.
  // Осмысленный вопрос короче десятка символов не бывает, а из стенограммы верим любому.
  const fromTr = String(d.trFinal || '').trim();
  const scraped = String(lastAgentBlock(replySnapshot(d)) || '').trim() || String(d.question || '').trim();
  const said = fromTr || (scraped.length >= TG_MIN_SCREEN_TEXT ? scraped : '');
  const body = said ? '\n\n' + said : '';
  // Разрешение, вариантов которого мы не разобрали, — это была отправка человека к
  // компьютеру, а с телефона он ничего сделать не мог: кнопок нет, а прозу в открытый диалог
  // мост не печатает. Теперь выход есть всегда — Escape (см. QA_ACTIONS.esc), и подпись
  // говорит именно про него, а не «ответь за компьютером».
  const kb = permission ? telegram.actionKeyboard(String(id), ['esc']) : null;
  const tail = permission
    ? '\n\nВариантов не разобрал — кнопок с ними не будет. Нажмите «закрыть диалог»,'
      + ' и можно отвечать словами; или ответь за компьютером.'
    : said
      ? '\n\nОтветь реплаем на это сообщение.'
      : '\n\nТекста вопроса не разобрал — загляни во вкладку.';
  const full = `${head} · ${tgTabName(id)}${body}${tail}`;
  // Вопрос прозой — это и есть исход хода, значит он вписывается в ту же заготовку: реплай
  // на неё маршрутизируется в ту же вкладку, потому что её id мы запомнили при отправке.
  // Кроме случая с кнопкой: правка сообщения клавиатуру не несёт, поэтому заготовка
  // становится указателем, а выход уезжает отдельным сообщением — как и в ветке с вариантами.
  if (d.tgAck) {
    if (!kb) { await tgAckResolve(id, d, full); return; }
    await tgAckResolve(id, d, `🔐 ${tgTabName(id)} держит диалог — что делать, ниже`);
  }
  const msgId = await tgSend({ threadId, text: full, replyMarkup: kb, rich: true });
  tgRemember(msgId, id);
  if (!msgId) tgNotifyFailed(d); else { d.tgFails = 0; d.tgRetryAt = 0; }
}

// Переключение режима разрешений жмёт Shift+Tab по кругу и каждый раз СМОТРИТ на экран:
// Claude Code не принимает «поставь accept edits», а жать вслепую — стрельба в темноте.
const TG_MODE_MAX_STEPS = 4;         // круг короткий; больше — значит не поняли, где мы
const TG_MODE_SETTLE_MS = 220;       // TUI успевает перерисовать строку режима
// Сколько ждать после Escape, прежде чем печатать отложенный текст: Клод убирает рамку
// диалога и возвращает поле ввода, и до этого момента буквы уходят в никуда.
const TG_ESC_SETTLE_MS = 450;

// Переключение режима, общее для /mode и быстрых кнопок. Возвращает, что получилось; слова
// для человека подбирает вызывающий.
//
// Главное здесь — отказ, когда на экране запрос разрешения. Тогда строки режима нет вообще
// (внизу «Esc to cancel · Tab to amend»), а Shift+Tab уходит в сам диалог, поэтому крутить
// режим бессмысленно. И именно в этот момент человек чаще всего и пробует — потому что ему
// надоели вопросы; поэтому вместо «не разобрал режим» надо сказать, что делать.
async function tgSwitchMode(id, d, want) {
  if (parsePrompt(promptSnapshot(d))) return { blocked: 'permission' };
  const was = readMode(snapshot(d)) || d.mode || null;
  if (was === want) return { ok: true, was, landed: was, already: true };
  let landed = was;
  for (let i = 0; i < TG_MODE_MAX_STEPS; i++) {
    const p = sessions.get(id);
    if (!p) break;
    ptyType(id, telegram.BACK_TAB);
    await new Promise((r) => setTimeout(r, TG_MODE_SETTLE_MS));
    landed = readMode(snapshot(d)) || landed;
    if (landed === want) break;
  }
  if (landed) d.mode = landed;
  tgLog(`  режим вкладки ${id}: ${was || '?'} → ${landed || '?'} (просили ${want})`);
  return { ok: landed === want, was, landed };
}

// Нажали быструю кнопку под шапкой темы. Все действия — из тех, что и так доступны
// командами; кнопка лишь избавляет от набора текста с телефона.
// Адресат — из telegram.callbackTab: в теме его называет ТЕМА, а не payload кнопки (почему —
// написано там). Быстрой кнопке этого достаточно: она ничего не печатает в диалог и не несёт
// текста конкретного запроса, поэтому расхождение с payload — не повод отказывать, а повод
// сделать то, что написано на кнопке, с тем агентом, чью тему человек открыл.
async function tgOnAction(qa, u, ack, routed) {
  // «Включить режим телефона» — единственная кнопка про ВСЁ приложение, а не про вкладку:
  // поэтому она разбирается до всех проверок про вкладку и работает даже если та успела
  // закрыться (задержанному тексту тогда просто некому уйти, см. tgFlushHeld).
  if (qa.action === 'phone') {
    const changed = tgSetPresence('phone', 'телега');
    tgLog(`  кнопка «режим телефона»: ${changed ? 'включил' : 'уже был включён'}`);
    await ack(changed
      ? '📱 Включил режим телефона — отправляю задержанное.'
      : '📱 Режим телефона уже включён.');
    // Включение само отпускает задержанное (см. tgSetPresence). Если режим уже был включён,
    // отпустить всё равно надо: кнопку могли нажать по старому отказу.
    if (!changed) await tgFlushHeld();
    return;
  }
  const at = telegram.callbackTab({ threadId: u.threadId, routed, payloadTab: qa.tab });
  const tab = at.tab;
  if (tab == null) {
    await ack('Эта тема ни с одной вкладкой не связана — кнопки в ней уже ничего не адресуют.'
      + ' Скажите /sync.');
    return;
  }
  if (at.mismatch) tgLog(`  кнопка из прошлого запуска: payload ${qa.tab}, тема даёт ${tab}`);
  const d = det.get(tab);
  if (!d || d.dead || !sessions.has(tab)) { await ack('Эта вкладка уже закрыта.'); return; }
  const name = tgTabName(tab);
  tgLog(`  быстрая кнопка: вкладка ${tab} → ${qa.action}`);
  // Правило без оговорок: в режиме компа мост в вкладки не печатает. Кнопки, которые печатают
  // (Escape, смена режима разрешений — это Shift+Tab в живую сессию), в этом режиме молчат.
  // Оставь одно исключение — и «мост в вкладки не пишет» опять придётся держать в голове со
  // сноской. «Что сейчас», «ещё агент», «вернуть тему» ничего в сессию не печатают и работают.
  if (TG_WRITING_ACTIONS.includes(qa.action) && !tgMirrors()) {
    tgLog(`  режим компа: в вкладку ${tab} не печатаю (кнопка ${qa.action})`);
    await ack('Сворм в режиме компа — в вкладки отсюда не пишу.');
    await tgSend({
      threadId: u.threadId, replyTo: u.messageId,
      text: `🖥 Сворм в режиме компа: в «${name}» я сейчас ничего не печатаю. Сделай это за`
        + ' компьютером или включи режим телефона.',
      replyMarkup: telegram.actionKeyboard(String(tab), ['phone']),
    });
    return;
  }
  if (qa.action === 'status') {
    const marks = { running: '🟠 работает', waiting: '🟡 ждёт', ready: '🟢 готов' };
    const kind = d.status === 'waiting' && d.waitingKind
      ? ` (${d.waitingKind === 'permission' ? 'разрешение' : 'вопрос'})` : '';
    await ack(`${name}: ${marks[d.status] || '⚪'}${kind}`);
    return;
  }
  if (qa.action === 'new') {
    if (!d.cwd) { await ack('Не знаю папку этой вкладки.'); return; }
    safeSend('app:createTab', { cwd: d.cwd });
    await ack('Открываю ещё одного агента в этой папке.');
    return;
  }
  // Ответы на «тему закрыли, а вкладка жива» (см. tgOnService). Вкладку закрывает рендерер —
  // тем же путём, что и крестик на самой вкладке, — а тема исчезнет следом, как при любом
  // закрытии.
  if (qa.action === 'reopen') {
    await tgTopicCall('reopenForumTopic', tgTopicOf(d));
    await ack('Тема снова открыта — пиши сюда.');
    return;
  }
  if (qa.action === 'kill') {
    safeSend('app:closeTab', { id: tab });
    await ack(`Закрываю «${name}».`);
    return;
  }
  // «Да, стереть» — единственная кнопка моста, которая теряет что-то безвозвратно, поэтому
  // она отвечает только на СВЕЖИЙ вопрос. Сообщение с ней остаётся в теме навсегда, а разговор
  // за час станет другим: нажатие по вчерашнему запросу стёрло бы не то, о чём спрашивали, и
  // человек узнал бы об этом уже после.
  if (qa.action === 'clear') {
    const asked = d.tgClearAsk || 0;
    d.tgClearAsk = 0;
    if (!asked || Date.now() - asked > TG_CLEAR_TTL_MS) {
      tgLog(`  кнопка «стереть»: запрос по вкладке ${tab} устарел — не стираю`);
      await ack('Этот запрос уже устарел, а разговор с тех пор мог стать другим. Скажите /clear'
        + ' заново, если всё ещё нужно.');
      return;
    }
    const done = await tgTypeClaudeCommand(tab, d, { ...u, command: 'clear' }, '/clear');
    if (done) await ack(`Стёр разговор в «${name}».`);
    return;
  }
  // Выход из тупика: Escape закрывает диалог, ничего в нём не выбрав. Ничего не одобряет —
  // именно поэтому такой кнопке можно быть там, где кнопкам с вариантами нельзя.
  //
  // Отложенный текст (см. отказ в tgOnMessage) уходит следом, а не вместо: человек уже написал
  // словами то, что хотел, и заставлять его набирать это на телефоне второй раз — та же
  // ловушка, только на один шаг длиннее. Пауза перед печатью нужна, чтобы TUI успел убрать
  // рамку: буквы, напечатанные в исчезающий диалог, пропадают вместе с ним.
  if (qa.action === 'esc') {
    const p = sessions.get(tab);
    if (!p) { await ack('Эта вкладка уже закрыта.'); return; }
    // Кнопка из прошлого тупика остаётся в ленте навсегда, а Escape в РАБОТАЮЩЕГО агента —
    // это прерванный ход. Поэтому нажатие действует только пока вкладка правда ждёт.
    if (d.status !== 'waiting') {
      await ack('Диалога сейчас нет — Escape не жму, чтобы не прервать работу. Пишите словами.');
      return;
    }
    const pending = d.tgPending || '';
    d.tgPending = '';
    ptyType(tab, telegram.ESC);
    markAnswered(d, Date.now());
    tgLog(`  кнопка «закрыть диалог»: вкладка ${tab}${pending ? ' + отложенный текст' : ''}`);
    if (!pending) { await ack('Закрыл диалог. Теперь можно писать словами.'); return; }
    await new Promise((r) => setTimeout(r, TG_ESC_SETTLE_MS));
    if (!tgAnswer(tab, pending)) { await ack('Диалог закрыл, но вкладки уже нет.'); return; }
    await ack('Закрыл диалог и отправил ваше сообщение.');
    return;
  }
  // Режимы: то же, что /mode, но одним касанием. Ответ во всплывашке говорит, чем это
  // кончилось — включая цену «правки без спроса», чтобы нажатие не выглядело безобидным.
  const want = qa.action === 'auto' ? 'auto' : qa.action === 'edits' ? 'accept-edits' : 'manual';
  const r = await tgSwitchMode(tab, d, want);
  if (r.blocked === 'permission') {
    await ack('Сейчас открыт запрос разрешения. Ответь на него кнопкой — вариант'
      + ' «Yes, and always allow…» и есть «без спроса» для таких же дальше.');
    return;
  }
  if (r.already) { await ack(`${name}: уже «${modeTitle(want)}».`); return; }
  // Ответ через modeTitle, а не тремя ветками руками. Раньше ветки было две, и нажатие
  // «✍️ правки без спроса» отвечало «снова спрашивает разрешение» — то есть кнопка сообщала
  // ровно противоположное тому, что сделала. Подпись и ответ теперь из одного места.
  await ack(r.ok
    ? `${name}: ${modeTitle(want)}.`
    : `Не смог переключить — сейчас ${r.landed ? modeTitle(r.landed) : 'режим не разобрал'}.`);
}

// A tapped button. Everything is re-checked here, because a lot can happen between the
// message going out and your thumb landing on it: the tab may be gone, the prompt may have
// been answered at the keyboard, or a DIFFERENT prompt may now be on screen. Printing the
// number into that would be the worst thing this bridge could do — so the fingerprint of
// what's on screen right now must equal the one the button was built with.
async function tgOnCallback(u) {
  const ack = (text) => tgFetchJson(telegram.apiUrl(TG.token, 'answerCallbackQuery'),
    { callback_query_id: u.callbackId, text, show_alert: false }).catch(reportMainError);
  // Нажатие в журнал ЦЕЛИКОМ и сразу, до всех проверок: раньше писали только успешные пути, и
  // «я нажал, ничего не произошло» выглядело в журнале как отсутствие нажатия. Автор здесь
  // важнее, чем у сообщения: разрешение — самое весомое действие моста.
  tgLog(`← кнопка от ${telegram.senderLabel(u)} · thread=${u.threadId == null ? '-' : u.threadId}`
    + ` data=${JSON.stringify(String(u.data || '').slice(0, 40))}`);
  // Кого адресует нажатие, решает ТЕМА, в которой висит кнопка: тема привязана к вкладке
  // ключом, переживающим перезапуск, а номер вкладки в payload — нет (см. telegram.callbackTab).
  const routed = tgRoute(u);
  // Быстрые действия разбираются ПЕРВЫМИ и совершенно отдельно от разрешений: у них свой
  // префикс, свой обработчик и никакого отпечатка — потому что они ничего не печатают в
  // диалог. Спутать «⚡ правки без спроса» с выбором варианта в запросе разрешения было бы
  // худшим, что этот мост умеет, поэтому пути не пересекаются даже случайно.
  const qa = telegram.parseAction(u.data);
  if (qa) { await tgOnAction(qa, u, ack, routed); return; }
  const cb = telegram.parseCallbackData(u.data);
  if (!cb) { await ack('Не понял эту кнопку.'); return; }
  // Здесь расхождение с темой — ОТКАЗ, в отличие от быстрых кнопок: это сообщение несёт текст
  // запроса и отпечаток конкретной вкладки, значит при расхождении оно просто не про ту вкладку,
  // и печатать в неё номер варианта нельзя. «Тема нам неизвестна» — тоже отказ, иначе решал бы
  // один payload из прошлого запуска.
  const at = telegram.callbackTab({ threadId: u.threadId, routed, payloadTab: cb.tab });
  if (at.tab == null || at.mismatch) {
    tgLog(`  нажатие мимо: кнопка адресует вкладку ${cb.tab}, а тема ${u.threadId} —`
      + ` ${routed == null ? 'ничью' : 'вкладку ' + routed}`);
    await ack('Эта кнопка от прошлого запуска — ничего по ней не делаю.'
      + ' Скажите /sync, и запрос придёт заново.');
    return;
  }
  const tab = at.tab;
  const d = det.get(tab);
  if (!d || d.dead || !sessions.has(tab)) {
    await ack('Эта вкладка уже закрыта.');
    return;
  }
  // Режим компа: в вкладку не печатаем ничего, и номер варианта — тем более (см. tgDeskHold).
  // Задержать его, как текст, нельзя: одобряют то, что видят, а к моменту включения режима на
  // экране может стоять другой запрос. Кнопка не потеряна — включив режим телефона, ты получишь
  // этот вопрос заново и свежими кнопками.
  if (!tgMirrors()) {
    tgLog(`  нажатие в режиме компа: вкладке ${tab} ничего не печатаю`);
    await ack('Сворм в режиме компа — разрешение отсюда не даю.');
    await tgSend({
      threadId: u.threadId, replyTo: u.messageId,
      text: `🖥 Сворм в режиме компа: одобрять запросы отсюда я не буду — ответь за`
        + ` компьютером или включи режим телефона, и «${tgTabName(tab)}» пришлёт этот запрос`
        + ' заново.',
      replyMarkup: telegram.actionKeyboard(String(tab), ['phone']),
    });
    return;
  }
  const now = parsePrompt(promptSnapshot(d));
  if (!now || now.fingerprint !== cb.fingerprint) {
    await ack('Запрос уже закрыт — на экране другое.');
    tgLog(`  нажатие мимо: отпечаток ${cb.fingerprint} ≠ ${now ? now.fingerprint : 'нет запроса'}`);
    return;
  }
  const chosen = now.options.find((o) => o.n === cb.n);
  if (!chosen) { await ack('Такого варианта здесь нет.'); return; }
  tgAnswer(tab, String(cb.n));
  tgLog(`  нажатие: вкладка ${tab} → вариант ${cb.n}`);
  await ack(`Выбрано: ${cb.n}. ${chosen.text}`);
  // Freeze the message: the choice is made, the buttons must not invite a second tap.
  await tgFetchJson(telegram.apiUrl(TG.token, 'editMessageText'), {
    chat_id: u.chatId,
    message_id: u.messageId,
    text: `${u.text}\n\n✅ выбрано: ${cb.n}. ${chosen.text}`,
  }).catch(reportMainError);
}

// Why a pairing attempt didn't take. Told to the chat that tried, because the person
// holding the phone is the only one who can act on it.
function tgPairHint() {
  if (!tgPair) return 'Окно привязки закрыто. Откройте «Настройки → Телеграм» → «Привязать группу»'
    + ' и пришли новый код.';
  const left = TG_PAIR_TTL_MS - (Date.now() - tgPair.at);
  if (left <= 0) return 'Код истёк. Нажмите «Привязать группу» ещё раз и пришлите новый —'
    + ' он живёт 15 минут.';
  return `Этот код не подходит. Пришлите тот, что показан в настройках (действует ещё`
    + ` ${Math.ceil(left / 60000)} мин).`;
}

// Minutes a live pairing code still has, for messages that ask the user to go fix
// something and come back.
function tgPairLeftMin() {
  if (!tgPair) return 0;
  return Math.max(0, Math.ceil((TG_PAIR_TTL_MS - (Date.now() - tgPair.at)) / 60000));
}

// Bind a chat — from the pairing code or from a hand-typed id. The check is a GATE, not
// advice: binding a chat where the bot can't create topics or can't see messages would
// look like a working bridge that silently does nothing. On refusal we say exactly what to
// fix and keep the pairing window open, so the user can fix it and send the code again.
async function tgBindChat(chatId, threadId) {
  const check = await tgCheckChat(chatId);
  tgCheck = check;
  if (!check || !check.ok) {
    tgLog(`  привязка отклонена: ${(check && check.note) || 'проверка не прошла'}`);
    // Keep the window open: the user is about to go fix exactly what we just named, and a
    // code that dies while they're in the group settings is how this looked broken.
    // Но не бесконечно: код — единственное, что стоит между чужим человеком, нашедшим бота, и
    // привязкой к этой машине, поэтому продлеваем дважды, а дальше пусть жмут «Привязать» снова.
    if (tgPair && (tgPair.renewed || 0) < TG_PAIR_RENEW_MAX) {
      tgPair.at = Date.now();
      tgPair.renewed = (tgPair.renewed || 0) + 1;
    }
    const note = (check && check.note) || 'Не удалось проверить чат.';
    const tail = tgPair ? ` Поправь и пришли этот же код снова — он действует ещё ${tgPairLeftMin()} мин.` : '';
    await tgSend({ chatId, threadId, text: note + tail });
    tgPush();
    return false;
  }
  TG.chatId = chatId;
  TG.isForum = true;
  TG.topics = {};
  tgResetRouting();          // ids from the previous group must not address this one
  tgPair = null;
  try { tgSave(); } catch (e) { reportMainError(e); }
  await tgSend({
    chatId,
    threadId,
    text: 'Сворм на связи. Каждая вкладка получит свою тему: пиши в тему — попадёшь в её агента.'
      + ' Список вкладок — /tabs.',
  });
  tgApplyKeepAwake();
  tgPush();
  tgEnsureTopics().catch(reportMainError);   // темы для уже открытых вкладок
  return true;
}

// Бота выгнали из группы или разжаловали из администраторов. До этой ветки узнать о таком
// было нечем: мост считал себя живым, «Мост в эфире» в настройках горел зелёным, а группа
// его уже не слышала — и разбираться человек начинал с того, что «сворм молчит».
//
// Ничего не отвязываем: восстановить права — дело одного касания в телеге, а стереть карту
// тем из-за случайного нажатия нельзя. Только называем беду в панели и в журнале.
function tgOnMembership(u) {
  if (TG.chatId == null || u.chatId !== TG.chatId) return;
  tgLog(`← бот в группе: ${u.status || '?'} (${telegram.senderLabel(u)})`);
  if (u.status === 'left' || u.status === 'kicked') {
    tgError = 'Бота убрали из группы — вернуть его и снова сделать администратором';
  } else if (u.status === 'administrator') {
    // Права вернули: старая жалоба на экране была бы ложью. Заодно забываем прошлый разбор
    // — он про то, как было, а не про то, как стало.
    tgError = null;
    tgCheck = null;
  } else {
    // «member» после «administrator» — это разжалование. Без админства Telegram (режим
    // приватности ботов) не отдаёт обычные сообщения в темах: мост оглох, хотя формально в
    // группе. Пишем прямо, потому что симптом («не отвечает на сообщения») сам себя не
    // объясняет.
    tgError = 'Бот больше не администратор — без этого он не видит сообщения в темах';
  }
  tgPush();
}

function tgOnUpdate(u) {
  if (!u) return;
  if (u.kind === 'callback') {
    if (TG.chatId != null && u.chatId === TG.chatId) tgOnCallback(u).catch(reportMainError);
    return;
  }
  if (u.kind === 'membership') { tgOnMembership(u); return; }
  if (u.kind !== 'message') return;
  tgLog(`← от ${telegram.senderLabel(u)} · chat=${u.chatId}`
    + ` thread=${u.threadId == null ? '-' : u.threadId}`
    + ` reply=${u.replyToId == null ? '-' : u.replyToId} cmd=${u.command || '-'}`
    + ` text=${JSON.stringify(String(u.text || '').slice(0, 60))}`);
  // Pairing wins over everything: the chat that brings the code becomes THE chat. Until
  // then nothing is bound, so no message can be mistaken for an answer to an agent.
  if (tgPair && Date.now() - tgPair.at < TG_PAIR_TTL_MS && telegram.pairingMatch(u, tgPair.code)) {
    tgLog('  код совпал — проверяю чат');
    tgBindChat(u.chatId, u.threadId).catch(reportMainError);
    return;
  }
  // Nothing bound yet, and the code didn't match above: this is almost always someone
  // trying to pair and getting it slightly wrong (a stale code, a code from a previous
  // click, no open window at all). Silence here reads as «мост сломан», so say which of
  // those it is. Nothing can be bound by this reply, so it's safe to answer.
  if (TG.chatId == null) {
    tgLog(`  чат не привязан; код ${tgPair ? 'открыт, не совпал или истёк' : 'не запрашивали'}`);
    if (u.command === 'start' || /^[A-Za-z0-9]{4,10}$/.test(String(u.text || '').trim())) {
      tgSend({ chatId: u.chatId, threadId: u.threadId, text: tgPairHint() }).catch(reportMainError);
    }
    return;
  }
  // Anything from another chat is not ours to listen to — a stranger who found the bot
  // gets silence, not a prompt injected into somebody's session.
  if (u.chatId !== TG.chatId) { tgLog('  чужой чат — игнорирую'); return; }

  // Тему тронули пальцами в самой телеге — переименовали или закрыли. Текста в таком
  // обновлении нет вовсе, поэтому разбирается оно ДО проверки «сообщение пустое», иначе
  // событие тихо выпадало бы в ту же дыру, из-за которой синк работал в одну сторону.
  if (u.service) { tgOnService(u).catch(reportMainError); return; }

  if (u.command === 'tabs') { tgSendTabs(u.threadId).catch(reportMainError); return; }
  if (u.command === 'usage') { tgUsage(u).catch(reportMainError); return; }
  if (u.command === 'sync') { tgSync(u.threadId).catch(reportMainError); return; }
  if (u.command === 'new') { tgNewTab(u).catch(reportMainError); return; }
  if (u.command === 'mode') { tgMode(u).catch(reportMainError); return; }
  if (u.command === 'phone') { tgWhereAmI(u, 'phone').catch(reportMainError); return; }
  if (u.command === 'comp') { tgWhereAmI(u, 'desk').catch(reportMainError); return; }
  if (u.command === 'night') { tgNightCmd(u).catch(reportMainError); return; }
  if (u.command === 'auto') { tgAutoCmd(u).catch(reportMainError); return; }
  if (u.command === 'morning') { tgMorning(u).catch(reportMainError); return; }
  if (u.command === 'last') { tgLastWord(u).catch(reportMainError); return; }
  // Помощь собирается из ТОГО ЖЕ списка, что и меню у поля ввода (telegram.COMMANDS).
  // Списка было два, набранных руками, и они уже разошлись формулировками: человек читал в
  // меню одно, а в /help про ту же команду другое.
  if (u.command === 'start' || u.command === 'help') {
    tgSend({ threadId: u.threadId, text: [
      'Уже на связи. Каждая вкладка живёт в своей теме — пишите в тему, попадёте в её агента.',
      'Можно голосом и картинкой: скриншот уйдёт агенту файлом.',
      'Писать агентам я даю в режиме телефона (/phone): за компом вы всё видите сами, и'
        + ' сообщение оттуда я разверну обратно — кнопкой, которая режим и включит.',
      '',
      ...telegram.COMMANDS.map((c) => `/${c.command} — ${c.description}`),
      '',
      'Любая другая команда со слэшем — не моя, а Клода: я печатаю её в вкладку темы, как'
        + ' будто вы набрали её за клавиатурой. Так работают /clear, /compact, /model и ваши'
        + ' собственные команды.',
    ].join('\n') }).catch(reportMainError);
    return;
  }
  if (u.voice) { tgOnVoice(u).catch(reportMainError); return; }
  if (u.photo) { tgOnPhoto(u).catch(reportMainError); return; }
  // Слэш, которого нет среди моих, — команда самого Клода. Проверка идёт ПОСЛЕ картинки:
  // подпись под скриншотом — это слова агенту, а не команда, даже если начинается со слэша.
  if (u.command && !telegram.isOwnCommand(u.command)) {
    tgClaudeCommand(u).catch(reportMainError);
    return;
  }
  const text = String(u.text || '').trim();
  // Вложение, с которым мы ничего не сделаем. Раньше здесь была ТИШИНА: файл или кружок,
  // отправленный в тему, не вызывал вообще ничего — ни ответа, ни строчки в журнале, и это
  // неотличимо от сломанного моста. Сказать «не умею» стоит одного сообщения.
  if (!text) {
    if (u.media) {
      tgLog(`  вложение «${u.media}» — не умею`);
      tgSend({ threadId: u.threadId, replyTo: u.messageId,
        text: `Не умею брать ${telegram.mediaLabel(u.media)}. Напишите текстом, наговорите голосовое`
          + ' или пришли картинку — её я отдам агенту файлом.' }).catch(reportMainError);
    }
    return;
  }

  const id = tgRoute(u);
  tgLog(`  адресат: ${id == null ? 'не определён' : 'вкладка ' + id + ' (' + tgTabName(id) + ')'}`);
  if (id == null) {
    // Отказ должен называть НАСТОЯЩУЮ причину: «это общая тема» в ответ на сообщение,
    // отправленное в тему вкладки, отправляет человека искать не ту проблему.
    const why = telegram.routeFailure(u, { topics: TG.topics });
    const text = why === 'general'
      ? 'Это общая тема — здесь я не знаю, к какому агенту обращаться. Напишите в тему нужной'
        + ' вкладки (список — /tabs) или ответь реплаем на сообщение агента.'
      : why === 'topic-closed'
        ? 'Вкладка этой темы уже закрыта, писать некому. Открытые — /tabs, а /sync приведёт'
          + ' темы в соответствие с ними.'
        : 'Эта тема ни с одной вкладкой не связана. Скажите /sync — я заново сведу темы с'
          + ' открытыми вкладками, и сюда снова можно будет писать.';
    tgLog(`  отказ: ${why}`);
    tgSend({ threadId: u.threadId, replyTo: u.messageId, text }).catch(reportMainError);
    return;
  }
  const d = det.get(id);
  // Tag the text so the agent knows it's answering into a phone (short answers, no
  // interactive pickers). The first message of a session carries the whole convention.
  const tagged = telegram.tagInput({ text, instruction: TG_PROMPT, primed: !!(d && d.tgPrimed) });
  tgDeliver(id, d, u, tagged).catch(reportMainError);
}

// Отдать вкладке готовую строку. Общий хвост для сообщения и для картинки: они отличаются
// только тем, ЧТО получилось из присланного, а правила дальше одни — диалог на экране,
// закрытая вкладка, заготовка «получил, думаю…».
async function tgDeliver(id, d, u, tagged) {
  // Режим компа — сообщение не уходит вовсе (см. tgDeskHold). Проверяем ПЕРВЫМ: остальные
  // ветки ниже говорят про экран вкладки, а его в этом режиме человек видит сам.
  if (await tgDeskHold(id, d, u, tagged)) return;
  // The one thing that never travels from a phone: approving a command. See tgNotifyWaiting.
  //
  // Но отказать можно только тому, у кого ЕСТЬ чем ответить, — кнопкам с вариантами Клода.
  // Живой случай: вопрос с вариантами, под каждым из которых своя строка описания, парсер не
  // разобрал (см. screen.parsePrompt), уведомление ушло без кнопок, и на любой текст с
  // телефона приходило «выбери вариант кнопкой под запросом» — кнопкой, которой там нет.
  // Выхода не оставалось вообще: ни выбрать, ни написать словами. Поэтому здесь тупика больше
  // нет: текст ждёт, а Escape закрывает диалог и отправляет его следом.
  if (d && d.status === 'waiting' && d.waitingKind === 'permission') {
    const open = parsePrompt(promptSnapshot(d));
    if (open && open.options.length) {
      await tgSend({
        threadId: u.threadId, replyTo: u.messageId,
        text: `${tgTabName(id)} ждёт разрешения: выбери вариант кнопкой под запросом.`
          + ' Словами разрешение не даётся — одобрять можно только то, что предложил Клод.',
      });
      return;
    }
    d.tgPending = tagged;
    tgLog(`  текст отложен: вкладка ${id} держит диалог, вариантов в нём не разобрал`);
    await tgSend({
      threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} держит диалог на экране, а вариантов в нём я не разобрал —`
        + ' напечатать словами прямо в него нельзя. Нажмите «закрыть диалог»: я закрою его'
        + ' и отправлю это сообщение.',
      replyMarkup: telegram.actionKeyboard(String(id), ['esc']),
    });
    return;
  }
  if (!tgAnswer(id, tagged)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' });
    return;
  }
  if (d) d.tgPrimed = true;
  await tgAckSend(id, d, u);
}

// --- команда самого Клода, набранная с телефона --------------------------------
// Мост исполняет свои команды (telegram.COMMANDS) и НЕ пытается понимать чужие: всё
// остальное со слэшем он печатает в живую вкладку как есть и жмёт Enter. Для Claude Code это
// неотличимо от набора за клавиатурой, поэтому с телефона работают и /clear, и /compact, и
// /model, и личные команды из ~/.claude/commands — про которые мост не знает и знать не должен.
//
// Ключевое отличие от прозы: строка уходит БЕЗ пометки «[из телеги: …]». Пометка стоит первой,
// и строка тогда начинается не со слэша — Claude Code видит слова о команде вместо команды.
// Ровно поэтому /clear с телефона раньше ничего не стирал: он доезжал до агента текстом.
//
// Сколько живёт вопрос «стереть разговор?». Кнопка под ним остаётся в ленте навсегда, а
// разговор за это время станет другим — нажатие через час стёрло бы не то, о чём спрашивали.
const TG_CLEAR_TTL_MS = 5 * 60_000;

async function tgClaudeCommand(u) {
  const line = telegram.claudeLine(u);
  const id = tgRoute(u);
  if (id == null) {
    // Отказ обязан называть причину точно: «такой команды не знаю» отправило бы человека
    // искать опечатку, хотя команда правильная — просто сказана не в теме вкладки.
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `«${line}» — команда самого Клода, и я печатаю её в вкладку. Скажите её в теме нужной`
        + ' вкладки (список — /tabs), тогда я буду знать, чьему агенту.' });
    return;
  }
  const d = det.get(id);
  if (!d || d.dead || !sessions.has(id)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' });
    return;
  }
  // Единственная команда, которую мост не отдаёт сразу. Не потому, что она «опасная вообще»,
  // а потому, что необратима и стоит в меню у поля ввода рядом с /comp: промах пальцем по
  // списку с телефона не должен стирать разговор, который вели полдня.
  if (u.command === 'clear') {
    d.tgClearAsk = Date.now();
    tgLog(`  /clear: спрашиваю подтверждение по вкладке ${id}`);
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `🧹 Стереть разговор в «${tgTabName(id)}»?\n\nВсё, что вы обсудили, пропадёт —`
        + ' назад не вернуть. Сделанное на диске останется, память об этом нет.',
      replyMarkup: telegram.actionKeyboard(String(id), ['clear']) });
    return;
  }
  await tgTypeClaudeCommand(id, d, u, line);
}

// Напечатать команду в вкладку. Отдельно от разбора, потому что сюда приходят двое: сама
// команда и кнопка «да, стереть».
async function tgTypeClaudeCommand(id, d, u, line) {
  const name = tgTabName(id);
  // Правило без оговорок: в режиме компа мост в вкладки не печатает (см. tgDeskHold). Здесь
  // оно строже, чем для прозы: текст мы держим до кнопки, а команду — нет. Набрать «/clear»
  // заново не то же, что надиктовать заново абзац, а исполнить её через час — уже не то, о
  // чём просили: разговор к тому моменту другой.
  if (!tgMirrors()) {
    tgLog(`  режим компа: «${line}» в вкладку ${id} не печатаю`);
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `🖥 Сворм в режиме компа: в «${name}» я ничего не печатаю, а команда — это ровно`
        + ' печать в неё. Набери её за компьютером или включи режим телефона и повтори.',
      replyMarkup: telegram.actionKeyboard(String(id), ['phone']) });
    return false;
  }
  // Диалог на экране забирает себе всё, что печатают: слэш уйдёт не в поле ввода, а в рамку
  // запроса — и там он не команда, а мусор в чужом окне.
  //
  // Смотрим НА ЭКРАН, а не на «вкладка ждёт разрешения», как это делает проза (см. tgDeliver).
  // Проза в открытый вопрос — законный ответ, а команда не ответ ничему: её съест любая рамка,
  // включая ту, что открыла предыдущая команда (`/model` без аргумента — это выбор списком).
  // Та же проверка стоит перед Shift+Tab (см. tgSwitchMode) и ровно по той же причине.
  const open = parsePrompt(promptSnapshot(d));
  if (open) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: open.options.length
        ? `${name} держит запрос на экране — пока он там, команда уйдёт в него, а не в поле`
          + ' ввода. Ответь кнопкой под запросом и повтори команду.'
        : `${name} держит диалог на экране — команда уйдёт в него, а не в поле ввода. Нажмите`
          + ' «закрыть диалог» и повтори команду.',
      replyMarkup: open.options.length ? null : telegram.actionKeyboard(String(id), ['esc']) });
    return false;
  }
  if (!tgAnswer(id, line)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' });
    return false;
  }
  // Контекст оборвали — значит уговор «отвечаешь коротко и в телегу» Клод больше не помнит:
  // он живёт в первом сообщении с телефона и уходит вместе с разговором. Снимаем отметку, и
  // следующее сообщение придёт с уговором заново. Без этого вкладка после /clear отвечала бы
  // в чат простынями, будто её никто ни о чём не просил.
  const forgets = u.command === 'clear' || u.command === 'compact';
  if (forgets) { d.tgPrimed = false; d.tgLastSent = ''; }
  tgLog(`  команда Клода «${line}» → вкладка ${id}`);
  await tgSend({ threadId: u.threadId, replyTo: u.messageId,
    text: `Напечатал «${line}» в «${name}».`
      + (u.command === 'clear' ? ' Разговор чистый — агент про прежнее уже не помнит.'
        : ' Что из этого вышло, видно на экране вкладки: /last покажет последнее слово агента.') });
  return true;
}

// Голосовое: сначала адресат (иначе незачем и распознавать), потом эхо распознанного и
// только затем печать в сессию. Эхо обязательно: «RoseVPN» легко становится «розовым пн», и
// увидеть это надо ДО того, как агент начнёт по нему работать.
async function tgOnVoice(u) {
  const id = tgRoute(u);
  if (id == null) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Не понял, какой вкладке это. Пришлите голосовое в тему нужной вкладки.' });
    return;
  }
  const d = det.get(id);
  if (d && d.status === 'waiting' && d.waitingKind === 'permission') {
    // Как и с текстом (см. tgOnMessage): отсылать к кнопке можно только когда кнопка есть.
    // Голосовое здесь ещё не расшифровано, откладывать нечего — но выход дать обязаны.
    const open = parsePrompt(promptSnapshot(d));
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: open && open.options.length
        ? `${tgTabName(id)} ждёт разрешения — выбери вариант кнопкой, голосом это не даётся.`
        : `${tgTabName(id)} держит диалог, а вариантов в нём я не разобрал. Нажмите «закрыть`
          + ' диалог» и скажи голосовое снова.',
      replyMarkup: open && open.options.length ? null : telegram.actionKeyboard(String(id), ['esc']) });
    return;
  }
  const secs = Number(u.voice.seconds) || 0;
  if (secs > TG_VOICE_MAX_S) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `Это ${secs} с — беру голосовые до ${TG_VOICE_MAX_S} с. Скажите короче или напишите текстом.` });
    return;
  }
  const r = await tgVoiceToText(u.voice.fileId);
  if (r.error) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: r.error });
    return;
  }
  // Эхо ДО печати в сессию, и именно поэтому await: «RoseVPN» легко становится «розовым
  // пн», и увидеть, ЧТО услышано, надо раньше, чем агент по этому пойдёт работать. Если
  // сначала печатать, то в ленте порядок обратный — ответ агента раньше расшифровки.
  // Расшифровка — ОТДЕЛЬНЫМ сообщением, которое потом никто не переписывает. Так человек
  // видит своими глазами, что именно услышано («RoseVPN» или «розовый пн»), и может
  // поправить, пока агент ещё думает. Вписывать её в сообщение с ответом нельзя: длинный
  // ответ в правку не влезает (Telegram режет на 4096), и тогда расшифровка осталась бы
  // висеть рядом с вечным «думаю…».
  tgRemember(await tgSend({ threadId: u.threadId, replyTo: u.messageId,
    text: `🎙 услышал: «${r.text}»` }), id);
  const tagged = telegram.tagInput({ text: r.text, instruction: TG_PROMPT, primed: !!(d && d.tgPrimed) });
  // Режим компа: расшифровку человек уже увидел («услышал: …»), а вот в вкладку не пишем —
  // держим её до кнопки. Наговаривать то же самое второй раз никто не станет.
  //
  // ДО заготовки «получил, думаю…»: ход не начался, и часики, которым нечего дождаться, —
  // худшее, что можно оставить в ленте.
  if (await tgDeskHold(id, d, u, tagged)) return;
  await tgAckSend(id, d, u);
  if (!tgAnswer(id, tagged)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: 'Эта вкладка уже закрыта.' });
    return;
  }
  if (d) d.tgPrimed = true;
}

// --- картинка из чата ----------------------------------------------------------
// Скриншот — самый быстрый способ показать агенту, что случилось: пересказывать пальцами
// красную простыню из терминала никто не будет. Claude Code читает картинки с диска, так
// что мосту достаточно положить файл и назвать путь — дальше агент смотрит сам.
//
// Кладём во временную папку системы, а не в userData: на маке userData — это «Application
// Support», путь с пробелами, и он поедет в строку задачи, где пробел разделяет слова.
// В tmpdir пробелов нет ни на одной из систем, а живёт файл ровно столько, сколько нужно.
const TG_IMG_MAX_BYTES = 20 << 20;      // столько же, сколько отдаёт сам Bot API
const TG_IMG_TTL_MS = 24 * 3600_000;    // сутки: за это время по картинке уже отработали

function tgImageDir() { return path.join(os.tmpdir(), 'swarm-tg-images'); }

// Старые снимки прибираем при каждом новом: без этого папка растёт молча и вечно, а
// напоминать о себе такому мусору нечем — человек про него никогда не узнает.
function tgSweepImages() {
  const dir = tgImageDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const dead = Date.now() - TG_IMG_TTL_MS;
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).mtimeMs < dead) fs.unlinkSync(p); } catch (_) {}
  }
}

// Имя файла из того, что прислали. Всё чужое отсюда выкидывается: имя приходит из телеги, а
// склеивается с путём — «../» в нём означал бы запись куда угодно. Пробелы тоже: путь идёт
// в строку задачи, где пробел разделяет слова.
function tgImageName(photo, filePath) {
  const given = path.basename(String((photo && photo.name) || '')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const ext = (path.extname(given) || path.extname(String(filePath || '')) || '.jpg').toLowerCase();
  const stem = path.basename(given, path.extname(given)).slice(0, 40) || 'shot';
  return `${stem}-${Date.now().toString(36)}${ext}`;
}

// Скачать картинку в файл. Возвращает { file } или { error } — текст ошибки уходит в чат как
// есть: человек с телефоном должен понимать, что случилось, а не смотреть в тишину.
async function tgSaveImage(photo) {
  try {
    const info = await tgFetchJson(telegram.apiUrl(TG.token, 'getFile'), { file_id: photo.fileId });
    const fpath = info.ok && info.body && info.body.ok === true && info.body.result && info.body.result.file_path;
    if (!fpath) return { error: 'Не смог забрать картинку у Telegram.' };
    const res = await fetch(`${telegram.API_HOST}/file/bot${TG.token}/${fpath}`);
    if (!res.ok) return { error: `Не смог скачать картинку (HTTP ${res.status}).` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) return { error: 'Картинка пришла пустой.' };
    tgSweepImages();
    fs.mkdirSync(tgImageDir(), { recursive: true });
    const file = path.join(tgImageDir(), tgImageName(photo, fpath));
    fs.writeFileSync(file, bytes);
    return { file };
  } catch (e) {
    // Сеть тут рвётся штатно (телефон в метро, мак ушёл в сон), и fetch в этом случае
    // БРОСАЕТ. Без перехвата вся реакция на картинку свелась бы к записи в лог main.
    return { error: 'Картинка не дошла: ' + ((e && e.message) || e) };
  }
}

async function tgOnPhoto(u) {
  const id = tgRoute(u);
  if (id == null) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Не понял, кому эта картинка. Пришлите её в тему нужной вкладки (список — /tabs).' });
    return;
  }
  if (u.photo.bytes > TG_IMG_MAX_BYTES) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `Это ${Math.round(u.photo.bytes / (1 << 20))} МБ — беру картинки до ${TG_IMG_MAX_BYTES >> 20} МБ.` });
    return;
  }
  const saved = await tgSaveImage(u.photo);
  if (saved.error) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId, text: saved.error });
    return;
  }
  tgLog(`  картинка → вкладка ${id}: ${saved.file}`);
  const d = det.get(id);
  // Подпись — это и есть задача («почему тут пусто?»), картинка к ней приложена. Без подписи
  // говорим прямо, что от агента нужно: иначе путь к файлу в пустой строке выглядит как
  // обрывок, и агент начинает спрашивать, что с ним делать.
  const caption = String(u.text || '').trim();
  const body = caption ? `${caption}\n\nКартинка: ${saved.file}` : `Посмотри картинку: ${saved.file}`;
  await tgDeliver(id, d, u, telegram.tagInput({
    text: body, instruction: TG_PROMPT, primed: !!(d && d.tgPrimed),
  }));
}

// /new в теме — ещё один агент в ТОЙ ЖЕ папке. Папку называть не надо: тема = вкладка =
// папка, и это самый естественный жест с телефона. Вкладки рождаются в рендерере (там
// xterm и DOM), поэтому main просит его, а не создаёт сам; тема новой вкладке создастся
// сама, как только у неё появится имя.
async function tgNewTab(u) {
  const id = tgRoute(u);
  const d = id == null ? null : det.get(id);
  if (!d || !d.cwd) {
    await tgSend({ threadId: u.threadId, text: '/new работает в теме вкладки — оттуда я знаю папку.'
      + ' Список тем — /tabs.' });
    return;
  }
  safeSend('app:createTab', { cwd: d.cwd });
  await tgSend({ threadId: u.threadId, text: `Открываю ещё одного агента в ${d.cwd}.`
    + ' Его тема появится в группе через пару секунд.' });
}

// /mode — посмотреть и переключить режим разрешений из телеги, тем же Shift+Tab, которым
// это делают за клавиатурой. Смысл: с телефона видно, что агент упёрся в разрешения на
// каждую правку, и можно разрешить их пачкой, не подходя к маку.
//
// Циклом, а не «установить режим»: Claude Code переключает режимы по кругу и не принимает
// «сделай accept edits» — поэтому жмём по одному разу и СМОТРИМ на экран, пока не попадём в
// нужный. Без чтения экрана это была бы стрельба в темноте.
// Четыре режима живого Claude Code, и auto — САМОСТОЯТЕЛЬНЫЙ, а не синоним accept edits:
// правки без спроса разрешают только правки, а auto судит каждое действие сам. Раньше
// здесь стояло auto → accept-edits, и «/mode auto» честно останавливался на «правках»,
// потому что просил не то.
//
// Псевдоним «без-вопросов» оставлен, хотя обещает лишнее: люди его уже набирали, и убрать
// его значило бы отвечать «не понял режим» на то, что вчера работало. Ответ теперь говорит
// правду про цену, а вход остаётся широким.
const TG_MODE_ALIASES = {
  auto: 'auto', авто: 'auto', автомод: 'auto', 'без-вопросов': 'auto',
  edits: 'accept-edits', 'accept-edits': 'accept-edits', правки: 'accept-edits',
  plan: 'plan', план: 'plan', планирование: 'plan',
  manual: 'manual', обычный: 'manual', normal: 'manual', ручной: 'manual',
};

function tgModeNow(d) {
  return readMode(snapshot(d));
}

async function tgMode(u) {
  const id = tgRoute(u);
  const d = id == null ? null : det.get(id);
  if (!d || !sessions.has(id)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: '/mode работает в теме вкладки — оттуда я знаю, какому агенту переключать режим.' });
    return;
  }
  const arg = String(u.text || '').replace(/^\/\S+\s*/, '').trim().toLowerCase();
  const now = tgModeNow(d);
  if (!arg) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)}: режим ${now ? modeTitle(now) : 'не разобрал'}.`
        + '\n\nЧетыре режима, по кругу Shift+Tab:'
        + '\n/mode manual — спрашивает разрешение на всё'
        + '\n/mode edits — правки без спроса, остальное спрашивает'
        + '\n/mode plan — сначала план, без изменений'
        + '\n/mode auto — сам решает; на опасном (git с потерями, удаление, деплой, секреты)'
        + ' всё равно спросит' });
    return;
  }
  const want = TG_MODE_ALIASES[arg];
  if (!want) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Не понял режим. Бывают: manual (спрашивает разрешение), edits (правки без'
        + ' спроса), plan (планирование), auto (сам решает).' });
    return;
  }
  // Переключение — это Shift+Tab в живую сессию, а в режиме компа мост в вкладки не пишет
  // (см. tgDeskHold). Спросить режим без аргумента можно всегда: это чтение.
  if (!tgMirrors()) {
    tgLog(`  режим компа: /mode в вкладку ${id} не печатаю`);
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `🖥 Сворм в режиме компа: в «${tgTabName(id)}» я ничего не печатаю, а режим`
        + ' переключается именно так — Shift+Tab в саму вкладку. Сделай это за компьютером'
        + ' или включи режим телефона.',
      replyMarkup: telegram.actionKeyboard(String(id), ['phone']) });
    return;
  }
  const r = await tgSwitchMode(id, d, want);
  if (r.blocked === 'permission') {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} сейчас держит запрос разрешения, и пока он на экране режим не`
        + ' переключается: Shift+Tab уходит в сам диалог.\n\nОтветь на запрос кнопкой —'
        + ' вариант «Yes, and always allow…» и есть «без спроса» для таких же дальше. А после'
        + ' ответа /mode auto сработает.' });
    return;
  }
  if (r.already) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: `${tgTabName(id)} уже в режиме «${modeTitle(want)}».` });
    return;
  }
  await tgSend({ threadId: u.threadId, replyTo: u.messageId,
    text: r.ok
      ? `${tgTabName(id)}: режим «${modeTitle(want)}».`
        + (want === 'auto' ? ' На опасном (git с потерями, удаление, деплой, секреты) всё'
          + ' равно спросит — настоящая тишина только в bypass.' : '')
      : `Не смог переключить: сейчас ${r.landed ? '«' + modeTitle(r.landed) + '»' : 'режим не видно'}.`
        + ' Возможно, агент занят и строки режима на экране нет — попробуй, когда он ответит,'
        + ' или переключи за компьютером (Shift+Tab).' });
}

// /sync — make the group match the machine. Normally topics keep themselves in step
// (created with a tab, closed with it), but not across every accident: the app was killed
// without closing them, the group was bound before topics existed, someone deleted a
// topic by hand. This is the one command that reconciles both directions on demand.
async function tgSync(threadId) {
  if (!TG.isForum || TG.chatId == null) {
    await tgSend({ threadId, text: 'Группа не привязана.' });
    return;
  }
  await tgEnsureTopics();
  // Обратная сторона: темы, чьих вкладок больше нет. Сносим — /sync означает «пусть в группе
  // будет то же, что на машине», а закрытая тема с замочком остаётся мусором в списке.
  const live = new Set();
  for (const [id, d] of det) if (!d.dead && d.tabKey && sessions.has(id)) live.add(d.tabKey);
  let gone = 0;
  for (const [key, thread] of Object.entries(TG.topics)) {
    if (live.has(key)) continue;
    await tgDeleteTopic(thread);
    gone++;
  }
  const names = [...det].filter(([id, d]) => !d.dead && sessions.has(id)).map(([id]) => tgTabName(id));
  await tgSend({ threadId, text: `Тем под открытые вкладки: ${names.length}`
    + (names.length ? ' — ' + names.join(', ') : '')
    + (gone ? `\nУбрано тем от закрытых вкладок: ${gone}` : '') });
}

// /tabs — what every agent is doing right now, so you can orient from the phone without
// waiting for someone to call you.
//
// Имя вкладки — ССЫЛКОЙ на её тему. Список из одних имён отвечал только на «кто чем занят»:
// дальше человек закрывал чат и искал нужную тему пальцем среди двух десятков, хотя адрес
// у неё есть и мы его знаем. Тап по строке — и ты в теме, где можно сразу писать.
async function tgSendTabs(threadId) {
  const marks = { running: '🟠 работает', waiting: '🟡 ждёт', ready: '🟢 готов' };
  const rich = [];
  const plain = [];
  for (const [id, d] of det) {
    if (d.dead) continue;
    const kind = d.status === 'waiting' && d.waitingKind ? ` (${d.waitingKind === 'permission' ? 'разрешение' : 'вопрос'})` : '';
    const head = `${marks[d.status] || '⚪'}${kind} · `;
    const name = tgTabName(id);
    const link = telegram.topicLink(TG.chatId, tgTopicOf(d));
    plain.push(head + name);
    rich.push(head + (link ? `<a href="${link}">${telegram.escapeHtml(name)}</a>` : telegram.escapeHtml(name)));
  }
  if (!plain.length) { await tgSend({ threadId, text: 'Открытых вкладок нет.' }); return; }
  // Разметка живёт только пока сообщение уходит ЦЕЛИКОМ: chunkText режет по длине и не знает
  // про теги, а разрезанная посередине ссылка — это отказ Telegram и /tabs без ответа. На
  // такой (очень людной) машине отдаём простой список: он хуже, но он приходит.
  const html = rich.join('\n');
  if (html.length <= telegram.MAX_TEXT) { await tgSend({ threadId, parseMode: 'HTML', text: html }); return; }
  await tgSend({ threadId, text: plain.join('\n') });
}

// /usage — расход: контекст и два окна подписки. В теме вкладки отвечаем про неё, в
// общей теме — про все: окна подписки общие на аккаунт, а контекст у каждой свой,
// поэтому «по вкладкам» — это ответ на вопрос «кого пора сжимать».
async function tgUsage(u) {
  const id = tgRoute(u);
  const ids = id != null ? [id] : [...det].filter(([, d]) => !d.dead).map(([sid]) => sid);
  const rows = ids.map((sid) => {
    const d = det.get(sid);
    return {
      name: tgTabName(sid),
      usage: readUsage(d && d.claudeSessionId),
      // Причина важнее прочерка: своя строка статуса в команде запуска — это наш
      // осознанный отказ вмешиваться, а не поломка, и человеку это надо различать.
      why: d && d.claudeSessionId ? 'нет данных: вкладка ещё не отрисовала строку статуса'
        : 'нет данных: это не разговор Claude Code',
    };
  });
  await tgSend({ threadId: u.threadId, text: statusline.usageReport(rows, Math.floor(Date.now() / 1000)) });
}

// /phone и /comp — то же самое, что иконка в строке состояния, только с телефона. Ради
// одного случая, который иначе не лечится: ушёл и забыл переключить. Из приложения ты его
// уже не переключишь — приложение осталось на столе.
// /night — общий ночной режим: мандат сразу всем вкладкам. Отдельной командой, а не третьим
// значением у /phone и /comp: это ответ на другой вопрос («меня не будет»), и снимая его,
// человек хочет увидеть отчёт, а не сообщение о положении дел.
// /night — ночной режим. Адрес выбирает ТЕМА, как у /usage: в теме вкладки это она одна, в
// общей теме — все вкладки разом. Раньше вкладке отдавалась отдельная команда /auto, и слово
// «авто» спорило с режимом разрешений самого Клода («auto mode on», /mode auto): человек
// звал автономию, а получал разговор про разрешения. Команда осталась псевдонимом.
async function tgNightCmd(u) {
  const one = tgRoute(u);
  if (one != null && sessions.has(one)) { await tgNightTab(u, one); return; }
  const on = awayAll();
  const changed = tgSetPresence(on ? 'desk' : night.NIGHT, 'телега');
  if (on) {
    // Вернулся — значит пора читать отчёт. Он уже собран переключателем (nightSwitch).
    await tgSend({ threadId: u.threadId, text: '🙋 Вернулся: ночной режим выключен.' });
    await tgMorning(u);
    return;
  }
  await tgSend({ threadId: u.threadId, text: changed
    ? '🌙 «Меня нет» включено — ночной режим у всех вкладок. Вопросы с вариантами агентам запрещу,'
      + ' прозу подтолкну правилом, разрешения оставлю стоять, лимиты разбужу по сбросу.'
      + ' Отчёт — /morning.'
    : '🌙 «Меня нет» и так включено.' });
}

// Ночной режим ОДНОЙ вкладке — ради того случая, ради которого всё это и переделано: одной
// вкладке отдал задачу на вечер, в остальных сидишь сам.
async function tgNightTab(u, id) {
  const d = det.get(id);
  if (!d) return;
  const on = setTabAuto(id, !d.auto, 'телега');
  await tgSend({ threadId: u.threadId, text: on
    ? `🌙 «${tgTabName(id)}» в ночном режиме: решает обратимое сама, на дорогом остановится и спросит.`
    : `🙋 «${tgTabName(id)}» снова с вами: вопросы будут ждать ответа.` });
}

// /auto — псевдоним для той же вкладки. Держим ради тех, у кого он в пальцах, но в меню бота
// его больше нет: в общей теме он честно отсылает к /night, а не пытается угадать вкладку.
async function tgAutoCmd(u) {
  const id = tgRoute(u);
  if (id == null || !sessions.has(id)) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Теперь это /night: в теме вкладки — ночной режим ей одной, в общей теме — всем сразу.' });
    return;
  }
  await tgNightTab(u, id);
}

// /morning — тот же отчёт, что в окне приложения, только словами: утром смотрят в телефон
// раньше, чем в мак. Собирается на месте, поэтому ответит и посреди ночи — «как дела сейчас».
async function tgMorning(u) {
  const dg = autoAny() ? night.digest(nightEntries(nightFrom), nightTabsNow(), Date.now(), { from: nightFrom })
    : (nightDigestNow || night.digest(nightEntries(nightFrom), nightTabsNow(), Date.now(), { from: nightFrom }));
  await tgSend({ threadId: u.threadId, text: night.digestText(dg) });
}

async function tgWhereAmI(u, presence) {
  const changed = tgSetPresence(presence, 'телега');
  const phone = presence === 'phone';
  const head = phone
    ? (changed ? '📱 Понял, вы с телефоном.' : '📱 Вы и так с телефоном.')
    : (changed ? '🖥 Понял, вы за компом.' : '🖥 Вы и так за компом.');
  const what = phone
    ? 'Вопросы, разрешения и итоги ходов идут сюда, компьютеру спать не даю.'
      + (TG.keepAwake ? '' : ' Сон, правда, выключен галкой в настройках — там его и включать.')
    : 'Молчу и в вкладки ничего не печатаю: сообщение в тему я разверну кнопкой обратно.'
      + ' Смотреть можно всегда — /tabs, /last, /usage.';
  // Пропущенные итоги — самое нужное сразу после «я ушёл»: ходы кончались, пока ты шёл к
  // машине, а в чате о них ни строчки, потому что тебя здесь ещё «не было». Поэтому не
  // отдельной командой по желанию, а сразу и само.
  await tgSend({ threadId: u.threadId, text: `${head} ${what}` });
  if (phone && changed) await tgCatchUp();
}

// Разослать по темам итоги ходов, которые закончились, пока зеркало было выключено.
// Ничего своего не выдумывает: тот же tgNotifyDone, что и в обычной жизни, — а он сам
// молчит про то, что уже отправлял (ключ d.tgSentKey), так что повторов не будет.
async function tgCatchUp() {
  for (const [id, d] of det) {
    if (d.dead || d.status !== 'ready') continue;
    // Пустой отчёт «✅ вкладка — готов.» досылать незачем: человек просил пропущенные
    // ОТВЕТЫ, а вкладка, которой нечего сказать, в этом списке только шум.
    if (!tgLastText(d).text) continue;
    const fresh = transcript.belongsToTurn(d.trReplyAt, d.turnStartedAt);
    try { await tgNotifyDone(id, d, fresh); } catch (e) { reportMainError(e); }
  }
}

// Что вкладка сказала последним — тем же путём, что и обычный итог (tgNotifyDone):
// дословно из стенограммы, а без неё — последним блоком с экрана.
function tgLastText(d) {
  const fromTr = String(d.trFinal || d.trReply || '').trim();
  const scraped = String(lastAgentBlock(replySnapshot(d)) || '').trim();
  return {
    text: fromTr || (scraped.length >= TG_MIN_SCREEN_TEXT ? scraped : ''),
    fromTr: !!fromTr,
  };
}

// /last — что агент сказал последним. Нужна ровно тогда, когда режим переключили ПОСЛЕ
// того, как ход закончился: итог в чат не поехал (тебя тут ещё «не было»), а в терминал
// уже не заглянешь.
//
// Текст берём тем же путём, что и обычный итог (tgNotifyDone): дословно из стенограммы, а
// без неё — последним блоком с экрана. И тем же ключом отмечаем отправку, чтобы штатный
// итог не прислал через минуту то же самое второй раз.
async function tgLastWord(u) {
  const id = tgRoute(u);
  if (id == null) {
    await tgSend({ threadId: u.threadId, replyTo: u.messageId,
      text: 'Это общая тема — не знаю, чей ответ показать. Спроси в теме вкладки (список — /tabs).' });
    return;
  }
  const d = det.get(id);
  if (!d || d.dead) {
    await tgSend({ threadId: u.threadId, text: 'Вкладка этой темы уже закрыта.' });
    return;
  }
  const { text, fromTr } = tgLastText(d);
  if (!text) {
    await tgSend({ threadId: u.threadId, text: `${tgTabName(id)} — сказать пока нечего.` });
    return;
  }
  const working = d.status === 'running';
  tgLog(`  → последний ответ вкладки ${id} по команде: ${text.length} симв.`
    + ` (${fromTr ? 'стенограмма' : 'экран'})`);
  d.tgSentKey = fromTr ? `tr:${d.trReplyAt}` : `screen:${text}`;
  await tgSend({ threadId: u.threadId, rich: true,
    text: `${working ? '⏳' : '✅'} ${tgTabName(id)}${working ? ' (ещё работает)' : ''}\n\n${text}` });
}

// --- IPC: the settings panel ---------------------------------------------------
ipcMain.handle('telegram:state', () => tgState());

ipcMain.handle('telegram:setToken', async (_e, raw) => {
  const token = String(raw == null ? '' : raw).trim();
  if (!telegram.looksLikeToken(token)) {
    tgError = 'Это не похоже на токен: нужен вид 1234567890:AA… из BotFather';
    return tgState();
  }
  TG = Object.assign(tgBlank(), { token });   // a new token means a new bot: unbind
  tgResetRouting();                           // …and its chat's thread/message ids
  try { tgSave(); } catch (e) { tgError = String(e.message || e); return tgState(); }
  await tgConnect();
  return tgState();
});

ipcMain.handle('telegram:forget', async () => {
  tgStop();
  // Бота забывают вместе со всеми настройками моста, а ночной режим в них и живёт (TG.night).
  // Гасим его ЧЕРЕЗ ОБЫЧНУЮ ДВЕРЬ и до того, как настройки обнулятся: иначе таймеры остались бы
  // висеть, а отчёт за эту отлучку не собрался бы вовсе — положение просто испарилось бы.
  if (tgPresence === night.NIGHT) tgSetPresence('desk', 'бота забыли');
  TG = tgBlank();
  tgResetRouting();
  tgBot = ''; tgPair = null; tgError = null; tgCheck = null;
  // Писать стало некуда — выбор «где я» вместе с чатом и уходит: иначе следующая привязка
  // начиналась бы с уже работающего зеркала, которого никто не просил. Ночь к этому моменту
  // уже снята выше (она в этих же настройках и живёт).
  tgPresence = 'desk';
  tgWriteModes();            // и запрет коробки с вариантами снимается вместе с ним
  try { fs.unlinkSync(tgPath()); } catch (_) { /* already gone */ }
  try { fs.unlinkSync(tgLegacyPath()); } catch (_) { /* его может и не быть */ }
  tgApplyKeepAwake();
  return tgState();
});

// Re-run the rights check on demand: the usual fix is «сделать бота админом», and the
// user needs a way to confirm it took without restarting anything.
ipcMain.handle('telegram:check', async () => {
  tgCheck = await tgCheckChat();
  try { tgSave(); } catch (e) { reportMainError(e); }   // isForum may have changed
  // Заодно поднимаем опрос, если он лежит: человек, который жмёт «проверить», хочет, чтобы
  // мост заработал, а не отчёта о том, что он всё ещё стоит.
  if (TG.token && !(tgPoller && tgPoller.alive)) await tgConnect();
  return tgState();
});

// Поднять опрос заново. Фатальная ошибка (401 «не тот токен», 409 «этот токен уже читает
// кто-то другой») гасит цикл НАСОВСЕМ — так и надо, повторы её не лечат. Но выйти из этого
// состояния было можно только перезапуском приложения: tgConnect вызывался лишь на старте и
// при сохранении токена. А 409 получить легко — запустить второй экземпляр или тот же бот на
// втором компьютере, — и мост оставался мёртвым, хотя причина уже устранена.
ipcMain.handle('telegram:reconnect', async () => {
  if (!TG.token) return tgState();
  await tgConnect();
  return tgState();
});

// The «you're answering from a phone» instruction (Telegram panel). Empty → the default.
ipcMain.handle('telegram:setPrompt', (_e, raw) => {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 400);
  TG.prompt = text;
  TG.detailPick = true;                 // выбор сделан руками — переезд больше не нужен
  // Написал свою строку — значит она и в силе. Иначе человек печатает текст, а мост продолжает
  // просить «кратко», и понять это можно только по тому, что ничего не изменилось.
  if (text) TG.detail = 'custom';
  else if (TG.detail === 'custom') TG.detail = 'short';
  tgApplyPrompt();
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// Какими просить агента отвечать в телегу: кратко, полно или своей формулировкой. Три
// положения одного выбора — своя строка не добавка к пресету, а его замена (см. tgApplyPrompt).
// Текст при переключении на пресет НЕ стираем: вернулся к «своей» — вернулась и она.
ipcMain.handle('telegram:setDetail', (_e, raw) => {
  const detail = telegram.DETAILS.includes(raw) ? raw : 'short';
  TG.detail = detail;
  TG.detailPick = true;
  tgApplyPrompt();
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// Пути к whisper.cpp и модели. Пусто в поле бинарника = искать в PATH.
ipcMain.handle('telegram:setWhisper', (_e, { bin, model } = {}) => {
  TG.whisperBin = String(bin || '').trim();
  TG.whisperModel = String(model || '').trim();
  try { tgSave(); } catch (e) { reportMainError(e); }
  return tgState();
});

// Не давать маку уснуть, пока человека нет: с закрытой крышкой ничто не опрашивает телегу,
// и «ответить из такси» тихо перестаёт работать. Выключено = обычное поведение сна.
ipcMain.handle('telegram:setKeepAwake', (_e, on) => {
  TG.keepAwake = !!on;
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgApplyKeepAwake();
  return tgState();
});

// «Где я» — выбор из списка в строке состояния. Не сохраняется на диск (см. tgPresence):
// это положение дел на сегодня, а не настройка.
//
// Журналим каждый переход, и не ради полноты: «почему в телегу поехали итоги всех вкладок» и
// «почему не поехали» разбираются именно по этой строке, а сам выбор следов не оставляет.
const TG_PRESENCE_SAID = {
  desk: 'за компом — в группу не пишу и в вкладки из телеги не печатаю',
  phone: 'за телефоном — вопросы, разрешения и итоги в группу, компьютер не засыпает',
  night: 'ночной режим — сразу у всех вкладок: решают сами по правилу, запрос разрешения ждёт возвращения, потом отчёт',
};

// --- РАБОТА БЕЗ ЧЕЛОВЕКА ------------------------------------------------------
// Мандат «работай без меня». Выдаётся двумя дверями: вкладке отдельно (правый клик по карточке
// или /auto в её теме) и всем сразу — третьим положением «где я»: «ночной режим». Что в силе для
// конкретной вкладки, считает autoOn(); общее положение вкладочных отметок не переписывает.
//
// Решения и тексты — в night.js (там же и почему именно так), здесь проводка: таймеры, печать
// в вкладку, журнал, чтение снимков расхода и сборка отчёта.
//
// Четыре вида остановки, и на каждый свой ответ:
//   • вопрос с вариантами — перехватывает ХУК, до остановки (см. deniesPicker);
//   • вопрос прозой — один толчок в вкладку ночным правилом;
//   • запрос разрешения — стоит до утра (кнопку жать некому, а одобрять чужие команды молча —
//     не то, за что стоит платить спокойным сном);
//   • упёрлась в лимит — будим по времени сброса, оно известно с точностью до секунды.
// И пятый, который не остановка, а порог фазы: «закончил груминг, скажи когда дальше». Его
// нельзя отличить от «всё сделал» по тексту, поэтому вкладку СПРАШИВАЮТ.

// «Меня нет» — общее положение: пока оно включено, мандат есть у всех вкладок.
function awayAll() { return tgPresence === night.NIGHT; }

// Есть ли мандат у ЭТОЙ вкладки. Одно вычисляемое значение на две двери — общую и вкладочную:
// иначе получаются два источника правды, и человек гадает, кто сейчас главный.
function autoOn(d) { return awayAll() || !!(d && d.auto); }

// Работает ли автономно хоть кто-нибудь. Нужно тому, что живёт на уровне приложения: такт,
// чистка журнала, отчёт.
function autoAny() {
  if (awayAll()) return true;
  for (const d of det.values()) if (d.auto && !d.dead) return true;
  return false;
}

// Сколько вкладок сейчас работает без человека — для журнала и для строки состояния.
function autoCount() {
  if (awayAll()) return det.size;
  let n = 0;
  for (const d of det.values()) if (d.auto && !d.dead) n++;
  return n;
}
function nightPath() { return path.join(app.getPath('userData'), 'night.jsonl'); }
function nightDigestPath() { return path.join(app.getPath('userData'), 'night-digest.json'); }

// Разговаривает ли перезапуск с агентом ПРЯМО СЕЙЧАС. Печатать в вкладку в это время нельзя:
// он сам печатает туда просьбу и `/exit`, и наш текст, приехавший посреди, попадёт в ту же
// строку ввода. Два писателя в одну строку — мусор вместо просьбы и потерянный перезапуск.
//
// Занятость — это ровно две фазы, `asked` и `exiting`. Остальные — покой, и путать их с
// разговором нельзя: `muted` (агент трижды не ответил) и `granted` под непрочитанным ждут
// СУТКАМИ — у второй часы разрешения намеренно остановлены до человеческих глаз, а ночью глаз
// нет. Считай мы их занятостью, вкладка, однажды заслужившая такую фазу, до утра не получила
// бы ни толчка, ни вопроса, ни будильника по лимиту.
const NIGHT_RS_BUSY = ['asked', 'exiting'];

function nightBusyWithRestart(d) {
  return !!(d && d.rs && NIGHT_RS_BUSY.includes(d.rs.phase));
}

// С какого мига идёт отлучка: по этой границе отчёт отбирает записи журнала. Ноль — все вкладки
// сейчас с человеком, отчёт закрыт.
let nightFrom = 0;
// Последняя собранная сводка. Её показывает значок в нижней панели и она же переживает
// перезапуск приложения — иначе утреннее обновление съедало бы отчёт за ночь.
let nightDigestNow = null;
// Человек печатал за клавиатурой, пока ночь ещё включена. Ночь выключается руками, значит
// «забыл снять» — самый вероятный промах, и молчать про него нельзя: агенты продолжают
// решать за человека, который уже сидит рядом.
let nightTyped = false;

const NIGHT_TICK_MS = 20_000;
// Сколько ждём ответа на вопрос про порог фазы, прежде чем записать, чем он кончился.
// Ответ — не слово, а поведение: работает дальше или снова замолчала.
const NIGHT_RESOLVE_MS = 120_000;
// Потолок будильников по лимиту за ночь. Первый сброс может оказаться не тем окном, которое
// упёрлось (недельное отпускает через дни), и вкладка встанет снова — но бесконечно ловить
// стену тоже нельзя.
const NIGHT_MAX_WAKES = 3;
const NIGHT_JOURNAL_TTL_MS = 7 * 24 * 3600 * 1000;

function nightSt(d) {
  if (!d.ni) {
    d.ni = {
      nudges: 0, nudgedKeys: [], continues: 0, wakes: 0,
      nudgeTimer: null, wakeTimer: null,
      readyAt: 0, askedAt: 0, askedTurn: 0, asks: 0, resolvedAt: 0,
      // limitAt — когда увидели стену, wokeUntil — по какому сбросу уже будили. Второе нужно
      // потому, что сообщение о лимите остаётся на экране и ПОСЛЕ подъёма: без него ночь
      // ловила бы одну и ту же строку по кругу и печатала в работающую вкладку.
      limitAt: 0, wokeUntil: 0, limitMute: false, resetMute: false,
      stoodKey: '', stoodPhase: '',
    };
  }
  return d.ni;
}

// Ночь кончилась (или вкладка умерла) — снимаем всё запланированное. Иначе толчок, заведённый
// в три часа, приезжает в вкладку, за которой уже сидит человек.
function nightClear(d) {
  const st = d && d.ni;
  if (!st) return;
  if (st.nudgeTimer) { clearTimeout(st.nudgeTimer); st.nudgeTimer = null; }
  if (st.wakeTimer) { clearTimeout(st.wakeTimer); st.wakeTimer = null; }
}

function nightReset(d) {
  nightClear(d);
  if (d) d.ni = null;
}

// Строка в журнал. Пишет и приложение, и хук (тот — дословные развилки, единственное место,
// где они видны целиком). Имя вкладки кладём сразу: к утру она может закрыться, а сводка без
// имён нечитаема.
function nightLog(kind, id, d, extra) {
  try {
    const e = night.entry(kind, tgTabName(id), Object.assign(
      { id: String(id), session: (d && d.claudeSessionId) || '' }, extra || {}));
    fs.appendFileSync(nightPath(), night.line(e));
  } catch (e) { reportMainError(e); }
}

// Печать в вкладку от лица сворма. Тот же путь, которым доезжает сообщение из телеграма
// (telegram.inputWrites + Enter отдельным чтением stdin), и та же отметка «ответили», без
// которой экранный детект снова поднял бы «ждёт» на висящей строке зова.
//
// Пометку «человек этого не видел» (unread.js) НЕ трогаем осознанно: человек ничего не
// прочитал, он спит. Снять её — значит соврать про прочтение и отпустить перезапуск.
function nightType(id, text) {
  const p = sessions.get(id);
  if (!p) return false;
  const [body, enter] = telegram.inputWrites(text);
  if (!body) return false;
  ptyType(id, body);
  setTimeout(() => ptyType(id, enter), TG_ENTER_DELAY_MS);
  const d = det.get(id);
  if (d) markAnswered(d, Date.now());
  return true;
}

// Метка, которую ночь называет агенту. Это ТЕГ, а не первая фраза из настроек: тег зашит
// в протокол и понимается всегда, а фраза у человека может быть своя — и тогда ночной текст
// учил бы одному, а хук искал бы другое.
function nightMarker() {
  return ASK_TAG;
}

// Отпечаток вопроса, на который мы толкали. Не хеш, а начало текста: журнал читают глазами,
// и «толкали вот по этому вопросу» должно быть видно без расшифровки.
function nightKey(d) {
  return night.short(d.question || '', 120);
}

// Вкладка встала и ждёт. Зовётся из такта статуса на каждой перемене ожидания, поэтому вся
// защита от повторов — внутри (night.nudgeDecision) и в таймере.
function nightOnWaiting(id, d) {
  if (!d || d.dead || !autoOn(d)) return;
  if (nightBusyWithRestart(d)) return;
  const st = nightSt(d);
  if (st.nudgeTimer) return;
  const key = nightKey(d);
  const dec = night.nudgeDecision(st, {
    auto: autoOn(d),
    kind: d.waitingKind,
    box: !!d.waitingBox,
    now: Date.now(),
    bootAt: BOOT_AT,
    startedAt: d.startedAt,
    fingerprint: key,
  });
  if (dec.act === 'stand') {
    // Про одно и то же ожидание пишем один раз: такт зовёт эту функцию, пока вкладка ждёт.
    const mark = dec.why + '|' + key;
    if (st.stoodKey !== mark) {
      st.stoodKey = mark;
      nightLog('stand', id, d, { why: dec.why, text: night.short(d.question, 300) });
    }
    return;
  }
  if (dec.act !== 'nudge') return;
  st.nudgeTimer = setTimeout(() => {
    st.nudgeTimer = null;
    // За эти секунды всё могло измениться: человек ответил за клавиатурой, ночь сняли,
    // агент сам открыл рамку. Проверяем заново — таймер решает не он, а мы сейчас.
    if (!autoOn(d) || d.dead || d.status !== 'waiting' || d.waitingBox) return;
    if (nightBusyWithRestart(d)) return;
    st.nudges++;
    st.nudgedKeys.push(key);
    if (st.nudgedKeys.length > 8) st.nudgedKeys.shift();
    st.stoodKey = '';
    nightType(id, night.ruleText(TG.nightRule, nightMarker()));
    nightLog('nudge', id, d, { text: night.short(d.question, 300) });
    tgLog(`авто: толчок в вкладку ${id} (${st.nudges}/${night.MAX_NUDGES})`);
  }, night.NUDGE_DELAY_MS);
}

function nightCancelWaiting(d) {
  const st = d && d.ni;
  if (!st) return;
  if (st.nudgeTimer) { clearTimeout(st.nudgeTimer); st.nudgeTimer = null; }
  st.stoodKey = '';
}

// Упёрлись в стену лимита. Время сброса берём из снимка расхода — там оно абсолютное и
// точное, а на экране его пришлось бы разбирать вместе с часовым поясом.
//
// Какое окно упёрлось, снимок прямо не говорит; берём то, где расход больше. Ошибиться не
// страшно: вкладка встанет снова, признак вернётся, и будильник заведётся заново — на это и
// нужен потолок NIGHT_MAX_WAKES.
function nightOnLimit(id, d) {
  const st = nightSt(d);
  if (st.wakeTimer) return;
  const u = readUsage(d.claudeSessionId);
  const five = u && u.five;
  const seven = u && u.seven;
  const worst = (five && seven)
    ? ((five.spent || 0) >= (seven.spent || 0) ? five : seven)
    : (five || seven);
  const untilMs = worst && Number.isFinite(worst.resetsAt) ? worst.resetsAt * 1000 : 0;
  // Та же стена, которую мы уже обработали: сообщение о лимите с экрана не исчезает, а такт
  // приходит каждые двадцать секунд. Отметку ставим ЗДЕСЬ, до всякой записи в журнал, — иначе
  // одна стена давала строку в журнал (и строку в утренней сводке) три раза в минуту до утра.
  // Новая стена отличается временем сброса: оно уходит вперёд.
  if (untilMs && untilMs <= st.wokeUntil) return;
  // Время сброса неизвестно (снимка расхода нет — вкладка не рисовала строку статуса). Будить
  // нечем, поэтому только записываем, и ровно один раз.
  if (!untilMs) {
    if (st.limitMute) return;
    st.limitMute = true;
    st.limitAt = Date.now();
    nightLog('limit', id, d, { until: null });
    tgLog(`авто: вкладка ${id} упёрлась в лимит (время сброса неизвестно — не бужу)`);
    return;
  }
  st.wokeUntil = untilMs;
  st.limitAt = Date.now();
  nightLog('limit', id, d, { until: untilMs });
  tgLog(`авто: вкладка ${id} упёрлась в лимит, сброс ${night.clock(untilMs)}`);
  if (st.wakes >= NIGHT_MAX_WAKES) return;
  const delay = untilMs + night.WAKE_LAG_MS - Date.now();
  // Сброс уже прошёл (снимок старый) — будим сразу, но не мгновенно: пусть вкладка успеет
  // дорисовать свой экран.
  const wait = Math.max(5_000, Math.min(delay, 8 * 3600_000));
  st.wakeTimer = setTimeout(() => {
    st.wakeTimer = null;
    if (!autoOn(d) || d.dead || nightBusyWithRestart(d)) return;
    // Будим только ПРОСТАИВАЮЩУЮ вкладку. За часы ожидания всё могло измениться: стена оказалась
    // ложной (строка про лимит в чужом выводе), агент поднялся сам, человек дал ему работу. Наше
    // «продолжай», напечатанное в середину живого хода, — тот же мусор в строке ввода, от
    // которого мы уворачиваемся у перезапуска.
    if (d.status !== 'ready' || d.bg) {
      tgLog(`авто: сброс лимита у вкладки ${id} — но она уже работает, не трогаю`);
      return;
    }
    st.wakes++;
    st.limitAt = 0;
    nightType(id, night.wakeWord());
    nightLog('wake', id, d, {});
    tgLog(`авто: разбудил вкладку ${id} после сброса лимита`);
  }, wait);
}

// Окно открылось само, и Клод ждёт одного нажатия: «Your usage limit has reset · press enter
// to continue». Будильник тут ни при чём — сброс уже случился, ждать нечего, — но и вкладка
// сама не тронется. Днём на клавишу нажимает человек, ночью нажимаем мы.
//
// Считается тем же потолком, что и подъём после стены: три касания за ночь на вкладку, дальше
// пусть стоит. Отметка resetMute снимается, когда вкладка снова заработала, — сообщение с
// экрана никуда не девается, и без отметки мы печатали бы в неё каждые двадцать секунд.
function nightOnLimitReset(id, d) {
  const st = nightSt(d);
  if (st.resetMute) return;
  st.resetMute = true;
  if (st.wakes >= NIGHT_MAX_WAKES) {
    tgLog(`авто: у вкладки ${id} сбросился лимит, но потолок подъёмов исчерпан`);
    return;
  }
  st.wakes++;
  st.limitAt = 0;
  nightType(id, night.wakeWord());
  nightLog('wake', id, d, {});
  tgLog(`авто: вкладка ${id} дождалась сброса лимита — нажал за неё`);
}

// Вопрос про порог фазы: вкладка простаивает, а работа могла и не кончиться.
function nightAskPhase(id, d) {
  const st = nightSt(d);
  st.askedAt = Date.now();
  st.asks = (st.asks || 0) + 1;
  st.askedTurn = d.turnStartedAt || st.askedAt;
  nightType(id, night.askText(TG.nightAsk, nightMarker()));
  nightLog('phase-ask', id, d, {});
  tgLog(`авто: спросил вкладку ${id} про порог фазы`);
}

// Чем кончился наш вопрос. Ответ читаем поведением, а не словами: работает дальше — значит
// пошла вторая фаза; снова молчит — значит работа правда кончилась; встала с вопросом —
// запишет ветка ожидания.
function nightResolvePhase(id, d, now) {
  const st = nightSt(d);
  if (!st.askedAt || now - st.askedAt < NIGHT_RESOLVE_MS) return;
  st.askedAt = 0;
  // С этого мига считаем работу заново: следующий вопрос вкладка получит только если ход
  // кончится ПОСЛЕ разбора. Иначе её собственный ответ нам и был бы тем «новым простоем», из
  // которого рождался следующий вопрос — круг на всю ночь (см. night.phaseDecision).
  st.resolvedAt = now;
  const text = night.short(d.trFinal || d.trText || '', 300);
  if (d.status === 'running') {
    st.continues++;
    nightLog('continue', id, d, { n: st.continues, text, at: now });
    tgLog(`авто: вкладка ${id} продолжила сама (${st.continues}/${night.MAX_CONTINUES})`);
  } else if (d.status === 'ready') {
    // Молчит. Это может быть и «всё сделано», и «сделал очередной шаг и снова жду» — по одному
    // взгляду на статус их не различить, поэтому запирающей отметки здесь НЕТ: вкладку ограничит
    // потолок вопросов, а не наша догадка о смысле её молчания.
    nightLog('done', id, d, { text, at: now });
  }
}

// Ночной такт. Отдельно от такта статуса (тот бежит раз в 300 мс на вкладку): всё ночное
// живёт в масштабе минут, а снимок экрана ради поиска стены лимита незачем брать триста раз
// в минуту.
setInterval(() => {
  if (!autoAny()) return;
  const now = Date.now();
  for (const [id, d] of det) {
    if (d.dead || !autoOn(d)) continue;
    try {
      const st = nightSt(d);
      if (nightBusyWithRestart(d)) continue;
      // Стена лимита. Ищем и у «готовой» вкладки, и у ждущей: сообщение остаётся на экране, а
      // ход при этом кончился — со стороны это ровно «готов».
      if (!st.wakeTimer && (d.status === 'ready' || d.status === 'waiting')) {
        const snap = snapshot(d);
        // Сообщение о сбросе разбираем ПЕРЕД стеной: на экране они уживаются (стена осталась
        // выше, сброс пришёл ниже), а значат противоположное — «жди ещё» и «жать прямо сейчас».
        if (limitReset(snap)) nightOnLimitReset(id, d);
        else if (limitHit(snap)) nightOnLimit(id, d);
      }
      // Ждущую вкладку разбираем и ЗДЕСЬ, а не только на перемене статуса. Такт статуса зовёт
      // nightOnWaiting по событию — «что-то в вкладке изменилось», — а вкладка, стоящая на
      // вопросе, ничего не меняет: вывода нет, статус тот же, текст тот же. Из этого выходил
      // ровно тот провал, ради которого функция и написана: включаешь ночь в час, три вкладки
      // УЖЕ стоят на вопросах — и стоят до утра, потому что события больше не будет. Тем же
      // лечится и отложенное: не прошёл прогрев, не было текста вопроса, была открыта рамка —
      // раньше такой отказ становился вечным, теперь через двадцать секунд решаем заново.
      if (d.status === 'waiting') nightOnWaiting(id, d);
      nightResolvePhase(id, d, now);
      // Вкладка снова работает — значит стена лимита, если она была, кончилась сама.
      if (d.status === 'running') { st.limitMute = false; st.resetMute = false; }
      // Сколько вкладка простаивает. Считаем здесь, а не в такте статуса: там это лишнее поле
      // в горячем цикле, а здесь — две строчки раз в двадцать секунд.
      if (d.status === 'ready' && !d.bg) { if (!st.readyAt) st.readyAt = now; }
      else st.readyAt = 0;
      if (st.askedAt) continue;               // ждём, чем кончится прошлый вопрос
      const dec = night.phaseDecision(st, {
        auto: autoOn(d), status: d.status, bg: d.bg, limited: !!st.wakeTimer,
        now, bootAt: BOOT_AT, startedAt: d.startedAt, readyAt: st.readyAt,
        workedAt: d.turnEndedAt || 0, turn: d.turnStartedAt || 0,
      });
      if (dec.act === 'ask') nightAskPhase(id, d);
      // Свой ключ, а не общий со ожиданием: иначе две ветки затирали бы друг другу отметку и
      // «не трогали» попадало бы в сводку дважды.
      else if (dec.act === 'stand' && st.stoodPhase !== dec.why) {
        st.stoodPhase = dec.why;
        nightLog('stand', id, d, { why: dec.why });
      }
    } catch (e) { reportMainError(e); }
  }
}, NIGHT_TICK_MS);

// --- утренняя сводка ----------------------------------------------------------
// Список дел на утро, а не журнал: журнал у нас уже есть. Порядок групп и тексты — в
// night.js digest, здесь только материал: записи за ночь и то, как вкладки выглядят сейчас.
function nightEntries(from) {
  let entries = [];
  try { entries = night.parse(fs.readFileSync(nightPath(), 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (from && e.at < from) continue;
    // Записи хука знают только id разговора Клода: имя вкладки ему негде взять. Подставляем
    // здесь — иначе половина сводки была бы без имён.
    if (!e.tab && e.session) {
      for (const [id, d] of det) {
        if (d.claudeSessionId === e.session) { e.tab = tgTabName(id); e.id = String(id); break; }
      }
    }
    out.push(e);
  }
  return out;
}

function nightTabsNow() {
  const out = [];
  for (const [id, d] of det) {
    if (d.dead) continue;
    out.push({
      id, name: tgTabName(id), status: d.status, waitingKind: d.waitingKind,
      question: d.question || '', since: d.waitSince || 0,
      // Отдавали ли эту вкладку за время отлучки. Не `autoOn(d)`: мандат мог быть снят посреди
      // окна («забрал вкладку себе»), а рассказать про то, что она успела сделать сама, всё
      // равно надо. Отметка живёт до конца окна (autoAfterChange) и переживает возврат вкладки,
      // но не перезапуск приложения — тогда вкладку в отчёт вернут её записи в журнале.
      auto: autoOn(d) || !!d.autoSeen,
    });
  }
  return out;
}

function nightBuildDigest(now) {
  const from = nightFrom || 0;
  const dg = night.digest(nightEntries(from), nightTabsNow(), now || Date.now(), { from });
  nightDigestNow = dg;
  try {
    let store = { digests: [] };
    try { store = JSON.parse(fs.readFileSync(nightDigestPath(), 'utf8')) || store; } catch (_) { /* первая отлучка */ }
    if (!Array.isArray(store.digests)) store.digests = [];
    store.digests.push(dg);
    // Семь последних ночей: дольше эти числа ни о чём не говорят, а материал всё равно лежит
    // в журнале.
    while (store.digests.length > 7) store.digests.shift();
    fs.writeFileSync(nightDigestPath(), JSON.stringify(store));
  } catch (e) { reportMainError(e); }
  return dg;
}

function nightState() {
  return {
    // `on` — общий ночной режим. Вкладочные мандаты в это поле НЕ сводятся: окну нужно знать
    // именно про общее (им красится панель и им объясняется гейт ввода), а про каждую вкладку
    // рендерер знает сам — он же их и переключает.
    on: awayAll(),
    from: nightFrom,
    typed: nightTyped,
    digest: nightDigestNow,
    // Свои формулировки и заготовки рядом. Заготовку отдаём готовой строкой, а не просим
    // рендерер собрать её сам: текст один на приложение, хук и подсказку в настройках.
    //
    // Заготовки — БЕЗ строки про метку: её сворм дописывает сам к любому тексту (night.protocol),
    // и класть её в поле значило бы снова отдать человеку на попечение то, за чем следит сворм.
    // Саму строку отдаём отдельно — настройкам её показывать, а не прятать.
    rule: TG.nightRule || '',
    ask: TG.nightAsk || '',
    ruleDefault: night.ruleBody(),
    askDefault: night.askBody(),
    protocol: night.protocol(nightMarker()),
    tag: nightMarker(),
  };
}

function nightPush() { safeSend('night:state', nightState()); }

// Мандат вкладке — ОДНА дверь для всех, кто его выдаёт: меню карточки, чат, восстановление
// вкладок при запуске. Возвращает то, что стало в силе.
function setTabAuto(id, on, from) {
  const key = String(id == null ? '' : id);
  const d = det.get(key);
  if (!d) return false;
  const next = !!on;
  if (d.auto === next) return next;
  const wasAny = autoAny();
  d.auto = next;
  // Свежий мандат — свежие счётчики: толчок, вопросы про фазу и подъёмы по лимиту считаются с
  // этого мига, а не с прошлого вечера. Снятый — снимаем и всё запланированное, иначе толчок,
  // заведённый минуту назад, приедет в вкладку, которую человек только что забрал себе.
  if (next) nightReset(d); else nightClear(d);
  // «Эту вкладку отдавали» — до конца окна отчёта. Снимать вместе с мандатом нельзя: человек
  // забирает вкладку себе, а то, что она сделала сама, из отчёта пропадать не должно.
  if (next) d.autoSeen = true;
  tgLog(`мандат (${from || '—'}): вкладка ${key} ${next ? 'работает без человека' : 'снова с человеком'}`);
  tgWriteModes();
  autoAfterChange(wasAny);
  safeSend('tab:auto', { id: key, auto: next });
  nightPush();
  return next;
}

// Мандатов стало больше или меньше — а от этого зависит окно отчёта. Начало ставим на ПЕРВЫЙ
// мандат, а собираем отчёт, когда не осталось ни одного: «что было без меня» имеет смысл
// именно как рассказ вернувшемуся, и пока хоть одна вкладка работает сама, рассказ не кончен.
function autoAfterChange(wasAny) {
  const nowAny = autoAny();
  if (nowAny && !nightFrom) {
    nightFrom = Date.now();
    nightTyped = false;
    // Прошлый отчёт здесь НЕ стираем, хотя соблазн есть («новая отлучка — старое неактуально»).
    // Стирал он не то, что задумано: при запуске приложения восстановленная отданная вкладка
    // открывает новое окно отчёта, и непрочитанный отчёт за прошлую ночь гас у человека на
    // глазах — а в файле оставался непрочитанным и всплывал на следующем запуске снова. Новый
    // отчёт всё равно заменит старый, когда окно закроется (nightBuildDigest).
  }
  if (!nowAny && wasAny) {
    nightBuildDigest(Date.now());
    // Отчёт собран — отметки «эту отдавали» больше ни о чём: следующая отлучка своя.
    for (const d of det.values()) d.autoSeen = false;
    nightFrom = 0;                      // следующая отлучка начнёт своё окно
    nightTyped = false;
  }
  // Окно отчёта переживает перезапуск приложения: мандат вкладки тоже переживает (persistTabs),
  // и без этой записи отчёт считался бы с мига восстановления.
  if (TG.nightFrom !== nightFrom) {
    TG.nightFrom = nightFrom;
    try { tgSave(); } catch (e) { reportMainError(e); }
  }
}

// Общий ночной режим включили / выключили. Зовётся из tgSetPresence — единственной двери к
// положению «где я». Вкладочные мандаты оно НЕ переписывает: включённое поднимает мандат всем
// сразу, снятое возвращает каждую вкладку к её собственному выбору. Иначе выходили два
// источника правды — общий переключатель молча стирал бы то, что человек отметил на карточке.
function nightSwitch(prev, next) {
  const wasAny = prev === night.NIGHT || autoCount() > 0;
  if (next === night.NIGHT) {
    // Счётчики обнуляем только тем, у кого мандата НЕ было: вкладке, которая работает сама уже
    // час, общий ночной режим ничего нового не выдаёт, а сброс её состояния забыл бы и стену
    // лимита (журнал получил бы вторую запись про ту же), и то, что правило ей уже говорили.
    for (const d of det.values()) if (!d.auto) nightReset(d);
    // Общее положение отдаёт все вкладки сразу — значит все они и попадут в отчёт, включая те,
    // что родятся позже: у них мандат считается живым (autoOn), отметка им не нужна.
    for (const d of det.values()) d.autoSeen = true;
    autoAfterChange(wasAny);
    tgLog(`ночной режим: включён, вкладок ${det.size}`);
  } else if (prev === night.NIGHT) {
    // Вкладкам со своим мандатом ничего не отменяем — они продолжают работать сами.
    for (const d of det.values()) if (!autoOn(d)) nightClear(d);
    autoAfterChange(wasAny);
    const left = autoCount();
    tgLog(left
      ? `ночной режим: выключен, но ${left} вкладок остались в нём — отчёт позже`
      : 'ночной режим: выключен, отчёт собран');
  }
  nightPush();
}

// Человек сел за клавиатуру, а ночной режим ещё включён. Второй эшелон: первым стоит граница
// владения в окне (typeInto) — она перехватывает клавишу ДО того, как та уедет агенту, и
// предлагает вернуться. Сюда доезжает ввод, который гейт пропустил, — и один раз за отлучку
// напоминаем в панели: агенты продолжают решать за человека, который уже сидит рядом.
function nightOnKeyboard() {
  if (!awayAll() || nightTyped) return;
  nightTyped = true;
  tgLog('авто: печатают за клавиатурой, а ночной режим не выключен');
  nightPush();
}

// Чистка журнала: перечитать и переписать целиком. Только когда ночи НЕТ — во время ночи в этот
// файл дописывают хуки всех вкладок, и перезапись потеряла бы строку, легшую между чтением и
// записью. Зовётся на старте, где ночь ещё не восстановлена (tgLoad идёт позже).
function pruneNight() {
  if (autoAny()) return;
  try {
    const cut = Date.now() - NIGHT_JOURNAL_TTL_MS;
    const entries = night.parse(fs.readFileSync(nightPath(), 'utf8')).filter((e) => e.at >= cut);
    fs.writeFileSync(nightPath(), entries.map(night.line).join(''));
  } catch (_) { /* нет журнала — нечего чистить */ }
}

function nightLoadDigest() {
  try {
    const store = JSON.parse(fs.readFileSync(nightDigestPath(), 'utf8'));
    const list = Array.isArray(store && store.digests) ? store.digests : [];
    const last = list[list.length - 1] || null;
    // Прочитанную сводку не поднимаем. Иначе значок «утро — 2 стоят» возвращался бы с каждым
    // запуском приложения и звал разбираться с ночью, которая была позавчера.
    nightDigestNow = last && !last.read ? last : null;
  } catch (_) { nightDigestNow = null; }
}

// Отметка «прочитал» — в файл, а не только в память. Сам отчёт остаётся: перечитать вчерашнее
// утро человек вправе, а вот звать его второй раз незачем.
function nightMarkRead() {
  try {
    const store = JSON.parse(fs.readFileSync(nightDigestPath(), 'utf8'));
    const list = Array.isArray(store && store.digests) ? store.digests : [];
    if (!list.length) return;
    list[list.length - 1].read = true;
    fs.writeFileSync(nightDigestPath(), JSON.stringify(store));
  } catch (_) { /* нет файла — нечего отмечать */ }
}

ipcMain.handle('night:state', () => nightState());
// Сводку прочитали — значок гаснет, и гаснет насовсем (см. nightMarkRead).
// Свои формулировки ночи. Пусто — заготовка: пустое поле здесь честнее кнопки «сбросить»,
// потому что не оставляет третьего состояния «своё, но пустое».
// Мандат вкладке из окна: меню карточки и кнопка «забрать себе» в гейте ввода.
ipcMain.handle('tab:setAuto', (_e, { id, auto } = {}) => setTabAuto(id, auto, 'окно'));

// Меню карточки. Родное меню системы, а не своё: правый клик по карточке — ожидаемый жест, и
// рисовать под него собственный попап значило бы заводить вторую машинерию меню ради одного
// пункта.
ipcMain.handle('tab:menu', (_e, { id } = {}) => {
  const key = String(id == null ? '' : id);
  const d = det.get(key);
  if (!d || !win) return false;
  const items = [{
    label: 'Ночной режим',
    type: 'checkbox',
    checked: !!d.auto,
    click: () => setTabAuto(key, !d.auto, 'меню карточки'),
  }];
  // Пока включён общий ночной режим, галочка вкладки в силу не вступает — но переключать её
  // можно: человек отмечает, с чем он хочет остаться, когда вернётся. Молчать об этом нельзя,
  // иначе галочка выглядит сломанной.
  if (awayAll()) items.push({ type: 'separator' }, { label: 'Сейчас в силе общий ночной режим', enabled: false });
  Menu.buildFromTemplate(items).popup({ window: win });
  return true;
});

ipcMain.handle('night:setTexts', (_e, raw) => {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 1200);
  const t = raw || {};
  if (t.rule !== undefined) TG.nightRule = clean(t.rule);
  if (t.ask !== undefined) TG.nightAsk = clean(t.ask);
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgWriteModes();                 // правило нужно и хуку, он читает файл рядом с собой
  return nightState();
});

ipcMain.handle('night:dismiss', () => {
  nightDigestNow = null;
  nightMarkRead();
  nightPush();
  return nightState();
});

// Одна дверь для обоих способов переключиться — иконкой в приложении и командой из телеги.
// Возвращает, изменилось ли положение: телега на этом отвечает по-разному («включил» против
// «и так уже»), а врать про переключение, которого не было, — сбивать с толку в дороге.
function tgSetPresence(raw, from) {
  const next = TG_PRESENCE.includes(raw) ? raw : 'desk';
  if (next === tgPresence) return false;
  const prev = tgPresence;
  tgPresence = next;
  tgLog(`где я (${from}): ${TG_PRESENCE_SAID[next]}`);
  // Ночь — единственное положение, которое ПЕРЕЖИВАЕТ выключение приложения (см. tgLoad).
  // Остальные два начинаются заново «за компом», и это осознанно; но ночь, слетевшая в три
  // часа от автообновления, — это остаток ночи со стоящими вкладками.
  TG.night = next === night.NIGHT;
  // Начало окна отчёта (TG.nightFrom) ведёт и сохраняет autoAfterChange — оно единственное
  // знает про вкладочные мандаты. Прежде эта строка стояла ЗДЕСЬ и ставила «сейчас» на каждое
  // включение, то есть затирала окно, начатое мандатом одной вкладки часом раньше. Сводка
  // отбирает записи журнала по этой границе, и перезапуск посреди ночи иначе обрезал бы отчёт
  // до «с момента обновления».
  nightSwitch(prev, next);
  try { tgSave(); } catch (e) { reportMainError(e); }
  // Хук читает это с диска (см. tgWriteModes): пока человек за телефоном, агент не открывает
  // вопрос с вариантами, а спрашивает прозой — на неё с телефона можно ответить.
  tgWriteModes();
  tgApplyKeepAwake();
  tgPush();             // иконка в строке состояния рисуется по этому же состоянию
  // Дверь открылась — отпускаем то, что в неё стучалось (см. tgDeskHold). Здесь, а не в
  // обработчиках: переключить режим можно и командой, и кнопкой, и иконкой в приложении, и
  // забыть про задержанный текст в одном из трёх мест — значит потерять его молча.
  if (next === 'phone') setTimeout(() => { tgFlushHeld().catch(reportMainError); }, TG_FLUSH_DELAY_MS);
  return true;
}

ipcMain.handle('telegram:setPresence', (_e, raw) => {
  tgSetPresence(raw, 'приложение');
  return tgState();
});

ipcMain.handle('telegram:unpair', async () => {
  TG.chatId = null; TG.isForum = false; TG.topics = {}; tgCheck = null;
  // Зеркалить стало некуда — «за телефоном» теряет смысл. А ночь бота не требует вовсе, и
  // гасить её отвязкой группы значило бы посреди ночи вернуть всем вкладкам обычные рамки.
  if (tgPresence === 'phone') tgPresence = 'desk';
  tgWriteModes();
  tgResetRouting();
  try { tgSave(); } catch (e) { reportMainError(e); }
  tgApplyKeepAwake();
  return tgState();
});

// Open a pairing window and hand back the code, the deep links and a QR of the private
// one. crypto.randomInt, not Math.random: this code is the only thing standing between
// a stranger who found the bot and a chat bound to your machine.
ipcMain.handle('telegram:pair', () => {
  if (!TG.token || !tgBot) return { error: 'Сначала подключи бота' };
  tgPair = { code: telegram.pairCode((n) => crypto.randomInt(n)), at: Date.now() };
  // The QR carries the ?startgroup= link, because a group is the only thing we bind to:
  // scanning it offers to add the bot to a group and delivers the code from there.
  const groupLink = telegram.deepLink(tgBot, tgPair.code, { group: true });
  const state = tgState();
  tgPush();
  return {
    code: tgPair.code,
    link: groupLink,
    qr: tgQr(groupLink),
    ttlMs: TG_PAIR_TTL_MS,
    state,
  };
});

// Window/taskbar chrome icon. nativeImage.createFromPath does NOT work for paths
// inside app.asar — read the bytes and build an image (fs CAN read asar).
function loadWindowIcon() {
  const iconFile = path.join(__dirname, 'build', 'icon.png');
  try {
    if (!fs.existsSync(iconFile)) return undefined;
    const img = nativeImage.createFromBuffer(fs.readFileSync(iconFile));
    return img.isEmpty() ? undefined : img;
  } catch (_) {
    return undefined;
  }
}

function createWindow() {
  // Разрешение на закрытие — одноразовое, и сбросить его надо здесь. Диалог ниже ставит
  // allowClose, чтобы пропустить сам себя, и на этом его жизнь кончалась: на маке закрытое
  // окно приложение не убивает (window-all-closed), клик по иконке в доке поднимает новое —
  // а флаг с прошлого раза оставался поднятым. Следующее закрытие тогда проходило молча и
  // уносило всех живых агентов, то есть ровно то, ради чего диалог и написан.
  allowClose = false;
  const icon = loadWindowIcon();
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    backgroundColor: '#0d0f12',
    ...(icon ? { icon } : {}),
    // Frameless-with-traffic-lights is a macOS affordance. On Windows/Linux we
    // keep the native window frame (min/max/close), so only opt in on darwin.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false, // security baseline; all Node work is here in main
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Если загрузчик не смог запустить скачанное обновление и откатился на код из
  // установленного приложения, человек должен об этом узнать: иначе он видит старую
  // версию там, где ждал новую, и считает, что обновление просто не работает.
  // Ждём готовности окна — до неё лог ошибок ещё некому принять (см. bootstrap.js).
  win.webContents.once('did-finish-load', () => {
    const boot = global.SWARM_BOOT;
    if (boot && boot.kind === 'bundle' && /не запустилось/.test(boot.reason || '')) {
      reportMainError(new Error(boot.reason));
    }
  });

  // Harden against accidental navigation. If a file is dropped anywhere on the
  // window that the renderer didn't preventDefault (e.g. onto the terminal/stage,
  // not the tab strip), Chromium navigates the webContents to that file:// URL and
  // renders its source as plain text — that's how the window could suddenly show
  // preload.js instead of the UI. We only ever load index.html, so block any
  // navigation and any window-open outright.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Confirm before the window closes — closing it kills every `claude` child
  // (see the 'closed' handler), so an accidental ⌘Q / red-button click would drop
  // live agents. Native sync dialog: simplest reliable gate in the main process.
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    const n = sessions.size;
    const message = n > 0
      ? `Закрыть Claude Swarm? Сейчас запущено сессий: ${n}. Все агенты завершатся.`
      : 'Закрыть Claude Swarm?';
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Отмена', 'Закрыть'],
      defaultId: 0,
      cancelId: 0,
      title: 'Закрытие приложения',
      message,
    });
    if (choice === 1) { allowClose = true; win.close(); return; }
    // Передумал. ⌘Q успел объявить `before-quit` ДО этого диалога, и без сброса флага
    // приложение до конца сеанса считало бы себя уходящим: смерть вкладки перестала бы
    // писаться в журнал, мандат — сниматься, а отчёт — собираться вовсе.
    quitting = false;
  });

  win.on('closed', () => {
    // Kill every child so we don't leak `claude` processes on quit.
    for (const p of sessions.values()) {
      try { p.kill(); } catch (_) {}
    }
    sessions.clear();
    win = null;
  });
}

// --- IPC: pick a working directory for a new session -------------------------
ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Рабочая папка для агента',
    defaultPath: defaultPath || undefined, // open where the user last was
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;

  return res.filePaths[0];
});

// --- IPC: list a project's + global custom slash commands --------------------
// Claude Code custom commands are markdown files under .claude/commands. We read
// the active session's project dir + the global ~/.claude/commands, pull the
// frontmatter (description → hint, argument-hint → needs a tee-up), and let the
// quick-menu show what's actually available for that project.
function parseFrontmatter(text) {
  const out = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  return out;
}

function readCommandsDir(baseDir, scope) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, prefix ? `${prefix}:${e.name}` : e.name); // Claude namespaces subdirs with ":"
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const base = e.name.slice(0, -3);
        let fm = {};
        try { fm = parseFrontmatter(fs.readFileSync(full, 'utf8')); } catch (_) {}
        out.push({
          name: '/' + (prefix ? `${prefix}:${base}` : base),
          hint: fm.description || '',
          arg: !!fm['argument-hint'],
          scope,
        });
      }
    }
  };
  walk(baseDir, '');

  return out;
}

// Short one-liner for the menu from a (usually long) skill description.
function shortHint(desc) {
  const first = desc.split(/(?<=[.!?])\s|—/)[0] || desc;
  const t = first.replace(/^Use\s+(when|to)\s+/i, '').trim();

  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

// Skills are directories with a SKILL.md (name + description frontmatter); each
// is invokable as /<name>. We guess "needs an argument" from the description
// showing "/name <…>" (like "/groom <issue-url>").
function readSkillsDir(baseDir, scope) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(path.join(baseDir, e.name, 'SKILL.md'), 'utf8')); } catch (_) { continue; }
    const name = fm.name || e.name;
    const desc = fm.description || '';
    const arg = new RegExp('/' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+[<«[]').test(desc);
    out.push({ name: '/' + name, hint: shortHint(desc), arg, scope });
  }

  return out;
}

// Свои команды и скиллы Клод берёт из конфига, с которым запущен. У вкладки с
// CLAUDE_CONFIG_DIR (алиас `claude-my`) это ~/.claude-my, и список из ~/.claude показывал ей
// ровно то, чего у неё НЕТ. Спрашивают здесь по папке, поэтому конфиг берём у вкладок с этой
// папкой — они его уже узнали от хука (см. d.claudeHome).
function homesForCwd(cwd) {
  const out = [];
  for (const d of det.values()) {
    if (d.dead || !d.cwd || d.cwd !== cwd || !d.claudeHome) continue;
    if (!out.includes(d.claudeHome)) out.push(d.claudeHome);
  }
  return out.length ? out : [CLAUDE_HOME];
}

ipcMain.handle('commands:list', (_e, cwd) => {
  const list = [];
  if (cwd) {
    list.push(...readCommandsDir(path.join(cwd, '.claude', 'commands'), 'project'));
    list.push(...readSkillsDir(path.join(cwd, '.claude', 'skills'), 'project'));
  }
  for (const home of homesForCwd(cwd)) {
    list.push(...readCommandsDir(path.join(home, 'commands'), 'global'));
    list.push(...readSkillsDir(path.join(home, 'skills'), 'global'));
  }
  const seen = new Set();

  return list.filter((c) => (seen.has(c.name) ? false : seen.add(c.name))).sort((a, b) => a.name.localeCompare(b.name));
});

// --- IPC: git status / actions for the active session's folder ---------------
// All logic lives in git.js (pure Node). The renderer drives which cwd to ask
// about (the active tab's folder). checkout/pull affect the real working tree
// that `claude` runs in — the same as running git yourself in that terminal.
ipcMain.handle('git:info', (_e, cwd) => git.gitInfo(cwd));
ipcMain.handle('git:branches', (_e, cwd) => git.gitBranches(cwd));
ipcMain.handle('git:fetch', (_e, cwd) => git.gitFetch(cwd));
ipcMain.handle('git:pull', (_e, cwd) => git.gitPull(cwd));
ipcMain.handle('git:checkout', (_e, cwd, branch) => git.gitCheckout(cwd, branch));

// Diff counter + viewer for the active session's folder. Same contract as the
// rest: the renderer picks the cwd, git.js does the work, nothing throws here.
ipcMain.handle('git:diffstat', (_e, cwd) => git.gitDiffStat(cwd));
ipcMain.handle('git:difftext', (_e, cwd, path) => git.gitDiffText(cwd, path));

// Hand a file to the OS' default editor. The overlay is read-only on purpose —
// editing here would race the agents writing these same files — so this is the
// way out to a real IDE.
//
// Joins here rather than in the renderer: the renderer has no `path`, and
// cwd + '/' + rel would hand Windows a mixed-separator path.
ipcMain.handle('shell:openPath', (_e, cwd, rel) => shell.openPath(path.join(cwd, rel)));

// --- самоперезапуск вкладки: чистая сессия без потери нити --------------------
// Спека: docs/superpowers/specs/2026-08-08-self-restart-design.md. Чистая логика (когда пора,
// текст просьбы, разбор ответа) — в restart.js и под тестом; здесь только руки: печать в pty,
// чтение расхода и сборка новой строки запуска.
//
// Главное решение: приложение НЕ определяет, безопасно ли сейчас чистить сессию, — оно
// спрашивает агента. Снаружи «всё закоммичено» и «три файла разобраны наполовину» выглядят
// одинаково, и цена ошибки здесь невозвратна.
let RESTART_ENABLED = false;
let RESTART_PCT = restart.DEFAULT_PCT;

const RESTART_TICK_MS = 30_000;
// Сроки, по которым автомат принимает решения, живут в restart.js — рядом с самими решениями и
// под тестом. Здесь остались только те, что нужны рукам.
//
// Насколько устаревший расход ещё годится. Строгая свежесть (пять минут, как у /usage) здесь не
// работает: спрашиваем мы только отдохнувшую вкладку, а отдохнувшая статуслайн не перерисовывает —
// то есть после любой отсрочки число протухало, и функция замолкала для вкладки навсегда. Снимок
// привязан к разговору, так что после /clear или перезапуска он не подойдёт и возьмётся заново.
const RESTART_PCT_STALE_MS = 45 * 60 * 1000;
// Записки не выбрасываем сразу — по ним видно, чем агент себя кормил. Но и вечно им не лежать:
// месяц это несколько сотен перезапусков, дальше они говорят только о прошлой жизни. Та же
// мысль, что у pruneUsage.
const RESTART_KEEP_MS = 30 * 24 * 3600 * 1000;

function restartDir() {
  const dir = path.join(app.getPath('userData'), 'restart');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* некуда писать — переживём */ }
  return dir;
}

// Ключ вкладки переживает перезапуск процесса, номер — нет. Поэтому файл ответа лежит под
// ключом: после самоперезапуска это та же вкладка и тот же файл.
function restartKeyOf(id, d) {
  const key = String((d && d.tabKey) || '') || ('tab-' + id);
  return key.replace(/[^\w.-]/g, '_');
}

// Файл ответа лежит В ПАПКЕ ВКЛАДКИ, а не в настройках приложения, и это не про удобство. Путь за
// пределами рабочей папки Клод спрашивает ОТДЕЛЬНО, сверх обычного разрешения на запись, — то
// есть ночь, ради которой всё делалось, кончалась бы вкладкой, замершей на запросе про наш
// собственный служебный файл, да ещё и звонком в телеграм в три часа.
//
// Оговорка, которой здесь сначала не было: внутри папки пропадает вопрос про ПУТЬ, но не про саму
// запись — её в ручном режиме Клод всё равно спросит. Значит по-настоящему без человека функция
// работает во вкладке, которая не спрашивает разрешение на каждую правку. Молчание агента мы на
// этот случай считаем (restart.MAX_SILENT) и говорим о нём в журнал, а не спрашиваем вечно.
//
// Имя с точки и «swarm» в нём: файл живёт секунды (читаем и удаляем), но за эти секунды его
// может увидеть и человек в `git status`, и соседний агент в том же дереве — пусть сразу будет
// понятно, чей он. Папки нет — падаем в настройки приложения, там хоть спросят, но не потеряем.
// Имя с ключом ВКЛАДКИ, а не одно на папку. Две вкладки в одном репозитории — обычное дело
// (см. оговорку про две вкладки в одной папке у injectSessionId), и на общем имени они крали бы
// друг у друга разрешение: сосед прочитал бы чужой ответ, стёр файл и перезапустил себя с чужим
// промптом, а спросивший так и не увидел бы своего ответа.
function restartAnswerFile(id, d) {
  const name = '.swarm-restart-' + restartKeyOf(id, d) + '.json';
  const cwd = d && d.cwd;
  if (cwd && fs.existsSync(cwd)) return path.join(cwd, name);
  return path.join(restartDir(), name);
}

// Имя БЕЗ ключа вкладки — для того, кто нашей просьбы не видел.
//
// Именной файл узнают из просьбы, и это работает, пока разговор тот самый. А свежая сессия после
// перезапуска (или сессия, которую ещё ни разу не спрашивали) пути не знает вовсе — и «положи файл
// в любой момент» для неё пустой звук. Общее имя знать неоткуда не надо: оно одно на все вкладки и
// пишется в документации.
//
// Цена общего имени — две вкладки в одной папке (у нас это норма, см. injectSessionId): чей это
// файл, по имени не понять, и перезапустить по нему не ту вкладку значит снести чужую работу без
// эстафеты. Поэтому общий файл читает только вкладка, которая в своей папке одна; остальным он не
// достаётся, и об этом мы говорим вслух, а не молчим.
const RESTART_SHARED_NAME = '.swarm-restart.json';

function restartTabsInCwd(cwd) {
  let n = 0;
  for (const id of sessions.keys()) {
    const d = det.get(id);
    if (d && !d.dead && d.cwd === cwd) n++;
  }
  return n;
}

function restartReadAt(file) {
  try {
    return { raw: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
  } catch (_) { return null; }
}

// Файл-ответ, названный по id РАЗГОВОРА. Его имя знает хук — он кладёт свежей сессии строку про
// самозвон, а ключа вкладки у него нет (см. restart.answerName). Однозначен по построению, поэтому
// читается и в папке с двумя вкладками, где общее имя не годится.
function restartSessionFile(d) {
  const cwd = d && d.cwd;
  const name = restart.answerName(d && d.claudeSessionId);
  if (!cwd || !name || !fs.existsSync(cwd)) return '';
  return path.join(cwd, name);
}

// Лежит ли зов на диске — без чтения и без разбора. Нужна только пинку (restartKick), которому
// важно не «что там написано», а «есть ли повод тратить полный такт».
//
// Общее имя `.swarm-restart.json` сюда не входит намеренно: у него свои оговорки (в папке с двумя
// вкладками мы его не трогаем, см. restartReadAnswer), и разбирать их в пробе значит завести им
// второе место жизни. Такой зов доедет общим тактом, за полминуты.
function restartAnswerWaiting(id, d) {
  for (const f of [restartAnswerFile(id, d), restartSessionFile(d)]) {
    if (f && fs.existsSync(f)) return true;
  }
  return false;
}

// Ответ вкладки: свой именной файл, потом названный по разговору, потом общий. Возвращает и путь:
// прочитанное мы стираем, и стереть надо ровно тот файл, который прочитали.
function restartReadAnswer(id, d) {
  const named = restartAnswerFile(id, d);
  const own = restartReadAt(named);
  if (own) return { file: named, answer: own };
  const bySession = restartSessionFile(d);
  if (bySession) {
    const mine = restartReadAt(bySession);
    if (mine) return { file: bySession, answer: mine };
  }
  const cwd = d && d.cwd;
  if (!cwd) return { file: named, answer: null };
  const shared = path.join(cwd, RESTART_SHARED_NAME);
  const any = restartReadAt(shared);
  if (!any) return { file: named, answer: null };
  if (restartTabsInCwd(cwd) > 1) {
    // Раз на появление файла, а не каждые полминуты: строка объясняет, что делать, и повторять её
    // до утра незачем.
    if (!d.rsSharedWarned) {
      d.rsSharedWarned = true;
      restartNote(id, `в этой папке открыта не одна вкладка — ${RESTART_SHARED_NAME} я не трогаю.`
        + ` Положи ответ в ${path.basename(named)}`);
    }
    return { file: named, answer: null };
  }
  d.rsSharedWarned = false;
  return { file: shared, answer: any };
}

function restartHandoffName(id, d) {
  return '.swarm-handoff-' + restartKeyOf(id, d) + '.md';
}

// Наши файлы из ПАПКИ ВКЛАДКИ. Внутри репозитория им жить незачем: ответ прочитан, эстафета
// прочитана свежей сессией, а лежать в чужом `git status` они не должны — однажды уедут в
// чей-нибудь `git add -A`. Архив эстафет остаётся у нас, там их и смотреть.
function restartSweepCwd(id, d) {
  const cwd = d && d.cwd;
  if (!cwd) return;
  const bySession = restartSessionFile(d);
  for (const f of [restartAnswerFile(id, d), path.join(cwd, restartHandoffName(id, d)),
    ...(bySession ? [bySession] : [])]) {
    try { fs.unlinkSync(f); } catch (_) { /* нет — и хорошо */ }
  }
}

// Записки и забытые файлы ответов. Живут долго, но не вечно — тем же порядком, что pruneUsage.
function pruneRestart() {
  try {
    const dir = path.join(app.getPath('userData'), 'restart');
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > RESTART_KEEP_MS) fs.unlinkSync(p);
      } catch (_) { /* исчез сам — не наша забота */ }
    }
  } catch (_) { /* папки нет — перезапусков ещё не было */ }
}

// Заполнение контекста для решения о перезапуске. Тот же снимок от статуслайна, что у полоски и
// /usage, но со своим сроком годности: у /usage он пять минут, потому что там человек ищет
// признак жизни и пятиминутная давность соврала бы. Здесь наоборот — мы спрашиваем именно
// отдохнувшую вкладку, а отдохнувшая статуслайн не перерисовывает, так что строгая свежесть
// означала бы «никогда». Подменить чужим числом снимок не может: он лежит под id разговора, и
// после /clear или перезапуска у новой сессии его просто нет.
function restartPctOf(d, now) {
  const u = readUsage(d && d.claudeSessionId);
  if (!u || !u.ctx || u.ctx.used == null) return null;
  if (now - (u.at || 0) * 1000 > RESTART_PCT_STALE_MS) return null;
  return u.ctx.used;
}

// В журнал приложения — тот, у которого есть кнопка. Файл рядом с настройками нужен для
// разбора «что именно спросили и что ответили», но человек про перезапуски узнаёт из вкладки.
function restartLog(msg) {
  logTo('restart.log', msg);
}

function restartNote(id, text) {
  restartLog(`вкладка ${id}: ${text}`);
  safeSend('session:restartNote', { id, text });
}

// Печать просьбы в живую сессию. Не через tgAnswer: у того свои побочные действия для
// телеграма (вкладка объявляется «ведомой из чата»), а здесь никакого чата нет.
function restartType(id, text) {
  const p = sessions.get(id);
  if (!p) return false;
  const [body, enter] = telegram.inputWrites(text);
  if (!body) return false;
  ptyType(id, body);
  setTimeout(() => ptyType(id, enter), TG_ENTER_DELAY_MS);
  return true;
}

function restartAsk(id, d, pct) {
  // Все причины НЕ спрашивать проверил автомат (restart.askable): и порог, и покой вкладки, и
  // диалог на экране, и то, что агент в оболочке вообще есть. Здесь остаётся печать.
  const file = restartAnswerFile(id, d);
  try { fs.unlinkSync(file); } catch (_) { /* прошлого ответа нет — тем лучше */ }
  // Записку прошлого перезапуска здесь НЕ трогаем, хотя соблазн был: она лежит в чужом репозитории
  // и светится в git status. Но её путь мы САМИ вписали в промпт живой сессии («прочитай её первым
  // делом»), и та вправе перечитать записку в любой момент — особенно после собственного сжатия
  // контекста. Стирать её на просьбе значит ломать сессию, которая на этой просьбе ещё и ответит
  // «не сейчас» и проработает часы. Убираем при закрытии вкладки и на выходе из приложения.
  // Сабагенты в просьбе названы числом: их агент бросит не задумываясь, если не напомнить, — с
  // его стороны они уже отпущены в фон, а гибнут вместе с ним (см. askText).
  if (!restartType(id, restart.askText({ pct, answerFile: file, sub: d.sub || 0 }))) {
    // Печать не удалась — вкладки уже нет. Возвращаем автомат в исходное, иначе он будет ждать
    // ответа на просьбу, которой никто не видел.
    d.rs = { ...restart.initial(), retryAt: Date.now() + restart.RETRY_MS };
    return;
  }
  // Этот ход начали МЫ, и его итог в телеграм не уезжает. Мост отправляет всякий переход
  // работает→готов, пока включён режим телефона, — то есть ночная переписка с агентом про
  // эстафету сама рождала бы уведомления в три часа. Прямой долг за вопрос человека это не
  // отменяет (см. owed в тике статусов): на его вопрос ответить надо, где бы он ни был.
  d.rsQuiet = true;
  restartLog(`вкладка ${id}: контекст ${pct}% — спросил про перезапуск`);
}

// Эстафета, которую положить было некуда. Пишем сами — и та копия, которую БУДЕТ ЧИТАТЬ свежая
// сессия, обязана лежать в папке вкладки. Чтение за её пределами Клод спрашивает отдельным
// разрешением, то есть свежая сессия замерла бы на запросе про нашу же записку, в три часа ночи,
// — ровно то, от чего вся затея. Файл в папке один и перезаписывается: истории в чужом
// репозитории накапливать нельзя, её мы держим у себя.
//
// Вторая копия, с отметкой времени, ложится рядом с настройками и прошлые не затирает: плохая
// записка тогда не смертельна, и утром видно, чем агент себя кормил.
function restartSaveHandoff(id, d, text) {
  const body = String(text || '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.writeFileSync(path.join(restartDir(), restartKeyOf(id, d) + '-' + stamp + '.md'), body, 'utf8');
  } catch (_) { /* архив не главное — главное та копия, которую прочитают */ }
  // С ключом вкладки, как и файл ответа, и ровно по той же причине: две вкладки в одном
  // репозитории — норма, а на общем имени второй агент затёр бы записку первого, и свежая сессия
  // прочитала бы чужую задачу вместо своей.
  const cwd = d && d.cwd;
  const file = cwd && fs.existsSync(cwd)
    ? path.join(cwd, restartHandoffName(id, d))
    : path.join(restartDir(), restartKeyOf(id, d) + '-' + stamp + '.md');
  try {
    fs.writeFileSync(file, body, 'utf8');
    return file;
  } catch (e) {
    restartLog(`вкладка ${id}: эстафету не записал — ${e.message}`);
    return '';
  }
}

// Один такт по одной вкладке. Все решения принял автомат (restart.step) — здесь только руки:
// прочитать файл, напечатать, погасить, доложить. Раньше это же лежало пятнадцатью полями
// состояния и шестью десятками разбросанных проверок, и пять проходов ревью нашли в них
// 35 замечаний против нуля в чистом модуле.
// Заготовленная строка запуска живёт ВНЕ автомата — это данные, а не решение. Значит её надо
// стирать всюду, где автомат возвращается в исходное: иначе `hasLine` останется правдой от
// прошлого раза, следующее разрешение проскочит ожидание свежей строки от вкладки, и вкладка
// стартует с ВЧЕРАШНИМ промптом, вчерашним ярлыком и вчерашним id разговора.
function restartClearPending(d) {
  d.rsPendingLine = '';
  d.rsPendingBase = '';
  d.rsPendingSession = null;
  d.rsKey = null;
  // Отметка «уход просили сигналом» живёт ровно один круг: с ней остаётся и частый такт фазы
  // выхода, и короткий срок ожидания, а следующий круг может пойти совсем другим путём.
  d.rsSignalled = false;
  d.rsKillPid = null;
  // И причину простоя: круг кончился, а следующий начнётся с чистого листа — иначе о новой
  // задержке по той же причине мы бы промолчали, приняв её за уже рассказанную.
  d.rsHold = '';
  d.rsShellBusy = undefined;
  d.rsProbeErr = false;
  d.rsProbedAt = 0;
  // И тишину в телеграме. Её снимает конец круга «спросили — ответили», но у выключенной функции
  // такта больше нет — и отметка досталась бы СЛЕДУЮЩЕМУ, настоящему итогу, который человек ждёт с
  // телефона: мост промолчал бы ровно там, где должен был доложить.
  d.rsQuiet = false;
}

// Вкладка сказала «работа закончена» и замолчала (фаза done, см. restart.js). Молчание это до
// НОВОЙ работы, а признак у неё один и надёжный: человек написал вкладке сам — с клавиатуры или
// с телефона. Возвращаемся не в «спрашиваю прямо сейчас», а в обычную отсрочку: работа только
// началась, и просьба о перезапуске на её первой минуте — ровно то, чего мы избегаем.
function restartWorkAgain(id, d) {
  if (!d || !d.rs || d.rs.phase !== 'done') return;
  d.rs = { ...restart.initial(), retryAt: Date.now() + restart.RETRY_MS };
  restartLog(`вкладка ${id}: во вкладке снова работа — возвращаю перезапуск в строй`);
}

function restartTick(id, d, now) {
  const state = d.rs || restart.initial();
  // Ждём ухода агента, которого сами и закрыли: тогда ответ даёт ОДИН его pid, а всё остальное
  // в этой фазе не читается вовсе (см. goneStep). Разница не косметическая — этот такт идёт
  // четыре раза в секунду, а полный набор стоит чтения снимка расхода с диска и двух снятий
  // экрана. Заодно и точность: `d.shellBusy` обновляется раз в пять секунд, то есть в этой фазе
  // он заведомо устаревший.
  const byPid = state.phase === 'exiting' && d.rsSignalled && d.rsShellBusy !== undefined;
  const pct = byPid ? 0 : restartPctOf(d, now);
  // В каких состояниях читать файл ответа, решает автомат (restart.wantsAnswer) — и решает не для
  // экономии: ответ, прочитанный не вовремя, перезапускает вкладку по ответу про прошлый круг, а не
  // прочитанный вовремя — теряет готовое разрешение на часы.
  let answer = null;
  let file = '';
  if (restart.wantsAnswer(state, { now, enabled: RESTART_ENABLED })) {
    const got = restartReadAnswer(id, d);
    file = got.file;
    answer = got.answer;
  }
  const r = restart.step(state, {
    now,
    enabled: RESTART_ENABLED,
    threshold: RESTART_PCT,
    pct,
    status: d.status,
    // «Работает в фоне» — это статус «работает» с отметкой. Для перезапуска разница
    // принципиальная: ход отдан, агент ничего не делает (см. turnOver).
    bg: byPid ? false : !!d.bg,
    dialog: byPid ? false : !!parsePrompt(promptSnapshot(d)),
    // Чего именно ждёт вкладка. Зов к человеку печати не мешает, запрос разрешения — мешает, и
    // знает об этом хук, а не экран: рамку скрёб иногда и не находит (см. boxOpen).
    kind: byPid ? null : (d.status === 'waiting' ? d.waitingKind : null),
    // Открыта ли РАМКА. Отличить её от зова прозой по статусу нельзя — оба «ждёт: вопрос», — а
    // разница решающая: в строку ввода печатать можно, в рамку Enter уходит выбором варианта.
    // Знает об этом сам Клод и говорит отдельным событием (токен `box`), которое детектор несёт
    // через все свои каналы наравне со статусом.
    //
    // Судить по одному «ждёт» от хука было нельзя: тем же ожиданием он объявляет и обычное
    // прощание зовом (Stop с фразой «Сейчас от тебя»), то есть ровно то состояние, ради которого
    // перезапуск вкладок сворма и делался. Приняв его за рамку, мы выключили бы функцию всем.
    box: byPid ? false : !!d.waitingBox,
    // Сколько сабагентов считает прямо сейчас. Вкладка с ними «готова» на вид, а закрыть её —
    // значит убить их вместе с агентом (см. turnOver).
    sub: byPid ? 0 : (d.sub || 0),
    shellBusy: byPid ? d.rsShellBusy : d.shellBusy,
    modeVisible: byPid ? false : !!readMode(snapshot(d)),
    uptimeMs: d.sessionStartAt ? now - d.sessionStartAt : 0,
    // Строка запуска уже собрана? Её приносит вкладка со своим новым ярлыком разговора
    // (session:relaunch), и до неё гасить прежнего агента нечем.
    hasLine: !!d.rsPendingLine,
    // А ЕСТЬ ли из чего её собирать: строка, которой вкладку запускал сворм. Пустая — значит
    // перезапуск невозможен, и спрашивать разрешение не с чего (см. askable).
    hasBase: !!d.launchCmd,
    // Ответ, которого человек ещё не видел. Единственная причина НЕ перезапускать, о которой
    // агента бесполезно спрашивать: он видит свой ответ написанным и всегда ответит «можно».
    unread: unread.isUnread(d.unread),
    answer,
  });
  d.rs = r.state;
  if (r.note) restartNote(id, r.note);
  // Служебный круг открылся или закрылся. Пока он идёт, всё сказанное агентом адресовано СВОРМУ, и
  // пометкой «человек этого не видел» ложиться не должно — иначе вкладка запирает себя собственной
  // перепиской (см. unread.onSwarmAsk). Отмечаем по переходам, а не по фазе каждый такт: человек
  // мог вмешаться в круг своим сообщением, и его ожидание перебивает наше.
  // При зове ФАЙЛОМ круг открывается задним числом: ход, которым агент позвал, кончился раньше,
  // чем мы о зове узнали, и уже лёг пометкой «человек этого не видел» — то есть запер ровно то
  // разрешение, которое сам и принёс. Поэтому отдаём время зова: пометку моложе него снимет
  // onSwarmAsk, а всё, что старше, останется держать (см. unread.js).
  if (r.action === 'ask' || r.action === 'grant') {
    d.unread = unread.onSwarmAsk(d.unread, { since: r.action === 'grant' && answer ? answer.mtime : 0 });
  } else if (r.action === 'drop' || r.action === 'fire') d.unread = unread.onSwarmIdle(d.unread);
  // Почему стоим с разрешением на руках. Раз в смену причины, а не каждый такт: между разрешением и
  // его исполнением проходит до десяти минут, и всё это время человек видит вкладку, которой сказали
  // «можно гасить», — а она живёт. Молчать здесь значит выглядеть зависшей.
  const holdWas = d.rsHold;
  if (r.hold !== undefined && r.hold !== d.rsHold) {
    d.rsHold = r.hold;
    if (r.hold) restartNote(id, `разрешение на перезапуск есть, но пока не гашу: ${restart.holdText(r.hold)}`);
  } else if (r.action !== 'nothing') d.rsHold = '';
  // И на карточку — потому что журнал приложения человек открывает, уже заподозрив неладное, а
  // заподозрить тут нечего: вкладка живая, работа идёт, просто перезапуска нет. Держит вечно одно
  // непрочитанное (часы разрешения под ним стоят намеренно, см. restart.js) — про него и говорим.
  // Остальные причины уйдут сами за десять минут, и мигать ими на карточке незачем.
  if ((d.rsHold || '') !== (holdWas || '')) safeSend('session:restartHold', { id, hold: d.rsHold || '' });
  // Круг «спросили — ответили» закрылся: снимаем тишину в телеграме. Раньше её снимал только
  // переход работает→готов, и если ход просьбы такого перехода не дал (статус его не заметил,
  // вкладка ушла в «ждёт»), отметка переживала круг и глушила СЛЕДУЮЩИЙ, настоящий итог — тот,
  // который человек ждал с телефона.
  if (r.action !== 'nothing') d.rsQuiet = false;
  // Ответ прочитан и больше не нужен — ни в успехе, ни в отказе. Неразобранное (action
  // 'nothing' в фазе asked) остаётся лежать: тик мог попасть в середину записи.
  // А `dropAnswer` — про залежавшийся файл, который автомат читать больше не будет: он бы лежал в
  // чужом репозитории и попадался нам под руку каждые полминуты (см. step).
  if (file && (r.action !== 'nothing' || r.dropAnswer)) { try { fs.unlinkSync(file); } catch (_) {} }

  if (r.action === 'ask') { restartClearPending(d); restartAsk(id, d, pct); }
  else if (r.action === 'grant') restartGrant(id, d, r.state);
  else if (r.action === 'exit') restartExit(id, d);
  else if (r.action === 'fire') restartFire(id, d);
  else if (r.action === 'drop') restartClearPending(d);
}

// Такт раз в полминуты — это про «пора ли спрашивать»: там полминуты не видны никому. А два шага
// круга видны человеку целиком, и оба ждали удара часов зря.
//
// По журналу живого перезапуска: ответ агента лежал на диске готовый, но замечен через 30 секунд;
// ещё через 60 — вкладка погашена. Полторы минуты, в которые ничего не происходило, — вкладка
// стояла, будто повисла. Поэтому там, где приложение и так узнаёт новость (вкладка кончила ход;
// строка запуска собрана), автомат тактуется НЕМЕДЛЕННО. Решения все те же — здесь только повод
// спросить его раньше, чем через полминуты.
//
// Поводы бывают двух пород, и различены они не для журнала: защита от дребезга нужна одной и
// вредна другой.
//   'turn' — вкладка кончила ход. Приходит от статуса, а статус дребезжит: перерисовка даёт
//            готов→работает→готов за доли секунды. Здесь выдержка на месте — такт стоит двух
//            снятий экрана и чтения снимка расхода с диска, а пропущенное колебание вернётся
//            следующим, потому что дребезг на то и дребезг.
//   всё остальное — события ОДНОРАЗОВЫЕ: пришла строка запуска, досчитали сабагенты, закрылась
//            рамка. Они не повторяются, и проглоченное такой же выдержкой не возвращается ничем,
//            кроме общего такта, — то есть ценой в полминуты пустого стояния ровно там, где пинок
//            и заводился. Строку запуска, скажем, рендерер приносит через миллисекунды после
//            разрешения, впритык к пинку от статуса, и прежняя общая выдержка съедала её всегда.
const RESTART_KICK_GAP_MS = 1000;

function restartKick(id, d, why) {
  if (!d || d.dead || !d.rs) return;
  // Фазы круга «спросили — ответили» тактуем всегда. Остальные — только когда на диске лежит зов:
  // агент кладёт файл и тем же ходом прощается, и ждать после этого полминуты общего такта значит
  // показывать человеку зависшую вкладку ровно там, где пинок и заводился. Проба — одно обращение
  // к файловой системе, а полный такт стоит снимка расхода с диска и двух снятий экрана.
  if (d.rs.phase !== 'asked' && d.rs.phase !== 'granted') {
    if (!RESTART_ENABLED || !restartAnswerWaiting(id, d)) return;
  }
  const now = Date.now();
  if (why === 'turn') {
    if (now - (d.rsKickAt || 0) < RESTART_KICK_GAP_MS) return;
    d.rsKickAt = now;
  }
  try { restartTick(id, d, now); } catch (e) { reportMainError(e); }
}

setInterval(() => {
  const now = Date.now();
  for (const id of sessions.keys()) {
    const d = det.get(id);
    if (!d || d.dead) continue;
    // До проверки галочки: доехал ли ПРОШЛЫЙ запуск. Функцию могли выключить сразу после
    // перезапуска, а вкладка с мёртвой оболочкой от этого не оживает.
    if (d.rsCheckAt && now >= d.rsCheckAt) restartVerify(id, d);
    // Выключенная функция не должна ничего стоить, а она стоит: чтение снимка расхода с диска и два
    // снятия экрана на каждую вкладку каждые полминуты. Незапущенную фазу пропускаем сразу, а
    // начатый перезапуск (exiting) доводим — иначе снятая галочка бросит вкладку голой оболочкой.
    if (!RESTART_ENABLED && (!d.rs || d.rs.phase === 'idle')) continue;
    // По вкладке отдельно, как в тике статусов: осечка на одной не должна ронять приложение и
    // лишать такта все следующие. Печать в pty умеет бросать на оболочке, которая только что умерла.
    try { restartTick(id, d, now); } catch (e) { reportMainError(e); }
  }
}, RESTART_TICK_MS);

// Отдельный частый такт на одну-единственную фазу: агента закрыли и ждём, когда освободится
// оболочка, чтобы напечатать в неё новый запуск.
//
// Общий такт идёт раз в полминуты, и этого хватает везде, кроме этого места: здесь пауза видна
// человеку — вкладка стоит голой оболочкой, будто умерла. Именно так и вышло вживую: агент
// закрылся, полминуты ничего не происходило, человек поднял агента руками (без наших флагов), а
// пришедший такт увидел занятую оболочку и остался ждать выхода, которого уже не будет.
//
// Стоит это почти ничего: тактуются только вкладки в этой фазе (обычно ни одной), и весь такт
// там — проверка одного pid, без чтений с диска и снятий экрана (см. byPid в restartTick).
const RESTART_EXIT_TICK_MS = 250;
// Быстро спрашиваем только первые секунды — там весь смысл. Дальше это уже не «вот-вот
// освободится», а «что-то держит», и частить незачем: фаза ожидания живёт до часа, а каждый
// вопрос — запуск отдельной программы. Четыре запуска PowerShell в секунду в течение часа
// человек увидел бы вентилятором.
const RESTART_EXIT_FAST_MS = 10_000;
const RESTART_EXIT_SLOW_MS = 3000;
setInterval(() => {
  const now = Date.now();
  for (const id of sessions.keys()) {
    const d = det.get(id);
    if (!d || d.dead || !d.rs || d.rs.phase !== 'exiting' || !d.rsSignalled) continue;
    if (d.rsProbing) continue;              // прошлый вопрос ещё в пути — не наслаиваем
    // Осечка опроса НЕ выключает быстрый путь навсегда — она лишь замедляет его. Латч здесь
    // пробовали и убрали: одна случайная неудача (WMI икнул, spawn под нагрузкой) оставляла
    // вкладку на общем такте раз в полминуты, то есть ровно с той дырой, ради которой быстрый
    // путь и заводился.
    const since = now - (d.rs.exitAt || now);
    const fast = since < RESTART_EXIT_FAST_MS && !d.rsProbeErr;
    // Порог чуть меньше периода: таймер иногда срабатывает на пару миллисекунд раньше, и
    // сравнение «прошло ли ровно 250 мс» роняло бы каждый второй заход вдвое.
    const due = (fast ? RESTART_EXIT_TICK_MS : RESTART_EXIT_SLOW_MS) - 50;
    if (now - (d.rsProbedAt || 0) < due) continue;
    const child = sessions.get(id);
    const shellPid = child && child.pid != null ? Number(child.pid) : 0;
    if (!shellPid) continue;
    d.rsProbing = true;
    d.rsProbedAt = now;
    // Спрашиваем ПУСТА ЛИ ОБОЛОЧКА, а не «умер ли тот номер, который мы закрыли». Разница в том
    // единственном случае, где ошибка непоправима: если мы закрыли не агента (в оболочке висел
    // чужой фоновый job), то смерть закрытого номера сказала бы «свободно» — и строка запуска
    // уехала бы прямо в поле ввода живого агента, репликой в разговор. Пустая оболочка такого
    // не допускает по определению.
    shellChildren(shellPid, (err, pids) => {
      d.rsProbing = false;
      if (!d.rs || d.rs.phase !== 'exiting' || !sessions.has(id)) return;
      if (err) {
        // Не спросили — не знаем. Но кое-что знаем даром: закрытый нами процесс проверяется
        // системным вызовом, без запуска программ. Жив — оболочка точно занята; ушёл — решать
        // будет общий такт по своим признакам (экран, обход процессов раз в пять секунд).
        d.rsShellBusy = pidAlive(d.rsKillPid) ? true : undefined;
        if (!d.rsProbeErr) {
          d.rsProbeErr = true;
          restartLog(`вкладка ${id}: потомков не спросить (${(err && err.code) || 'ошибка'}) — спрашиваю реже`);
        }
      } else {
        d.rsProbeErr = false;
        d.rsShellBusy = !!pids.length;
      }
      try { restartTick(id, d, Date.now()); } catch (e) { reportMainError(e); }
    });
  }
}, RESTART_EXIT_TICK_MS);

// Разрешение получено. Эстафету, которую агенту некуда было положить, дописываем сами и путь к
// ней добавляем к промпту: агент писал его до того, как файл появился.
//
// Туда же уходит и САМ ПРОМПТ, если он вырос до эстафеты. Промпт мы печатаем в оболочку, и
// килобайты в псевдотерминале однажды повесили приложение целиком (см. ptyType,
// BUG-pty-deadlock-2026-08-11.md). Порции этот тупик разомкнули, но длинному промпту в терминале
// всё равно нечего делать: свежая сессия прочитает его из файла тем же чтением, которым читает
// записку, а вкладка откроется на агенте, а не на пол-экрана нашего эха.
//
// Ярлык разговора заводит рендерер — он его хранит и по нему восстанавливает вкладку, а после
// перезапуска ярлык обязан стать НОВЫМ: со старым вкладка после релонча сворма вернулась бы в тот
// самый разбухший разговор, из которого мы ушли.
function restartGrant(id, d, state) {
  let prompt = String(state.prompt || '');
  let carry = state.handoff ? '' : String(state.text || '');
  if (!restart.promptFits(prompt)) {
    restartLog(`вкладка ${id}: промпт длиной ${prompt.length} — уношу его в записку`);
    // Промпт идёт ПЕРЕД эстафетой: это то, что агент считал главным, и читающий должен увидеть
    // его первым. Пустая эстафета — обычный случай: длинный промпт ею и был.
    carry = carry ? `${prompt}\n\n${carry}` : prompt;
    prompt = restart.PROMPT_CARRIED;
  }
  if (carry) {
    const saved = restartSaveHandoff(id, d, carry);
    if (!saved) { d.rs = { ...restart.initial(), retryAt: Date.now() + restart.RETRY_MS }; return; }
    prompt = restart.handoffPrompt(prompt, saved);
  }
  restartLog(`вкладка ${id}: разрешил перезапуск, эстафета ${state.handoff || 'текстом'}`);
  safeSend('app:restartAgent', { id, prompt });
}

// Собрать строку нового запуска из той, которой вкладку запустили. Берём именно её, а не
// собираем заново: в ней уже стоят ссылки на окружение этой оболочки (--settings, правило
// обращения), а окружение задаётся при создании pty и позже недоступно. Пересборка «как для
// новой вкладки» дала бы ссылку на переменную, которой в этой оболочке нет, — и Клод отказался
// бы стартовать, оставив вкладку с мёртвой оболочкой.
function restartLaunchLine(base, sessionKey, mode) {
  let cmd = String(base || '').trim();
  if (!cmd) return { cmd: '', sessionId: null };
  // Метки прежнего разговора: и ярлык, и id. Иначе новая сессия унаследует чужую.
  cmd = cmd.replace(/\s--session-id(=|\s+)[^\s]+/g, '')
    .replace(/\s(-n|--name)(=|\s+)[^\s]+/g, '')
    .replace(/\s(--resume|-r)(=|\s+)[^\s]+/g, '')
    .replace(/\s(--continue|-c)(\s|$)/g, ' ')
    .trim();
  // Режим разрешений, в котором вкладка РАБОТАЛА. Всё, что накопилось внутри сессии, вместе с
  // ней и умирает, а Shift+Tab (и кнопка из телеги) настройкой не помнится — без этого агент
  // после ночного перезапуска встал бы на первом же вопросе, хотя весь вечер работал сам.
  //
  // Живой режим ЗАМЕЩАЕТ флаг из строки запуска, а не уступает ему: с экрана видно, в чём
  // вкладка работает сейчас, а флаг говорит лишь о том, в чём её когда-то открыли. Не прочитали
  // режим — флаг остаётся как был. `--dangerously-skip-permissions` не трогаем вовсе: это выбор
  // человека, написавшего его руками, и подменять его нашей догадкой нельзя.
  const flag = modeFlag(mode);
  const skipFlag = /(^|\s)--dangerously-skip-permissions(\s|$)/.test(cmd);
  if (flag && !skipFlag && resume.supports(launcherOf(cmd))) {
    cmd = cmd.replace(/\s--permission-mode(=|\s+)[^\s]+/g, '').trim() + ` --permission-mode ${flag}`;
  }
  if (sessionKey && resume.supports(launcherOf(cmd))) cmd += ` -n ${sessionKey}`;
  return injectSessionId(cmd);
}

// Доехал ли напечатанный запуск. Строку мы отдаём оболочке и на этом успокаиваемся — а она
// может её и не исполнить: Клод отказался стартовать (незнакомый флаг, битый путь к настройкам),
// кончился лимит, слетела авторизация. Тогда вкладка остаётся голой оболочкой, и снаружи это
// выглядит спокойно: статус «готов», агента нет, эстафета потрачена впустую. Утром человек
// находит вкладку, которая всю ночь ничего не делала, и не понимает почему.
//
// Перезапускать вслепую нельзя (та же строка отвалится так же), поэтому просто ГОВОРИМ — в
// журнал вкладки, который человек видит. Молчание здесь дороже ложной тревоги.
const RESTART_CHECK_MS = 20_000;
function restartVerify(id, d) {
  d.rsCheckAt = 0;
  const child = sessions.get(id);
  const shellPid = child && child.pid != null ? Number(child.pid) : 0;
  if (!shellPid) return;
  shellChildren(shellPid, (err, pids) => {
    if (err || pids.length) return;      // не спросили или агент на месте — тревожить незачем
    if (!sessions.has(id)) return;
    restartNote(id, 'запуск после перезапуска не поднялся — вкладка осталась голой оболочкой');
  });
}

// Напечатать заготовленный запуск в освободившуюся оболочку. Отдельно от session:relaunch,
// потому что зовут отсюда двое: сам перезапуск и тик, если агент вышел позже, чем мы ждали.
function restartFire(id, d) {
  const live = sessions.get(id);
  const line = d.rsPendingLine || '';
  const sessionId = d.rsPendingSession || null;
  const base = d.rsPendingBase || '';
  d.rsPendingLine = '';
  d.rsPendingBase = '';
  d.rsPendingSession = null;
  d.rsSignalled = false;      // круг закончен, см. restartClearPending
  d.rsKillPid = null;
  d.rsShellBusy = undefined;
  d.rsProbeErr = false;
  d.rsProbedAt = 0;
  // Агент ушёл — теперь уже точно. Обычно мост об этом предупредили ещё при `/exit`, и здесь
  // работы не остаётся; но уход мог занять больше минуты, а мост столько не молчит: он снова
  // объявил вопрос, и человек с телефона отвечал бы уже в пустоту. Второй заход эту дыру и
  // закрывает — молчаливо, если объявлять было нечего.
  tgOnRestartExit(id, d);
  if (!live || !line) return false;
  // Порциями, а не одним куском: именно здесь приложение и вставало намертво — строка запуска
  // с эстафетой внутри выросла до килобайтов, и оболочка со своим эхом заперла нас в write.
  // Потолок на саму эстафету стоит раньше, в restartGrant (restart.promptFits), но полагаться
  // только на него нельзя: базу строки пишет человек, и её длину мы не выбираем.
  ptyType(id, clearPrefix(pickShell()) + line + '\r');
  // Базой следующего перезапуска остаётся строка БЕЗ промпта: с ним внутри она потащила бы за
  // собой прошлую задачу. Метки разговора и режим в ней есть, но это не беда: restartLaunchLine
  // снимает их и накладывает заново, иначе режим, схваченный при первом перезапуске, застыл бы
  // навсегда, а следующая сессия унаследовала бы чужой ярлык.
  d.launchCmd = base;
  d.claudeSessionId = sessionId;
  // Мандат остаётся вкладкой, а не сессией: хук знает вкладку только по id разговора, и после
  // самоперезапуска этот id другой. Без перезаписи отданная вкладка тихо теряла бы разрешение
  // решать самой — ровно в тот миг, когда человека рядом нет.
  if (d.auto) tgWriteModes();
  // Тем же каналом, которым вкладка узнаёт про /clear и про `claude`, набранный руками: он
  // хранит id и восстанавливает по нему разговор. Иначе вкладка осталась бы с id брошенного.
  safeSend('session:claude', { id, claudeSessionId: d.claudeSessionId });
  // Стенограмма прежнего разговора вкладке больше не её. Ровно то же делает перепривязка после
  // /clear (trForget + сброс trHint): пока привязка не отвалится сама по молчанию файла, статус и
  // текст хода приходят из БРОШЕННОГО разговора — а в режиме телефона этот старый текст ещё и
  // уедет в чат как итог свежей сессии.
  trForget(d);
  d.trHint = '';
  applyTranscript(d, null);
  // И вкладка обязана СЧИТАТЬСЯ новой, иначе отвязка делает хуже, чем ничего. Оба срока,
  // защищающих привязку, отсчитываются от рождения вкладки и от начала хода: у ночного
  // перезапуска первый истёк часы назад, а второй помнит ход прошлой сессии. Без сброса поиск
  // стенограммы уходил в скан папки, находил там ТОЛЬКО ЧТО брошенный файл — свежий по времени,
  // с той же папкой внутри и уже никем не занятый — и привязывался к нему, попутно затирая
  // новый id разговора старым. То есть ровно то, от чего отвязка и ставилась.
  d.startedAt = Date.now();
  d.turnStartedAt = 0;
  d.turnEndedAt = 0;
  d.sessionStartAt = Date.now();
  d.launchAt = Date.now();
  d.launchPid = null;
  d.rsCheckAt = Date.now() + RESTART_CHECK_MS;   // а доехал ли запуск, см. restartVerify
  d.restarts = (d.restarts || 0) + 1;
  // Автомат начинает с чистого листа: у свежей сессии ни висящего вопроса, ни счётчика молчания,
  // ни немоты. Одной строкой вместо шести — раньше забыть одну из них было отдельным способом
  // сломать функцию (счётчик молчания так и накапливался через успешные перезапуски).
  d.rs = restart.initial();
  // И непрочитанное — тоже с чистого листа. Долг «человек этого не видел» принадлежит РАЗГОВОРУ,
  // а разговор только что умер: держать пометку дальше значит запереть уже другую сессию за то,
  // чего она не говорила.
  d.unread = unread.reset(d.unread);
  // Уговор «отвечаешь коротко и в телегу» живёт в первом сообщении разговора и уходит вместе с
  // ним — ровно как при /clear (см. forgets в tgTypeClaudeCommand). Не снять отметку значит: с
  // утра первое сообщение с телефона придёт без уговора, и свежий агент ответит в чат простынёй.
  // Заодно и tgLastSent: по нему стенограмма ищет файл вкладки, а он от прошлого разговора.
  d.tgPrimed = false;
  d.tgLastSent = '';
  restartLog(`вкладка ${id}: перезапуск №${d.restarts}, новый разговор ${sessionId || '—'}`);
  // Ярлык уезжает вкладке вместе с известием: печатать запуск может и тик (когда агент вышел
  // позже, чем мы ждали), а тогда рендерер про новый ярлык иначе не узнает — и после релонча
  // сворма запасной путь по ИМЕНИ поднял бы брошенный разбухший разговор.
  safeSend('session:restarted', { id, n: d.restarts, sessionKey: d.rsKey || null });
  return true;
}

// Вкладка прислала ярлык нового разговора — собираем строку запуска и кладём её наготове.
// Печатать её и гасить прежнего агента будет автомат: он единственный знает, спокойна ли вкладка
// сейчас, и решает это ЗАНОВО в свой такт, а не в момент этого вызова.
ipcMain.handle('session:relaunch', (_e, opts = {}) => {
  const id = String(opts.id == null ? '' : opts.id);
  const d = det.get(id);
  if (!d || !sessions.has(id)) return { ok: false };
  // Только у вкладки, которая эту строку ждёт. Ответ рендерера может опоздать — к тому времени
  // разрешение уже устарело и автомат вернулся в исходное; принять строку тогда значит зарядить
  // её к следующему, ни о чём не подозревающему разрешению.
  if (!d.rs || d.rs.phase !== 'granted') {
    restartLog(`вкладка ${id}: строка запуска пришла не ко времени (фаза ${d.rs ? d.rs.phase : '—'})`);
    return { ok: false };
  }
  const built = restartLaunchLine(d.launchCmd, String(opts.sessionKey || ''), d.mode);
  const line = restart.launchLine(built.cmd, opts.prompt || '', shellFamily(pickShell()));
  if (!line) {
    // Пустая база — вкладка, которую мы не запускали (чистый терминал, агент набран руками).
    restartNote(id, 'не знаю, чем её запускать — перезапуск отменён');
    d.rs = { ...restart.initial(), retryAt: Date.now() + restart.RETRY_MS };
    return { ok: false };
  }
  d.rsPendingLine = line;
  d.rsPendingBase = built.cmd;
  d.rsPendingSession = built.sessionId || null;
  d.rsKey = String(opts.sessionKey || '') || null;
  restartLog(`вкладка ${id}: строка запуска готова, ярлык ${d.rsKey || '—'}`);
  // Гасить прежнего агента теперь есть чем — и ждать общего такта незачем: строка приходит через
  // миллисекунды после разрешения, а такт добавлял к ним до полминуты пустого стояния.
  restartKick(id, d, 'line');
  return { ok: true };
});

// Жив ли процесс. Сигнал 0 ничего не посылает, только проверяет доступность: EPERM значит
// «процесс есть, но чужой» — для нас это тоже «жив». Работает и на винде.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// Кто крутится в оболочке вкладки прямо сейчас — её первый потомок. Спрашиваем СИСТЕМУ, каждый
// раз заново: общий обход процессов идёт раз в пять секунд, и его номер к моменту сигнала мог уже
// достаться другому процессу.
//
// Винда отвечает на тот же вопрос через PowerShell: `ps`/`pgrep` там нет, но список процессов с
// их родителями есть, и он ничем не хуже. PowerShell стоит в самой системе, ставить ничего не
// нужно. Не ответил — зовущий останется на прежнем пути (печать `/exit`).
// Потомки оболочки, от старшего к младшему: [{ pid, name }]. Пустой список — «оболочка
// свободна», ошибка — «спросить не смогли», и путать эти два ответа нельзя: первый разрешает
// печатать запуск, второй обязан нас остановить.
//
// Спрашиваем `ps`, а не `pgrep`. Это не вкусовщина: `pgrep -P` на маке (26.3.1, проверено на
// живых процессах приложения) НЕ ВИДИТ как раз наши процессы — у оболочки вкладки он отвечает
// «потомков нет», хотя `ps` показывает там работающего агента. Код на pgrep был мёртвым: он
// всегда откатывался на печать `/exit`, и заметить это по тестам было нельзя — процессы,
// поднятые самим тестом, pgrep находит прекрасно.
//
// `ps -eo pid=,ppid=,args=` — тот же вызов, которым приложение уже определяет занятость оболочки
// (scanTabProcesses), то есть источник заведомо рабочий. Плюс он даёт КОМАНДНУЮ СТРОКУ, а не
// «имя процесса»: Клод переписывает себе имя, и в нём бывает что угодно, вплоть до номера версии.
//
// Коды возврата: `ps` отвечает нулём и на пустой список, так что ошибка здесь означает ровно
// «спросить не смогли». У PowerShell так же: 0 — ответил (пусто значит пусто), иначе беда.
function shellChildren(shellPid, cb) {
  const isWin = os.platform() === 'win32';
  const done = (err, out) => {
    if (err) { cb(err, []); return; }
    const list = String(out || '').trim().split('\n').map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), name: m[2].trim() } : null;
    }).filter((e) => e && e.pid);
    cb(null, list);
  };
  if (isWin) {
    // Родителя винда помнит ЧИСЛОМ и не забывает, когда родитель умер, а номера переиспользует
    // куда охотнее юникса. Поэтому «потомок» без второй проверки — это в том числе чужой
    // процесс, чей давно почивший родитель когда-то носил наш номер. Отсекаем по времени: наш
    // потомок не мог родиться раньше самой оболочки.
    const q = '$ErrorActionPreference = "Stop"; try {'
      + ` $s = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(shellPid)}";`
      + ` Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(shellPid)}"`
      + ' | Where-Object { $_.CreationDate -ge $s.CreationDate }'
      + ' | Sort-Object CreationDate | ForEach-Object { "$($_.ProcessId) $($_.Name)" }'
      + ' } catch { exit 3 }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q],
      { windowsHide: true }, done);
    return;
  }
  execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 4 << 20 }, (err, out) => {
    if (err) { cb(err, []); return; }
    const rows = [];
    for (const line of String(out).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || Number(m[2]) !== Number(shellPid)) continue;
      rows.push(String(m[1]) + ' ' + m[3].trim());
    }
    done(null, rows.join('\n'));
  });
}

// Закрыть агента. На маке и линуксе это вежливая просьба (SIGTERM): процесс закрывается сам и
// успевает прибрать за собой.
//
// У винды вежливого сигнала консольному процессу нет вовсе — там любое закрытие снаружи
// принудительное, и это не наш выбор, а свойство системы. Зовём `taskkill` с деревом (/T):
// `claude` там обычно поднимается через .cmd-обёртку, и закрытие одной обёртки оставило бы
// настоящий процесс жить сиротой — оболочка бы не освободилась, а мы бы ждали и отменили
// перезапуск. Потерять при этом нечего: разговор Клод дописывает в стенограмму по ходу дела, а
// эстафета к этому моменту уже лежит файлом.
function killAgent(pid, cb) {
  if (os.platform() === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => cb(err));
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    // И будим следом. Остановленному (Ctrl+Z) процессу SIGTERM доставлен не будет: он повиснет
    // до пробуждения, а `kill` при этом отчитается успехом. Мы бы решили, что закрыли агента, и
    // ждали бы час освободившейся оболочки, которая не освободится никогда.
    try { process.kill(pid, 'SIGCONT'); } catch (_) { /* уже ушёл — тем лучше */ }
    cb(null);
  } catch (e) { cb(e); }
}

// Погасить прежнего агента. Закрываем ПРОЦЕСС, а не просим агента выйти буквами в поле ввода.
//
// Печать `/exit` стоила нам всего класса поломок, и каждая тихая: текст склеивается с тем, что
// человек не дописал и забыл в поле, — тогда не выходит никто; Enter, идущий следом, попадает в
// список команд по префиксу или в рамку запроса разрешения — тогда приложение подтверждает то,
// чего человек не видел. Плюс момент выхода приходилось УГАДЫВАТЬ по опросу процессов раз в пять
// секунд и по мебели на экране, и вкладка стояла голой оболочкой до полуминуты — ровно в это
// окно человек и починил всё руками, потеряв наши флаги.
//
// С закрытием процесса ничего этого нет: поле ввода в схеме не участвует вовсе, а освобождение
// оболочки видно точно и сразу. Зависшего не добиваем — ждём его столько же, сколько ждали бы
// после напечатанного `/exit` (PENDING_MS в restart.js), и отменяем перезапуск, пока агент жив.
//
// Путь один на всех платформах: винда отвечает на «кто потомок этой оболочки» через PowerShell,
// а закрывает через taskkill (см. shellChildren и killAgent). Прежняя печать `/exit` осталась
// только отступлением на случай, когда систему не спросить вовсе.
function restartExit(id, d) {
  // Первым делом — мост: с этой строки сессия считается уходящей, и её вопрос человеку больше не
  // адресован (см. tgOnRestartExit). Раньше почты, потому что печать в pty может и бросить.
  tgOnRestartExit(id, d);
  const child = sessions.get(id);
  const shellPid = child && child.pid != null ? Number(child.pid) : 0;
  const typeInstead = (why) => {
    d.rsSignalled = false;
    restartLog(`вкладка ${id}: ${why} — печатаю /exit`);
    restartType(id, '/exit');
  };
  if (!shellPid) { typeInstead('оболочки уже нет'); return; }
  // Ответ системы приходит асинхронно, а за это время фаза могла смениться: агента закрыл сам
  // человек, такт напечатал запуск, вкладку закрыли. Всё, что ниже, тогда било бы по СВЕЖЕЙ
  // сессии — печатало бы ей `/exit` или закрывало по устаревшему номеру.
  const stillExiting = () => sessions.has(id) && d.rs && d.rs.phase === 'exiting';
  shellChildren(shellPid, (err, pids) => {
    if (!stillExiting()) return;
    // Систему не спросить — остаёмся на прежнем пути.
    if (err) { typeInstead('потомков оболочки не спросить'); return; }
    // Потомков нет: агент ушёл сам, пока мы собирались. Закрывать некого и печатать нечего —
    // такт увидит свободную оболочку и напечатает в неё запуск.
    if (!pids.length) { restartLog(`вкладка ${id}: оболочка уже свободна — закрывать некого`); return; }
    // Кого именно закрывать. В оболочке вкладки может висеть и чужое: job, отправленный человеком
    // в фон, приостановленный Ctrl+Z процесс, неприбранный зомби. Поэтому сначала ищем потомка ПО
    // ИМЕНИ — тому, которым вкладку запускали, — и только если такого нет, берём самого свежего.
    // Одного «самого свежего» мало: человек, приостановивший агента и запустивший что-то другое,
    // получил бы закрытым как раз своё.
    //
    // Имя может и не совпасть (алиас `claude-my` виден в процессах как `claude`), поэтому это
    // предпочтение, а не условие. Ошибиться всё равно можно, и именно поэтому запуск печатается
    // не по смерти ЭТОГО номера, а только когда оболочка опустела совсем.
    const wanted = [launcherOf(d.launchCmd), d.runCmd]
      .map((w) => path.basename(String(w || '')).toLowerCase().replace(/\.exe$/, ''))
      .filter(Boolean);
    // Имя потомка — первое слово его командной строки, как и `d.runCmd` у вкладки: сравнивать
    // надо одинаково добытые вещи, иначе совпадений не будет никогда.
    const nameOf = (e) => path.basename(String(e.name).trim().split(/\s+/)[0] || '')
      .toLowerCase().replace(/\.exe$/, '');
    const named = pids.filter((e) => wanted.includes(nameOf(e)));
    const pick = (named.length ? named : pids)[(named.length ? named : pids).length - 1];
    const pid = pick.pid;
    // Пид оболочки не трогаем ни при каких обстоятельствах: это убьёт вкладку целиком. Своим
    // потомком процесс быть не может, так что проверка лишняя — но цена ошибки здесь такая, что
    // пусть лучше будет лишняя.
    if (pid === shellPid) { typeInstead('потомок совпал с оболочкой'); return; }
    killAgent(pid, (e) => {
      if (!stillExiting()) return;
      // Ошибка при УЖЕ УШЕДШЕМ процессе — это не ошибка: агент закрылся сам между вопросом и
      // закрытием, и `taskkill`/`kill` честно сказали, что закрывать нечего. Считаем такое
      // успехом, иначе мы бы зря напечатали `/exit` в свободную оболочку.
      if (e && pidAlive(pid)) {
        typeInstead(`закрыть не вышло (${(e && e.code) || 'ошибка'})`);
        return;
      }
      d.rsSignalled = true;
      d.rsKillPid = pid;
      restartLog(`вкладка ${id}: закрываю агента (pid ${pid})`);
    });
  });
}

ipcMain.on('settings:restart', (_e, opts = {}) => {
  const was = RESTART_ENABLED;
  RESTART_ENABLED = !!(opts && opts.enabled);
  RESTART_PCT = restart.clampPct(opts && opts.threshold);
  restartLog(`настройка: ${RESTART_ENABLED ? 'вкл' : 'выкл'}, порог ${RESTART_PCT}%`);
  // Хук читает это из файла режимов: снятая галочка должна закрыть агенту и дверь самозвона, а
  // не только наши вопросы на пороге.
  tgWriteModes();
  if (was && !RESTART_ENABLED) {
    // Висящий вопрос снимаем вместе с функцией. Иначе он переживёт выключение, агент допишет
    // ответ в файл, и первый же тик после будущего включения исполнит вчерашнее «можно» — стерев
    // разговор, в котором с тех пор работали. Заодно снимаем немоту: включая функцию заново,
    // человек вправе ждать, что она попробует ещё раз.
    //
    // Фазу exiting НЕ трогаем: там `/exit` уже ушёл агенту, и бросить вкладку голой оболочкой
    // хуже, чем довести начатое. Её автомат доведёт сам — тик про заготовку идёт до проверки
    // галочки.
    for (const [id, d] of det) {
      if (!d || !d.rs || d.rs.phase === 'exiting' || d.rs.phase === 'idle') continue;
      d.rs = restart.initial();
      restartClearPending(d);
      try { fs.unlinkSync(restartAnswerFile(id, d)); } catch (_) {}
      restartLog(`вкладка ${id}: функцию выключили — снимаю висящий вопрос`);
    }
  }
});

// --- IPC: renderer asks main to spawn a new claude session -------------------
ipcMain.handle('session:create', (_event, opts = {}) => {
  const id = String(nextId++);
  const shell = pickShell();
  const isWin = os.platform() === 'win32';
  // Restored tabs may point at a folder that no longer exists — fall back safely.
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : defaultWorkdir();

  // Build the launch line BEFORE the shell exists: our long flag values are handed
  // over in this shell's environment (see envPassing), so they have to be collected
  // while we can still set it.
  const pass = envPassing(shell);
  const pinned = injectSessionId(injectPermissionMode(
    injectAgentRules(injectStatusline(opts.command != null ? opts.command : START_COMMAND, pass), pass)));
  const cmd = pinned.cmd;

  const child = pty.spawn(shell, isWin ? [] : ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    // <-- inherits your Claude Code auth. Do not strip. Our own SWARM_* additions carry
    // the flag values that would otherwise be echoed across half the screen. Вычищаются
    // только метки Клод-сессии, из которой запустили сам сворм: см. tabEnv.
    env: { ...tabEnv(process.env), ...pass.env },
  });

  sessions.set(id, child);
  const d0 = makeDetector(opts.cols, opts.rows);
  d0.cwd = cwd;                       // the transcript lives under a slug of this path
  d0.tabKey = String(opts.tabKey || '');   // survives relaunch: the Telegram topic key
  d0.name = String(opts.name || '');
  // Мандат «работай без меня» принадлежит вкладке, а не сеансу приложения: сохраняется рядом с
  // именем и папкой (persistTabs) и возвращается сюда при восстановлении. Иначе обновление
  // сворма молча забирало бы у отданных вкладок разрешение работать.
  d0.auto = !!opts.auto;
  det.set(id, d0);
  if (d0.auto) { const was = autoAny(); tgWriteModes(); autoAfterChange(was); }

  child.onData((data) => {
    feedDetector(id, data);
    safeSend('session:data', { id, data });
  });

  child.onExit(({ exitCode }) => {
    tgOnTabGone(det.get(id));
    // Наши служебные файлы лежат в папке вкладки, то есть в чужом репозитории. Обычно они живут
    // секунды, но если вкладку закрыли между записью и чтением — остались бы висеть в `git status`.
    restartSweepCwd(id, det.get(id));
    sessions.delete(id);
    ptyOut.drop(id);                    // хвост печати мёртвой вкладке досылать некуда
    safeSend('session:exit', { id, code: exitCode });
  });

  // Known id => exact transcript binding. Either we pinned it just now (a fresh tab),
  // or the renderer is restoring a conversation and told us the id it is resuming —
  // `--resume <id>` keeps that id, so the tab binds precisely from the first tick
  // instead of guessing by folder + mtime.
  d0.claudeSessionId = pinned.sessionId || String(opts.resumeId || '') || null;
  // Give the login shell a moment to finish sourcing the profile, then run claude —
  // preceded by a `clear`, so what the user sees first is the agent and not the line we
  // typed for them.
  // Строку запуска ЗАПОМИНАЕМ целиком: самоперезапуск стартует свежую сессию именно ей, только
  // с новыми метками разговора. Пересобрать её заново он не может — ссылки на окружение
  // (--settings, правило обращения) живут в окружении ЭТОГО pty, а оно задаётся один раз здесь.
  d0.launchCmd = cmd || '';
  d0.sessionStartAt = Date.now();
  if (cmd) {
    setTimeout(() => {
      // Вкладку могли закрыть за эти 350 мс — тогда и отметок о запуске быть не должно.
      if (!ptyType(id, clearPrefix(shell) + cmd + '\r')) return;
      // С этой секунды в шелле крутится НАШ запуск (см. scanTabProcesses): чем он развернулся,
      // вкладке знать незачем — она помнит команду, которую выбрал человек.
      d0.launchAt = Date.now();
      d0.launchPid = null;
    }, 350);
  }

  // The renderer keeps claudeSessionId with the tab and saves it: that id is what the
  // NEXT launch resumes. Null for non-Claude tabs and clean terminals.
  return { id, cwd, claudeSessionId: d0.claudeSessionId };
});

// Is this conversation still on disk? Asked before a restored tab runs `--resume <id>`:
// a dead id would drop the tab into Claude's interactive picker (or an error) instead of
// a working agent, so we'd rather start it fresh.
//
// The folder slug is a guess (see transcript.projectSlug), so a miss falls back to a
// scan of ~/.claude/projects — the file NAME is the session id and is unique, whatever
// folder Claude filed it under.
//
// И конфигов тоже несколько: вкладка, запущенная с CLAUDE_CONFIG_DIR (алиас `claude-my`),
// пишет разговор в ~/.claude-my, а здесь искали только в ~/.claude. Ответ был «разговора нет»,
// и вкладка после каждого перезапуска приложения открывалась ПУСТОЙ вместо возобновления —
// самая дорогая цена одного зашитого пути. См. configRoots.
ipcMain.handle('session:canResume', (_e, cwd, sessionId) => {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return false;
  const file = id + '.jsonl';
  try {
    if (cwd) {
      for (const dir of projectDirs(cwd)) if (fs.existsSync(path.join(dir, file))) return true;
    }
    // Промах по слагу — ищем шире, но найденное ПРОВЕРЯЕМ по записанной внутри папке.
    // `--resume` разрешает разговор в пределах текущей папки, поэтому файл из чужого проекта
    // — это ложное «да»: вкладка снова упирается в «сессия не найдена», то есть ровно в тот
    // тупик, от которого эта проверка и поставлена.
    for (const root of configRoots()) {
      const projects = path.join(root, 'projects');
      let dirs = [];
      try { dirs = fs.readdirSync(projects); } catch (_) { continue; }
      for (const dir of dirs) {
        const full = path.join(projects, dir, file);
        if (fs.existsSync(full) && sessionCwdIs(full, cwd)) return true;
      }
    }
  } catch (_) {}
  return false;
});

// Начало файла стенограммы: и имя разговора, и папка лежат в его первых записях, поэтому
// больше читать незачем.
function sessionHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    return buf.slice(0, read).toString('utf8');
  } catch (_) { return ''; }
  finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
}

// Этот разговор действительно про эту папку? Сравниваем с записанным внутри cwd, а не с именем
// папки-слага: слаг мы угадываем (см. transcript.projectSlug), а запись внутри точна.
//
// Первая строка не обязана быть той, где есть cwd (в начале файла бывают служебные записи —
// сводка, снимок истории файлов), поэтому идём по строкам до первой, которая его называет. Не
// нашли ни одной — отвечаем «нет»: это проверка, а не догадка.
function sessionCwdIs(file, cwd) {
  const want = String(cwd || '');
  if (!want) return false;
  for (const line of sessionHead(file).split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let d;
    try { d = JSON.parse(t); } catch (_) { continue; }   // хвост обрезан по 4 КБ — обычное дело
    if (d && typeof d.cwd === 'string') return d.cwd === want;
  }
  return false;
}

// ТОЛЬКО папка этой вкладки — и это принципиально, по двум причинам.
//
// Правильность: `--resume` разрешает разговор в пределах текущей папки, поэтому имя, найденное
// в другом проекте, — ложное «да», и вкладка снова упирается в «сессия не найдена».
//
// Цена: раньше здесь перебирались ВСЕ папки из ~/.claude/projects и читалось по 4 КБ из каждого
// файла — синхронно, в main-процессе, на каждую восстанавливаемую вкладку. У кого сорок
// проектов по двести разговоров, у того это тысячи чтений на вкладку, то есть ступор
// приложения при старте. И происходило это ровно у всех сразу — на первом запуске после
// обновления, когда у сохранённых вкладок ещё нет id разговора.
//
// Не нашли — вкладка просто стартует свежей. Это то же поведение, что и при ненайденном имени
// раньше, и оно строго лучше, чем возобновление в тупик.
// Папка эта — но во всех конфигах: вкладка с CLAUDE_CONFIG_DIR (алиас `claude-my`) держит свои
// разговоры в другом (см. configRoots), и здесь её имя не находилось, то есть вкладка
// открывалась пустой. Про цену помним: идём от САМЫХ СВЕЖИХ файлов и останавливаемся на первом
// совпадении — разговор, который вкладка возобновляет, почти всегда среди последних, — а число
// прочитанных начал ограничиваем, чтобы папка с сотнями разговоров не тормозила старт.
const RESUME_HEADS_MAX = 120;

ipcMain.handle('session:canResumeName', (_e, cwd, name) => {
  const want = String(name || '').trim();
  if (!/^swarm-[0-9a-z]{4,16}$/i.test(want)) return false;
  if (!cwd) return false;
  const files = [];
  for (const dir of projectDirs(cwd)) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (_) { continue; }
    for (const n of names) {
      const file = path.join(dir, n);
      try { files.push({ file, mtimeMs: fs.statSync(file).mtimeMs }); } catch (_) {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, RESUME_HEADS_MAX)) {
    if (sessionHead(f.file).includes(`"customTitle":"${want}"`)) return true;
  }
  return false;
});

// --- IPC: на какую вкладку человек смотрит прямо сейчас ----------------------
// Единственное, чего main о человеке не знает вовсе: активная вкладка живёт в окне, а фокус
// приложения — свойство окна. Обе половины нужны вместе: вкладка на переднем плане в свёрнутом
// (или просто неактивном) окне никем не читается, и считать её прочитанной — то же самое, что
// не иметь пометки вовсе.
//
// Ровно эту пару окно уже применяет к уведомлениям — «не звать про вкладку, в которую человек
// смотрит в упор». Здесь она нужна второму потребителю (unread.js), поэтому окно называет её
// сообщением, а не каждый читает по-своему.
let VIEWING = { id: null, focused: false };

function viewingNow(id) {
  return !!id && !!VIEWING.focused && VIEWING.id === id;
}

ipcMain.on('tabs:viewing', (_event, { id, focused }) => {
  VIEWING = { id: id || null, focused: !!focused };
  const d = id ? det.get(id) : null;
  if (d && VIEWING.focused) d.unread = unread.onViewed(d.unread);
});

// --- IPC: keystrokes from the xterm in the renderer --------------------------
ipcMain.on('session:input', (_event, { id, data }) => {
  // Нажатие клавиши уезжает синхронно, как раньше, а вставка из буфера — порциями: ваш
  // многострочный текст в терминале это такой же килобайт в pty, как и строка перезапуска,
  // и вешал он приложение точно так же. См. ptyType.
  ptyType(id, data);
  // Your keystrokes echo back + redraw the input box — that's you typing, not the
  // agent working. Grace it so it isn't counted as activity.
  const d = det.get(id);
  if (!d) return;
  // You're at the keyboard for this tab, so it is no longer «driven from the phone»:
  // full-size answers and interactive pickers are useful again. The mode follows where
  // YOU are, not where the last message came from.
  //
  // Но «за компьютером» — это ОТПРАВИЛ СООБЩЕНИЕ, а не «пошевелил чем-нибудь». Раньше режим
  // снимался на любом непустом байте, и потому его снимала мышь: Клод умеет включать отчёты о
  // мыши, и клик в терминале уходит сюда как последовательность. Человек ничего не отправлял —
  // а ответ на свой же вопрос с телефона уже не получал.
  //
  // Печать и Enter приходят разными событиями, поэтому «напечатал» помним до отправки. Enter
  // без печати сообщением не считается: он лишь досылает то, что уже лежит в поле ввода, а это
  // обычно текст из телеги, которому не хватило отправки (см. detector.keyboardEvent).
  const k = keyboardEvent(data);
  if (k.typed) d.typedAtKeyboard = true;
  // За клавиатурой печатают, а ночь не снята. Само по себе это законно (сел проверить, что
  // там у агентов), но чаще значит «забыл выключить» — а забытая ночь означает, что агенты
  // продолжают решать за человека, который уже сидит рядом. Один раз за ночь напоминаем.
  if (k.typed || k.submit) nightOnKeyboard();
  if (k.submit) {
    // Отправленное сообщение закрывает прошлый ответ и открывает ожидание нового: отвечают
    // тому, кого прочитали (см. unread.js). Считаем ЛЮБУЮ отправку, а не только «напечатал и
    // отправил»: голый Enter в рамке разрешения — это тоже ответ человека вкладке, и нажать
    // кнопку он мог, только увидев вопрос.
    d.unread = unread.onHumanSend(d.unread);
    restartWorkAgain(id, d);
    if (d.typedAtKeyboard) {
      tgClearMode(d);
      // И отложенное с телефона отпускаем: ты только что сказал этой вкладке что-то сам, а
      // задержанное сообщение писалось до этого — отдавать его теперь значит вклиниваться в
      // разговор с прошлым вопросом (та же причина, что у d.tgPending в tgCancelWaiting).
      if (d.tgHeld) { tgLog(`  задержанный текст отпущен: вкладке ${id} ответили за компьютером`); d.tgHeld = null; }
    }
    d.typedAtKeyboard = false;
  }
  const now = Date.now();
  if (/[\r\n]/.test(String(data || ''))) {
    // Enter: you SENT something. Don't sit out the grace window — that froze the
    // detector for INPUT_GRACE_MS right when the picture changes fastest, and left
    // lastDataAt stale so the agent's first output didn't read as «работает».
    // This is a hint, not a verdict: a quiz answers one question and paints the
    // next, and detector.js keeps «ждёт» whenever a prompt box is still on screen.
    markAnswered(d, now);
  } else {
    d.graceUntil = now + INPUT_GRACE_MS;
  }
});

// --- IPC: the xterm was resized; keep the pty grid in sync -------------------
ipcMain.on('session:resize', (_event, { id, cols, rows }) => {
  const p = sessions.get(id);
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows); } catch (_) {}
    const d = det.get(id);
    if (d && d.term) {
      try { d.term.resize(cols, rows); } catch (_) {}
      d.graceUntil = Date.now() + RESIZE_GRACE_MS;
    }
  }
});

// --- IPC: close a tab --------------------------------------------------------
ipcMain.on('session:kill', (_event, { id }) => {
  // BEFORE the detector goes away: the Telegram side needs it to know which topic to close
  // and which timer to cancel. Dropping it first is why closing a tab left its topic open.
  tgOnTabGone(det.get(id));
  const p = sessions.get(id);
  if (p) {
    try { p.kill(); } catch (_) {}
    sessions.delete(id);
  }
  det.delete(id);
});

// --- IPC: в вкладке запустили другого агента РУКАМИ ---------------------------
// Тогда строка, которой её открыл сворм, больше не про неё: в ней стоит прежний лончер, а с
// ним и прежний аккаунт. Самоперезапуск по заполнению контекста стартует именно эту строку —
// то есть ночью, когда никто не смотрит, вернул бы рабочую подписку в вкладку, которую днём
// перевели на личную. Молча и с чужими лимитами.
//
// Поэтому строку ЗАБЫВАЕМ, а не пересобираем под новый лончер: собрать её мы не можем (флаги
// человека нам неизвестны, а ссылки на окружение живут в этом pty), и лучше честный отказ
// «не знаю, чем её запускать» в журнале перезапуска, чем тихо не тот аккаунт. Открыть вкладку
// другой командой без этой потери можно с «+» на папке — там выбор наш и строка наша.
ipcMain.on('session:forgetLaunch', (_event, { id } = {}) => {
  const key = String(id == null ? '' : id);
  const d = det.get(key);
  if (!d || !d.launchCmd) return;
  d.launchCmd = '';
  restartLog(`вкладка ${key}: агента запустили руками — забыл строку запуска`);
  // Забыть строку МАЛО, если перезапуск уже заряжен. Строку автомат спрашивает один раз, при
  // разрешении, и дальше держит готовой у себя (rsPendingLine): `hasLine` — это про заготовку, а
  // не про launchCmd, так что фаза granted доедет до конца и с забытой строкой. А доехав, ещё и
  // вернёт launchCmd на место (restartFire) — то есть воскресит лончер, который мы только что
  // стёрли. Окно узкое, но это ровно наше окно: заготовка ждёт спокойной вкладки, и человек
  // гасит агента и запускает другой аккаунт именно в такую минуту.
  //
  // Фазу exiting не трогаем — как и при выключении функции: `/exit` уже ушёл, и обрывать начатое
  // хуже. Она безопасна сама: пока в оболочке живёт агент, автомат не печатает ничего и через час
  // отменяется сам.
  // Немоту тоже оставляем: сброс вернул бы в строй вкладку, которая уже сдалась спрашивать. Ей это
  // теперь не вредит (без строки askable молчит), но и будить её незачем.
  if (!d.rs || ['exiting', 'idle', 'muted'].includes(d.rs.phase)) return;
  d.rs = restart.initial();
  restartClearPending(d);
  // И висящий вопрос вместе с ним: он задан ПРОШЛОМУ агенту, отвечать на него некому, а
  // залежавшийся файл с «можно» исполнил бы вчерашнее разрешение над свежим разговором.
  try { fs.unlinkSync(restartAnswerFile(key, d)); } catch (_) {}
  restartLog(`вкладка ${key}: снял заряженный перезапуск — он был про прежнего агента`);
});

// --- IPC: a UI action is about to repaint terminals; grace ALL detectors -----
// Switching tabs blurs one xterm and focuses another; with focus-reporting on,
// Claude repaints on both focus-out and focus-in. That burst is not real work,
// so we briefly stop counting activity for every session.
ipcMain.on('ui:repaint', () => {
  const until = Date.now() + RESIZE_GRACE_MS;
  for (const d of det.values()) d.graceUntil = until;
});

// --- bring the app forward ----------------------------------------------------
// Общая для двух поводов: клик по уведомлению и попытка запустить второй сворм.
function raiseWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
}

ipcMain.on('app:focus', () => raiseWindow());

// Годится ли рабочая папка второго запуска под новую вкладку.
//
// Смысл проверки в том, что папка есть НЕ ВСЕГДА: запуск из Finder или через `open` даёт
// корень файловой системы — это не проект, и открывать там агента бессмысленно. А вот запуск
// `swarm` из терминала внутри репозитория даёт именно то, что человек имел в виду.
function launchCwd(dir) {
  const p = String(dir || '');
  if (!p) return null;
  if (p === path.parse(p).root) return null;      // «/» на маке, «C:\» на винде — не проект
  try { if (!fs.statSync(p).isDirectory()) return null; } catch (_) { return null; }
  return p;
}

// Вторую копию запустить нельзя (замок выше), но САМА ПОПЫТКА — это осмысленный жест: человек
// пришёл к сворму, и чаще всего из папки, с которой хочет работать. Поэтому не молча
// поднимаем окно, а ещё и открываем в этой папке агента — тем же путём, которым это делает
// /new из телеги (вкладки умеет только рендерер, там xterm и DOM).
app.on('second-instance', (_e, _argv, workingDirectory) => {
  raiseWindow();
  const cwd = launchCwd(workingDirectory);
  if (cwd) safeSend('app:createTab', { cwd });
});

// --- IPC: copy text to the clipboard -----------------------------------------
// The renderer sends the exact string to copy (a terminal selection or a modal's
// DOM selection). We write it via Electron's clipboard, which encodes UTF-8 to the
// pasteboard correctly. This deliberately replaces the Edit-menu's native `copy`
// role: that path read the xterm selection through a byte-mangled route and put
// UTF-8 bytes on the board tagged as MacRoman, so Cyrillic pasted as mojibake.
ipcMain.on('clipboard:write', (_event, text) => {
  try { clipboard.writeText(String(text == null ? '' : text)); } catch (_) {}
});

// Open a URL in the user's default browser (terminal link clicks). We only hand
// http(s) to the OS — anything else (file:, javascript:, custom schemes) is
// dropped so a rogue link in pty output can't launch arbitrary handlers.
ipcMain.on('shell:openExternal', (_event, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
  } catch (_) {}
});

// --- IPC: auto-update ---------------------------------------------------------
// Версия ВЫПОЛНЯЕМОГО кода, а не бандла: после обновления они расходятся (updater.js).
ipcMain.handle('app:version', () => updater.runningVersion());
// Обрыв связи — не ошибка приложения: проверка идёт по таймеру и в фоне, а гитхаб
// бывает недоступен ровно потому, что интернета нет. Раньше такой таймаут падал в «Логи
// ошибок» стеком из updater.js и выглядел как поломка. Отвечаем 'offline' — вызывающая
// сторона сама решит, промолчать (фон) или сказать вслух (проверка по кнопке).
ipcMain.handle('update:check', async () => {
  try { return await updater.checkForUpdate(); }
  catch (e) {
    if (updater.isNetworkError(e)) return { kind: 'offline' };
    reportMainError(e);
    return { kind: 'none' };
  }
});
ipcMain.handle('update:apply', async (_e, { url, sha256, version }) => {
  try {
    const res = await updater.applyPayload({ url, sha256, version }, (pct) => safeSend('update:progress', pct));
    return res && typeof res === 'object' ? res : { ok: true };
  } catch (e) { reportMainError(e); return { ok: false, error: String(e && e.message || e) }; }
});
// «Что уже скачано и ждёт запуска» — чтобы плашка после перезапуска приложения не
// предлагала качать то, что лежит рядом готовым.
ipcMain.handle('update:pending', () => {
  try { return updater.pendingVersion(); }
  catch (e) { reportMainError(e); return ''; }
});
ipcMain.handle('update:installer', async (_e, { url, filename }) => {
  try {
    return await updater.downloadInstaller(url, filename, (pct) => safeSend('update:progress', pct));
  } catch (e) { reportMainError(e); return { ok: false, error: String(e && e.message || e) }; }
});
// Renderer pushes the «precise status via hooks» pref (on startup and on toggle).
// We rewrite swarm-settings.json; the flag is read by claude at launch, so it
// applies to sessions started after the change.
ipcMain.on('settings:hooks', (_e, enabled) => {
  HOOKS_ENABLED = !!enabled;
  try { writeSwarmSettings(); } catch (e) { reportMainError(e); }
});
// И для «новые вкладки стартуют в режиме». Проверяем значение здесь, а не только в панели:
// сюда приходит то, что лежало в localStorage, а там мог остаться режим из версии, где он
// назывался иначе. Неизвестное — это пусто, то есть «не вмешиваться»; подставить с ним флаг
// значило бы, что вкладка вообще не запустится.
ipcMain.on('settings:permissionMode', (_e, mode) => {
  const want = String(mode || '');
  PERMISSION_MODE = modeFlag(want) ? want : '';
});

// Список режимов для селекта в настройках — ОТСЮДА, а не списком в рендерере: подписи и
// сами режимы живут в screen.js (там же, где их читают с экрана), и второй список рядом
// разошёлся бы с первым молча. Порядок — живой круг Shift+Tab, чтобы селект читался как
// то же самое, что человек видит в терминале.
//
// bypass в списке НЕТ намеренно: в круг Shift+Tab он не входит, требует отдельного согласия
// Claude Code, и вкладка, которой флаг не понравился, встречает человека мёртвой оболочкой.
// Кому нужен именно он — пишет флаг в поле флагов сам, и там его никто не перебьёт.
ipcMain.handle('settings:modes', () => {
  return ['manual', 'accept-edits', 'plan', 'auto'].map((id) => ({ id, title: modeTitle(id) }));
});
// Renderer pushes the «agent is calling me» phrases (on startup and on save). Takes
// effect immediately for screen scraping; the hook picks the new file up on its next
// run, so it applies within the current session too.
// The tab's visible name (create + rename). Used to title its Telegram topic and to sign
// its messages, so «→ api» in the chat means the tab you call api.
ipcMain.on('tabs:name', (_e, { id, name } = {}) => {
  const d = det.get(String(id));
  if (!d) return;
  d.name = String(name || '');
  // No topic yet (a new tab, or one restored after a relaunch) → make it now, so you can
  // write to this tab from the phone before it ever speaks. Already has one → a rename,
  // so move the topic's title along with it.
  if (!tgTopicOf(d)) tgEnsureTopics().catch(reportMainError);
  else tgRenameTopic(String(id));
});

ipcMain.on('update:relaunch', () => {
  // Skip the "close app?" confirm — уходим намеренно.
  allowClose = true;
  // Обычный перезапуск на обеих системах: обновление лежит отдельным файлом в папке
  // настроек, установленное приложение не тронуто, занятых файлов нет. Раньше здесь был
  // выход без relaunch, потому что приложение поднимал внешний хелпер после подмены
  // app.asar (см. историю updater.js).
  app.relaunch();
  app.exit(0);
});

// Native app menu. A custom menu REPLACES Electron's default, so we must re-add
// the standard roles (Edit gives ⌘C/⌘V/⌘A — critical in a terminal; View gives
// reload/devtools; Window gives minimize/close), then append our own "Справка".
// The Help item just asks the renderer to open the in-app help overlay.
function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      // Explicit label (not role:'editMenu') so our custom submenu — with the
      // routed Copy — is used instead of the auto-generated one. Copy is NOT the
      // stock `copy` role: that native path mangled the xterm selection's encoding
      // (Cyrillic → MacRoman mojibake). Instead ⌘C asks the renderer to copy — it
      // grabs the terminal/modal selection as a proper string and writes it through
      // clipboard:write. Cut/Paste/Select-All stay native.
      label: 'Правка',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Копировать', accelerator: 'CmdOrCtrl+C', click: () => safeSend('menu:copy') },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Справка',
      submenu: [
        { label: 'Как пользоваться', accelerator: 'CmdOrCtrl+/', click: () => safeSend('open-help') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Offer to move into ~/Applications on macOS so a later asar-swap can write.
  // If it relocates, it exits — don't open a window in that case.
  if (updater.maybeRelocate()) return;
  try { provisionStatusline(); } catch (e) { reportMainError(e); } // bar is best-effort
  // Telegram: pick up a saved token and start polling. Best-effort like the statusline —
  // no bot, or no network, must never hold up the window.
  try { tgLoad(); tgConnect().catch(reportMainError); } catch (e) { reportMainError(e); }
  buildMenu();
  createWindow();
});

// Наши служебные файлы лежат в папках вкладок, то есть в чужих репозиториях. Закрытие вкладки их
// убирает (child.onExit), но выход из приложения на это рассчитывать не даёт: процессы гасятся, и
// до обработчиков дело доходит не всегда. Иначе записка и файл ответа остались бы в git status до
// следующего запуска — и однажды уехали бы в чей-нибудь `git add -A`.
app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  for (const [id, d] of det) restartSweepCwd(id, d);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
