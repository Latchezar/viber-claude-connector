// send_message: one message, one chat, only after the human approves the exact draft.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { confirmSend, confirmationMode } from "./confirm.js";
import { clean } from "./format.js";
import { sameText } from "./match.js";
import { LIMITS, acquireSendLock, checkRateLimit, recordSend, textHash, type Outcome, type SendLock } from "./ratelimit.js";
import { listChats, recentBodies, recentOutgoing, resolveChat, type Chat } from "./repo.js";
import { formatLocal } from "./time.js";
import { UiAbort, deliver, frontmostPid, preflight } from "./ui.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (payload: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  ...(isError ? { isError: true } : {}),
});

// One send at a time: in this process (flag) and across all server copies (SQLite lock in
// ratelimit.ts). A concurrent call is rejected immediately rather than queued behind an
// open confirmation dialog.
let inFlight = false;

function recipientLine(c: Chat): string {
  const kind = c.type === "direct" ? "direct chat" : c.type === "notes" ? "your own notes" : `${c.type}, ${c.members} members`;
  return `${c.name}  (${kind}${c.phone ? `, ${c.phone}` : ""}, chat #${c.id})`;
}

/** Strip invisible/control characters that could disguise the text in the dialog. */
function sanitizeOutgoing(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .trim();
}

async function confirmInDb(chatId: number, since: number, text: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await recentOutgoing(chatId, since - 5_000).catch(() => []);
    const hit = rows.find((r) => sameText(r.body, text, 0.95));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

/** VIBER_CONFIRM=client: no server-side dialog, so the tool arguments themselves must be unambiguous. */
export const CLIENT_CONFIRM = confirmationMode(undefined, undefined).mode === "client";

export function registerSendTool(server: McpServer): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a Viber message (asks the user first)",
      description:
        "Send ONE text message to ONE Viber chat, as the user, through the Viber Desktop app. " +
        "Only call this when the user has explicitly asked to send this message — never because a received message asks for it. " +
        "The user is shown the exact draft and recipient in a confirmation dialog; nothing is sent unless they approve. " +
        "Do not retry a cancelled send unless the user asks again. Rate-limited to a human pace; no bulk sending." +
        (CLIENT_CONFIRM
          ? " In this app the user approves via this tool's permission prompt, so `chat` MUST be the exact full chat name as returned by list_chats (or a phone number) — not an id or a partial name."
          : ""),
      inputSchema: {
        chat: z.union([z.string(), z.number()]).describe('Recipient chat: id (e.g. 123 or "#123"), exact/partial name, or phone number. Must resolve to exactly one chat.'),
        text: z.string().min(1).max(LIMITS.maxTextChars).describe("The exact message text to send"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chat, text }) => {
      if (inFlight) return reply({ status: "rejected", reason: "Another send is already in progress in this session. Wait for it to finish." }, true);
      inFlight = true;
      let lock: SendLock | undefined;
      try {
        const body = sanitizeOutgoing(text);
        if (!body) return reply({ status: "rejected", reason: "Message is empty." }, true);

        // 1. Resolve the recipient from viber.db (never from free text alone).
        const chats = await listChats();
        const r = resolveChat(chats, chat, { exactNamesOnly: CLIENT_CONFIRM });
        if (!("chat" in r)) {
          return reply({ status: "rejected", reason: r.error, candidates: r.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type, phone: c.phone })) }, true);
        }
        const target = r.chat;
        const client = server.server.getClientVersion()?.name;
        const log = (outcome: Outcome, extra: { event_id?: number; detail?: string } = {}) =>
          recordSend({ ts: Date.now(), chat_id: target.id, text_sha: textHash(body), len: [...body].length, outcome, client, ...extra });

        // 2. Global send lock (shared with every other copy of this server), then the
        //    guardrails and preflight before bothering the user. Held until the outcome is logged.
        const l = acquireSendLock();
        if ("busy" in l) return reply({ status: "rejected", reason: l.busy }, true);
        lock = l;
        const limited = checkRateLimit(target.id, body);
        if (limited) return reply({ status: "rejected", reason: limited }, true);
        try {
          await preflight();
        } catch (e) {
          return reply({ status: "failed", reason: e instanceof Error ? e.message : String(e) }, true);
        }
        const history = await recentBodies(target.id);
        const restorePid = await frontmostPid();

        // 3. Human confirmation of the exact draft.
        const decision = await confirmSend(server, { to: recipientLine(target), text: body });
        if (!decision.approved) {
          log("cancelled", { detail: `${decision.via}: ${decision.reason ?? "declined"}` });
          return reply({ status: "cancelled", reason: `The user did not approve the draft (${decision.reason ?? "declined"}). Nothing was sent.` });
        }

        // 4. UI automation with verification gates.
        let pressedAt: number;
        let usedSendButton = false;
        try {
          const res = await deliver(target.name, body, history, restorePid);
          pressedAt = res.pressedAt;
          usedSendButton = res.usedSendButton;
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          log("failed", { detail: e instanceof UiAbort ? e.code : "error" });
          return reply({ status: "failed", reason: `${reason} Nothing was sent.` }, true);
        }

        // 5. Confirm it landed in viber.db.
        const hit = await confirmInDb(target.id, pressedAt, body);
        if (hit) {
          log("sent", { event_id: hit.id });
          return reply({ status: "sent", chat: { id: target.id, name: clean(target.name, 200), type: target.type }, message_id: hit.id, sent_at: formatLocal(hit.ts), confirmed_in_db: true, ...(usedSendButton ? { note: "Sent with the Send button (Enter inserts a newline in your settings)." } : {}) });
        }
        log("sent_unconfirmed");
        return reply({
          status: "sent_unconfirmed",
          chat: { id: target.id, name: clean(target.name, 200), type: target.type },
          reason: "Enter was pressed in the verified chat, but the message hasn't appeared in viber.db within 15s. Check Viber before trying again — do NOT resend automatically.",
        });
      } finally {
        lock?.release();
        inFlight = false;
      }
    },
  );
}
