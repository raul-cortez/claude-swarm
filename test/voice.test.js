// Тесты чистой части голосового ввода (voice.js): WAV-упаковка, поиск бинарника,
// аргументы и разбор вывода whisper.cpp. Без сети, без звука, без самого whisper.
const assert = require('assert');
const V = require('../voice');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('wavFromFloat32 пишет корректный заголовок 16 кГц моно 16 бит', () => {
  const wav = V.wavFromFloat32(new Float32Array(8), 16000);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.readUInt16LE(22), 1, 'моно');
  assert.strictEqual(wav.readUInt32LE(24), 16000);
  assert.strictEqual(wav.readUInt16LE(34), 16, 'бит на сэмпл');
  assert.strictEqual(wav.readUInt32LE(40), 16, 'размер data = 8 сэмплов * 2 байта');
  assert.strictEqual(wav.length, 44 + 16);
});

test('wavFromFloat32 клиппит громкое, а не заворачивает его в треск', () => {
  const wav = V.wavFromFloat32([2, -2, 0], 16000);
  assert.strictEqual(wav.readInt16LE(44), 32767);
  assert.strictEqual(wav.readInt16LE(46), -32768);
  assert.strictEqual(wav.readInt16LE(48), 0);
});

test('wavFromFloat32 не падает на пустом входе', () => {
  assert.strictEqual(V.wavFromFloat32(null).length, 44);
});

// --- поиск бинарника ---------------------------------------------------------

const finder = (present, over) => V.findBinary(Object.assign({
  pathEnv: '/opt/homebrew/bin:/usr/bin',
  exists: (p) => present.includes(p),
  join: (a, b) => a + '/' + b,
}, over));

test('findBinary берёт первое подходящее имя из PATH', () => {
  assert.strictEqual(finder(['/usr/bin/whisper-cli']), '/usr/bin/whisper-cli');
  assert.strictEqual(finder(['/opt/homebrew/bin/whisper-cpp']), '/opt/homebrew/bin/whisper-cpp');
});

test('findBinary на Windows ищет .exe и по ; в PATH', () => {
  const got = V.findBinary({
    isWin: true,
    pathEnv: 'C:\\tools;C:\\bin',
    join: (a, b) => a + '\\' + b,
    exists: (p) => p === 'C:\\tools\\whisper-cli.exe',
  });
  assert.strictEqual(got, 'C:\\tools\\whisper-cli.exe');
});

test('указанный руками путь не подменяется тихо чем-то из PATH', () => {
  assert.strictEqual(finder(['/usr/bin/whisper-cli'], { configured: '/opt/my/whisper' }), null,
    'промах в настройках должен быть виден, а не замаскирован');
  assert.strictEqual(finder(['/opt/my/whisper'], { configured: '/opt/my/whisper' }), '/opt/my/whisper');
});

test('findBinary возвращает null, когда ничего нет', () => {
  assert.strictEqual(finder([]), null);
  assert.strictEqual(V.findBinary(null), null);
});

// --- аргументы и разбор ------------------------------------------------------

test('whisperArgs просит текст без таймкодов и без прогресса', () => {
  const a = V.whisperArgs({ model: '/m/ggml-base.bin', wav: '/tmp/a.wav' });
  assert.deepStrictEqual(a, ['-m', '/m/ggml-base.bin', '-f', '/tmp/a.wav', '-l', 'ru', '-nt', '-np']);
});

test('parseOutput достаёт фразу и выбрасывает служебные строки', () => {
  const out = [
    'whisper_init_from_file_with_params_no_state: loading model',
    'system_info: n_threads = 4',
    'Посмотри, почему падает тест на миграциях.',
  ].join('\n');
  assert.strictEqual(V.parseOutput(out), 'Посмотри, почему падает тест на миграциях.');
});

test('parseOutput снимает таймкод, если версия его печатает', () => {
  assert.strictEqual(V.parseOutput('[00:00:00.000 --> 00:00:03.100]   Открой api.'), 'Открой api.');
});

test('parseOutput на тишине даёт пустую строку, а не «[BLANK_AUDIO]»', () => {
  assert.strictEqual(V.parseOutput('[BLANK_AUDIO]'), '');
  assert.strictEqual(V.parseOutput('(музыка)'), '');
  assert.strictEqual(V.parseOutput(''), '');
  assert.strictEqual(V.parseOutput(null), '');
});

test('setupHint говорит про brew на маке, про релизы на винде и не про brew на Linux', () => {
  assert.ok(/brew install whisper-cpp/.test(V.setupHint('darwin')));
  assert.ok(/whisper-cli\.exe/.test(V.setupHint('win32')));
  assert.ok(/^Linux:/.test(V.setupHint('linux')));
  assert.ok(!/brew/.test(V.setupHint('linux')));
});

// --- установка одной кнопкой ---------------------------------------------------

const MANIFEST = {
  runtimes: {
    'darwin-arm64': { bin: 'whisper-cli', files: [{ name: 'whisper-cli', bytes: 2e6, sha256: 'aa' }] },
    // Как пишет whisper-linux.yml: файл назван по системе, потому что в том же релизе
    // лежит маковский whisper-cli.
    'linux-x64': {
      bin: 'whisper-cli-linux-x64',
      files: [{ name: 'whisper-cli-linux-x64', bytes: 3e6, sha256: 'dd' }],
    },
    'win32-x64': {
      bin: 'whisper-cli.exe',
      files: [
        { name: 'whisper-cli.exe', bytes: 480000, sha256: 'bb' },
        { name: 'whisper.dll', bytes: 1370000, sha256: 'cc' },
      ],
    },
  },
};
const plan = (over) => V.installPlan(Object.assign({
  dir: '/u/voice', platform: 'darwin', arch: 'arm64', modelId: 'base',
  manifest: MANIFEST, base: 'https://reg/deps/whisper/1.9.1',
}, over));

test('installPlan собирает распознаватель и модель с адресами и размерами', () => {
  const p = plan();
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.items.map((i) => i.name), ['whisper-cli', 'ggml-base.bin']);
  assert.strictEqual(p.items[0].url, 'https://reg/deps/whisper/1.9.1/whisper-cli');
  assert.ok(/huggingface\.co.*ggml-base\.bin$/.test(p.items[1].url));
  assert.strictEqual(p.bin, '/u/voice/whisper-cli');
  assert.strictEqual(p.model, '/u/voice/ggml-base.bin');
  assert.strictEqual(p.bytes, 2e6 + 147951465);
});

// Бит +x нужен только бинарнику: скачанный без него whisper на маке просто не запустится.
test('installPlan помечает исполняемым только сам бинарник', () => {
  assert.deepStrictEqual(plan({ platform: 'win32', arch: 'x64' }).items.map((i) => i.exec),
    [true, false, false]);
});

// Повторное нажатие после обрыва не должно тянуть заново то, что уже лежит целым.
test('installPlan пропускает уже скачанное', () => {
  const p = plan({ have: ['whisper-cli'] });
  assert.deepStrictEqual(p.items.map((i) => i.name), ['ggml-base.bin']);
  assert.strictEqual(p.bytes, 147951465);
  assert.strictEqual(p.bin, '/u/voice/whisper-cli');   // путь известен и без скачивания
});

test('installPlan на Linux берёт свой бинарник и делает его исполняемым', () => {
  const p = plan({ platform: 'linux', arch: 'x64' });
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.items.map((i) => i.name), ['whisper-cli-linux-x64', 'ggml-base.bin']);
  assert.strictEqual(p.bin, '/u/voice/whisper-cli-linux-x64');
  assert.deepStrictEqual(p.items.map((i) => i.exec), [true, false]);
});

test('installPlan отказывается на ОС, для которой распознавателя нет', () => {
  const p = plan({ platform: 'freebsd', arch: 'x64' });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'no-runtime');
});

test('модель по умолчанию — base, у каждой есть размер и sha256', () => {
  assert.strictEqual(V.modelById('нет такой').id, 'base');
  assert.strictEqual(V.modelById('small').id, 'small');
  for (const m of V.MODELS) {
    assert.ok(m.bytes > 1e7, m.id + ': размер');
    assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id + ': sha256');
  }
});

// Прогресс по байтам, а не по файлам: иначе полоса стоит всю модель и дёргается на dll.
test('planProgress считает долю по байтам', () => {
  const p = plan();
  assert.strictEqual(V.planProgress(p, 0), 0);
  assert.strictEqual(V.planProgress(p, p.bytes), 1);
  assert.ok(Math.abs(V.planProgress(p, p.bytes / 2) - 0.5) < 1e-9);
  assert.strictEqual(V.planProgress(p, p.bytes * 2), 1);   // не вылезает за единицу
  assert.strictEqual(V.planProgress({ bytes: 0 }, 0), 1);  // качать нечего = готово
});

test('humanBytes показывает мегабайты, а гигабайты с десятой', () => {
  assert.strictEqual(V.humanBytes(147951465), '148 МБ');
  assert.strictEqual(V.humanBytes(1.5e9), '1.5 ГБ');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL: ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
console.log(passed + '/' + tests.length + ' voice tests passed');
