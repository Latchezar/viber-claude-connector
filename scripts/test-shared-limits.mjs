#!/usr/bin/env node
// Two separate server processes (think: Claude Code + the Claude desktop app) sharing one
// state dir must share the send lock and the human-pace limits. Never sends anything:
// every confirmation is answered "decline" by the test clients.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = mkdtempSync(join(tmpdir(), "viber-mcp-shared-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let signalAInDialog;
let firstDone = false;
const aInDialog = new Promise((r) => (signalAInDialog = r));

async function server(label, declineDelayMs) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, "dist/index.js")],
    env: { HOME: process.env.HOME, VIBER_MCP_STATE_DIR: stateDir },
    stderr: "ignore",
  });
  // "claude-code" + form elicitation => the server asks via the form (no native dialog pops up).
  const client = new Client({ name: "claude-code", version: `0.0.0-${label}` }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => {
    if (label === "A") signalAInDialog(); // A now holds the lock, with its "dialog" open
    await sleep(label === "A" && !firstDone ? declineDelayMs : 0);
    return { action: "decline" };
  });
  await client.connect(transport);
  const send = async (text) => {
    const res = await client.callTool({ name: "send_message", arguments: { chat: "My Notes", text } });
    const out = JSON.parse(res.content[0].text);
    console.log(`  [${label}] ${out.status}: ${out.reason ?? ""}`.slice(0, 170));
    return out;
  };
  return { client, send };
}

const A = await server("A", 6000); // slow to answer: holds the lock well past B's 2 s busy timeout
const B = await server("B", 0);
const results = [];
const check = (name, cond) => {
  results.push(cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};

console.log("1) B tries to send while A's confirmation is open");
const pendingA = A.send("shared test 1");
// Deterministic: only start B once A is inside its confirmation. Sends check that Viber is
// running BEFORE asking, so without Viber A never gets there: fail fast instead of hanging.
const reached = await Promise.race([aInDialog.then(() => true), pendingA.then(() => false), sleep(30_000).then(() => false)]);
if (!reached) {
  console.log("FAIL  A never reached its confirmation: " + ((await Promise.race([pendingA, sleep(0)]))?.reason ?? "timeout") + "\n(open Viber Desktop: sends check it before asking)");
  process.exit(1);
}
const b1 = await B.send("shared test 2");
check("B is rejected as busy while A holds the lock", b1.status === "rejected" && /in progress/i.test(b1.reason));
const a1 = await pendingA;
firstDone = true; // later A confirmations answer immediately
check("A's declined draft is recorded as cancelled", a1.status === "cancelled");

console.log("2) cancellations from both processes count toward one shared cool-down");
check("B can ask once A is done", (await B.send("shared test 3")).status === "cancelled");
check("A third cancellation (from A)", (await A.send("shared test 4")).status === "cancelled");
const b4 = await B.send("shared test 5");
check("B sees the shared cool-down (3 declines across A+B)", b4.status === "rejected" && /Cooling down/.test(b4.reason));

console.log("3) a send recorded by one copy blocks the other (30 s human pace)");
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const db = new DatabaseSync(join(stateDir, "state.db"));
db.prepare("INSERT INTO sends (ts, chat_id, text_sha, len, outcome) VALUES (?, 1, 'x', 1, 'sent')").run(Date.now() - 5000);
db.close();
const a5 = await A.send("shared test 6");
check("A sees the other copy's send 5 s ago", a5.status === "rejected" && /Human pace/.test(a5.reason));

await A.client.close();
await B.client.close();
console.log(results.every(Boolean) ? "\nALL PASS" : "\nSOME CHECKS FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
