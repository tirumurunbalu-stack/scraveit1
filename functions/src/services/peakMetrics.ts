import {FieldValue} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {DEFAULT_DISPATCH_POLICY} from "../domain/dispatchPolicy";
import {
  combinePeakSlots,
  countOnlinePartners,
  istParts,
  PEAK_SLOTS,
  PEAK_TARGET_ORDERS_PER_PARTNER_HOUR,
  peakSlotAt,
  sampleKey,
  summarizePeakSlot,
  type PeakSlotSummary,
} from "../domain/peakMetrics";
import type {FirestoreLike} from "../firestoreTypes";
import {riderAvailabilityCollectionRef} from "../firestorePaths";
import type {SavrivoOrder} from "../types";

/** private/opsMetrics/peakDays/{YYYY-MM-DD}: {lunch: {counts: {"1135": 4}, orders: 9}, dinner: {...}} */
const peakDayRef = (database: FirestoreLike, date: string) =>
  database.collection("private").doc("opsMetrics").collection("peakDays").doc(date);

/** Every 5 minutes in a peak window: how many partners are online. Same sample twice = same key, no double count. */
export async function samplePeakPartners(
  now = Date.now(),
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<{slot: string; online: number} | null> {
  const peak = peakSlotAt(now);
  if (!peak) return null;
  const snapshot = await riderAvailabilityCollectionRef(database).where("online", "==", true).limit(2_000).get();
  const online = countOnlinePartners(snapshot.docs.map((doc) => doc.data() as Record<string, unknown>), now,
    DEFAULT_DISPATCH_POLICY.presenceFreshMs);
  await peakDayRef(database, peak.date).set({
    date: peak.date,
    [peak.slot]: {counts: {[sampleKey(peak.minute)]: online}},
    updatedAt: now,
  }, {merge: true});
  return {slot: peak.slot, online};
}

/** A delivery made inside a peak window counts for that window (the caller runs it once per order). */
export async function countPeakDelivery(
  order: SavrivoOrder,
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<boolean> {
  if (order.status !== "Delivered" || order.selfDelivery === true) return false;
  const peak = peakSlotAt(Number(order.deliveredAt ?? order.updatedAt));
  if (!peak) return false;
  await peakDayRef(database, peak.date).set({
    date: peak.date,
    [peak.slot]: {orders: FieldValue.increment(1)},
  }, {merge: true});
  return true;
}

export interface PeakReport {
  target: number;
  days: Array<{date: string; slots: PeakSlotSummary[]}>;
  week: PeakSlotSummary[];
}

/** The last `days` days (today first) and the 7-day totals per window. */
export async function readPeakReport(
  days = 14,
  now = Date.now(),
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<PeakReport> {
  const dates = Array.from({length: Math.max(1, Math.min(31, days))}, (_, index) => istParts(now - index * 86_400_000).date);
  const snapshots = await Promise.all(dates.map((date) => peakDayRef(database, date).get().catch((error) => {
    logger.warn("PEAK_DAY_READ_FAILED", {date, error: String(error)});
    return null;
  })));
  const rows = dates.map((date, index) => {
    const data = snapshots[index]?.exists ? snapshots[index]!.data() as Record<string, unknown> : {};
    return {date, slots: PEAK_SLOTS.map((slot) => summarizePeakSlot(slot.key, data[slot.key]))};
  });
  const lastWeek = rows.slice(0, 7);
  return {
    target: PEAK_TARGET_ORDERS_PER_PARTNER_HOUR,
    days: rows,
    week: PEAK_SLOTS.map((slot, index) => combinePeakSlots(slot.key, lastWeek.map((row) => row.slots[index]!))),
  };
}
