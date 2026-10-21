'use strict';
// sleep.js — сон простаивающей вкладки.
//
// Память ест не сворм, а `claude` в каждой вкладке: это отдельная программа, и даже без дела она
// держит в памяти весь разговор, свой движок и MCP-серверы — 150–300 МБ на вкладку. Пятнадцать
// открытых вкладок — это гигабайты, хотя работают из них две. Ужаться Клод не умеет, поэтому
// давно простаивающую вкладку мы УСЫПЛЯЕМ: закрываем агента, а карточку, историю на экране и
// разговор на диске оставляем. Подходит к ней человек, пишет телега или прораб — агент
// поднимается тем же разговором через `--resume`.
//
// Цена ошибки несимметрична. Не усыпили лишний раз — потеряли сотню мегабайт. Усыпили
// работающую вкладку — убили фоновую задачу, сабагентов или будильник агента, и это уже не
// вернуть. Поэтому статусу карточки здесь не верят: зелёная вкладка бывает и тогда, когда в
// фоне идёт сборка. Перед сном проверяется всё, что у вкладки может жить без хода: процессы
// инструментов, сабагенты по их собственным файлам, будильники и расписания в стенограмме.
//
// Здесь только решения — над тем, что main.js уже собрал с процессов и диска. Их цена высока, а
// проверить тестом их можно только отдельно от pty.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_SLEEP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Через сколько минут простоя усыплять. Ползунок в настройках; 30 по умолчанию — просьба
  // человека. Меньше десяти не даём: вкладку, от которой отошли налить кофе, будить незачем.
  const MIN_MIN = 10;
  const MAX_MIN = 180;
  const DEFAULT_MIN = 30;

  // «Не задано» — это умолчание, а не ноль (та же ловушка localStorage, что в restart.clampPct).
  function clampMin(n) {
    if (n == null || n === '') return DEFAULT_MIN;
    const v = Math.round(Number(n));
    if (!isFinite(v)) return DEFAULT_MIN;
    return Math.max(MIN_MIN, Math.min(MAX_MIN, v));
  }

  // --- стенограмма ----------------------------------------------------------------
  // Хвост файла JSONL → записи. Первая строка хвоста почти всегда обрезана посередине, а
  // последняя может дописываться прямо сейчас: битые строки просто пропускаем.
  function parseTail(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      if (!line || line[0] !== '{') continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* обрезок */ }
    }
    return out;
  }

  function contentOf(rec) {
    const c = rec && rec.message && rec.message.content;
    return Array.isArray(c) ? c : [];
  }

  function tsOf(rec) {
    const t = Date.parse(rec && rec.timestamp);
    return isFinite(t) ? t : 0;
  }

  // Записи, которые говорят о ходе разговора: реплики и ответы инструментов. Отчёты хуков,
  // снимки файлов и служебные строки — шум, по ним о жизни агента ничего не скажешь.
  function meaningful(rec) {
    return rec && (rec.type === 'assistant' || rec.type === 'user');
  }

  // Сабагент отдал работу: хук SubagentStop отработал, либо последняя его реплика — текст без
  // вызова инструмента. Реплика из одного «размышления» концом не считается: Клод пишет его
  // отдельной записью перед ответом, и в этот миг агент ещё думает.
  function saidLastWord(records) {
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      const a = r && r.attachment;
      if (a && a.hookEvent === 'SubagentStop') return true;
      if (!meaningful(r)) continue;
      if (r.type !== 'assistant') return false;
      const c = contentOf(r);
      if (c.some((b) => b && b.type === 'tool_use')) return false;
      return c.some((b) => b && b.type === 'text' && String(b.text || '').trim());
    }
    return false;
  }

  // Ждёт ли последний шаг ответа инструмента — вызов есть, результата нет.
  function pendingTool(records) {
    const answered = new Set();
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (!meaningful(r)) continue;
      for (const b of contentOf(r)) {
        if (b && b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
      }
      if (r.type === 'assistant') {
        return contentOf(r).some((b) => b && b.type === 'tool_use' && !answered.has(b.id));
      }
    }
    return false;
  }

  // --- сабагенты -----------------------------------------------------------------
  // Свежая запись — агент живой без вопросов: ходит по файлам, получает ответы.
  const SUB_ACTIVE_MS = 3 * 60 * 1000;
  // Дольше этого без единой записи живой сабагент не молчит: ответ модели, даже длинный, приходит
  // за минуты. Исключение — инструмент, который честно долго считает (сборка, прогон тестов), и
  // его видно по процессам.
  const SUB_STUCK_MS = 15 * 60 * 1000;

  // Жив ли сабагент НА САМОМ ДЕЛЕ. Экран Клода говорит «ждём N фоновых агентов», но эта строка
  // врёт в обе стороны: агент отчитался, а строка висит; агент повис, а строка его считает. Файл
  // разговора сабагента — первичный источник: туда пишется каждый его шаг, а с недавних версий
  // ещё и отметка `finished` в соседнем .meta.json.
  //
  //   meta      — содержимое agent-*.meta.json (или null)
  //   records   — хвост его стенограммы (parseTail)
  //   ageMs     — сколько файл не менялся
  //   toolProcs — сколько процессов инструментов живёт под агентом вкладки (Bash и прочие)
  //
  // → 'done' (отработал), 'running' (работает), 'stuck' (висит: молчит давно, и ничего под ним
  // не крутится).
  function subagentState({ meta, records, ageMs, toolProcs }) {
    if (meta && meta.finished === true) return 'done';
    const recs = records || [];
    if (saidLastWord(recs)) return 'done';
    if (ageMs < SUB_ACTIVE_MS) return 'running';
    if (pendingTool(recs) && toolProcs > 0) return 'running';
    if (ageMs < SUB_STUCK_MS) return 'running';
    return 'stuck';
  }

  // Сколько сабагентов работает, по их файлам. Сводка для журнала — тоже здесь, чтобы main не
  // собирал её по-своему.
  function tallySubagents(states) {
    const t = { running: 0, stuck: 0, done: 0 };
    for (const s of states || []) if (t[s] != null) t[s]++;
    return t;
  }

  // --- будильники в главном разговоре ---------------------------------------------
  // Агент поставил себе будильник (ScheduleWakeup) или задачу по расписанию (CronCreate) — его
  // разбудит сам Клод, и только пока он жив. Со стороны такая вкладка выглядит законченной:
  // ход отдан, зелёная, процессов нет. Усыпить её — молча отменить ему будильник.
  //
  // Смотрим только записи этой жизни агента (since): расписания живут в процессе и вместе с
  // ним умирают, вчерашний CronCreate из поднятого разговора ничего уже не держит.
  const WAKE_GRACE_MS = 2 * 60 * 1000;
  function pendingTimer(records, since, now) {
    let crons = 0;
    let wakeAt = 0;
    for (const r of records || []) {
      if (r.type !== 'assistant' || tsOf(r) < since) continue;
      for (const b of contentOf(r)) {
        if (!b || b.type !== 'tool_use') continue;
        const inp = b.input || {};
        if (b.name === 'CronCreate') crons++;
        else if (b.name === 'CronDelete') crons = Math.max(0, crons - 1);
        else if (b.name === 'ScheduleWakeup') {
          wakeAt = inp.stop ? 0 : tsOf(r) + Math.max(0, Number(inp.delaySeconds) || 0) * 1000;
        }
      }
    }
    if (crons > 0) return 'задача по расписанию';
    if (wakeAt && now < wakeAt + WAKE_GRACE_MS) return 'будильник агента';
    return '';
  }

  // --- решение ------------------------------------------------------------------
  // Дешёвая часть — по тому, что уже лежит в памяти main. Её зовут раз в минуту на каждую
  // вкладку, и до диска и процессов доходят только те, кто прошёл её целиком.
  //
  // t — сводка вкладки:
  //   enabled, idleMin   — настройка
  //   now, activeAt      — последний признак жизни (ход, печать, запись стенограммы, подъём)
  //   status, bg, box    — из детектора
  //   auto               — мандат «работает без человека»: такую не усыпляем никогда
  //   agentUp            — агент в оболочке есть (по процессам)
  //   canResume          — его можно поднять тем же разговором
  //   busyWith           — занята чем-то нашим: перезапуском, телегой, заморозкой по региону
  //   watched            — вкладку прямо сейчас видит человек
  //   toolProcs          — живые процессы инструментов под агентом
  // → { act: 'sleep' | 'check' | 'wait', why }. 'check' — дешёвая часть пройдена, дальше
  // проверка диска (deepCheck).
  function quickDecision(t) {
    if (!t.enabled) return { act: 'wait', why: 'выключено' };
    if (t.auto) return { act: 'wait', why: 'работает без человека' };
    if (!t.agentUp) return { act: 'wait', why: 'агента нет' };
    if (!t.canResume) return { act: 'wait', why: 'поднять будет нечем' };
    if (t.busyWith) return { act: 'wait', why: t.busyWith };
    if (t.status !== 'ready') return { act: 'wait', why: 'не готова' };
    if (t.box) return { act: 'wait', why: 'открыт вопрос' };
    if (t.watched) return { act: 'wait', why: 'на неё смотрят' };
    const idle = t.now - (t.activeAt || 0);
    const limit = clampMin(t.idleMin) * 60 * 1000;
    if (idle < limit) return { act: 'wait', why: 'простаивает недавно' };
    // «Работает в фоне» — агент сказал, что ждёт фоновую задачу, и та его разбудит. Но если
    // задача зависла, будить некому, и вкладка висит в фоне вечно. Такой вкладке даём двойной
    // срок, а дальше решает та же проверка процессов, сабагентов и будильников: живое там
    // найдётся — не тронем.
    if (t.bg && idle < 2 * limit) return { act: 'wait', why: 'работает в фоне' };
    if (t.toolProcs > 0) return { act: 'wait', why: 'крутятся процессы инструментов' };
    return { act: 'check', why: '' };
  }

  // Вторая часть — по стенограмме и файлам сабагентов, уже прочитанным main'ом.
  //   records    — хвост главной стенограммы
  //   since      — когда поднялся нынешний агент
  //   subStates  — subagentState каждого сабагента этой жизни
  //   trAgeMs    — сколько главная стенограмма не менялась
  function deepDecision({ records, since, now, subStates, trAgeMs, idleMin }) {
    // Стенограмма живая — значит идёт ход, что бы ни показывал экран.
    if (trAgeMs < clampMin(idleMin) * 60 * 1000) return { act: 'wait', why: 'разговор недавно писался' };
    if (pendingTool(records)) return { act: 'wait', why: 'ждёт ответа инструмента' };
    const timer = pendingTimer(records, since, now);
    if (timer) return { act: 'wait', why: timer };
    const t = tallySubagents(subStates);
    if (t.running) return { act: 'wait', why: `работают сабагенты (${t.running})` };
    return { act: 'sleep', why: t.stuck ? `зависшие сабагенты (${t.stuck}) не держат` : '' };
  }

  return {
    MIN_MIN, MAX_MIN, DEFAULT_MIN, SUB_ACTIVE_MS, SUB_STUCK_MS,
    clampMin, parseTail, saidLastWord, pendingTool, subagentState, tallySubagents,
    pendingTimer, quickDecision, deepDecision,
  };
});
