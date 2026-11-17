#!/usr/bin/env node
// Exercises send_message's guard rails WITHOUT sending anything:
//  - ambiguous / unknown recipients are rejected before any dialog
//  - the user declining the elicitation dialog => status "cancelled", no UI automation
// The client identifies as "claude-code" with form elicitation (so the server uses the form,
// never a native dialog) and always answers "decline".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = mkdtempSync(join(tmpdir(), "viber-mcp-test-")); // keep the real send log clean

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist/index.js")],
  env: { ...process.env, VIBER_MCP_STATE_DIR: stateDir },
  stderr: "inherit",
});
const client = new Client({ name: "claude-code", version: "0.0.1-guard-test" }, { capabilities: { elicitation: {} } });
let elicitations = 0;
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  elicitations++;
  const msg = req.params.message;
  console.log("  [dialog shown] first line:", JSON.stringify(msg.split("\n")[0]), "| has To: line:", /\nTo: /.test(msg), "| fields:", Object.keys(req.params.requestedSchema?.properties ?? {}));
  return { action: "decline" };
});
await client.connect(transport);

async function send(args) {
  const res = await client.callTool({ name: "send_message", arguments: args });
  const out = JSON.parse(res.content[0].text);
  console.log(`send_message(${JSON.stringify({ ...args, text: `<${args.text.length} chars>` })}) -> ${out.status}${res.isError ? " (isError)" : ""}: ${out.reason ?? ""}`.slice(0, 220));
  if (out.candidates) console.log(`  candidates: ${out.candidates.length}`);
  return out;
}

let before = elicitations;
await send({ chat: "zzz-no-such-chat", text: "hello" });
console.log("  dialog shown for unknown chat?", elicitations > before);

before = elicitations;
await send({ chat: "a", text: "hello" }); // matches many chat names
console.log("  dialog shown for ambiguous chat?", elicitations > before);

before = elicitations;
const r = await send({ chat: "My Notes", text: "Guard test — this must NOT be sent." });
console.log("  dialog shown for valid chat?", elicitations > before, "| final status:", r.status);

await client.close();
