#!/usr/bin/env node
// react_to_message guard rails — never reacts: the client identifies as "claude-code" with
// form elicitation and always declines, so no native dialog appears and nothing is clicked.
//   usage: node scripts/test-react-guards.mjs <chat-id> <incoming-message-id> <own-message-id>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { norm } from "../dist/match.js";
import { getReactionTarget } from "../dist/repo.js";

const [chat, incoming, own] = process.argv.slice(2).map(Number);
// A matching excerpt for the incoming message (start of its text, or its kind) — never printed.
const target = await getReactionTarget(chat, incoming, norm);
const goodExcerpt = norm(target?.body ?? "") ? norm(target.body).slice(0, 12) : ({ 2: "photo", 3: "video" })[target?.mtype] ?? "photo";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist/index.js")],
  env: { ...process.env, VIBER_MCP_STATE_DIR: mkdtempSync(join(tmpdir(), "viber-react-test-")) },
  stderr: "ignore",
});
const client = new Client({ name: "claude-code", version: "0.0.0-react-guards" }, { capabilities: { elicitation: {} } });
let asked = 0;
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  asked++;
  const lines = req.params.message.split("\n");
  console.log(`    [confirmation shown] ${JSON.stringify(lines[0])} | ${lines.filter((l) => /^(Chat|From):/.test(l)).length} context lines | field: ${Object.keys(req.params.requestedSchema.properties)}`);
  return { action: "decline" };
});
await client.connect(transport);
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

const results = [];
async function expect(label, args, wantStatus, wantAsked) {
  const before = asked;
  const res = await client.callTool({ name: "react_to_message", arguments: args });
  const out = JSON.parse(res.content[0].text);
  const okStatus = out.status === wantStatus;
  const okAsked = asked - before === (wantAsked ? 1 : 0);
  results.push(okStatus && okAsked);
  console.log(`${okStatus && okAsked ? "PASS" : "FAIL"}  ${label} -> ${out.status}${okAsked ? "" : " (confirmation count wrong)"}: ${(out.reason ?? "").slice(0, 110)}`);
}

await expect("unknown message id", { chat, message_id: 1, reaction: "like" }, "rejected", false);
await expect("own message", { chat, message_id: own, reaction: "like" }, "rejected", false);
await expect("excerpt that doesn't match", { chat, message_id: incoming, reaction: "like", message_excerpt: "definitely not this" }, "rejected", false);
await expect("remove when not liked", { chat, message_id: incoming, reaction: "remove" }, "unchanged", false);
await expect("valid like -> asks, user declines", { chat, message_id: incoming, reaction: "like", message_excerpt: goodExcerpt }, "cancelled", true);

await client.close();
console.log(results.every(Boolean) ? "ALL PASS" : "SOME CHECKS FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
