// Bridge to build/viberdb — the C++ harness that opens viber.db read-only through
// Viber's own Qt SQLite driver (which contains the SEE codec).
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { VIBER_APP, VIBERDB_BIN, findProfile } from "./config.js";
import { requireHelpers } from "./setup.js";
/**
 * Candidate values for `PRAGMA hexkey`. Viber Desktop for macOS derives the key as
 * "aes128:" + reverse(<macOS login name>) — nothing is stored on disk. VIBER_DB_HEXKEY
 * (comma-separated) lets you supply captured keys if a future Viber build changes this.
 */
function keyCandidates() {
    const keys = [];
    const override = process.env.VIBER_DB_HEXKEY;
    if (override)
        keys.push(...override.split(",").map((s) => s.trim()).filter(Boolean));
    const user = process.env.VIBER_USERNAME || userInfo().username;
    keys.push(Buffer.from("aes128:" + [...user].reverse().join(""), "utf8").toString("hex"));
    return keys;
}
let preferredKey = 0;
export async function runQueries(queries, opts = {}) {
    requireHelpers();
    const profile = findProfile();
    const all = keyCandidates();
    // Try the key that worked last time first.
    const order = [preferredKey, ...all.keys()].filter((v, i, a) => v < all.length && a.indexOf(v) === i);
    const keys = order.map((i) => all[i]);
    const request = JSON.stringify({
        db: profile.dbPath,
        keys,
        queries: queries.map((q) => ({ sql: q.sql, params: q.params ?? [] })),
        maxRows: opts.maxRows ?? 5000,
        busyTimeoutMs: 5000,
    });
    const out = await new Promise((resolve, reject) => {
        const child = spawn(VIBERDB_BIN, [], {
            env: { ...process.env, VIBER_APP, QT_LOGGING_RULES: "*.debug=false" },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("viber.db query timed out"));
        }, opts.timeoutMs ?? 30_000);
        child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", () => {
            clearTimeout(timer);
            if (!stdout.trim())
                reject(new Error(`viberdb produced no output. stderr: ${stderr.slice(0, 500)}`));
            else
                resolve(stdout);
        });
        child.stdin.end(request);
    });
    let parsed;
    try {
        parsed = JSON.parse(out);
    }
    catch {
        throw new Error(`viberdb returned invalid JSON: ${out.slice(0, 300)}`);
    }
    if (typeof parsed.keyIndex === "number")
        preferredKey = order[parsed.keyIndex] ?? 0;
    if (!parsed.ok || !parsed.results) {
        throw new Error(`viber.db access failed: ${parsed.error ?? "unknown error"}`);
    }
    return parsed.results;
}
export function toRows(result) {
    return result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])));
}
//# sourceMappingURL=viberdb.js.map