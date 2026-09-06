import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import type {DispatchRiderJob} from "../domain/dispatch";
import {
  buildRiderOperationalWorkload,
  reduceRiderOperationalWorkload,
  type RiderOperationalWorkload,
} from "../domain/riderWorkload";

export const RIDER_OPERATIONAL_WORKLOAD_ROOT = `${ROOT}/private/operations/riderWorkload`;

function objectMap<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" ? value as Record<string, T> : {};
}

export async function reconcileRiderOperationalWorkload(
  riderIdValue: unknown,
  orderIdValue: unknown,
  before: DispatchRiderJob | null | undefined,
  after: DispatchRiderJob | null | undefined,
  eventAt = Date.now(),
): Promise<RiderOperationalWorkload> {
  const riderId = String(riderIdValue ?? "").trim().slice(0, 128);
  const orderId = String(orderIdValue ?? "").trim().slice(0, 128);
  if (!riderId || !orderId) throw new Error("RIDER_WORKLOAD_ID_REQUIRED");
  const ref = db.ref(`${RIDER_OPERATIONAL_WORKLOAD_ROOT}/${riderId}`);
  const result = await ref.transaction((current: RiderOperationalWorkload | null) => {
    const next = reduceRiderOperationalWorkload(current, riderId, orderId, before, after, eventAt);
    return next === current ? undefined : next;
  }, undefined, false);
  return result.snapshot.val() as RiderOperationalWorkload;
}

/**
 * Full history is read only to repair/backfill a missing or overflowed
 * projection. Steady-state source triggers use the single-job reducer above.
 */
export async function rebuildRiderOperationalWorkload(
  riderIdValue: unknown,
  now = Date.now(),
): Promise<RiderOperationalWorkload> {
  const riderId = String(riderIdValue ?? "").trim().slice(0, 128);
  if (!riderId) throw new Error("RIDER_WORKLOAD_RIDER_ID_REQUIRED");
  const jobsSnapshot = await db.ref(`${ROOT}/riderJobs/${riderId}`).get();
  const rebuilt = buildRiderOperationalWorkload(
    riderId,
    objectMap<DispatchRiderJob>(jobsSnapshot.val()),
    now,
  );
  const result = await db.ref(`${RIDER_OPERATIONAL_WORKLOAD_ROOT}/${riderId}`).transaction(
    (current: RiderOperationalWorkload | null) =>
      Number(current?.updatedAt ?? 0) > rebuilt.updatedAt ? undefined : rebuilt,
    undefined,
    false,
  );
  const persisted = result.snapshot.val() as RiderOperationalWorkload | null;
  if (!result.committed) {
    logger.info("STALE_RIDER_WORKLOAD_REBUILD_IGNORED", {riderId, rebuiltAt: rebuilt.updatedAt});
  }
  return persisted ?? rebuilt;
}
