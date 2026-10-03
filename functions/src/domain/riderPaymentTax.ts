/**
 * How SCRAVEIT's own payments to a rider (beyond the delivery consideration
 * the customer paid) are treated for income tax under the RIDER-supplier
 * model. Each kind of payment has one category; the category decides the TDS:
 * - DELIVERY_SERVICE_CONSIDERATION: linked to delivering through SCRAVEIT
 *   (guarantee top-ups, quests, per-order / peak bonuses, pay kept after a
 *   customer refund): part of the rider's gross services, e-commerce TDS
 *   s.393(1) Table Sl. 8(v) - never the contractor ₹30,000 / ₹1 lakh rules.
 * - BUSINESS_INCENTIVE_OR_PERQUISITE: a genuine business benefit, not pay for
 *   delivery: s.393(1) Table Sl. 8(iv), 10% once the year's value exceeds
 *   ₹20,000 (then on the whole year). Never also under 8(v).
 * - REFERRAL_SERVICE: a referral payment; not delivery consideration. Its TDS
 *   follows the referral arrangement (configurable, no deduction until set).
 * - REIMBURSEMENT: actual costs paid back; no TDS.
 * - EX_GRATIA: a payment truly unrelated to the rider's service; recorded.
 * - PENDING_REVIEW: recorded, nothing deducted until classified.
 */

export type RiderPaymentTaxCategory =
  | "DELIVERY_SERVICE_CONSIDERATION"
  | "BUSINESS_INCENTIVE_OR_PERQUISITE"
  | "REFERRAL_SERVICE"
  | "REIMBURSEMENT"
  | "EX_GRATIA"
  | "PENDING_REVIEW";

export const RIDER_PAYMENT_TAX_CATEGORIES: readonly RiderPaymentTaxCategory[] = [
  "DELIVERY_SERVICE_CONSIDERATION", "BUSINESS_INCENTIVE_OR_PERQUISITE", "REFERRAL_SERVICE", "REIMBURSEMENT", "EX_GRATIA",
  "PENDING_REVIEW",
];

/** Ledger event types of SCRAVEIT-funded rider credits, by default category. */
export interface RiderPaymentCategoryMap {
  rider_incentive: RiderPaymentTaxCategory;
  rider_referral_reward: RiderPaymentTaxCategory;
  adjustment: RiderPaymentTaxCategory;
  /** What a REFERRAL_SERVICE payment is taxed as, once the arrangement is settled. */
  referralTdsTreatment: "PENDING_REVIEW" | "DELIVERY_SERVICE_CONSIDERATION" | "BUSINESS_INCENTIVE_OR_PERQUISITE";
}

export const DEFAULT_RIDER_PAYMENT_CATEGORIES: Readonly<RiderPaymentCategoryMap> = Object.freeze({
  rider_incentive: "DELIVERY_SERVICE_CONSIDERATION",
  rider_referral_reward: "REFERRAL_SERVICE",
  adjustment: "PENDING_REVIEW",
  referralTdsTreatment: "PENDING_REVIEW",
});

function category(value: unknown, fallback: RiderPaymentTaxCategory): RiderPaymentTaxCategory {
  return (RIDER_PAYMENT_TAX_CATEGORIES as readonly string[]).includes(String(value)) ? value as RiderPaymentTaxCategory : fallback;
}

export function normalizeRiderPaymentCategories(value: unknown): RiderPaymentCategoryMap {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const referral = String(input.referralTdsTreatment ?? "");
  return {
    rider_incentive: category(input.rider_incentive, DEFAULT_RIDER_PAYMENT_CATEGORIES.rider_incentive),
    rider_referral_reward: category(input.rider_referral_reward, DEFAULT_RIDER_PAYMENT_CATEGORIES.rider_referral_reward),
    adjustment: category(input.adjustment, DEFAULT_RIDER_PAYMENT_CATEGORIES.adjustment),
    referralTdsTreatment: referral === "DELIVERY_SERVICE_CONSIDERATION" || referral === "BUSINESS_INCENTIVE_OR_PERQUISITE"
      ? referral : "PENDING_REVIEW",
  };
}

/** The category of one SCRAVEIT-funded rider credit: an explicit tag on the journal wins. */
export function riderPaymentCategoryOf(eventType: string, metadataCategory: unknown, map: RiderPaymentCategoryMap): RiderPaymentTaxCategory {
  if ((RIDER_PAYMENT_TAX_CATEGORIES as readonly string[]).includes(String(metadataCategory))) {
    return metadataCategory as RiderPaymentTaxCategory;
  }
  if (eventType === "rider_incentive") return map.rider_incentive;
  if (eventType === "rider_referral_reward") return map.rider_referral_reward;
  return map.adjustment;
}

/** Which TDS a category leads to. */
export function tdsRouteOf(category: RiderPaymentTaxCategory, map: RiderPaymentCategoryMap): "ECOMMERCE_8V" | "PERQUISITE_8IV" | "NONE" {
  const effective = category === "REFERRAL_SERVICE" ? map.referralTdsTreatment : category;
  if (effective === "DELIVERY_SERVICE_CONSIDERATION") return "ECOMMERCE_8V";
  if (effective === "BUSINESS_INCENTIVE_OR_PERQUISITE") return "PERQUISITE_8IV";
  return "NONE";
}

export interface PerquisiteRule {
  section: string;
  rateBps: number;
  /** No TDS while the year's value is at most this; once exceeded, on the whole year. */
  thresholdPaise: number;
}

export const PERQUISITE_RULE: Readonly<PerquisiteRule> = Object.freeze({
  section: "393(1) Table Sl. 8(iv) (Income-tax Act, 2025)", rateBps: 1_000, thresholdPaise: 20_000_00,
});

/** Business benefit/perquisite TDS, year-to-date: required − already deducted. */
export function perquisiteTdsOnCredit(rule: PerquisiteRule, yearValueBeforePaise: number, deductedBeforePaise: number,
  valuePaise: number): {tdsPaise: number; yearValueAfterPaise: number; requiredYtdPaise: number} {
  const after = yearValueBeforePaise + Math.max(0, valuePaise);
  const requiredYtdPaise = after > rule.thresholdPaise ? Math.round(after * rule.rateBps / 10_000) : 0;
  return {tdsPaise: Math.max(0, requiredYtdPaise - deductedBeforePaise), yearValueAfterPaise: after, requiredYtdPaise};
}

// ---------------------------------------------------------------------------
// Returned e-commerce transactions (CBDT Circular 20/2023): TDS already
// deducted on a returned transaction is set off against the next transaction
// with the same participant in the same tax year - never paid back as cash.
// ---------------------------------------------------------------------------

export type TdsReversalStatus =
  | "NOT_REQUIRED"
  | "PENDING_ADJUSTMENT"
  | "AVAILABLE_FOR_OFFSET"
  | "OFFSET_APPLIED"
  | "CLAIMABLE_BY_PARTICIPANT";

export type TdsProvision = "ECOMMERCE_TDS" | "CONTRACTOR_TDS";

/** One returned transaction's TDS, waiting to be set off. */
export interface TdsOffsetSource {
  orderId: string;
  /** seller:{id} or rider:{id} - the account the TDS came from (audit linkage). */
  participantKey: string;
  /** Deductee PAN ("" when none was furnished). */
  pan: string;
  provision: TdsProvision;
  financialYear: string;
  createdAt: number;
  originalOffsetPaise: number;
  offsetUsedPaise: number;
  offsetRemainingPaise: number;
}

export interface TdsOffsetPool {
  provision: TdsProvision;
  pan: string;
  financialYear: string;
  sources: TdsOffsetSource[];
}

/** Pools are per TDS provision + deductee PAN + tax year; no PAN: per participant account. */
export function tdsOffsetPoolKey(provision: TdsProvision, pan: string, participantKey: string, financialYear: string): string {
  return `${provision}_${pan || `NOPAN-${participantKey.replace(":", "-")}`}_${financialYear}`;
}

/** Only this deductee's, this account's, this provision's, this year's offsets. */
function usable(source: TdsOffsetSource, scope: {participantKey: string; pan: string; provision: TdsProvision; financialYear: string}): boolean {
  return source.offsetRemainingPaise > 0 && source.participantKey === scope.participantKey && source.pan === scope.pan &&
    source.provision === scope.provision && source.financialYear === scope.financialYear;
}

export function poolAvailable(pool: TdsOffsetPool | null | undefined,
  scope: {participantKey: string; pan: string; provision: TdsProvision; financialYear: string}): number {
  return (pool?.sources ?? []).filter((source) => usable(source, scope)).reduce((sum, source) => sum + source.offsetRemainingPaise, 0);
}

/**
 * tdsNormallyDue − availableTdsOffset = tdsActuallyDeducted, oldest offset
 * first, partial use allowed. A source is fully applied only when its
 * offsetRemaining reaches 0.
 */
export function applyTdsOffset(pool: TdsOffsetPool, tdsNormallyDuePaise: number,
  scope: {participantKey: string; pan: string; provision: TdsProvision; financialYear: string}): {
  offsetPaise: number; tdsActuallyDeductedPaise: number; pool: TdsOffsetPool;
  usage: {orderId: string; usedPaise: number; offsetRemainingPaise: number}[];
} {
  let left = Math.max(0, tdsNormallyDuePaise);
  const usage: {orderId: string; usedPaise: number; offsetRemainingPaise: number}[] = [];
  const order = pool.sources.map((source, index) => ({source, index}))
    .sort((a, b) => a.source.createdAt - b.source.createdAt || a.index - b.index);
  const sources = pool.sources.map((source) => ({...source}));
  for (const {index} of order) {
    const source = sources[index]!;
    if (left <= 0 || !usable(source, scope)) continue;
    const used = Math.min(left, source.offsetRemainingPaise);
    left -= used;
    source.offsetUsedPaise += used;
    source.offsetRemainingPaise -= used;
    usage.push({orderId: source.orderId, usedPaise: used, offsetRemainingPaise: source.offsetRemainingPaise});
  }
  return {offsetPaise: Math.max(0, tdsNormallyDuePaise) - left, tdsActuallyDeductedPaise: left, pool: {...pool, sources}, usage};
}
