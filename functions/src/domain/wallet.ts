/**
 * Customer wallet and cashback - pure rules.
 *
 * Wallet money is never free money: every lot records who funded it
 * (Scraveit, a restaurant, or both) and when it expires. Lots are spent
 * earliest-expiry first, and a cancelled order puts back exactly the lots it
 * used.
 */

export type CashbackFunding = "platform_budget" | "restaurant" | "shared" | "realized_contribution";

export interface WalletLot {
  lotId: string;
  customerId: string;
  source: "cashback" | "customer_referral" | "restore";
  amountPaise: number;
  remainingPaise: number;
  /** Portion of the lot funded by a restaurant (for breakage accounting). */
  restaurantFundedPaise: number;
  restaurantId: string;
  campaignId: string;
  orderId: string;
  cityKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface WalletRules {
  /** Largest share of the item subtotal wallet money may pay for. */
  maxRedeemBpsOfSubtotal: number;
  maxRedeemPerOrderPaise: number;
  minOrderForRedeemPaise: number;
  /** Fraud control: the most cashback one customer may earn in a day. */
  maxEarnPerCustomerPerDayPaise: number;
  defaultExpiryDays: number;
  /** A restored lot that already expired gets this many days again. */
  restoreGraceDays: number;
}

export const DEFAULT_WALLET_RULES: Readonly<WalletRules> = Object.freeze({
  maxRedeemBpsOfSubtotal: 2_000,
  maxRedeemPerOrderPaise: 10_000,
  minOrderForRedeemPaise: 14_900,
  maxEarnPerCustomerPerDayPaise: 20_000,
  defaultExpiryDays: 30,
  restoreGraceDays: 7,
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.min(maximum, Math.max(minimum, parsed))) : fallback;
}

export function normalizeWalletRules(value: unknown): WalletRules {
  const input = record(value);
  return {
    maxRedeemBpsOfSubtotal: bounded(input.maxRedeemBpsOfSubtotal, DEFAULT_WALLET_RULES.maxRedeemBpsOfSubtotal, 0, 10_000),
    maxRedeemPerOrderPaise: bounded(input.maxRedeemPerOrderPaise, DEFAULT_WALLET_RULES.maxRedeemPerOrderPaise, 0, 10_000_000),
    minOrderForRedeemPaise: bounded(input.minOrderForRedeemPaise, DEFAULT_WALLET_RULES.minOrderForRedeemPaise, 0, 10_000_000),
    maxEarnPerCustomerPerDayPaise: bounded(input.maxEarnPerCustomerPerDayPaise,
      DEFAULT_WALLET_RULES.maxEarnPerCustomerPerDayPaise, 0, 10_000_000),
    defaultExpiryDays: bounded(input.defaultExpiryDays, DEFAULT_WALLET_RULES.defaultExpiryDays, 1, 3_650),
    restoreGraceDays: bounded(input.restoreGraceDays, DEFAULT_WALLET_RULES.restoreGraceDays, 1, 365),
  };
}

export function normalizeWalletLot(lotId: string, value: unknown): WalletLot {
  const input = record(value);
  const int = (entry: unknown) => {
    const parsed = Math.round(Number(entry));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    lotId,
    customerId: String(input.customerId ?? ""),
    source: input.source === "customer_referral" || input.source === "restore" ? input.source : "cashback",
    amountPaise: int(input.amountPaise),
    remainingPaise: int(input.remainingPaise),
    restaurantFundedPaise: int(input.restaurantFundedPaise),
    restaurantId: String(input.restaurantId ?? ""),
    campaignId: String(input.campaignId ?? ""),
    orderId: String(input.orderId ?? ""),
    cityKey: String(input.cityKey ?? ""),
    createdAt: int(input.createdAt),
    expiresAt: int(input.expiresAt),
  };
}

export function spendableBalance(lots: readonly WalletLot[], at: number): number {
  return lots.reduce((total, lot) => lot.expiresAt > at ? total + lot.remainingPaise : total, 0);
}

/** How much wallet money this order may use, before looking at the balance. */
export function maxRedeemableForOrder(rules: WalletRules, subtotalPaise: number): number {
  if (subtotalPaise < rules.minOrderForRedeemPaise) return 0;
  return Math.max(0, Math.min(rules.maxRedeemPerOrderPaise, Math.round(subtotalPaise * rules.maxRedeemBpsOfSubtotal / 10_000)));
}

export interface LotAllocation {
  lotId: string;
  amountPaise: number;
  restaurantFundedPaise: number;
  expiresAt: number;
}

/** Earliest-expiring first; never touches an expired lot. */
export function allocateRedemption(lots: readonly WalletLot[], requestedPaise: number, at: number): LotAllocation[] {
  let remaining = Math.max(0, Math.round(requestedPaise));
  const allocations: LotAllocation[] = [];
  const usable = lots.filter((lot) => lot.expiresAt > at && lot.remainingPaise > 0)
    .sort((left, right) => left.expiresAt - right.expiresAt || left.createdAt - right.createdAt || left.lotId.localeCompare(right.lotId));
  for (const lot of usable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.remainingPaise);
    // A lot's restaurant-funded share is used up in proportion.
    const restaurantShare = lot.remainingPaise > 0 ?
      Math.round(take * Math.min(lot.restaurantFundedPaise, lot.remainingPaise) / lot.remainingPaise) : 0;
    allocations.push({lotId: lot.lotId, amountPaise: take, restaurantFundedPaise: restaurantShare, expiresAt: lot.expiresAt});
    remaining -= take;
  }
  return allocations;
}

// ---------------------------------------------------------------------------
// Cashback campaigns
// ---------------------------------------------------------------------------

export interface CashbackCampaign {
  id: string;
  title: string;
  active: boolean;
  funding: CashbackFunding;
  /** Restaurant share for "shared" funding. */
  restaurantShareBps: number;
  kind: "percent" | "flat";
  percent: number;
  flatAmountPaise: number;
  maxCashbackPaise: number;
  minimumOrderPaise: number;
  restaurantIds: string[];
  cityKeys: string[];
  zoneKeys: string[];
  startsAt: number;
  endsAt: number;
  expiryDays: number;
  budgetPaise: number;
  usedBudgetPaise: number;
  perCustomerLimit: number;
  firstOrderOnly: boolean;
  /** realized_contribution only: share of the order's safe contribution. */
  contributionShareBps: number;
}

export function normalizeCashbackCampaign(id: string, value: unknown): CashbackCampaign {
  const input = record(value);
  const funding: CashbackFunding = ["platform_budget", "restaurant", "shared", "realized_contribution"]
    .includes(String(input.funding)) ? input.funding as CashbackFunding : "platform_budget";
  const list = (entry: unknown, key = false) => Array.isArray(entry) ?
    entry.map((item) => key ? String(item).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : String(item))
      .filter(Boolean).slice(0, 200) : [];
  return {
    id,
    title: String(input.title ?? "Cashback").slice(0, 120),
    active: input.active === true,
    funding,
    restaurantShareBps: bounded(input.restaurantShareBps, 5_000, 0, 10_000),
    kind: input.kind === "flat" ? "flat" : "percent",
    percent: bounded(input.percent, 0, 0, 100),
    flatAmountPaise: bounded(input.flatAmountPaise, 0, 0, 10_000_000),
    maxCashbackPaise: bounded(input.maxCashbackPaise, 0, 0, 10_000_000),
    minimumOrderPaise: bounded(input.minimumOrderPaise, 0, 0, 10_000_000),
    restaurantIds: list(input.restaurantIds),
    cityKeys: list(input.cityKeys, true),
    zoneKeys: list(input.zoneKeys, true),
    startsAt: bounded(input.startsAt, 0, 0, Number.MAX_SAFE_INTEGER),
    endsAt: bounded(input.endsAt, 0, 0, Number.MAX_SAFE_INTEGER),
    expiryDays: bounded(input.expiryDays, 30, 1, 3_650),
    budgetPaise: bounded(input.budgetPaise, 0, 0, 1_000_000_000_00),
    usedBudgetPaise: bounded(input.usedBudgetPaise, 0, 0, 1_000_000_000_00),
    perCustomerLimit: bounded(input.perCustomerLimit, 0, 0, 1_000),
    firstOrderOnly: input.firstOrderOnly === true,
    contributionShareBps: bounded(input.contributionShareBps, 2_000, 0, 10_000),
  };
}

export interface CashbackContext {
  subtotalPaise: number;
  restaurantId: string;
  cityKey: string;
  zoneKey: string;
  orderedAt: number;
  /** Order's contribution above the minimum - the only money contribution-funded cashback may use. */
  safeContributionPaise: number;
  /** Cap from the city policy on how much of that may return to the customer. */
  policyContributionShareBps: number;
  customerUses: number;
  isFirstOrder: boolean;
}

export interface CashbackAward {
  campaignId: string;
  amountPaise: number;
  platformFundedPaise: number;
  restaurantFundedPaise: number;
  restaurantId: string;
  expiryDays: number;
}

export function cashbackIneligibility(campaign: CashbackCampaign, context: CashbackContext): string | null {
  if (!campaign.active) return "inactive";
  if (campaign.startsAt && context.orderedAt < campaign.startsAt) return "not_started";
  if (campaign.endsAt && context.orderedAt >= campaign.endsAt) return "ended";
  if (context.subtotalPaise < campaign.minimumOrderPaise) return "below_minimum";
  if (campaign.restaurantIds.length && !campaign.restaurantIds.includes(context.restaurantId)) return "wrong_restaurant";
  if ((campaign.funding === "restaurant" || campaign.funding === "shared") && !campaign.restaurantIds.length) {
    return "restaurant_not_named";
  }
  if (campaign.cityKeys.length && !campaign.cityKeys.includes(context.cityKey)) return "wrong_city";
  if (campaign.zoneKeys.length && !campaign.zoneKeys.includes(context.zoneKey)) return "wrong_zone";
  if (campaign.perCustomerLimit > 0 && context.customerUses >= campaign.perCustomerLimit) return "customer_limit";
  if (campaign.firstOrderOnly && !context.isFirstOrder) return "not_first_order";
  if (campaign.budgetPaise > 0 && campaign.funding !== "restaurant" && campaign.usedBudgetPaise >= campaign.budgetPaise) {
    return "budget_exhausted";
  }
  return null;
}

/** Amount one campaign would give this order, split by funder, with every cap applied. */
export function cashbackAward(campaign: CashbackCampaign, context: CashbackContext): CashbackAward | null {
  if (cashbackIneligibility(campaign, context)) return null;
  const raw = campaign.kind === "flat" ? campaign.flatAmountPaise :
    Math.round(context.subtotalPaise * campaign.percent / 100);
  let amount = campaign.maxCashbackPaise > 0 ? Math.min(raw, campaign.maxCashbackPaise) : raw;
  if (campaign.funding === "realized_contribution") {
    const share = Math.min(campaign.contributionShareBps, context.policyContributionShareBps);
    amount = Math.min(amount, Math.floor(Math.max(0, context.safeContributionPaise) * share / 10_000));
  }
  if (campaign.funding !== "restaurant" && campaign.budgetPaise > 0) {
    const platformPart = campaign.funding === "shared" ?
      amount - Math.round(amount * campaign.restaurantShareBps / 10_000) : amount;
    const left = Math.max(0, campaign.budgetPaise - campaign.usedBudgetPaise);
    if (platformPart > left) {
      amount = campaign.funding === "shared" && campaign.restaurantShareBps < 10_000 ?
        Math.floor(left * 10_000 / (10_000 - campaign.restaurantShareBps)) : left;
    }
  }
  amount = Math.max(0, Math.min(amount, context.subtotalPaise));
  if (amount <= 0) return null;
  const restaurantFundedPaise = campaign.funding === "restaurant" ? amount :
    campaign.funding === "shared" ? Math.round(amount * campaign.restaurantShareBps / 10_000) : 0;
  return {
    campaignId: campaign.id,
    amountPaise: amount,
    platformFundedPaise: amount - restaurantFundedPaise,
    restaurantFundedPaise,
    restaurantId: restaurantFundedPaise > 0 ? context.restaurantId : "",
    expiryDays: campaign.expiryDays,
  };
}

/** One cashback per order: the most valuable eligible campaign. */
export function bestCashbackAward(
  campaigns: readonly CashbackCampaign[],
  context: Omit<CashbackContext, "customerUses">,
  usesByCampaign: Readonly<Record<string, number>>,
): CashbackAward | null {
  let best: CashbackAward | null = null;
  for (const campaign of campaigns) {
    const award = cashbackAward(campaign, {...context, customerUses: usesByCampaign[campaign.id] ?? 0});
    if (!award) continue;
    if (!best || award.amountPaise > best.amountPaise) best = award;
  }
  return best;
}

/** Reduces a candidate award so the customer's daily earning cap is respected. */
export function capDailyEarn(award: CashbackAward, rules: WalletRules, earnedTodayPaise: number): CashbackAward | null {
  const room = Math.max(0, rules.maxEarnPerCustomerPerDayPaise - earnedTodayPaise);
  if (room <= 0) return null;
  if (award.amountPaise <= room) return award;
  const ratio = room / award.amountPaise;
  const restaurantFundedPaise = Math.round(award.restaurantFundedPaise * ratio);
  return {...award, amountPaise: room, restaurantFundedPaise, platformFundedPaise: room - restaurantFundedPaise};
}
