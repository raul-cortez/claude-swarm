'use strict';
// questions.js — the tab's questions to the person and their answers, for the «Вопросы» side panel.
//
// A question asked while the agent keeps working gets lost in the scroll: the person answers
// it, and a screen later neither of them can find what was decided. Two sources feed the list:
//
//   questions.md (in the tab's folder, next to the dossier) — the agent's own record of the
//     questions it asked in prose, one per item, with the answer written under each. Only the
//     agent can split «three questions in one message, one reply to all three» into pairs, so
//     the file is its job, done in the same step as the dossier.
//   the transcript — questions asked with options (AskUserQuestion). Claude records the
//     question and the picked answer as one structured pair, so the app takes them itself
//     and the agent doesn't write them down.
//
// Times: the agent doesn't write any (it has no clock it can trust). The app stamps a question
// and its answer the first time it sees them; stamps live in the tab's state.json.
//
// Pure: strings and plain values in, plain values out. File I/O lives in main.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_QUESTIONS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FILE = 'questions.md';
  // Answered box pairs we keep in state.json. Older ones drop off: the panel is for the work at
  // hand, not an archive, and state.json is rewritten on every change.
  const BOX_KEEP = 200;

  function template() {
    return [
      '# Вопросы вкладки',
      '',
      '<!-- Каждый твой вопрос человеку — отдельным пунктом «- вопрос», одной строкой.',
      '     Ответ — строкой ниже с отступом: «  → ответ». Снят без ответа — «  → снят: почему».',
      '     Новые — в конец, старые не удаляй. Вопросы с вариантами записывает приложение само. -->',
      '',
    ].join('\n');
  }

  const RE_ITEM = /^[-*+]\s+(.*)$/;
  const RE_ANSWER = /^(?:→|->|=>|ответ\s*:)\s*(.*)$/i;

  // [{q, a}] in file order; a === null — no answer yet. A top-level list item opens a question;
  // indented lines continue it, and the first one starting with an arrow opens the answer (later
  // indented lines continue the answer).
  function parseFile(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const out = [];
    let cur = null;
    let inAnswer = false;
    for (const raw of lines) {
      if (/^#/.test(raw)) { cur = null; continue; }
      if (!raw.trim()) continue;
      const top = !/^\s/.test(raw);
      const m = top ? RE_ITEM.exec(raw) : null;
      if (m) {
        const q = m[1].trim();
        if (!q) { cur = null; continue; }
        cur = { q, a: null };
        out.push(cur);
        inAnswer = false;
        continue;
      }
      if (!cur) continue;
      const line = raw.trim();
      const am = RE_ANSWER.exec(line);
      if (am && !inAnswer) { cur.a = am[1].trim(); inAnswer = true; continue; }
      if (inAnswer) cur.a = cur.a ? cur.a + ' ' + line : line;
      else cur.q += ' ' + line;
    }
    for (const it of out) if (it.a !== null && !it.a) it.a = '—';
    return out;
  }

  function tsOf(e) {
    const t = Date.parse((e && e.timestamp) || '');
    return Number.isFinite(t) ? t : 0;
  }

  // Box questions out of raw transcript entries (not dossier.compact — it drops tool calls).
  // `pending` — asks from earlier reads still without a result: the transcript is read in chunks,
  // and the answer comes in a later one than the question.
  // asks:    [{id, at, questions: [text]}]   — AskUserQuestion calls, pending first, then log order
  // results: [{id, at, answers: {text: answer} | null}] — null: refused or dismissed
  // lastAt:  newest main-thread assistant/user entry that isn't the box itself — an ask older than
  //          it with no result is not on screen any more (the session moved on or died).
  function boxEvents(entries, pending) {
    const asks = (pending || []).slice();
    const ids = new Set(asks.map((x) => x.id));
    const results = [];
    let lastAt = 0;
    for (const e of entries || []) {
      if (!e || typeof e !== 'object' || e.isSidechain) continue;
      if (e.type !== 'assistant' && e.type !== 'user') continue;
      const at = tsOf(e);
      const c = e.message && e.message.content;
      let mine = false;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== 'object') continue;
          if (e.type === 'assistant' && b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id && !ids.has(String(b.id))) {
            const qs = (b.input && Array.isArray(b.input.questions) ? b.input.questions : [])
              .map((x) => String((x && x.question) || '').trim()).filter(Boolean);
            if (qs.length) { asks.push({ id: String(b.id), at, questions: qs }); ids.add(String(b.id)); mine = true; }
          }
          if (e.type === 'user' && b.type === 'tool_result' && ids.has(String(b.tool_use_id))) {
            const r = e.toolUseResult;
            const answers = !b.is_error && r && typeof r === 'object' && r.answers && typeof r.answers === 'object' ? r.answers : null;
            results.push({ id: String(b.tool_use_id), at, answers });
            mine = true;
          }
        }
      }
      if (!mine && at > lastAt) lastAt = at;
    }
    return { asks, results, lastAt };
  }

  function answerText(v) {
    if (Array.isArray(v)) return v.map(String).join(', ');
    return String(v == null ? '' : v).trim();
  }

  // Fold events into the saved box pairs. Returns
  //   box     — answered pairs [{id, i, q, a, at, aAt}], one per question of a box: a box with
  //             three questions gives three pairs; kept in state.json;
  //   pending — asks still without a result (handed back to the next boxEvents);
  //   open    — their questions, waiting on screen right now.
  // A refused or dismissed box leaves nothing: the agent goes on to ask in prose (and writes that
  // down itself) or drops the question.
  function absorbBox(box, ev) {
    const out = Array.isArray(box) ? box.slice() : [];
    const known = new Set(out.map((x) => x.id + '#' + x.i));
    const resOf = new Map((ev.results || []).map((r) => [r.id, r]));
    const pending = [];
    for (const ask of ev.asks || []) {
      const r = resOf.get(ask.id);
      if (!r) {
        // Left without a result while the log went on — off screen, not waiting.
        if (ask.at >= (ev.lastAt || 0)) pending.push(ask);
        continue;
      }
      if (!r.answers) continue;
      ask.questions.forEach((q, i) => {
        if (known.has(ask.id + '#' + i)) return;
        const a = answerText(r.answers[q]);
        out.push({ id: ask.id, i, q, a: a || '—', at: ask.at, aAt: r.at });
        known.add(ask.id + '#' + i);
      });
    }
    out.sort((x, y) => x.at - y.at || x.i - y.i);
    const open = [];
    for (const ask of pending) ask.questions.forEach((q, i) => open.push({ id: ask.id, i, q, a: null, at: ask.at }));
    return { box: out.slice(-BOX_KEEP), pending, open };
  }

  function keyOf(q) { return String(q).replace(/\s+/g, ' ').trim().toLowerCase(); }

  // Stamp file items with the moment they were first seen. seen: {key: {at, aAt}}. `now` — this
  // read; `firstRead` — no stamps yet at all (an old file, a lost state): spread the items just
  // before `fallback` (the file's mtime) in file order, instead of claiming they all appeared now.
  function stamp(items, seen, now, fallback) {
    const prev = seen && typeof seen === 'object' ? seen : {};
    const next = {};
    const firstRead = !Object.keys(prev).length;
    const base = Number.isFinite(fallback) && fallback > 0 ? fallback : now;
    const out = items.map((it, idx) => {
      const k = keyOf(it.q);
      const s = prev[k] || next[k] || {};
      const at = s.at || (firstRead ? base - (items.length - idx) * 1000 : now);
      const aAt = it.a === null ? 0 : (s.aAt || (firstRead ? at : now));
      next[k] = { at, aAt: aAt || undefined };
      return { q: it.q, a: it.a, at, aAt };
    });
    return { items: out, seen: next };
  }

  // The list the panel shows: newest first, one timeline — the person answers out of order, so
  // there is no «waiting» block on top; a waiting question stays in its place and is marked.
  // Returns null when there's nothing to show.
  function merge(fileItems, box, open) {
    const all = []
      .concat((fileItems || []).map((x) => ({ q: x.q, a: x.a, at: x.at, aAt: x.aAt || 0, src: 'text' })))
      .concat((box || []).map((x) => ({ q: x.q, a: x.a, at: x.at, aAt: x.aAt || 0, src: 'box' })))
      .concat((open || []).map((x) => ({ q: x.q, a: null, at: x.at, aAt: 0, src: 'box' })));
    if (!all.length) return null;
    all.sort((x, y) => y.at - x.at);
    return { items: all, waiting: all.filter((x) => x.a === null).length, total: all.length };
  }

  return { FILE, BOX_KEEP, template, parseFile, boxEvents, absorbBox, stamp, merge, keyOf };
});
