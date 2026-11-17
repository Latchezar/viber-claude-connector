# viber-claude-connector

A local **stdio MCP server** that connects Claude (Claude Code) to **Viber Desktop on macOS**:
read your chats from Viber's local database, and send messages through Viber's own UI,
**only after you approve the exact draft**.

There is no Viber API for personal accounts (the Bot API is commercial-only since Feb 2024
and can't send as you), so this server:

- **reads** the encrypted `viber.db` **read-only**, through Viber's own bundled SQLite codec;
- **sends** by driving the Viber app with the macOS Accessibility API (open chat → put text
  in the message box → press Enter). No DB writes, no protocol reverse-engineering.

> **Unofficial.** Not affiliated with or endorsed by Rakuten Viber or Anthropic. It automates *your own* Viber
> account through the macOS UI. Use it responsibly and at your own risk.

## Privacy

- Everything runs **on your Mac**. The server reads `viber.db` locally and talks only to the Claude app that started
  it. Apart from the one-time build (which downloads Qt headers, see *Install*), it makes no network requests.
- Whatever Claude reads (messages, names, numbers) becomes part of your Claude conversation, and Anthropic processes it
  like anything else you share with Claude. That includes your contacts' messages, so be deliberate about what you
  ask it to read.
- Nothing is ever written to Viber's databases. The local audit log (`state.db`, see *Guardrails*) stores chat ids,
  hashes and lengths, never message text.

## Tools

| Tool | What it does |
|---|---|
| `list_chats(query?, type?, unread_only?, limit?)` | Chats by recent activity: id, name, type (direct/group/community/notes), unread count, missed calls, last-message preview |
| `read_messages(chat, since?, until?, before_id?, limit?)` | Messages of one chat, oldest first, with reactions (counts + `my_reaction`). `since`/`until` accept ISO dates, `today`, `yesterday`, `2h`, `3d`, `1w`. Page back with `before_id` |
| `search_messages(query, chat?, since?, until?, limit?)` | Case-insensitive full-text search (Cyrillic-aware). All words must match; `"quoted phrase"` matches exactly |
| `get_unread(per_chat?, include_communities?)` | Chats with unread messages (same semantics as Viber's *Unread* filter) plus missed calls |
| `send_message(chat, text)` | Sends **one** text message to **one** chat after you confirm the draft in a dialog |
| `react_to_message(chat, message_id, reaction, message_excerpt?)` | **Likes (❤️)** one message, or removes your like (`reaction: "like" \| "remove"`), after you confirm. Works on other people's text messages, photos and videos that are visible once the chat is open |

A chat can be referenced by id (`42`, `#42`), exact or partial name (`"hiking"`), or phone number.
Ambiguous references are rejected with a list of candidates, never guessed.

## Requirements

- macOS (tested: macOS 26.6, Apple Silicon) with **Viber Desktop** installed and signed in (tested: 29.5.0).
- Xcode command line tools (`xcode-select --install`), to compile two small native helpers on your Mac, and Node.js ≥ 22.13
  on your `PATH` (built-in `node:sqlite`).
- For sending, the app that **launches the server** needs the permissions below: your terminal/IDE for Claude Code
  (Terminal, iTerm, IntelliJ…), or Claude.app for the desktop app (see *Claude desktop app*):
  - **Accessibility**: System Settings → Privacy & Security → Accessibility;
  - **Screen Recording**: used to OCR the search-result row and the chat header, since neither is exposed via Accessibility.

## Install

### As a Claude Code plugin (recommended)

In Claude Code (2.1.275 or later):

```
/plugin install viber-connector --marketplace Latchezar/viber-claude-connector
```

Or in two steps, `/plugin marketplace add Latchezar/viber-claude-connector` and then
`/plugin install viber-connector@viber-connector`. From a terminal:
`claude plugin install viber-connector --marketplace Latchezar/viber-claude-connector`.

Restart Claude Code. The first time the server starts, it compiles its two native helpers against the Qt inside your
`Viber.app`. This happens once, in the background, and takes about 1–3 minutes. Until then the tools answer *"First-run
setup…"*. The helpers rebuild automatically when needed: after a plugin update, or when a Viber update changes its Qt
version. Update with `claude plugin update viber-connector@viber-connector` (restart afterwards). Then grant the
permissions above to the app you run Claude Code in, and ask e.g. *"what's unread on Viber?"*.

The plugin works in Claude Code in a terminal, an IDE, and the Code tab of the Claude desktop app. The desktop app's chat
ignores plugins that start local servers; for chat (and agent mode), use the manual setup in *Claude desktop app*
below. If you registered the server by hand before (`claude mcp add viber …`), remove that entry
(`claude mcp remove viber`) so you don't run two copies.

### From source

For development, or for the desktop app's chat and agent mode. Clone this repository, then from its folder:

```bash
npm install
npm run build                   # build/viberdb (C++), build/viberax (Swift), dist/ (TypeScript)
npm test                        # unit tests (no Viber needed)
node scripts/smoke.mjs          # end-to-end read check over MCP stdio (prints counts, not content)
```

The first build downloads the Qt headers that match the Qt inside your `Viber.app` (QtCore + QtSql only, a few MB,
via [aqtinstall](https://github.com/miurahr/aqtinstall) in a throwaway venv) into a per-user cache
(`~/Library/Caches/viber-connector`). Nothing from Qt is linked statically: the helper uses Viber's own Qt libraries
at runtime.

Register with Claude Code (run from this folder; `local` scope = only when Claude runs here):

```bash
claude mcp add --transport stdio viber -- "$(which node)" "$PWD/dist/index.js"
# available in every project instead:
claude mcp add --scope user --transport stdio viber -- "$(which node)" "$PWD/dist/index.js"
```

Then start a new Claude Code session and ask e.g. *"what's unread on Viber?"*.

## Claude desktop app

The same server also runs under the Claude desktop app. Each app starts its **own copy** of the server (the desktop
app even starts two: `claude-ai` for chats and `local-agent-mode-viber` for agent mode). All copies share one state
file, so the send lock and the pace limits apply across all of them (see Guardrails).

1. **Add the server** (backs up the config, merges only `mcpServers.viber`, validates the JSON, keeps every other
   key untouched, absolute paths only):
   ```bash
   python3 scripts/install-desktop-config.py          # --confirm client|dialog, --dry-run, --node /abs/path
   ```
   It writes this entry to `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   "viber": {
     "command": "/Users/<you>/.nvm/versions/node/v22.21.1/bin/node",
     "args": ["/Users/<you>/Documents/viber-claude-connector/dist/index.js"],
     "env": {
       "VIBER_CONFIRM": "dialog"
     }
   }
   ```
   (`"client"` instead of `"dialog"` with `--confirm client`, see step 4.)
   The desktop app doesn't load your shell, so nothing may depend on `PATH`/nvm. Check the exact command in a clean
   environment with `python3 scripts/check-desktop-command.py`.
2. **Quit the desktop app with Cmd+Q and reopen it**, after every config change *and* after every `npm run build`.
   The app starts its server copies at launch and keeps them running, so reloading the window isn't enough. The app sometimes rewrites this file itself. If `viber` is missing
   after reopening, quit the app, re-run the script (it's idempotent), and reopen.
3. **Grant macOS permissions to Claude** (System Settings → Privacy & Security). macOS attributes everything the
   server does to the app that launched it:
   | Permission | Why |
   |---|---|
   | **Accessibility** → Claude | reading/setting Viber's search field and message box, Enter, the click on the search result |
   | **Screen & System Audio Recording** → Claude | capturing Viber's window to OCR the search result row and chat header |
   | **Files & Folders → Claude → Documents Folder** | the server lives in `~/Documents` (code + `state/`). macOS asks on first launch; click Allow |

   Nothing else is needed: no Automation (the dialog uses no Apple Events), no Input Monitoring, no Full Disk Access.
   After granting Screen Recording, macOS asks you to quit and reopen Claude. If a permission is missing, the first send
   attempt fails *before* any dialog, and the server triggers macOS's own prompt, which names the exact app.
   Note: the desktop app starts MCP servers through a helper named `disclaimer`, which makes macOS treat the server
   as its **own** responsible process. The permissions may therefore have to go to the `node` binary
   (`/Users/<you>/.nvm/versions/node/v22.21.1/bin/node`) rather than to Claude. The prompt names the right one; you can
   also add it to both lists with **+**. Check the result in the log (`accessibility=… screenRecording=…`).
4. **Confirmation in the desktop app.** Pick one with `--confirm` (re-runs keep the current choice):
   - `--confirm dialog` (default): every send shows the **macOS dialog** (Cancel is the default button).
   - `--confirm client`: **no extra dialog.** The desktop app's own *"Allow tool?"* prompt, which shows the tool
     arguments, is the confirmation. So that prompt shows exactly who receives what, the server then accepts only the
     **exact full chat name** (or a phone number) as the recipient, never an id or a partial name.
     ⚠️ Answer **"Allow once"** for `send_message`. *Always allow* or *Allow for this chat* would let later sends go out
     with no confirmation at all (only the rate limits would remain).

   The in-app form is only used for Claude Code (`clientInfo.name == "claude-code"` declaring form-mode elicitation).
   Other clients never get it.

### Logs

| File | Contents |
|---|---|
| `~/Library/Logs/Claude/mcp-server-viber.log` | this server's stderr: startup line, which client connected (and whether it declares in-app forms) and how sends will be confirmed, and the **permissions of the launching app** (`accessibility=… screenRecording=…`). The permission line is a snapshot taken at startup; permissions granted later apply right away, because the helper is a fresh process each time |
| `~/Library/Logs/Claude/mcp.log` | the desktop app's MCP connection events (start, stop, errors) |
| `~/Library/Logs/Claude/main.log` | general app log (config writes, crashes) |

```bash
tail -f ~/Library/Logs/Claude/mcp-server-viber.log
```
The desktop app shows server status under Settings → Developer.

## How it works

### Reading: `build/viberdb` (C++)

On current macOS builds `viber.db` is encrypted with **SQLite SEE** (`AES-128` scheme). The codec lives inside Viber's
Qt SQLite plugin (`Viber.app/Contents/PlugIns/sqldrivers/libqsqlite.dylib`), which exports no `sqlite3_*`
symbols. So `viberdb` is compiled against Qt 6 headers but **links Viber's own `QtCore`/`QtSql` at runtime**
and opens the DB through `QSqlDatabase("QSQLITE")`. Viber derives the key at runtime as
`"aes128:" + reverse(<macOS login name>)`, passed hex-encoded to `PRAGMA hexkey`; nothing is stored on disk.

Read-only guarantees, layered:

1. the connection is opened with `SQLITE_OPEN_READONLY`;
2. `PRAGMA query_only=1` is set right after keying;
3. the helper only accepts `SELECT`/`WITH` (plus a few introspection pragmas);
4. Qt prepares only the first statement of a string, so nothing can be appended.

The DB is read live (including the WAL), so new messages appear immediately. Keys travel over stdin,
never argv. The helper speaks JSON on stdin/stdout; all SQL lives in `src/repo.ts`.

### Sending: `build/viberax` (Swift) + `src/ui.ts`

Viber is a Qt Quick app. Its Accessibility tree exposes stable QML object paths (search field,
message box `QQuickTextEdit`, `SendToolbarButton`, visible messages), but **not** the chat-list rows or the
conversation title. A send therefore goes like this:

1. **Resolve** the recipient in `viber.db` (exactly one chat, or it stops).
2. **Rate limits** (see below), plus a preflight: Viber running, Accessibility granted.
3. **Confirmation.** Claude Code shows an MCP *elicitation* form with the recipient (taken from the DB, not from the
   model), the requesting app and the exact text, and nothing happens unless you tick *"Yes, send this message"*
   and submit. Every other client, the Claude desktop app included, gets a native macOS dialog whose default button
   is **Cancel**. Approval is only ever a submitted form with the box ticked, or the dialog's **Send** button. Decline,
   cancel, timeout, a missing capability or an error all mean *not sent*. In non-interactive sessions the request is
   cancelled.
4. **Open the chat.** Focus the search field via AX, set the chat name, OCR the result list (Apple Vision) to find
   the row with that name, and click it. Viber needs a real click here; Return/Down don't open results.
5. **Verify** that it's the right chat: OCR the conversation header (must match the name) **and** match the
   visible messages against that chat's latest messages in `viber.db`. If verification fails, the send aborts.
6. **Compose.** Refuse if the message box already holds your draft. Otherwise set the text via AX, read it back,
   check it matches exactly, and re-check the header.
7. **Press Enter**, or use the Send button if Enter only inserts a newline.
8. **Confirm** that the new outgoing message appears in `viber.db`, then return focus to the app you were using.

### Reacting: `react_to_message`

Viber's ♡ (next to a message) is a **toggle**: one click likes the message, a second click removes the like. It isn't
in the Accessibility tree, and the right-click menu has no "React" item, so:

1. Resolve the chat and look the message up in `viber.db`. Calls, system notices and your own messages are rejected;
   so is a request that wouldn't change anything (already liked, or nothing to remove), *before* any confirmation.
2. Confirmation (same modes as sending). It shows the chat, the sender, the time and the message excerpt (or `[photo]`).
3. Open and verify the chat (same checks as sending).
4. `viberax heart` finds the ♡ from fresh Accessibility geometry and clicks it **in one atomic step**:
   - **text**: hover the bubble (matched by its exact text) to reveal its action row; the ♡ sits 29 pt right of the
     reply icon, centred on the bubble;
   - **photo/video**: the ♡ is the round button 34 pt left of the bubble's share button. Before clicking, the
     bubble's **time label** (e.g. `14:05`) must be read off the screen by OCR as an identity check;
   - if the feed **moved** between measuring and clicking (new messages arriving), it **aborts** instead of
     clicking. Identical texts and several photos are told apart by counting newer ones from the bottom.
5. Verify in `viber.db` that *your* reaction on that message is now ❤️ (or gone), and that no other message's
   reaction changed. It **never retries blindly**: a second click would undo the first.

Limits of this first version: ❤️ only (Viber stores it as type `1`; other emoji need its picker, not supported yet),
no reactions to your own messages, and the message must be visible after opening the chat (recent messages).
The ♡ offsets were calibrated on Viber 29.5 and may need adjusting after a Viber redesign. The click then misses
harmlessly and the result is reported as unconfirmed.

Keystrokes are posted **only to Viber's process** and only while Viber is frontmost. Clicks happen only if
Viber's window is the topmost window at that point; for example, the macOS Screenshot overlay blocks them.

## Guardrails

- **Explicit confirmation of every send** (see above). The model cannot answer the dialog.
- **Untrusted content.** Message text, names, quotes and link titles are returned only inside JSON strings,
  stripped of invisible/bidi control characters, and labelled untrusted. Server instructions and tool
  descriptions tell Claude never to act on instructions found in messages.
- **Human pace, no bulk.** At least 30 s between sends, ≤ 10/hour, ≤ 40/day. Identical text to a different chat
  within an hour is blocked (no broadcasts), as are repeats to the same chat within 10 min. Three
  declined drafts in 10 min trigger a cool-down.
- **Reactions** have their own human pace: at least 10 s apart, ≤ 20/hour, ≤ 60/day. They share the global lock and
  the decline cool-down with messages (3 declines of anything in 10 min trigger the cool-down).
- **Shared across Claude apps.** The limits live in `~/Library/Application Support/viber-connector/state/state.db`
  (SQLite), not in memory, so every copy shares them, however it was installed. A send holds SQLite's
  write lock (`BEGIN IMMEDIATE`) from the limit check, through the confirmation dialog and delivery, until its
  outcome is recorded. If another copy tries to send meanwhile (e.g. Claude Code while the desktop app's dialog is
  open), it's rejected with "another send is in progress". If a process dies, the OS releases its lock, so there are
  no stale lock files. `scripts/test-shared-limits.mjs` checks this with two real server processes.
- **Audit log.** `state.db` records the time, chat id, action, outcome, requesting client, text hash and length (not the text):
  `sqlite3 -readonly ~/Library/Application\ Support/viber-connector/state/state.db "SELECT datetime(ts/1000,'unixepoch','localtime'), chat_id, action, outcome, client, len FROM sends"`.
- **Read-only DB**, as described above.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `VIBER_APP` | `/Applications/Viber.app` | Viber bundle (codec + Qt frameworks) |
| `VIBER_DB` | newest `~/Library/Application Support/ViberPC/<phone>/viber.db` | DB to read |
| `VIBER_USERNAME` | current login name | Login name used to derive the key (for a DB copied from another Mac) |
| `VIBER_DB_HEXKEY` | — | Comma-separated captured `hexkey` values, if Viber changes its key scheme |
| `VIBER_MCP_STATE_DIR` | `~/Library/Application Support/viber-connector/state` | Shared state (`state.db`: send lock, limits, audit log). Must be the same for every copy, so leave it unset |
| `VIBER_CONFIRM` | `auto` | `auto`: in-app form for Claude Code, macOS dialog for everything else. `dialog`: always the macOS dialog. `client`: no server-side confirmation; the client's own tool-approval prompt is the confirmation (exact recipient names required) |
| `VIBER_MIN_SEND_INTERVAL_S` / `VIBER_MAX_SENDS_PER_HOUR` / `VIBER_MAX_SENDS_PER_DAY` | 30 / 10 / 40 | Pace limits |
| `VIBER_MAX_TEXT_CHARS` | 2000 | Max message length |
| `VIBER_MIN_REACTION_INTERVAL_S` / `VIBER_MAX_REACTIONS_PER_HOUR` / `VIBER_MAX_REACTIONS_PER_DAY` | 10 / 20 / 60 | Reaction pace limits |

## Troubleshooting

- **`no key candidate opened the database`**: Viber changed its key derivation. Capture the `PRAGMA hexkey`
  Viber issues (see GhostingBit/viber-export's `INTERNALS.md`) and pass it via `VIBER_DB_HEXKEY`.
- **Tools answer "First-run setup…"**: the native helpers are being compiled (once, about 1–3 minutes). The log is in
  `build/build.log` inside the plugin or checkout folder. If setup failed, the tools show the last lines of that log;
  the usual fix is `xcode-select --install`. The build is retried after 10 minutes, or run `npm run build` in that folder.
- **`QSQLITE driver not loadable` or crashes after a Viber update**: Viber's bundled Qt version changed. The server
  notices and rebuilds the helpers by itself; from a checkout you can also run `npm run build`.
- **Send fails with `unverified` / `not_found`**: the chat name shown in Viber differs from the DB name, or
  the UI layout changed. `build/ax-dump` shows the current Accessibility tree; values are redacted unless you pass `--values`.
- **`occluded` / `not_frontmost`**: another window covered Viber, or focus changed mid-send. Nothing was
  sent, so just try again.
- **Desktop app: server missing or "failed"**: check `~/Library/Logs/Claude/mcp.log` and `mcp-server-viber.log`.
  `EPERM` on `dist/index.js` means the Documents-folder permission for Claude is missing. "command not found"
  means the node path in the config is gone (e.g. nvm version removed), so re-run `install-desktop-config.py`.
- **`another send is in progress`**: a confirmation is open in the other Claude app (or the last send is still
  being confirmed in `viber.db`). Answer or close it, then retry.

## Development

```
native/viberdb/viberdb.cpp   read-only DB harness (Qt, links Viber's frameworks)
native/viberax/main.swift    AX/OCR/click primitives, one JSON object per command
src/                         MCP server (TypeScript): index, repo (SQL), format, match, ui, send, react, confirm, ratelimit, setup
dist/                        compiled server, committed: plugin installs run it as-is (rebuild before committing src/ changes)
build/                       native helpers + build log/stamp (not committed; built on first start or by `npm run build`)
.claude-plugin/              plugin.json (the MCP server) + marketplace.json (this repo as a plugin marketplace)
scripts/q.py                 ad-hoc read-only SQL:  scripts/q.py "SELECT count(*) FROM Events"
scripts/smoke.mjs            end-to-end read test over MCP (counts only; --show to print content)
scripts/test-send-guards.mjs send_message guard tests (auto-declines; never sends)
scripts/test-shared-limits.mjs two server processes share the send lock + limits (auto-declines; never sends)
scripts/send-test.mjs        live send through the native confirmation dialog (you must click Send)
scripts/react-test.mjs       live like/un-like through the native dialog (you must click Like)
scripts/test-react-guards.mjs react_to_message guard tests (auto-declines; never reacts)
scripts/dev-open-chat.mjs    open + verify a chat through the production path (sends nothing)
scripts/install-desktop-config.py   add/refresh the viber entry in the Claude desktop config (backup + validate)
scripts/check-desktop-command.py    run the desktop entry's exact command in a clean env + MCP handshake
scripts/ax-dump.swift        dump Viber's Accessibility tree
```

Contributions are welcome. [CLAUDE.md](CLAUDE.md) lists the project's hard rules and hard-won gotchas (useful for
humans too).

## Credits

The key formula and the "use Viber's own codec" approach are documented in
[GhostingBit/viber-export](https://github.com/GhostingBit/viber-export) (`INTERNALS.md`). Reading the DB through
Viber's bundled Qt driver was pioneered by the (no longer available) *vibcrawl* project.

## License

[MIT](LICENSE)
