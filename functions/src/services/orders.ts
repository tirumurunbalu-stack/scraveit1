import {randomBytes, randomInt, timingSafeEqual} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {SCHEMA_VERSION} from "../config";
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
import {availabilityCityKey} from "../domain/dispatch";
import {countAvailableRiders, estimateDelivery} from "../domain/deliveryEstimate";
// Same staleness bar dispatch itself uses to decide a rider is really there,
// so the delivery estimate and the dispatcher never disagree about supply.
import {DEFAULT_DISPATCH_POLICY} from "../domain/dispatchPolicy";
import {deriveLifecycleFromCanonicalState} from "../domain/lifecycle";
import {
  resolveFinancePaymentSelection,
  type FinancePolicy,
} from "../domain/financePolicy";
import type {ProximityStatus} from "../domain/tracking";
import {DomainError} from "../errors";
import type {TransactionLike} from "../firestoreTypes";
import {FieldValue} from "../firestoreTypes";
import {deliveryOtpRef, orderRef, restaurantRef, riderAvailabilityCollectionRef, riderWalletRef} from "../firestorePaths";
import type {CreateCodOrderInput, CreateOrderInput, TransitionOrderInput} from "./serviceTypes";
import type {ActorRole, OrderStatus, PricingBreakdown, SavrivoOrder, StatusEvent} from "../types";
import {authorizeTransition} from "./authz";
import {loadCustomerAddress, loadRestaurantAndMenu, loadServerFees} from "./catalog";
import {
  checkoutTax,
  finalizeOrderEconomics,
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
import {planWalletRedemption, reserveWalletRedemption} from "./wallet";
import {reconcileRestaurantWorkload} from "./workload";
import {reconcileRestaurantOrderProjection} from "./orderProjection";
import {persistCodOrderDeliveryLedger} from "./ledger";
import {resolveDeliverySettlementOptions} from "./deliverySettlement";
import {persistOnlineOrderDeliveryLedger} from "./onlineDeliveryLedger";
import {loadFinancePolicy} from "./platformConfig";
import {lawBasedCheckoutTax} from "./taxEngine";
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

export async function createAuthoritativeOrder(uid: string, input: CreateOrderInput): Promise<{
  order: SavrivoOrder;
  deliveryOtp: string;
  recovered: boolean;
}> {
  const orderId = deterministicOrderId(uid, input.idempotencyKey);
  const ref = orderRef(firestoreDb, orderId);
  const existingSnapshot = await ref.get();
  const existing = existingSnapshot.exists ? existingSnapshot.data() as SavrivoOrder : null;
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
  const pricedAt = Date.now();
  const [fees, promotion, economicsControl, availableRiders] = await Promise.all([
    loadServerFees(restaurant, address, subtotal),
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
  });
  const discount = (economicsPlan.discount.restaurantDiscountPaise + economicsPlan.discount.platformDiscountPaise) / 100;
  // CA-defined component tax rules replace the flat food tax only once a
  // version in component_rules mode is in force (see domain/taxRules.ts).
  let tax = checkoutTax(economicsControl, economicsPlan, fees, subtotal, pricedAt);
  // Effective-dated tax law (services/taxEngine.ts) replaces it once switched on.
  const lawTax = await lawBasedCheckoutTax({restaurant, items, menuById, plan: economicsPlan, fees, subtotal, at: pricedAt});
  if (lawTax?.tax) tax = lawTax.tax;
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
    ...(tax ? {taxOverride: tax.customerTaxPaise / 100} : {}),
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
  const pricing: PricingBreakdown = economicsPlan.engineEnabled ? {
    ...basePricing,
    restaurantDiscount: economicsPlan.discount.restaurantDiscountPaise / 100,
    platformDiscount: economicsPlan.discount.platformDiscountPaise / 100,
  } : basePricing;
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
  const deliveryEstimate = estimateDelivery({
    kitchenEtaMinMinutes: restaurant.etaMin,
    kitchenEtaMaxMinutes: restaurant.etaMax,
    distanceKm: fees.distanceKm,
    activeOrders: fees.activeOrders,
    availableRiders,
    occurredAt: now,
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
    etaMin: deliveryEstimate.etaMinMinutes,
    etaMax: deliveryEstimate.etaMaxMinutes,
    etaConfidence: deliveryEstimate.confidence,
    // Kept so a late delivery can be explained after the fact, and so the
    // promise can be scored against the actual time once enough have landed.
    etaBasis: deliveryEstimate.basis,
    ...(economics ? {economics: settlementTerms(economics)} : {}),
    ...(economicsPlan.offer ? {appliedOffer: economicsPlan.offer} : {}),
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
