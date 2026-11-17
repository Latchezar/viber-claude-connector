#!/usr/bin/env python3
"""Add the "viber" MCP server to the Claude desktop app's config (idempotent, safe).

- Backs up the existing file first (claude_desktop_config.json.bak-YYYYmmdd-HHMMSS).
- Only adds/replaces mcpServers.viber; every other key and server entry is kept as-is
  (verified after writing). Creates the file if it doesn't exist.
- Absolute paths only: the node binary and the entry point — the desktop app does not
  load your shell (no nvm/PATH lookups at runtime).
- Atomic write (temp file + rename), keeps the file's permissions, validates the JSON.

usage: python3 scripts/install-desktop-config.py [--node /abs/path/to/node] [--confirm client|dialog] [--dry-run]
  --confirm dialog  every send/reaction shows a macOS dialog (Cancel is the default button)
  --confirm client  no extra dialog: the desktop app's own "Allow tool?" prompt is the confirmation
                    (never choose "Always allow"/"Allow for this chat" for the sending tools)
  Without --confirm the current setting is kept (default for a new entry: dialog).
Run it while the Claude desktop app is closed if you want to be sure the app doesn't
overwrite the file with a stale copy when it quits.
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"
MIN_NODE = (22, 13)  # node:sqlite without flags


def pick_node(explicit):
    node = explicit or shutil.which("node")
    if not node:
        sys.exit("node not found; pass --node /absolute/path/to/node")
    node = os.path.realpath(node)
    out = subprocess.run([node, "--version"], capture_output=True, text=True, env={"HOME": str(Path.home())}).stdout.strip()
    try:
        major, minor = (int(x) for x in out.lstrip("v").split(".")[:2])
    except ValueError:
        sys.exit(f"could not run {node} --version (got {out!r})")
    if (major, minor) < MIN_NODE:
        sys.exit(f"{node} is {out}; need >= v{MIN_NODE[0]}.{MIN_NODE[1]} (node:sqlite)")
    return node, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", help="absolute path of the node binary to use")
    ap.add_argument("--confirm", choices=["client", "dialog"], help="how sends are confirmed in the desktop app")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    node, version = pick_node(a.node)
    entry_point = ROOT / "dist" / "index.js"
    if not entry_point.exists():
        sys.exit(f"{entry_point} missing; run `npm run build` first")
    raw = CONFIG.read_text(encoding="utf-8") if CONFIG.exists() else None
    original = json.loads(raw) if raw and raw.strip() else {}
    if not isinstance(original, dict):
        sys.exit(f"{CONFIG} is not a JSON object; not touching it")
    data = json.loads(json.dumps(original))  # deep copy, same key order
    servers = data.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        sys.exit('"mcpServers" is not an object; not touching it')
    current = ((servers.get("viber") or {}).get("env") or {}).get("VIBER_CONFIRM")
    confirm = a.confirm or (current if current in ("client", "dialog") else "dialog")
    entry = {
        "command": node,
        "args": [str(entry_point)],
        "env": {
            # dialog: macOS dialog per send; client: the desktop app's own tool-approval prompt.
            # (No state dir here: every copy uses the shared per-user default, so the send
            # lock and rate limits are shared with Claude Code automatically.)
            "VIBER_CONFIRM": confirm,
        },
    }

    print(f"node:   {node} ({version})")
    print(f"config: {CONFIG}")
    print(f"confirm: {confirm}" + ("  (no extra dialog — never 'Always allow' the sending tools)" if confirm == "client" else "  (macOS dialog)"))
    if servers.get("viber") == entry:
        print("viber entry already up to date; nothing to do")
        return
    servers["viber"] = entry
    if a.dry_run:
        print(json.dumps({"viber": entry}, indent=2))
        return

    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    mode = 0o600
    if raw is not None:
        mode = CONFIG.stat().st_mode & 0o777
        backup = CONFIG.with_name(f"{CONFIG.name}.bak-{datetime.datetime.now():%Y%m%d-%H%M%S}")
        shutil.copy2(CONFIG, backup)
        print(f"backup: {backup}")
    text = json.dumps(data, indent=2, ensure_ascii=False)
    if raw is None or raw.endswith("\n"):
        text += "\n"
    fd, tmp = tempfile.mkstemp(dir=CONFIG.parent, prefix=".claude_desktop_config.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, CONFIG)

    # Validate: parses, viber entry present, everything else unchanged.
    written = json.loads(CONFIG.read_text(encoding="utf-8"))
    assert written["mcpServers"]["viber"] == entry
    for k, v in original.items():
        if k != "mcpServers":
            assert written[k] == v, f"top-level key {k!r} changed"
    for name, cfg in (original.get("mcpServers") or {}).items():
        if name != "viber":
            assert written["mcpServers"][name] == cfg, f"server {name!r} changed"
    print("written and validated: JSON parses, viber added, all other entries unchanged")


if __name__ == "__main__":
    main()
