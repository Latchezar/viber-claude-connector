#!/usr/bin/env python3
"""Start the server exactly as the Claude desktop app would — the command, args and env
from claude_desktop_config.json, in a clean environment (only HOME + the entry's env) —
and run an MCP handshake + a read-only tool call. Prints counts, not message content.

usage: python3 scripts/check-desktop-command.py [--client-name claude-ai]
"""
import argparse
import json
import os
import select
import shlex
import subprocess
import sys
import time
from pathlib import Path

CONFIG = Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"

ap = argparse.ArgumentParser()
ap.add_argument("--client-name", default="claude-ai", help='clientInfo.name to present (desktop app: "claude-ai")')
ap.add_argument("--drop-env", action="append", default=[], help="remove this env var from the entry (e.g. VIBER_CONFIRM, to test detection alone)")
a = ap.parse_args()

entry = json.loads(CONFIG.read_text(encoding="utf-8"))["mcpServers"]["viber"]
for p in [entry["command"], *entry["args"]]:
    assert os.path.isabs(p), f"not absolute: {p}"
env = {"HOME": str(Path.home()), **{k: v for k, v in entry.get("env", {}).items() if k not in a.drop_env}}
cmd = [entry["command"], *entry["args"]]
print("command:", "env -i " + " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items()) + " " + " ".join(map(shlex.quote, cmd)))

proc = subprocess.Popen(cmd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd="/")


def send(msg):
    proc.stdin.write((json.dumps(msg) + "\n").encode())
    proc.stdin.flush()


def wait_for(msg_id, timeout=30):
    deadline = time.time() + timeout
    buf = b""
    while time.time() < deadline:
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if not r:
            if proc.poll() is not None:
                sys.exit(f"server exited early (code {proc.returncode}): {proc.stderr.read().decode()[:500]}")
            continue
        buf += os.read(proc.stdout.fileno(), 1 << 20)
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            msg = json.loads(line)
            if msg.get("id") == msg_id:
                return msg
    sys.exit(f"timeout waiting for response {msg_id}")


send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "2025-06-18", "capabilities": {"elicitation": {}},
                 "clientInfo": {"name": a.client_name, "version": "0.1.0"}}})
init = wait_for(1)["result"]
print("initialize: server", init["serverInfo"], "| protocol", init["protocolVersion"], "| instructions:", bool(init.get("instructions")))
send({"jsonrpc": "2.0", "method": "notifications/initialized"})
send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
print("tools:", [t["name"] for t in wait_for(2)["result"]["tools"]])
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_unread", "arguments": {"per_chat": 1}}})
res = wait_for(3)["result"]
data = json.loads(res["content"][0]["text"])
print("get_unread:", "ERROR" if res.get("isError") else "ok",
      {k: data.get(k) for k in ("chats_with_unread_messages", "total_unread_messages", "total_missed_calls")})
time.sleep(1.5)  # let the async permission summary reach stderr
proc.stdin.close()
proc.wait(timeout=10)
print("stderr diagnostics:")
for line in proc.stderr.read().decode().splitlines():
    print("  " + line)
print("exit code:", proc.returncode)
