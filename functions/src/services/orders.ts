import {randomBytes, randomInt, timingSafeEqual} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db, firestoreDb} from "../admin";
import {ROOT, SCHEMA_VERSION} from "../config";
import {
  buildOrderTransitionCandidate,
  buildPricing,
  canTransition,
  deterministicOrderId,
  hashOtp,
  legacyOrderId,
  priceCart,
  roundMoney,
} from "../domain/order";
import {deliveryOtpRecoveryAllowed, legacyOtpVerifier, stripPrivateOrderFields} from "../domain/orderSecurity";
import {availabilityCityKey} from "../domain/dispatch";
import {countAvailableRiders, estimateDelivery} from "../domain/deliveryEstimate";
// Same staleness bar dispatch itself uses to decide a rider is really there,
// so the delivery estimate and the dispatcher never disagree about supply.
import {DEFAULT_DISPATCH_POLICY} from "../domain/dispatchPolicy";
import {buildLifecycleMutation, deriveLifecycle, deriveLifecycleFromCanonicalState} from "../domain/lifecycle";
import {
  resolveFinancePaymentSelection,
  type FinancePolicy,
} from "../domain/financePolicy";
import {partnerAtCampusNow} from "../domain/campus";
import {normalizeTrackingFix, trackingDistanceMeters, type ProximityStatus} from "../domain/tracking";
import {DomainError} from "../errors";
import type {TransactionLike} from "../firestoreTypes";
import {FieldValue} from "../firestoreTypes";
import {deliveryOtpRef, orderRef, restaurantRef, riderAvailabilityCollectionRef, riderWalletRef} from "../firestorePaths";
import type {CreateCodOrderInput, CreateOrderInput, TransitionOrderInput} from "./serviceTypes";
import type {ActorRole, OrderStatus, PricingBreakdown, SavrivoOrder, StatusEvent} from "../types";
import {authorizeTransition, requireApprovedRider} from "./authz";
import {deliveryCampusFor} from "./campus";
import {assertMayOrder} from "./accountAge";
import {loadCustomerAddress, loadRestaurantAndMenu, loadServerFees} from "./catalog";
import {loadPriceQuote} from "./priceQuotes";
import {
  checkoutTax,
  finalizeOrderEconomics,
  markupCheckoutBill,
  loadEconomicsControl,
  orderEconomicsRecord,
  orderEconomicsRef,
  planCheckoutEconomics,
  promotionReservationRefs,
  reservePromotionSpend,
  resolveCheckoutPromotion,
  checkoutLines,
  restaurantCommissionBps,
} from "./economics";
import {economicsScopeKey, rupeesToPaise, settlementTerms} from "../domain/economics";
import {isMarkupCart, markupCutPaise, markupFees, menuPricingOf, withoutCustomerTax} from "../domain/markupPricing";
import {planWalletRedemption, reserveWalletRedemption} from "./wallet";
import {reconcileRestaurantWorkload} from "./workload";
import {reconcileRestaurantOrderProjection} from "./orderProjection";
import {persistCodOrderDeliveryLedger} from "./ledger";
import {resolveDeliverySettlementOptions} from "./deliverySettlement";
import {persistOnlineOrderDeliveryLedger} from "./onlineDeliveryLedger";
import {loadFinancePolicy} from "./platformConfig";
import {lawBasedCheckoutTax} from "./taxEngine";
import {requireVerifiedRiderRestaurantArrival} from "./riderRestaurantArrival";
import {mediaFile} from "./mediaBucket";
import {adClickBefore, learnedEtaFor, writeAdConversion} from "./learning";
import {kitchenPrepMinutes} from "../domain/kitchenLate";

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
  const ref = deliveryOtpRef(firestoreDb, orderId);
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
  const record = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as PrivateOtpRecord : null;
    if (!current) {
      transaction.set(ref, candidate);
      return candidate;
    }
    if (current.customerId !== customerId) {
      throw new DomainError("already-exists", "Delivery verification reservation conflict.");
    }
    const currentOtp = String(current.otp ?? "");
    const currentSalt = String(current.salt ?? "");
    if (/^\d{4}$/.test(currentOtp) && /^[a-f0-9]{16,128}$/i.test(currentSalt)) {
      const next: PrivateOtpRecord = {
        ...current,
        otp: currentOtp,
        salt: currentSalt,
        verifier: hashOtp(currentOtp, currentSalt),
        updatedAt: Number(current.updatedAt ?? current.createdAt ?? now),
      };
      transaction.set(ref, next);
      return next;
    }
    // A verifier-only legacy migration cannot recover the customer's code.
    // Reissue it atomically and return the replacement to the same customer.
    transaction.set(ref, candidate);
    return candidate;
  });
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
    const privateRef = deliveryOtpRef(firestoreDb, order.id);
    const privateRecord = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const snapshot = await transaction.get(privateRef);
      const current = snapshot.exists ? snapshot.data() as PrivateOtpRecord : null;
      if (!current) {
        transaction.set(privateRef, migrated);
        return migrated;
      }
      if (current.customerId !== order.customerId) {
        throw new DomainError("failed-precondition", "Legacy delivery verification could not be migrated safely.");
      }
      if (/^[a-f0-9]{64}$/i.test(String(current.verifier ?? "")) && current.salt) return current;
      transaction.set(privateRef, migrated);
      return migrated;
    });
    if (!privateRecord || privateRecord.customerId !== order.customerId ||
      !/^[a-f0-9]{64}$/i.test(String(privateRecord.verifier ?? "")) || !privateRecord.salt) {
      throw new DomainError("failed-precondition", "Legacy delivery verification could not be migrated safely.");
    }
  }
  // `orders` is one flat collection (customerId/restaurantId are indexed
  // fields, not path segments) - clearing the fields on this single document
  // replaces what used to be a second fan-out clear on the `restaurantOrders`
  // denormalized copy.
  await orderRef(firestoreDb, order.id).update({
    deliveryOtp: FieldValue.delete(),
    deliveryOtpHash: FieldValue.delete(),
    deliveryOtpSalt: FieldValue.delete(),
    deliveryOtpVerifier: FieldValue.delete(),
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
  const snapshot = await orderRef(firestoreDb, orderId).get();
  const order = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
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
  const ref = deliveryOtpRef(firestoreDb, order.id);
  const snapshot = await ref.get();
  let record = snapshot.exists ? snapshot.data() as PrivateOtpRecord : null;
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
    record = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
      const current = await transaction.get(ref);
      if (current.exists) return current.data() as PrivateOtpRecord;
      transaction.set(ref, migrated);
      return migrated;
    });
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
  const ref = orderRef(firestoreDb, before.id);
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
  const order = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    const candidate = buildOrderTransitionCandidate(current, before, {
      toStatus,
      actorRole,
      eventId: id,
      event,
      now,
      ...(options.reason ? {reason: options.reason} : {}),
      ...(options.expectedRiderId ? {expectedRiderId: options.expectedRiderId} : {}),
    });
    if (!candidate) throw new DomainError("aborted", "Order changed; refresh and try again.");
    const stripped = stripPrivateOrderFields(candidate);
    transaction.set(ref, stripped);
    return stripped;
  });
  await Promise.all([
    reconcileRestaurantOrderProjection(order),
    firestoreDb.collection("audit").doc(id).set({
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
      const snapshot = await orderRef(firestoreDb, before.id).get();
      const latestValue = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
      if (latestValue) {
        const latest = stripPrivateOrderFields(latestValue);
        if (latest.status === "Assigned" && latest.riderId === riderId) return latest;
      }
    }
    throw error;
  }
}

/**
 * Preparing → Ready for pickup → Assigned for the rider standing at the
 * counter with the parcel, the same two steps "Order ready" would have taken.
 */
async function markReadyForRiderPickup(before: SavrivoOrder, riderId: string): Promise<SavrivoOrder> {
  const ready = before.status === "Preparing" ? await commitAuthoritativeTransition({
    before,
    toStatus: "Ready for pickup",
    // Not the rider's id: the pickup event right after it may land in the same
    // millisecond and the two would share a history key.
    actorId: "rider_pickup",
    actorRole: "system",
    detail: "Rider picked up before the kitchen tapped Order ready",
    expectedRiderId: riderId,
  }) : before;
  return promoteReadyOrderToAssigned(ready);
}

/** One restaurant's part of a multi-restaurant order (see services/clusterOrders.ts). */
export interface ClusterPartOptions {
  id: string;
  index: number;
  size: number;
  /** The platform fee is charged once per cart, on the first part. */
  waivePlatformFee: boolean;
  /** The small-order fee is judged on the whole cart, not on each restaurant's part. */
  waiveSmallOrderFee: boolean;
}

const ORDER_ID_ATTEMPTS = 5;

/**
 * The order number for this checkout and the order already placed with it,
 * if any. A checkout started before the switch to 15-digit numbers keeps its
 * SV- order on retry; a number another customer's order holds moves on to
 * the next one.
 */
export async function claimOrderId(uid: string, idempotencyKey: string): Promise<{orderId: string; existing: SavrivoOrder | null}> {
  const mine = (snapshot: {exists: boolean; data(): unknown}) => {
    const order = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    return order?.customerId === uid && order.idempotencyKey === idempotencyKey ? order : null;
  };
  const legacyId = legacyOrderId(uid, idempotencyKey);
  const [legacy, first] = await Promise.all([
    orderRef(firestoreDb, legacyId).get(),
    orderRef(firestoreDb, deterministicOrderId(uid, idempotencyKey)).get(),
  ]);
  const legacyOrder = mine(legacy);
  if (legacyOrder) return {orderId: legacyId, existing: legacyOrder};
  let snapshot = first;
  for (let attempt = 0; attempt < ORDER_ID_ATTEMPTS; attempt++) {
    const orderId = deterministicOrderId(uid, idempotencyKey, attempt);
    if (attempt > 0) snapshot = await orderRef(firestoreDb, orderId).get();
    if (!snapshot.exists) return {orderId, existing: null};
    const existing = mine(snapshot);
    if (existing) return {orderId, existing};
  }
  throw new DomainError("already-exists", "Order idempotency conflict.");
}

export async function createAuthoritativeOrder(uid: string, input: CreateOrderInput, options: {
  payerUid?: string;
  cluster?: ClusterPartOptions;
  /** Meal plans place orders on a schedule; group orders check every store before their first part. */
  skipDeliveryPartnerCheck?: boolean;
} = {}): Promise<{
  order: SavrivoOrder;
  deliveryOtp: string;
  recovered: boolean;
}> {
  const {orderId, existing} = await claimOrderId(uid, input.idempotencyKey);
  const ref = orderRef(firestoreDb, orderId);
  if (existing) {
    const deliveryOtp = await otpForExisting(existing);
    return {order: stripPrivateOrderFields(existing), deliveryOtp, recovered: true};
  }

  // Under-18 accounts order only after a parent approves (DPDP Act 2023, s.9).
  await assertMayOrder(uid);
  const [{restaurant, menuById}, {address, profile}] = await Promise.all([
    loadRestaurantAndMenu(input.restaurantId),
    loadCustomerAddress(uid, input.addressId),
  ]);
  // No free delivery partner near the store: nothing is written and no payment starts.
  // Loaded on use (like adminToday.ts): dispatch brings rider-side modules order code otherwise never needs.
  if (!options.skipDeliveryPartnerCheck && !options.cluster) await (await import("./dispatch")).assertDeliveryPartnerFreeNear(restaurant);
  const {items, subtotal, markup} = priceCart(input.items, menuById, menuPricingOf(restaurant));
  const pricedAt = Date.now();
  const [loadedFees, promotion, economicsControl, availableRiders] = await Promise.all([
    // Markup restaurants: fee rules see the food total the customer saw (GST included).
    loadServerFees(restaurant, address, markup?.listSubtotal ?? subtotal).then((value) => markupFees(value, markup)),
    resolveCheckoutPromotion(input.couponCode, {
      subtotalPaise: rupeesToPaise(subtotal),
      restaurantId: restaurant.id,
      cityKey: economicsScopeKey(restaurant.city),
      customerId: uid,
      at: pricedAt,
      lines: checkoutLines(items),
      deliveryArea: address.area,
    }),
    loadEconomicsControl(pricedAt),
    // Rider supply feeds the delivery estimate only. A read failure must never
    // block an order, so it degrades to "unknown" - which the estimator treats
    // as unknown rather than as zero riders.
    riderAvailabilityCollectionRef(firestoreDb)
      .where("cityKey", "==", availabilityCityKey(restaurant.city))
      .limit(500).get()
      .then((snapshot) => countAvailableRiders(
        Object.fromEntries(snapshot.docs.map((doc) => [doc.id, doc.data()])),
        Date.now(),
        DEFAULT_DISPATCH_POLICY.presenceFreshMs,
      ))
      .catch((error) => {
        logger.warn("DELIVERY_ESTIMATE_RIDER_SUPPLY_READ_FAILED", {restaurantId: restaurant.id, error});
        return null;
      }),
  ]);
  const cluster = options.cluster;
  // The fees the customer was shown, when that is the total they tapped on. Fresh fees still ran above,
  // because they also enforce the minimum order and the delivery radius. An order from several
  // restaurants has no single total to compare, so each part takes its own quote.
  const quote = input.quotedTotal !== undefined || cluster ? await loadPriceQuote<typeof loadedFees>(uid, {
    restaurantId: input.restaurantId,
    addressId: input.addressId,
    lat: address.lat,
    lng: address.lng,
    items: input.items,
  }, pricedAt) : null;
  const shownFees = quote && (cluster || rupeesToPaise(quote.total) === rupeesToPaise(input.quotedTotal)) ?
    {...loadedFees, ...quote.fees} : loadedFees;
  const fees = cluster ? {
    ...shownFees,
    ...(cluster.waivePlatformFee ? {platformFee: 0} : {}),
    ...(cluster.waiveSmallOrderFee ? {smallOrderFee: 0} : {}),
  } : shownFees;
  let payment: Pick<SavrivoOrder, "paymentMethod" | "paymentState" | "paymentProvider">;
  const financePolicy = await loadFinancePolicy(pricedAt);
  try {
    payment = paymentDetailsFromCreateInput(input, financePolicy);
  } catch (error) {
    throw paymentSelectionError(error) ?? error;
  }
  // Who pays for the discount, and how much Scraveit can safely fund, is
  // decided once here - the same plan the checkout preview showed.
  const economicsPlan = planCheckoutEconomics({
    control: economicsControl,
    restaurant,
    address,
    subtotal,
    fees,
    paymentMethod: payment.paymentMethod,
    tip: input.tip,
    promotion,
    defaultCommissionBps: financePolicy.restaurantCommissionBps,
    now: pricedAt,
    ...(isMarkupCart(markup) ? {markupCutPaise: markupCutPaise(rupeesToPaise(subtotal), markup)} : {}),
  });
  const discount = (economicsPlan.discount.restaurantDiscountPaise + economicsPlan.discount.platformDiscountPaise) / 100;
  // CA-defined component tax rules replace the flat food tax only once a
  // version in component_rules mode is in force (see domain/taxRules.ts).
  let tax = checkoutTax(economicsControl, economicsPlan, fees, subtotal, pricedAt);
  // Effective-dated tax law (services/taxEngine.ts) replaces it once switched on.
  const lawTax = await lawBasedCheckoutTax({restaurant, items, menuById, plan: economicsPlan, fees, subtotal, at: pricedAt});
  if (lawTax?.tax) tax = lawTax.tax;
  // Markup restaurants: food GST is inside the customer's prices, not added on top.
  const markupPricing = markup ? markupCheckoutBill(markup, {
    subtotal, plan: economicsPlan, tax, orderTax: lawTax?.tax ? lawTax.orderTax : null,
  }) : null;
  const feeInput = {
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
    riderSurgeFee: fees.riderSurgeFee,
    ...(markupPricing ? {taxOverride: markupPricing.customerTaxPaise / 100} :
      tax ? {taxOverride: tax.customerTaxPaise / 100} : {}),
  };
  // Wallet money (cashback / referral credit) is a way of paying, used only
  // when the customer asked and only up to the wallet rules for this order.
  const walletPlan = economicsPlan.engineEnabled && input.useWallet ? await planWalletRedemption({
    customerId: uid,
    rules: economicsControl.walletRules,
    subtotalPaise: rupeesToPaise(subtotal),
    payableBeforeWalletPaise: rupeesToPaise(buildPricing(feeInput).total),
    at: pricedAt,
    requested: true,
  }) : null;
  const walletRedeemPaise = walletPlan?.amountPaise ?? 0;
  const {pricing: basePricing, total} = buildPricing({
    ...feeInput,
    ...(walletRedeemPaise > 0 ? {walletRedeem: walletRedeemPaise / 100} : {}),
  });
  // The customer pays what was on the screen, or no order is made and the app shows them the new total.
  if (input.quotedTotal !== undefined && rupeesToPaise(total) !== rupeesToPaise(input.quotedTotal)) {
    logger.info("ORDER_PRICE_CHANGED", {orderId, restaurantId: restaurant.id, shown: input.quotedTotal, total, quoted: quote !== null});
    throw new DomainError("failed-precondition", `PRICE_CHANGED:${total}`);
  }
  // Saved with the order so its bill names each charge the way checkout did.
  const incentiveItems = [
    ...fees.riderIncentiveItems,
    ...(fees.riderSurgeFee > 0 ? [{label: "Rider surge fee", amount: fees.riderSurgeFee}] : []),
  ];
  const labelledPricing: PricingBreakdown = {
    ...basePricing,
    ...(incentiveItems.length ? {riderIncentiveItems: incentiveItems} : {}),
    ...(markupPricing ? {markup: withoutCustomerTax(markupPricing)} : {}),
  };
  const pricing: PricingBreakdown = economicsPlan.engineEnabled ? {
    ...labelledPricing,
    restaurantDiscount: economicsPlan.discount.restaurantDiscountPaise / 100,
    platformDiscount: economicsPlan.discount.platformDiscountPaise / 100,
  } : labelledPricing;
  const economics = economicsPlan.engineEnabled ? finalizeOrderEconomics(
    economicsPlan,
    pricing,
    total,
    restaurant.id,
    payment.paymentMethod,
    [...(fees.riderIncentiveCampaignIds ?? []).map((id) => `rider_campaign:${id}`), ...fees.pricingScopes.map((scope) => `pricing:${scope}`)],
    tax ? {commissionTaxPaise: tax.restaurantTaxPaise, taxVersionId: tax.versionId} : {},
  ) : undefined;
  if (fees.riderIncentiveFee > 0) {
    logger.info("RIDER_INCENTIVE_FEE_APPLIED", {
      orderId, restaurantId: restaurant.id,
      amount: fees.riderIncentiveFee, campaignIds: fees.riderIncentiveCampaignIds,
    });
  }
  if (economics) {
    logger.info("ORDER_ECONOMICS_PRICED", {
      orderId,
      cityKey: economics.cityKey,
      payablePaise: economics.customer.payablePaise,
      restaurantReceivablePaise: economics.restaurant.receivablePaise,
      riderPayPaise: economics.rider.totalPaise,
      contributionPaise: economics.platform.contributionPaise,
      verdict: economics.guardrail.verdict,
      offer: economicsPlan.offer?.code ?? "",
      withheldPlatformPaise: economicsPlan.discount.withheldPlatformPaise,
      policyScopes: economics.policyScopes.join(","),
    });
  }

  const now = pricedAt;
  // Learned prep and ride times (only once they beat the rules), and whether a tap on this store's Ad brought the order.
  const [learnedEta, adClickAt] = await Promise.all([
    learnedEtaFor({
      restaurant,
      items: items.reduce((sum, item) => sum + item.quantity, 0),
      customer: Number.isFinite(Number(address.lat)) && Number.isFinite(Number(address.lng)) ? {lat: Number(address.lat), lng: Number(address.lng)} : null,
      at: now,
    }).catch((error) => {
      logger.warn("LEARNED_ETA_FAILED", {orderId, error: String(error)});
      return null;
    }),
    adClickBefore(uid, restaurant.id, now),
  ]);
  const deliveryEstimate = estimateDelivery({
    kitchenEtaMinMinutes: restaurant.etaMin,
    kitchenEtaMaxMinutes: restaurant.etaMax,
    distanceKm: fees.distanceKm,
    activeOrders: fees.activeOrders,
    availableRiders,
    occurredAt: now,
    learned: learnedEta,
    kitchenTimerMinutes: kitchenPrepMinutes({items} as Parameters<typeof kitchenPrepMinutes>[0]),
  });
  // Reserve the OTP before committing the canonical order. A process failure
  // can leave a harmless private reservation, but can never leave a live order
  // whose customer OTP is unrecoverable.
  const otpRecord = await reserveDeliveryOtp(uid, orderId);
  const deliveryOtp = String(otpRecord.otp);
  const event: StatusEvent = {status: "Order placed", at: now, actorId: uid, actorRole: "customer"};
  const orderBase: SavrivoOrder = {
    id: orderId,
    schemaVersion: SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    customerId: uid,
    customerName: (String(profile.name ?? "").trim() || "Scraveit customer").slice(0, 120),
    customerPhone: address.phone,
    // A parent paying for their child's order ("Ask a parent to pay").
    ...(options.payerUid && options.payerUid !== uid ? {payerUid: options.payerUid} : {}),
    restaurantId: restaurant.id,
    restaurant: restaurant.name,
    restaurantLocation: {address: restaurant.address, lat: Number(restaurant.lat), lng: Number(restaurant.lng)},
    // Fixed at checkout: whether this store delivers the order itself (see assignStoreAsRider).
    ...((restaurant as {selfDelivery?: unknown}).selfDelivery === true ? {selfDelivery: true} : {}),
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
    etaMin: deliveryEstimate.etaMinMinutes,
    etaMax: deliveryEstimate.etaMaxMinutes,
    etaConfidence: deliveryEstimate.confidence,
    // Kept so a late delivery can be explained after the fact, and so the
    // promise can be scored against the actual time once enough have landed.
    etaBasis: deliveryEstimate.basis,
    ...(economics ? {economics: settlementTerms(economics)} : {}),
    ...(economicsPlan.offer ? {appliedOffer: economicsPlan.offer} : {}),
    ...(cluster ? {clusterId: cluster.id, clusterIndex: cluster.index, clusterSize: cluster.size, clusterHold: true} : {}),
    ...(adClickAt ? {adClickAt} : {}),
  };
  const order: SavrivoOrder = {...orderBase, ...deriveLifecycleFromCanonicalState(orderBase)};

  let created = false;
  const reservationRefs = economicsPlan.engineEnabled ?
    promotionReservationRefs(firestoreDb, orderId, uid, economicsPlan.offer, promotion?.terms ?? null) : null;
  const committedOrder = await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists) return snapshot.data() as SavrivoOrder;
    // Offer budgets and per-customer limits are reserved in the same
    // transaction as the order itself, so neither can exist without the other.
    const writeReservation = reservationRefs && economicsPlan.offer && promotion ?
      await reservePromotionSpend(transaction, reservationRefs, {
        orderId,
        customerId: uid,
        offer: economicsPlan.offer,
        terms: promotion.terms,
        cityKey: economicsPlan.cityKey,
        at: now,
      }) : null;
    transaction.set(ref, order);
    // The store's Ad gets the credit in the same transaction, so a counted order always exists.
    if (adClickAt) writeAdConversion(transaction, order, adClickAt, markup?.listSubtotal ?? subtotal);
    const writeWallet = walletRedeemPaise > 0 ?
      await reserveWalletRedemption(transaction, {customerId: uid, orderId, amountPaise: walletRedeemPaise, at: now}) : null;
    if (economics) {
      transaction.set(orderEconomicsRef(firestoreDb, orderId), orderEconomicsRecord(order, economics, {
        tripPayPolicy: economicsPlan.tripPayPolicy,
        distanceMeters: Math.round(fees.distanceKm * 1_000),
        taxLines: tax?.lines ?? [],
        ...(lawTax ? {orderTax: lawTax.orderTax} : {}),
      }));
    }
    writeReservation?.();
    writeWallet?.();
    created = true;
    return order;
  });
  if (!created) {
    if (committedOrder?.customerId !== uid || committedOrder?.idempotencyKey !== input.idempotencyKey) {
      throw new DomainError("aborted", "Another order operation won the transaction.");
    }
    const recoveredOtp = await otpForExisting(committedOrder);
    return {order: stripPrivateOrderFields(committedOrder), deliveryOtp: recoveredOtp, recovered: true};
  }

  // `reserveDeliveryOtp` already persisted this record durably above; only
  // the idempotency marker is new state to write here.
  await firestoreDb.collection("orderIdempotency").doc(`${uid}_${input.idempotencyKey}`)
    .set({orderId, createdAt: now});
  // A multi-restaurant part stays invisible to its restaurant until the whole cart is released.
  if (!order.clusterHold) {
    await Promise.all([
      reconcileRestaurantOrderProjection(order),
      reconcileRestaurantWorkload(order),
    ]);
  }
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

const PICKUP_PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PICKUP_PHOTO_LINK_MS = 7 * 24 * 60 * 60 * 1000;

async function authorizeRiderPickup(uid: string, order: SavrivoOrder): Promise<ActorRole> {
  if (order.riderId !== uid || isStoreDelivery(order)) {
    throw new DomainError("permission-denied", "Only the delivery partner on this order can pick it up.");
  }
  await requireApprovedRider(uid);
  return "rider";
}

export function pickupPhotoPathOk(path: string, uid: string, orderId: string): boolean {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "");
  if (!uid || !orderId || safe(uid) !== uid || safe(orderId) !== orderId) return false;
  return new RegExp(`^private/rider-pickups/${uid}/${orderId}-[0-9]{10,16}\\.jpg$`).test(path);
}

/**
 * The rider's photo of the parcel with the order ID showing, taken with the
 * camera at pickup. It stays private; the order keeps a 7-day link to it for
 * support if anything goes missing.
 */
async function verifyPickupPhoto(order: SavrivoOrder, uid: string, path: string | undefined) {
  if (!path || !pickupPhotoPathOk(path, uid, order.id)) {
    throw new DomainError("invalid-argument", "That photo can't be used for this order.");
  }
  const file = await mediaFile(path);
  const [exists] = await file.exists();
  if (!exists) throw new DomainError("failed-precondition", "The photo didn't finish uploading. Take it again.");
  const [meta] = await file.getMetadata();
  if (Number(meta.size ?? 0) > PICKUP_PHOTO_MAX_BYTES || !String(meta.contentType ?? "").startsWith("image/")) {
    throw new DomainError("invalid-argument", "That file isn't a photo we can use.");
  }
  const at = Date.now(), expiresAt = at + PICKUP_PHOTO_LINK_MS;
  const [url] = await file.getSignedUrl({version: "v4", action: "read", expires: expiresAt});
  return {url, at, expiresAt, by: uid, path};
}

export async function transitionOrder(
  uid: string,
  token: DecodedIdToken,
  input: TransitionOrderInput,
): Promise<{order: SavrivoOrder; actorRole: ActorRole; idempotent: boolean}> {
  const snapshot = await orderRef(firestoreDb, input.orderId).get();
  const before = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
  if (!before || before.customerId !== input.customerId) throw new DomainError("not-found", "Order not found.");
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
  // Campus orders: the partner's own "I'm at the delivery location" swipe.
  if (input.toStatus === "Arrived" && before.riderId === uid) {
    if (before.status === "Arrived") return {order: stripPrivateOrderFields(before), actorRole: "rider", idempotent: true};
    return {order: await arriveAtCampusOnSwipe(before, uid), actorRole: "rider", idempotent: false};
  }
  // The rider picks up with a photo of the parcel showing the order ID, so the
  // restaurant has nothing to tap. Without a photo the old staff handover runs.
  const riderPickup = input.toStatus === "Handed to rider" && input.pickupPhotoPath !== undefined;
  const actorRole = riderPickup ? await authorizeRiderPickup(uid, before) :
    await authorizeTransition(uid, token, before, input.toStatus);
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
  // Kitchens often skip "Order ready" in a rush. A rider holding the parcel at
  // the restaurant is proof it is ready, so the photo pickup marks it first.
  const pickupBeforeReady = riderPickup && (before.status === "Preparing" || before.status === "Ready for pickup");
  if (!pickupBeforeReady && !canTransition(before.status, input.toStatus, actorRole)) {
    throw new DomainError("failed-precondition", `Cannot change ${before.status} to ${input.toStatus}.`);
  }
  if (input.toStatus === "Cancelled" && !input.reason) {
    throw new DomainError("invalid-argument", "A cancellation reason is required.");
  }
  if (input.toStatus === "Handed to rider" && !isStoreDelivery(before)) {
    // The UI projection is advisory. Only the durable proof written by the
    // server-side GPS verifier can authorize physical handover.
    await requireVerifiedRiderRestaurantArrival(before);
  }
  const pickupPhoto = riderPickup ? await verifyPickupPhoto(before, uid, input.pickupPhotoPath) : null;
  if (input.toStatus === "Delivered") {
    if (actorRole !== "rider" || !input.deliveryOtp || !await verifyPrivateDeliveryOtp(before, input.deliveryOtp)) {
      throw new DomainError("permission-denied", "Delivery verification failed.");
    }
    if (before.paymentMethod === "cod" && input.cashCollected !== true) {
      throw new DomainError("failed-precondition", "Confirm exact COD collection before delivery completion.");
    }
  }

  const from = pickupBeforeReady ? await markReadyForRiderPickup(before, uid) : before;
  let order = await commitAuthoritativeTransition({
    before: from,
    toStatus: input.toStatus,
    actorId: uid,
    actorRole,
    actorEmail: String(token.email ?? ""),
    ...(input.reason ? {reason: input.reason} : {}),
    ...(input.toStatus === "Delivered" ? {proof: "otp"} : {}),
    ...(riderPickup ? {proof: "parcel_photo", expectedRiderId: uid} : {}),
  });
  if (pickupPhoto) await orderRef(firestoreDb, before.id).set({pickupPhoto}, {merge: true});
  // A rider may reserve the delivery while the kitchen is still preparing it.
  // Once staff marks that pre-assigned order ready, promote it immediately to
  // Assigned so the next restaurant action is an unambiguous handover.
  if (input.toStatus === "Ready for pickup" && order.riderId) {
    order = await promoteReadyOrderToAssigned(order);
  }
  // A self-delivering store's "handover" is the owner leaving with the food.
  if (input.toStatus === "Handed to rider" && isStoreDelivery(order)) {
    order = await commitAuthoritativeTransition({
      before: order,
      toStatus: "Out for delivery",
      actorId: String(order.riderId),
      actorRole: "rider",
      detail: "Store left to deliver its own order",
      expectedRiderId: String(order.riderId),
    });
  }
  return {order, actorRole, idempotent: false};
}

/**
 * The customer said "cancel" on the COD confirmation call. Only an order the
 * kitchen hasn't started (placed or just accepted) is cancelled; anything
 * further along is left for a person to sort out. Returns whether it cancelled.
 */
export async function cancelOrderFromConfirmationCall(orderId: string, callId: string): Promise<boolean> {
  const snapshot = await orderRef(firestoreDb, orderId).get();
  const before = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
  if (!before || before.paymentMethod !== "cod" || !["Order placed", "Accepted"].includes(before.status)) return false;
  await commitAuthoritativeTransition({
    before,
    toStatus: "Cancelled",
    actorId: "voice-agent",
    actorRole: "system",
    reason: "Customer cancelled on the order confirmation call",
    detail: `confirmation call ${callId}`,
  });
  return true;
}

/**
 * The customer gave up on paying online (to place it as cash on delivery, or
 * not at all). Only their own unpaid online order that nobody has accepted is
 * cancelled, and only after closePayments made sure no money can still land.
 */
export async function cancelUnpaidOnlineOrder(
  uid: string,
  orderId: string,
  reason: string,
  closePayments: (orderId: string) => Promise<void>,
): Promise<SavrivoOrder> {
  const snapshot = await orderRef(firestoreDb, orderId).get();
  const before = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
  if (!before || before.customerId !== uid) throw new DomainError("not-found", "Order not found.");
  if (before.status === "Cancelled") return stripPrivateOrderFields(before);
  if (before.paymentState === "paid") throw new DomainError("already-exists", "Your payment was received. Your order will confirm in a moment.");
  if (!requiresVerifiedOnlinePaymentBeforeProgress(before, "Accepted") || before.status !== "Order placed") {
    throw new DomainError("failed-precondition", "This order can't be cancelled here.");
  }
  await closePayments(before.id);
  return commitAuthoritativeTransition({
    before,
    toStatus: "Cancelled",
    actorId: uid,
    actorRole: "system",
    reason,
    detail: "online payment not completed",
  });
}

/**
 * A campus stops delivery partners at the gate, and the customer is often
 * already standing there. Waiting 3 minutes (domain/campus.ts) would hold up
 * a handover that is ready now. So for a campus order the partner's swipe
 * opens the delivery code box at once, when our own GPS record puts them at
 * that campus. Everywhere else, and for every other order, the swipe changes
 * nothing: only the 100 m check at the pin can mark arrival. The customer's
 * code is still what completes the delivery.
 */
async function arriveAtCampusOnSwipe(before: SavrivoOrder, riderId: string): Promise<SavrivoOrder> {
  const notThere = new DomainError("failed-precondition", "Go to the customer's location pin and swipe again.");
  if (before.status !== "Out for delivery" && before.status !== "Near you") throw notThere;
  await requireApprovedRider(riderId);
  const [campus, snapshot] = await Promise.all([
    deliveryCampusFor(before.id),
    db.ref(`${ROOT}/tracking/${before.id}`).get(),
  ]);
  const fix = campus ? normalizeTrackingFix(snapshot.val(), before.id) : null;
  if (!campus || !fix || fix.riderId !== riderId || fix.customerId !== before.customerId ||
    !partnerAtCampusNow(fix, campus, Date.now())) throw notThere;
  const distance = trackingDistanceMeters(fix, {lat: Number(before.address?.lat), lng: Number(before.address?.lng)});
  return commitAuthoritativeTransition({
    before,
    toStatus: "Arrived",
    actorId: riderId,
    actorRole: "system",
    // "campus:" also words the customer's message as "at the gate" (services/notifications.ts).
    proof: `campus:swipe:${fix.updatedAt}`.slice(0, 180),
    detail: `partner swiped at campus ${Math.round(distance)}m from pin`,
    expectedRiderId: riderId,
  });
}

export async function transitionOrderFromTracking(
  customerId: string,
  orderId: string,
  riderId: string,
  target: ProximityStatus,
  evidenceEventId: string,
  distanceMeters: number,
  campusWait = false,
): Promise<SavrivoOrder> {
  const snapshot = await orderRef(firestoreDb, orderId).get();
  const before = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
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
    // "campus:" = the partner waited 3 minutes at the customer's campus (gate) instead of reaching the pin.
    proof: `${campusWait ? "campus" : "tracking"}:${evidenceEventId}`.slice(0, 180),
    detail: campusWait ? `waited at campus ${Math.round(distanceMeters)}m from pin` : `server geofence ${Math.round(distanceMeters)}m`,
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
  const snapshot = await restaurantRef(firestoreDb, order.restaurantId).get();
  // The same rule checkout uses, so the locked order terms and the ledger agree.
  return restaurantCommissionBps((snapshot.exists ? snapshot.data() : {}) as {commissionBps?: number},
    financePolicy.restaurantCommissionBps);
}

export async function recordCodLedger(order: SavrivoOrder): Promise<void> {
  if (order.paymentMethod !== "cod" || order.status !== "Delivered" || !order.riderId) return;
  const financePolicy = await loadFinancePolicy();
  const commissionBps = await resolveRestaurantCommissionBps(order, financePolicy);
  // The immutable balanced journal is authoritative. The existing mutable
  // rider wallet remains only a backwards-compatible operational projection.
  await persistCodOrderDeliveryLedger(order, commissionBps, await resolveDeliverySettlementOptions(order));
  const ref = riderWalletRef(firestoreDb, order.riderId);
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = (snapshot.exists ? snapshot.data() : {}) as Record<string, unknown>;
    const entries = (current.codEntries ?? {}) as Record<string, unknown>;
    if (entries[order.id]) return;
    const nextOutstanding = roundMoney(Number(current.codOutstanding ?? 0) + order.total);
    const nextOutstandingPaise = Math.round(nextOutstanding * 100);
    const limitEnabled = financePolicy.codOutstandingLimitPaise > 0;
    transaction.set(ref, {
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
    });
  });
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
  await persistOnlineOrderDeliveryLedger(order, commissionBps, undefined, await resolveDeliverySettlementOptions(order));
}

// ---------------------------------------------------------------------------
// Store self-delivery: a store marked `selfDelivery` delivers its own orders.
// The store stands in as the order's rider ("store_<restaurantId>"), so the
// released Restaurant app's existing buttons drive it: "Chat rider" holds the
// customer's address and the delivery pay, "Confirm handover" means the owner
// has left, and typing the customer's delivery code in that chat completes it.
// At delivery the rider's share is credited to the store's payout instead.

const STORE_RIDER_PREFIX = "store_";
const STORE_DELIVERY_ASSIGNABLE = new Set<OrderStatus>(["Accepted", "Preparing", "Ready for pickup"]);
const STORE_DELIVERY_ON_THE_WAY = new Set<OrderStatus>(["Handed to rider", "Out for delivery", "Near you", "Arrived"]);

export function storeRiderId(restaurantId: string): string {
  return `${STORE_RIDER_PREFIX}${restaurantId}`;
}

export function isStoreDelivery(order: Pick<SavrivoOrder, "selfDelivery" | "riderId" | "restaurantId">): boolean {
  return order.selfDelivery === true;
}

function paiseText(paise: number): string {
  return `₹${Math.round(paise) / 100}`;
}

/** The rider's share for this order (trip pay plus any rain or surge share, and the tip). */
export function storeDeliveryPayPaise(order: SavrivoOrder): {payPaise: number; tipPaise: number} {
  const rider = order.economics?.rider;
  const payPaise = Number(rider?.deliveryPayPaise ?? 0) + Number(rider?.feeSharePaise ?? 0);
  const tipPaise = Number(order.economics?.customer.tipPaise ?? 0);
  return {payPaise: Number.isFinite(payPaise) ? payPaise : 0, tipPaise: Number.isFinite(tipPaise) ? tipPaise : 0};
}

export function storeDeliveryNote(order: SavrivoOrder): string {
  const address = order.address;
  const where = [address.house, address.street || address.address, address.area].filter((part) => String(part ?? "").trim()).join(", ");
  const {payPaise, tipPaise} = storeDeliveryPayPaise(order);
  return [
    "You deliver this order.",
    `Customer: ${order.customerName}`,
    `Phone: ${order.customerPhone || address.phone || "not given"}`,
    `Address: ${where}`,
    ...(address.landmark ? [`Landmark: ${address.landmark}`] : []),
    ...(address.details ? [`Note: ${address.details}`] : []),
    ...(order.instructions ? [`Delivery instructions: ${order.instructions}`] : []),
    `Map: https://maps.google.com/?q=${address.lat},${address.lng}`,
    ...(address.photoUrl ? [`Photo of the place: ${address.photoUrl}`] : []),
    `Your delivery pay: ${paiseText(payPaise)}${tipPaise > 0 ? ` + ${paiseText(tipPaise)} tip` : ""}, added to your payout.`,
    "Tap \"Confirm handover\" when you leave. At the door, ask the customer for the 4-digit delivery code in their app and type it here to finish the order.",
  ].join("\n");
}

/** Posts a Scraveit message into the store-and-rider chat, which the customer can't see. */
export async function postStoreDeliveryMessage(order: SavrivoOrder, body: string): Promise<void> {
  const at = Date.now();
  const id = `m_scraveit_${at}_${randomInt(1_000_000)}`;
  await firestoreDb.collection("orderChats").doc(`${order.id}_restaurantRider_${id}`).set({
    id,
    orderId: order.id,
    customerId: order.customerId,
    restaurantId: order.restaurantId,
    riderId: String(order.riderId ?? ""),
    channel: "restaurantRider",
    senderId: "scraveit",
    senderRole: "Scraveit",
    body: body.slice(0, 1_500),
    masked: false,
    at,
  });
}

/**
 * Accepting a self-delivery order takes the delivery for the store itself
 * instead of searching for a rider. Idempotent: an order that already has a
 * rider (or isn't a self-delivery order) is returned unchanged.
 */
export async function assignStoreAsRider(order: SavrivoOrder): Promise<SavrivoOrder> {
  if (!isStoreDelivery(order) || order.riderId || !STORE_DELIVERY_ASSIGNABLE.has(order.status)) return order;
  const ref = orderRef(firestoreDb, order.id);
  const riderId = storeRiderId(order.restaurantId);
  const now = Date.now();
  let assigned: SavrivoOrder | null = null;
  await firestoreDb.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
    if (!current || current.riderId || !isStoreDelivery(current) || !STORE_DELIVERY_ASSIGNABLE.has(current.status)) return;
    const candidate: SavrivoOrder = {
      ...current,
      riderId,
      riderName: current.restaurant,
      ...(current.restaurantPhone ? {riderPhone: current.restaurantPhone} : {}),
      riderAssignedAt: now,
      updatedAt: now,
    };
    const lifecycle = buildLifecycleMutation(deriveLifecycle(current), deriveLifecycleFromCanonicalState(candidate), now);
    assigned = {...candidate, ...lifecycle.patch};
    transaction.set(ref, assigned);
  });
  if (!assigned) {
    const latest = await ref.get();
    return latest.exists ? stripPrivateOrderFields(latest.data() as SavrivoOrder) : order;
  }
  let result = stripPrivateOrderFields(assigned);
  await postStoreDeliveryMessage(result, storeDeliveryNote(assigned))
    .catch((error) => logger.warn("STORE_DELIVERY_NOTE_FAILED", {orderId: order.id, error: String(error)}));
  logger.info("STORE_DELIVERY_ASSIGNED", {orderId: order.id, restaurantId: order.restaurantId});
  if (result.status === "Ready for pickup") result = await promoteReadyOrderToAssigned(result);
  return result;
}

/**
 * The store typed a message in its order chat. If the order is out with the
 * store and the message holds the customer's delivery code, the order is
 * delivered (with the code as proof, exactly as a rider's delivery).
 */
export async function completeStoreDeliveryFromChat(message: {
  orderId?: unknown; senderRole?: unknown; body?: unknown;
}): Promise<"delivered" | "wrong_code" | "ignored"> {
  if (message.senderRole !== "restaurant") return "ignored";
  const code = String(message.body ?? "").match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1];
  if (!code) return "ignored";
  const snapshot = await orderRef(firestoreDb, String(message.orderId ?? "")).get();
  let order = snapshot.exists ? snapshot.data() as SavrivoOrder : null;
  if (!order || !isStoreDelivery(order) || !order.riderId || !STORE_DELIVERY_ON_THE_WAY.has(order.status)) return "ignored";
  if (!await verifyPrivateDeliveryOtp(order, code)) {
    await postStoreDeliveryMessage(order, "That code didn't match. Ask the customer for the 4-digit delivery code shown in their Scraveit app.");
    return "wrong_code";
  }
  const riderId = order.riderId;
  const step = async (toStatus: OrderStatus, actorRole: ActorRole, proof?: string): Promise<void> => {
    order = await commitAuthoritativeTransition({
      before: order!,
      toStatus,
      actorId: actorRole === "system" ? "store-delivery" : riderId,
      actorRole,
      detail: "Store delivered its own order",
      expectedRiderId: riderId,
      ...(proof ? {proof} : {}),
    });
  };
  if (order.status === "Handed to rider") await step("Out for delivery", "rider");
  if (order.status === "Out for delivery" || order.status === "Near you") await step("Arrived", "system");
  await step("Delivered", "rider", "otp");
  const {payPaise, tipPaise} = storeDeliveryPayPaise(order);
  await postStoreDeliveryMessage(order, `Delivered. ${paiseText(payPaise + tipPaise)} delivery pay is added to your payout.`)
    .catch(() => undefined);
  logger.info("STORE_DELIVERY_COMPLETED", {orderId: order.id, restaurantId: order.restaurantId});
  return "delivered";
}
