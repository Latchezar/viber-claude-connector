#!/usr/bin/env python3
"""Dev helper: run read-only SQL against viber.db through build/viberdb.

usage: scripts/q.py "SELECT ..." [param ...]
       scripts/q.py -f queries.sql          (one statement per ';'-separated chunk)
Prints a simple aligned table per statement. Never prints the key.
"""
import glob
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_db():
    if os.environ.get("VIBER_DB"):
        return os.environ["VIBER_DB"]
    cands = glob.glob(os.path.expanduser("~/Library/Application Support/ViberPC/*/viber.db"))
    if not cands:
        sys.exit("viber.db not found")
    return max(cands, key=os.path.getmtime)


def keys():
    user = os.environ.get("VIBER_USERNAME") or os.environ["USER"]
    return [("aes128:" + user[::-1]).encode().hex()]


def run(queries):
    req = {"db": find_db(), "keys": keys(), "queries": queries, "maxRows": 200}
    p = subprocess.run([os.path.join(ROOT, "build", "viberdb")], input=json.dumps(req),
                       capture_output=True, text=True)
    out = json.loads(p.stdout)
    if not out.get("ok"):
        sys.exit("ERROR: " + out.get("error", p.stderr))
    return out["results"]


def show(res, width=60):
    cols = res["columns"]
    rows = [[("" if v is None else str(v)).replace("\n", "⏎")[:width] for v in r] for r in res["rows"]]
    w = [max([len(c)] + [len(r[i]) for r in rows]) for i, c in enumerate(cols)]
    print(" | ".join(c.ljust(w[i]) for i, c in enumerate(cols)))
    print("-+-".join("-" * x for x in w))
    for r in rows:
        print(" | ".join(v.ljust(w[i]) for i, v in enumerate(r)))
    if res.get("truncated"):
        print("… (truncated)")
    print()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "-f":
        sql = open(sys.argv[2]).read()
        qs = [{"sql": s.strip()} for s in sql.split(";") if s.strip()]
    else:
        qs = [{"sql": sys.argv[1], "params": sys.argv[2:]}]
    for r in run(qs):
        show(r)
