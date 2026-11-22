/**
 * Bonus abuse check (founder 21 Nov 2026): the same delivery partner keeps
 * delivering to the same customer. Flag (never block) when one pair reaches
 * 3 deliveries in a day or 6 in 7 days, or when the partner delivers to their
 * own phone number. One flag per pair per 7 days; the admin decides.
 */
export const PAIR_DAY_LIMIT = 3;
export const PAIR_WEEK_LIMIT = 6;
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const KEEP_MS = 30 * DAY_MS;
const MAX_KEPT = 60;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000;

export interface PairDelivery {
  orderId: string;
  at: number;
}

export interface PairState {
  deliveries: PairDelivery[];
  lastFlaggedAt: number;
}

export type PairFlagReason = "repeat_pair" | "own_phone";

function istDay(at: number): string {
  return new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function pairDocId(riderId: string, customerId: string): string {
  return `${riderId}__${customerId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 300);
}

/** Last 10 digits, so +91 and spaces don't matter. */
export function samePhone(left: unknown, right: unknown): boolean {
  const a = String(left ?? "").replace(/\D/g, "").slice(-10);
  const b = String(right ?? "").replace(/\D/g, "").slice(-10);
  return a.length === 10 && a === b;
}

export function readPairState(stored: unknown): PairState {
  const record = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  const deliveries = Array.isArray(record.deliveries) ? record.deliveries
    .map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {})
    .map((entry) => ({orderId: String(entry.orderId ?? ""), at: Number(entry.at)}))
    .filter((entry) => entry.orderId && Number.isFinite(entry.at) && entry.at > 0) : [];
  const lastFlaggedAt = Number(record.lastFlaggedAt);
  return {deliveries, lastFlaggedAt: Number.isFinite(lastFlaggedAt) && lastFlaggedAt > 0 ? lastFlaggedAt : 0};
}

/**
 * Adds one delivery (a repeat of the same order changes nothing) and says
 * whether to flag now.
 */
export function nextPairState(current: PairState, delivery: PairDelivery, ownPhone = false): {
  state: PairState;
  duplicate: boolean;
  dayCount: number;
  weekCount: number;
  flag: PairFlagReason | null;
} {
  const duplicate = current.deliveries.some((entry) => entry.orderId === delivery.orderId);
  const deliveries = (duplicate ? current.deliveries : [...current.deliveries, delivery])
    .filter((entry) => delivery.at - entry.at < KEEP_MS)
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_KEPT);
  const day = istDay(delivery.at);
  const dayCount = deliveries.filter((entry) => istDay(entry.at) === day).length;
  const weekCount = deliveries.filter((entry) => delivery.at - entry.at < WEEK_MS && entry.at <= delivery.at).length;
  const reason: PairFlagReason | null = ownPhone ? "own_phone" :
    dayCount >= PAIR_DAY_LIMIT || weekCount >= PAIR_WEEK_LIMIT ? "repeat_pair" : null;
  const due = !duplicate && reason !== null && (!current.lastFlaggedAt || delivery.at - current.lastFlaggedAt >= WEEK_MS);
  return {
    state: {deliveries, lastFlaggedAt: due ? delivery.at : current.lastFlaggedAt},
    duplicate,
    dayCount,
    weekCount,
    flag: due ? reason : null,
  };
}
