// keybinds.js — terminal input remaps. Dual-mode: attaches to window.SWARM_KEYBINDS
// in the browser (loaded via <script> before renderer.js), and exports via
// module.exports under Node so test/keybinds.test.js can require it.
// NO DOM / xterm here — just data and matching, so it's unit-testable in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_KEYBINDS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // `chord` → full key+mods (newline). `scope` → modifiers only; arrows /
  // Backspace / Delete with those mods move or delete by word / line.
  const ACTIONS = [
    { id: 'newline', kind: 'chord', label: 'Перенос строки' },
    { id: 'word', kind: 'scope', label: 'Слово' },
    { id: 'line', kind: 'scope', label: 'До края строки' },
  ];

  // Canonical bytes Claude / readline understand (not the user's physical chord).
  const BYTES = {
    newline: '\n',
    wordLeft: '\x1bb',       // Esc+b
    wordRight: '\x1bf',      // Esc+f
    wordBackspace: '\x1b\x7f', // Esc+Backspace
    wordDelete: '\x1bd',     // Esc+d
    lineStart: '\x01',       // Ctrl+A
    lineEnd: '\x05',         // Ctrl+E
    lineBackspace: '\x15',   // Ctrl+U
    lineDelete: '\x0b',      // Ctrl+K
  };

  const SCOPE_KEYS = {
    ArrowLeft: { word: 'wordLeft', line: 'lineStart' },
    ArrowRight: { word: 'wordRight', line: 'lineEnd' },
    Backspace: { word: 'wordBackspace', line: 'lineBackspace' },
    Delete: { word: 'wordDelete', line: 'lineDelete' },
  };

  // macOS: ⌘ = word, ⌃ = line. Windows: Ctrl = word, Alt = line.
  const DEFAULT_KEYBINDS_DARWIN = {
    newline: { key: 'Enter', meta: true, ctrl: false, alt: false, shift: false },
    word: { meta: true, ctrl: false, alt: false, shift: false },
    line: { meta: false, ctrl: true, alt: false, shift: false },
  };

  const DEFAULT_KEYBINDS_WIN = {
    newline: { key: 'Enter', meta: false, ctrl: true, alt: false, shift: false },
    word: { meta: false, ctrl: true, alt: false, shift: false },
    line: { meta: false, ctrl: false, alt: true, shift: false },
  };

  // Alias kept for older callers/tests — mac defaults.
  const DEFAULT_KEYBINDS = DEFAULT_KEYBINDS_DARWIN;

  function isDarwin(platform) {
    return platform === 'darwin';
  }

  function defaultsFor(platform) {
    return isDarwin(platform) ? DEFAULT_KEYBINDS_DARWIN : DEFAULT_KEYBINDS_WIN;
  }

  // App shortcuts that must not be stolen by remaps (⌘T / Ctrl+T new, …).
  const RESERVED = [
    { key: 't', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'w', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'o', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'k', meta: true, ctrl: false, alt: false, shift: false },
    { key: ',', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'l', meta: true, ctrl: false, alt: false, shift: false },
    { key: 'j', meta: true, ctrl: false, alt: false, shift: false },
    { key: '1', meta: true, ctrl: false, alt: false, shift: false },
    { key: '2', meta: true, ctrl: false, alt: false, shift: false },
    { key: '3', meta: true, ctrl: false, alt: false, shift: false },
    { key: '4', meta: true, ctrl: false, alt: false, shift: false },
    { key: '5', meta: true, ctrl: false, alt: false, shift: false },
    { key: '6', meta: true, ctrl: false, alt: false, shift: false },
    { key: '7', meta: true, ctrl: false, alt: false, shift: false },
    { key: '8', meta: true, ctrl: false, alt: false, shift: false },
    { key: '9', meta: true, ctrl: false, alt: false, shift: false },
  ];

  function modsEqual(a, b) {
    if (!a || !b) return false;
    return !!a.meta === !!b.meta
      && !!a.ctrl === !!b.ctrl
      && !!a.alt === !!b.alt
      && !!a.shift === !!b.shift;
  }

  function chordEqual(a, b) {
    if (!a || !b) return false;
    return a.key === b.key && modsEqual(a, b);
  }

  // Normalize a stored/captured full chord. Returns null for "unbound" / garbage.
  function normalizeChord(raw) {
    if (raw == null) return null;
    if (typeof raw !== 'object') return null;
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (!key) return null;
    // Modifier-only presses are not valid chord bindings.
    if (['Meta', 'Control', 'Alt', 'Shift', 'MetaLeft', 'MetaRight',
         'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
         'ShiftLeft', 'ShiftRight'].includes(key)) return null;
    return {
      key,
      meta: !!raw.meta,
      ctrl: !!raw.ctrl,
      alt: !!raw.alt,
      shift: !!raw.shift,
    };
  }

  // Scope = modifiers only; at least one required.
  function normalizeScope(raw) {
    if (raw == null) return null;
    if (typeof raw !== 'object') return null;
    const scope = {
      meta: !!raw.meta,
      ctrl: !!raw.ctrl,
      alt: !!raw.alt,
      shift: !!raw.shift,
    };
    if (!scope.meta && !scope.ctrl && !scope.alt && !scope.shift) return null;
    return scope;
  }

  // Extract scope mods from a legacy full chord (wordLeft / lineStart), or from
  // an already-scoped object. Home/End with no mods → null (caller uses default).
  function scopeFromLegacy(raw) {
    if (raw == null || typeof raw !== 'object') return null;
    const scope = normalizeScope(raw);
    if (scope) return scope;
    return null;
  }

  function chordFromEvent(ev) {
    return normalizeChord({
      key: ev.key,
      meta: ev.metaKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
    });
  }

  // Capture modifiers from any keydown (including modifier-only).
  function scopeFromEvent(ev) {
    return normalizeScope({
      meta: ev.metaKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
    });
  }

  function chordMatches(chord, ev) {
    if (!chord) return false;
    return chordEqual(chord, chordFromEvent(ev));
  }

  function scopeMatches(scope, ev) {
    if (!scope) return false;
    return modsEqual(scope, {
      meta: ev.metaKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
    });
  }

  function isReserved(chord) {
    if (!chord || !chord.key) return false;
    // Reserved list is meta-only on mac; also treat ctrl+same-key as reserved on
    // non-mac where the app listener uses ctrl as the accelerator.
    const lower = { ...chord, key: String(chord.key).toLowerCase() };
    for (const r of RESERVED) {
      if (chordEqual(lower, r)) return true;
      if (chordEqual(lower, { ...r, meta: false, ctrl: true })) return true;
    }
    return false;
  }

  // Old storage shape used full chords for wordLeft/lineStart/…. Prefer new
  // `word`/`line` scopes; else migrate mods from legacy keys.
  function resolveScopeRaw(r, id, legacyIds) {
    if (Object.prototype.hasOwnProperty.call(r, id)) return r[id];
    for (const lid of legacyIds) {
      if (Object.prototype.hasOwnProperty.call(r, lid) && r[lid] != null) return r[lid];
    }
    return undefined;
  }

  // Coerce any stored/garbage value into a full keybinds object. Never throws.
  // Missing / invalid → platform default. Explicit null stays null (cleared).
  // On win/linux, leftover mac defaults (⌘…) are rewritten to the Windows set.
  function normalizeKeybinds(raw, platform) {
    const defaults = defaultsFor(platform);
    const r = (raw && typeof raw === 'object') ? raw : {};
    const out = {};

    // --- newline (chord) ---
    if (Object.prototype.hasOwnProperty.call(r, 'newline') && r.newline === null) {
      out.newline = null;
    } else {
      const c = normalizeChord(r.newline);
      if (c && !isReserved(c)) {
        if (!isDarwin(platform) && chordEqual(c, DEFAULT_KEYBINDS_DARWIN.newline)) {
          out.newline = { ...defaults.newline };
        } else {
          out.newline = c;
        }
      } else {
        out.newline = { ...defaults.newline };
      }
    }

    // --- word / line (scopes) ---
    const wordRaw = resolveScopeRaw(r, 'word', ['wordLeft', 'wordRight']);
    const lineRaw = resolveScopeRaw(r, 'line', ['lineStart', 'lineEnd']);

    function pickScope(rawVal, defaultScope, darwinDefault) {
      if (rawVal == null) return { ...defaultScope };
      const s = scopeFromLegacy(rawVal);
      if (!s) return { ...defaultScope };
      if (!isDarwin(platform) && modsEqual(s, darwinDefault)) {
        return { ...defaultScope };
      }
      return s;
    }

    if (Object.prototype.hasOwnProperty.call(r, 'word') && r.word === null) {
      out.word = null;
    } else {
      out.word = pickScope(wordRaw, defaults.word, DEFAULT_KEYBINDS_DARWIN.word);
    }

    if (Object.prototype.hasOwnProperty.call(r, 'line') && r.line === null) {
      out.line = null;
    } else {
      out.line = pickScope(lineRaw, defaults.line, DEFAULT_KEYBINDS_DARWIN.line);
    }

    // Scopes must differ; if equal, keep word and reset line to default (if that
    // still collides, clear line).
    if (out.word && out.line && modsEqual(out.word, out.line)) {
      out.line = { ...defaults.line };
      if (modsEqual(out.word, out.line)) out.line = null;
    }

    return out;
  }

  // Chord-kind match → action id, or null.
  function matchInputKeybind(binds, ev) {
    const b = binds || DEFAULT_KEYBINDS;
    for (const a of ACTIONS) {
      if (a.kind !== 'chord') continue;
      if (chordMatches(b[a.id], ev)) return a.id;
    }
    return null;
  }

  // Scope + Arrow/Backspace/Delete → bytes string, or null.
  function matchScopeInput(binds, ev) {
    const b = binds || DEFAULT_KEYBINDS;
    const map = SCOPE_KEYS[ev.key];
    if (!map) return null;
    if (scopeMatches(b.word, ev)) {
      const id = map.word;
      return id ? BYTES[id] : null;
    }
    if (scopeMatches(b.line, ev)) {
      const id = map.line;
      return id ? BYTES[id] : null;
    }
    return null;
  }

  // Combined: newline chord or scope input → bytes to send, or null.
  function matchInputBytes(binds, ev) {
    const action = matchInputKeybind(binds, ev);
    if (action && BYTES[action]) return BYTES[action];
    return matchScopeInput(binds, ev);
  }

  const KEY_LABELS = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Esc',
    Home: 'Home',
    End: 'End',
    ' ': 'Space',
  };

  function modParts(mods, platform) {
    if (!mods) return [];
    const parts = [];
    if (isDarwin(platform)) {
      if (mods.ctrl) parts.push('Ctrl');
      if (mods.alt) parts.push('Option');
      if (mods.shift) parts.push('Shift');
      if (mods.meta) parts.push('Cmd');
    } else {
      if (mods.ctrl) parts.push('Ctrl');
      if (mods.alt) parts.push('Alt');
      if (mods.shift) parts.push('Shift');
      if (mods.meta) parts.push('Win');
    }
    return parts;
  }

  // Ordered list of keycap labels for a chord (modifiers then key). Empty if unbound.
  function chordParts(chord, platform) {
    if (!chord) return [];
    const parts = modParts(chord, platform);
    if (chord.key) {
      const k = KEY_LABELS[chord.key]
        || (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
      parts.push(k);
    }
    return parts;
  }

  // Scope display = modifiers only.
  function scopeParts(scope, platform) {
    return modParts(scope, platform);
  }

  function formatChord(chord, platform) {
    if (!chord) return 'не задано';
    return chordParts(chord, platform).join('+');
  }

  function formatScope(scope, platform) {
    if (!scope) return 'не задано';
    const parts = scopeParts(scope, platform);
    return parts.length ? parts.join('+') : 'не задано';
  }

  // Binding display for Settings: chord or scope depending on action kind.
  function bindingParts(actionId, binding, platform) {
    const a = ACTIONS.find((x) => x.id === actionId);
    if (!a || !binding) return [];
    return a.kind === 'scope' ? scopeParts(binding, platform) : chordParts(binding, platform);
  }

  function formatBinding(actionId, binding, platform) {
    const a = ACTIONS.find((x) => x.id === actionId);
    if (!a || !binding) return 'не задано';
    return a.kind === 'scope' ? formatScope(binding, platform) : formatChord(binding, platform);
  }

  return {
    ACTIONS,
    BYTES,
    SCOPE_KEYS,
    DEFAULT_KEYBINDS,
    DEFAULT_KEYBINDS_DARWIN,
    DEFAULT_KEYBINDS_WIN,
    RESERVED,
    defaultsFor,
    normalizeChord,
    normalizeScope,
    normalizeKeybinds,
    chordFromEvent,
    scopeFromEvent,
    chordEqual,
    modsEqual,
    chordMatches,
    scopeMatches,
    isReserved,
    matchInputKeybind,
    matchScopeInput,
    matchInputBytes,
    chordParts,
    scopeParts,
    bindingParts,
    formatChord,
    formatScope,
    formatBinding,
  };
});
