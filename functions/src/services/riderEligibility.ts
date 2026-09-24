import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  deriveRiderDispatchEligibilityFromWorkload,
  type RiderDispatchEligibilityProjection,
  type RiderEligibilityProfile,
  type RiderEligibilityWallet,
} from "../domain/riderEligibility";
import {
  isRiderOperationalWorkloadUsable,
  type RiderOperationalWorkload,
} from "../domain/riderWorkload";
import type {CollectionReferenceLike, DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import {riderRef} from "../firestorePaths";
import {
  rebuildRiderOperationalWorkload,
  riderOperationalWorkloadRef,
} from "./riderWorkload";

export function riderDispatchEligibilityCollectionRef(database: FirestoreLike): CollectionReferenceLike {
  return database.collection("private").doc("riderDispatchEligibility").collection("riders");
}

export function riderDispatchEligibilityRef(database: FirestoreLike, riderId: string): DocumentReferenceLike {
  return riderDispatchEligibilityCollectionRef(database).doc(riderId);
}

export interface RefreshRiderDispatchEligibilityOptions {
  workload?: RiderOperationalWorkload | null;
  forceWorkloadRebuild?: boolean;
}

/**
 * Rebuilds one private server-owned projection from authoritative records.
 * This function is suitable for RTDB source triggers and lazy repair during
 * dispatch. Client rules must never grant writes to this path.
 */
export async function refreshRiderDispatchEligibility(
  riderIdValue: unknown,
  now = Date.now(),
  options: RefreshRiderDispatchEligibilityOptions = {},
): Promise<RiderDispatchEligibilityProjection> {
  const riderId = String(riderIdValue ?? "").trim().slice(0, 128);
  if (!riderId) throw new Error("RIDER_ELIGIBILITY_RIDER_ID_REQUIRED");
  const [profileSnapshot, walletSnapshot, workloadValue] = await Promise.all([
    riderRef(firestoreDb, riderId).get(),
    firestoreDb.collection("riderWallets").doc(riderId).get(),
    options.workload === undefined || options.forceWorkloadRebuild === true
      ? riderOperationalWorkloadRef(firestoreDb, riderId).get().then((snapshot) => snapshot.exists ? snapshot.data() : null)
      : Promise.resolve(options.workload),
  ]);
  const usableWorkload = isRiderOperationalWorkloadUsable(workloadValue, riderId) ? workloadValue : null;
  const workload = usableWorkload && usableWorkload.overflow !== true && options.forceWorkloadRebuild !== true
    ? usableWorkload
    : await rebuildRiderOperationalWorkload(riderId, now);
  const projection = deriveRiderDispatchEligibilityFromWorkload(
    riderId,
    (profileSnapshot.exists ? profileSnapshot.data() : null) as RiderEligibilityProfile | null,
    (walletSnapshot.exists ? walletSnapshot.data() : null) as RiderEligibilityWallet | null,
    workload,
    now,
  );
  try {
    const ref = riderDispatchEligibilityRef(firestoreDb, riderId);
    await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() as RiderDispatchEligibilityProjection : null;
      if (Number(current?.updatedAt ?? 0) > projection.updatedAt) return;
      transaction.set(ref, projection);
    });
  } catch (error) {
    // The authoritative reads are still safe to use for this dispatch. A
    // projection write outage must not prevent an otherwise valid delivery.
    logger.warn("RIDER_ELIGIBILITY_PROJECTION_WRITE_FAILED", {riderId, error});
  }
  return projection;
}
