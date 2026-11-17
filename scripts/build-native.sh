#!/usr/bin/env bash
# Build the native helpers into ./build (private to the server; deliberately not ./bin):
#   build/viberdb  — C++ read-only DB harness (links Viber's own Qt + SEE codec at runtime)
#   build/viberax  — Swift Accessibility helper (UI automation for sending and reacting)
# Run by `npm run build`, and by the server itself on first start (src/setup.ts), which passes
# VIBER_BUILD_LOCK (a lock dir to remove when done) and VIBER_BUILD_FAILED (a marker to write on failure).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build"
VIBER_APP="${VIBER_APP:-/Applications/Viber.app}"
FW="$VIBER_APP/Contents/Frameworks"
SOURCES=(native/viberdb/viberdb.cpp native/viberax/main.swift scripts/build-native.sh)

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "[!] build failed (exit $code)" >&2
    [ -n "${VIBER_BUILD_FAILED:-}" ] && printf '{"at":%s,"code":%s}\n' "$(date +%s)" "$code" > "$VIBER_BUILD_FAILED"
  fi
  [ -n "${VIBER_BUILD_LOCK:-}" ] && rm -rf "$VIBER_BUILD_LOCK"
  rm -f "$OUT/viberdb.tmp" "$OUT/viberax.tmp"
  exit "$code" # keep the build's own exit status (the trap's last command would replace it)
}
trap on_exit EXIT

if [ ! -f "$FW/QtCore.framework/QtCore" ]; then
  echo "Viber Desktop not found at $VIBER_APP (install it, or set VIBER_APP=/path/to/Viber.app)" >&2
  exit 1
fi
# Without the command line tools, macOS still has clang++/swiftc stubs, so check the tools themselves.
if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "The Xcode command line tools are not installed. Run: xcode-select --install" >&2
  exit 1
fi

# The headers must match the Qt version bundled inside Viber.app (it changes with Viber updates).
RUNTIME_QT="$(otool -L "$FW/QtCore.framework/QtCore" | awk '/QtCore.framework/ && /current version/ {print $NF; exit}' | tr -d ')')"
QT_VER="${QT_VER:-$RUNTIME_QT}"
# Per-user cache shared by every checkout and plugin version; an older ./vendor copy is still used if present.
QTINC="$ROOT/vendor/qt-$QT_VER/lib"
if [ ! -d "$QTINC/QtCore.framework/Headers" ]; then
  QTINC="${VIBER_QT_CACHE:-$HOME/Library/Caches/viber-connector}/qt-$QT_VER/lib"
fi
if [ ! -d "$QTINC/QtCore.framework/Headers" ]; then
  echo "[*] Qt $QT_VER headers not found; fetching them once (QtCore + QtSql only) into $QTINC"
  QT_VER="$QT_VER" QT_DEST="$QTINC" VIBER_APP="$VIBER_APP" "$ROOT/scripts/fetch-qt-headers.sh"
fi
if [ "${RUNTIME_QT%.*}" != "${QT_VER%.*}" ]; then
  echo "WARNING: Viber ships Qt $RUNTIME_QT but headers are $QT_VER (QT_VER override)." >&2
fi

mkdir -p "$OUT"
rm -f "$OUT/stamp.json" # not "up to date" until this build succeeds

echo "[*] building build/viberdb (Qt headers $QT_VER, runtime Qt $RUNTIME_QT from $VIBER_APP)"
clang++ -std=c++17 -O2 -Wall -Wextra \
  -iframework "$QTINC" \
  -I "$QTINC/QtCore.framework/Headers" -I "$QTINC/QtSql.framework/Headers" \
  "$ROOT/native/viberdb/viberdb.cpp" -o "$OUT/viberdb.tmp" \
  "$FW/QtCore.framework/QtCore" "$FW/QtSql.framework/QtSql" \
  -Wl,-rpath,"$FW"

echo "[*] building build/viberax"
swiftc -O "$ROOT/native/viberax/main.swift" -o "$OUT/viberax.tmp" \
  -framework ApplicationServices -framework AppKit -framework Vision

# Swap in atomically, then record what was built (src/setup.ts compares this stamp).
mv -f "$OUT/viberdb.tmp" "$OUT/viberdb"
mv -f "$OUT/viberax.tmp" "$OUT/viberax"
{
  printf '{"qt":"%s","sources":{' "$RUNTIME_QT"
  sep=""
  for f in "${SOURCES[@]}"; do
    printf '%s"%s":"%s"' "$sep" "$f" "$(shasum -a 256 "$ROOT/$f" | awk '{print $1}')"
    sep=","
  done
  printf '}}\n'
} > "$OUT/stamp.json.tmp"
mv -f "$OUT/stamp.json.tmp" "$OUT/stamp.json"
if [ -n "${VIBER_BUILD_FAILED:-}" ]; then rm -f "$VIBER_BUILD_FAILED"; fi
echo "[*] done"
