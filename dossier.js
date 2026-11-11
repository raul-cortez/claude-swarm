'use strict';
// dossier.js — a tab's memory that outlives its sessions.
//
// Every tab gets two files in <userData>/tabs/<tabKey>/:
//   dossier.md — the rules of the work: the person's brief, task-wide rules, temporary
//                remarks with an expiry event, notes the agent leaves for its successor;
//   work.md    — the live handoff: how to get back in, the plan, where we stand, what's
//                next, what is running and where.
// The agent edits them; the app only seeds them, watches them and hands them over.
//
// The raw queue is the conversation transcript Claude Code writes itself. The app keeps a
// mark — «the dossier has digested everything up to here» — as the timestamp of the latest
// transcript entry at the moment the dossier last changed. When a session dies (context
// restart, crash), the next one gets the dossier, the work file and the verbatim tail of
// the old transcript after the mark, plus messages that were typed while the agent was
// busy and never delivered (`queue-operation enqueue` without a matching removal — stand
// 2026-11-11: such a message survives SIGKILL in the log, but `--resume` drops it).
//
// Pure: takes already-read text and plain values, returns values. File I/O lives in main.js,
// texts for the agent live in hooks/swarm-signal.mjs (which can't import app modules, so the
// file names there are duplicated and pinned by a test).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_DOSSIER = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DIR = 'tabs';
  const FILES = { dossier: 'dossier.md', work: 'work.md', inherit: 'inherit.md', state: 'state.json' };
  const HISTORY = 'history';
  const HISTORY_KEEP = 5;
  const ARCHIVE = 'archive';
  const ARCHIVE_DAYS = 30;
  // How many of the person's messages may pile up after the mark before we nudge the agent.
  const NUDGE_AFTER = 5;
  // Cap on the tail handed to a fresh session. The person's own words are never dropped
  // whole; the agent's prose goes first, oldest first.
  const TAIL_MAX = 12000;

  // A tab key from the renderer is opaque; on disk it must be a plain folder name.
  function safeKey(key) {
    return String(key == null ? '' : key).replace(/[^\w.-]/g, '_');
  }

  function templates() {
    return {
      dossier: [
        '# Досье вкладки',
        '',
        '## Задача',
        '<!-- Бриф человека, близко к его словам. Меняется только по его слову. -->',
        '- Цель:',
        '- Готово, когда:',
        '- Рамки:',
        '',
        '## Правила задачи',
        '<!-- Действуют до конца задачи. Запись: одна строка, в конце (человек, ДД.ММ) или (я, ДД.ММ). -->',
        '',
        '## Пока',
        '<!-- Временное. У каждой записи — [до: событие], по которому она отпадёт. -->',
        '',
        '## Заметки себе',
        '<!-- Что выяснил сам и что пригодится тому, кто придёт после. -->',
        '',
        '## Открытое',
        '<!-- Твой вопрос человеку без ответа; то, к чему договорились вернуться. -->',
        '',
      ].join('\n'),
      work: [
        '# Работа вкладки',
        '',
        '## Вход',
        '<!-- Как вернуться в работу с нуля: команда/скилл, папка или worktree, что сделать первым, чего НЕ делать. -->',
        '',
        '## План',
        '<!-- Шаги с [x] / [ ]. Если план живёт у команды (задача, файл плана) — ссылка и номер шага, без копии. -->',
        '',
        '## Где стою',
        '<!-- Текущий шаг и что в нём недоделано. -->',
        '',
        '## Дальше',
        '<!-- 1–3 конкретных действия. -->',
        '',
        '## Хозяйство',
        '<!-- Что запущено и где лежит: worktree, ветки, порты, фоновые процессы, тестовые учётки. -->',
        '',
        '## Как проверить',
        '',
      ].join('\n'),
    };
  }

  // Seeded but never touched: nothing in it except headings and hints. The hook nags about
  // an empty dossier, so «exists» is not the same as «written».
  function isBlank(text, which) {
    const t = templates()[which || 'dossier'];
    const strip = (s) => String(s == null ? '' : s).replace(/<!--[\s\S]*?-->/g, '')
      .split('\n').map((l) => l.trim()).filter((l) => l && !/^#/.test(l) && !/^-\s*[^:]*:\s*$/.test(l)).join('\n');
    return strip(text) === strip(t);
  }

  // --- transcript ------------------------------------------------------------
  // All lines of a .jsonl that parse, in file order. Unlike transcript.parseEntries we keep
  // every type: queue operations and queued-command attachments are exactly what we need.
  function parseLines(text) {
    const out = [];
    for (const line of String(text == null ? '' : text).split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try { const e = JSON.parse(t); if (e && typeof e === 'object') out.push(e); } catch (_) { /* partial line */ }
    }
    return out;
  }

  function tsOf(e) {
    const t = Date.parse((e && e.timestamp) || '');
    return Number.isFinite(t) ? t : 0;
  }

  function textOf(e) {
    const c = e && e.message && e.message.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }

  const RE_INTERRUPT = /^\[Request interrupted by user(?: for tool use)?\]$/;
  // Harness noise that arrives as a «user» string: local command output, caveats.
  const RE_NOISE = /^<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)>/;

  // What the person actually said, as { at, text }. Two shapes: a plain user prompt, and a
  // message typed while the agent was busy, delivered later as a queued_command attachment.
  function humanMessage(e) {
    if (!e || e.isSidechain) return null;
    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary) return null;
      const c = e.message && e.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return null;
      const text = textOf(e).trim();
      if (!text || RE_INTERRUPT.test(text) || RE_NOISE.test(text)) return null;
      return { at: tsOf(e), text: commandText(text) };
    }
    if (e.type === 'attachment' && e.attachment && e.attachment.type === 'queued_command') {
      const text = String(e.attachment.prompt || '').trim();
      return text ? { at: tsOf(e), text } : null;
    }
    return null;
  }

  // `/task <url>` arrives wrapped in tags; the person typed the plain form.
  function commandText(text) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
    if (!name) return text;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return (name[1].trim() + ' ' + (args ? args[1].trim() : '')).trim();
  }

  function agentText(e) {
    if (!e || e.isSidechain || e.type !== 'assistant') return null;
    const text = textOf(e).trim();
    return text ? { at: tsOf(e), text } : null;
  }

  // Typed while the agent was busy and never handed to it. Each removal (delivery, the person
  // pulling it back into the input box) cancels the oldest pending copy with the same text;
  // a removal without content clears everything pending.
  function undelivered(entries) {
    const pending = [];
    for (const e of entries || []) {
      if (!e || e.type !== 'queue-operation') continue;
      const text = typeof e.content === 'string' ? e.content : '';
      if (e.operation === 'enqueue') { if (text.trim()) pending.push({ at: tsOf(e), text: text.trim() }); continue; }
      if (!text) { pending.length = 0; continue; }
      const i = pending.findIndex((p) => p.text === text.trim());
      if (i >= 0) pending.splice(i, 1);
    }
    return pending;
  }

  // Timestamp of the newest entry — the mark the dossier gets when it changes.
  function lastTs(entries) {
    let at = 0;
    for (const e of entries || []) at = Math.max(at, tsOf(e));
    return at;
  }

  function humanCountAfter(entries, mark) {
    let n = 0;
    for (const e of entries || []) {
      const h = humanMessage(e);
      if (h && h.at > (mark || 0)) n++;
    }
    return n;
  }

  // The conversation after the mark: the person's messages and the agent's prose, oldest
  // first. Over the cap, the agent's oldest prose goes first; the person's words are kept
  // (a single huge message is cut from its head, keeping the end where the ask usually is).
  function tailAfter(entries, mark, max) {
    const limit = Number(max) > 0 ? Number(max) : TAIL_MAX;
    const items = [];
    for (const e of entries || []) {
      const h = humanMessage(e);
      if (h && h.at > (mark || 0)) { items.push({ who: 'human', ...h }); continue; }
      const a = agentText(e);
      if (a && a.at > (mark || 0)) items.push({ who: 'agent', ...a });
    }
    const size = () => items.reduce((n, x) => n + x.text.length + 16, 0);
    let dropped = 0;
    while (size() > limit) {
      const i = items.findIndex((x) => x.who === 'agent');
      if (i < 0) break;
      items.splice(i, 1);
      dropped++;
    }
    for (const x of items) {
      if (size() <= limit) break;
      const room = Math.max(400, x.text.length - (size() - limit));
      if (x.text.length > room) x.text = '…' + x.text.slice(x.text.length - room + 1);
    }
    return { items, dropped };
  }

  // Tool calls after the work file was last written: how stale «where I stand» is.
  function toolCallsAfter(entries, since) {
    let n = 0;
    for (const e of entries || []) {
      if (!e || e.isSidechain || e.type !== 'assistant' || tsOf(e) <= (since || 0)) continue;
      const c = e.message && e.message.content;
      if (Array.isArray(c)) n += c.filter((b) => b && b.type === 'tool_use').length;
    }
    return n;
  }

  function hhmm(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function quote(text) {
    return String(text).split('\n').map((l) => '> ' + l).join('\n');
  }

  // The inheritance a new session gets in place of the old one. `how`: 'restart' | 'crash'.
  function inheritText(o) {
    const opts = o || {};
    const tail = opts.tail || { items: [], dropped: 0 };
    const und = opts.undelivered || [];
    const out = [];
    out.push(opts.how === 'crash'
      ? `# Наследство: прошлая сессия этой вкладки упала (${hhmm(opts.at)})`
      : `# Наследство: прошлая сессия этой вкладки перезапустилась по контексту (${hhmm(opts.at)})`);
    out.push('');
    out.push('Человек мог не заметить подмену. Если он о чём-то спросил, а ответа не было — ответь и скажи, что отвечаешь после перезапуска.');
    if (opts.workStale > 0) {
      out.push('');
      out.push(`Файл работы правился ${hhmm(opts.workAt)}, после этого прошлая сессия сделала ещё ${opts.workStale} вызовов инструментов — «Где стою» мог отстать: сверь с хвостом ниже и с репозиторием.`);
    }
    if (und.length) {
      out.push('');
      out.push('## Недоставленное');
      out.push('Человек набрал это, пока прошлая сессия работала, и оно до неё так и не дошло. Начни с этого.');
      for (const u of und) { out.push(''); out.push(`(${hhmm(u.at)})`); out.push(quote(u.text)); }
    }
    out.push('');
    out.push('## Хвост разговора после последней правки досье');
    if (opts.resumed) out.push('Если тебя подняли с прежним разговором (`--resume`), этот хвост у тебя уже есть — смотри только «Недоставленное».');
    if (!tail.items.length) {
      out.push('Пусто: досье успело разобрать всё, что было сказано.');
    } else {
      out.push('Разбери: новые правила и замечания — в досье, на неотвеченное — ответь.');
      if (tail.dropped) out.push(`(${tail.dropped} ранних реплик агента выпали по длине; слова человека — все.)`);
      for (const x of tail.items) {
        out.push('');
        out.push(`**${x.who === 'human' ? 'Человек' : 'Агент'}** (${hhmm(x.at)}):`);
        out.push(quote(x.text));
      }
    }
    out.push('');
    return out.join('\n');
  }

  // Housekeeping at startup. `dirs`: [{ key, mtimeMs }] — live tab folders under tabs/;
  // `archived`: [{ name, mtimeMs }] under tabs/archive/; `liveKeys`: keys of restored tabs.
  // Folders with no tab go to the archive; the archive is cleared after ARCHIVE_DAYS.
  function sweepPlan(o) {
    const opts = o || {};
    const live = new Set((opts.liveKeys || []).map(safeKey));
    const now = Number(opts.now) || Date.now();
    const toArchive = (opts.dirs || []).filter((d) => d && d.key && d.key !== ARCHIVE && !live.has(d.key)).map((d) => d.key);
    const toDelete = (opts.archived || []).filter((a) => a && now - (a.mtimeMs || 0) > ARCHIVE_DAYS * 86400000).map((a) => a.name);
    return { toArchive, toDelete };
  }

  // Versions to drop after a new one was added: keep the newest HISTORY_KEEP.
  function historyPrune(names) {
    const sorted = (names || []).slice().sort();
    return sorted.slice(0, Math.max(0, sorted.length - HISTORY_KEEP));
  }

  return {
    DIR, FILES, HISTORY, HISTORY_KEEP, ARCHIVE, ARCHIVE_DAYS, NUDGE_AFTER, TAIL_MAX,
    safeKey, templates, isBlank, parseLines, humanMessage, undelivered, lastTs,
    humanCountAfter, tailAfter, toolCallsAfter, inheritText, sweepPlan, historyPrune, hhmm,
  };
});
