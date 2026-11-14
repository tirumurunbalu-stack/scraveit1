import type {SavrivoOrder} from "../types";

/**
 * Kitchen timer, the same rule the store apps show (counted from Accept):
 * 15 minutes for a small order, 20 for a bigger one (more than 3 dishes in
 * all, or more than 2 different dishes). Free items don't count.
 * Once it runs out the store hears "Your order is getting late": at the
 * deadline, then every minute until Order ready (or the order moves on).
 * Safety stop after 60 reminders (an hour late) so a forgotten order
 * doesn't ring all night.
 */
export const LATE_REMINDER_GAP_MS = 60_000;
export const LATE_REMINDER_COUNT = 60;
const LATE_STATUSES = new Set(["Accepted", "Preparing"]);

type KitchenOrder = Pick<SavrivoOrder, "status" | "items" | "statusHistory" | "updatedAt" | "createdAt">;

export function kitchenAcceptedAt(order: KitchenOrder): number {
  const times = Object.values(order.statusHistory ?? {})
    .filter((event) => event?.status === "Accepted")
    .map((event) => Number(event.at) || 0)
    .filter((at) => at > 0);
  return times.length ? Math.min(...times) : Number(order.updatedAt || order.createdAt || 0);
}

export function kitchenPrepMinutes(order: KitchenOrder): number {
  const items = (order.items ?? []).filter((item) => !(item as {free?: unknown}).free);
  const units = items.reduce((n, item) => n + (Number(item.quantity) || 1), 0);
  return units > 3 || items.length > 2 ? 20 : 15;
}

/** Which reminder (0 … 59) is due now, or null when none is. */
export function lateReminderDue(order: KitchenOrder, now: number): number | null {
  if (!LATE_STATUSES.has(String(order.status))) return null;
  const accepted = kitchenAcceptedAt(order);
  if (!accepted) return null;
  const late = now - (accepted + kitchenPrepMinutes(order) * 60_000);
  if (late < 0) return null;
  const n = Math.floor(late / LATE_REMINDER_GAP_MS);
  return n < LATE_REMINDER_COUNT ? n : null;
}
