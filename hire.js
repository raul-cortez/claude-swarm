'use strict';
// hire.js — найм по просьбе прораба: прораб просит открыть вкладку-исполнителя, сворм читает
// заявку и открывает её сам. Спека: docs/superpowers/specs/2026-09-22-crew-design.md, раздел
// «Протокол найма».
//
// Механика — та же, что у digest.js/restart.js, и по той же причине: прораб пишет файл в свою
// рабочую папку, сворм опрашивает его тактом. Здесь только чистый разбор заявки и потолок
// бригады — открытие вкладки, печать задачи в pty и обратная связь прорабу живут в main.js
// (fs, IPC, pty — этого тут нет, и это непроверяемо тестом).
//
// UMD-обёртка как у digest.js/restart.js: main.js и тесты берут модуль через require, а панель
// настроек (renderer.js) — через window.SWARM_HIRE, тем же скриптом без бандлера.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_HIRE = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Имя файла — по id разговора, той же причине, что у digest.fileName/restart.answerName: хук
  // (hooks/swarm-signal.mjs) не видит модулей приложения и не знает ключа вкладки, только id
  // своего разговора. Дубликат этой строки живёт в хуке и сверяется тестом.
  function fileName(sessionId) {
    const sid = String(sessionId == null ? '' : sessionId).replace(/[^\w.-]/g, '_');
    return sid ? '.swarm-hire-' + sid + '.json' : '';
  }

  // Потолок бригады — сколько исполнителей прораб может держать разом. Не про то, сколько точек
  // влезает в подвал карточки (там «+N» при любом числе, см. спеку «Индикатор детей») — это
  // настоящий предел параллельных вкладок, который человек двигает под свою подписку и машину.
  const MIN_MAX = 1;
  const MAX_MAX = 20;
  const DEFAULT_MAX = 6;

  // «Не задано» и «задано нулём» — разные вещи, и путать их дорого (та же ловушка, что у
  // digest.clampMaxLen/restart.clampPct): localStorage.getItem на несохранённой настройке
  // отдаёт null, а Number(null) — конечный ноль, который молча заткнул бы наём вовсе.
  function clampCeiling(n) {
    if (n == null || n === '') return DEFAULT_MAX;
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_MAX;
    return Math.min(MAX_MAX, Math.max(MIN_MAX, v));
  }

  // Сколько буквами прораб может назвать исполнителя (`#629`) и сколько написать ему задачей.
  // Заявка длиннее — обрезаем, а не отвергаем целиком: это защита от раздутого файла, не строгая
  // валидация чужого ввода (прораб — свой агент, не внешний источник).
  const NAME_MAX = 60;
  const PROMPT_MAX = 4000;

  function trimStr(v, max) {
    if (typeof v !== 'string') return '';
    return v.trim().slice(0, max);
  }

  // Заявок в одном файле — тоже с потолком, отдельным от потолка бригады: файл мог накопить
  // мусор от нескольких перезаписей подряд (агент пишет файл не атомарно), и без границы здесь
  // одна порченая запись могла бы попросить сотню вкладок разом. Настоящий предел бригады
  // проверяет main.js (живых детей у прораба), это лишь потолок на один разбор файла.
  const MAX_PER_FILE = 20;

  // Разбор заявки: {"hire": [{"name": "#629", "prompt": "…", "model": "sonnet"}]} →
  // нормализованный массив. Терпимо к мусору в ОДНОЙ записи (пропускаем её, а не всю заявку) —
  // та же логика, что у restart.parseAnswer: агент мог ошибиться в одном поле, а не во всём
  // файле. `model` не проверяем по белому списку здесь (он в restart.js, дублировать его тут
  // незачем — main.js применяет restart.modelOf к уже разобранной строке).
  function parseRequest(raw) {
    let obj;
    try { obj = JSON.parse(raw); } catch (_) { return []; }
    const list = obj && Array.isArray(obj.hire) ? obj.hire : [];
    const out = [];
    for (const item of list) {
      if (out.length >= MAX_PER_FILE) break;
      if (!item || typeof item !== 'object') continue;
      const name = trimStr(item.name, NAME_MAX);
      const prompt = trimStr(item.prompt, PROMPT_MAX);
      if (!name || !prompt) continue;      // без имени и задачи нанимать нечего
      const model = typeof item.model === 'string' ? item.model.trim().toLowerCase() : '';
      out.push({ name, prompt, model });
    }
    return out;
  }

  return {
    fileName, clampCeiling, MIN_MAX, MAX_MAX, DEFAULT_MAX, NAME_MAX, PROMPT_MAX, MAX_PER_FILE,
    parseRequest,
  };
});
