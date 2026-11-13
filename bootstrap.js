// bootstrap.js — точка входа приложения. Крошечная нарочно: единственное, что она
// решает, — грузить код из бандла (./main.js) или обновлённый файл из папки настроек.
// Почему обновление живёт снаружи бандла, объяснено в boot-core.js.
//
// Главное свойство этого файла: он не имеет права упасть. Он лежит внутри подписанного
// бандла и не обновляется никогда, поэтому любая ошибка здесь чинится только полной
// переустановкой у каждого пользователя. Отсюда try/catch вокруг всего и запасной путь
// в любой непонятной ситуации — код из бандла, который заведомо рабочий.
'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const core = require('./boot-core');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function boot() {
  const root = path.join(app.getPath('userData'), core.PAYLOAD_DIR);
  const markerPath = path.join(root, core.MARKER);

  let d;
  try {
    d = core.decideBoot({
      pointer: readJson(path.join(root, core.POINTER)),
      marker: readJson(markerPath),
      bundleVersion: require('./package.json').version,
    });
  } catch (e) {
    d = { kind: 'bundle', reason: 'решение о загрузке не сложилось: ' + (e && e.message) };
  }

  // Файл, который уже ронял запуск, убираем с дороги, чтобы указатель на него больше не
  // указывал. Не удаляем: он пригодится, если понадобится понять, что с ним не так.
  if (d.bad) {
    try { fs.renameSync(path.join(root, d.bad), path.join(root, d.bad + '.broken')); } catch (_) {}
    try { fs.unlinkSync(path.join(root, core.POINTER)); } catch (_) {}
    try { fs.unlinkSync(markerPath); } catch (_) {}
  }

  // Что бы ни случилось дальше, main.js увидит это в global и покажет в логе ошибок.
  global.SWARM_BOOT = { kind: 'bundle', version: null, reason: d.reason || '' };

  // Прошлые версии убираем ДО загрузки: сейчас они точно никем не заняты (на винде это
  // единственный момент, когда файл предыдущей версии не открыт работающим приложением).
  try {
    for (const name of core.stalePayloads(fs.readdirSync(root), d.kind === 'payload' ? d.file : null)) {
      try { fs.unlinkSync(path.join(root, name)); } catch (_) {}
    }
  } catch (_) { /* папки нет — обновлений и не было */ }

  if (d.kind === 'payload') {
    const file = path.join(root, d.file);
    try {
      // Счётчик попыток растёт ДО загрузки: если код обновления окажется битым и
      // приложение умрёт по дороге, обнулить его будет некому. Несколько неудач подряд —
      // и следующий запуск уйдёт в бандл (см. ATTEMPT_LIMIT в boot-core).
      fs.writeFileSync(markerPath, JSON.stringify({ version: d.version, attempts: d.attempt }));
      // Ставим ДО require: загруженный код читает это на старте, и он должен видеть
      // правду о том, откуда его запустили.
      global.SWARM_BOOT = { kind: 'payload', version: d.version, reason: '' };
      const stopWatch = watchStartup(markerPath);
      try {
        require(path.join(file, 'main.js'));
      } catch (e) {
        // Откатываемся на бандл — и слежение надо отменить. Иначе удачный запуск бандла
        // обнулит счётчик попыток, и битое обновление будет пробоваться заново вечно.
        stopWatch();
        throw e;
      }
      return;
    } catch (e) {
      // Обновление не завелось — метка остаётся, и следующий запуск уйдёт в бандл сам.
      // Здесь же честно грузим бандл, чтобы человек не остался без приложения сейчас.
      global.SWARM_BOOT = {
        kind: 'bundle',
        version: null,
        reason: `обновление ${d.version} не запустилось (${(e && e.message) || e}) — работает версия из установленного приложения`,
      };
    }
  }

  require('./main.js');
}

// Счётчик попыток обнуляем, когда стало ясно, что запуск удался: приложение поднялось и
// прожило несколько секунд после готовности. Второй сигнал — обычный выход: вторая копия
// Svarmo закрывается сама сразу после старта (см. одиночную блокировку в main.js). На
// него полагаться нельзя (при выходе до готовности события может и не быть — так это
// выглядело на проверке), поэтому он не единственный, а страховка сверху к счётчику.
function watchStartup(markerPath) {
  let cancelled = false;
  const clear = () => {
    if (cancelled) return;
    try { fs.unlinkSync(markerPath); } catch (_) {}
  };
  try {
    app.whenReady().then(() => setTimeout(clear, 8000).unref?.());
    app.on('quit', clear);
  } catch (_) {}
  return () => { cancelled = true; };
}

boot();
