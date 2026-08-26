'use strict';
// Имя файла дайджеста вкладки — короткой сводки «чем занята», которую агент сам пишет в
// свою рабочую папку, а сворм читает и показывает на карточке. По той же причине, что и у
// restart.answerName: хук (hooks/swarm-signal.mjs) не видит модулей приложения, поэтому эта
// строка там продублирована и сверяется тестом.
function fileName(sessionId) {
  const sid = String(sessionId == null ? '' : sessionId).replace(/[^\w.-]/g, '_');
  return sid ? '.swarm-digest-' + sid + '.json' : '';
}

// Сколько текста берём из файла. Дайджест — «пара строк», а не отчёт: без потолка одна вкладка
// могла бы залить полоску над терминалом и утянуть за собой макет. Полоска рисует ровно две
// строки (line-clamp в styles.css) — 400 знаков это запас на них при обычной ширине окна, а не
// гарантия, что все они влезут: длинный текст обрежется многоточием уже в интерфейсе.
const MAX_LEN = 400;

function readText(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return ''; }
  const text = String((parsed && parsed.digest) || '').trim();
  return text.slice(0, MAX_LEN);
}

module.exports = { fileName, readText, MAX_LEN };
