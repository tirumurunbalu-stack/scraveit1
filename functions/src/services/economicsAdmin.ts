import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  activeCommercialPlan,
  allocateReserves,
  economicsScopeKey,
  formatRupees,
  normalizePromotionTerms,
  promotionDiscountPaise,
  resolveEconomicsPolicy,
  simulateOffer,
  splitDiscountByFunding,
  type EconomicsPolicy,
  type OfferSimulationInput,
  type OfferSimulationResult,
  type OrderEconomicsSnapshot,
  type PromotionTerms,
} from "../domain/economics";
import {guaranteeLiabilityEstimate, type GuaranteeTier} from "../domain/earningsGuarantee";
import {validateLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {isActiveMembershipForRestaurant, type RestaurantMembership} from "../domain/restaurantAccess";
import {DomainError} from "../errors";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {legacyStaffRef, restaurantMemberRef, restaurantRef} from "../firestorePaths";
import {requireOwnerClaim, requirePlatformConfigAdminClaim} from "./authz";
import {
  GROWTH_BUDGETS_COLLECTION,
  ORDER_ECONOMICS_COLLECTION,
  loadEconomicsControl,
  normalizeGrowthBudget,
  restaurantCommissionBps,
  type GrowthBudget,
} from "./economics";
import {LEDGER_JOURNALS_COLLECTION} from "./ledger";
import {
  breakEven,
  cityProfitAndLoss,
  normalizeOperatingCost,
  operatingCostsByCategory,
  resolveCityFinancePolicy,
  type BreakEvenInput,
  type BreakEvenResult,
  type CityOperatingCost,
  type CityProfitAndLoss,
} from "../domain/cityFinance";
import {loadFinancePolicy} from "./platformConfig";

// ---------------------------------------------------------------------------
// Simulate before publish
// ---------------------------------------------------------------------------

export interface OfferSimulationRequest {
  cityKey: string;
  averageOrderValuePaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  riderPayPerOrderPaise: number;
  onlinePaymentShareBps: number;
  expectedOrders: number;
  redemptionShareBps: number;
  commissionBps?: number;
  offer: OfferSimulationInput["offer"];
}

async function cityPolicy(cityKey: string, database: FirestoreLike): Promise<{policy: EconomicsPolicy; scopes: string[]}> {
  const control = await loadEconomicsControl(Date.now(), database);
  const resolved = resolveEconomicsPolicy(control.policies, {cityKey});
  return {policy: resolved.policy, scopes: resolved.appliedScopes};
}

export async function simulateOfferForAdmin(
  token: DecodedIdToken,
  input: OfferSimulationRequest,
  database: FirestoreLike = firestoreDb,
): Promise<OfferSimulationResult & {policyScopes: string[]}> {
  requirePlatformConfigAdminClaim(token);
  const [{policy, scopes}, finance] = await Promise.all([cityPolicy(input.cityKey, database), loadFinancePolicy()]);
  return {
    ...simulateOffer({
      averageOrderValuePaise: input.averageOrderValuePaise,
      deliveryFeePaise: input.deliveryFeePaise,
      platformFeePaise: input.platformFeePaise,
      otherCustomerFeesPaise: 0,
      riderPayPerOrderPaise: input.riderPayPerOrderPaise,
      commissionBps: input.commissionBps ?? finance.restaurantCommissionBps,
      onlinePaymentShareBps: input.onlinePaymentShareBps,
      expectedOrders: input.expectedOrders,
      redemptionShareBps: input.redemptionShareBps,
      offer: input.offer,
    }, policy),
    policyScopes: scopes,
  };
}

export interface GuaranteeSimulationRequest {
  tiers: GuaranteeTier[];
  maxRiders: number;
  expectedRiders: number;
  minimumEarningPerDeliveryPaise: number;
  expectedEarningPerDeliveryPaise: number;
  budgetPaise: number;
  /** Expected contribution the covered orders generate, to show the net effect. */
  expectedOrders: number;
  contributionPerOrderPaise: number;
}

export function simulateGuarantee(input: GuaranteeSimulationRequest) {
  const estimate = guaranteeLiabilityEstimate(input);
  const orderContribution = Math.max(0, Math.round(input.expectedOrders)) * Math.round(input.contributionPerOrderPaise);
  const netExpected = orderContribution - estimate.expectedPaise;
  const netWorst = orderContribution - estimate.worstCasePaise;
  const verdict = netWorst >= 0 ? "safe" : netExpected >= 0 ? "below_target" : "unsafe";
  const message = verdict === "safe" ?
    `Safe: even in the worst case the covered orders still leave ${formatRupees(netWorst)}.` :
    verdict === "below_target" ?
      `Expected cost ${formatRupees(estimate.expectedPaise)} is covered, but the worst case (${formatRupees(estimate.worstCasePaise)}) would leave ${formatRupees(netWorst)}. Set a budget to cap it.` :
      `Unsafe: expected top-ups of ${formatRupees(estimate.expectedPaise)} exceed the ${formatRupees(orderContribution)} the covered orders earn.`;
  return {...estimate, expectedOrderContributionPaise: orderContribution, netExpectedPaise: netExpected, netWorstCasePaise: netWorst, verdict, message};
}

export async function simulateGuaranteeForAdmin(token: DecodedIdToken, input: GuaranteeSimulationRequest) {
  requirePlatformConfigAdminClaim(token);
  return simulateGuarantee(input);
}

// ---------------------------------------------------------------------------
// Promotions: validated writes only
// ---------------------------------------------------------------------------

export interface PromotionUpsertRequest {
  promotionId?: string;
  code: string;
  title: string;
  description: string;
  kind: "percent" | "flat";
  percent: number;
  flatAmountPaise: number;
  maxDiscountPaise: number;
  minimumOrderPaise: number;
  fundingSource: "restaurant" | "platform" | "shared";
  restaurantShareBps: number;
  restaurantIds: string[];
  cityKeys: string[];
  firstOrderOnly: boolean;
  perCustomerLimit: number;
  budgetPaise: number;
  growthBudgetId: string;
  startsAt: number;
  expiresAt: number;
  active: boolean;
  approvalStatus?: "approved" | "pending" | "rejected";
  /** Admin confirms customers will only get the profit-safe part of an unsafe offer. */
  acknowledgeLimitedFunding: boolean;
  simulation: Omit<OfferSimulationRequest, "offer" | "cityKey">;
}

function promotionDocument(id: string, input: PromotionUpsertRequest, existing: Record<string, unknown>, uid: string, now: number) {
  return {
    id,
    code: input.code.trim().toUpperCase(),
    title: input.title.trim(),
    description: input.description.trim(),
    kind: input.kind,
    percent: input.kind === "percent" ? input.percent : 0,
    flatAmountPaise: input.kind === "flat" ? input.flatAmountPaise : 0,
    maxDiscountPaise: input.maxDiscountPaise,
    minimumOrderPaise: input.minimumOrderPaise,
    // Kept in rupees too so older customer-app builds still render the offer.
    maxDiscount: input.maxDiscountPaise / 100,
    minimumOrder: input.minimumOrderPaise / 100,
    fundingSource: input.fundingSource,
    restaurantShareBps: input.fundingSource === "shared" ? input.restaurantShareBps : input.fundingSource === "restaurant" ? 10_000 : 0,
    restaurantIds: input.restaurantIds,
    cityKeys: input.cityKeys.map(economicsScopeKey).filter(Boolean),
    firstOrderOnly: input.firstOrderOnly,
    perCustomerLimit: input.perCustomerLimit,
    budgetPaise: input.budgetPaise,
    usedBudgetPaise: Number(existing.usedBudgetPaise ?? 0) || 0,
    growthBudgetId: input.growthBudgetId,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt || null,
    active: input.active,
    approvalStatus: input.approvalStatus ?? String(existing.approvalStatus ?? "approved"),
    createdByRestaurantId: String(existing.createdByRestaurantId ?? ""),
    createdAt: Number(existing.createdAt ?? now) || now,
    updatedAt: now,
    updatedBy: uid,
  };
}

export async function upsertPromotionForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: PromotionUpsertRequest,
  database: FirestoreLike = firestoreDb,
): Promise<{promotion: Record<string, unknown>; simulation: OfferSimulationResult}> {
  const role = requirePlatformConfigAdminClaim(token);
  if (input.fundingSource !== "platform" && input.restaurantIds.length === 0 && input.active) {
    // A restaurant's money can only be spent on an offer that names it.
    throw new DomainError("failed-precondition",
      "A restaurant-funded or shared offer must name the restaurants that agreed to fund it.");
  }
  const cityKey = input.cityKeys[0] ?? "";
  const simulation = await simulateOfferForAdmin(token, {...input.simulation, cityKey, offer: input}, database);
  if (input.active && simulation.verdict === "unsafe" && !input.growthBudgetId && !input.acknowledgeLimitedFunding) {
    throw new DomainError("failed-precondition", `${simulation.message} Lower the Scraveit-funded amount, attach an approved growth budget, or confirm that customers will only receive the safe part.`);
  }
  if (input.growthBudgetId) {
    const budget = await database.collection(GROWTH_BUDGETS_COLLECTION).doc(input.growthBudgetId).get();
    if (!budget.exists || !normalizeGrowthBudget(input.growthBudgetId, budget.data()).active) {
      throw new DomainError("failed-precondition", "That growth budget does not exist or is not active.");
    }
  }
  const now = Date.now();
  const id = input.promotionId || `promo_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ref = database.collection("promotions").doc(id);
  const duplicate = await database.collection("promotions").where("code", "==", input.code.trim().toUpperCase()).limit(5).get();
  if (duplicate.docs.some((doc) => doc.id !== id && (doc.data() as {active?: unknown}).active === true)) {
    throw new DomainError("already-exists", "Another active offer already uses this code.");
  }
  const promotion = await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const existing = (snapshot.exists ? snapshot.data() : {}) as Record<string, unknown>;
    const document = promotionDocument(id, input, existing, uid, now);
    transaction.set(ref, document);
    transaction.set(database.collection("audit").doc(`promotion_${id}_${now}`), {
      action: snapshot.exists ? "promotion.update" : "promotion.create",
      target: id,
      actorId: uid,
      actorRole: role,
      before: snapshot.exists ? existing : null,
      after: document,
      simulationVerdict: simulation.verdict,
      at: now,
    });
    return document;
  });
  logger.info("PROMOTION_UPSERTED", {promotionId: id, fundingSource: input.fundingSource, verdict: simulation.verdict});
  return {promotion, simulation};
}

// ---------------------------------------------------------------------------
// Growth budgets (owner only - a budget is permission to lose money)
// ---------------------------------------------------------------------------

export async function upsertGrowthBudgetForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: {budgetId?: string; name: string; cityKey: string; approvedPaise: number; validFrom: number; validUntil: number; active: boolean; reason: string},
  database: FirestoreLike = firestoreDb,
): Promise<GrowthBudget> {
  requireOwnerClaim(token);
  if (input.reason.trim().length < 3) throw new DomainError("invalid-argument", "Explain why this subsidy is approved.");
  const now = Date.now();
  const id = input.budgetId || `growth_${now.toString(36)}`;
  const ref = database.collection(GROWTH_BUDGETS_COLLECTION).doc(id);
  const saved = await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const existing = snapshot.exists ? normalizeGrowthBudget(id, snapshot.data()) : null;
    if (existing && input.approvedPaise < existing.spentPaise) {
      throw new DomainError("failed-precondition", `This budget has already spent ${formatRupees(existing.spentPaise)}.`);
    }
    const document = {
      id,
      name: input.name.trim(),
      cityKey: economicsScopeKey(input.cityKey),
      approvedPaise: input.approvedPaise,
      spentPaise: existing?.spentPaise ?? 0,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      active: input.active,
      approvedBy: uid,
      approvedByEmail: String(token.email ?? ""),
      reason: input.reason.trim(),
      updatedAt: now,
    };
    transaction.set(ref, document);
    transaction.set(database.collection("audit").doc(`growth_${id}_${now}`), {
      action: snapshot.exists ? "growth_budget.update" : "growth_budget.create",
      target: id,
      actorId: uid,
      before: existing,
      after: document,
      at: now,
    });
    return document;
  });
  return normalizeGrowthBudget(id, saved);
}

export async function listGrowthBudgetsForAdmin(token: DecodedIdToken, database: FirestoreLike = firestoreDb): Promise<GrowthBudget[]> {
  requirePlatformConfigAdminClaim(token);
  const snapshot = await database.collection(GROWTH_BUDGETS_COLLECTION).limit(100).get();
  return snapshot.docs.map((doc) => normalizeGrowthBudget(doc.id, doc.data()));
}

// ---------------------------------------------------------------------------
// Restaurant-created offers (always restaurant-funded)
// ---------------------------------------------------------------------------

async function requireRestaurantManager(uid: string, token: DecodedIdToken, restaurantId: string, database: FirestoreLike): Promise<void> {
  if (token.savrivoRole === "owner" || token.savrivoRole === "ops_admin") return;
  const [normalized, legacy] = await Promise.all([
    restaurantMemberRef(database, restaurantId, uid).get(),
    legacyStaffRef(database, uid).get(),
  ]);
  const allowed = (member: RestaurantMembership | null, source: "path-scoped" | "legacy-global") =>
    isActiveMembershipForRestaurant(member, restaurantId, source) &&
    (["restaurant_owner", "restaurant_manager"].includes(member?.role ?? "") || member?.permissions?.offers === true);
  if (allowed((normalized.exists ? normalized.data() : null) as RestaurantMembership | null, "path-scoped") ||
    allowed((legacy.exists ? legacy.data() : null) as RestaurantMembership | null, "legacy-global")) return;
  throw new DomainError("permission-denied", "Only the restaurant owner or manager can manage offers.");
}

export interface RestaurantOfferRequest {
  restaurantId: string;
  promotionId?: string;
  code: string;
  title: string;
  kind: "percent" | "flat";
  percent: number;
  flatAmountPaise: number;
  maxDiscountPaise: number;
  minimumOrderPaise: number;
  perCustomerLimit: number;
  startsAt: number;
  expiresAt: number;
  active: boolean;
}

export async function upsertRestaurantOffer(
  uid: string,
  token: DecodedIdToken,
  input: RestaurantOfferRequest,
  database: FirestoreLike = firestoreDb,
): Promise<{promotion: Record<string, unknown>; approvalStatus: string; youFundPaiseOnSample: number}> {
  await requireRestaurantManager(uid, token, input.restaurantId, database);
  const control = await loadEconomicsControl(Date.now(), database);
  if (!control.flags.restaurantOffers) throw new DomainError("failed-precondition", "Restaurant offers are paused right now.");
  const restaurant = await restaurantRef(database, input.restaurantId).get();
  if (!restaurant.exists) throw new DomainError("not-found", "Restaurant not found.");
  const cityKey = economicsScopeKey((restaurant.data() as {city?: unknown}).city);
  const now = Date.now();
  const id = input.promotionId || `rpromo_${input.restaurantId.slice(0, 20)}_${now.toString(36)}`;
  const ref = database.collection("promotions").doc(id);
  const auto = control.restaurantOfferAutoApproval;
  const withinAuto = auto.enabled &&
    (input.kind === "percent" ? input.percent <= auto.maxPercent : true) &&
    (input.maxDiscountPaise > 0 ? input.maxDiscountPaise : input.flatAmountPaise) <= auto.maxDiscountPaise;
  const code = input.code.trim().toUpperCase();
  const duplicate = await database.collection("promotions").where("code", "==", code).limit(5).get();
  if (duplicate.docs.some((doc) => doc.id !== id && (doc.data() as {active?: unknown}).active === true)) {
    throw new DomainError("already-exists", "Another active offer already uses this code. Choose a different code.");
  }
  const promotion = await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    const existing = (snapshot.exists ? snapshot.data() : {}) as Record<string, unknown>;
    if (snapshot.exists && existing.createdByRestaurantId !== input.restaurantId) {
      throw new DomainError("permission-denied", "This offer belongs to someone else.");
    }
    const previouslyApproved = existing.approvalStatus === "approved";
    const termsChanged = !snapshot.exists || ["kind", "percent", "flatAmountPaise", "maxDiscountPaise", "minimumOrderPaise"]
      .some((field) => existing[field] !== (input as unknown as Record<string, unknown>)[field]);
    const approvalStatus = previouslyApproved && !termsChanged ? "approved" : withinAuto ? "approved" : "pending";
    const document = {
      id,
      code,
      title: input.title.trim(),
      description: "",
      kind: input.kind,
      percent: input.kind === "percent" ? input.percent : 0,
      flatAmountPaise: input.kind === "flat" ? input.flatAmountPaise : 0,
      maxDiscountPaise: input.maxDiscountPaise,
      minimumOrderPaise: input.minimumOrderPaise,
      maxDiscount: input.maxDiscountPaise / 100,
      minimumOrder: input.minimumOrderPaise / 100,
      // A restaurant can only ever spend its own money.
      fundingSource: "restaurant",
      restaurantShareBps: 10_000,
      restaurantIds: [input.restaurantId],
      cityKeys: cityKey ? [cityKey] : [],
      firstOrderOnly: false,
      perCustomerLimit: input.perCustomerLimit,
      budgetPaise: 0,
      usedBudgetPaise: 0,
      growthBudgetId: "",
      startsAt: input.startsAt,
      expiresAt: input.expiresAt || null,
      active: input.active,
      approvalStatus,
      createdByRestaurantId: input.restaurantId,
      createdAt: Number(existing.createdAt ?? now) || now,
      updatedAt: now,
      updatedBy: uid,
    };
    transaction.set(ref, document);
    transaction.set(database.collection("audit").doc(`rpromo_${id}_${now}`), {
      action: snapshot.exists ? "restaurant_offer.update" : "restaurant_offer.create",
      target: id,
      restaurantId: input.restaurantId,
      actorId: uid,
      approvalStatus,
      at: now,
    });
    return document;
  });
  const sample = normalizePromotionTerms(id, promotion);
  return {
    promotion,
    approvalStatus: String(promotion.approvalStatus),
    youFundPaiseOnSample: splitDiscountByFunding(sample, promotionDiscountPaise(sample, Math.max(sample.minimumOrderPaise, 30_000))).restaurantPaise,
  };
}

export async function listRestaurantOffers(
  uid: string,
  token: DecodedIdToken,
  restaurantId: string,
  database: FirestoreLike = firestoreDb,
): Promise<{
  offers: PromotionTerms[];
  autoApproval: {enabled: boolean; maxPercent: number; maxDiscountPaise: number};
  /** The commission this restaurant pays right now, for its "you get" figures. */
  commissionBps: number;
  commissionSource: "plan" | "restaurant" | "default";
}> {
  await requireRestaurantManager(uid, token, restaurantId, database);
  const now = Date.now();
  const [snapshot, control, restaurant, finance] = await Promise.all([
    database.collection("promotions").where("createdByRestaurantId", "==", restaurantId).limit(50).get(),
    loadEconomicsControl(now, database),
    restaurantRef(database, restaurantId).get(),
    loadFinancePolicy(now, database),
  ]);
  const plan = activeCommercialPlan(control.commercialPlans[restaurantId] ?? [], now);
  const own = (restaurant.exists ? restaurant.data() : {}) as {commissionBps?: number};
  const fallback = finance.restaurantCommissionBps;
  const commissionBps = plan ? plan.commissionBps : restaurantCommissionBps(own, fallback);
  return {
    offers: snapshot.docs.map((doc) => normalizePromotionTerms(doc.id, doc.data())),
    autoApproval: control.restaurantOfferAutoApproval,
    commissionBps,
    commissionSource: plan ? "plan" : restaurantCommissionBps(own, -1) >= 0 ? "restaurant" : "default",
  };
}

export async function reviewRestaurantOfferForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: {promotionId: string; decision: "approved" | "rejected"; reason: string},
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  const role = requirePlatformConfigAdminClaim(token);
  const ref = database.collection("promotions").doc(input.promotionId);
  const now = Date.now();
  await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new DomainError("not-found", "Offer not found.");
    transaction.set(ref, {
      approvalStatus: input.decision,
      ...(input.decision === "rejected" ? {active: false} : {}),
      reviewedBy: uid,
      reviewReason: input.reason.slice(0, 300),
      reviewedAt: now,
      updatedAt: now,
    }, {merge: true});
    transaction.set(database.collection("audit").doc(`offer_review_${input.promotionId}_${now}`), {
      action: `restaurant_offer.${input.decision}`,
      target: input.promotionId,
      actorId: uid,
      actorRole: role,
      reason: input.reason.slice(0, 300),
      at: now,
    });
  });
}

// ---------------------------------------------------------------------------
// City economics dashboard
// ---------------------------------------------------------------------------

export const CITY_ECONOMICS_MAX_ORDERS = 5_000;

export interface ZoneEconomics {
  zoneKey: string;
  orders: number;
  delivered: number;
  gmvPaise: number;
  revenuePaise: number;
  promoCostPaise: number;
  riderCostPaise: number;
  refundCostPaise: number;
  contributionPaise: number;
  contributionPerOrderPaise: number;
  averageDeliveryMeters: number;
  repeatProfitableOrders: number;
}

export interface CityEconomicsSummary {
  cityKey: string;
  startAt: number;
  endAt: number;
  complete: boolean;
  orders: {placed: number; delivered: number; cancelled: number; open: number};
  gmvPaise: number;
  revenue: {
    commissionPaise: number;
    platformFeePaise: number;
    deliveryFeePaise: number;
    surchargePaise: number;
    grossPlatformRevenuePaise: number;
  };
  costs: {
    riderTripPayPaise: number;
    riderPerOrderIncentivePaise: number;
    paymentCostPaise: number;
    refundReservePaise: number;
    supportAndOtherPaise: number;
    platformDiscountPaise: number;
    growthSubsidyPaise: number;
    riderMilestoneBonusPaise: number;
    guaranteeTopUpPaise: number;
    riderReferralPaise: number;
    cashbackPaise: number;
    customerReferralPaise: number;
    walletBreakagePaise: number;
  };
  /** Customer delivery fees minus rider trip pay: negative means delivery is subsidised. */
  deliveryMarginPaise: number;
  restaurantFundedDiscountPaise: number;
  restaurantReceivablePaise: number;
  tipsPaise: number;
  taxPaise: number;
  refundsPaidPaise: number;
  /** Delivered orders' own contribution (operating, growth subsidy excluded). */
  operatingContributionPaise: number;
  /** After period-level rider and customer-reward costs attributed to this city. */
  netContributionPaise: number;
  /** Net after the growth-budget subsidies. */
  netCashImpactPaise: number;
  contributionPerOrderPaise: number;
  contributionBpsOfGmv: number;
  reserves: {operatingReservePaise: number; expansionReservePaise: number; riskReservePaise: number; distributablePaise: number};
  /** Legacy entries (written before city attribution existed) are kept out of the city figures. */
  unattributedCostPaise: number;
  unsafeOrders: number;
  repeatOrders: number;
  contributionPositiveRepeatOrders: number;
  activeZones: number;
  days: number;
  /** Contribution-positive repeat orders per active zone per day. */
  northStar: number;
  averageDeliveryMeters: number;
  zones: ZoneEconomics[];
  riders?: {onlineNow: number; approxOnlineHours: number; ordersPerRiderHour: number | null};
  pnl?: CityProfitAndLoss;
  operatingCosts?: CityOperatingCost[];
}

function cleanJournal(value: unknown): LedgerJournal | null {
  try {
    validateLedgerJournal(value as LedgerJournal);
    return value as LedgerJournal;
  } catch {
    return null;
  }
}

function accountMovement(journal: LedgerJournal, prefix: string, side: "credit" | "debit"): number {
  return journal.entries.reduce((total, entry) =>
    entry.accountId.startsWith(prefix) && entry.side === side ? total + entry.amountPaise : total, 0);
}

function riderEarningsCredit(journal: LedgerJournal): number {
  return accountMovement(journal, "liability:rider-earnings:", "credit") - accountMovement(journal, "liability:rider-earnings:", "debit");
}

type EconomicsRecord = {
  orderId?: string;
  customerId: string;
  outcome: string;
  createdAt: number;
  distanceMeters?: number;
  snapshot: OrderEconomicsSnapshot;
  riderFinal?: {totalPaise?: number};
};

export function summarizeCityEconomics(input: {
  cityKey: string;
  startAt: number;
  endAt: number;
  records: readonly EconomicsRecord[];
  journals: readonly LedgerJournal[];
  policy: EconomicsPolicy;
  truncated: boolean;
}): CityEconomicsSummary {
  const orders = {placed: 0, delivered: 0, cancelled: 0, open: 0};
  let gmvPaise = 0;
  const revenue = {commissionPaise: 0, platformFeePaise: 0, deliveryFeePaise: 0, surchargePaise: 0, grossPlatformRevenuePaise: 0};
  const costs = {
    riderTripPayPaise: 0, riderPerOrderIncentivePaise: 0, paymentCostPaise: 0, refundReservePaise: 0,
    supportAndOtherPaise: 0, platformDiscountPaise: 0, growthSubsidyPaise: 0,
    riderMilestoneBonusPaise: 0, guaranteeTopUpPaise: 0, riderReferralPaise: 0,
    cashbackPaise: 0, customerReferralPaise: 0, walletBreakagePaise: 0,
  };
  let restaurantFundedDiscountPaise = 0;
  let restaurantReceivablePaise = 0;
  let tipsPaise = 0;
  let taxPaise = 0;
  let operatingContributionPaise = 0;
  let deliveryMarginPaise = 0;
  let unsafeOrders = 0;
  let distanceTotal = 0;
  let distanceCount = 0;
  const zones = new Map<string, ZoneEconomics & {distanceTotal: number; distanceCount: number}>();
  const zoneOfOrder = new Map<string, string>();
  const deliveredByCustomer = new Map<string, {createdAt: number; positive: boolean; zoneKey: string}[]>();

  for (const record of input.records) {
    orders.placed += 1;
    if (record.outcome === "cancelled") { orders.cancelled += 1; continue; }
    if (record.outcome !== "delivered") { orders.open += 1; continue; }
    orders.delivered += 1;
    const s = record.snapshot;
    // The rider's final trip pay (real pickup distance and wait) replaces the
    // checkout estimate once the delivery settled.
    const finalTrip = Number(record.riderFinal?.totalPaise);
    const tripPay = Number.isFinite(finalTrip) && finalTrip >= 0 ? finalTrip : s.rider.deliveryPayPaise;
    const tripAdjustment = tripPay - s.rider.deliveryPayPaise;
    const contribution = s.platform.contributionPaise - tripAdjustment;
    gmvPaise += s.customer.payablePaise + (s.customer.walletRedeemPaise ?? 0);
    revenue.commissionPaise += s.restaurant.commissionPaise;
    revenue.platformFeePaise += s.customer.platformFeePaise;
    revenue.deliveryFeePaise += s.customer.deliveryFeePaise;
    revenue.surchargePaise += s.customer.smallOrderFeePaise + s.customer.lateNightFeePaise + s.customer.rainFeePaise +
      s.customer.surgeFeePaise + s.customer.riderIncentiveFeePaise;
    revenue.grossPlatformRevenuePaise += s.platform.grossRevenuePaise;
    costs.riderTripPayPaise += tripPay;
    costs.riderPerOrderIncentivePaise += s.rider.incentivePayPaise;
    costs.paymentCostPaise += s.platform.paymentCostPaise;
    costs.refundReservePaise += s.platform.refundReservePaise;
    costs.supportAndOtherPaise += s.platform.supportCostPaise + s.platform.otherVariableCostPaise;
    costs.platformDiscountPaise += s.customer.platformDiscountPaise;
    costs.growthSubsidyPaise += s.platform.growthSubsidyPaise;
    deliveryMarginPaise += s.customer.deliveryFeePaise - tripPay;
    restaurantFundedDiscountPaise += s.customer.restaurantDiscountPaise;
    restaurantReceivablePaise += s.restaurant.receivablePaise;
    tipsPaise += s.customer.tipPaise;
    taxPaise += s.customer.taxPaise;
    operatingContributionPaise += s.platform.operatingContributionPaise - tripAdjustment;
    if (s.guardrail.verdict === "unsafe") unsafeOrders += 1;
    const meters = Number(record.distanceMeters ?? s.rider.tripPay?.dropMeters ?? NaN);
    const zoneKey = s.zoneKey || "unzoned";
    if (record.orderId) zoneOfOrder.set(record.orderId, zoneKey);
    const zone = zones.get(zoneKey) ?? {
      zoneKey, orders: 0, delivered: 0, gmvPaise: 0, revenuePaise: 0, promoCostPaise: 0, riderCostPaise: 0,
      refundCostPaise: 0, contributionPaise: 0, contributionPerOrderPaise: 0, averageDeliveryMeters: 0,
      repeatProfitableOrders: 0, distanceTotal: 0, distanceCount: 0,
    };
    zone.orders += 1;
    zone.delivered += 1;
    zone.gmvPaise += s.customer.payablePaise + (s.customer.walletRedeemPaise ?? 0);
    zone.revenuePaise += s.platform.grossRevenuePaise;
    zone.promoCostPaise += s.customer.platformDiscountPaise;
    zone.riderCostPaise += tripPay + s.rider.incentivePayPaise;
    zone.contributionPaise += contribution;
    if (Number.isFinite(meters)) {
      zone.distanceTotal += meters; zone.distanceCount += 1;
      distanceTotal += meters; distanceCount += 1;
    }
    zones.set(zoneKey, zone);
    const list = deliveredByCustomer.get(record.customerId) ?? [];
    list.push({createdAt: record.createdAt, positive: contribution > 0, zoneKey});
    deliveredByCustomer.set(record.customerId, list);
  }

  let refundsPaidPaise = 0;
  let unattributedCostPaise = 0;
  for (const journal of input.journals) {
    const journalCity = String(journal.metadata.cityKey ?? "");
    const attributed = !input.cityKey || journalCity === input.cityKey;
    const legacy = input.cityKey !== "" && journalCity === "";
    if (journal.eventType === "refund") {
      // Refunds carry the order id; a refund belongs to this city when its order does.
      if (journal.orderId && zoneOfOrder.has(journal.orderId)) {
        refundsPaidPaise += journal.debitTotalPaise;
        const zone = zones.get(zoneOfOrder.get(journal.orderId)!);
        if (zone) zone.refundCostPaise += journal.debitTotalPaise;
      } else if (!input.cityKey) {
        refundsPaidPaise += journal.debitTotalPaise;
      }
      continue;
    }
    let amount = 0;
    let bucket: keyof typeof costs | null = null;
    if (journal.eventType === "rider_incentive") {
      amount = Math.max(0, riderEarningsCredit(journal));
      if (journal.metadata.payoutMode === "earnings_guarantee") bucket = "guaranteeTopUpPaise";
      else if (journal.metadata.settlementType === "period_close") bucket = "riderMilestoneBonusPaise";
      // Per-order bonuses are already in each order's own snapshot.
    } else if (journal.eventType === "rider_referral_reward") {
      amount = Math.max(0, riderEarningsCredit(journal));
      bucket = "riderReferralPaise";
    } else if (journal.eventType === "cashback_earned") {
      amount = accountMovement(journal, "expense:cashback", "debit");
      bucket = "cashbackPaise";
    } else if (journal.eventType === "cashback_reversed") {
      amount = -accountMovement(journal, "expense:cashback", "credit");
      bucket = "cashbackPaise";
    } else if (journal.eventType === "customer_referral_reward") {
      amount = accountMovement(journal, "expense:customer-referrals", "debit");
      bucket = "customerReferralPaise";
    } else if (journal.eventType === "wallet_expired") {
      amount = accountMovement(journal, "revenue:wallet-breakage", "credit");
      bucket = "walletBreakagePaise";
    }
    if (!bucket || amount === 0) continue;
    if (legacy) { unattributedCostPaise += amount; continue; }
    if (attributed) costs[bucket] += amount;
  }

  let repeatOrders = 0;
  let contributionPositiveRepeatOrders = 0;
  for (const list of deliveredByCustomer.values()) {
    list.sort((left, right) => left.createdAt - right.createdAt).slice(1).forEach((entry) => {
      repeatOrders += 1;
      if (entry.positive) {
        contributionPositiveRepeatOrders += 1;
        const zone = zones.get(entry.zoneKey);
        if (zone) zone.repeatProfitableOrders += 1;
      }
    });
  }
  const periodLevelCosts = costs.riderMilestoneBonusPaise + costs.guaranteeTopUpPaise + costs.riderReferralPaise +
    costs.cashbackPaise + costs.customerReferralPaise - costs.walletBreakagePaise;
  const netContributionPaise = operatingContributionPaise - periodLevelCosts;
  const netCashImpactPaise = netContributionPaise - costs.growthSubsidyPaise;
  const days = Math.max(1, Math.ceil((input.endAt - input.startAt) / 86_400_000));
  const activeZones = zones.size;
  return {
    cityKey: input.cityKey,
    startAt: input.startAt,
    endAt: input.endAt,
    complete: !input.truncated,
    orders,
    gmvPaise,
    revenue,
    costs,
    deliveryMarginPaise,
    restaurantFundedDiscountPaise,
    restaurantReceivablePaise,
    tipsPaise,
    taxPaise,
    refundsPaidPaise,
    operatingContributionPaise,
    netContributionPaise,
    netCashImpactPaise,
    contributionPerOrderPaise: orders.delivered ? Math.round(netContributionPaise / orders.delivered) : 0,
    contributionBpsOfGmv: gmvPaise > 0 ? Math.round(netContributionPaise * 10_000 / gmvPaise) : 0,
    reserves: allocateReserves(netCashImpactPaise, input.policy),
    unattributedCostPaise,
    unsafeOrders,
    repeatOrders,
    contributionPositiveRepeatOrders,
    activeZones,
    days,
    northStar: activeZones ? Math.round(contributionPositiveRepeatOrders * 100 / (activeZones * days)) / 100 : 0,
    averageDeliveryMeters: distanceCount ? Math.round(distanceTotal / distanceCount) : 0,
    zones: [...zones.values()].map(({distanceTotal: total, distanceCount: count, ...zone}) => ({
      ...zone,
      contributionPerOrderPaise: zone.delivered ? Math.round(zone.contributionPaise / zone.delivered) : 0,
      averageDeliveryMeters: count ? Math.round(total / count) : 0,
    })).sort((left, right) => right.gmvPaise - left.gmvPaise),
  };
}

/**
 * Rider supply for the city: riders online right now (availability index)
 * and an approximate number of online hours in the period, from each rider's
 * first-to-last presence per day. Riders are not zoned, so these are city-level.
 */
async function citySupply(
  database: FirestoreLike,
  cityKey: string,
  startAt: number,
  endAt: number,
  delivered: number,
): Promise<{onlineNow: number; approxOnlineHours: number; ordersPerRiderHour: number | null}> {
  if (!cityKey) return {onlineNow: 0, approxOnlineHours: 0, ordersPerRiderHour: null};
  const [availability, riders] = await Promise.all([
    database.collection("riderAvailability").where("cityKey", "==", cityKey).limit(1_000).get().catch(() => null),
    database.collection("riders").where("status", "==", "approved").limit(1_000).get().catch(() => null),
  ]);
  const now = Date.now();
  const onlineNow = (availability?.docs ?? []).filter((doc) => {
    const data = doc.data() as {online?: unknown; updatedAt?: unknown; lastSeenAt?: unknown};
    return data.online === true && now - Number(data.updatedAt ?? data.lastSeenAt ?? 0) < 120_000;
  }).length;
  const cityRiders = (riders?.docs ?? []).filter((doc) =>
    economicsScopeKey((doc.data() as {city?: unknown}).city) === cityKey).map((doc) => doc.id).slice(0, 300);
  let onlineMs = 0;
  const startDay = new Date(startAt + 330 * 60_000).toISOString().slice(0, 10);
  const endDay = new Date(endAt - 1 + 330 * 60_000).toISOString().slice(0, 10);
  await Promise.all(cityRiders.map(async (riderId) => {
    const days = await database.collection("private").doc("riderRewards").collection("sessionDays")
      .doc(riderId).collection("days").get().catch(() => null);
    for (const day of days?.docs ?? []) {
      if (day.id < startDay || day.id > endDay) continue;
      const data = day.data() as {firstSeenAt?: unknown; lastSeenAt?: unknown};
      const span = Number(data.lastSeenAt ?? 0) - Number(data.firstSeenAt ?? 0);
      if (span > 0 && span < 86_400_000) onlineMs += span;
    }
  }));
  const approxOnlineHours = Math.round(onlineMs / 36_000) / 100;
  return {onlineNow, approxOnlineHours, ordersPerRiderHour: approxOnlineHours > 0 ? Math.round(delivered * 100 / approxOnlineHours) / 100 : null};
}

export async function readCityEconomics(
  token: DecodedIdToken,
  input: {cityKey: string; startAt: number; endAt: number},
  database: FirestoreLike = firestoreDb,
): Promise<CityEconomicsSummary> {
  requirePlatformConfigAdminClaim(token);
  const cityKey = economicsScopeKey(input.cityKey);
  const base = database.collection(ORDER_ECONOMICS_COLLECTION);
  const query = cityKey ?
    base.where("cityKey", "==", cityKey).where("createdAt", ">=", input.startAt).where("createdAt", "<", input.endAt) :
    base.where("createdAt", ">=", input.startAt).where("createdAt", "<", input.endAt);
  const [orders, journals, control, costs] = await Promise.all([
    query.orderBy("createdAt", "asc").limit(CITY_ECONOMICS_MAX_ORDERS + 1).get(),
    database.collection(LEDGER_JOURNALS_COLLECTION)
      .where("occurredAt", ">=", input.startAt)
      .where("occurredAt", "<=", input.endAt - 1)
      .orderBy("occurredAt", "asc")
      .limit(CITY_ECONOMICS_MAX_ORDERS * 3)
      .get(),
    loadEconomicsControl(Date.now(), database),
    readOperatingCosts(database, cityKey),
  ]);
  const records = orders.docs.slice(0, CITY_ECONOMICS_MAX_ORDERS).map((doc) => ({
    orderId: doc.id,
    ...(doc.data() as Omit<EconomicsRecord, "orderId">),
  })).filter((entry) => entry.snapshot && entry.snapshot.calculationVersion === 1);
  const ledger = journals.docs.map((doc) => cleanJournal(doc.data())).filter((entry): entry is LedgerJournal => entry !== null);
  const summary = summarizeCityEconomics({
    cityKey,
    startAt: input.startAt,
    endAt: input.endAt,
    records,
    journals: ledger,
    policy: resolveEconomicsPolicy(control.policies, {cityKey}).policy,
    truncated: orders.docs.length > CITY_ECONOMICS_MAX_ORDERS || journals.docs.length >= CITY_ECONOMICS_MAX_ORDERS * 3,
  });
  const riders = await citySupply(database, cityKey, input.startAt, input.endAt, summary.orders.delivered);
  const pnl = cityProfitAndLoss({
    startAt: input.startAt,
    endAt: input.endAt,
    // Growth investment is taken off separately, so contribution here is before it.
    grossContributionPaise: summary.netContributionPaise,
    growthInvestmentPaise: summary.costs.growthSubsidyPaise,
    costs,
    policy: resolveCityFinancePolicy(control.cityFinance, cityKey),
  });
  return {...summary, riders, pnl, operatingCosts: costs};
}

// ---------------------------------------------------------------------------
// City fixed operating costs
// ---------------------------------------------------------------------------

export const OPERATING_COSTS = "cityOperatingCosts";

async function readOperatingCosts(database: FirestoreLike, cityKey: string): Promise<CityOperatingCost[]> {
  const base = database.collection(OPERATING_COSTS);
  const snapshot = await (cityKey ? base.where("cityKey", "==", cityKey).limit(500) : base.limit(1_000)).get();
  return snapshot.docs.map((doc) => normalizeOperatingCost(doc.id, doc.data()));
}

export async function listOperatingCostsForAdmin(token: DecodedIdToken, cityKey: string, database: FirestoreLike = firestoreDb) {
  requirePlatformConfigAdminClaim(token);
  return readOperatingCosts(database, economicsScopeKey(cityKey));
}

export async function upsertOperatingCostForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: Record<string, unknown> & {costId?: string; reason: string},
  database: FirestoreLike = firestoreDb,
): Promise<CityOperatingCost> {
  const role = requirePlatformConfigAdminClaim(token);
  const now = Date.now();
  const id = String(input.costId || `cost_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const cost = normalizeOperatingCost(id, input);
  if (!cost.cityKey) throw new DomainError("invalid-argument", "Choose the city this cost belongs to.");
  if (cost.amountPaise <= 0) throw new DomainError("invalid-argument", "Enter the amount.");
  if (!cost.startAt) throw new DomainError("invalid-argument", "Enter the start date.");
  const ref = database.collection(OPERATING_COSTS).doc(id);
  await database.runTransaction(async (transaction: TransactionLike) => {
    const existing = await transaction.get(ref);
    transaction.set(ref, {...cost, updatedAt: now, updatedBy: uid});
    transaction.set(database.collection("audit").doc(`opcost_${id}_${now}`), {
      action: existing.exists ? "operating_cost.update" : "operating_cost.create",
      target: id, actorId: uid, actorRole: role, reason: String(input.reason ?? "").slice(0, 500),
      before: existing.exists ? existing.data() : null, after: cost, at: now,
    });
  });
  return cost;
}

// ---------------------------------------------------------------------------
// Break-even / forecast calculator
// ---------------------------------------------------------------------------

/**
 * Break-even for a city. Any input left out defaults to the city's real
 * figures over the last 30 days (per-order averages) and its configured fixed
 * costs, so the answer reflects actual economics rather than a sample.
 */
export async function breakEvenForAdmin(
  token: DecodedIdToken,
  input: Partial<BreakEvenInput> & {cityKey: string},
  database: FirestoreLike = firestoreDb,
): Promise<{inputs: BreakEvenInput; result: BreakEvenResult; basedOnDeliveredOrders: number}> {
  requirePlatformConfigAdminClaim(token);
  const cityKey = economicsScopeKey(input.cityKey);
  const endAt = Date.now();
  const startAt = endAt - 30 * 86_400_000;
  const summary = await readCityEconomics(token, {cityKey, startAt, endAt}, database);
  const delivered = Math.max(1, summary.orders.delivered);
  const per = (paise: number) => Math.round(paise / delivered);
  const control = await loadEconomicsControl(Date.now(), database);
  const cityFinance = resolveCityFinancePolicy(control.cityFinance, cityKey);
  const policy = resolveEconomicsPolicy(control.policies, {cityKey}).policy;
  const monthStart = startAt;
  const fixedMonthly = Math.round((summary.operatingCosts ?? []).reduce((total, cost) =>
    total + operatingCostsByCategory([cost], monthStart, monthStart + 30 * 86_400_000).totalPaise, 0));
  const itemsPerOrder = summary.orders.delivered ?
    per(summary.gmvPaise - summary.tipsPaise - summary.taxPaise - summary.revenue.platformFeePaise -
      summary.revenue.deliveryFeePaise - summary.revenue.surchargePaise) : 30_000;
  const defaults: BreakEvenInput = {
    ordersPerDay: summary.orders.delivered ? Math.round(summary.orders.delivered / 30) : 100,
    averageOrderValuePaise: Math.max(0, itemsPerOrder),
    commissionBps: summary.orders.delivered && itemsPerOrder > 0 ?
      Math.round(per(summary.revenue.commissionPaise) * 10_000 / itemsPerOrder) : 1_500,
    customerFeesPerOrderPaise: summary.orders.delivered ?
      per(summary.revenue.platformFeePaise + summary.revenue.deliveryFeePaise + summary.revenue.surchargePaise) : 3_200,
    riderCostPerOrderPaise: summary.orders.delivered ?
      per(summary.costs.riderTripPayPaise + summary.costs.riderPerOrderIncentivePaise + summary.costs.riderMilestoneBonusPaise +
        summary.costs.guaranteeTopUpPaise) : 3_400,
    promoCostPerOrderPaise: summary.orders.delivered ?
      per(summary.costs.platformDiscountPaise + summary.costs.cashbackPaise + summary.costs.customerReferralPaise) : 0,
    paymentCostBps: policy.paymentGatewayCostBps,
    refundRateBps: policy.refundReserveBpsOfGmv,
    otherVariableCostPerOrderPaise: policy.supportCostPaisePerOrder + policy.otherVariableCostPaisePerOrder,
    fixedMonthlyCostPaise: fixedMonthly,
    riskReserveBps: cityFinance.riskReserveBps,
    workingCapitalReserveBps: cityFinance.workingCapitalReserveBps,
    expansionBps: cityFinance.expansionBps,
  };
  const inputs: BreakEvenInput = {...defaults};
  for (const key of Object.keys(defaults) as (keyof BreakEvenInput)[]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) (inputs as unknown as Record<string, number>)[key] = value;
  }
  return {inputs, result: breakEven(inputs), basedOnDeliveredOrders: summary.orders.delivered};
}

// ---------------------------------------------------------------------------
// Restaurant offer performance (restaurant managers see only their own)
// ---------------------------------------------------------------------------

export interface RestaurantOfferPerformance {
  promotionId: string;
  code: string;
  title: string;
  fundingSource: string;
  restaurantShareBps: number;
  createdByRestaurant: boolean;
  orders: number;
  delivered: number;
  cancelled: number;
  salesPaise: number;
  restaurantFundedPaise: number;
  platformFundedPaise: number;
  newCustomers: number;
}

export async function readRestaurantOfferPerformance(
  uid: string,
  token: DecodedIdToken,
  input: {restaurantId: string; days: number},
  database: FirestoreLike = firestoreDb,
): Promise<{
  restaurantId: string;
  days: number;
  totals: {orders: number; delivered: number; salesPaise: number; commissionPaise: number; restaurantFundedDiscountPaise: number;
    platformFundedDiscountPaise: number; restaurantFundedCashbackPaise: number; netEarningsPaise: number; ordersWithOffers: number};
  offers: RestaurantOfferPerformance[];
  sharedOffers: {promotionId: string; code: string; title: string; restaurantShareBps: number; active: boolean}[];
}> {
  await requireRestaurantManager(uid, token, input.restaurantId, database);
  const days = Math.max(1, Math.min(90, Math.round(input.days)));
  const since = Date.now() - days * 86_400_000;
  const [records, own, named] = await Promise.all([
    database.collection(ORDER_ECONOMICS_COLLECTION).where("restaurantId", "==", input.restaurantId)
      .where("createdAt", ">=", since).orderBy("createdAt", "asc").limit(CITY_ECONOMICS_MAX_ORDERS).get(),
    database.collection("promotions").where("createdByRestaurantId", "==", input.restaurantId).limit(50).get(),
    database.collection("promotions").where("restaurantIds", "array-contains", input.restaurantId).limit(50).get(),
  ]);
  const promotions = new Map<string, PromotionTerms>();
  for (const doc of [...own.docs, ...named.docs]) promotions.set(doc.id, normalizePromotionTerms(doc.id, doc.data()));
  const byOffer = new Map<string, RestaurantOfferPerformance>();
  const firstOrderByCustomer = new Map<string, number>();
  const totals = {orders: 0, delivered: 0, salesPaise: 0, commissionPaise: 0, restaurantFundedDiscountPaise: 0,
    platformFundedDiscountPaise: 0, restaurantFundedCashbackPaise: 0, netEarningsPaise: 0, ordersWithOffers: 0};
  const rows = records.docs.map((doc) => doc.data() as EconomicsRecord & {cashback?: {restaurantFundedPaise?: number}});
  for (const row of rows) {
    const at = firstOrderByCustomer.get(row.customerId);
    if (at === undefined || row.createdAt < at) firstOrderByCustomer.set(row.customerId, row.createdAt);
  }
  for (const row of rows) {
    const s = row.snapshot;
    if (!s) continue;
    totals.orders += 1;
    const delivered = row.outcome === "delivered";
    if (delivered) {
      totals.delivered += 1;
      totals.salesPaise += s.customer.itemSubtotalPaise;
      totals.commissionPaise += s.restaurant.commissionPaise;
      totals.restaurantFundedDiscountPaise += s.customer.restaurantDiscountPaise;
      totals.platformFundedDiscountPaise += s.customer.platformDiscountPaise;
      const cashback = Number(row.cashback?.restaurantFundedPaise ?? 0);
      totals.restaurantFundedCashbackPaise += cashback;
      totals.netEarningsPaise += s.restaurant.receivablePaise - cashback;
    }
    const promotionRule = (s as OrderEconomicsSnapshot & {ruleIds?: string[]}).ruleIds?.find((rule) => rule.startsWith("promotion:"));
    if (!promotionRule) continue;
    totals.ordersWithOffers += 1;
    const promotionId = promotionRule.slice("promotion:".length);
    const terms = promotions.get(promotionId);
    const entry = byOffer.get(promotionId) ?? {
      promotionId, code: terms?.code ?? promotionId, title: terms?.title ?? "", fundingSource: terms?.fundingSource ?? "",
      restaurantShareBps: terms?.restaurantShareBps ?? 0, createdByRestaurant: terms?.createdByRestaurantId === input.restaurantId,
      orders: 0, delivered: 0, cancelled: 0, salesPaise: 0, restaurantFundedPaise: 0, platformFundedPaise: 0, newCustomers: 0,
    };
    entry.orders += 1;
    if (row.outcome === "cancelled") entry.cancelled += 1;
    if (delivered) {
      entry.delivered += 1;
      entry.salesPaise += s.customer.itemSubtotalPaise;
      entry.restaurantFundedPaise += s.customer.restaurantDiscountPaise;
      entry.platformFundedPaise += s.customer.platformDiscountPaise;
    }
    if (firstOrderByCustomer.get(row.customerId) === row.createdAt) entry.newCustomers += 1;
    byOffer.set(promotionId, entry);
  }
  return {
    restaurantId: input.restaurantId,
    days,
    totals,
    offers: [...byOffer.values()].sort((left, right) => right.salesPaise - left.salesPaise),
    sharedOffers: named.docs.map((doc) => normalizePromotionTerms(doc.id, doc.data()))
      .filter((terms) => terms.createdByRestaurantId !== input.restaurantId && terms.fundingSource !== "platform")
      .map((terms) => ({promotionId: terms.id, code: terms.code, title: terms.title,
        restaurantShareBps: terms.fundingSource === "restaurant" ? 10_000 : terms.restaurantShareBps, active: terms.active})),
  };
}
