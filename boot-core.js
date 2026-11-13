// boot-core.js — чистое решение «чей код запускать»: тот, что лежит в подписанном
// бандле, или обновлённый, который живёт рядом с настройками. Без fs и electron —
// поэтому проверяется обычными тестами (test/boot.test.js).
//
// Зачем это вообще. Раньше обновление лезло внутрь установленного приложения и
// подменяло там app.asar. Подпись macOS покрывает всё содержимое бандла, поэтому
// подмена её ломала, приходилось переподписывать заново уже на машине пользователя —
// а с каждой переподписью у приложения менялся отпечаток. Для системы это каждый раз
// НОВОЕ приложение: выданные разрешения (папки, связка ключей) сбрасывались, и она
// спрашивала всё заново. На винде та же подмена упиралась в заблокированный файл и
// требовала хелпера на PowerShell.
//
// Отсюда правило: бандл после установки не меняется никогда. Обновляемый код лежит
// отдельным файлом в папке настроек, и обновление — это «положить рядом новый файл и
// переставить указатель». Подпись остаётся нетронутой, блокировок нет.
'use strict';

const { compareVersions } = require('./updater-core');

// Папка с обновлённым кодом (внутри userData) и два её служебных файла.
const PAYLOAD_DIR = 'payload';
// Указатель: { version, file } — какой файл считать актуальным.
const POINTER = 'current.json';
// Метка попыток: { version, attempts }. Растёт перед каждой загрузкой обновлённого кода
// и обнуляется, когда приложение дожило до рабочего состояния.
const MARKER = 'loading.json';
// Со скольких подряд неудачных попыток версия считается негодной.
//
// Не с одной: приложение выходит сразу после старта не только падая. Вторая копия Svarmo
// закрывается сама (одна копия на машину, см. main.js), и она не успевает снять метку —
// а по одной попытке это было бы неотличимо от падения, и исправное обновление
// выбрасывалось бы после того, как человек случайно кликнул по иконке дважды.
const ATTEMPT_LIMIT = 3;

// Имя файла и есть имя файла: указатель не должен уметь увести загрузку из своей папки.
function safeName(name) {
  return typeof name === 'string' && !!name && !/[\\/]/.test(name) && name !== '..';
}

/**
 * @param {{ pointer: object|null, marker: object|null, bundleVersion: string }} state
 * @returns {{ kind: 'bundle'|'payload', file?: string, version?: string, reason?: string, bad?: string }}
 *   bad — файл, который надо убрать с дороги: он уже уронил запуск.
 */
function decideBoot(state) {
  const p = (state && state.pointer) || null;
  const marker = (state && state.marker) || null;
  const bundleVersion = (state && state.bundleVersion) || '0.0.0';

  if (!p || typeof p.version !== 'string' || !safeName(p.file)) {
    return { kind: 'bundle', reason: 'обновлённого кода нет' };
  }
  // Бандл не старее — значит приложение только что переставили с новым dmg, а рядом
  // лежит обновление от прежней версии. Оно уже неактуально.
  if (compareVersions(p.version, bundleVersion) <= 0) {
    return { kind: 'bundle', reason: 'в бандле версия не старее' };
  }
  if (marker && marker.version === p.version && attemptsOf(marker) >= ATTEMPT_LIMIT) {
    return {
      kind: 'bundle',
      reason: `эта версия ${ATTEMPT_LIMIT} раза подряд не дошла до рабочего состояния`,
      bad: p.file,
    };
  }
  return { kind: 'payload', file: p.file, version: p.version, attempt: nextAttempt(marker, p.version) };
}

function attemptsOf(marker) {
  const n = marker && Number(marker.attempts);
  return Number.isFinite(n) && n > 0 ? n : 1;   // метка без счётчика — одна попытка
}

// Какой по счёту будет попытка, которую мы сейчас предпримем.
function nextAttempt(marker, version) {
  if (!marker || marker.version !== version) return 1;
  return attemptsOf(marker) + 1;
}

// Что в папке обновлений лишнее — при том, что запускаем мы `keep` (или ничего, если
// идём из бандла). Прошлые версии не нужны: запасной вариант всегда есть в самом
// приложении, и держать рядом ещё по пять мегабайт на каждую былую версию незачем.
// Недокачанные .part — тем более мусор.
//
// Файлы .broken не трогаем: это улика. Их появление означает, что обновление не
// запустилось, и по нему потом можно понять почему.
function stalePayloads(names, keep) {
  return (names || []).filter((n) => {
    if (n === keep) return false;
    return n.endsWith('.asar') || n.endsWith('.asar.part');
  });
}

module.exports = {
  decideBoot, safeName, stalePayloads,
  PAYLOAD_DIR, POINTER, MARKER, ATTEMPT_LIMIT,
};
