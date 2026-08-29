'use strict';
// digest.js — дайджест вкладки: короткой сводки «чем занята», которую агент сам пишет в свою
// рабочую папку, а сворм читает и показывает на карточке.
//
// UMD-обёртка как у restart.js/subs.js: main.js и тесты берут модуль через require, а панель
// настроек (renderer.js) — через window.SWARM_DIGEST, тем же скриптом без бандлера.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SWARM_DIGEST = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Имя файла. По той же причине, что и у restart.answerName: хук (hooks/swarm-signal.mjs) не
  // видит модулей приложения, поэтому эта строка там продублирована и сверяется тестом.
  function fileName(sessionId) {
    const sid = String(sessionId == null ? '' : sessionId).replace(/[^\w.-]/g, '_');
    return sid ? '.swarm-digest-' + sid + '.json' : '';
  }

  // Сколько текста берём из файла. Дайджест — «пара строк», а не отчёт: без потолка одна вкладка
  // могла бы залить полоску над терминалом и утянуть за собой макет. Полоска рисует ровно две
  // строки (line-clamp в styles.css) — 400 знаков это запас на них при обычной ширине окна, а не
  // гарантия, что все они влезут: длинный текст обрежется многоточием уже в интерфейсе. Человек
  // может подвинуть потолок в настройках (Settings → Запуск, 100–1000): выше DEFAULT_LEN текст
  // просто хранится длиннее, чем реально показывает полоска, — это не ломает вёрстку, только
  // не всё будет видно без клика на карточку.
  const DEFAULT_LEN = 400;
  const MIN_LEN = 100;
  const MAX_LEN = 1000;

  // «Не задано» и «задано нулём» — разные вещи, та же ловушка, что у restart.clampPct: сюда
  // приходит localStorage.getItem, а он на несохранённой настройке отдаёт null. Через Number(null)
  // это 0 — конечное число, — и потолок молча улетел бы к MIN_LEN вместо умолчания.
  function clampMaxLen(n) {
    if (n == null || n === '') return DEFAULT_LEN;
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_LEN;
    return Math.min(MAX_LEN, Math.max(MIN_LEN, v));
  }

  function readText(raw, maxLen) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return ''; }
    const text = String((parsed && parsed.digest) || '').trim();
    return text.slice(0, clampMaxLen(maxLen));
  }

  // Заготовка поля «Что писать в дайджест» (Settings → Запуск) — по той же схеме, что ночные
  // тексты в night.js: поле не пустое, в нём лежит редактируемый текст, и «своим» он считается
  // по отличию от этой строки, а не по факту правки. Отсюда же берёт умолчание renderer при
  // первом открытии панели.
  function defaultNote() {
    return 'О чём этот таск и что сейчас происходит — по-человечески, а не отчётом о процессе '
      + 'разработки. Если жду от тебя решения, скажи это отдельно.';
  }

  // Температура промпт-кэша Anthropic на старте сессии — пишет СТОРОННИЙ хук проекта (например,
  // fastio: scripts/hooks/warm-start-hint.mjs), не агент и не сворм, прямо в этот же файл рядом
  // с `digest`. Поле чужое для агента: он его не пишет и не обязан о нём знать, а мы его просто
  // не трогаем, когда перезаписываем `digest` (см. `readText`, который читает СВОЁ поле и не
  // видит это). Отдельная функция, а не подмешивание в readText, — по той же причине: два разных
  // писателя в один файл, значения читаются и валидируются порознь.
  function readCache(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return null; }
    const v = parsed && parsed.cache;
    return v === 'warm' || v === 'cold' ? v : null;
  }

  return { fileName, readText, readCache, DEFAULT_LEN, MIN_LEN, MAX_LEN, clampMaxLen, defaultNote };
});
