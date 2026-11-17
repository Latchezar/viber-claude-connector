// Drives Viber's UI through build/viberax: open the chat (search → OCR-locate → click),
// verify it is the right chat, put the text in the composer, press Enter.
// Every irreversible step is preceded by a check; any failed check aborts before Enter.
import { execFile } from "node:child_process";
import { VIBERAX_BIN } from "./config.js";
import { requireHelpers } from "./setup.js";
import { feedMatch, isVerified, norm } from "./match.js";

type Ax = { ok: boolean; error?: string; code?: string; [k: string]: any };

export function ax(args: string[], stdin = "", timeoutMs = 20_000): Promise<Ax> {
  try {
    requireHelpers();
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const child = execFile(VIBERAX_BIN, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const line = String(stdout).trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line)); // viberax exits 1 on {"ok":false}; the JSON is still valid
      } catch {
        reject(new Error(`viberax ${args[0]} failed: ${String(stderr).trim() || err?.message || "no output"}`));
      }
    });
    child.stdin?.end(stdin);
  });
}

/** Small randomised pause: lets Qt render, and keeps the automation at a human-ish pace. */
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms + Math.random() * 150));

export class UiAbort extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

async function must(args: string[], stdin = "", what = args[0]): Promise<Ax> {
  const r = await ax(args, stdin);
  if (!r.ok) throw new UiAbort(`${what}: ${r.error ?? "failed"}`, r.code ?? "ax_failed");
  return r;
}

/** PID of the frontmost app (not Viber), captured before confirmation so focus can be restored. */
export async function frontmostPid(): Promise<number> {
  const f = await ax(["frontmost"]).catch(() => ({ ok: false }) as Ax);
  return f.ok && f.bundle !== "com.viber.osx" ? Number(f.pid ?? 0) : 0;
}

export async function preflight(): Promise<void> {
  const s = await ax(["status"]);
  if (!s.ok) throw new UiAbort(s.error ?? "status failed", s.code ?? "status");
  if (!s.trusted || !s.screenCapture) {
    // macOS's own prompts name the app that launched this server (Claude, Terminal, IntelliJ…).
    await ax(["request-permissions"]).catch(() => undefined);
    const missing = [!s.trusted && "Accessibility", !s.screenCapture && "Screen Recording"].filter(Boolean).join(" and ");
    throw new UiAbort(
      `${missing} permission is missing for the app that launched this server ` +
        "(System Settings → Privacy & Security). macOS should now show a prompt naming that app — grant it, quit and reopen that app, then try again.",
      "permissions",
    );
  }
  if (!s.running) throw new UiAbort("Viber Desktop is not running. Open Viber and try again.", "not_running");
}

export interface OpenCheck {
  headerScore: number;
  matched: number;
  total: number;
  verified: boolean;
}

async function checkOpenChat(name: string, history: string[]): Promise<OpenCheck> {
  const h = await ax(["header"], name);
  const headerScore = h.ok ? Number(h.score ?? 0) : 0;
  const feed = await ax(["feed"]);
  const fm = feedMatch(feed.ok ? (feed.messages as string[]) : [], history);
  return { headerScore, ...fm, verified: isVerified(headerScore, fm) };
}

export interface OpenResult {
  openedVia: "already_open" | "search";
  check: OpenCheck;
}

/**
 * Make `name` the open conversation (Viber must already be frontmost) and verify it against
 * `history` (recent bodies from viber.db). Throws UiAbort if it can't be verified.
 */
export async function openChat(name: string, history: string[]): Promise<OpenResult> {
  let openedVia: OpenResult["openedVia"] = "already_open";
  let check = await checkOpenChat(name, history);
  if (!check.verified) {
    openedVia = "search";
    await must(["focus", "search"], "", "focus search field");
    await must(["set-value", "search"], "", "clear search field");
    await pause(200);
    const plain = name.replace(/[^\p{L}\p{N}\s&'.-]/gu, " ").replace(/\s+/g, " ").trim();
    let loc: Ax = { ok: false };
    for (const term of [...new Set([name, plain])].filter(Boolean)) {
      await must(["set-value", "search"], term, "type into search field");
      for (let i = 0; i < 4 && !loc.ok; i++) {
        await pause(350);
        loc = await ax(["locate"], name);
      }
      if (loc.ok) break;
    }
    if (!loc.ok) throw new UiAbort(`Couldn't find "${name}" in Viber's search results.`, "not_found");
    await must(["click", String(loc.x), String(loc.y)], "", "click the conversation");
    await pause(700);
    check = await checkOpenChat(name, history);
    if (!check.verified) {
      await pause(700); // slow render: one more look
      check = await checkOpenChat(name, history);
    }
  }
  if (!check.verified) {
    throw new UiAbort(
      `Couldn't verify that "${name}" is the open conversation (header match ${check.headerScore.toFixed(2)}, ` +
        `${check.matched}/${check.total} visible messages matched its history).`,
      "unverified",
    );
  }
  return { openedVia, check };
}

export interface DeliverResult {
  pressedAt: number;
  composerCleared: boolean;
  usedSendButton: boolean;
  openedVia: OpenResult["openedVia"];
  check: OpenCheck;
}

/**
 * Open `name`, verify it against `history` (recent bodies from viber.db), compose `text`, press Enter.
 * Restores the previously frontmost app afterwards, whatever happens.
 */
export async function deliver(name: string, text: string, history: string[], restorePid = 0): Promise<DeliverResult> {
  const act = await must(["activate"], "", "bring Viber to the front");
  // Prefer the app captured before the confirmation step (a native dialog shifts focus).
  const previousPid = restorePid > 0 ? restorePid : Number(act.previousPid ?? 0);
  let composerTouched = false;
  try {
    await pause(250);
    const { openedVia, check } = await openChat(name, history);

    // Composer: never clobber a draft the user is writing.
    await must(["focus", "composer"], "", "focus the message box");
    const before = await must(["get-value", "composer"], "", "read the message box");
    if (norm(before.value)) throw new UiAbort("The message box already contains an unsent draft; not overwriting it.", "draft_present");

    composerTouched = true;
    await must(["set-value", "composer"], text, "put the text in the message box");
    await pause(300);
    const composed = await must(["get-value", "composer"], "", "read back the message box");
    if (norm(composed.value) !== norm(text)) throw new UiAbort("The message box doesn't contain exactly the approved text.", "compose_mismatch");

    // Last look before the irreversible step: still frontmost and still the same chat?
    const st = await ax(["status"]);
    if (!st.frontmost) {
      await must(["activate"], "", "bring Viber back to the front");
      await pause(250);
    }
    const final = await ax(["header"], name);
    if (!final.ok || Number(final.score ?? 0) < 0.85) throw new UiAbort("The conversation changed before sending.", "changed");

    const pressedAt = Date.now();
    await must(["key", "return"], "", "press Enter");
    await pause(600);
    let after = await must(["get-value", "composer"], "", "read the message box after Enter");
    let usedSendButton = false;
    if (norm(after.value) && norm(after.value) === norm(text)) {
      // Enter inserted a newline (send-on-Enter is off): use the Send button instead.
      await must(["press-send"], "", "press the Send button");
      usedSendButton = true;
      await pause(600);
      after = await must(["get-value", "composer"], "", "read the message box after Send");
    }
    composerTouched = norm(after.value) !== "";
    return { pressedAt, composerCleared: !composerTouched, usedSendButton, openedVia, check };
  } finally {
    if (composerTouched) {
      // Aborted after composing: leave nothing behind that a stray Enter could send —
      // but only clear text that is ours (the user may have switched to their own draft).
      const cur = await ax(["get-value", "composer"]).catch(() => ({ ok: false }) as Ax);
      if (cur.ok && norm(cur.value) === norm(text)) await ax(["set-value", "composer"], "").catch(() => undefined);
    }
    if (previousPid > 0) await ax(["restore", String(previousPid)]).catch(() => undefined);
  }
}

export interface HeartRequest {
  mode: "text" | "media";
  text?: string;
  rank: number;
  group?: boolean;
  timeLabel?: string;
}

/**
 * Open + verify the chat, then click the target message's ♡ (Viber's like toggle) via the
 * atomic `viberax heart` command. Returns when the click happened; the caller verifies in viber.db.
 */
export async function clickHeart(name: string, history: string[], target: HeartRequest, restorePid = 0): Promise<{ clickedAt: number }> {
  const act = await must(["activate"], "", "bring Viber to the front");
  const previousPid = restorePid > 0 ? restorePid : Number(act.previousPid ?? 0);
  try {
    await pause(250);
    await openChat(name, history);
    await pause(300);
    const st = await ax(["status"]);
    if (!st.frontmost) {
      await must(["activate"], "", "bring Viber back to the front");
      await pause(250);
    }
    const clickedAt = Date.now();
    await must(["heart"], JSON.stringify(target), "click the ♡ of the message");
    return { clickedAt };
  } finally {
    if (previousPid > 0) await ax(["restore", String(previousPid)]).catch(() => undefined);
  }
}
