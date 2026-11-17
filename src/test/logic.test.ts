// Unit tests for the pure logic behind the guardrails. Run: npm test
// (Invisible characters are built with String.fromCharCode so they stay explicit.)
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the rate limiter at a throwaway state dir BEFORE importing it.
process.env.VIBER_MCP_STATE_DIR = mkdtempSync(join(tmpdir(), "viber-mcp-unit-"));

const { norm, sameText, feedMatch, isVerified } = await import("../match.js");
const { parseWhen, formatLocal } = await import("../time.js");
const { checkRateLimit, recordSend, textHash, acquireSendLock, STATE_DB } = await import("../ratelimit.js");
const { confirmationMode, clientLabel } = await import("../confirm.js");
const { resolveChat } = await import("../repo.js");
const { renderMessage, clean } = await import("../format.js");

const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
const LSEP = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);

test("norm strips bidi isolates and maps LINE SEPARATOR like the DB's newline", () => {
  const ui = `${FSI}Hello${PDI}${LSEP}${FSI}world${PDI}`;
  assert.equal(norm(ui), norm("Hello\nworld"));
});

test("sameText tolerates a dropped mention placeholder but not different text", () => {
  assert.ok(sameText("Hi team, see you at noon", "Hi tteam, see you at noon"));
  assert.ok(!sameText("see you tomorrow", "see you on friday"));
  assert.ok(!sameText("ok", "no")); // very short strings must match exactly
});

test("verification: header must match; feed must agree when there is one", () => {
  const history = ["first message", "second message", "third one here"];
  assert.deepEqual(feedMatch(["first message", "third one here"], history), { matched: 2, total: 2 });
  assert.ok(isVerified(1, feedMatch(["first message", "third one here"], history)));
  assert.ok(!isVerified(0.5, feedMatch(["first message", "third one here"], history)), "wrong header");
  assert.ok(!isVerified(1, feedMatch(["totally different", "other chat text"], history)), "wrong feed");
  assert.ok(isVerified(0.97, { matched: 0, total: 0 }), "empty chat + near-exact header");
  assert.ok(!isVerified(0.9, { matched: 0, total: 0 }), "empty chat + fuzzy header is not enough");
  assert.ok(!isVerified(1, { matched: 1, total: 3 }), "too few matches");
});

test("parseWhen: durations, keywords, date-only as local midnight", () => {
  const now = new Date(2026, 10, 17, 15, 30, 0);
  assert.equal(parseWhen("2h", now), now.getTime() - 2 * 3_600_000);
  assert.equal(parseWhen("3d", now), now.getTime() - 3 * 86_400_000);
  assert.equal(parseWhen("today", now), new Date(2026, 10, 17).getTime());
  assert.equal(parseWhen("yesterday", now), new Date(2026, 10, 16).getTime());
  assert.equal(parseWhen("2026-11-15", now), new Date(2026, 10, 15).getTime());
  assert.throws(() => parseWhen("next tuesday-ish", now));
  assert.match(formatLocal(now.getTime()), /^2026-11-17T15:30:00[+-]\d\d:\d\d$/);
});

test("rate limits: human pace, duplicates, no broadcast, cancel cooldown", () => {
  const t = Date.now();
  assert.equal(checkRateLimit(1, "hello", t), null);
  recordSend({ ts: t, chat_id: 1, text_sha: textHash("hello"), len: 5, outcome: "sent" });
  assert.match(checkRateLimit(2, "something else", t + 5_000) ?? "", /Human pace/);
  assert.match(checkRateLimit(2, "hello", t + 60_000) ?? "", /bulk/);
  assert.match(checkRateLimit(1, "hello", t + 60_000) ?? "", /Duplicate/);
  assert.equal(checkRateLimit(2, "a different message", t + 60_000), null);
  for (let i = 0; i < 3; i++) recordSend({ ts: t + 61_000 + i, chat_id: 3, text_sha: "x", len: 1, outcome: "cancelled" });
  assert.match(checkRateLimit(3, "yet another", t + 70_000) ?? "", /Cooling down/);
});

// Fictional fixtures. Phone numbers are from the UK range reserved for fiction (07700 900xxx).
const chats = [
  { id: 12, name: "Тестов Акаунт", type: "direct", unread: 0, missedCalls: 0, members: 2, phone: "+447700900123" },
  { id: 13, name: "Тестов Профил", type: "direct", unread: 0, missedCalls: 0, members: 2, phone: "+447700900456" },
  { id: 31, name: "Weekend Hiking Club", type: "group", unread: 0, missedCalls: 0, members: 5 },
  { id: 7, name: "My Notes", type: "notes", unread: 0, missedCalls: 0, members: 1 },
] as const;

test("resolveChat: id, phone, exact, partial (Cyrillic, case-insensitive), ambiguity", () => {
  const pick = (ref: string | number) => {
    const r = resolveChat(chats as any, ref);
    return "chat" in r ? r.chat.id : `ambiguous:${r.candidates.length}`;
  };
  assert.equal(pick(31), 31);
  assert.equal(pick("#7"), 7);
  assert.equal(pick("07700 900123"), 12);
  assert.equal(pick("my notes"), 7);
  assert.equal(pick("ТЕСТОВ АКАУНТ"), 12);
  assert.equal(pick("hiking"), 31);
  assert.equal(pick("Тестов"), "ambiguous:2");
  assert.equal(pick("nobody"), "ambiguous:0");
});

test("renderMessage: kinds, missed calls, replies, sanitised text", () => {
  const base = { id: 1, ts: Date.now(), dir: 0, sender: "Sender" };
  const call = renderMessage({ ...base, type: 1, duration: 0 });
  assert.equal(call.kind, "call");
  assert.equal(call.call?.missed, true);
  const voice = renderMessage({ ...base, type: 0, mtype: 11, info: JSON.stringify({ audio_ptt: {}, fileInfo: { Duration: 7.4 } }) });
  assert.equal(voice.kind, "voice");
  assert.equal(voice.attachment?.duration_s, 7);
  const reply = renderMessage({ ...base, type: 0, mtype: 1, body: `ok${RLO}`, info: JSON.stringify({ quote: { name: "Someone", text: "lunch?" } }) });
  assert.equal(reply.text, "ok");
  assert.deepEqual(reply.reply_to, { from: "Someone", text: "lunch?" });
  const sys = renderMessage({ ...base, type: 0, mtype: 77, body: "AAAAAAAAAAA=" });
  assert.equal(sys.kind, "system");
  assert.equal(sys.text, undefined);
  assert.equal(renderMessage({ ...base, dir: 1, type: 0, mtype: 1, body: "hi" }).from, "me");
  assert.ok((clean("x".repeat(5000)) ?? "").includes("truncated"));
});

test("confirmation mode: only Claude Code with form elicitation gets the form", () => {
  const m = (name: string | undefined, caps: unknown, pref?: string) => confirmationMode(name, caps, pref ?? "auto").mode;
  assert.equal(m("claude-code", { form: {}, url: {} }), "form");
  assert.equal(m("claude-code", {}), "form", "bare {} = form mode in older protocol revisions");
  assert.equal(m("claude-code", { url: {} }), "dialog", "URL-only elicitation can't show the draft");
  assert.equal(m("claude-code", undefined), "dialog");
  assert.equal(m("claude-ai", { form: {}, url: {} }), "dialog", "desktop app always gets the macOS dialog");
  assert.equal(m("claude-ai", undefined), "dialog");
  assert.equal(m(undefined, {}), "dialog");
  assert.equal(m("claude-code", { form: {} }, "dialog"), "dialog", "VIBER_CONFIRM=dialog wins");
  assert.equal(clientLabel("claude-ai"), "Claude desktop app");
  assert.equal(clientLabel("claude-code"), "Claude Code");
});

test("send lock is exclusive across connections and released on release()", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const lock = acquireSendLock();
  assert.ok(!("busy" in lock), "first acquire succeeds");
  const other = new DatabaseSync(STATE_DB); // stands in for a second server process
  other.exec("PRAGMA busy_timeout = 100");
  assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked|busy/i, "second writer is blocked while the lock is held");
  // Writes inside the held lock become visible to others only after release (commit).
  recordSend({ ts: Date.now(), chat_id: 99, text_sha: "lock-test", len: 1, outcome: "failed" });
  const before = other.prepare("SELECT count(*) AS n FROM sends WHERE text_sha = 'lock-test'").get() as { n: number };
  assert.equal(before.n, 0);
  if (!("busy" in lock)) lock.release();
  const after = other.prepare("SELECT count(*) AS n FROM sends WHERE text_sha = 'lock-test'").get() as { n: number };
  assert.equal(after.n, 1);
  other.exec("BEGIN IMMEDIATE"); // free again
  other.exec("ROLLBACK");
  other.close();
});

test("client confirm mode: no extra dialog, but recipients must be exact full names (or phone)", () => {
  assert.equal(confirmationMode("claude-ai", undefined, "client").mode, "client");
  assert.equal(confirmationMode("claude-code", { form: {} }, "client").mode, "client", "explicit opt-in wins");
  const pick = (ref: string | number) => {
    const r = resolveChat(chats as any, ref, { exactNamesOnly: true });
    return "chat" in r ? r.chat.id : "rejected";
  };
  assert.equal(pick("Weekend Hiking Club"), 31);
  assert.equal(pick("weekend hiking club"), 31, "case-insensitive exact match is fine");
  assert.equal(pick("hiking"), "rejected", "partial names are not allowed");
  assert.equal(pick(31), "rejected", "bare ids are not human-checkable in an approval prompt");
  assert.equal(pick("+447700900123"), 12, "phone numbers are allowed");
});

test("reactions: codes map to emoji, own reaction detected, summary JSON fallback", () => {
  const base = { id: 1, ts: Date.now(), dir: 0, type: 0, mtype: 1, body: "hi", sender: "Sender", me_id: 1 };
  const RS = String.fromCharCode(30);
  const US = String.fromCharCode(31);
  const m = renderMessage({ ...base, reactions_raw: ["1", "7"].join(RS) + US + ["1", "1"].join(RS) + US + ["🚀", "9"].join(RS) });
  assert.deepEqual(m.reactions, [
    { emoji: "❤️", type: "1", count: 2 },
    { emoji: "🚀", type: "🚀", count: 1 },
  ]);
  assert.equal(m.my_reaction, "❤️");
  const s = renderMessage({ ...base, reactions_raw: null, members_reactions: '{"2":3}' });
  assert.deepEqual(s.reactions, [{ emoji: "😂", type: "2", count: 3 }]);
  assert.equal(s.my_reaction, undefined);
  assert.equal(renderMessage(base).reactions, undefined);
});
