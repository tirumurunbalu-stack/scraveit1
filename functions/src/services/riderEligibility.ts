import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
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
import {
  rebuildRiderOperationalWorkload,
  RIDER_OPERATIONAL_WORKLOAD_ROOT,
} from "./riderWorkload";

export const RIDER_DISPATCH_ELIGIBILITY_ROOT = `${ROOT}/private/riderDispatchEligibility`;

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
    db.ref(`${ROOT}/riders/${riderId}`).get(),
    db.ref(`${ROOT}/riderWallets/${riderId}`).get(),
    options.workload === undefined || options.forceWorkloadRebuild === true
      ? db.ref(`${RIDER_OPERATIONAL_WORKLOAD_ROOT}/${riderId}`).get().then((snapshot) => snapshot.val())
      : Promise.resolve(options.workload),
  ]);
  const usableWorkload = isRiderOperationalWorkloadUsable(workloadValue, riderId) ? workloadValue : null;
  const workload = usableWorkload && usableWorkload.overflow !== true && options.forceWorkloadRebuild !== true
    ? usableWorkload
    : await rebuildRiderOperationalWorkload(riderId, now);
  const projection = deriveRiderDispatchEligibilityFromWorkload(
    riderId,
    profileSnapshot.val() as RiderEligibilityProfile | null,
    walletSnapshot.val() as RiderEligibilityWallet | null,
    workload,
    now,
  );
  try {
    await db.ref(`${RIDER_DISPATCH_ELIGIBILITY_ROOT}/${riderId}`).transaction(
      (current: RiderDispatchEligibilityProjection | null) =>
        Number(current?.updatedAt ?? 0) > projection.updatedAt ? undefined : projection,
      undefined,
      false,
    );
  } catch (error) {
    // The authoritative reads are still safe to use for this dispatch. A
    // projection write outage must not prevent an otherwise valid delivery.
    logger.warn("RIDER_ELIGIBILITY_PROJECTION_WRITE_FAILED", {riderId, error});
  }
  return projection;
}
