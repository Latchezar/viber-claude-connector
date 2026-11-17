#!/usr/bin/env bash
# Fetch Qt headers that match the Qt version bundled inside Viber.app, keeping only
# QtCore + QtSql headers in ./vendor (a few MB). Uses aqtinstall in a throwaway venv.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIBER_APP="${VIBER_APP:-/Applications/Viber.app}"
FW="$VIBER_APP/Contents/Frameworks"
DEFAULT_VER="$(otool -L "$FW/QtCore.framework/QtCore" | awk '/QtCore.framework/ && /current version/ {print $NF; exit}' | tr -d ')')"
QT_VER="${QT_VER:-$DEFAULT_VER}"
DEST="$ROOT/vendor/qt-$QT_VER/lib"

if [ -d "$DEST/QtSql.framework/Headers" ]; then
  echo "[*] Qt $QT_VER headers already present in $DEST"; exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "[*] fetching Qt $QT_VER qtbase via aqtinstall (temporary venv in $TMP)"
python3 -m venv "$TMP/venv"
"$TMP/venv/bin/pip" install --quiet aqtinstall
( cd "$TMP" && "$TMP/venv/bin/aqt" install-qt mac desktop "$QT_VER" clang_64 --archives qtbase --outputdir "$TMP/qt" >/dev/null )

mkdir -p "$DEST"
for fw in QtCore QtSql; do
  mkdir -p "$DEST/$fw.framework"
  cp -RL "$TMP/qt/$QT_VER/macos/lib/$fw.framework/Headers" "$DEST/$fw.framework/Headers"
done
echo "[*] headers installed in $DEST"
