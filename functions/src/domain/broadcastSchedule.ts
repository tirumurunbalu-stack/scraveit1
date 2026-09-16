const DAY_MS = 24 * 60 * 60 * 1000;
/** India does not observe DST, so a fixed offset is safe for civil-day math. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type CustomerBroadcastRepeatType = "none" | "daily" | "weekly" | "custom";

export interface CustomerBroadcastRepeat {
  type: CustomerBroadcastRepeatType;
  days?: number[];
  intervalDays?: number;
}

function istWeekday(epochMs: number): number {
  return new Date(epochMs + IST_OFFSET_MS).getUTCDay();
}

/**
 * Given the occurrence that was just sent, returns the next scheduledAt for
 * a recurring broadcast, or null if it should not recur again. Interval-based
 * types (daily/custom) add whole days in absolute time, which is exact for
 * India's fixed UTC+5:30 offset. Weekly recurrence walks forward day-by-day
 * (also in absolute 24h steps) checking the IST calendar weekday, so the
 * original time-of-day is always preserved.
 */
export function computeNextBroadcastOccurrence(
  currentScheduledAt: number,
  repeat: CustomerBroadcastRepeat | null | undefined,
): number | null {
  if (!repeat || repeat.type === "none") return null;
  if (!Number.isFinite(currentScheduledAt) || currentScheduledAt <= 0) return null;

  if (repeat.type === "daily") return currentScheduledAt + DAY_MS;

  if (repeat.type === "custom") {
    const interval = Number.isInteger(repeat.intervalDays) && (repeat.intervalDays as number) >= 1
      ? (repeat.intervalDays as number)
      : 1;
    return currentScheduledAt + interval * DAY_MS;
  }

  if (repeat.type === "weekly") {
    const days = Array.isArray(repeat.days)
      ? [...new Set(repeat.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [];
    if (!days.length) return null;
    const daySet = new Set(days);
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = currentScheduledAt + offset * DAY_MS;
      if (daySet.has(istWeekday(candidate))) return candidate;
    }
    return null;
  }

  return null;
}
