/**
 * Store opening hours: the store opens itself at its opening time and closes
 * itself at its closing time, every day it is open (openDays).
 *
 * Only the moments matter, not the whole day: at each opening or closing time
 * the server sets the switch once. If the restaurant switches it by hand in
 * between, that choice stands until the next opening or closing time.
 *
 * Times may be "11:00", "23:00" (sign-up), "11:00am", "10:00 PM", "11 am".
 * A closing time at or before the opening time means after midnight
 * (e.g. 6 pm to 2 am). Same opening and closing time = open all day: nothing to do.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Minutes after midnight, or null when the text is not a time. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(value);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  const half = m[3] ? m[3].toLowerCase().replace(/\./g, "") : "";
  if (minutes > 59) return null;
  if (half) {
    if (hours < 1 || hours > 12) return null;
    hours = hours % 12 + (half === "pm" ? 12 : 0);
  } else {
    // "11" alone is ambiguous; a 24-hour time needs its minutes.
    if (m[2] === undefined || hours > 23) return null;
  }
  return hours * 60 + minutes;
}

export interface StoreHoursInput {
  opensAt?: unknown;
  opensUntil?: unknown;
  openDays?: unknown;
}

export interface StoreHoursEvent {
  /** Unique per store per opening or closing, e.g. "2026-11-13:open". */
  key: string;
  open: boolean;
  at: number;
}

function openDaySet(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const days = new Set(value.map((d) => String(d).trim().slice(0, 3).toLowerCase()).filter(Boolean));
  return days.size ? days : null;
}

/** The latest opening or closing time that has already passed, or null (no usable hours). */
export function latestStoreHoursEvent(store: StoreHoursInput, now: number): StoreHoursEvent | null {
  const open = parseClock(store.opensAt);
  const close = parseClock(store.opensUntil);
  if (open === null || close === null || open === close) return null;
  const days = openDaySet(store.openDays);
  const overnight = close < open;
  const todayStartIst = Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS; // midnight IST, as UTC-style ms
  let best: StoreHoursEvent | null = null;
  // Each open day's opening, and its closing (the next morning for overnight hours).
  // Eight days back covers a store open only one day a week.
  for (let d = 0; d <= 8; d++) {
    const dayStartIst = todayStartIst - d * DAY_MS;
    const date = new Date(dayStartIst);
    if (days && !days.has(String(DAY_NAMES[date.getUTCDay()]).toLowerCase())) continue;
    const dayKey = date.toISOString().slice(0, 10);
    const events: StoreHoursEvent[] = [
      {key: `${dayKey}:open`, open: true, at: dayStartIst + open * 60_000 - IST_OFFSET_MS},
      {key: `${dayKey}:close`, open: false, at: dayStartIst + (overnight ? DAY_MS : 0) + close * 60_000 - IST_OFFSET_MS},
    ];
    for (const event of events) if (event.at <= now && (!best || event.at > best.at)) best = event;
  }
  return best;
}

/**
 * What the server should do now: null = nothing (no hours, or this opening or
 * closing was already applied, so a manual switch since then is respected).
 */
export function storeHoursChange(
  store: StoreHoursInput & {open?: unknown; archived?: unknown},
  lastAppliedKey: string,
  now: number,
): StoreHoursEvent | null {
  if (store.archived === true) return null;
  const event = latestStoreHoursEvent(store, now);
  if (!event || event.key === lastAppliedKey) return null;
  return event;
}
