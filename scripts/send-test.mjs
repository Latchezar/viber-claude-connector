#!/usr/bin/env node
// Live send test through the real MCP server. This client does NOT declare elicitation,
// so the server falls back to the native macOS confirmation dialog — a human must click
// "Send" for anything to happen.
//   usage: node scripts/send-test.mjs "<chat>" "<text>"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [chat, text] = process.argv.slice(2);
if (!chat || !text) {
  console.error('usage: node scripts/send-test.mjs "<chat>" "<text>"');
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist/index.js")], stderr: "inherit" });
const client = new Client({ name: "send-test", version: "0.0.1" }); // no elicitation capability
await client.connect(transport);
const t0 = Date.now();
const res = await client.callTool({ name: "send_message", arguments: { chat, text } }, undefined, { timeout: 10 * 60_000 });
console.log(`result after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, res.content[0].text);
await client.close();
