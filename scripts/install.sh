#!/bin/sh
# install.sh — установка Swarm на macOS и Linux одной командой.
#
# Зачем отдельный установщик, когда есть dmg. Карантин («не удалось проверить
# разработчика») вешает на файл не система сама по себе, а приложение, которое его
# скачало: браузеры и почта помечают загрузки, curl — нет. Поэтому приложение, принесённое
# этим скриптом, запускается сразу, без обхода Gatekeeper и без команд в терминале после.
# Заверение у Apple (и платная подписка разработчика) нужны ровно для того же самого — и
# только для случая, когда dmg скачали браузером.
#
# Целостность образа проверяет сам hdiutil: в dmg есть контрольная сумма, и с битым
# файлом он просто не смонтируется.
#
# Запуск:
#   curl -fsSL https://raw.githubusercontent.com/raul-cortez/claude-swarm/main/scripts/install.sh | sh
#
# Куда ставит: на маке — /Программы, если туда можно писать, иначе ~/Applications; на Linux —
# ~/.local/share/swarm, с ярлыком в меню и командой `swarm`. Переопределяется переменной
# SWARM_DEST (этим же пользуются проверки).
set -eu

REPO=raul-cortez/claude-swarm
MANIFEST="https://github.com/$REPO/releases/latest/download/manifest.json"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
step() { printf '▸ %s\n' "$*"; }

# Поле манифеста по имени: jq у людей стоит не всегда, а манифест наш и плоский.
field() { printf '%s\n' "$manifest" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\\1/p" | head -1; }

# Полоска прогресса — только когда есть кому смотреть: в перенаправленный вывод она
# высыпается тысячей строк (так и обнаружилось).
fetch() {
  if [ -t 1 ]; then curl -fL# -o "$2" "$1"; else curl -fsSL -o "$2" "$1"; fi
}

# --- Linux ------------------------------------------------------------------------------
# AppImage не запускаем как есть, а распаковываем один раз. Запуск «как есть» требует FUSE 2,
# а его на свежих Ubuntu/Kubuntu нет из коробки, и человек получил бы непонятную ошибку про
# libfuse вместо окна. Распакованный — обычная папка: ни FUSE, ни прав администратора.
# Обновления это не трогает: они ложатся в папку настроек, а не в папку приложения.
install_linux() {
  [ "$(uname -m)" = "x86_64" ] || die "сборки для Linux есть только под x86_64 (у вас $(uname -m))"
  # Своя подпапка внутри DEST, как Swarm.app на маке: ниже она удаляется целиком, и
  # указанный руками SWARM_DEST=$HOME не должен этим стать.
  DEST="${SWARM_DEST:-${XDG_DATA_HOME:-$HOME/.local/share}}/swarm"
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  bindir="$HOME/.local/bin"

  # По пути, а не по имени: `swarm` зовут и чужие программы, и мешать они не должны.
  if pgrep -f "$DEST/swarm" >/dev/null 2>&1; then
    die "Swarm сейчас запущен — закройте его и повторите"
  fi

  step "узнаю последнюю версию"
  manifest=$(curl -fsSL "$MANIFEST") || die "не скачался манифест — проверьте связь"
  url=$(field appimage); ver=$(field version)
  [ -n "$url" ] || die "в последнем релизе ещё нет сборки для Linux"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  step "качаю Swarm ${ver:-}"
  fetch "$url" "$tmp/swarm.AppImage" || die "не скачался AppImage"
  chmod +x "$tmp/swarm.AppImage"

  step "распаковываю"
  (cd "$tmp" && ./swarm.AppImage --appimage-extract >/dev/null) \
    || die "AppImage не распаковался (возможно, скачался битым — повторите)"
  [ -x "$tmp/squashfs-root/AppRun" ] || die "в AppImage нет приложения"

  step "ставлю в $DEST"
  mkdir -p "$(dirname "$DEST")" "$apps" "$bindir"
  rm -rf "$DEST"
  mv "$tmp/squashfs-root" "$DEST"

  # Запускаем через AppRun, а не сам бинарник: AppRun проверяет, разрешены ли системой
  # пространства имён, на которых держится песочница Chromium (Ubuntu 24.04 и всё, что от
  # неё, их запрещает), и только тогда добавляет --no-sandbox. Где запрета нет, песочница
  # остаётся.
  cat > "$bindir/swarm" <<LAUNCH
#!/bin/sh
exec "$DEST/AppRun" "\$@"
LAUNCH
  chmod +x "$bindir/swarm"

  icon="$DEST/swarm.png"
  [ -f "$icon" ] || icon="$DEST/.DirIcon"
  # Имя файла — то же, что desktopName в package.json: по нему KDE на Wayland узнаёт окно
  # и показывает в панели нашу иконку, а не безымянную.
  cat > "$apps/swarm.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Swarm
Comment=Several Claude Code sessions in tabs
Exec="$bindir/swarm" %U
Icon=$icon
Terminal=false
Categories=Development;
StartupWMClass=swarm
DESKTOP
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true
  command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
  command -v kbuildsycoca5 >/dev/null 2>&1 && kbuildsycoca5 >/dev/null 2>&1 || true

  printf '\n✔ Готово: Swarm есть в меню приложений\n'
  printf '  Из терминала: swarm\n'
  case ":$PATH:" in *":$bindir:"*) ;; *) printf '  (папки %s нет в PATH — запускайте из меню или полным путём)\n' "$bindir" ;; esac
  printf '  Нужен установленный Claude Code — проверьте командой: claude --version\n'
}

case "$(uname -s)" in
  Linux) install_linux; exit 0 ;;
  Darwin) ;;
  *) die "это установщик для macOS и Linux; для Windows есть .exe в релизах" ;;
esac
[ "$(uname -m)" = "arm64" ] || die "сборки есть только для Apple Silicon (у вас $(uname -m))"

DEST="${SWARM_DEST:-}"
if [ -z "$DEST" ]; then
  if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; fi
fi
mkdir -p "$DEST"

# Подменять файлы работающего приложения нельзя: оно живёт в них прямо сейчас.
if pgrep -x Swarm >/dev/null 2>&1; then
  die "Swarm сейчас запущен — закройте его и повторите"
fi

step "узнаю последнюю версию"
manifest=$(curl -fsSL "$MANIFEST") || die "не скачался манифест — проверьте связь"
url=$(field dmg); ver=$(field version)
[ -n "$url" ] || die "в манифесте нет ссылки на образ"

mnt=""
tmp=$(mktemp -d)
cleanup() {
  [ -n "$mnt" ] && hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

step "качаю Swarm ${ver:-}"
fetch "$url" "$tmp/swarm.dmg" || die "не скачался образ"

step "распаковываю"
mnt=$(hdiutil attach -nobrowse -readonly "$tmp/swarm.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)
[ -n "$mnt" ] || die "образ не смонтировался (возможно, скачался битым — повторите)"
app=$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)
[ -n "$app" ] || die "в образе нет приложения"
name=$(basename "$app")

step "ставлю в $DEST"
rm -rf "$DEST/$name"
# ditto, а не cp: сохраняет подпись и права внутри бандла как есть.
ditto "$app" "$DEST/$name"
# На всякий случай: если папку назначения когда-то пометили карантином, снимаем.
xattr -dr com.apple.quarantine "$DEST/$name" >/dev/null 2>&1 || true

printf '\n✔ Готово: %s/%s\n' "$DEST" "$name"
printf '  Открыть: open "%s/%s"\n' "$DEST" "$name"
printf '  Нужен установленный Claude Code — проверьте командой: claude --version\n'
