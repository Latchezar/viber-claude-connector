// Data access: all SQL against viber.db lives here (read-only, via build/viberdb).
import { findProfile } from "./config.js";
import { clean } from "./format.js";
import { runQueries, toRows, type Query, type Row } from "./viberdb.js";

export type ChatType = "direct" | "group" | "community" | "notes";

export interface Chat {
  id: number;
  name: string;
  type: ChatType;
  unread: number;
  missedCalls: number;
  members: number;
  phone?: string;
  lastTs?: number;
  lastPreview?: string;
  lastFromMe?: boolean;
}

/** Unread = real incoming messages (not calls, not system notices) — matches Viber's "Unread" filter. */
const UNREAD_MSG = `(e.Type = 0 AND e.MessageType BETWEEN 1 AND 59)`;
/** Incoming call with zero duration = missed/declined (CallStatus 6/8/9). */
const MISSED_CALL = `(e.Type = 1 AND IFNULL(e.Duration, 0) = 0)`;
const NOT_DELETED = `IFNULL(e.Flags, 0) <> 1`;
const SENDER = `COALESCE(NULLIF(ct.Name, ''), NULLIF(ct.ClientName, ''), ct.Number)`;
// Reactions per message: "<type>\x1e<contactId>" pairs joined by \x1f (types can be emoji).
const REACTIONS = `(SELECT group_concat(r.ReactionType || char(30) || IFNULL(r.ContactID, ''), char(31)) FROM Reactions r
  WHERE r.ChatID = e.ChatID AND r.MessageToken = e.Token AND r.ReactionType <> '')`;
const ME_ID = `(SELECT ContactID FROM Events WHERE Direction = 1 AND ContactID IS NOT NULL LIMIT 1)`;
const MSG_COLS = `e.EventID AS id, e.ChatID AS chat_id, e.TimeStamp AS ts, e.Direction AS dir, e.Type AS type,
  e.MessageType AS mtype, e.Body AS body, e.Info AS info, e.Duration AS duration, ${SENDER} AS sender,
  ${REACTIONS} AS reactions_raw, e.MembersReactions AS members_reactions, ${ME_ID} AS me_id`;

function meCte(): string {
  const phone = findProfile().phone.replace(/\D/g, "");
  // Own ContactID: whoever authored outgoing events; else the profile's phone; else 1.
  return `me AS (SELECT COALESCE(
      (SELECT ContactID FROM Events WHERE Direction = 1 AND ContactID IS NOT NULL LIMIT 1),
      (SELECT ContactID FROM Contact WHERE Number IN ('${phone}', '+${phone}') LIMIT 1),
      1) AS id)`;
}

function chatListQuery(): Query {
  return {
    sql: `WITH ${meCte()},
    rel AS (
      SELECT r.ChatID, COUNT(*) AS members,
             MIN(CASE WHEN r.ContactID <> (SELECT id FROM me) THEN r.ContactID END) AS peer_id
      FROM ChatRelation r GROUP BY r.ChatID),
    names AS (
      SELECT r.ChatID, group_concat(COALESCE(NULLIF(ct.Name, ''), NULLIF(ct.ClientName, ''), ct.Number), ', ') AS member_names
      FROM ChatRelation r JOIN Contact ct ON ct.ContactID = r.ContactID
      WHERE r.ContactID <> (SELECT id FROM me) GROUP BY r.ChatID),
    unread AS (
      SELECT e.ChatID, SUM(${UNREAD_MSG}) AS n, SUM(${MISSED_CALL}) AS missed
      FROM Events e JOIN ChatInfo c ON c.ChatID = e.ChatID
      WHERE e.Direction = 0 AND e.Token > IFNULL(c.LastReadMessageToken, 0) AND ${NOT_DELETED}
      GROUP BY e.ChatID)
    SELECT c.ChatID AS id, c.Name AS name, c.Flags AS flags, c.PGType AS pg_type, c.TimeStamp AS chat_ts,
           IFNULL(rel.members, 0) AS members,
           p.Name AS peer_name, p.ClientName AS peer_client_name, p.Number AS peer_number,
           names.member_names, IFNULL(unread.n, 0) AS unread, IFNULL(unread.missed, 0) AS missed_calls,
           le.TimeStamp AS last_ts, le.Direction AS last_dir, le.Type AS last_type,
           le.MessageType AS last_mtype, substr(le.Body, 1, 200) AS last_body
    FROM ChatInfo c
    LEFT JOIN rel ON rel.ChatID = c.ChatID
    LEFT JOIN Contact p ON p.ContactID = rel.peer_id
    LEFT JOIN names ON names.ChatID = c.ChatID
    LEFT JOIN unread ON unread.ChatID = c.ChatID
    LEFT JOIN Events le ON le.EventID = (
      SELECT e.EventID FROM Events e WHERE e.ChatID = c.ChatID AND ${NOT_DELETED}
      ORDER BY e.SortOrder DESC, e.TimeStamp DESC LIMIT 1)
    ORDER BY IFNULL(le.TimeStamp, c.TimeStamp) DESC`,
  };
}

function classify(r: Row): ChatType {
  const flags = Number(r.flags ?? 0);
  if (Number(r.pg_type) === 3 || flags & 0x40000) return "community";
  if (flags & 0x80000 && Number(r.members) <= 1) return "notes";
  if (flags & 0x4) return "group";
  return "direct";
}

function previewOf(r: Row): string | undefined {
  if (r.last_ts === null || r.last_ts === undefined) return undefined;
  if (Number(r.last_type) === 1) return "[call]";
  const mt = Number(r.last_mtype);
  if (mt >= 60) return "[system notice]";
  const body = mt === 4 ? undefined : clean(r.last_body, 120);
  const label: Record<number, string> = { 2: "[photo]", 3: "[video]", 4: "[sticker]", 5: "[location]", 10: "[contact]", 11: "[file]" };
  return body ? (label[mt] ? `${label[mt]} ${body}` : body) : (label[mt] ?? "[message]");
}

function toChat(r: Row): Chat {
  const type = classify(r);
  let name: string | undefined;
  if (type === "notes") name = "My Notes";
  else if (type === "direct") name = clean(r.peer_name, 200) ?? clean(r.peer_client_name, 200) ?? clean(r.peer_number, 50) ?? clean(r.name, 200);
  else {
    name = clean(r.name, 200);
    if (!name && r.member_names) {
      const parts = String(r.member_names).split(", ");
      name = clean(parts.slice(0, 3).join(", ") + (parts.length > 3 ? ` +${parts.length - 3}` : ""), 200);
    }
  }
  const chat: Chat = {
    id: Number(r.id),
    name: name ?? `${type === "direct" ? "Chat" : "Group"} #${r.id}`,
    type,
    unread: Number(r.unread ?? 0),
    missedCalls: Number(r.missed_calls ?? 0),
    members: Number(r.members ?? 0),
  };
  if (type === "direct" && r.peer_number) chat.phone = String(r.peer_number);
  if (r.last_ts !== null && r.last_ts !== undefined) {
    chat.lastTs = Number(r.last_ts);
    chat.lastPreview = previewOf(r);
    chat.lastFromMe = Number(r.last_dir) === 1;
  }
  return chat;
}

export async function listChats(): Promise<Chat[]> {
  const [res] = await runQueries([chatListQuery()]);
  return toRows(res).map(toChat);
}

// ---------- chat resolution ----------

const norm = (s: string) => s.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "");

export type Resolution = { chat: Chat } | { error: string; candidates: Chat[] };

/**
 * Resolve a user-supplied chat reference: "#123" / "id:123" / small integer = ChatID,
 * a phone number (7+ digits), or a (partial) name. Never guesses between several matches.
 */
export function resolveChat(chats: Chat[], ref: string | number, opts: { exactNamesOnly?: boolean } = {}): Resolution {
  const raw = String(ref).trim();
  const idMatch = /^(?:#|id:)?(\d{1,6})$/i.exec(raw);
  if (idMatch && !opts.exactNamesOnly) {
    const byId = chats.find((c) => c.id === Number(idMatch[1]));
    if (byId) return { chat: byId };
  }
  const d = digits(raw);
  if (d.length >= 7 && /^[+\d\s()\-./]+$/.test(raw)) {
    const byPhone = chats.filter((c) => c.phone && digits(c.phone).endsWith(d.slice(-9)));
    if (byPhone.length === 1) return { chat: byPhone[0] };
    if (byPhone.length > 1) return { error: `Phone "${raw}" matches ${byPhone.length} chats`, candidates: byPhone };
  }
  const q = norm(raw);
  if (!q) return { error: "Empty chat reference", candidates: [] };
  const exact = chats.filter((c) => norm(c.name) === q);
  if (exact.length === 1) return { chat: exact[0] };
  if (exact.length > 1) return { error: `"${raw}" matches ${exact.length} chats with the same name`, candidates: exact };
  if (opts.exactNamesOnly) {
    const close = chats.filter((c) => q.split(" ").every((w) => norm(c.name).includes(w))).slice(0, 15);
    return { error: `No chat is named exactly "${raw}". Use the exact full chat name (or a phone number) so the approval prompt shows exactly who receives it.`, candidates: close };
  }
  const words = q.split(" ");
  const partial = chats.filter((c) => {
    const n = norm(c.name);
    return words.every((w) => n.includes(w));
  });
  if (partial.length === 1) return { chat: partial[0] };
  if (partial.length > 1) return { error: `"${raw}" is ambiguous (${partial.length} chats match)`, candidates: partial.slice(0, 15) };
  return { error: `No chat matches "${raw}"`, candidates: [] };
}

// ---------- messages ----------

export interface ReadOpts {
  since?: number;
  until?: number;
  beforeId?: number;
  limit: number;
}

export async function readMessages(chatId: number, o: ReadOpts): Promise<{ rows: Row[]; more: boolean }> {
  const where = [`e.ChatID = ?`, NOT_DELETED];
  const params: unknown[] = [chatId];
  if (o.since !== undefined) (where.push(`e.TimeStamp >= ?`), params.push(o.since));
  if (o.until !== undefined) (where.push(`e.TimeStamp < ?`), params.push(o.until));
  if (o.beforeId !== undefined) {
    where.push(`(e.SortOrder, e.TimeStamp, e.EventID) < (SELECT SortOrder, TimeStamp, EventID FROM Events WHERE EventID = ?)`);
    params.push(o.beforeId);
  }
  params.push(o.limit + 1);
  const [res] = await runQueries([
    {
      sql: `SELECT ${MSG_COLS} FROM Events e LEFT JOIN Contact ct ON ct.ContactID = e.ContactID
            WHERE ${where.join(" AND ")}
            ORDER BY e.SortOrder DESC, e.TimeStamp DESC, e.EventID DESC LIMIT ?`,
      params,
    },
  ]);
  const rows = toRows(res);
  const more = rows.length > o.limit;
  return { rows: rows.slice(0, o.limit).reverse(), more };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchOpts {
  query: string;
  chatId?: number;
  since?: number;
  until?: number;
  limit: number;
}

/** Case-insensitive (Unicode-aware, e.g. Cyrillic) search; all words must appear. "Quoted phrases" stay together. */
export async function searchMessages(o: SearchOpts): Promise<{ rows: Row[]; more: boolean }> {
  const terms = [...o.query.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean).slice(0, 8);
  if (terms.length === 0) throw new Error("Empty search query");
  const where = [NOT_DELETED, `e.Type = 0`, `e.Body IS NOT NULL`, `e.MessageType BETWEEN 1 AND 59`, `e.MessageType <> 4`];
  const params: unknown[] = [];
  for (const t of terms) {
    where.push(`e.Body REGEXP ?`);
    params.push(`(?i)${escapeRegex(t)}`);
  }
  if (o.chatId !== undefined) (where.push(`e.ChatID = ?`), params.push(o.chatId));
  if (o.since !== undefined) (where.push(`e.TimeStamp >= ?`), params.push(o.since));
  if (o.until !== undefined) (where.push(`e.TimeStamp < ?`), params.push(o.until));
  params.push(o.limit + 1);
  const [res] = await runQueries([
    {
      sql: `SELECT ${MSG_COLS} FROM Events e LEFT JOIN Contact ct ON ct.ContactID = e.ContactID
            WHERE ${where.join(" AND ")} ORDER BY e.TimeStamp DESC LIMIT ?`,
      params,
    },
  ]);
  const rows = toRows(res);
  return { rows: rows.slice(0, o.limit), more: rows.length > o.limit };
}

export async function unreadMessages(perChat: number): Promise<Row[]> {
  const [res] = await runQueries([
    {
      sql: `WITH u AS (
              SELECT ${MSG_COLS},
                     ROW_NUMBER() OVER (PARTITION BY e.ChatID ORDER BY e.SortOrder DESC, e.TimeStamp DESC) AS rn
              FROM Events e JOIN ChatInfo c ON c.ChatID = e.ChatID
              LEFT JOIN Contact ct ON ct.ContactID = e.ContactID
              WHERE e.Direction = 0 AND e.Token > IFNULL(c.LastReadMessageToken, 0) AND ${NOT_DELETED}
                AND (${UNREAD_MSG} OR ${MISSED_CALL}))
            SELECT * FROM u WHERE rn <= ? ORDER BY chat_id, ts`,
      params: [perChat],
    },
  ]);
  return toRows(res);
}

/** Text bodies of a chat's most recent messages (both directions) — used to verify the open chat in the UI. */
export async function recentBodies(chatId: number, limit = 80): Promise<string[]> {
  const [res] = await runQueries([
    {
      sql: `SELECT e.Body AS body FROM Events e
            WHERE e.ChatID = ? AND ${NOT_DELETED} AND e.Body IS NOT NULL AND e.Body <> ''
              AND e.Type = 0 AND e.MessageType BETWEEN 1 AND 59 AND e.MessageType <> 4
            ORDER BY e.SortOrder DESC, e.TimeStamp DESC LIMIT ?`,
      params: [chatId, limit],
    },
  ]);
  return toRows(res).map((r) => String(r.body));
}

/** Outgoing messages in a chat since a point in time — used to confirm a send landed. */
export async function recentOutgoing(chatId: number, sinceMs: number): Promise<{ id: number; ts: number; body: string }[]> {
  const [res] = await runQueries([
    {
      sql: `SELECT e.EventID AS id, e.TimeStamp AS ts, e.Body AS body FROM Events e
            WHERE e.ChatID = ? AND e.Direction = 1 AND e.Type = 0 AND e.TimeStamp >= ?
            ORDER BY e.TimeStamp DESC LIMIT 20`,
      params: [chatId, sinceMs],
    },
  ]);
  return toRows(res).map((r) => ({ id: Number(r.id), ts: Number(r.ts), body: String(r.body ?? "") }));
}

// ---------- reactions ----------

export interface ReactionTarget {
  id: number;
  chatId: number;
  ts: number;
  dir: number;
  type: number;
  mtype: number;
  body: string;
  token: string;
  sender?: string;
  /** My current reaction on it (raw Viber value, e.g. "1" = ❤️), or null. */
  mine: string | null;
  /** How many newer messages in the chat have exactly the same (normalised) text. */
  textRank: number;
  /** How many newer photos/videos the chat has (each shows a share button on screen). */
  mediaRank: number;
}


export async function getReactionTarget(chatId: number, eventId: number, normalize: (s: string) => string): Promise<ReactionTarget | null> {
  const [msg, newer, me] = await runQueries([
    {
      sql: `SELECT e.EventID AS id, e.ChatID AS chat_id, e.TimeStamp AS ts, e.Direction AS dir, e.Type AS type,
                   IFNULL(e.MessageType, 0) AS mtype, IFNULL(e.Body, '') AS body, CAST(e.Token AS TEXT) AS token, ${SENDER} AS sender,
                   e.SortOrder AS so
            FROM Events e LEFT JOIN Contact ct ON ct.ContactID = e.ContactID
            WHERE e.EventID = ? AND e.ChatID = ? AND ${NOT_DELETED}`,
      params: [eventId, chatId],
    },
    {
      sql: `SELECT IFNULL(n.Body, '') AS body, IFNULL(n.MessageType, 0) AS mtype FROM Events n, Events t
            WHERE t.EventID = ? AND n.ChatID = t.ChatID AND IFNULL(n.Flags, 0) <> 1 AND n.Type = 0
              AND (n.SortOrder, n.TimeStamp, n.EventID) > (t.SortOrder, t.TimeStamp, t.EventID)
            ORDER BY n.SortOrder DESC LIMIT 500`,
      params: [eventId],
    },
    { sql: `SELECT ${ME_ID} AS me_id` },
  ]);
  const m = toRows(msg)[0];
  if (!m) return null;
  const meId = toRows(me)[0]?.me_id;
  const token = String(m.token);
  const mine = await myReaction(chatId, token, meId);
  const target = normalize(String(m.body));
  const newerRows = toRows(newer);
  return {
    id: Number(m.id),
    chatId: Number(m.chat_id),
    ts: Number(m.ts),
    dir: Number(m.dir),
    type: Number(m.type),
    mtype: Number(m.mtype),
    body: String(m.body),
    token,
    sender: m.sender ? String(m.sender) : undefined,
    mine,
    textRank: target ? newerRows.filter((r) => normalize(String(r.body)) === target).length : 0,
    mediaRank: newerRows.filter((r) => [2, 3].includes(Number(r.mtype))).length,
  };
}

/** My current reaction on a message (raw Viber value) or null. */
export async function myReaction(chatId: number, token: string, meId?: unknown): Promise<string | null> {
  const [res] = await runQueries([
    {
      sql: `SELECT r.ReactionType AS type FROM Reactions r
            WHERE r.ChatID = ? AND CAST(r.MessageToken AS TEXT) = ? AND r.ContactID = ${meId ? "?" : ME_ID} AND r.ReactionType <> ''
            LIMIT 1`,
      params: meId ? [chatId, token, meId] : [chatId, token],
    },
  ]);
  const row = toRows(res)[0];
  return row ? String(row.type) : null;
}

/** My reactions in a chat changed since `sinceMs` — to catch a like that landed on the wrong message. */
export async function myRecentReactions(chatId: number, sinceMs: number): Promise<{ token: string; type: string; eventId: number | null }[]> {
  const [res] = await runQueries([
    {
      sql: `SELECT CAST(r.MessageToken AS TEXT) AS token, r.ReactionType AS type,
                   (SELECT e.EventID FROM Events e WHERE e.ChatID = r.ChatID AND e.Token = r.MessageToken LIMIT 1) AS event_id
            FROM Reactions r WHERE r.ChatID = ? AND r.ContactID = ${ME_ID} AND r.TimeStamp >= ?`,
      params: [chatId, sinceMs],
    },
  ]);
  return toRows(res).map((r) => ({ token: String(r.token), type: String(r.type ?? ""), eventId: r.event_id === null ? null : Number(r.event_id) }));
}
