import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (dist/ or src/ live one level below it). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const VIBER_APP = process.env.VIBER_APP ?? "/Applications/Viber.app";
export const VIBERPC_DIR = process.env.VIBERPC_DIR ?? join(homedir(), "Library/Application Support/ViberPC");

/**
 * Native helpers, compiled on this Mac by scripts/build-native.sh (see setup.ts).
 * Deliberately NOT in a top-level bin/: Claude Code puts a plugin's bin/ on the Bash tool's
 * PATH, which would let the model call the click/keystroke helper directly, bypassing every
 * confirmation. build/ is private to the server.
 */
export const BUILD_DIR = join(ROOT, "build");
export const VIBERDB_BIN = process.env.VIBERDB_BIN ?? join(BUILD_DIR, "viberdb");
export const VIBERAX_BIN = process.env.VIBERAX_BIN ?? join(BUILD_DIR, "viberax");

/**
 * Shared state (send lock, rate limits, audit log). One fixed per-user folder, so every copy
 * of the server shares it however it was installed (plugin, `claude mcp add`, desktop config)
 * and plugin updates (which change ROOT) don't reset it.
 */
export const STATE_DIR = process.env.VIBER_MCP_STATE_DIR ?? join(homedir(), "Library/Application Support/viber-connector/state");
/** Where older versions kept the state (inside the checkout); migrated once by ratelimit.ts. */
export const LEGACY_STATE_DIR = join(ROOT, "state");

export interface Profile {
  /** Account phone number = name of the profile folder. */
  phone: string;
  dbPath: string;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Locate the active Viber profile (newest viber.db / viber.db-wal), or VIBER_DB if set. */
export function findProfile(): Profile {
  const override = process.env.VIBER_DB;
  if (override) {
    if (!existsSync(override)) throw new Error(`VIBER_DB does not exist: ${override}`);
    return { dbPath: override, phone: basename(dirname(override)) };
  }
  if (!existsSync(VIBERPC_DIR)) throw new Error(`Viber data folder not found: ${VIBERPC_DIR}`);
  const profiles = readdirSync(VIBERPC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{6,}$/.test(d.name))
    .map((d) => ({ phone: d.name, dbPath: join(VIBERPC_DIR, d.name, "viber.db") }))
    .filter((p) => existsSync(p.dbPath));
  if (profiles.length === 0) throw new Error(`No ViberPC/<phone>/viber.db found under ${VIBERPC_DIR}`);
  const recency = (p: Profile) => Math.max(mtime(p.dbPath), mtime(p.dbPath + "-wal"));
  profiles.sort((a, b) => recency(b) - recency(a));
  return profiles[0];
}
