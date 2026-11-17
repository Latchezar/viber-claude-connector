#!/usr/bin/env bash
# Fetch the Qt headers that match the Qt bundled inside Viber.app — QtCore + QtSql only, a few MB —
# into a per-user cache shared by every checkout and plugin version (QT_DEST overrides the target).
# Uses aqtinstall (https://github.com/miurahr/aqtinstall) in a throwaway venv.
set -euo pipefail

VIBER_APP="${VIBER_APP:-/Applications/Viber.app}"
FW="$VIBER_APP/Contents/Frameworks"
DEFAULT_VER="$(otool -L "$FW/QtCore.framework/QtCore" | awk '/QtCore.framework/ && /current version/ {print $NF; exit}' | tr -d ')')"
QT_VER="${QT_VER:-$DEFAULT_VER}"
DEST="${QT_DEST:-${VIBER_QT_CACHE:-$HOME/Library/Caches/viber-connector}/qt-$QT_VER/lib}"

if [ -d "$DEST/QtSql.framework/Headers" ]; then
  echo "[*] Qt $QT_VER headers already present in $DEST"; exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "[*] fetching Qt $QT_VER qtbase via aqtinstall (temporary venv in $TMP)"
python3 -m venv "$TMP/venv"
"$TMP/venv/bin/pip" install --quiet --disable-pip-version-check aqtinstall
( cd "$TMP" && "$TMP/venv/bin/aqt" install-qt mac desktop "$QT_VER" clang_64 --archives qtbase --outputdir "$TMP/qt" >/dev/null )

# Stage, then move into place in one step (another build may be fetching the same version).
mkdir -p "$TMP/stage"
for fw in QtCore QtSql; do
  mkdir -p "$TMP/stage/$fw.framework"
  cp -RL "$TMP/qt/$QT_VER/macos/lib/$fw.framework/Headers" "$TMP/stage/$fw.framework/Headers"
done
mkdir -p "$(dirname "$DEST")"
[ -d "$DEST" ] || mv "$TMP/stage" "$DEST"
echo "[*] headers installed in $DEST"
