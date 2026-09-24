import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import type {DispatchRiderJob} from "../domain/dispatch";
import {
  buildRiderOperationalWorkload,
  reduceRiderOperationalWorkload,
  type RiderOperationalWorkload,
} from "../domain/riderWorkload";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import {riderJobsCollectionRef} from "../firestorePaths";

export function riderOperationalWorkloadRef(database: FirestoreLike, riderId: string): DocumentReferenceLike {
  return database.collection("private").doc("operations").collection("riderWorkload").doc(riderId);
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
  const ref = riderOperationalWorkloadRef(firestoreDb, riderId);
  return firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as RiderOperationalWorkload : null;
    const next = reduceRiderOperationalWorkload(current, riderId, orderId, before, after, eventAt);
    if (next !== current) transaction.set(ref, next);
    return next;
  });
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
  const jobsSnapshot = await riderJobsCollectionRef(firestoreDb).where("riderId", "==", riderId).get();
  const jobs: Record<string, DispatchRiderJob> = {};
  for (const doc of jobsSnapshot.docs) {
    const orderId = doc.id.slice(riderId.length + 1);
    jobs[orderId] = doc.data() as DispatchRiderJob;
  }
  const rebuilt = buildRiderOperationalWorkload(riderId, jobs, now);
  const ref = riderOperationalWorkloadRef(firestoreDb, riderId);
  let committed = false;
  const persisted = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as RiderOperationalWorkload : null;
    if (Number(current?.updatedAt ?? 0) > rebuilt.updatedAt) return current;
    transaction.set(ref, rebuilt);
    committed = true;
    return rebuilt;
  });
  if (!committed) {
    logger.info("STALE_RIDER_WORKLOAD_REBUILD_IGNORED", {riderId, rebuiltAt: rebuilt.updatedAt});
  }
  return persisted ?? rebuilt;
}
