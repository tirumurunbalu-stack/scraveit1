import {
  activeDispatchJobs,
  isEarlyDispatchWorkloadEligible,
  type DispatchRiderJob,
} from "./dispatch";

export const RIDER_OPERATIONAL_WORKLOAD_VERSION = 1 as const;
export const RIDER_OPERATIONAL_WORKLOAD_MAX_ACTIVE = 32;
export const RIDER_OPERATIONAL_WORKLOAD_MAX_RECENT = 50;
export const RIDER_OPERATIONAL_WORKLOAD_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export interface RiderWorkloadJobState extends DispatchRiderJob {
  orderId: string;
  sourceUpdatedAt: number;
  observedAt: number;
  terminalAt?: number;
}

export interface RiderOperationalWorkload {
  version: typeof RIDER_OPERATIONAL_WORKLOAD_VERSION;
  source: "functions";
  riderId: string;
  activeCount: number;
  workloadEligible: boolean;
  overflow: boolean;
  activeOrders: Record<string, RiderWorkloadJobState>;
  recentOrders: Record<string, RiderWorkloadJobState>;
  updatedAt: number;
}

function normalizedId(value: unknown): string {
  return String(value ?? "").trim().slice(0, 128);
}

function positiveTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : fallback;
}

function jobIsActive(job: DispatchRiderJob | null | undefined): boolean {
  return activeDispatchJobs(job ? {job} : {}).length === 1;
}

function workloadEligible(activeOrders: Record<string, RiderWorkloadJobState>, overflow: boolean): boolean {
  return !overflow && isEarlyDispatchWorkloadEligible(activeOrders);
}

function recentEntries(
  states: Record<string, RiderWorkloadJobState>,
  now: number,
): Record<string, RiderWorkloadJobState> {
  return Object.fromEntries(Object.entries(states)
    .filter(([, state]) => Number(state.terminalAt ?? state.observedAt) >= now - RIDER_OPERATIONAL_WORKLOAD_RECENT_MS)
    .sort((a, b) => Number(b[1].terminalAt ?? b[1].observedAt) - Number(a[1].terminalAt ?? a[1].observedAt))
    .slice(0, RIDER_OPERATIONAL_WORKLOAD_MAX_RECENT));
}

function projection(
  riderId: string,
  activeOrdersValue: Record<string, RiderWorkloadJobState>,
  recentOrdersValue: Record<string, RiderWorkloadJobState>,
  now: number,
  inheritedOverflow = false,
): RiderOperationalWorkload {
  const orderedActive = Object.entries(activeOrdersValue)
    .sort((a, b) => b[1].sourceUpdatedAt - a[1].sourceUpdatedAt);
  const overflow = inheritedOverflow || orderedActive.length > RIDER_OPERATIONAL_WORKLOAD_MAX_ACTIVE;
  const activeOrders = Object.fromEntries(orderedActive.slice(0, RIDER_OPERATIONAL_WORKLOAD_MAX_ACTIVE));
  const recentOrders = recentEntries(recentOrdersValue, now);
  return {
    version: RIDER_OPERATIONAL_WORKLOAD_VERSION,
    source: "functions",
    riderId,
    activeCount: overflow ? RIDER_OPERATIONAL_WORKLOAD_MAX_ACTIVE + 1 : orderedActive.length,
    workloadEligible: workloadEligible(activeOrders, overflow),
    overflow,
    activeOrders,
    recentOrders,
    updatedAt: now,
  };
}

/**
 * Incrementally reconciles one rider-job change without reading the rider's
 * complete job history. Trigger event time is used to reject out-of-order
 * deletes while a job's own updatedAt rejects stale writes.
 */
export function reduceRiderOperationalWorkload(
  current: RiderOperationalWorkload | null,
  riderIdValue: unknown,
  orderIdValue: unknown,
  before: DispatchRiderJob | null | undefined,
  after: DispatchRiderJob | null | undefined,
  eventAtValue = Date.now(),
): RiderOperationalWorkload {
  const riderId = normalizedId(riderIdValue);
  const orderId = normalizedId(orderIdValue);
  if (!riderId || !orderId) throw new Error("RIDER_WORKLOAD_ID_REQUIRED");
  const eventAt = positiveTimestamp(eventAtValue, Date.now());
  const activeOrders = {...(current?.activeOrders ?? {})};
  const recentOrders = {...(current?.recentOrders ?? {})};
  const existing = activeOrders[orderId] ?? recentOrders[orderId];
  const sourceUpdatedAt = after
    ? positiveTimestamp((after as Record<string, unknown>).updatedAt, eventAt)
    : eventAt;
  if (existing && existing.sourceUpdatedAt > sourceUpdatedAt) return current!;

  delete activeOrders[orderId];
  delete recentOrders[orderId];
  if (after) {
    const state: RiderWorkloadJobState = {
      orderId,
      status: after.status,
      orderStatus: after.orderStatus,
      phase: after.phase,
      sourceUpdatedAt,
      observedAt: eventAt,
      ...(!jobIsActive(after) ? {terminalAt: eventAt} : {}),
    };
    if (jobIsActive(after)) activeOrders[orderId] = state;
    else recentOrders[orderId] = state;
  } else if (before && !jobIsActive(before)) {
    // A deleted terminal projection remains useful for a short operational
    // window, without retaining the full rider-job record or customer data.
    recentOrders[orderId] = {
      orderId,
      status: before.status,
      orderStatus: before.orderStatus,
      phase: before.phase,
      sourceUpdatedAt,
      observedAt: eventAt,
      terminalAt: eventAt,
    };
  }
  return projection(riderId, activeOrders, recentOrders, eventAt, current?.overflow === true);
}

/** One-time repair/backfill helper. Normal event processing uses the reducer. */
export function buildRiderOperationalWorkload(
  riderIdValue: unknown,
  jobs: Record<string, DispatchRiderJob> | null | undefined,
  nowValue = Date.now(),
): RiderOperationalWorkload {
  const riderId = normalizedId(riderIdValue);
  if (!riderId) throw new Error("RIDER_WORKLOAD_RIDER_ID_REQUIRED");
  const now = positiveTimestamp(nowValue, Date.now());
  const activeOrders: Record<string, RiderWorkloadJobState> = {};
  const recentOrdersValue: Record<string, RiderWorkloadJobState> = {};
  for (const [rawOrderId, job] of Object.entries(jobs ?? {})) {
    const orderId = normalizedId(rawOrderId);
    if (!orderId || !job || typeof job !== "object") continue;
    const sourceUpdatedAt = positiveTimestamp((job as Record<string, unknown>).updatedAt, now);
    const state: RiderWorkloadJobState = {
      orderId,
      status: job.status,
      orderStatus: job.orderStatus,
      phase: job.phase,
      sourceUpdatedAt,
      observedAt: now,
      ...(!jobIsActive(job) ? {terminalAt: sourceUpdatedAt} : {}),
    };
    if (jobIsActive(job)) activeOrders[orderId] = state;
    else recentOrdersValue[orderId] = state;
  }
  return projection(riderId, activeOrders, recentOrdersValue, now);
}

export function isRiderOperationalWorkloadUsable(
  value: unknown,
  expectedRiderIdValue: unknown,
): value is RiderOperationalWorkload {
  if (!value || typeof value !== "object") return false;
  const workload = value as Partial<RiderOperationalWorkload>;
  const expectedRiderId = normalizedId(expectedRiderIdValue);
  return Boolean(
    expectedRiderId &&
    workload.version === RIDER_OPERATIONAL_WORKLOAD_VERSION &&
    workload.source === "functions" &&
    normalizedId(workload.riderId) === expectedRiderId &&
    typeof workload.activeCount === "number" &&
    Number.isInteger(workload.activeCount) &&
    workload.activeCount >= 0 &&
    typeof workload.workloadEligible === "boolean" &&
    typeof workload.overflow === "boolean" &&
    workload.activeOrders && typeof workload.activeOrders === "object" &&
    workload.recentOrders && typeof workload.recentOrders === "object" &&
    typeof workload.updatedAt === "number" && Number.isFinite(workload.updatedAt) && workload.updatedAt > 0
  );
}
