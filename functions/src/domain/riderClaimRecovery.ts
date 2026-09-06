import {createHash} from "node:crypto";

export const RIDER_CLAIM_RECOVERY_VERSION = 1 as const;

export const RIDER_CLAIM_STATES = ["reserved", "order_committed", "finalized"] as const;
export type RiderClaimState = typeof RIDER_CLAIM_STATES[number];

export const RIDER_CLAIM_RECOVERY_ACTIONS = [
  "none",
  "wait_for_lease",
  "release_for_redispatch",
  "cancel_queue",
  "finalize_authoritative_assignment",
] as const;
export type RiderClaimRecoveryAction = typeof RIDER_CLAIM_RECOVERY_ACTIONS[number];

export interface RiderClaimLike {
  riderId?: unknown;
  claimedAt?: unknown;
  operationId?: unknown;
  leaseUntil?: unknown;
  state?: unknown;
}

/** A narrow structural view of both legacy and current RTDB dispatch queues. */
export interface RiderClaimQueueLike {
  orderId?: unknown;
  customerId?: unknown;
  status?: unknown;
  active?: unknown;
  claim?: RiderClaimLike | null;
  metrics?: Record<string, unknown> | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
}

/** Canonical order is authoritative for whether and to whom a rider is assigned. */
export interface RiderClaimOrderLike {
  id?: unknown;
  customerId?: unknown;
  status?: unknown;
  riderId?: unknown;
  riderAssignedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface NormalizedRiderClaim {
  riderId: string;
  claimedAt: number;
  operationId: string;
  leaseUntil: number;
  state: RiderClaimState;
  inferredState: boolean;
  inferredLease: boolean;
}

export interface RiderClaimRecoveryOptions {
  /** Compatibility duration for old claim records that predate leaseUntil. */
  legacyLeaseMs?: number;
}

export type RiderClaimRecoveryReason =
  | "claim_missing"
  | "lease_active"
  | "authoritative_order_missing"
  | "authoritative_order_not_dispatchable"
  | "authoritative_order_unassigned"
  | "authoritative_order_matches_claim"
  | "authoritative_order_overrides_claim"
  | "assignment_already_finalized";

export interface RiderClaimRecoveryPlan {
  recoveryVersion: typeof RIDER_CLAIM_RECOVERY_VERSION;
  recoveryId: string;
  orderId: string;
  customerId: string;
  action: RiderClaimRecoveryAction;
  reason: RiderClaimRecoveryReason;
  claim: NormalizedRiderClaim | null;
  expectedQueueFingerprint: string;
  authoritativeRiderId: string | null;
  assignmentAt: number | null;
  /** Explicit integration hints; no side effects are performed by this module. */
  clearOutstandingOffers: boolean;
  stopOutstandingAlerts: boolean;
  rebuildRiderProjection: boolean;
  restartDispatch: boolean;
}

const DEFAULT_LEGACY_LEASE_MS = 60_000;
const DISPATCHABLE_UNASSIGNED_STATUSES = new Set(["Accepted", "Preparing", "Ready for pickup"]);

function text(value: unknown, maximum = 256): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function claimState(value: unknown): RiderClaimState {
  return RIDER_CLAIM_STATES.some((state) => state === value) ? value as RiderClaimState : "reserved";
}

function stableHash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}

function deterministicOperationId(orderId: string, riderId: string): string {
  const safeOrder = orderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 90) || "unknown";
  const safeRider = riderId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 70) || "unknown";
  return `claim_${safeOrder}_${safeRider}`.slice(0, 180);
}

export function normalizeRiderClaim(
  raw: RiderClaimLike,
  orderId: string,
  options: RiderClaimRecoveryOptions = {},
): NormalizedRiderClaim {
  const riderId = text(raw.riderId, 128);
  const claimedAt = nonNegativeInteger(raw.claimedAt);
  const state = claimState(raw.state);
  const legacyLeaseMs = positiveInteger(options.legacyLeaseMs, DEFAULT_LEGACY_LEASE_MS);
  const inferredLeaseUntil = Math.min(Number.MAX_SAFE_INTEGER, claimedAt + legacyLeaseMs);
  const leaseUntil = nonNegativeInteger(raw.leaseUntil, inferredLeaseUntil);
  const operationId = text(raw.operationId, 180) || deterministicOperationId(orderId, riderId);
  return {
    riderId,
    claimedAt,
    operationId,
    leaseUntil,
    state,
    inferredState: !RIDER_CLAIM_STATES.some((candidate) => candidate === raw.state),
    inferredLease: !(typeof raw.leaseUntil === "number" && Number.isSafeInteger(raw.leaseUntil) && raw.leaseUntil >= 0),
  };
}

export function riderClaimQueueFingerprint(
  queue: RiderClaimQueueLike,
  options: RiderClaimRecoveryOptions = {},
): string {
  const orderId = text(queue.orderId);
  const claim = queue.claim && typeof queue.claim === "object" ? normalizeRiderClaim(queue.claim, orderId, options) : null;
  return stableHash([
    orderId,
    text(queue.customerId),
    text(queue.status, 80),
    queue.active === true,
    claim?.riderId ?? null,
    claim?.claimedAt ?? null,
    claim?.operationId ?? null,
    claim?.leaseUntil ?? null,
    claim?.state ?? null,
  ]);
}

function assignmentTimestamp(order: RiderClaimOrderLike, claim: NormalizedRiderClaim): number {
  return nonNegativeInteger(
    order.riderAssignedAt,
    nonNegativeInteger(order.updatedAt, nonNegativeInteger(order.createdAt, claim.claimedAt)),
  );
}

function queueIsFinalizedFor(queue: RiderClaimQueueLike, riderId: string, claim: NormalizedRiderClaim): boolean {
  const activeOffers = queue.activeOffers && typeof queue.activeOffers === "object" ?
    Object.keys(queue.activeOffers).length : 0;
  const hasOutstandingOffer = Boolean(queue.currentOffer) || activeOffers > 0 || Boolean(text(queue.offeredRiderId));
  return claim.state === "finalized" && claim.riderId === riderId &&
    queue.status === "assigned" && queue.active === false && !hasOutstandingOffer;
}

function actionForUnassignedOrder(order: RiderClaimOrderLike | null): {
  action: RiderClaimRecoveryAction;
  reason: RiderClaimRecoveryReason;
} {
  if (!order) return {action: "cancel_queue", reason: "authoritative_order_missing"};
  const status = text(order.status, 80);
  if (DISPATCHABLE_UNASSIGNED_STATUSES.has(status)) {
    return {action: "release_for_redispatch", reason: "authoritative_order_unassigned"};
  }
  return {
    action: "cancel_queue",
    reason: "authoritative_order_not_dispatchable",
  };
}

/**
 * Pure recovery decision for a dispatch claim lease.
 *
 * The order's riderId is always authoritative. The helper never mutates an
 * order or changes its legacy status string. An expired reservation with no
 * committed assignment is released; an authoritative assignment is finalized
 * even when it differs from the stale claimant; an already-finalized matching
 * queue is an idempotent no-op.
 */
export function decideExpiredRiderClaimRecovery(
  queue: RiderClaimQueueLike,
  order: RiderClaimOrderLike | null,
  now: number,
  options: RiderClaimRecoveryOptions = {},
): RiderClaimRecoveryPlan {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_RECOVERY_TIMESTAMP");
  const orderId = text(queue.orderId) || text(order?.id) || "unknown-order";
  const customerId = text(queue.customerId) || text(order?.customerId);
  const expectedQueueFingerprint = riderClaimQueueFingerprint(queue, options);
  const rawClaim = queue.claim && typeof queue.claim === "object" ? queue.claim : null;
  const claim = rawClaim ? normalizeRiderClaim(rawClaim, orderId, options) : null;
  const authoritativeRiderId = text(order?.riderId, 128) || null;

  let action: RiderClaimRecoveryAction = "none";
  let reason: RiderClaimRecoveryReason = "claim_missing";
  let assignmentAt: number | null = null;

  if (claim) {
    if (claim.leaseUntil > now) {
      action = "wait_for_lease";
      reason = "lease_active";
    } else if (!authoritativeRiderId) {
      ({action, reason} = actionForUnassignedOrder(order));
    } else {
      assignmentAt = assignmentTimestamp(order!, claim);
      if (queueIsFinalizedFor(queue, authoritativeRiderId, claim)) {
        action = "none";
        reason = "assignment_already_finalized";
      } else {
        action = "finalize_authoritative_assignment";
        reason = authoritativeRiderId === claim.riderId ?
          "authoritative_order_matches_claim" : "authoritative_order_overrides_claim";
      }
    }
  }

  const recoveryId = `claim-recovery-${stableHash([
    orderId,
    expectedQueueFingerprint,
    action,
    reason,
    authoritativeRiderId,
    assignmentAt,
  ])}`;
  const mutating = action === "release_for_redispatch" || action === "cancel_queue" ||
    action === "finalize_authoritative_assignment";
  return {
    recoveryVersion: RIDER_CLAIM_RECOVERY_VERSION,
    recoveryId,
    orderId,
    customerId,
    action,
    reason,
    claim,
    expectedQueueFingerprint,
    authoritativeRiderId,
    assignmentAt,
    clearOutstandingOffers: mutating,
    stopOutstandingAlerts: mutating,
    rebuildRiderProjection: action === "finalize_authoritative_assignment",
    restartDispatch: action === "release_for_redispatch",
  };
}

function currentMatchesPlan(
  current: RiderClaimQueueLike,
  plan: RiderClaimRecoveryPlan,
  options: RiderClaimRecoveryOptions,
): boolean {
  return riderClaimQueueFingerprint(current, options) === plan.expectedQueueFingerprint &&
    (text(current.orderId) || plan.orderId) === plan.orderId;
}

function finalizedOperationId(plan: RiderClaimRecoveryPlan, riderId: string): string {
  if (plan.claim?.riderId === riderId) return plan.claim.operationId;
  return deterministicOperationId(plan.orderId, riderId);
}

/**
 * Pure RTDB queue transaction updater. Undefined means the plan is stale or
 * non-mutating. Offer fields are removed from the returned object rather than
 * written as undefined, keeping the result RTDB-compatible.
 */
export function buildRiderClaimRecoveryQueueCandidate(
  current: RiderClaimQueueLike | null,
  plan: RiderClaimRecoveryPlan,
  now: number,
  options: RiderClaimRecoveryOptions = {},
): RiderClaimQueueLike | undefined {
  if (!current || !Number.isSafeInteger(now) || now < 0 || !currentMatchesPlan(current, plan, options)) return undefined;
  if (!["release_for_redispatch", "cancel_queue", "finalize_authoritative_assignment"].includes(plan.action)) {
    return undefined;
  }
  const {
    claim: _claim,
    currentOffer: _currentOffer,
    activeOffers: _activeOffers,
    offeredRiderId: _offeredRiderId,
    ...base
  } = current;

  if (plan.action === "release_for_redispatch") {
    return {...base, status: "exhausted", active: false, updatedAt: now};
  }
  if (plan.action === "cancel_queue") {
    return {...base, status: "cancelled", active: false, updatedAt: now};
  }

  const riderId = plan.authoritativeRiderId;
  if (!riderId || plan.assignmentAt == null) return undefined;
  const metrics = current.metrics && typeof current.metrics === "object" ? current.metrics : {};
  const existingAccepted = nonNegativeInteger(metrics.accepted);
  const existingAssignedAt = nonNegativeInteger(metrics.assignedAt, plan.assignmentAt);
  return {
    ...base,
    status: "assigned",
    active: false,
    claim: {
      riderId,
      claimedAt: plan.assignmentAt,
      operationId: finalizedOperationId(plan, riderId),
      leaseUntil: plan.assignmentAt,
      state: "finalized",
    },
    metrics: {
      ...metrics,
      accepted: Math.max(1, existingAccepted),
      assignedAt: existingAssignedAt,
    },
    updatedAt: now,
  };
}
