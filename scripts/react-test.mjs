#!/usr/bin/env node
// Live reaction test through the real MCP server. The client does NOT declare elicitation, so
// the server asks with the native macOS dialog — a human must click "Like" for anything to happen.
//   usage: node scripts/react-test.mjs <chat> <message-id> <like|remove> [excerpt]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [chat, messageId, reaction, excerpt] = process.argv.slice(2);
if (!chat || !messageId || !reaction) {
  console.error("usage: node scripts/react-test.mjs <chat> <message-id> <like|remove> [excerpt]");
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist/index.js")], stderr: "inherit" });
const client = new Client({ name: "react-test", version: "0.0.1" }); // no elicitation => macOS dialog
await client.connect(transport);
const t0 = Date.now();
const args = { chat: /^\d+$/.test(chat) ? Number(chat) : chat, message_id: Number(messageId), reaction, ...(excerpt ? { message_excerpt: excerpt } : {}) };
const res = await client.callTool({ name: "react_to_message", arguments: args }, undefined, { timeout: 10 * 60_000 });
console.log(`result after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, res.content[0].text);
await client.close();
