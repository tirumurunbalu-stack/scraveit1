/**
 * Orders per delivery partner per peak hour (founder 21 Nov 2026, target 1.5).
 * Every 5 minutes in the lunch and dinner windows we count the partners who
 * are online; partner-hours = those counts × 5 min. Orders = deliveries made
 * inside the same windows. Orders ÷ partner-hours above the target means the
 * partners on the road can't keep up: add partners.
 */
export const PEAK_SLOTS = [
  {key: "lunch", label: "Lunch 11:30 AM–3 PM", startMinute: 11 * 60 + 30, endMinute: 15 * 60},
  {key: "dinner", label: "Dinner 7–11 PM", startMinute: 19 * 60, endMinute: 23 * 60},
] as const;

export type PeakSlotKey = typeof PEAK_SLOTS[number]["key"];

export const PEAK_SAMPLE_MINUTES = 5;
export const PEAK_TARGET_ORDERS_PER_PARTNER_HOUR = 1.5;
/** Below this, partners wait for orders and earn less an hour. */
export const PEAK_LOW_ORDERS_PER_PARTNER_HOUR = 1;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000;

/** IST calendar day and minute of the day. */
export function istParts(at: number): {date: string; minute: number} {
  const shifted = new Date(at + IST_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** The peak window `at` falls in, or null. */
export function peakSlotAt(at: number): {date: string; slot: PeakSlotKey; minute: number} | null {
  if (!Number.isFinite(at) || at <= 0) return null;
  const {date, minute} = istParts(at);
  const slot = PEAK_SLOTS.find((entry) => minute >= entry.startMinute && minute < entry.endMinute);
  return slot ? {date, slot: slot.key, minute} : null;
}

/** "1135" for 11:35 IST, rounded down to the 5-minute sample. */
export function sampleKey(minute: number): string {
  const rounded = Math.floor(minute / PEAK_SAMPLE_MINUTES) * PEAK_SAMPLE_MINUTES;
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}${String(rounded % 60).padStart(2, "0")}`;
}

/**
 * Partners online now. One on a delivery counts even if their last ping is
 * older (they're working); an idle one needs a fresh ping.
 */
export function countOnlinePartners(partners: ReadonlyArray<Record<string, unknown>>, now: number, freshMs: number): number {
  return partners.filter((partner) => {
    if (partner.online !== true) return false;
    if (String(partner.activeOrderId ?? "").trim()) return true;
    const updatedAt = Number(partner.updatedAt ?? 0);
    return Number.isFinite(updatedAt) && now - updatedAt <= freshMs;
  }).length;
}

export type PeakAdvice = "add_partners" | "on_target" | "partners_waiting" | "no_data";

export interface PeakSlotSummary {
  slot: PeakSlotKey;
  orders: number;
  samples: number;
  partnerHours: number;
  averageOnline: number;
  ordersPerPartnerHour: number | null;
  advice: PeakAdvice;
}

/** One window's numbers from its stored samples (sampleKey → partners online) and delivered orders. */
export function summarizePeakSlot(slot: PeakSlotKey, stored: unknown): PeakSlotSummary {
  const record = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  const orders = Math.max(0, Math.round(Number(record.orders) || 0));
  const counts = record.counts && typeof record.counts === "object" ? Object.values(record.counts as Record<string, unknown>) : [];
  const online = counts.map((value) => Math.max(0, Number(value) || 0));
  const samples = online.length;
  const partnerMinutes = online.reduce((sum, value) => sum + value, 0) * PEAK_SAMPLE_MINUTES;
  const partnerHours = Math.round(partnerMinutes / 60 * 100) / 100;
  const averageOnline = samples ? Math.round(online.reduce((sum, value) => sum + value, 0) / samples * 10) / 10 : 0;
  const ordersPerPartnerHour = partnerMinutes > 0 ? Math.round(orders / (partnerMinutes / 60) * 100) / 100 : null;
  return {slot, orders, samples, partnerHours, averageOnline, ordersPerPartnerHour, advice: peakAdvice(ordersPerPartnerHour, orders)};
}

export function peakAdvice(ordersPerPartnerHour: number | null, orders: number): PeakAdvice {
  if (ordersPerPartnerHour === null) return orders > 0 ? "add_partners" : "no_data";
  if (ordersPerPartnerHour > PEAK_TARGET_ORDERS_PER_PARTNER_HOUR) return "add_partners";
  if (ordersPerPartnerHour < PEAK_LOW_ORDERS_PER_PARTNER_HOUR) return "partners_waiting";
  return "on_target";
}

/** Several days of one window added up (the weekly line on the admin page). */
export function combinePeakSlots(slot: PeakSlotKey, days: readonly PeakSlotSummary[]): PeakSlotSummary {
  const orders = days.reduce((sum, day) => sum + day.orders, 0);
  const samples = days.reduce((sum, day) => sum + day.samples, 0);
  const partnerHours = Math.round(days.reduce((sum, day) => sum + day.partnerHours, 0) * 100) / 100;
  const averageOnline = samples ?
    Math.round(days.reduce((sum, day) => sum + day.averageOnline * day.samples, 0) / samples * 10) / 10 : 0;
  const ordersPerPartnerHour = partnerHours > 0 ? Math.round(orders / partnerHours * 100) / 100 : null;
  return {slot, orders, samples, partnerHours, averageOnline, ordersPerPartnerHour, advice: peakAdvice(ordersPerPartnerHour, orders)};
}
