#!/usr/bin/env bash
# Build the native helpers into ./bin:
#   bin/viberdb  — C++ read-only DB harness (links Viber's own Qt + SEE codec at runtime)
#   bin/viberax  — Swift Accessibility helper (UI automation for sending)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIBER_APP="${VIBER_APP:-/Applications/Viber.app}"
FW="$VIBER_APP/Contents/Frameworks"

if [ ! -f "$FW/QtCore.framework/QtCore" ]; then
  echo "Viber Desktop not found at $VIBER_APP (install it, or set VIBER_APP=/path/to/Viber.app)" >&2
  exit 1
fi
for tool in clang++ swiftc otool; do
  command -v "$tool" >/dev/null || { echo "$tool not found: install the Xcode command line tools (xcode-select --install)" >&2; exit 1; }
done

# The headers must match the Qt version bundled inside Viber.app (it changes with Viber updates).
RUNTIME_QT="$(otool -L "$FW/QtCore.framework/QtCore" | awk '/QtCore.framework/ && /current version/ {print $NF; exit}' | tr -d ')')"
QT_VER="${QT_VER:-$RUNTIME_QT}"
QTINC="$ROOT/vendor/qt-$QT_VER/lib"

mkdir -p "$ROOT/bin"

if [ ! -d "$QTINC/QtCore.framework/Headers" ]; then
  echo "[*] Qt $QT_VER headers not found; fetching them once (QtCore + QtSql only)"
  QT_VER="$QT_VER" VIBER_APP="$VIBER_APP" "$ROOT/scripts/fetch-qt-headers.sh"
fi

if [ "${RUNTIME_QT%.*}" != "${QT_VER%.*}" ]; then
  echo "WARNING: Viber ships Qt $RUNTIME_QT but headers are $QT_VER." >&2
  echo "         Re-run: QT_VER=$RUNTIME_QT scripts/fetch-qt-headers.sh && QT_VER=$RUNTIME_QT $0" >&2
fi

echo "[*] building bin/viberdb (Qt headers $QT_VER, runtime Qt $RUNTIME_QT from $VIBER_APP)"
clang++ -std=c++17 -O2 -Wall -Wextra \
  -iframework "$QTINC" \
  -I "$QTINC/QtCore.framework/Headers" -I "$QTINC/QtSql.framework/Headers" \
  "$ROOT/native/viberdb/viberdb.cpp" -o "$ROOT/bin/viberdb" \
  "$FW/QtCore.framework/QtCore" "$FW/QtSql.framework/QtSql" \
  -Wl,-rpath,"$FW"

if [ -f "$ROOT/native/viberax/main.swift" ]; then
  echo "[*] building bin/viberax"
  swiftc -O "$ROOT/native/viberax/main.swift" -o "$ROOT/bin/viberax" \
    -framework ApplicationServices -framework AppKit -framework Vision
fi

echo "[*] done"
