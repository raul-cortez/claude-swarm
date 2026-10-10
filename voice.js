'use strict';
// Голос из телеги → текст. Чистая часть: сборка WAV, поиск бинарника, аргументы и разбор
// вывода. Ввод-вывод и запуск процесса — в main.js, поэтому всё это тестируется в node.
//
// РЕШЕНИЕ, определяющее весь модуль: распознаём ЛОКАЛЬНО (whisper.cpp). Звук — это твои
// задачи вслух, и отправлять их на чужой сервер ради удобства мы отказались там же, где
// отказались от общего бота.
//
// Второе решение: НЕ тащим ffmpeg. Телеграм отдаёт OGG/Opus, whisper ест WAV 16 кГц —
// обычно тут появляется ffmpeg с отдельной инструкцией на каждую ОС. Но Chromium умеет
// декодировать Opus сам, поэтому декодирование живёт в рендерере (OfflineAudioContext),
// а здесь мы только упаковываем полученные сэмплы в WAV. Ни нативных модулей, ни
// сторонних бинарников, кроме самого whisper.

const SAMPLE_RATE = 16000;   // whisper.cpp работает только с этим

// 16-битный моно WAV из Float32 (то, что отдаёт Web Audio). Заголовок 44 байта, всё
// остальное — сэмплы; клиппинг обязателен, иначе громкая запись даёт треск.
function wavFromFloat32(samples, rate) {
  const src = samples || [];
  const n = src.length;
  const hz = rate || SAMPLE_RATE;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);          // размер fmt-блока
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // моно
  buf.writeUInt32LE(hz, 24);
  buf.writeUInt32LE(hz * 2, 28);      // байт в секунду
  buf.writeUInt16LE(2, 32);           // байт на кадр
  buf.writeUInt16LE(16, 34);          // бит на сэмпл
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, src[i] || 0));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

// Имена, под которыми whisper.cpp попадает в PATH. Их несколько, потому что проект
// переименовывал бинарник (main → whisper-cli), а brew и релизы под Windows кладут разные.
const BIN_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];

// Найти бинарник: сначала явный путь из настроек, потом PATH. `exists` инжектится, чтобы
// тест не зависел от того, что стоит на машине.
function findBinary(opts) {
  const o = opts || {};
  const exists = typeof o.exists === 'function' ? o.exists : () => false;
  const sep = o.isWin ? ';' : ':';
  const exts = o.isWin ? ['.exe', ''] : [''];
  if (o.configured) {
    for (const ext of exts) if (exists(o.configured + ext)) return o.configured + ext;
    return null;   // указали руками и промахнулись — не подменяем тихо чем-то из PATH
  }
  for (const dir of String(o.pathEnv || '').split(sep).filter(Boolean)) {
    for (const name of BIN_NAMES) {
      for (const ext of exts) {
        const full = (o.join || ((a, b) => a + '/' + b))(dir, name + ext);
        if (exists(full)) return full;
      }
    }
  }
  return null;
}

// `-nt` — без таймкодов, `-l ru` — язык не угадываем (на короткой фразе угадывается плохо),
// `-np` — не печатать прогресс в stdout, чтобы разбор не ловил мусор.
function whisperArgs(opts) {
  const o = opts || {};
  return ['-m', o.model, '-f', o.wav, '-l', o.lang || 'ru', '-nt', '-np'];
}

// Вывод whisper-cli: либо чистые строки текста (с -nt), либо со таймкодами, если версия
// их всё равно печатает. Служебные строки (whisper_init…, system_info) отбрасываем.
function parseOutput(stdout) {
  const lines = String(stdout == null ? '' : stdout).split('\n');
  const out = [];
  for (const raw of lines) {
    let t = raw.trim();
    if (!t) continue;
    if (/^(whisper_|system_info|main:|ggml_)/i.test(t)) continue;
    t = t.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, '');   // таймкод, если он есть
    if (!t || t === '[BLANK_AUDIO]' || /^\(.*\)$/.test(t)) continue;
    out.push(t);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Что показать в настройках, когда голос не настроен: инструкция своя на каждую ОС,
// потому что brew есть только на маке. Нужна лишь для ручной настройки — обычный путь
// теперь одна кнопка (см. ниже).
function setupHint(platform) {
  if (platform === 'win32') {
    return 'Windows: скачайте готовый whisper.cpp из его релизов на GitHub, распакуйте и'
      + ' укажите путь к whisper-cli.exe. Модель — ggml-base или крупнее, файл .bin.';
  }
  if (platform === 'linux') {
    return 'Linux: соберите whisper.cpp из исходников или поставьте пакетом дистрибутива и'
      + ' укажите путь к whisper-cli. Модель — ggml-base или крупнее, файл .bin.';
  }
  return 'macOS: brew install whisper-cpp. Модель скачайте отдельно (ggml-base или крупнее,'
    + ' файл .bin) и укажите путь к ней.';
}

// --- Установка одной кнопкой ---------------------------------------------------
// РЕШЕНИЕ, определяющее эту часть: ни распознаватель, ни модель НЕ лежат в сборке. Кому
// голос не нужен, тот не платит за него ничем — ни размером приложения, ни весом
// обновления (они ходят свопом app.asar, так что вложенный бинарник дорожал бы каждое
// обновление для всех). Кому нужен — жмёт одну кнопку, и всё скачивается в его профиль.
// Ни консоли, ни brew, ни путей руками.
const RUNTIME_DIRNAME = 'voice';        // папка внутри userData

// Модели — канонические файлы whisper.cpp с HuggingFace. sha256 зашиты намеренно:
// оборванные 148 МБ иначе не отличить от целых, и это выглядело бы как «ничего не
// разобрал», то есть худшая из возможных диагностик.
const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const MODELS = [
  { id: 'tiny', bytes: 77691713, label: 'Крошечная',
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    note: 'быстрее всех, но на русском путает имена и термины' },
  { id: 'base', bytes: 147951465, label: 'Обычная', recommended: true,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    note: 'разумный выбор по умолчанию' },
  { id: 'small', bytes: 487601967, label: 'Крупная',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    note: 'заметно точнее на русском, вчетверо тяжелее' },
];

function modelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.recommended);
}

function modelUrl(id) {
  return `${MODEL_HOST}/ggml-${modelById(id).id}.bin`;
}

function modelFileName(id) {
  return `ggml-${modelById(id).id}.bin`;
}

// Сам распознаватель описан МАНИФЕСТОМ в реестре, а не зашит здесь: тогда новую сборку
// whisper.cpp можно выложить, не выпуская версию приложения — тот же приём, которым уже
// живёт обновлялка. Манифест: { "darwin-arm64": { bin, files: [{name, bytes, sha256}] } }.
function runtimeKey(platform, arch) {
  return `${platform}-${arch}`;
}

function runtimeEntry(manifest, platform, arch) {
  const m = manifest && manifest.runtimes;
  if (!m) return null;
  const e = m[runtimeKey(platform, arch)];
  if (!e || !e.bin || !Array.isArray(e.files) || !e.files.length) return null;
  return e;
}

// Что скачать и куда для одной установки: распознаватель (если его ещё нет) плюс модель.
// `have` — что уже лежит на диске целым, чтобы повторное нажатие не тянуло всё заново.
function installPlan(opts) {
  const o = opts || {};
  const join = typeof o.join === 'function' ? o.join : ((a, b) => a + '/' + b);
  const dir = o.dir || '';
  const have = o.have instanceof Set ? o.have : new Set(o.have || []);
  const items = [];
  const entry = runtimeEntry(o.manifest, o.platform, o.arch);
  if (!entry) return { ok: false, reason: 'no-runtime', items: [], bytes: 0 };
  for (const f of entry.files) {
    items.push({
      kind: 'runtime',
      name: f.name,
      url: `${String(o.base || '').replace(/\/+$/, '')}/${f.name}`,
      target: join(dir, f.name),
      bytes: f.bytes || 0,
      sha256: f.sha256 || '',
      // Исполняемым бит нужен только бинарнику: на маке скачанный файл без +x не
      // запустится, а «не смог запустить whisper» — бесполезное сообщение.
      exec: f.name === entry.bin,
    });
  }
  const model = modelById(o.modelId);
  items.push({
    kind: 'model',
    name: modelFileName(model.id),
    url: modelUrl(model.id),
    target: join(dir, modelFileName(model.id)),
    bytes: model.bytes,
    sha256: model.sha256,
    exec: false,
  });
  const todo = items.filter((i) => !have.has(i.name));
  return {
    ok: true,
    bin: join(dir, entry.bin),
    model: join(dir, modelFileName(model.id)),
    items: todo,
    bytes: todo.reduce((s, i) => s + i.bytes, 0),
  };
}

// Доля скачанного по всему плану, 0..1. Считается по байтам, а не по файлам: иначе
// полоса стоит на месте всё время загрузки модели и дёргается на мелких dll.
function planProgress(plan, doneBytes) {
  const total = plan && plan.bytes ? plan.bytes : 0;
  if (!total) return 1;
  return Math.max(0, Math.min(1, (Number(doneBytes) || 0) / total));
}

function humanBytes(n) {
  const v = Number(n) || 0;
  return v >= 1e9 ? (v / 1e9).toFixed(1) + ' ГБ' : Math.round(v / 1e6) + ' МБ';
}

module.exports = {
  SAMPLE_RATE, BIN_NAMES, wavFromFloat32, findBinary, whisperArgs, parseOutput, setupHint,
  RUNTIME_DIRNAME, MODELS, MODEL_HOST, modelById, modelUrl, modelFileName,
  runtimeKey, runtimeEntry, installPlan, planProgress, humanBytes,
};
