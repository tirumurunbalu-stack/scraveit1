import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  activeCommercialPlan,
  computeOrderEconomics,
  economicsImbalancePaise,
  economicsScopeKey,
  guardPlatformDiscount,
  normalizePromotionTerms,
  promotionDiscountPaise,
  promotionIneligibility,
  resolveEconomicsPolicy,
  rupeesToPaise,
  splitDiscountByFunding,
  type EconomicsPolicy,
  type GuardedDiscount,
  type OrderEconomicsSnapshot,
  type PromotionTerms,
} from "../domain/economics";
import {
  applyEconomicsControlUpdate,
  economicsEnabledForCity,
  normalizeEconomicsControl,
  type EconomicsControl,
  type EconomicsControlUpdate,
} from "../domain/economicsControl";
import {
  calculateRiderTripPay,
  minuteOfDayInTimeZone,
  resolveRiderTripPayPolicy,
  type RiderTripPayBreakdown,
  type RiderTripPayPolicy,
} from "../domain/riderTripPay";
import {activeTaxVersion, computeTaxLines, type TaxComputation} from "../domain/taxRules";
import {DomainError} from "../errors";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {Address, AppliedOfferSnapshot, CatalogRestaurant, PricingBreakdown, SavrivoOrder} from "../types";
import {requirePlatformConfigAdminClaim} from "./authz";

export const ECONOMICS_CONTROL_COLLECTION = "economicsControl";
export const ECONOMICS_HISTORY_COLLECTION = "economicsControlHistory";
export const PROMOTION_REDEMPTIONS_COLLECTION = "promotionRedemptions";
export const PROMOTION_CUSTOMER_USAGE_COLLECTION = "promotionCustomerUsage";
export const GROWTH_BUDGETS_COLLECTION = "growthBudgets";

export function economicsControlRef(database: FirestoreLike): DocumentReferenceLike {
  return database.collection(ECONOMICS_CONTROL_COLLECTION).doc("current");
}

// ---------------------------------------------------------------------------
// Control document: cached read, audited write
// ---------------------------------------------------------------------------

const CONTROL_CACHE_MS = 30_000;
let controlCache: {control: EconomicsControl; expiresAt: number} | null = null;

/**
 * Checkout reads this on every order, so it is cached briefly. A read failure
 * falls back to the safe defaults (guardrail on, standard minimums) rather
 * than to "no rules at all".
 */
export async function loadEconomicsControl(
  now = Date.now(),
  database: FirestoreLike = firestoreDb,
): Promise<EconomicsControl> {
  if (controlCache && controlCache.expiresAt > now) return controlCache.control;
  try {
    const snapshot = await economicsControlRef(database).get();
    const control = normalizeEconomicsControl(snapshot.exists ? snapshot.data() : null);
    controlCache = {control, expiresAt: now + CONTROL_CACHE_MS};
    return control;
  } catch (error) {
    logger.error("ECONOMICS_CONTROL_LOAD_FAILED", {error});
    const control = normalizeEconomicsControl(null);
    controlCache = {control, expiresAt: now + 5_000};
    return control;
  }
}

export function clearEconomicsControlCache(): void {
  controlCache = null;
}

export async function readEconomicsControlForAdmin(
  token: DecodedIdToken,
  database: FirestoreLike = firestoreDb,
): Promise<{control: EconomicsControl; resolvedGlobal: EconomicsPolicy; history: unknown[]}> {
  requirePlatformConfigAdminClaim(token);
  const [snapshot, history] = await Promise.all([
    economicsControlRef(database).get(),
    database.collection(ECONOMICS_HISTORY_COLLECTION).orderBy("at", "desc").limit(25).get(),
  ]);
  const control = normalizeEconomicsControl(snapshot.exists ? snapshot.data() : null);
  return {
    control,
    resolvedGlobal: resolveEconomicsPolicy(control.policies, {cityKey: ""}).policy,
    history: history.docs.map((doc) => doc.data()),
  };
}

export async function updateEconomicsControlForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: {update: EconomicsControlUpdate; reason: string; expectedRevision?: number},
  database: FirestoreLike = firestoreDb,
): Promise<{control: EconomicsControl}> {
  const role = requirePlatformConfigAdminClaim(token);
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) {
    throw new DomainError("invalid-argument", "Give a short reason for this financial setting change.");
  }
  const ref = economicsControlRef(database);
  const now = Date.now();
  const result = await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const current = normalizeEconomicsControl(snapshot.exists ? snapshot.data() : null);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new DomainError("aborted", "Someone else changed these settings. Reload and try again.");
    }
    let applied: ReturnType<typeof applyEconomicsControlUpdate>;
    try {
      applied = applyEconomicsControlUpdate(current, input.update);
    } catch (error) {
      throw new DomainError("invalid-argument", error instanceof Error ? error.message : "Invalid economics update.");
    }
    const next: EconomicsControl = {...applied.next, revision: current.revision + 1, updatedAt: now, updatedBy: uid};
    transaction.set(ref, next);
    const historyRef = database.collection(ECONOMICS_HISTORY_COLLECTION).doc(`rev_${String(next.revision).padStart(8, "0")}`);
    transaction.set(historyRef, {
      revision: next.revision,
      target: applied.target,
      before: applied.before ?? null,
      after: applied.after ?? null,
      reason: reason.slice(0, 500),
      by: uid,
      byEmail: String(token.email ?? "").slice(0, 160),
      role,
      at: now,
    });
    transaction.set(database.collection("audit").doc(`economics_${next.revision}_${now}`), {
      action: "economics.update",
      target: applied.target,
      actorId: uid,
      actorRole: role,
      reason: reason.slice(0, 500),
      at: now,
    });
    return next;
  });
  clearEconomicsControlCache();
  logger.info("ECONOMICS_CONTROL_UPDATED", {uid, revision: result.revision});
  return {control: result};
}

// ---------------------------------------------------------------------------
// Offers at checkout
// ---------------------------------------------------------------------------

export interface CheckoutPromotion {
  terms: PromotionTerms;
  growthBudgetRemainingPaise: number;
}

function promotionError(reason: string): DomainError {
  const messages: Record<string, string> = {
    inactive: "Coupon is not valid.",
    not_approved: "Coupon is not valid.",
    not_started: "This offer has not started yet.",
    expired: "Coupon has expired.",
    below_minimum: "Order does not meet the coupon minimum.",
    wrong_restaurant: "Coupon is not valid for this restaurant.",
    wrong_city: "Coupon is not valid in this city.",
    budget_exhausted: "This offer has been fully claimed.",
    first_order: "This offer is only for a first Scraveit order.",
    customer_limit: "You have already used this offer the maximum number of times.",
  };
  return new DomainError("failed-precondition", messages[reason] ?? "Coupon is not valid.");
}

/**
 * A first-order offer exists to buy a new customer, so any previous order at
 * all disqualifies it - including one that was cancelled, which would
 * otherwise be an obvious way to keep claiming it. An unknown customer is
 * treated as "not new": failing closed costs at most one missed discount,
 * while failing open hands out an unlimited one.
 */
async function customerHasOrderedBefore(customerId: string, database: FirestoreLike): Promise<boolean> {
  if (!customerId) return true;
  const snapshot = await database.collection("orders").where("customerId", "==", customerId).limit(1).get();
  return !snapshot.empty;
}

function customerUsageRef(database: FirestoreLike, promotionId: string, customerId: string): DocumentReferenceLike {
  return database.collection(PROMOTION_CUSTOMER_USAGE_COLLECTION).doc(`${promotionId}_${customerId}`);
}

function growthBudgetRef(database: FirestoreLike, id: string): DocumentReferenceLike {
  return database.collection(GROWTH_BUDGETS_COLLECTION).doc(id);
}

export interface GrowthBudget {
  id: string;
  name: string;
  cityKey: string;
  approvedPaise: number;
  spentPaise: number;
  validFrom: number;
  validUntil: number;
  active: boolean;
  approvedBy: string;
  reason: string;
}

export function normalizeGrowthBudget(id: string, value: unknown): GrowthBudget {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const int = (entry: unknown) => {
    const parsed = Math.round(Number(entry));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    id,
    name: String(input.name ?? "").slice(0, 120),
    cityKey: economicsScopeKey(input.cityKey),
    approvedPaise: int(input.approvedPaise),
    spentPaise: int(input.spentPaise),
    validFrom: int(input.validFrom),
    validUntil: int(input.validUntil),
    active: input.active === true,
    approvedBy: String(input.approvedBy ?? "").slice(0, 160),
    reason: String(input.reason ?? "").slice(0, 500),
  };
}

export function growthBudgetRemaining(budget: GrowthBudget | null, cityKey: string, at: number): number {
  if (!budget || !budget.active) return 0;
  if (budget.validFrom > 0 && at < budget.validFrom) return 0;
  if (budget.validUntil > 0 && at >= budget.validUntil) return 0;
  if (budget.cityKey && budget.cityKey !== economicsScopeKey(cityKey)) return 0;
  return Math.max(0, budget.approvedPaise - budget.spentPaise);
}

/** Validates a coupon for this customer and cart. Throws a customer-readable error when it cannot apply. */
export async function resolveCheckoutPromotion(
  code: string,
  context: {subtotalPaise: number; restaurantId: string; cityKey: string; customerId: string; at: number},
  database: FirestoreLike = firestoreDb,
): Promise<CheckoutPromotion | null> {
  const normalizedCode = String(code ?? "").trim().toUpperCase();
  if (!normalizedCode) return null;
  const snapshot = await database.collection("promotions").where("code", "==", normalizedCode).limit(5).get();
  const candidates = snapshot.docs
    .map((doc) => normalizePromotionTerms(doc.id, doc.data()))
    .filter((terms) => terms.code === normalizedCode);
  const terms = candidates.find((entry) => entry.active && entry.approvalStatus === "approved") ?? candidates[0];
  if (!terms) throw promotionError("inactive");
  const ineligible = promotionIneligibility(terms, context);
  if (ineligible) throw promotionError(ineligible);
  if (terms.firstOrderOnly && await customerHasOrderedBefore(context.customerId, database)) {
    throw promotionError("first_order");
  }
  if (terms.perCustomerLimit > 0) {
    const usage = await customerUsageRef(database, terms.id, context.customerId).get();
    const used = Number((usage.exists ? usage.data() as {count?: unknown} : {}).count ?? 0);
    if (used >= terms.perCustomerLimit) throw promotionError("customer_limit");
  }
  let growthBudgetRemainingPaise = 0;
  if (terms.growthBudgetId) {
    const budgetSnapshot = await growthBudgetRef(database, terms.growthBudgetId).get();
    growthBudgetRemainingPaise = growthBudgetRemaining(
      budgetSnapshot.exists ? normalizeGrowthBudget(terms.growthBudgetId, budgetSnapshot.data()) : null,
      context.cityKey,
      context.at,
    );
  }
  return {terms, growthBudgetRemainingPaise};
}

// ---------------------------------------------------------------------------
// Pricing plan: who pays what, decided once
// ---------------------------------------------------------------------------

export interface ServerFees {
  deliveryFee: number;
  platformFee: number;
  lateNightFee: number;
  rainFee: number;
  surgeFee: number;
  riderIncentiveFee: number;
  /** What riders earn for the matched per-order campaigns; defaults to riderIncentiveFee. */
  riderIncentivePay?: number;
  riderSurgeFee?: number;
  smallOrderThreshold: number;
  smallOrderFee: number;
  riderIncentiveCampaignIds?: string[];
  /** Restaurant-to-customer straight-line distance, for rider drop pay. */
  distanceKm?: number;
}

export interface CheckoutEconomicsPlan {
  engineEnabled: boolean;
  cityKey: string;
  zoneKey: string;
  policy: EconomicsPolicy;
  policyScopes: string[];
  commissionBps: number;
  commercialPlanId: string;
  riderTripPayPaise: number;
  /** Per-order campaign bonuses the rider will be paid (customer fee may differ). */
  riderIncentivePayPaise: number;
  /** Estimated at checkout; replaced by the final figure at delivery. */
  tripPay: RiderTripPayBreakdown | null;
  tripPayPolicy: RiderTripPayPolicy | null;
  discount: GuardedDiscount;
  offer: AppliedOfferSnapshot | null;
  guardrailEnabled: boolean;
}

function smallOrderFeePaise(fees: ServerFees, subtotal: number): number {
  return fees.smallOrderThreshold > 0 && subtotal < fees.smallOrderThreshold ? rupeesToPaise(fees.smallOrderFee) : 0;
}

/**
 * Decides, before anything is written, how much discount the customer gets
 * and who pays for it. Pure given its inputs, so the checkout preview and the
 * real order creation reach exactly the same answer.
 */
export function planCheckoutEconomics(input: {
  control: EconomicsControl;
  restaurant: Pick<CatalogRestaurant, "id" | "city">;
  address: Pick<Address, "area" | "label">;
  subtotal: number;
  fees: ServerFees;
  paymentMethod: "cod" | "upi" | "card";
  tip: number;
  promotion: CheckoutPromotion | null;
  defaultCommissionBps: number;
  now: number;
}): CheckoutEconomicsPlan {
  const cityKey = economicsScopeKey(input.restaurant.city);
  const zoneKey = economicsScopeKey(input.address.area || input.address.label);
  const engineEnabled = economicsEnabledForCity(input.control, cityKey);
  const {policy, appliedScopes} = resolveEconomicsPolicy(input.control.policies, {
    cityKey,
    zoneKey,
    restaurantId: input.restaurant.id,
  });
  const plan = activeCommercialPlan(input.control.commercialPlans[input.restaurant.id] ?? [], input.now);
  const commissionBps = plan ? plan.commissionBps : input.defaultCommissionBps;
  const subtotalPaise = rupeesToPaise(input.subtotal);
  const deliveryFeePaise = rupeesToPaise(input.fees.deliveryFee);
  // Rider pay comes from the rider trip-pay policy, never from what the
  // customer was charged for delivery. The difference is shown, not hidden.
  const tripPayPolicy = engineEnabled ?
    resolveRiderTripPayPolicy(input.control.riderTripPay, {cityKey, zoneKey}, input.now) : null;
  const tripPay = tripPayPolicy ? calculateRiderTripPay(tripPayPolicy, {
    pickupMeters: tripPayPolicy.expectedPickupMeters,
    dropMeters: Math.round(Math.max(0, Number(input.fees.distanceKm ?? 0)) * 1_000),
    waitMinutes: 0,
    minuteOfDay: minuteOfDayInTimeZone(input.now, input.control.cities[cityKey]?.timezone ?? "Asia/Kolkata"),
  }) : null;
  const riderTripPayPaise = tripPay ? tripPay.totalPaise : deliveryFeePaise;
  const guardrailEnabled = engineEnabled && input.control.flags.profitabilityGuardrail;

  const terms = input.promotion?.terms ?? null;
  const gross = terms ? promotionDiscountPaise(terms, subtotalPaise) : 0;
  // With the engine off, every discount settles the legacy way: restaurant-funded.
  const requested = terms && engineEnabled ? splitDiscountByFunding(terms, gross) : {restaurantPaise: gross, platformPaise: 0};

  // Capacity is measured after the restaurant's own share, which already
  // lowers Scraveit's commission, and before any platform money is spent.
  const beforePlatform = computeOrderEconomics({
    cityKey,
    zoneKey,
    restaurantId: input.restaurant.id,
    paymentMethod: input.paymentMethod,
    itemSubtotalPaise: subtotalPaise,
    restaurantDiscountPaise: requested.restaurantPaise,
    platformDiscountPaise: 0,
    deliveryFeePaise,
    platformFeePaise: rupeesToPaise(input.fees.platformFee),
    smallOrderFeePaise: smallOrderFeePaise(input.fees, input.subtotal),
    lateNightFeePaise: rupeesToPaise(input.fees.lateNightFee),
    rainFeePaise: rupeesToPaise(input.fees.rainFee),
    surgeFeePaise: rupeesToPaise(input.fees.surgeFee),
    riderIncentiveFeePaise: rupeesToPaise(input.fees.riderIncentiveFee),
    riderSurgeFeePaise: rupeesToPaise(input.fees.riderSurgeFee ?? 0),
    taxPaise: 0,
    tipPaise: rupeesToPaise(input.tip),
    commissionBps,
    riderDeliveryPayPaise: riderTripPayPaise,
    riderIncentivePayPaise: rupeesToPaise(input.fees.riderIncentivePay ?? input.fees.riderIncentiveFee),
  }, policy, appliedScopes);

  const promotionBudgetRemaining = terms && terms.budgetPaise > 0 ?
    Math.max(0, terms.budgetPaise - terms.usedBudgetPaise) : null;
  const discount = guardPlatformDiscount({
    requestedRestaurantPaise: requested.restaurantPaise,
    requestedPlatformPaise: requested.platformPaise,
    promotionCapacityPaise: beforePlatform.guardrail.promotionCapacityPaise,
    guardrailEnabled,
    promotionBudgetRemainingPaise: engineEnabled ? promotionBudgetRemaining : null,
    growthBudgetRemainingPaise: input.promotion?.growthBudgetRemainingPaise ?? 0,
  });

  return {
    engineEnabled,
    cityKey,
    zoneKey,
    policy,
    policyScopes: appliedScopes,
    commissionBps,
    commercialPlanId: plan?.planId ?? "",
    riderTripPayPaise,
    riderIncentivePayPaise: rupeesToPaise(input.fees.riderIncentivePay ?? input.fees.riderIncentiveFee),
    tripPay,
    tripPayPolicy,
    discount,
    guardrailEnabled,
    offer: terms ? {
      promotionId: terms.id,
      code: terms.code,
      title: terms.title,
      fundingSource: engineEnabled ? terms.fundingSource : "restaurant",
      restaurantFundedPaise: discount.restaurantDiscountPaise,
      platformFundedPaise: discount.platformDiscountPaise,
      growthSubsidyPaise: discount.growthSubsidyPaise,
      growthBudgetId: discount.growthSubsidyPaise > 0 ? terms.growthBudgetId : "",
      withheldPlatformPaise: discount.withheldPlatformPaise,
      limitedBy: discount.limitedBy,
    } : null,
  };
}

/**
 * Freezes the economics snapshot from the final server pricing. Throws if the
 * snapshot's own customer total disagrees with the order total by even one
 * paisa - an order must never be written with money that does not reconcile.
 */
export function finalizeOrderEconomics(
  plan: CheckoutEconomicsPlan,
  pricing: PricingBreakdown,
  total: number,
  restaurantId: string,
  paymentMethod: "cod" | "upi" | "card",
  ruleIds: string[],
  extras: {commissionTaxPaise?: number; taxVersionId?: string} = {},
): OrderEconomicsSnapshot {
  const snapshot = computeOrderEconomics({
    cityKey: plan.cityKey,
    zoneKey: plan.zoneKey,
    restaurantId,
    paymentMethod,
    itemSubtotalPaise: rupeesToPaise(pricing.subtotal),
    restaurantDiscountPaise: plan.discount.restaurantDiscountPaise,
    platformDiscountPaise: plan.discount.platformDiscountPaise,
    growthSubsidyPaise: plan.discount.growthSubsidyPaise,
    deliveryFeePaise: rupeesToPaise(pricing.deliveryFee),
    platformFeePaise: rupeesToPaise(pricing.platformFee),
    smallOrderFeePaise: rupeesToPaise(pricing.smallOrderFee),
    lateNightFeePaise: rupeesToPaise(pricing.lateNightFee),
    rainFeePaise: rupeesToPaise(pricing.rainFee),
    surgeFeePaise: rupeesToPaise(pricing.surgeFee),
    riderIncentiveFeePaise: rupeesToPaise(pricing.riderIncentiveFee),
    riderSurgeFeePaise: rupeesToPaise(pricing.riderSurgeFee ?? 0),
    taxPaise: rupeesToPaise(pricing.tax),
    tipPaise: rupeesToPaise(pricing.tip),
    commissionBps: plan.commissionBps,
    riderDeliveryPayPaise: plan.riderTripPayPaise,
    riderIncentivePayPaise: plan.riderIncentivePayPaise,
    ...(plan.tripPay ? {tripPay: {
      basePickupPaise: plan.tripPay.basePickupPaise,
      pickupDistancePaise: plan.tripPay.pickupDistancePaise,
      dropDistancePaise: plan.tripPay.dropDistancePaise,
      longDistancePaise: plan.tripPay.longDistancePaise,
      vehicleAdjustmentPaise: plan.tripPay.vehicleAdjustmentPaise,
      minimumTopUpPaise: plan.tripPay.minimumTopUpPaise,
      maximumCapPaise: plan.tripPay.maximumCapPaise,
      waitingPaise: plan.tripPay.waitingPaise,
      slotPaise: plan.tripPay.slotPaise,
      pickupMeters: plan.tripPay.pickupMeters,
      dropMeters: plan.tripPay.dropMeters,
      waitMinutes: plan.tripPay.waitMinutes,
      estimated: true,
    }} : {}),
    walletRedeemPaise: rupeesToPaise(pricing.walletRedeem ?? 0),
    commissionTaxPaise: extras.commissionTaxPaise ?? 0,
    ...(extras.taxVersionId ? {taxVersionId: extras.taxVersionId} : {}),
    ruleIds: [
      ...ruleIds,
      ...(plan.commercialPlanId ? [`commercial_plan:${plan.commercialPlanId}`] : []),
      ...(plan.offer ? [`promotion:${plan.offer.promotionId}`] : []),
    ],
  }, plan.policy, plan.policyScopes);
  if (snapshot.customer.payablePaise !== rupeesToPaise(total) || economicsImbalancePaise(snapshot) !== 0) {
    logger.error("ECONOMICS_SNAPSHOT_RECONCILIATION_FAILED", {
      payablePaise: snapshot.customer.payablePaise,
      totalPaise: rupeesToPaise(total),
      imbalancePaise: economicsImbalancePaise(snapshot),
    });
    throw new DomainError("internal", "Order pricing could not be reconciled. Please try again.");
  }
  return snapshot;
}

/**
 * Component tax per the CA-defined version in force, or null to keep the
 * legacy flat food rate. Restaurant-side tax (on commission) is withheld from
 * the restaurant's settlement; customer-side tax is added to the bill.
 */
export function checkoutTax(
  control: EconomicsControl,
  plan: CheckoutEconomicsPlan,
  fees: ServerFees,
  subtotal: number,
  at: number,
): (TaxComputation & {lines: TaxComputation["lines"]}) | null {
  if (!plan.engineEnabled) return null;
  const version = activeTaxVersion(control.taxVersions, at);
  if (!version || version.mode !== "component_rules") return null;
  const subtotalPaise = rupeesToPaise(subtotal);
  const commissionBase = subtotalPaise - plan.discount.restaurantDiscountPaise;
  return computeTaxLines(version, {
    foodPaise: subtotalPaise,
    restaurantDiscountPaise: plan.discount.restaurantDiscountPaise,
    platformDiscountPaise: plan.discount.platformDiscountPaise,
    packagingPaise: 0,
    deliveryFeePaise: rupeesToPaise(fees.deliveryFee),
    platformFeePaise: rupeesToPaise(fees.platformFee),
    smallOrderFeePaise: smallOrderFeePaise(fees, subtotal),
    lateNightFeePaise: rupeesToPaise(fees.lateNightFee),
    surgeFeePaise: rupeesToPaise(fees.surgeFee),
    rainFeePaise: rupeesToPaise(fees.rainFee),
    riderIncentiveFeePaise: rupeesToPaise(fees.riderIncentiveFee),
    commissionPaise: Math.round(commissionBase * plan.commissionBps / 10_000),
  });
}

// ---------------------------------------------------------------------------
// Server-only full snapshot
// ---------------------------------------------------------------------------

export const ORDER_ECONOMICS_COLLECTION = "orderEconomics";

export function orderEconomicsRef(database: FirestoreLike, orderId: string): DocumentReferenceLike {
  return database.collection(ORDER_ECONOMICS_COLLECTION).doc(orderId);
}

export type OrderEconomicsOutcome = "open" | "delivered" | "cancelled";

/**
 * One record per order holding the complete snapshot, plus the few indexed
 * fields the city economics dashboard filters on. Never readable by clients.
 */
export function orderEconomicsRecord(
  order: Pick<SavrivoOrder, "id" | "restaurantId" | "customerId" | "createdAt">,
  snapshot: OrderEconomicsSnapshot,
  extras: {tripPayPolicy?: RiderTripPayPolicy | null; distanceMeters?: number; taxLines?: unknown[]} = {},
): Record<string, unknown> {
  return {
    ...(extras.tripPayPolicy ? {tripPayPolicy: extras.tripPayPolicy} : {}),
    ...(extras.distanceMeters !== undefined ? {distanceMeters: extras.distanceMeters} : {}),
    ...(extras.taxLines && extras.taxLines.length ? {taxLines: extras.taxLines} : {}),
    orderId: order.id,
    restaurantId: order.restaurantId,
    customerId: order.customerId,
    cityKey: snapshot.cityKey,
    zoneKey: snapshot.zoneKey,
    createdAt: order.createdAt,
    outcome: "open" satisfies OrderEconomicsOutcome,
    snapshot,
  };
}

/** Records the final outcome; the snapshot itself is never rewritten. */
export async function recordOrderEconomicsOutcome(
  order: Pick<SavrivoOrder, "id" | "status" | "updatedAt" | "deliveredAt" | "economics">,
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  if (!order.economics) return;
  const outcome: OrderEconomicsOutcome | null = order.status === "Delivered" ? "delivered" :
    order.status === "Cancelled" ? "cancelled" : null;
  if (!outcome) return;
  await orderEconomicsRef(database, order.id).set({
    outcome,
    outcomeAt: Number(order.deliveredAt ?? order.updatedAt) || Date.now(),
  }, {merge: true});
}

// ---------------------------------------------------------------------------
// Budget reservation and release (inside the order transaction)
// ---------------------------------------------------------------------------

export interface PromotionReservationReads {
  promotion: DocumentReferenceLike | null;
  growthBudget: DocumentReferenceLike | null;
  customerUsage: DocumentReferenceLike | null;
  redemption: DocumentReferenceLike;
}

export function promotionReservationRefs(
  database: FirestoreLike,
  orderId: string,
  customerId: string,
  offer: AppliedOfferSnapshot | null,
  terms: PromotionTerms | null,
): PromotionReservationReads | null {
  if (!offer || !terms) return null;
  const needsPromotion = offer.platformFundedPaise - offer.growthSubsidyPaise > 0 && terms.budgetPaise > 0;
  return {
    promotion: needsPromotion ? database.collection("promotions").doc(terms.id) : null,
    growthBudget: offer.growthSubsidyPaise > 0 && offer.growthBudgetId ? growthBudgetRef(database, offer.growthBudgetId) : null,
    customerUsage: terms.perCustomerLimit > 0 ? customerUsageRef(database, terms.id, customerId) : null,
    redemption: database.collection(PROMOTION_REDEMPTIONS_COLLECTION).doc(orderId),
  };
}

/**
 * Must run inside the same transaction that creates the order, after all
 * other reads. Re-checks every limit against the live documents so two
 * customers racing for the last of a budget can never both get it: the loser
 * gets a clear error and re-prices with whatever is left.
 */
export async function reservePromotionSpend(
  transaction: TransactionLike,
  refs: PromotionReservationReads,
  input: {orderId: string; customerId: string; offer: AppliedOfferSnapshot; terms: PromotionTerms; cityKey: string; at: number},
): Promise<() => void> {
  const [promotionSnap, growthSnap, usageSnap] = await Promise.all([
    refs.promotion ? transaction.get(refs.promotion) : Promise.resolve(null),
    refs.growthBudget ? transaction.get(refs.growthBudget) : Promise.resolve(null),
    refs.customerUsage ? transaction.get(refs.customerUsage) : Promise.resolve(null),
  ]);
  const operatingSpend = input.offer.platformFundedPaise - input.offer.growthSubsidyPaise;
  let promotionUsed = 0;
  if (refs.promotion && promotionSnap) {
    const live = normalizePromotionTerms(input.terms.id, promotionSnap.exists ? promotionSnap.data() : null);
    promotionUsed = live.usedBudgetPaise;
    if (live.budgetPaise > 0 && live.usedBudgetPaise + operatingSpend > live.budgetPaise) {
      throw new DomainError("aborted", "This offer's budget just ran out. Review your cart and place the order again.");
    }
  }
  let growthSpent = 0;
  if (refs.growthBudget && growthSnap) {
    const budget = growthSnap.exists ? normalizeGrowthBudget(input.offer.growthBudgetId, growthSnap.data()) : null;
    if (growthBudgetRemaining(budget, input.cityKey, input.at) < input.offer.growthSubsidyPaise) {
      throw new DomainError("aborted", "This offer's budget just ran out. Review your cart and place the order again.");
    }
    growthSpent = budget?.spentPaise ?? 0;
  }
  let usageCount = 0;
  if (refs.customerUsage && usageSnap) {
    usageCount = Number((usageSnap.exists ? usageSnap.data() as {count?: unknown} : {}).count ?? 0);
    if (usageCount >= input.terms.perCustomerLimit) throw promotionError("customer_limit");
  }
  // Writes are returned as a closure so the caller can run them after its own
  // reads - Firestore transactions require every read before any write.
  return () => {
    if (refs.promotion) {
      transaction.set(refs.promotion, {usedBudgetPaise: promotionUsed + operatingSpend, updatedAt: input.at}, {merge: true});
    }
    if (refs.growthBudget) {
      transaction.set(refs.growthBudget, {spentPaise: growthSpent + input.offer.growthSubsidyPaise, updatedAt: input.at}, {merge: true});
    }
    if (refs.customerUsage) {
      transaction.set(refs.customerUsage, {
        promotionId: input.terms.id,
        customerId: input.customerId,
        count: usageCount + 1,
        updatedAt: input.at,
      }, {merge: true});
    }
    transaction.set(refs.redemption, {
      orderId: input.orderId,
      customerId: input.customerId,
      promotionId: input.terms.id,
      operatingSpendPaise: operatingSpend,
      growthSubsidyPaise: input.offer.growthSubsidyPaise,
      growthBudgetId: input.offer.growthBudgetId,
      countedCustomerUse: Boolean(refs.customerUsage),
      countedPromotionBudget: Boolean(refs.promotion),
      status: "reserved",
      reservedAt: input.at,
    });
  };
}

/**
 * Gives a cancelled order's offer budget back, exactly once. Safe to call
 * repeatedly (the trigger that calls it retries): the redemption record's
 * status is the idempotency guard.
 */
export async function releasePromotionSpend(orderId: string, database: FirestoreLike = firestoreDb): Promise<boolean> {
  const redemptionRef = database.collection(PROMOTION_REDEMPTIONS_COLLECTION).doc(orderId);
  return database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(redemptionRef);
    if (!snapshot.exists) return false;
    const redemption = snapshot.data() as Record<string, unknown>;
    if (redemption.status !== "reserved") return false;
    const promotionId = String(redemption.promotionId ?? "");
    const growthBudgetId = String(redemption.growthBudgetId ?? "");
    const customerId = String(redemption.customerId ?? "");
    const promotionRef = redemption.countedPromotionBudget === true && promotionId ?
      database.collection("promotions").doc(promotionId) : null;
    const growthRef = Number(redemption.growthSubsidyPaise) > 0 && growthBudgetId ? growthBudgetRef(database, growthBudgetId) : null;
    const usageRef = redemption.countedCustomerUse === true && promotionId && customerId ?
      customerUsageRef(database, promotionId, customerId) : null;
    const [promotionSnap, growthSnap, usageSnap] = await Promise.all([
      promotionRef ? transaction.get(promotionRef) : Promise.resolve(null),
      growthRef ? transaction.get(growthRef) : Promise.resolve(null),
      usageRef ? transaction.get(usageRef) : Promise.resolve(null),
    ]);
    const now = Date.now();
    if (promotionRef && promotionSnap?.exists) {
      const used = Number((promotionSnap.data() as {usedBudgetPaise?: unknown}).usedBudgetPaise ?? 0);
      transaction.set(promotionRef, {
        usedBudgetPaise: Math.max(0, used - Number(redemption.operatingSpendPaise ?? 0)),
        updatedAt: now,
      }, {merge: true});
    }
    if (growthRef && growthSnap?.exists) {
      const spent = Number((growthSnap.data() as {spentPaise?: unknown}).spentPaise ?? 0);
      transaction.set(growthRef, {
        spentPaise: Math.max(0, spent - Number(redemption.growthSubsidyPaise ?? 0)),
        updatedAt: now,
      }, {merge: true});
    }
    if (usageRef && usageSnap?.exists) {
      const count = Number((usageSnap.data() as {count?: unknown}).count ?? 0);
      transaction.set(usageRef, {count: Math.max(0, count - 1), updatedAt: now}, {merge: true});
    }
    transaction.set(redemptionRef, {status: "released", releasedAt: now}, {merge: true});
    return true;
  });
}

export {splitDiscountByFunding, promotionDiscountPaise};
