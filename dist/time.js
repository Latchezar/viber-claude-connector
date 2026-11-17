// Time helpers: parse user-friendly "since"/"until" values and format timestamps locally.
const UNIT_MS = {
    m: 60_000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
};
/**
 * Accepts ISO dates/datetimes ("2026-11-15", "2026-11-15T10:00", "2026-11-15 10:00"),
 * relative durations ("30m", "2h", "3d", "1w"), and "today" / "yesterday".
 * Returns epoch milliseconds.
 */
export function parseWhen(value, now = new Date()) {
    const v = value.trim().toLowerCase();
    if (v === "now")
        return now.getTime();
    if (v === "today" || v === "yesterday") {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        if (v === "yesterday")
            d.setDate(d.getDate() - 1);
        return d.getTime();
    }
    const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/.exec(v);
    if (rel)
        return now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]];
    // Date-only strings are parsed as UTC by JS; treat them as local midnight instead.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (dateOnly)
        return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
    const t = Date.parse(value.trim().replace(" ", "T"));
    if (Number.isNaN(t)) {
        throw new Error(`Unrecognised time "${value}". Use ISO (2026-11-15 or 2026-11-15T10:00), a duration (2h, 3d, 1w), "today" or "yesterday".`);
    }
    return t;
}
/** Local time as ISO-8601 with UTC offset, e.g. 2026-11-17T20:27:56+02:00. */
export function formatLocal(ms) {
    const d = new Date(ms);
    const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    return (`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
        `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`);
}
//# sourceMappingURL=time.js.map