#!/usr/bin/env node
// Dev tool: bring Viber to the front and open a chat through the production
// open-and-verify path (search → OCR → click → header + history check). Sends nothing.
//   usage: node scripts/dev-open-chat.mjs "<chat name | #id>"
import { listChats, recentBodies, resolveChat } from "../dist/repo.js";
import { ax, openChat } from "../dist/ui.js";

const ref = process.argv[2];
if (!ref) {
  console.error('usage: node scripts/dev-open-chat.mjs "<chat>"');
  process.exit(2);
}
const r = resolveChat(await listChats(), ref);
if (!("chat" in r)) {
  console.error(r.error);
  process.exit(1);
}
await ax(["activate"]);
const res = await openChat(r.chat.name, await recentBodies(r.chat.id));
console.log(JSON.stringify({ chat_id: r.chat.id, type: r.chat.type, ...res }));
