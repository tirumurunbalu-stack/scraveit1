import {randomBytes, randomInt, timingSafeEqual} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db} from "../admin";
import {pathFor, ROOT, SCHEMA_VERSION} from "../config";
import {
  buildOrderTransitionCandidate,
  buildPricing,
  canTransition,
  deterministicOrderId,
  hashOtp,
  priceCart,
  roundMoney,
} from "../domain/order";
import {deliveryOtpRecoveryAllowed, legacyOtpVerifier, stripPrivateOrderFields} from "../domain/orderSecurity";
import {deriveLifecycleFromCanonicalState} from "../domain/lifecycle";
import {
  resolveFinancePaymentSelection,
  type FinancePolicy,
} from "../domain/financePolicy";
import type {ProximityStatus} from "../domain/tracking";
import {DomainError} from "../errors";
import type {CreateCodOrderInput, CreateOrderInput, TransitionOrderInput} from "./serviceTypes";
import type {ActorRole, OrderStatus, SavrivoOrder, StatusEvent} from "../types";
import {authorizeTransition} from "./authz";
import {calculateDiscount, loadCustomerAddress, loadRestaurantAndMenu, loadServerFees} from "./catalog";
import {reconcileRestaurantWorkload} from "./workload";
import {reconcileRestaurantOrderProjection} from "./orderProjection";
import {persistCodOrderDeliveryLedger} from "./ledger";
import {persistOnlineOrderDeliveryLedger} from "./onlineDeliveryLedger";
import {loadFinancePolicy} from "./platformConfig";
import {requireVerifiedRiderRestaurantArrival} from "./riderRestaurantArrival";

function eventKey(now: number, actorId: string): string {
  return `e_${now}_${actorId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30)}`;
}

function isOnlinePaymentMethod(value: SavrivoOrder["paymentMethod"]): value is "upi" | "card" {
  return value === "upi" || value === "card";
}

function initialOrderPaymentState(
  paymentMethod: SavrivoOrder["paymentMethod"],
): SavrivoOrder["paymentState"] {
  return paymentMethod === "cod" ? "cash_due" : "pending";
}

function paymentDetailsFromCreateInput(
  input: CreateOrderInput,
  financePolicy: Pick<FinancePolicy, "payments">,
): Pick<SavrivoOrder, "paymentMethod" | "paymentState" | "paymentProvider"> {
  const payment = resolveFinancePaymentSelection(financePolicy, {
    paymentMethod: input.paymentMethod,
    paymentProvider: input.paymentProvider,
  });
  return isOnlinePaymentMethod(payment.paymentMethod)
    ? {
      paymentMethod: payment.paymentMethod,
      paymentState: initialOrderPaymentState(payment.paymentMethod),
      paymentProvider: payment.paymentProvider,
    }
    : {
      paymentMethod: "cod",
      paymentState: "cash_due",
    };
}

function paymentSelectionError(error: unknown): DomainError | null {
  const code = error instanceof Error ? error.message : "";
  if (code === "PAYMENT_METHOD_DISABLED:cod") {
    return new DomainError("failed-precondition", "Cash on delivery is not available right now.");
  }
  if (code === "PAYMENT_METHOD_DISABLED:upi") {
    return new DomainError("failed-precondition", "UPI payment is not available right now.");
  }
  if (code === "PAYMENT_METHOD_DISABLED:card") {
    return new DomainError("failed-precondition", "Card payment is not available right now.");
  }
  if (code === "PAYMENT_PROVIDER_UNAVAILABLE:upi" || code === "PAYMENT_PROVIDER_MISSING:upi") {
    return new DomainError("failed-precondition", "The configured UPI provider is not available right now.");
  }
  if (code === "PAYMENT_PROVIDER_UNAVAILABLE:card" || code === "PAYMENT_PROVIDER_MISSING:card") {
    return new DomainError("failed-precondition", "The configured card provider is not available right now.");
  }
  return null;
}

export function requiresVerifiedOnlinePaymentBeforeProgress(
  order: Pick<SavrivoOrder, "paymentMethod" | "paymentState">,
  toStatus: OrderStatus,
): boolean {
  return isOnlinePaymentMethod(order.paymentMethod) &&
    order.paymentState !== "paid" &&
    toStatus !== "Cancelled";
}

interface PrivateOtpRecord {
  customerId: string;
  otp?: string;
  verifier: string;
  salt: string;
  createdAt: number;
  updatedAt: number;
  migratedFromLegacy?: boolean;
}

async function reserveDeliveryOtp(customerId: string, orderId: string): Promise<PrivateOtpRecord> {
  const ref = db.ref(`${ROOT}/private/deliveryOtps/${orderId}`);
  const now = Date.now();
  const otp = String(randomInt(1000, 10_000));
  const salt = randomBytes(16).toString("hex");
  const candidate: PrivateOtpRecord = {
    customerId,
    otp,
    verifier: hashOtp(otp, salt),
    salt,
    createdAt: now,
    updatedAt: now,
  };
  const result = await ref.transaction((current: PrivateOtpRecord | null) => {
    if (!current) return candidate;
    if (current.customerId !== customerId) return undefined;
    const currentOtp = String(current.otp ?? "");
    const currentSalt = String(current.salt ?? "");
    if (/^\d{4}$/.test(currentOtp) && /^[a-f0-9]{16,128}$/i.test(currentSalt)) {
      return {
        ...current,
        otp: currentOtp,
        salt: currentSalt,
        verifier: hashOtp(currentOtp, currentSalt),
        updatedAt: Number(current.updatedAt ?? current.createdAt ?? now),
      };
    }
    // A verifier-only legacy migration cannot recover the customer's code.
    // Reissue it atomically and return the replacement to the same customer.
    return candidate;
  }, undefined, false);
  const record = result.snapshot.val() as PrivateOtpRecord | null;
  if (!record || record.customerId !== customerId || !/^\d{4}$/.test(String(record.otp)) ||
    !/^[a-f0-9]{64}$/i.test(String(record.verifier)) || !record.salt) {
    throw new DomainError("already-exists", "Delivery verification reservation conflict.");
  }
  return record;
}

export async function scrubLegacyPublicOtp(order: SavrivoOrder): Promise<SavrivoOrder> {
  const clean = stripPrivateOrderFields(order);
  const legacy = order as SavrivoOrder & Record<string, unknown>;
  if (!["deliveryOtp", "deliveryOtpHash", "deliveryOtpSalt", "deliveryOtpVerifier"]
    .some((field) => Object.prototype.hasOwnProperty.call(legacy, field))) return clean;
  const legacyVerifier = legacyOtpVerifier(order);
  const legacyOtp = String(legacy.deliveryOtp ?? "");
  if (legacyVerifier || /^\d{4}$/.test(legacyOtp)) {
    const now = Date.now();
    const salt = legacyVerifier?.salt ?? randomBytes(16).toString("hex");
    const migrated: PrivateOtpRecord = {
      customerId: order.customerId,
      ...(/^\d{4}$/.test(legacyOtp) ? {otp: legacyOtp} : {}),
      verifier: legacyVerifier?.verifier ?? hashOtp(legacyOtp, salt),
      salt,
      createdAt: now,
      updatedAt: now,
      migratedFromLegacy: true,
    };
    const privateRef = db.ref(`${ROOT}/private/deliveryOtps/${order.id}`);
    const result = await privateRef.transaction((current: PrivateOtpRecord | null) => {
      if (!current) return migrated;
      if (current.customerId !== order.customerId) return undefined;
      if (/^[a-f0-9]{64}$/i.test(String(current.verifier ?? "")) && current.salt) return current;
      return migrated;
    }, undefined, false);
    const privateRecord = result.snapshot.val() as PrivateOtpRecord | null;
    if (!privateRecord || privateRecord.customerId !== order.customerId ||
      !/^[a-f0-9]{64}$/i.test(String(privateRecord.verifier ?? "")) || !privateRecord.salt) {
      throw new DomainError("failed-precondition", "Legacy delivery verification could not be migrated safely.");
    }
  }
  await db.ref(ROOT).update({
    [`orders/${order.customerId}/${order.id}/deliveryOtp`]: null,
    [`orders/${order.customerId}/${order.id}/deliveryOtpHash`]: null,
    [`orders/${order.customerId}/${order.id}/deliveryOtpSalt`]: null,
    [`orders/${order.customerId}/${order.id}/deliveryOtpVerifier`]: null,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/deliveryOtp`]: null,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/deliveryOtpHash`]: null,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/deliveryOtpSalt`]: null,
    [`restaurantOrders/${order.restaurantId}/${order.customerId}/${order.id}/deliveryOtpVerifier`]: null,
  });
  return clean;
}

async function otpForExisting(order: SavrivoOrder): Promise<string> {
  if (["Delivered", "Cancelled"].includes(order.status)) {
    await scrubLegacyPublicOtp(order);
    return "";
  }
  const reserved = await reserveDeliveryOtp(order.customerId, order.id);
  await scrubLegacyPublicOtp(order);
  return String(reserved.otp);
}

/** Restores an active delivery code only to the authenticated customer who owns the order. */
export async function recoverCustomerDeliveryOtp(uid: string, orderId: string): Promise<string> {
  const order = (await db.ref(pathFor.order(uid, orderId)).get()).val() as SavrivoOrder | null;
  if (!order || order.customerId !== uid) throw new DomainError("not-found", "Order not found.");
  if (!deliveryOtpRecoveryAllowed(order.status)) {
    throw new DomainError("failed-precondition", "Delivery verification is not available at this order stage.");
  }
  const deliveryOtp = await otpForExisting(order);
  if (!/^\d{4}$/.test(deliveryOtp)) {
    throw new DomainError("failed-precondition", "Delivery verification could not be restored.");
  }
  return deliveryOtp;
}

function secureVerifierMatch(suppliedOtp: string, record: Pick<PrivateOtpRecord, "verifier" | "salt">): boolean {
  const supplied = Buffer.from(hashOtp(suppliedOtp, record.salt), "hex");
  const expected = Buffer.from(record.verifier, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function verifyPrivateDeliveryOtp(order: SavrivoOrder, suppliedOtp: string): Promise<boolean> {
  const ref = db.ref(`${ROOT}/private/deliveryOtps/${order.id}`);
  let record = (await ref.get()).val() as PrivateOtpRecord | null;
  if (record?.customerId === order.customerId && record.salt) {
    const storedVerifier = String(record.verifier ?? "");
    const verifier = /^[a-f0-9]{64}$/i.test(storedVerifier)
      ? storedVerifier.toLowerCase()
      : /^\d{4}$/.test(String(record.otp ?? "")) ? hashOtp(String(record.otp), String(record.salt)) : "";
    if (verifier) {
      record = {...record, verifier};
      if (verifier !== storedVerifier) {
        await ref.update({verifier, updatedAt: Date.now()});
      }
    }
  }

  if (!record || record.customerId !== order.customerId || !/^[a-f0-9]{64}$/i.test(String(record.verifier ?? ""))) {
    const legacy = legacyOtpVerifier(order);
    if (!legacy) return false;
    const now = Date.now();
    const migrated: PrivateOtpRecord = {
      customerId: order.customerId,
      verifier: legacy.verifier,
      salt: legacy.salt,
      createdAt: now,
      updatedAt: now,
      migratedFromLegacy: true,
    };
    const result = await ref.transaction((current: PrivateOtpRecord | null) => current ?? migrated, undefined, false);
    record = result.snapshot.val() as PrivateOtpRecord | null;
  }

  if (!record || record.customerId !== order.customerId || !record.salt ||
    !/^[a-f0-9]{64}$/i.test(String(record.verifier ?? ""))) return false;
  const matches = secureVerifierMatch(suppliedOtp, record);
  // Once the private verifier is durable, remove legacy public material even
  // when the submitted code is wrong; future attempts still verify privately.
  await scrubLegacyPublicOtp(order);
  return matches;
}

interface CommitTransitionOptions {
  before: SavrivoOrder;
  toStatus: OrderStatus;
  actorId: string;
  actorRole: ActorRole;
  actorEmail?: string;
  reason?: string;
  proof?: string;
  detail?: string;
  expectedRiderId?: string;
}

async function commitAuthoritativeTransition(options: CommitTransitionOptions): Promise<SavrivoOrder> {
  const {before, toStatus, actorId, actorRole} = options;
  const ref = db.ref(pathFor.order(before.customerId, before.id));
  const now = Date.now();
  const id = eventKey(now, actorId);
  const event: StatusEvent = {
    status: toStatus,
    at: now,
    actorId,
    actorRole,
    ...(options.reason ? {reason: options.reason} : {}),
    ...(options.proof ? {proof: options.proof} : {}),
    ...(options.detail ? {detail: options.detail} : {}),
  };
  const result = await ref.transaction((current: SavrivoOrder | null) => {
    const candidate = buildOrderTransitionCandidate(current, before, {
      toStatus,
      actorRole,
      eventId: id,
      event,
      now,
      ...(options.reason ? {reason: options.reason} : {}),
      ...(options.expectedRiderId ? {expectedRiderId: options.expectedRiderId} : {}),
    });
    return candidate ? stripPrivateOrderFields(candidate) : undefined;
  }, undefined, false);
  if (!result.committed) throw new DomainError("aborted", "Order changed; refresh and try again.");
  const order = stripPrivateOrderFields(result.snapshot.val() as SavrivoOrder);
  await Promise.all([
    reconcileRestaurantOrderProjection(order),
    db.ref(`${ROOT}/audit/${id}`).set({
      id,
      action: "order.transition",
      target: order.id,
      detail: `${before.status} -> ${toStatus}${options.detail ? ` · ${options.detail}` : ""}`.slice(0, 500),
      actorId,
      actorEmail: String(options.actorEmail ?? ""),
      actorRole,
      at: now,
    }),
  ]);
  await reconcileRestaurantWorkload(order);
  return order;
}

async function promoteReadyOrderToAssigned(before: SavrivoOrder): Promise<SavrivoOrder> {
  const riderId = String(before.riderId ?? "").trim();
  if (before.status !== "Ready for pickup" || !riderId) return before;
  try {
    return await commitAuthoritativeTransition({
      before,
      toStatus: "Assigned",
      actorId: "dispatch",
      actorRole: "system",
      detail: "Pre-assigned rider confirmed for pickup",
      expectedRiderId: riderId,
    });
  } catch (error) {
    // Two retries can observe the same interrupted Ready state. Only one may
    // write the system promotion; the loser reconciles the canonical winner
    // instead of adding a duplicate transition/audit event or surfacing an
    // erroneous failure to the restaurant.
    if (error instanceof DomainError && error.code === "aborted") {
      const latestValue = (
        await db.ref(pathFor.order(before.customerId, before.id)).get()
      ).val() as SavrivoOrder | null;
      if (latestValue) {
        const latest = stripPrivateOrderFields(latestValue);
        if (latest.status === "Assigned" && latest.riderId === riderId) return latest;
      }
    }
    throw error;
  }
}

export async function createAuthoritativeOrder(uid: string, input: CreateOrderInput): Promise<{
  order: SavrivoOrder;
  deliveryOtp: string;
  recovered: boolean;
}> {
  const orderId = deterministicOrderId(uid, input.idempotencyKey);
  const orderRef = db.ref(pathFor.order(uid, orderId));
  const existing = (await orderRef.get()).val() as SavrivoOrder | null;
  if (existing) {
    if (existing.customerId !== uid || existing.idempotencyKey !== input.idempotencyKey) {
      throw new DomainError("already-exists", "Order idempotency conflict.");
    }
    const deliveryOtp = await otpForExisting(existing);
    return {order: stripPrivateOrderFields(existing), deliveryOtp, recovered: true};
  }

  const [{restaurant, menuById}, {address, profile}] = await Promise.all([
    loadRestaurantAndMenu(input.restaurantId),
    loadCustomerAddress(uid, input.addressId),
  ]);
  const {items, subtotal} = priceCart(input.items, menuById);
  const [fees, discount] = await Promise.all([
    loadServerFees(restaurant, address, subtotal),
    calculateDiscount(input.couponCode, subtotal, restaurant.id),
  ]);
  const {pricing, total} = buildPricing({
    subtotal,
    discount,
    deliveryFee: fees.deliveryFee,
    platformFee: fees.platformFee,
    taxRate: fees.taxRate,
    tip: input.tip,
    smallOrderThreshold: fees.smallOrderThreshold,
    smallOrderFee: fees.smallOrderFee,
    lateNightFee: fees.lateNightFee,
    rainFee: fees.rainFee,
    surgeFee: fees.surgeFee,
    riderIncentiveFee: fees.riderIncentiveFee,
  });
  if (fees.riderIncentiveFee > 0) {
    logger.info("RIDER_INCENTIVE_FEE_APPLIED", {
      orderId, restaurantId: restaurant.id,
      amount: fees.riderIncentiveFee, campaignIds: fees.riderIncentiveCampaignIds,
    });
  }

  const now = Date.now();
  const financePolicy = await loadFinancePolicy(now);
  // Reserve the OTP before committing the canonical order. A process failure
  // can leave a harmless private reservation, but can never leave a live order
  // whose customer OTP is unrecoverable.
  const otpRecord = await reserveDeliveryOtp(uid, orderId);
  const deliveryOtp = String(otpRecord.otp);
  const event: StatusEvent = {status: "Order placed", at: now, actorId: uid, actorRole: "customer"};
  let payment: Pick<SavrivoOrder, "paymentMethod" | "paymentState" | "paymentProvider">;
  try {
    payment = paymentDetailsFromCreateInput(input, financePolicy);
  } catch (error) {
    throw paymentSelectionError(error) ?? error;
  }
  const orderBase: SavrivoOrder = {
    id: orderId,
    schemaVersion: SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    customerId: uid,
    customerName: (String(profile.name ?? "").trim() || "Savrivo customer").slice(0, 120),
    customerPhone: address.phone,
    restaurantId: restaurant.id,
    restaurant: restaurant.name,
    restaurantLocation: {address: restaurant.address, lat: Number(restaurant.lat), lng: Number(restaurant.lng)},
    ...(restaurant.phone ? {restaurantPhone: String(restaurant.phone).slice(0, 30)} : {}),
    items,
    pricing,
    pricingContext: {
      distanceKm: roundMoney(fees.distanceKm),
      platformFeeRule: "server_authoritative",
      weatherSeverity: fees.rainFee > 0 ? "verified_rain" : "",
      surgeActiveOrders: fees.activeOrders,
      pricedAt: now,
    },
    total,
    coupon: input.couponCode,
    paymentMethod: payment.paymentMethod,
    ...(payment.paymentProvider ? {paymentProvider: payment.paymentProvider} : {}),
    paymentState: payment.paymentState,
    deliveryMode: input.deliveryMode,
    address,
    instructions: input.instructions,
    contactless: input.contactless,
    status: "Order placed",
    statusHistory: {[eventKey(now, uid)]: event},
    createdAt: now,
    updatedAt: now,
    etaMin: Number(restaurant.etaMin),
    etaMax: Number(restaurant.etaMax),
  };
  const order: SavrivoOrder = {...orderBase, ...deriveLifecycleFromCanonicalState(orderBase)};

  const result = await orderRef.transaction((current) => current == null ? order : undefined, undefined, false);
  const committedOrder = result.snapshot.val() as SavrivoOrder;
  if (!result.committed) {
    if (committedOrder?.customerId !== uid || committedOrder?.idempotencyKey !== input.idempotencyKey) {
      throw new DomainError("aborted", "Another order operation won the transaction.");
    }
    const recoveredOtp = await otpForExisting(committedOrder);
    return {order: stripPrivateOrderFields(committedOrder), deliveryOtp: recoveredOtp, recovered: true};
  }

  await db.ref(ROOT).update({
    [`orderIdempotency/${uid}/${input.idempotencyKey}`]: {orderId, createdAt: now},
    [`private/deliveryOtps/${orderId}`]: otpRecord,
  });
  await Promise.all([
    reconcileRestaurantOrderProjection(order),
    reconcileRestaurantWorkload(order),
  ]);
  return {order, deliveryOtp, recovered: false};
}

export async function createAuthoritativeCodOrder(uid: string, input: CreateCodOrderInput): Promise<{
  order: SavrivoOrder;
  deliveryOtp: string;
  recovered: boolean;
}> {
  return createAuthoritativeOrder(uid, {
    ...input,
    paymentMethod: "cod",
  });
}

export async function transitionOrder(
  uid: string,
  token: DecodedIdToken,
  input: TransitionOrderInput,
): Promise<{order: SavrivoOrder; actorRole: ActorRole; idempotent: boolean}> {
  const ref = db.ref(pathFor.order(input.customerId, input.orderId));
  const before = (await ref.get()).val() as SavrivoOrder | null;
  if (!before) throw new DomainError("not-found", "Order not found.");
  if (input.toStatus === "Assigned") {
    throw new DomainError("failed-precondition", "Rider assignment must use the transactional dispatch claim.");
  }
  if (input.toStatus === "Handed to rider" && !before.riderId) {
    throw new DomainError("failed-precondition", "Assign a delivery partner before handover.");
  }
  if (requiresVerifiedOnlinePaymentBeforeProgress(before, input.toStatus)) {
    throw new DomainError(
      "failed-precondition",
      "Verified online payment is required before this order can progress.",
    );
  }
  const actorRole = await authorizeTransition(uid, token, before, input.toStatus);
  if (before.status === input.toStatus) {
    // Network retries and two restaurant devices may repeat the same decision.
    // Returning the committed server state is safe; writing another history
    // event would incorrectly turn a retry into a second transition.
    // Ready is the sole two-step restaurant transition: an interruption can
    // happen after Ready commits but before a previously reserved rider is
    // promoted to Assigned. Repair that missing system step on the retry.
    if (input.toStatus === "Ready for pickup" && before.riderId) {
      const order = await promoteReadyOrderToAssigned(before);
      return {order, actorRole, idempotent: true};
    }
    return {order: stripPrivateOrderFields(before), actorRole, idempotent: true};
  }
  // A lost response after the automatic promotion may retry the original
  // Ready request. Treat the already-promoted canonical result as the same
  // idempotent operation without writing any additional state or effects.
  if (input.toStatus === "Ready for pickup" && before.status === "Assigned" && before.riderId) {
    return {order: stripPrivateOrderFields(before), actorRole, idempotent: true};
  }
  if (!canTransition(before.status, input.toStatus, actorRole)) {
    throw new DomainError("failed-precondition", `Cannot change ${before.status} to ${input.toStatus}.`);
  }
  if (input.toStatus === "Cancelled" && !input.reason) {
    throw new DomainError("invalid-argument", "A cancellation reason is required.");
  }
  if (input.toStatus === "Handed to rider") {
    // The UI projection is advisory. Only the durable proof written by the
    // server-side GPS verifier can authorize physical handover.
    await requireVerifiedRiderRestaurantArrival(before);
  }
  if (input.toStatus === "Delivered") {
    if (actorRole !== "rider" || !input.deliveryOtp || !await verifyPrivateDeliveryOtp(before, input.deliveryOtp)) {
      throw new DomainError("permission-denied", "Delivery verification failed.");
    }
    if (before.paymentMethod === "cod" && input.cashCollected !== true) {
      throw new DomainError("failed-precondition", "Confirm exact COD collection before delivery completion.");
    }
  }

  let order = await commitAuthoritativeTransition({
    before,
    toStatus: input.toStatus,
    actorId: uid,
    actorRole,
    actorEmail: String(token.email ?? ""),
    ...(input.reason ? {reason: input.reason} : {}),
    ...(input.toStatus === "Delivered" ? {proof: "otp"} : {}),
  });
  // A rider may reserve the delivery while the kitchen is still preparing it.
  // Once staff marks that pre-assigned order ready, promote it immediately to
  // Assigned so the next restaurant action is an unambiguous handover.
  if (input.toStatus === "Ready for pickup" && order.riderId) {
    order = await promoteReadyOrderToAssigned(order);
  }
  return {order, actorRole, idempotent: false};
}

export async function transitionOrderFromTracking(
  customerId: string,
  orderId: string,
  riderId: string,
  target: ProximityStatus,
  evidenceEventId: string,
  distanceMeters: number,
): Promise<SavrivoOrder> {
  const before = (await db.ref(pathFor.order(customerId, orderId)).get()).val() as SavrivoOrder | null;
  if (!before || before.customerId !== customerId || before.id !== orderId) {
    throw new DomainError("not-found", "Order not found.");
  }
  if (before.riderId !== riderId || !canTransition(before.status, target, "system")) {
    throw new DomainError("failed-precondition", "Tracking evidence does not match an active assigned delivery.");
  }
  return commitAuthoritativeTransition({
    before,
    toStatus: target,
    actorId: riderId,
    actorRole: "system",
    proof: `tracking:${evidenceEventId}`.slice(0, 180),
    detail: `server geofence ${Math.round(distanceMeters)}m`,
    expectedRiderId: riderId,
  });
}

/**
 * A restaurant's own commission rate (set by an admin/owner on its catalog
 * record) overrides the platform-wide default for that restaurant only.
 * Restaurants without an explicit rate keep using the global policy exactly
 * as before this override existed.
 */
async function resolveRestaurantCommissionBps(order: SavrivoOrder, financePolicy: FinancePolicy): Promise<number> {
  const override = (await db.ref(`${pathFor.restaurant(order.restaurantId)}/commissionBps`).get()).val();
  return Number.isFinite(Number(override)) && Number(override) >= 0 && Number(override) <= 5_000
    ? Number(override)
    : financePolicy.restaurantCommissionBps;
}

export async function recordCodLedger(order: SavrivoOrder): Promise<void> {
  if (order.paymentMethod !== "cod" || order.status !== "Delivered" || !order.riderId) return;
  const financePolicy = await loadFinancePolicy();
  const commissionBps = await resolveRestaurantCommissionBps(order, financePolicy);
  // The immutable balanced journal is authoritative. The existing mutable
  // rider wallet remains only a backwards-compatible operational projection.
  await persistCodOrderDeliveryLedger(order, commissionBps);
  const ref = db.ref(`${ROOT}/riderWallets/${order.riderId}`);
  await ref.transaction((wallet: Record<string, unknown> | null) => {
    const current = wallet ?? {};
    const entries = (current.codEntries ?? {}) as Record<string, unknown>;
    if (entries[order.id]) return undefined;
    const nextOutstanding = roundMoney(Number(current.codOutstanding ?? 0) + order.total);
    const nextOutstandingPaise = Math.round(nextOutstanding * 100);
    const limitEnabled = financePolicy.codOutstandingLimitPaise > 0;
    return {
      ...current,
      codOutstanding: nextOutstanding,
      codOutstandingLimitPaise: financePolicy.codOutstandingLimitPaise,
      codBlocked: current.codBlocked === true ||
        (limitEnabled && nextOutstandingPaise >= financePolicy.codOutstandingLimitPaise),
      updatedAt: Date.now(),
      codEntries: {
        ...entries,
        [order.id]: {orderId: order.id, amount: order.total, status: "pending_return", collectedAt: order.deliveredAt ?? order.updatedAt},
      },
    };
  }, undefined, false);
}

/**
 * Releases verified online order funds at delivery. Unlike the COD
 * compatibility wallet projection, online settlement is represented only by
 * immutable balanced journals and fails closed without verified receipt
 * provenance.
 */
export async function recordOnlinePaymentLedger(order: SavrivoOrder): Promise<void> {
  if (order.paymentMethod === "cod" || order.status !== "Delivered" || !order.riderId) return;
  const financePolicy = await loadFinancePolicy();
  const commissionBps = await resolveRestaurantCommissionBps(order, financePolicy);
  await persistOnlineOrderDeliveryLedger(order, commissionBps);
}
