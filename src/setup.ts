// Native helpers (build/viberdb, build/viberax) must be compiled on the user's Mac: viberdb
// links the Qt that ships inside *their* Viber.app. A plugin install has no build step, so the
// server builds them itself — in the background, once (and again when the native sources or
// Viber's Qt version change) — while tools answer "setting up". Several server copies may
// start at the same time (Claude Code, the desktop app); a directory lock keeps it to one build.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DIR, ROOT, VIBER_APP, VIBERAX_BIN, VIBERDB_BIN } from "./config.js";

export const BUILD_LOG = join(BUILD_DIR, "build.log");
const LOCK_DIR = join(BUILD_DIR, ".lock");
const STAMP = join(BUILD_DIR, "stamp.json"); // written by build-native.sh after a successful build
const FAILED = join(BUILD_DIR, "failed.json"); // written by build-native.sh when a build fails
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
/** Inputs of the native build; build-native.sh records the same sha256 list in the stamp. */
const SOURCES = ["native/viberdb/viberdb.cpp", "native/viberax/main.swift", "scripts/build-native.sh"];

let ready = false;

/** Qt version bundled in Viber.app (e.g. "6.11.3"), or null if Viber isn't installed there. */
export function viberQtVersion(): string | null {
  const qtcore = join(VIBER_APP, "Contents/Frameworks/QtCore.framework/QtCore");
  if (!existsSync(qtcore)) return null;
  try {
    const out = execFileSync("/usr/bin/otool", ["-L", qtcore], { encoding: "utf8", timeout: 10_000 });
    return out.match(/QtCore\.framework[^\n]*current version ([\d.]+)\)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function upToDate(): boolean {
  if (!existsSync(VIBERDB_BIN) || !existsSync(VIBERAX_BIN)) return false;
  // Explicit helper paths (dev overrides) are trusted as-is.
  if (process.env.VIBERDB_BIN || process.env.VIBERAX_BIN) return true;
  const stamp = readJson(STAMP);
  if (!stamp || stamp.qt !== viberQtVersion()) return false;
  return SOURCES.every((f) => stamp.sources?.[f] === sha256(join(ROOT, f)));
}

/** True once the helpers match the current sources and the installed Viber. */
export function helpersReady(): boolean {
  if (!ready && upToDate()) ready = true;
  return ready;
}

function lockHolderAlive(): boolean {
  try {
    const pid = Number(readFileSync(join(LOCK_DIR, "pid"), "utf8"));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    }
  } catch {
    /* no pid file yet: the lock was taken a moment ago */
  }
  try {
    return Date.now() - statSync(LOCK_DIR).mtimeMs < 120_000;
  } catch {
    return false;
  }
}

/** Start a detached background build unless one is already running. Returns true if this call started it. */
function startBuild(): boolean {
  mkdirSync(BUILD_DIR, { recursive: true });
  try {
    mkdirSync(LOCK_DIR); // atomic: fails while another copy is building
  } catch {
    if (lockHolderAlive()) return false;
    rmSync(LOCK_DIR, { recursive: true, force: true }); // stale lock (builder died)
    try {
      mkdirSync(LOCK_DIR);
    } catch {
      return false;
    }
  }
  const log = openSync(BUILD_LOG, "w");
  const child = spawn("/bin/bash", [join(ROOT, "scripts/build-native.sh")], {
    cwd: ROOT,
    detached: true, // finishes even if this server exits meanwhile
    stdio: ["ignore", log, log],
    env: { ...process.env, VIBER_APP, VIBER_BUILD_LOCK: LOCK_DIR, VIBER_BUILD_FAILED: FAILED },
  });
  closeSync(log);
  writeFileSync(join(LOCK_DIR, "pid"), String(child.pid ?? ""));
  child.on("error", () => rmSync(LOCK_DIR, { recursive: true, force: true }));
  child.unref();
  return true;
}

function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no build log)";
  }
}

export type SetupState = "ready" | "building" | "failed" | "no-viber";

/** Startup hook: make sure the helpers exist, building them in the background if needed. */
export function ensureHelpers(): SetupState {
  if (helpersReady()) return "ready";
  if (!viberQtVersion()) return "no-viber";
  const failed = readJson(FAILED);
  if (failed && Date.now() - Number(failed.at) * 1000 < RETRY_AFTER_FAILURE_MS && !existsSync(LOCK_DIR)) return "failed";
  startBuild();
  return "building";
}

/** Throws a user-facing explanation (and starts a build if needed) unless the helpers are usable. */
export function requireHelpers(): void {
  switch (ensureHelpers()) {
    case "ready":
      return;
    case "no-viber":
      throw new Error(`Viber Desktop wasn't found at ${VIBER_APP}. Install it from viber.com, sign in, and try again (set VIBER_APP if it lives elsewhere).`);
    case "failed":
      throw new Error(
        `Setting up the native helpers failed. Last lines of ${BUILD_LOG}:\n${tail(BUILD_LOG, 12)}\n` +
          `Fix the problem above (most often: run \`xcode-select --install\`), then try again in a few minutes — or run \`npm run build\` in ${ROOT}.`,
      );
    default:
      throw new Error(
        `First-run setup: compiling the Viber helpers for your Viber version (one-time, about 1–3 minutes; it downloads ` +
          `matching Qt headers). Try again shortly. Progress: ${BUILD_LOG}`,
      );
  }
}
