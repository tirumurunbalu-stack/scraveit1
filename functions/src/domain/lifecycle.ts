import type {ActorRole, OrderStatus} from "../types";

/**
 * Version of the additive lifecycle model. This is intentionally independent
 * from SavrivoOrder.schemaVersion so the lifecycle can evolve without changing
 * the live legacy order shape or its user-facing status strings.
 */
export const LIFECYCLE_MODEL_VERSION = 1 as const;

export const FULFILLMENT_PHASES = [
  "cart",
  "payment_pending",
  "restaurant_pending",
  "restaurant_accepted",
  "preparing",
  "ready_for_pickup",
  "picked_up",
  "out_for_delivery",
  "near_customer",
  "arrived_customer",
  "delivered",
] as const;

export const DISPATCH_PHASES = [
  "not_started",
  "searching",
  "assigned",
  "arriving_restaurant",
  "arrived_restaurant",
  "picked_up",
  "delivering",
  "completed",
] as const;

export const PAYMENT_PHASES = [
  "not_started",
  "pending",
  "authorized",
  "cash_due",
  "paid",
  "failed",
  "refund_pending",
  "refunded",
] as const;

export const TERMINAL_PHASES = [
  "none",
  "delivered",
  "restaurant_rejected",
  "customer_cancelled",
  "system_cancelled",
  "delivery_failed",
  "payment_failed",
  "refunded",
] as const;

export type FulfillmentPhase = typeof FULFILLMENT_PHASES[number];
export type DispatchPhase = typeof DISPATCH_PHASES[number];
export type PaymentPhase = typeof PAYMENT_PHASES[number];
export type TerminalPhase = typeof TERMINAL_PHASES[number];
export type LifecycleAxis = "fulfillment" | "dispatch" | "payment" | "terminal";

export interface LifecyclePhases {
  fulfillmentPhase: FulfillmentPhase;
  dispatchPhase: DispatchPhase;
  paymentPhase: PaymentPhase;
  terminalPhase: TerminalPhase;
}

export interface LifecycleSnapshot extends LifecyclePhases {
  lifecycleVersion: typeof LIFECYCLE_MODEL_VERSION;
  lifecycleRevision: number;
  lifecycleUpdatedAt: number;
}

interface LegacyHistoryEvent {
  status?: unknown;
  at?: unknown;
}

/** A deliberately small structural type so old and future order records map safely. */
export interface LifecycleOrderLike {
  status?: unknown;
  statusBeforeTerminal?: unknown;
  statusHistory?: Record<string, LegacyHistoryEvent> | null;
  paymentMethod?: unknown;
  paymentState?: unknown;
  cancelledByRole?: unknown;
  cancellationKind?: unknown;
  deliveryFailed?: unknown;
  riderId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lifecycleVersion?: unknown;
  lifecycleRevision?: unknown;
  lifecycleUpdatedAt?: unknown;
  fulfillmentPhase?: unknown;
  dispatchPhase?: unknown;
  paymentPhase?: unknown;
  terminalPhase?: unknown;
}

export const LEGACY_STATUS_LIFECYCLE: Readonly<Record<OrderStatus, Readonly<{
  fulfillmentPhase: FulfillmentPhase;
  dispatchPhase: DispatchPhase;
}>>> = {
  "Order placed": {fulfillmentPhase: "restaurant_pending", dispatchPhase: "not_started"},
  "Accepted": {fulfillmentPhase: "restaurant_accepted", dispatchPhase: "searching"},
  "Preparing": {fulfillmentPhase: "preparing", dispatchPhase: "searching"},
  "Ready for pickup": {fulfillmentPhase: "ready_for_pickup", dispatchPhase: "searching"},
  "Assigned": {fulfillmentPhase: "ready_for_pickup", dispatchPhase: "assigned"},
  "Handed to rider": {fulfillmentPhase: "picked_up", dispatchPhase: "picked_up"},
  "Out for delivery": {fulfillmentPhase: "out_for_delivery", dispatchPhase: "delivering"},
  "Near you": {fulfillmentPhase: "near_customer", dispatchPhase: "delivering"},
  "Arrived": {fulfillmentPhase: "arrived_customer", dispatchPhase: "delivering"},
  "Delivered": {fulfillmentPhase: "delivered", dispatchPhase: "completed"},
  // A cancelled legacy status carries no stage information. deriveLifecycle()
  // recovers the last non-cancelled status from history where it is available.
  "Cancelled": {fulfillmentPhase: "restaurant_pending", dispatchPhase: "not_started"},
};

const FULFILLMENT_TRANSITIONS: Readonly<Record<FulfillmentPhase, readonly FulfillmentPhase[]>> = {
  cart: ["payment_pending", "restaurant_pending"],
  payment_pending: ["restaurant_pending"],
  restaurant_pending: ["restaurant_accepted"],
  restaurant_accepted: ["preparing"],
  preparing: ["ready_for_pickup"],
  ready_for_pickup: ["picked_up"],
  picked_up: ["out_for_delivery"],
  out_for_delivery: ["near_customer", "arrived_customer"],
  near_customer: ["arrived_customer"],
  arrived_customer: ["delivered"],
  delivered: [],
};

const DISPATCH_TRANSITIONS: Readonly<Record<DispatchPhase, readonly DispatchPhase[]>> = {
  not_started: ["searching", "assigned"],
  searching: ["assigned"],
  assigned: ["arriving_restaurant", "arrived_restaurant", "picked_up"],
  arriving_restaurant: ["arrived_restaurant", "picked_up"],
  arrived_restaurant: ["picked_up"],
  picked_up: ["delivering"],
  delivering: ["completed"],
  completed: [],
};

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentPhase, readonly PaymentPhase[]>> = {
  not_started: ["pending", "cash_due"],
  pending: ["authorized", "paid", "failed"],
  authorized: ["paid", "failed", "refund_pending"],
  cash_due: ["paid"],
  paid: ["refund_pending"],
  failed: [],
  refund_pending: ["refunded"],
  refunded: [],
};

const TERMINAL_TRANSITIONS: Readonly<Record<TerminalPhase, readonly TerminalPhase[]>> = {
  none: [
    "delivered",
    "restaurant_rejected",
    "customer_cancelled",
    "system_cancelled",
    "delivery_failed",
    "payment_failed",
    "refunded",
  ],
  delivered: ["refunded"],
  restaurant_rejected: ["refunded"],
  customer_cancelled: ["refunded"],
  system_cancelled: ["refunded"],
  delivery_failed: ["refunded"],
  payment_failed: [],
  refunded: [],
};

type PhaseByAxis = {
  fulfillment: FulfillmentPhase;
  dispatch: DispatchPhase;
  payment: PaymentPhase;
  terminal: TerminalPhase;
};

const TRANSITIONS_BY_AXIS: Readonly<Record<LifecycleAxis, Readonly<Record<string, readonly string[]>>>> = {
  fulfillment: FULFILLMENT_TRANSITIONS,
  dispatch: DISPATCH_TRANSITIONS,
  payment: PAYMENT_TRANSITIONS,
  terminal: TERMINAL_TRANSITIONS,
};

const LEGACY_STATUSES = Object.keys(LEGACY_STATUS_LIFECYCLE) as OrderStatus[];

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

export function isLegacyOrderStatus(value: unknown): value is OrderStatus {
  return member(LEGACY_STATUSES, value);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function lastActiveLegacyStatus(order: LifecycleOrderLike): OrderStatus | undefined {
  if (isLegacyOrderStatus(order.statusBeforeTerminal) && order.statusBeforeTerminal !== "Cancelled") {
    return order.statusBeforeTerminal;
  }
  const candidates = Object.entries(order.statusHistory ?? {})
    .map(([key, event]) => ({key, status: event.status, at: event.at}))
    .filter((event): event is {key: string; status: OrderStatus; at: unknown} =>
      isLegacyOrderStatus(event.status) && event.status !== "Cancelled")
    .sort((a, b) => {
      const aTime = typeof a.at === "number" && Number.isFinite(a.at) ? a.at : 0;
      const bTime = typeof b.at === "number" && Number.isFinite(b.at) ? b.at : 0;
      return aTime - bTime || a.key.localeCompare(b.key);
    });
  return candidates.at(-1)?.status;
}

function legacyBaseStatus(order: LifecycleOrderLike): OrderStatus | undefined {
  if (!isLegacyOrderStatus(order.status)) return undefined;
  return order.status === "Cancelled" ? lastActiveLegacyStatus(order) ?? "Order placed" : order.status;
}

function derivePaymentPhase(order: LifecycleOrderLike): PaymentPhase {
  if (member(PAYMENT_PHASES, order.paymentState)) return order.paymentState;
  if (order.paymentMethod === "cod") return "cash_due";
  return "not_started";
}

function cancellationTerminal(order: LifecycleOrderLike): TerminalPhase {
  if (member(TERMINAL_PHASES, order.cancellationKind) &&
    !["none", "delivered", "payment_failed", "refunded"].includes(order.cancellationKind)) {
    return order.cancellationKind;
  }
  const role = order.cancelledByRole as ActorRole | undefined;
  if (role === "customer") return "customer_cancelled";
  if (role === "staff" || role === "owner") return "restaurant_rejected";
  return "system_cancelled";
}

function deriveTerminalPhase(order: LifecycleOrderLike, paymentPhase: PaymentPhase): TerminalPhase {
  if (paymentPhase === "refunded") return "refunded";
  if (paymentPhase === "failed") return "payment_failed";
  if (order.deliveryFailed === true) return "delivery_failed";
  if (order.status === "Cancelled") return cancellationTerminal(order);
  if (order.status === "Delivered") return "delivered";
  return "none";
}

function hasCurrentLifecycle(order: LifecycleOrderLike): order is LifecycleOrderLike & LifecyclePhases {
  return order.lifecycleVersion === LIFECYCLE_MODEL_VERSION &&
    member(FULFILLMENT_PHASES, order.fulfillmentPhase) &&
    member(DISPATCH_PHASES, order.dispatchPhase) &&
    member(PAYMENT_PHASES, order.paymentPhase) &&
    member(TERMINAL_PHASES, order.terminalPhase);
}

/**
 * Deterministically maps both legacy and versioned order records. No clock,
 * database, or environment access occurs here, making replay and migration safe.
 */
export function deriveLifecycle(order: LifecycleOrderLike): LifecycleSnapshot {
  const lifecycleUpdatedAt = nonNegativeInteger(
    order.lifecycleUpdatedAt,
    nonNegativeInteger(order.updatedAt, nonNegativeInteger(order.createdAt, 0)),
  );
  const lifecycleRevision = nonNegativeInteger(order.lifecycleRevision, 0);

  if (hasCurrentLifecycle(order)) {
    return {
      lifecycleVersion: LIFECYCLE_MODEL_VERSION,
      lifecycleRevision,
      lifecycleUpdatedAt,
      fulfillmentPhase: order.fulfillmentPhase,
      dispatchPhase: order.dispatchPhase,
      paymentPhase: order.paymentPhase,
      terminalPhase: order.terminalPhase,
    };
  }

  const paymentPhase = derivePaymentPhase(order);
  const baseStatus = legacyBaseStatus(order);
  const legacy = baseStatus ? LEGACY_STATUS_LIFECYCLE[baseStatus] : undefined;
  const fulfillmentPhase = legacy?.fulfillmentPhase ??
    (paymentPhase === "pending" || paymentPhase === "authorized" || paymentPhase === "failed" ?
      "payment_pending" : "cart");

  const earlyAssigned = Boolean(String(order.riderId ?? "").trim()) &&
    baseStatus != null && ["Accepted", "Preparing", "Ready for pickup"].includes(baseStatus);
  return {
    lifecycleVersion: LIFECYCLE_MODEL_VERSION,
    lifecycleRevision,
    lifecycleUpdatedAt,
    fulfillmentPhase,
    dispatchPhase: earlyAssigned ? "assigned" : legacy?.dispatchPhase ?? "not_started",
    paymentPhase,
    terminalPhase: deriveTerminalPhase(order, paymentPhase),
  };
}

/**
 * Rebuilds lifecycle phases from the canonical legacy-compatible order fields,
 * deliberately ignoring any previously persisted lifecycle projection. This
 * is used inside the same server transaction that changes `status` so an old
 * projection can never override the newly committed canonical state.
 */
export function deriveLifecycleFromCanonicalState(order: LifecycleOrderLike): LifecycleSnapshot {
  const {
    lifecycleVersion: _version,
    lifecycleRevision: _revision,
    lifecycleUpdatedAt: _updatedAt,
    fulfillmentPhase: _fulfillment,
    dispatchPhase: _dispatch,
    paymentPhase: _payment,
    terminalPhase: _terminal,
    ...canonical
  } = order;
  return deriveLifecycle(canonical);
}

function reachable(
  graph: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): boolean {
  const pending = [...(graph[from] ?? [])];
  const visited = new Set<string>([from]);
  while (pending.length) {
    const candidate = pending.shift();
    if (!candidate || visited.has(candidate)) continue;
    if (candidate === to) return true;
    visited.add(candidate);
    pending.push(...(graph[candidate] ?? []));
  }
  return false;
}

export interface PhaseAdvanceOptions {
  allowIdempotent?: boolean;
  allowSkips?: boolean;
}

/** Validates one orthogonal lifecycle axis without assuming database state. */
export function canAdvanceLifecyclePhase<A extends LifecycleAxis>(
  axis: A,
  from: PhaseByAxis[A],
  to: PhaseByAxis[A],
  options: PhaseAdvanceOptions = {},
): boolean {
  if (from === to) return options.allowIdempotent !== false;
  const graph = TRANSITIONS_BY_AXIS[axis];
  return options.allowSkips === true ? reachable(graph, from, to) : (graph[from]?.includes(to) ?? false);
}

export interface LifecycleViolation {
  axis: LifecycleAxis | "state";
  code: "BACKWARD_OR_INVALID_TRANSITION" | "TERMINAL_STATE_LOCKED" | "INCONSISTENT_STATE";
  from?: string;
  to?: string;
  detail: string;
}

export interface LifecycleValidationResult {
  allowed: boolean;
  idempotent: boolean;
  violations: LifecycleViolation[];
}

function phasesEqual(a: LifecyclePhases, b: LifecyclePhases): boolean {
  return a.fulfillmentPhase === b.fulfillmentPhase &&
    a.dispatchPhase === b.dispatchPhase &&
    a.paymentPhase === b.paymentPhase &&
    a.terminalPhase === b.terminalPhase;
}

function consistencyViolations(next: LifecyclePhases): LifecycleViolation[] {
  const violations: LifecycleViolation[] = [];
  const inconsistent = (detail: string) => violations.push({
    axis: "state", code: "INCONSISTENT_STATE", detail,
  });

  if (next.terminalPhase === "delivered" &&
    (next.fulfillmentPhase !== "delivered" || next.dispatchPhase !== "completed")) {
    inconsistent("Delivered terminal state requires delivered fulfillment and completed dispatch.");
  }
  if (next.fulfillmentPhase === "delivered" &&
    next.terminalPhase !== "delivered" && next.terminalPhase !== "refunded") {
    inconsistent("Delivered fulfillment requires a delivered or refunded terminal state.");
  }
  if (next.dispatchPhase === "completed" && next.fulfillmentPhase !== "delivered") {
    inconsistent("Completed dispatch requires delivered fulfillment.");
  }
  if (next.terminalPhase === "payment_failed" && next.paymentPhase !== "failed") {
    inconsistent("Payment-failed terminal state requires failed payment.");
  }
  if (next.paymentPhase === "failed" && next.terminalPhase !== "payment_failed") {
    inconsistent("Failed payment requires the payment-failed terminal state.");
  }
  if (next.terminalPhase === "refunded" && next.paymentPhase !== "refunded") {
    inconsistent("Refunded terminal state requires refunded payment.");
  }
  if (next.paymentPhase === "refunded" && next.terminalPhase !== "refunded") {
    inconsistent("Refunded payment requires the refunded terminal state.");
  }
  return violations;
}

/**
 * Validates a proposed lifecycle mutation. Direct transitions are the default;
 * migration/reconciliation code may explicitly opt into monotonic phase skips.
 */
export function validateLifecycleTransition(
  current: LifecyclePhases,
  next: LifecyclePhases,
  options: PhaseAdvanceOptions = {},
): LifecycleValidationResult {
  const idempotent = phasesEqual(current, next);
  const violations: LifecycleViolation[] = [];
  const check = (axis: LifecycleAxis, from: string, to: string) => {
    const graph = TRANSITIONS_BY_AXIS[axis];
    const allowed = from === to ? options.allowIdempotent !== false :
      options.allowSkips === true ? reachable(graph, from, to) : (graph[from]?.includes(to) ?? false);
    if (!allowed) violations.push({
      axis,
      code: "BACKWARD_OR_INVALID_TRANSITION",
      from,
      to,
      detail: `Cannot change ${axis} from ${from} to ${to}.`,
    });
  };

  check("fulfillment", current.fulfillmentPhase, next.fulfillmentPhase);
  check("dispatch", current.dispatchPhase, next.dispatchPhase);
  check("payment", current.paymentPhase, next.paymentPhase);
  check("terminal", current.terminalPhase, next.terminalPhase);

  if (current.terminalPhase !== "none" &&
    (current.fulfillmentPhase !== next.fulfillmentPhase || current.dispatchPhase !== next.dispatchPhase)) {
    violations.push({
      axis: "state",
      code: "TERMINAL_STATE_LOCKED",
      detail: "Fulfillment and dispatch cannot change after a terminal outcome.",
    });
  }
  violations.push(...consistencyViolations(next));

  return {allowed: violations.length === 0, idempotent, violations};
}

export function canTransitionLifecycle(
  current: LifecyclePhases,
  next: LifecyclePhases,
  options: PhaseAdvanceOptions = {},
): boolean {
  return validateLifecycleTransition(current, next, options).allowed;
}

export class LifecycleTransitionError extends Error {
  constructor(readonly violations: readonly LifecycleViolation[]) {
    super(violations.map((violation) => violation.detail).join(" "));
    this.name = "LifecycleTransitionError";
  }
}

export interface LifecycleMutationResult {
  idempotent: boolean;
  expectedRevision: number;
  patch: LifecycleSnapshot;
}

export interface LifecycleMutationOptions extends PhaseAdvanceOptions {
  expectedRevision?: number;
}

/**
 * Builds fields suitable for an additive backend mutation. `serverTimestamp`
 * must be supplied by trusted server code. Idempotent retries do not increment
 * revision or move the timestamp, enabling safe callable/function retries.
 */
export function buildLifecycleMutation(
  current: LifecycleSnapshot,
  next: LifecyclePhases,
  serverTimestamp: number,
  options: LifecycleMutationOptions = {},
): LifecycleMutationResult {
  if (!Number.isSafeInteger(serverTimestamp) || serverTimestamp < 0) {
    throw new Error("INVALID_SERVER_TIMESTAMP");
  }
  if (current.lifecycleVersion !== LIFECYCLE_MODEL_VERSION) {
    throw new Error("UNSUPPORTED_LIFECYCLE_VERSION");
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.lifecycleRevision) {
    throw new Error("LIFECYCLE_REVISION_CONFLICT");
  }

  const validation = validateLifecycleTransition(current, next, options);
  if (!validation.allowed) throw new LifecycleTransitionError(validation.violations);
  if (!validation.idempotent && serverTimestamp < current.lifecycleUpdatedAt) {
    throw new Error("STALE_SERVER_TIMESTAMP");
  }

  return {
    idempotent: validation.idempotent,
    expectedRevision: current.lifecycleRevision,
    patch: {
      lifecycleVersion: LIFECYCLE_MODEL_VERSION,
      lifecycleRevision: validation.idempotent ? current.lifecycleRevision : current.lifecycleRevision + 1,
      lifecycleUpdatedAt: validation.idempotent ? current.lifecycleUpdatedAt : serverTimestamp,
      fulfillmentPhase: next.fulfillmentPhase,
      dispatchPhase: next.dispatchPhase,
      paymentPhase: next.paymentPhase,
      terminalPhase: next.terminalPhase,
    },
  };
}
