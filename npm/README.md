# claude-swarm

Установщик [Swarm](https://github.com/raul-cortez/claude-swarm) — пульта для нескольких сессий Claude Code сразу: вкладка на агента, цвет по состоянию, ответ из Telegram, когда вас нет за компьютером.

```bash
npx claude-swarm
```

Приложение окажется в «Программах» и откроется без предупреждений системы: карантин вешает на файл то приложение, которое его скачало, а этот установщик берёт образ сам.

Ставится всегда последняя версия. Дальше Swarm обновляется сам, кнопкой внутри — переустанавливать через npm не нужно.

Требуется macOS на Apple Silicon или Linux x86_64 и установленный Claude Code (`claude --version`). На Linux Swarm появится в меню приложений и командой `swarm`. Для Windows в релизах лежит обычный `.exe`.

Что именно делает установщик, видно в [scripts/install.sh](https://github.com/raul-cortez/claude-swarm/blob/main/scripts/install.sh) — он же лежит внутри пакета.
