/**
 * Scraveit's one authoritative economics engine.
 *
 * Everything here is pure and works in integer paise - never floating rupees -
 * so the same inputs always produce the same snapshot, byte for byte, and a
 * snapshot frozen onto an order at checkout can be recomputed later to prove
 * nothing was altered. Apps only ever display what this produces.
 *
 * Money model (per order):
 *
 *   customer pays   = items - restaurantDiscount - platformDiscount
 *                     + delivery + platform/small-order/late-night/rain/surge/
 *                       rider-incentive fees + tax + tip
 *   restaurant gets = (items - restaurantDiscount) - commission
 *   rider gets      = delivery pay + per-order incentives + tip (tip is 100% rider)
 *   government      = tax (a pass-through liability, never revenue)
 *   platform keeps  = commission + fees - rider pay - platformDiscount
 *                     - gateway/COD, refund-risk, support and other variable costs
 *
 * Who funds a discount is explicit. A restaurant-funded discount lowers the
 * restaurant's commission base (it is the restaurant's money), a
 * platform-funded one is a Scraveit cost and never touches the restaurant's
 * settlement, and a shared one splits by a stored ratio.
 */

export const ECONOMICS_CALCULATION_VERSION = 1 as const;

export type FundingSource = "restaurant" | "platform" | "shared";
export type EconomicsVerdict = "safe" | "below_target" | "unsafe";
export type CheckoutPaymentKind = "cod" | "upi" | "card";

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

export function rupeesToPaise(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/** Basis-point share of an amount, rounded half away from zero to the paisa. */
export function bpsOf(amountPaise: number, bps: number): number {
  return Math.round(amountPaise * bps / 10_000);
}

function nonNegative(value: unknown): number {
  const parsed = Math.round(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function boundedInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, parsed)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// ---------------------------------------------------------------------------
// Profitability policy
// ---------------------------------------------------------------------------

/**
 * Everything the business can tune without a release. Percentages are basis
 * points (100 bps = 1%). Scoped overrides (city, zone, restaurant) only carry
 * the fields they change and are layered over `global` by resolveEconomicsPolicy.
 */
export interface EconomicsPolicy {
  /** Minimum Scraveit contribution every normal order must still leave. */
  minContributionPaisePerOrder: number;
  /** Optional additional floor as a share of what the customer paid. 0 = off. */
  minContributionBpsOfGmv: number;
  /** Desired contribution per order. Below it a campaign shows yellow, not green. */
  targetContributionPaisePerOrder: number;
  /** Optional desired contribution as a share of the bill. 0 = off. */
  targetContributionBpsOfGmv: number;
  /** Positive contribution is split into these buckets before anything is "spendable". */
  operatingReserveBps: number;
  expansionReserveBps: number;
  riskReserveBps: number;
  /** Payment gateway fee on online payments. */
  paymentGatewayCostBps: number;
  /** Cost of handling a cash order (reconciliation, cash risk). */
  codHandlingCostPaise: number;
  /** Expected refunds/complaints, as a share of what the customer paid. */
  refundReserveBpsOfGmv: number;
  supportCostPaisePerOrder: number;
  otherVariableCostPaisePerOrder: number;
  /** Hard ceiling on Scraveit-funded discount on any one order. */
  maxPlatformSubsidyPerOrderPaise: number;
  /** Share of an order's positive contribution that may come back as cashback. */
  cashbackMaxShareOfContributionBps: number;
  /** Rider's share of the rain fee (rest is Scraveit's). */
  riderRainShareBps: number;
  /** Rider's share of the rider surge fee (rest is Scraveit's). */
  riderSurgeShareBps: number;
  /** Restaurant's share of the busy-kitchen fee (rest is Scraveit's). */
  restaurantRushShareBps: number;
}

export const DEFAULT_ECONOMICS_POLICY: Readonly<EconomicsPolicy> = Object.freeze({
  minContributionPaisePerOrder: 800,
  minContributionBpsOfGmv: 0,
  targetContributionPaisePerOrder: 2_000,
  targetContributionBpsOfGmv: 0,
  operatingReserveBps: 4_000,
  expansionReserveBps: 3_000,
  riskReserveBps: 1_000,
  paymentGatewayCostBps: 200,
  codHandlingCostPaise: 300,
  refundReserveBpsOfGmv: 100,
  supportCostPaisePerOrder: 300,
  otherVariableCostPaisePerOrder: 200,
  maxPlatformSubsidyPerOrderPaise: 10_000,
  cashbackMaxShareOfContributionBps: 2_000,
  riderRainShareBps: 7_000,
  riderSurgeShareBps: 7_000,
  restaurantRushShareBps: 7_000,
});

const POLICY_BOUNDS: Readonly<Record<keyof EconomicsPolicy, readonly [number, number]>> = {
  minContributionPaisePerOrder: [0, 1_000_000],
  minContributionBpsOfGmv: [0, 5_000],
  targetContributionPaisePerOrder: [0, 1_000_000],
  targetContributionBpsOfGmv: [0, 5_000],
  operatingReserveBps: [0, 10_000],
  expansionReserveBps: [0, 10_000],
  riskReserveBps: [0, 10_000],
  paymentGatewayCostBps: [0, 1_000],
  codHandlingCostPaise: [0, 100_000],
  refundReserveBpsOfGmv: [0, 5_000],
  supportCostPaisePerOrder: [0, 100_000],
  otherVariableCostPaisePerOrder: [0, 100_000],
  maxPlatformSubsidyPerOrderPaise: [0, 10_000_000],
  cashbackMaxShareOfContributionBps: [0, 10_000],
  riderRainShareBps: [0, 10_000],
  riderSurgeShareBps: [0, 10_000],
  restaurantRushShareBps: [0, 10_000],
};

export const ECONOMICS_POLICY_FIELDS = Object.keys(POLICY_BOUNDS) as (keyof EconomicsPolicy)[];

/** Keeps only valid, in-range fields - used for partial scoped overrides. */
export function normalizeEconomicsPolicyOverride(value: unknown): Partial<EconomicsPolicy> {
  const input = record(value);
  const output: Partial<EconomicsPolicy> = {};
  for (const field of ECONOMICS_POLICY_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") continue;
    const parsed = Number(input[field]);
    if (!Number.isFinite(parsed)) continue;
    const [minimum, maximum] = POLICY_BOUNDS[field];
    output[field] = boundedInt(parsed, minimum, minimum, maximum);
  }
  return output;
}

export function normalizeEconomicsPolicy(value: unknown): EconomicsPolicy {
  const merged = {...DEFAULT_ECONOMICS_POLICY, ...normalizeEconomicsPolicyOverride(value)};
  return clampReserves(merged);
}

/** The three reserve buckets can never claim more than 100% between them. */
function clampReserves(policy: EconomicsPolicy): EconomicsPolicy {
  const total = policy.operatingReserveBps + policy.expansionReserveBps + policy.riskReserveBps;
  if (total <= 10_000) return policy;
  const scale = 10_000 / total;
  const operating = Math.floor(policy.operatingReserveBps * scale);
  const expansion = Math.floor(policy.expansionReserveBps * scale);
  return {
    ...policy,
    operatingReserveBps: operating,
    expansionReserveBps: expansion,
    riskReserveBps: 10_000 - operating - expansion,
  };
}

export function economicsScopeKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export interface EconomicsScope {
  cityKey: string;
  zoneKey?: string;
  restaurantId?: string;
}

export interface EconomicsPolicyLayers {
  global?: Partial<EconomicsPolicy>;
  cities?: Record<string, Partial<EconomicsPolicy>>;
  /** Keyed `${cityKey}|${zoneKey}`. */
  zones?: Record<string, Partial<EconomicsPolicy>>;
  restaurants?: Record<string, Partial<EconomicsPolicy>>;
}

/**
 * global -> city -> zone -> restaurant, most specific wins field by field. The
 * returned `appliedScopes` is recorded on every order so a figure can always
 * be traced back to the exact configuration that produced it.
 */
export function resolveEconomicsPolicy(
  layers: EconomicsPolicyLayers,
  scope: EconomicsScope,
): {policy: EconomicsPolicy; appliedScopes: string[]} {
  const appliedScopes = ["global"];
  let merged: EconomicsPolicy = normalizeEconomicsPolicy(layers.global);
  const apply = (label: string, override: unknown) => {
    const normalized = normalizeEconomicsPolicyOverride(override);
    if (!Object.keys(normalized).length) return;
    merged = clampReserves({...merged, ...normalized});
    appliedScopes.push(label);
  };
  const city = economicsScopeKey(scope.cityKey);
  const zone = economicsScopeKey(scope.zoneKey);
  if (city) apply(`city:${city}`, layers.cities?.[city]);
  if (city && zone) apply(`zone:${city}|${zone}`, layers.zones?.[`${city}|${zone}`]);
  if (scope.restaurantId) apply(`restaurant:${scope.restaurantId}`, layers.restaurants?.[scope.restaurantId]);
  return {policy: merged, appliedScopes};
}

// ---------------------------------------------------------------------------
// Restaurant commercial plans
// ---------------------------------------------------------------------------

export interface RestaurantCommercialPlan {
  planId: string;
  /** e.g. "founding_partner", "standard". */
  label: string;
  commissionBps: number;
  effectiveFrom: number;
  /** 0 = open ended. */
  effectiveTo: number;
}

export function normalizeCommercialPlans(value: unknown): RestaurantCommercialPlan[] {
  const list = Array.isArray(value) ? value : Object.values(record(value));
  return list.map((entry, index) => {
    const input = record(entry);
    return {
      planId: String(input.planId || `plan_${index + 1}`).slice(0, 60),
      label: String(input.label || "Commercial plan").slice(0, 80),
      commissionBps: boundedInt(input.commissionBps, 1_500, 0, 5_000),
      effectiveFrom: boundedInt(input.effectiveFrom, 0, 0, Number.MAX_SAFE_INTEGER),
      effectiveTo: boundedInt(input.effectiveTo, 0, 0, Number.MAX_SAFE_INTEGER),
    };
  }).sort((left, right) => left.effectiveFrom - right.effectiveFrom);
}

/** The plan in force at `at`; the latest-starting one wins an overlap. */
export function activeCommercialPlan(
  plans: readonly RestaurantCommercialPlan[],
  at: number,
): RestaurantCommercialPlan | null {
  const live = plans.filter((plan) => plan.effectiveFrom <= at && (plan.effectiveTo === 0 || at < plan.effectiveTo));
  return live.length ? live[live.length - 1]! : null;
}

// ---------------------------------------------------------------------------
// Promotions and who funds them
// ---------------------------------------------------------------------------

export interface PromotionTerms {
  id: string;
  code: string;
  title: string;
  kind: "percent" | "flat";
  percent: number;
  flatAmountPaise: number;
  maxDiscountPaise: number;
  minimumOrderPaise: number;
  fundingSource: FundingSource;
  /** For shared offers: the restaurant's share of the discount. */
  restaurantShareBps: number;
  restaurantIds: string[];
  cityKeys: string[];
  firstOrderOnly: boolean;
  active: boolean;
  startsAt: number;
  expiresAt: number;
  /** Platform money this promotion may spend in total. 0 = no platform budget cap. */
  budgetPaise: number;
  usedBudgetPaise: number;
  perCustomerLimit: number;
  /** Optional approved growth budget that may pay beyond the profit-safe amount. */
  growthBudgetId: string;
  /** Restaurant-created offers wait for approval. */
  approvalStatus: "approved" | "pending" | "rejected";
  createdByRestaurantId: string;
  /** No funding source on record: kept restaurant-funded, which is how every
   *  such offer was always settled. */
  legacyFunding: boolean;
}

export function normalizePromotionTerms(id: string, value: unknown): PromotionTerms {
  const input = record(value);
  const explicitFunding = input.fundingSource === "restaurant" || input.fundingSource === "platform" ||
    input.fundingSource === "shared";
  const kind = input.kind === "flat" ? "flat" : "percent";
  const percent = boundedInt(input.percent, 0, 0, 100);
  // Rupee fields written by older admin builds are converted; paise fields win.
  const maxDiscountPaise = input.maxDiscountPaise !== undefined ?
    nonNegative(input.maxDiscountPaise) :
    input.maxDiscount !== undefined && input.maxDiscount !== null ? rupeesToPaise(input.maxDiscount) : 0;
  const minimumOrderPaise = input.minimumOrderPaise !== undefined ?
    nonNegative(input.minimumOrderPaise) : rupeesToPaise(input.minimumOrder ?? 0);
  const flatAmountPaise = input.flatAmountPaise !== undefined ?
    nonNegative(input.flatAmountPaise) : rupeesToPaise(input.flatAmount ?? 0);
  const approval = input.approvalStatus === "pending" || input.approvalStatus === "rejected" ?
    input.approvalStatus : "approved";
  return {
    id,
    code: String(input.code ?? "").trim().toUpperCase().slice(0, 24),
    title: String(input.title ?? "").slice(0, 120),
    kind,
    percent,
    flatAmountPaise,
    maxDiscountPaise,
    minimumOrderPaise: Math.max(0, minimumOrderPaise),
    fundingSource: explicitFunding ? input.fundingSource as FundingSource : "restaurant",
    restaurantShareBps: boundedInt(input.restaurantShareBps, 5_000, 0, 10_000),
    restaurantIds: Array.isArray(input.restaurantIds) ? input.restaurantIds.map(String).filter(Boolean).slice(0, 200) : [],
    cityKeys: Array.isArray(input.cityKeys) ? input.cityKeys.map(economicsScopeKey).filter(Boolean).slice(0, 50) : [],
    firstOrderOnly: input.firstOrderOnly === true,
    active: input.active === true,
    startsAt: nonNegative(input.startsAt),
    expiresAt: nonNegative(input.expiresAt),
    budgetPaise: nonNegative(input.budgetPaise),
    usedBudgetPaise: nonNegative(input.usedBudgetPaise),
    perCustomerLimit: boundedInt(input.perCustomerLimit, 0, 0, 1_000),
    growthBudgetId: String(input.growthBudgetId ?? "").slice(0, 80),
    approvalStatus: approval,
    createdByRestaurantId: String(input.createdByRestaurantId ?? "").slice(0, 120),
    legacyFunding: !explicitFunding,
  };
}

export type PromotionIneligibility =
  | "inactive"
  | "not_approved"
  | "not_started"
  | "expired"
  | "below_minimum"
  | "wrong_restaurant"
  | "wrong_city"
  | "budget_exhausted";

/** Order-independent checks. First-order and per-customer limits need reads and stay with the caller. */
export function promotionIneligibility(
  terms: PromotionTerms,
  context: {subtotalPaise: number; restaurantId: string; cityKey: string; at: number},
): PromotionIneligibility | null {
  if (!terms.active) return "inactive";
  if (terms.approvalStatus !== "approved") return "not_approved";
  if (terms.startsAt > 0 && context.at < terms.startsAt) return "not_started";
  if (terms.expiresAt > 0 && context.at >= terms.expiresAt) return "expired";
  if (context.subtotalPaise < terms.minimumOrderPaise) return "below_minimum";
  if (terms.restaurantIds.length && !terms.restaurantIds.includes(context.restaurantId)) return "wrong_restaurant";
  if (terms.cityKeys.length && !terms.cityKeys.includes(economicsScopeKey(context.cityKey))) return "wrong_city";
  if (terms.budgetPaise > 0 && terms.fundingSource !== "restaurant" && terms.usedBudgetPaise >= terms.budgetPaise) {
    return "budget_exhausted";
  }
  return null;
}

/** Gross discount the terms promise, before any profitability limit. */
export function promotionDiscountPaise(terms: PromotionTerms, subtotalPaise: number): number {
  const raw = terms.kind === "flat" ? terms.flatAmountPaise : bpsOf(subtotalPaise, terms.percent * 100);
  const capped = terms.maxDiscountPaise > 0 ? Math.min(raw, terms.maxDiscountPaise) : raw;
  return Math.max(0, Math.min(subtotalPaise, capped));
}

export function splitDiscountByFunding(
  terms: Pick<PromotionTerms, "fundingSource" | "restaurantShareBps">,
  discountPaise: number,
): {restaurantPaise: number; platformPaise: number} {
  const total = Math.max(0, Math.round(discountPaise));
  if (terms.fundingSource === "platform") return {restaurantPaise: 0, platformPaise: total};
  if (terms.fundingSource === "restaurant") return {restaurantPaise: total, platformPaise: 0};
  const restaurantPaise = bpsOf(total, terms.restaurantShareBps);
  return {restaurantPaise, platformPaise: total - restaurantPaise};
}

// ---------------------------------------------------------------------------
// Per-order economics
// ---------------------------------------------------------------------------

export interface OrderEconomicsInput {
  cityKey: string;
  zoneKey: string;
  restaurantId: string;
  paymentMethod: CheckoutPaymentKind;
  itemSubtotalPaise: number;
  restaurantDiscountPaise: number;
  platformDiscountPaise: number;
  /** Part of platformDiscountPaise paid from an approved growth budget. */
  growthSubsidyPaise?: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  smallOrderFeePaise: number;
  lateNightFeePaise: number;
  rainFeePaise: number;
  surgeFeePaise: number;
  riderIncentiveFeePaise: number;
  /** Rider surge fee charged to the customer (shared with the rider). */
  riderSurgeFeePaise?: number;
  taxPaise: number;
  tipPaise: number;
  commissionBps: number;
  /** What the rider is paid for the trip itself, from the rider trip-pay policy. */
  riderDeliveryPayPaise: number;
  /** Per-order rider bonuses expected on this order (rain/peak/special). */
  riderIncentivePayPaise: number;
  /** Component breakdown of riderDeliveryPayPaise, kept for display and audit. */
  tripPay?: {
    basePickupPaise: number;
    pickupDistancePaise: number;
    dropDistancePaise: number;
    longDistancePaise: number;
    vehicleAdjustmentPaise: number;
    minimumTopUpPaise: number;
    maximumCapPaise: number;
    waitingPaise: number;
    slotPaise: number;
    pickupMeters: number;
    dropMeters: number;
    waitMinutes: number;
    estimated: boolean;
  };
  /** Customer wallet (cashback / referral credit) used on this order. */
  walletRedeemPaise?: number;
  /** Tax charged to the restaurant on Scraveit's commission (CA-defined rules only). */
  commissionTaxPaise?: number;
  taxVersionId?: string;
  ruleIds?: string[];
}

export interface OrderEconomicsSnapshot {
  calculationVersion: typeof ECONOMICS_CALCULATION_VERSION;
  currency: "INR";
  cityKey: string;
  zoneKey: string;
  restaurantId: string;
  paymentMethod: CheckoutPaymentKind;
  policyScopes: string[];
  ruleIds: string[];
  customer: {
    itemSubtotalPaise: number;
    restaurantDiscountPaise: number;
    platformDiscountPaise: number;
    deliveryFeePaise: number;
    platformFeePaise: number;
    smallOrderFeePaise: number;
    lateNightFeePaise: number;
    rainFeePaise: number;
    surgeFeePaise: number;
    riderIncentiveFeePaise: number;
    riderSurgeFeePaise?: number;
    taxPaise: number;
    tipPaise: number;
    walletRedeemPaise?: number;
    payablePaise: number;
  };
  restaurant: {
    commissionBps: number;
    commissionBasePaise: number;
    commissionPaise: number;
    commissionTaxPaise?: number;
    /** Restaurant's share of the busy-kitchen fee, included in receivablePaise. */
    rushFeeSharePaise?: number;
    receivablePaise: number;
  };
  rider: {
    deliveryPayPaise: number;
    incentivePayPaise: number;
    /** Rider's share of the rain and rider surge fees, paid with the trip. */
    feeSharePaise?: number;
    tipPaise: number;
    totalPaise: number;
    tripPay?: OrderEconomicsInput["tripPay"];
  };
  platform: {
    grossRevenuePaise: number;
    riderPayPaise: number;
    paymentCostPaise: number;
    refundReservePaise: number;
    supportCostPaise: number;
    otherVariableCostPaise: number;
    promotionCostPaise: number;
    growthSubsidyPaise: number;
    /** Customer delivery fee minus rider trip pay: negative is a delivery subsidy. */
    deliveryMarginPaise?: number;
    totalVariableCostPaise: number;
    contributionBeforePromotionPaise: number;
    /** After every cost, including platform-funded discounts. */
    contributionPaise: number;
    /** Excluding the growth-budget part of the discount: the order's own operating result. */
    operatingContributionPaise: number;
    operatingReservePaise: number;
    expansionReservePaise: number;
    riskReservePaise: number;
    distributablePaise: number;
  };
  guardrail: {
    minimumContributionPaise: number;
    targetContributionPaise: number;
    promotionCapacityPaise: number;
    verdict: EconomicsVerdict;
  };
}

/**
 * The part of the snapshot that decides who is paid what. It is stored on the
 * order itself (customers, restaurants and riders can read their own orders),
 * while Scraveit's own margin, costs and reserves stay in the server-only
 * `orderEconomics` record.
 */
export type OrderSettlementTerms = Pick<OrderEconomicsSnapshot,
  "calculationVersion" | "currency" | "cityKey" | "zoneKey" | "paymentMethod" | "customer" | "restaurant" | "rider">;

export function settlementTerms(snapshot: OrderEconomicsSnapshot): OrderSettlementTerms {
  return {
    calculationVersion: snapshot.calculationVersion,
    currency: snapshot.currency,
    cityKey: snapshot.cityKey,
    zoneKey: snapshot.zoneKey,
    paymentMethod: snapshot.paymentMethod,
    customer: {...snapshot.customer},
    restaurant: {...snapshot.restaurant},
    rider: {...snapshot.rider},
  };
}

function customerPayable(input: OrderEconomicsInput): number {
  return input.itemSubtotalPaise - input.restaurantDiscountPaise - input.platformDiscountPaise +
    input.deliveryFeePaise + input.platformFeePaise + input.smallOrderFeePaise + input.lateNightFeePaise +
    input.rainFeePaise + input.surgeFeePaise + input.riderIncentiveFeePaise + (input.riderSurgeFeePaise ?? 0) +
    input.taxPaise + input.tipPaise - (input.walletRedeemPaise ?? 0);
}

export function minimumContributionPaise(policy: EconomicsPolicy, payablePaise: number): number {
  return Math.max(policy.minContributionPaisePerOrder, bpsOf(Math.max(0, payablePaise), policy.minContributionBpsOfGmv));
}

export function allocateReserves(
  contributionPaise: number,
  policy: Pick<EconomicsPolicy, "operatingReserveBps" | "expansionReserveBps" | "riskReserveBps">,
): {operatingReservePaise: number; expansionReservePaise: number; riskReservePaise: number; distributablePaise: number} {
  if (contributionPaise <= 0) {
    return {operatingReservePaise: 0, expansionReservePaise: 0, riskReservePaise: 0, distributablePaise: contributionPaise};
  }
  const operatingReservePaise = bpsOf(contributionPaise, policy.operatingReserveBps);
  const expansionReservePaise = bpsOf(contributionPaise, policy.expansionReserveBps);
  const riskReservePaise = Math.min(
    contributionPaise - operatingReservePaise - expansionReservePaise,
    bpsOf(contributionPaise, policy.riskReserveBps),
  );
  return {
    operatingReservePaise,
    expansionReservePaise,
    riskReservePaise,
    distributablePaise: contributionPaise - operatingReservePaise - expansionReservePaise - riskReservePaise,
  };
}

export function computeOrderEconomics(
  rawInput: OrderEconomicsInput,
  policy: EconomicsPolicy,
  policyScopes: string[] = ["global"],
): OrderEconomicsSnapshot {
  const input: OrderEconomicsInput = {
    ...rawInput,
    itemSubtotalPaise: nonNegative(rawInput.itemSubtotalPaise),
    restaurantDiscountPaise: nonNegative(rawInput.restaurantDiscountPaise),
    platformDiscountPaise: nonNegative(rawInput.platformDiscountPaise),
    growthSubsidyPaise: Math.min(nonNegative(rawInput.growthSubsidyPaise), nonNegative(rawInput.platformDiscountPaise)),
    deliveryFeePaise: nonNegative(rawInput.deliveryFeePaise),
    platformFeePaise: nonNegative(rawInput.platformFeePaise),
    smallOrderFeePaise: nonNegative(rawInput.smallOrderFeePaise),
    lateNightFeePaise: nonNegative(rawInput.lateNightFeePaise),
    rainFeePaise: nonNegative(rawInput.rainFeePaise),
    surgeFeePaise: nonNegative(rawInput.surgeFeePaise),
    riderIncentiveFeePaise: nonNegative(rawInput.riderIncentiveFeePaise),
    riderSurgeFeePaise: nonNegative(rawInput.riderSurgeFeePaise),
    taxPaise: nonNegative(rawInput.taxPaise),
    tipPaise: nonNegative(rawInput.tipPaise),
    commissionBps: boundedInt(rawInput.commissionBps, 0, 0, 5_000),
    riderDeliveryPayPaise: nonNegative(rawInput.riderDeliveryPayPaise),
    riderIncentivePayPaise: nonNegative(rawInput.riderIncentivePayPaise),
    walletRedeemPaise: nonNegative(rawInput.walletRedeemPaise),
    commissionTaxPaise: nonNegative(rawInput.commissionTaxPaise),
  };
  if (input.restaurantDiscountPaise + input.platformDiscountPaise > input.itemSubtotalPaise) {
    throw new Error("ECONOMICS_DISCOUNT_EXCEEDS_SUBTOTAL");
  }
  const payablePaise = customerPayable(input);
  if (payablePaise < 0) throw new Error("ECONOMICS_WALLET_EXCEEDS_BILL");
  const commissionBasePaise = input.itemSubtotalPaise - input.restaurantDiscountPaise;
  const commissionPaise = bpsOf(commissionBasePaise, input.commissionBps);
  const commissionTaxPaise = input.commissionTaxPaise ?? 0;
  // Busy-kitchen fee: the restaurant's share is paid out with its food money.
  const rushFeeSharePaise = bpsOf(input.surgeFeePaise, policy.restaurantRushShareBps);
  const receivablePaise = commissionBasePaise - commissionPaise - commissionTaxPaise + rushFeeSharePaise;
  // Rain and rider surge fees: the rider's share is paid with the trip.
  const riderSurgeFeePaise = input.riderSurgeFeePaise ?? 0;
  const riderFeeSharePaise = bpsOf(input.rainFeePaise, policy.riderRainShareBps) +
    bpsOf(riderSurgeFeePaise, policy.riderSurgeShareBps);

  const grossRevenuePaise = commissionPaise + input.deliveryFeePaise + input.platformFeePaise +
    input.smallOrderFeePaise + input.lateNightFeePaise + input.rainFeePaise + riderSurgeFeePaise +
    (input.surgeFeePaise - rushFeeSharePaise) + input.riderIncentiveFeePaise;
  const riderPayPaise = input.riderDeliveryPayPaise + input.riderIncentivePayPaise + riderFeeSharePaise;
  const onlinePayment = input.paymentMethod === "upi" || input.paymentMethod === "card";
  const paymentCostPaise = onlinePayment ? bpsOf(payablePaise, policy.paymentGatewayCostBps) : policy.codHandlingCostPaise;
  const refundReservePaise = bpsOf(payablePaise, policy.refundReserveBpsOfGmv);
  const costsBeforePromotion = riderPayPaise + paymentCostPaise + refundReservePaise +
    policy.supportCostPaisePerOrder + policy.otherVariableCostPaisePerOrder;
  const contributionBeforePromotionPaise = grossRevenuePaise - costsBeforePromotion;
  const contributionPaise = contributionBeforePromotionPaise - input.platformDiscountPaise;
  const growthSubsidyPaise = input.growthSubsidyPaise ?? 0;
  const operatingContributionPaise = contributionPaise + growthSubsidyPaise;
  const minimumContribution = minimumContributionPaise(policy, payablePaise);
  const targetContribution = Math.max(policy.targetContributionPaisePerOrder,
    bpsOf(Math.max(0, payablePaise), policy.targetContributionBpsOfGmv));
  const promotionCapacityPaise = Math.max(0, Math.min(
    policy.maxPlatformSubsidyPerOrderPaise,
    contributionBeforePromotionPaise - minimumContribution,
  ));
  const reserves = allocateReserves(contributionPaise, policy);
  const verdict: EconomicsVerdict = operatingContributionPaise < minimumContribution ? "unsafe" :
    operatingContributionPaise < targetContribution ? "below_target" : "safe";

  return {
    calculationVersion: ECONOMICS_CALCULATION_VERSION,
    currency: "INR",
    cityKey: economicsScopeKey(input.cityKey),
    zoneKey: economicsScopeKey(input.zoneKey),
    restaurantId: input.restaurantId,
    paymentMethod: input.paymentMethod,
    policyScopes: [...policyScopes],
    ruleIds: [...new Set(input.ruleIds ?? [])].slice(0, 30),
    customer: {
      itemSubtotalPaise: input.itemSubtotalPaise,
      restaurantDiscountPaise: input.restaurantDiscountPaise,
      platformDiscountPaise: input.platformDiscountPaise,
      deliveryFeePaise: input.deliveryFeePaise,
      platformFeePaise: input.platformFeePaise,
      smallOrderFeePaise: input.smallOrderFeePaise,
      lateNightFeePaise: input.lateNightFeePaise,
      rainFeePaise: input.rainFeePaise,
      surgeFeePaise: input.surgeFeePaise,
      riderIncentiveFeePaise: input.riderIncentiveFeePaise,
      ...(riderSurgeFeePaise ? {riderSurgeFeePaise} : {}),
      taxPaise: input.taxPaise,
      tipPaise: input.tipPaise,
      ...(input.walletRedeemPaise ? {walletRedeemPaise: input.walletRedeemPaise} : {}),
      payablePaise,
    },
    restaurant: {
      commissionBps: input.commissionBps,
      commissionBasePaise,
      commissionPaise,
      ...(commissionTaxPaise ? {commissionTaxPaise} : {}),
      ...(rushFeeSharePaise ? {rushFeeSharePaise} : {}),
      receivablePaise,
    },
    rider: {
      deliveryPayPaise: input.riderDeliveryPayPaise,
      incentivePayPaise: input.riderIncentivePayPaise,
      ...(riderFeeSharePaise ? {feeSharePaise: riderFeeSharePaise} : {}),
      tipPaise: input.tipPaise,
      totalPaise: riderPayPaise + input.tipPaise,
      ...(input.tripPay ? {tripPay: input.tripPay} : {}),
    },
    platform: {
      grossRevenuePaise,
      riderPayPaise,
      paymentCostPaise,
      refundReservePaise,
      supportCostPaise: policy.supportCostPaisePerOrder,
      otherVariableCostPaise: policy.otherVariableCostPaisePerOrder,
      promotionCostPaise: input.platformDiscountPaise,
      growthSubsidyPaise,
      deliveryMarginPaise: input.deliveryFeePaise - input.riderDeliveryPayPaise,
      totalVariableCostPaise: costsBeforePromotion + input.platformDiscountPaise,
      contributionBeforePromotionPaise,
      contributionPaise,
      operatingContributionPaise,
      ...reserves,
    },
    guardrail: {
      minimumContributionPaise: minimumContribution,
      targetContributionPaise: targetContribution,
      promotionCapacityPaise,
      verdict,
    },
  };
}

/**
 * Every rupee has a source and a destination. What the customer paid plus
 * what Scraveit put in as a discount must equal exactly what the restaurant,
 * the rider (trip pay and tip), the government (tax) and Scraveit (commission
 * and fees) receive. Returns the imbalance; 0 means it reconciles.
 */
export function economicsImbalancePaise(snapshot: OrderEconomicsSnapshot): number {
  const sources = snapshot.customer.payablePaise + snapshot.customer.platformDiscountPaise +
    (snapshot.customer.walletRedeemPaise ?? 0);
  const destinations = snapshot.restaurant.receivablePaise + snapshot.restaurant.commissionPaise +
    (snapshot.restaurant.commissionTaxPaise ?? 0) +
    snapshot.customer.deliveryFeePaise + snapshot.customer.platformFeePaise + snapshot.customer.smallOrderFeePaise +
    snapshot.customer.lateNightFeePaise + snapshot.customer.rainFeePaise + snapshot.customer.surgeFeePaise +
    snapshot.customer.riderIncentiveFeePaise + (snapshot.customer.riderSurgeFeePaise ?? 0) +
    snapshot.customer.taxPaise + snapshot.customer.tipPaise - (snapshot.restaurant.rushFeeSharePaise ?? 0);
  return sources - destinations;
}

// ---------------------------------------------------------------------------
// Profitability guardrail at checkout
// ---------------------------------------------------------------------------

export interface GuardedDiscount {
  restaurantDiscountPaise: number;
  platformDiscountPaise: number;
  /** Part of platformDiscountPaise drawn from a growth budget. */
  growthSubsidyPaise: number;
  /** Platform funding the offer asked for but the order could not safely give. */
  withheldPlatformPaise: number;
  limitedBy: "" | "profitability" | "growth_budget" | "promotion_budget";
}

/**
 * Applies the profitability rule to one offer on one order. The
 * restaurant-funded part is never reduced (it is the restaurant's own money).
 * The platform part is limited to what the order can give while still
 * leaving the minimum contribution; anything beyond that is paid only from an
 * approved growth budget with money left, and otherwise withheld - the
 * customer then sees the smaller, honest discount.
 */
export function guardPlatformDiscount(input: {
  requestedRestaurantPaise: number;
  requestedPlatformPaise: number;
  promotionCapacityPaise: number;
  guardrailEnabled: boolean;
  promotionBudgetRemainingPaise: number | null;
  growthBudgetRemainingPaise: number;
}): GuardedDiscount {
  const restaurantDiscountPaise = nonNegative(input.requestedRestaurantPaise);
  let requestedPlatform = nonNegative(input.requestedPlatformPaise);
  let limitedBy: GuardedDiscount["limitedBy"] = "";
  if (input.promotionBudgetRemainingPaise !== null && requestedPlatform > input.promotionBudgetRemainingPaise) {
    requestedPlatform = Math.max(0, input.promotionBudgetRemainingPaise);
    limitedBy = "promotion_budget";
  }
  if (!input.guardrailEnabled) {
    return {
      restaurantDiscountPaise,
      platformDiscountPaise: requestedPlatform,
      growthSubsidyPaise: 0,
      withheldPlatformPaise: nonNegative(input.requestedPlatformPaise) - requestedPlatform,
      limitedBy,
    };
  }
  const safe = Math.min(requestedPlatform, nonNegative(input.promotionCapacityPaise));
  const growthSubsidyPaise = Math.min(requestedPlatform - safe, nonNegative(input.growthBudgetRemainingPaise));
  const platformDiscountPaise = safe + growthSubsidyPaise;
  const withheldPlatformPaise = nonNegative(input.requestedPlatformPaise) - platformDiscountPaise;
  if (withheldPlatformPaise > 0 && limitedBy === "") {
    limitedBy = growthSubsidyPaise > 0 ? "growth_budget" : "profitability";
  }
  return {restaurantDiscountPaise, platformDiscountPaise, growthSubsidyPaise, withheldPlatformPaise, limitedBy};
}

// ---------------------------------------------------------------------------
// Simulate before publish
// ---------------------------------------------------------------------------

export interface OfferSimulationInput {
  averageOrderValuePaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  otherCustomerFeesPaise: number;
  riderPayPerOrderPaise: number;
  commissionBps: number;
  onlinePaymentShareBps: number;
  expectedOrders: number;
  /** Share of those orders that redeem the offer. */
  redemptionShareBps: number;
  offer: Pick<PromotionTerms, "kind" | "percent" | "flatAmountPaise" | "maxDiscountPaise" | "fundingSource" | "restaurantShareBps">;
}

export interface OfferSimulationResult {
  discountPerOrderPaise: number;
  restaurantFundedPerOrderPaise: number;
  platformFundedPerOrderPaise: number;
  customerBillPaise: number;
  restaurantEarningPaise: number;
  riderEarningPaise: number;
  platformRevenuePaise: number;
  contributionPerOrderPaise: number;
  contributionPerRedeemedOrderPaise: number;
  totalContributionPaise: number;
  totalPromoCostPaise: number;
  worstCasePromoCostPaise: number;
  expansionReservePaise: number;
  maximumSafePlatformFundingPaise: number;
  verdict: EconomicsVerdict;
  message: string;
}

function blendedEconomics(
  input: OfferSimulationInput,
  policy: EconomicsPolicy,
  discount: {restaurantPaise: number; platformPaise: number},
  paymentMethod: CheckoutPaymentKind,
): OrderEconomicsSnapshot {
  return computeOrderEconomics({
    cityKey: "",
    zoneKey: "",
    restaurantId: "simulation",
    paymentMethod,
    itemSubtotalPaise: input.averageOrderValuePaise,
    restaurantDiscountPaise: discount.restaurantPaise,
    platformDiscountPaise: discount.platformPaise,
    deliveryFeePaise: input.deliveryFeePaise,
    platformFeePaise: input.platformFeePaise,
    smallOrderFeePaise: input.otherCustomerFeesPaise,
    lateNightFeePaise: 0,
    rainFeePaise: 0,
    surgeFeePaise: 0,
    riderIncentiveFeePaise: 0,
    taxPaise: 0,
    tipPaise: 0,
    commissionBps: input.commissionBps,
    riderDeliveryPayPaise: input.riderPayPerOrderPaise,
    riderIncentivePayPaise: 0,
  }, policy);
}

/** Weighted mix of COD and online orders, so payment cost is realistic. */
function mixedEconomics(
  input: OfferSimulationInput,
  policy: EconomicsPolicy,
  discount: {restaurantPaise: number; platformPaise: number},
): {contribution: number; capacity: number; payable: number; revenue: number; receivable: number; riderPay: number} {
  const online = blendedEconomics(input, policy, discount, "upi");
  const cod = blendedEconomics(input, policy, discount, "cod");
  const share = boundedInt(input.onlinePaymentShareBps, 0, 0, 10_000);
  const mix = (a: number, b: number) => Math.round((a * share + b * (10_000 - share)) / 10_000);
  return {
    contribution: mix(online.platform.contributionPaise, cod.platform.contributionPaise),
    // The tighter of the payment methods actually in the mix: the safe amount
    // has to be safe on every order it could be applied to.
    capacity: share === 0 ? cod.guardrail.promotionCapacityPaise :
      share === 10_000 ? online.guardrail.promotionCapacityPaise :
        Math.min(online.guardrail.promotionCapacityPaise, cod.guardrail.promotionCapacityPaise),
    payable: online.customer.payablePaise,
    revenue: online.platform.grossRevenuePaise,
    receivable: online.restaurant.receivablePaise,
    riderPay: online.rider.totalPaise,
  };
}

export function simulateOffer(input: OfferSimulationInput, policy: EconomicsPolicy): OfferSimulationResult {
  const terms = {
    kind: input.offer.kind,
    percent: input.offer.percent,
    flatAmountPaise: input.offer.flatAmountPaise,
    maxDiscountPaise: input.offer.maxDiscountPaise,
  } as PromotionTerms;
  const discountPerOrderPaise = promotionDiscountPaise(terms, nonNegative(input.averageOrderValuePaise));
  const split = splitDiscountByFunding(input.offer, discountPerOrderPaise);
  const withOffer = mixedEconomics(input, policy, split);
  const withoutOffer = mixedEconomics(input, policy, {restaurantPaise: 0, platformPaise: 0});
  const orders = nonNegative(input.expectedOrders);
  const redeemed = Math.round(orders * boundedInt(input.redemptionShareBps, 10_000, 0, 10_000) / 10_000);
  const totalContributionPaise = withOffer.contribution * redeemed + withoutOffer.contribution * (orders - redeemed);
  const expansion = allocateReserves(totalContributionPaise, policy).expansionReservePaise;
  // Minimum is judged on the offer's own orders: a loss on every redeemed order
  // is not made acceptable by profit on everyone else's.
  const minimum = minimumContributionPaise(policy, withOffer.payable);
  const verdict: EconomicsVerdict = withOffer.contribution < minimum ? "unsafe" :
    withOffer.contribution < policy.targetContributionPaisePerOrder ? "below_target" : "safe";
  const maximumSafe = withoutOffer.capacity;
  const message = verdict === "unsafe" ?
    `Unsafe: Scraveit would fund ${formatRupees(split.platformPaise)} per order but can safely fund at most ${formatRupees(maximumSafe)}. Each redeemed order would leave ${formatRupees(withOffer.contribution)}.` :
    verdict === "below_target" ?
      `Allowed, but each redeemed order leaves ${formatRupees(withOffer.contribution)}, below the ${formatRupees(policy.targetContributionPaisePerOrder)} target.` :
      `Safe: each redeemed order still leaves ${formatRupees(withOffer.contribution)}.`;
  return {
    discountPerOrderPaise,
    restaurantFundedPerOrderPaise: split.restaurantPaise,
    platformFundedPerOrderPaise: split.platformPaise,
    customerBillPaise: withOffer.payable,
    restaurantEarningPaise: withOffer.receivable,
    riderEarningPaise: withOffer.riderPay,
    platformRevenuePaise: withOffer.revenue,
    contributionPerOrderPaise: orders > 0 ? Math.round(totalContributionPaise / orders) : 0,
    contributionPerRedeemedOrderPaise: withOffer.contribution,
    totalContributionPaise,
    totalPromoCostPaise: split.platformPaise * redeemed,
    worstCasePromoCostPaise: split.platformPaise * orders,
    expansionReservePaise: expansion,
    maximumSafePlatformFundingPaise: maximumSafe,
    verdict,
    message,
  };
}

export function formatRupees(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(Math.round(paise));
  const rupees = Math.floor(absolute / 100);
  const rest = absolute % 100;
  return `${negative ? "-" : ""}₹${rupees.toLocaleString("en-IN")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}
