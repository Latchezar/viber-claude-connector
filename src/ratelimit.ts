// Human-pace guardrails for sending, SHARED by every copy of this server (Claude Code,
// the Claude desktop app, …) through one SQLite file with real cross-process locking.
//
// A send holds SQLite's write lock (BEGIN IMMEDIATE) from the limit check, through the
// confirmation dialog and delivery, until its outcome is recorded. Another copy that tries
// to send meanwhile gets "busy" instead of racing past the limits. If a process dies, the
// OS drops its file lock — no stale lock files. The log stores chat id, a hash and the
// length of the text — never the text itself.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { STATE_DIR } from "./config.js";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const LIMITS = {
  minIntervalMs: num(process.env.VIBER_MIN_SEND_INTERVAL_S, 30) * 1000,
  maxPerHour: num(process.env.VIBER_MAX_SENDS_PER_HOUR, 10),
  maxPerDay: num(process.env.VIBER_MAX_SENDS_PER_DAY, 40),
  maxTextChars: num(process.env.VIBER_MAX_TEXT_CHARS, 2000),
};

/** Reactions are lighter than messages but still visible to others: their own human pace. */
export const REACTION_LIMITS = {
  minIntervalMs: num(process.env.VIBER_MIN_REACTION_INTERVAL_S, 10) * 1000,
  maxPerHour: num(process.env.VIBER_MAX_REACTIONS_PER_HOUR, 20),
  maxPerDay: num(process.env.VIBER_MAX_REACTIONS_PER_DAY, 60),
};

export type Action = "message" | "reaction";

export type Outcome = "sent" | "sent_unconfirmed" | "cancelled" | "failed";

export interface LogEntry {
  ts: number;
  chat_id: number;
  text_sha: string;
  len: number;
  outcome: Outcome;
  event_id?: number;
  detail?: string;
  client?: string;
  action?: Action;
}

export const STATE_DB = join(STATE_DIR, "state.db");
const LEGACY_JSONL = join(STATE_DIR, "send-log.jsonl");

export function textHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").trim()).digest("hex").slice(0, 16);
}

/** node:sqlite is stable enough here but prints an ExperimentalWarning on load; keep logs clean. */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (msg?.includes("SQLite is an experimental feature")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

let db: DatabaseSync | undefined;

function ensureSchema(d: DatabaseSync): void {
  const exists = d.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (exists) return;
  // First use: create tables and import the legacy JSONL log exactly once, atomically.
  d.exec("BEGIN IMMEDIATE");
  let migrated = false;
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS sends (
              id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, chat_id INTEGER NOT NULL,
              text_sha TEXT NOT NULL, len INTEGER NOT NULL, outcome TEXT NOT NULL,
              event_id INTEGER, detail TEXT, client TEXT, pid INTEGER);
            CREATE INDEX IF NOT EXISTS sends_ts ON sends(ts);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
    if (!d.prepare("SELECT v FROM meta WHERE k = 'jsonl_migrated'").get() && existsSync(LEGACY_JSONL)) {
      const ins = d.prepare("INSERT INTO sends (ts, chat_id, text_sha, len, outcome, event_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const line of readFileSync(LEGACY_JSONL, "utf8").split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as LogEntry;
          ins.run(e.ts, e.chat_id, e.text_sha, e.len, e.outcome, e.event_id ?? null, e.detail ?? null);
        } catch {
          /* skip malformed line */
        }
      }
      migrated = true;
    }
    d.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('jsonl_migrated', ?)").run(String(Date.now()));
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  if (migrated) {
    try {
      renameSync(LEGACY_JSONL, LEGACY_JSONL + ".migrated");
    } catch {
      /* meta key already prevents a second import */
    }
  }
}

/** v2: sends.action ('message' | 'reaction'). Idempotent; runs once per database. */
function migrate(d: DatabaseSync): void {
  const cols = d.prepare("PRAGMA table_info(sends)").all() as { name: string }[];
  if (cols.some((c) => c.name === "action")) return;
  d.exec("BEGIN IMMEDIATE");
  try {
    const again = d.prepare("PRAGMA table_info(sends)").all() as { name: string }[];
    if (!again.some((c) => c.name === "action")) d.exec("ALTER TABLE sends ADD COLUMN action TEXT NOT NULL DEFAULT 'message'");
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

function store(): DatabaseSync {
  if (db) return db;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const { DatabaseSync: Database } = loadSqlite();
  const d = new Database(STATE_DB);
  d.exec("PRAGMA busy_timeout = 2000");
  ensureSchema(d);
  migrate(d);
  db = d;
  return d;
}

export interface SendLock {
  release(): void;
}

/**
 * Take the global (cross-process) send lock. Returns { busy } if another copy of the
 * server is in the middle of a send — e.g. its confirmation dialog is open.
 */
export function acquireSendLock(): SendLock | { busy: string } {
  const d = store();
  try {
    d.exec("BEGIN IMMEDIATE");
  } catch (e) {
    if (/locked|busy/i.test(e instanceof Error ? e.message : String(e))) {
      return { busy: "Another Viber send is in progress (possibly from another Claude window, waiting for its confirmation). Try again once it has finished." };
    }
    throw e;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        d.exec("COMMIT");
      } catch {
        try {
          d.exec("ROLLBACK");
        } catch {
          /* nothing left to do */
        }
      }
    },
  };
}

/** Record an outcome. Inside a held lock it is committed when the lock is released. */
export function recordSend(e: LogEntry): void {
  store()
    .prepare("INSERT INTO sends (ts, chat_id, text_sha, len, outcome, event_id, detail, client, pid, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(e.ts, e.chat_id, e.text_sha, e.len, e.outcome, e.event_id ?? null, e.detail ?? null, e.client ?? null, process.pid, e.action ?? "message");
}

/** Returns a human-readable reason if acting now would break a guardrail, else null. Call while holding the lock. */
export function checkRateLimit(chatId: number, text: string, now = Date.now(), action: Action = "message"): string | null {
  const rows = store()
    .prepare("SELECT ts, chat_id, text_sha, outcome, action FROM sends WHERE ts > ? ORDER BY ts")
    .all(now - 86_400_000) as unknown as (Pick<LogEntry, "ts" | "chat_id" | "text_sha" | "outcome"> & { action: Action })[];
  const L = action === "reaction" ? REACTION_LIMITS : LIMITS;
  const noun = action === "reaction" ? "reactions" : "messages";
  const done = rows.filter((e) => e.action === action && (e.outcome === "sent" || e.outcome === "sent_unconfirmed"));
  const last = done.at(-1);
  if (last && now - last.ts < L.minIntervalMs) {
    const wait = Math.ceil((L.minIntervalMs - (now - last.ts)) / 1000);
    return `Human pace: please wait ${wait}s before the next ${action === "reaction" ? "reaction" : "message"}.`;
  }
  const lastHour = done.filter((e) => now - e.ts < 3_600_000).length;
  if (lastHour >= L.maxPerHour) return `Rate limit: ${lastHour} ${noun} in the last hour (max ${L.maxPerHour}).`;
  if (done.length >= L.maxPerDay) return `Daily limit reached: ${done.length} ${noun} in 24h (max ${L.maxPerDay}).`;

  if (action === "message") {
    const h = textHash(text);
    const same = done.filter((e) => e.text_sha === h && now - e.ts < 3_600_000);
    if (same.some((e) => e.chat_id !== chatId)) {
      return "No bulk sending: this exact text was already sent to a different chat within the last hour.";
    }
    if (same.some((e) => e.chat_id === chatId && now - e.ts < 600_000)) {
      return "Duplicate: this exact text was already sent to this chat in the last 10 minutes.";
    }
  }
  // Declines count across messages and reactions: the user is saying "stop".
  const recentCancels = rows.filter((e) => e.outcome === "cancelled" && now - e.ts < 600_000).length;
  if (recentCancels >= 3) return "Cooling down: the user declined 3 requests in the last 10 minutes.";
  return null;
}
