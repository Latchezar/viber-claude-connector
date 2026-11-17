// Human confirmation of a send.
//   - Claude Code (clientInfo.name "claude-code") with form-mode elicitation: an MCP
//     elicitation form in the terminal, which only the human can answer.
//   - Every other client (e.g. the Claude desktop app) — or VIBER_CONFIRM=dialog — a native
//     macOS dialog whose default button is "Cancel".
// Approval is only ever: the form submitted with send === true, or the dialog's "Send"
// button. Anything else (decline, cancel, timeout, errors, missing capability) = not approved.
import { execFile } from "node:child_process";
/** Decide how to ask the human. Pure function (unit-tested). */
export function confirmationMode(clientName, elicitation, pref = process.env.VIBER_CONFIRM) {
    const p = (pref ?? "auto").trim().toLowerCase();
    if (p === "dialog")
        return { mode: "dialog", why: "VIBER_CONFIRM=dialog" };
    // Opt-in: the MCP client's own per-call tool approval ("Allow?") is the confirmation.
    if (p === "client")
        return { mode: "client", why: "VIBER_CONFIRM=client: the app's own tool-approval prompt is the confirmation" };
    const caps = elicitation && typeof elicitation === "object" ? elicitation : undefined;
    // Protocol 2025-11-25+: {form:{}, url:{}}; older revisions: a bare {} means form mode.
    const formSupported = !!caps && ("form" in caps || Object.keys(caps).length === 0);
    const isClaudeCode = /^claude[-_ ]?code$/i.test(clientName ?? "");
    if (isClaudeCode && formSupported)
        return { mode: "form", why: "Claude Code with form elicitation" };
    if (!isClaudeCode)
        return { mode: "dialog", why: `client "${clientName ?? "unknown"}" is not Claude Code` };
    return { mode: "dialog", why: "client does not declare form elicitation" };
}
export function clientLabel(name) {
    if (/^claude[-_ ]?code$/i.test(name ?? ""))
        return "Claude Code";
    if (/^claude-ai$/i.test(name ?? ""))
        return "Claude desktop app";
    if (/^local-agent-mode/i.test(name ?? ""))
        return "Claude desktop app (agent mode)";
    return name ? `MCP client "${name}"` : "an unknown MCP client";
}
function render(r, mode, requestedBy) {
    return [
        r.question,
        "",
        ...r.lines,
        `Requested from: ${requestedBy}`,
        ...(r.block ? ["", `──── ${r.block.label} ────`, r.block.text, "──── end ────"] : []),
        "",
        mode === "form" ? "Nothing happens unless you tick the box and submit." : `Nothing happens unless you click ${r.button}.`,
    ].join("\n");
}
export async function confirmAction(server, r) {
    const client = server.server.getClientVersion();
    const requestedBy = clientLabel(client?.name);
    const { mode } = confirmationMode(client?.name, server.server.getClientCapabilities()?.elicitation);
    if (mode === "client")
        return { approved: true, via: "client" };
    if (mode === "form") {
        try {
            const res = await server.server.elicitInput({
                mode: "form",
                message: render(r, "form", requestedBy),
                requestedSchema: {
                    type: "object",
                    properties: { confirm: { type: "boolean", title: r.checkbox, default: false } },
                    required: ["confirm"],
                },
            }, { timeout: 10 * 60_000 });
            if (res.action === "accept" && res.content?.confirm === true)
                return { approved: true, via: "form" };
            // decline / cancel (incl. non-interactive sessions) is a real answer: never fall back.
            return { approved: false, via: "form", reason: res.action === "accept" ? "box not ticked" : res.action };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/timed? ?out/i.test(msg))
                return { approved: false, via: "form", reason: "no answer within 10 minutes" };
            // Protocol-level failure (declared but can't render): ask with the native dialog instead.
        }
    }
    return nativeDialog(render(r, "dialog", requestedBy), r.dialogTitle, r.button);
}
export function confirmSend(server, d) {
    return confirmAction(server, {
        question: "Send this Viber message?",
        lines: [`To: ${d.to}`, `Length: ${[...d.text].length} characters`],
        block: { label: "message", text: d.text },
        checkbox: "Yes, send this message",
        button: "Send",
        dialogTitle: "Viber — confirm send",
    });
}
const DIALOG_SCRIPT = `on run argv
  try
    set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancel", (item 3 of argv)} default button "Cancel" cancel button "Cancel" with icon caution giving up after 300
    if gave up of r then return "timeout"
    return button returned of r
  on error number -128
    return "Cancel"
  end try
end run`;
function nativeDialog(message, title, button) {
    return new Promise((resolve) => {
        execFile("/usr/bin/osascript", ["-e", DIALOG_SCRIPT, message, title, button], { timeout: 320_000 }, (err, stdout) => {
            const answer = String(stdout ?? "").trim();
            if (!err && answer === button && button !== "Cancel")
                resolve({ approved: true, via: "dialog" });
            else
                resolve({ approved: false, via: "dialog", reason: err ? `dialog error: ${err.message}` : answer || "cancelled" });
        });
    });
}
//# sourceMappingURL=confirm.js.map