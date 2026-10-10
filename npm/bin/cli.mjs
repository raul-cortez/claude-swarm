#!/usr/bin/env node
// npx claude-swarm — поставить Swarm.
//
// Пакет намеренно крошечный: это установщик, а не само приложение. Внутри лежит тот же
// scripts/install.sh, что и в репозитории (кладётся при публикации, см. prepack), —
// логика установки живёт в одном месте, а npm тут только привычный способ её запустить.
//
// Версия пакета не совпадает с версией Swarm и не должна: установщик всегда берёт
// последний релиз, поэтому переиздавать его на каждую версию приложения не нужно.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'install.sh');

if (process.platform === 'win32') {
  console.error([
    'Для Windows установщика в npm нет: там обычный .exe.',
    'Возьмите его в релизах: https://github.com/raul-cortez/claude-swarm/releases/latest',
  ].join('\n'));
  process.exit(1);
}

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error('Swarm собирается под macOS, Windows и Linux; для этой системы сборок нет.');
  process.exit(1);
}

const r = spawnSync('/bin/sh', [script], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
