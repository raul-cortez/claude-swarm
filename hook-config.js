'use strict';
// The `hooks` block we add to swarm-settings.json, which the app already passes to
// Claude via `--settings` — scoped to swarm-spawned sessions only, never the user's
// global ~/.claude/settings.json. Every event we track points at the same launcher;
// the script (hooks/swarm-signal.mjs) switches on hook_event_name. Kept pure so the
// event set is pinned by a test — a wrong/missing event name means that signal just
// silently never fires. Event names mirror swarm-signal.mjs's tokenFor.
function hookSettings(command) {
  const entry = [{ hooks: [{ type: 'command', command }] }];
  return {
    UserPromptSubmit: entry,   // → busy (working)
    Stop: entry,               // last_assistant_message calls me → ask, else idle
    Notification: entry,       // permission_prompt → perm; напоминания про неотвеченный
                               // ввод → nag / lull (они рамку не отменяют)
    PermissionRequest: entry,  // → perm (разрешение)
    PreToolUse: entry,         // AskUserQuestion → box (рамка на экране), else busy
    PostToolUse: entry,        // → busy: a tool finished, so work resumed. Without
                               // it an approved permission stays «ждёт» until the
                               // next tool starts.
    SessionStart: entry,       // статуса не даёт: это единственный миг, когда агенту можно
                               // положить в контекст одну строку — что он вправе позвать
                               // перезапуск сам (см. selfRestartNote в swarm-signal.mjs).
    SubagentStop: entry,       // → subend: подагент закончил. Парный к `sub`, который
                               // приходит с его шагов через те же Pre/PostToolUse.
  };
}

module.exports = { hookSettings };
