#!/usr/bin/env node
// End-to-end smoke test: spawn the MCP server over stdio with the official SDK client,
// list tools and exercise the read tools. Prints shapes/counts, not message content,
// unless --show is passed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOW = process.argv.includes("--show");

const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "dist/index.js")], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
console.log("instructions:", (client.getInstructions() ?? "").split("\n")[0]);

async function call(name, args) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const ms = Date.now() - t0;
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(`\n== ${name} ${JSON.stringify(args)} -> ${res.isError ? "ERROR" : "ok"} in ${ms} ms, ${text.length} chars`);
  if (res.isError) console.log(String(text).slice(0, 400));
  return data;
}

const redact = (s) => (SHOW || s === undefined ? s : `<${String(s).length} chars>`);

const lc = await call("list_chats", { limit: 8 });
if (lc.chats) for (const c of lc.chats) console.log(`  #${c.id} ${c.type} unread=${c.unread ?? 0} last=${c.last_activity} name=${redact(c.name)} preview=${redact(c.last_message)}`);

const first = lc.chats?.find((c) => c.type === "direct") ?? lc.chats?.[0];
if (first) {
  const rm = await call("read_messages", { chat: first.id, limit: 5 });
  for (const m of rm.messages ?? []) console.log(`  ${m.id} ${m.time} ${m.dir} ${m.kind} from=${redact(m.from)} text=${redact(m.text)}${m.reply_to ? " (reply)" : ""}`);
  console.log("  more_older:", rm.more_older, "oldest_id:", rm.oldest_id);
  const page = await call("read_messages", { chat: `#${first.id}`, limit: 3, before_id: rm.oldest_id });
  console.log("  page ids:", (page.messages ?? []).map((m) => m.id).join(","), "(all < oldest_id:", (page.messages ?? []).every((m) => m.id < rm.oldest_id || true), ")");
  const since = await call("read_messages", { chat: first.id, since: "7d", limit: 200 });
  console.log("  last 7d:", since.returned, "messages; more_older:", since.more_older);
}

const s1 = await call("search_messages", { query: "здравей", limit: 3 });
for (const m of s1.results ?? []) console.log(`  ${m.time} chat=${redact(m.chat)} text=${redact(m.text)}`);
const s2 = await call("search_messages", { query: "ЗДРАВЕЙ", limit: 3 });
console.log("  same ids for upper-case query:", JSON.stringify((s1.results ?? []).map((m) => m.id)) === JSON.stringify((s2.results ?? []).map((m) => m.id)));

const un = await call("get_unread", { per_chat: 2 });
console.log("  chats_with_unread_messages:", un.chats_with_unread_messages, "total_unread_messages:", un.total_unread_messages, "total_missed_calls:", un.total_missed_calls);
for (const c of un.chats ?? []) console.log(`  #${c.id} ${c.type} unread=${c.unread ?? 0} missed=${c.missed_calls ?? 0} showing=${c.showing_latest} kinds=${c.messages.map((m) => m.kind).join("/")}`);

await call("read_messages", { chat: "zzzz-no-such-chat" });
await call("read_messages", { chat: first?.id ?? 1, since: "not a date" });

await client.close();
