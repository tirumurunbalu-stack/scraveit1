import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {economicsScopeKey, resolveEconomicsPolicy, type OrderEconomicsSnapshot} from "../domain/economics";
import {
  allocateRedemption,
  bestCashbackAward,
  capDailyEarn,
  maxRedeemableForOrder,
  normalizeCashbackCampaign,
  normalizeWalletLot,
  spendableBalance,
  type CashbackAward,
  type LotAllocation,
  type WalletLot,
  type WalletRules,
} from "../domain/wallet";
import {DomainError} from "../errors";
import type {DocumentReferenceLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";
import {requirePlatformConfigAdminClaim} from "./authz";
import {
  finalizeOrderEconomics,
  loadEconomicsControl,
  orderEconomicsRef,
  type CheckoutEconomicsPlan,
} from "./economics";
import type {PricingBreakdown} from "../types";
import {persistLedgerJournalIfAbsent, type LedgerAttribution} from "./ledger";

/**
 * Customer wallet: lots of money owed to a customer (cashback, referral
 * credit), each with its funder and expiry, plus an immutable entry for every
 * movement. The balance on `customerWallets/{uid}` is a projection of the lots;
 * the financial ledger carries the same money as `liability:customer-wallet:{uid}`.
 */

export const WALLET_LOTS = "walletLots";
export const WALLET_ENTRIES = "walletEntries";
export const CUSTOMER_WALLETS = "customerWallets";
export const CASHBACK_CAMPAIGNS = "cashbackCampaigns";

const DAY_MS = 86_400_000;

function lotsQuery(database: FirestoreLike, customerId: string) {
  return database.collection(WALLET_LOTS).where("customerId", "==", customerId).where("remainingPaise", ">", 0).limit(200);
}

function entryRef(database: FirestoreLike, entryId: string): DocumentReferenceLike {
  return database.collection(WALLET_ENTRIES).doc(entryId);
}

function walletRef(database: FirestoreLike, customerId: string): DocumentReferenceLike {
  return database.collection(CUSTOMER_WALLETS).doc(customerId);
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140);
}

function istDayKey(at: number): string {
  return new Date(at + 330 * 60_000).toISOString().slice(0, 10);
}

async function readLots(database: FirestoreLike, customerId: string): Promise<WalletLot[]> {
  const snapshot = await lotsQuery(database, customerId).get();
  return snapshot.docs.map((doc) => normalizeWalletLot(doc.id, doc.data()));
}

// ---------------------------------------------------------------------------
// Redemption at checkout
// ---------------------------------------------------------------------------

/** How much wallet money this order will use (0 when the customer did not ask). */
export async function planWalletRedemption(input: {
  customerId: string;
  rules: WalletRules;
  subtotalPaise: number;
  payableBeforeWalletPaise: number;
  at: number;
  requested: boolean;
}, database: FirestoreLike = firestoreDb): Promise<{amountPaise: number; balancePaise: number; maxForOrderPaise: number}> {
  const lots = await readLots(database, input.customerId);
  const balancePaise = spendableBalance(lots, input.at);
  const maxForOrderPaise = maxRedeemableForOrder(input.rules, input.subtotalPaise);
  // A bill is never paid entirely from the wallet: at least ₹1 stays payable.
  const amountPaise = input.requested ?
    Math.max(0, Math.min(balancePaise, maxForOrderPaise, input.payableBeforeWalletPaise - 100)) : 0;
  return {amountPaise, balancePaise, maxForOrderPaise};
}

/**
 * Inside the order-creation transaction (reads first, then the returned
 * closure writes). Spends the earliest-expiring lots; if the balance changed
 * since pricing, the order is refused rather than under-paid.
 */
export async function reserveWalletRedemption(
  transaction: TransactionLike,
  input: {customerId: string; orderId: string; amountPaise: number; at: number},
  database: FirestoreLike = firestoreDb,
): Promise<() => void> {
  const lotsSnapshot = await transaction.get(lotsQuery(database, input.customerId));
  const walletSnapshot = await transaction.get(walletRef(database, input.customerId));
  const lots = lotsSnapshot.docs.map((doc) => normalizeWalletLot(doc.id, doc.data()));
  const allocations = allocateRedemption(lots, input.amountPaise, input.at);
  const covered = allocations.reduce((total, allocation) => total + allocation.amountPaise, 0);
  if (covered < input.amountPaise) {
    throw new DomainError("aborted", "Your wallet balance changed. Review your cart and place the order again.");
  }
  const balance = Number((walletSnapshot.exists ? walletSnapshot.data() as {balancePaise?: unknown} : {}).balancePaise ?? 0);
  return () => {
    for (const allocation of allocations) {
      const lot = lots.find((entry) => entry.lotId === allocation.lotId)!;
      transaction.set(database.collection(WALLET_LOTS).doc(lot.lotId), {
        remainingPaise: lot.remainingPaise - allocation.amountPaise,
        restaurantFundedPaise: Math.max(0, lot.restaurantFundedPaise - allocation.restaurantFundedPaise),
        updatedAt: input.at,
      }, {merge: true});
    }
    transaction.set(entryRef(database, `redeem_${safeId(input.orderId)}`), {
      customerId: input.customerId,
      type: "redeem",
      amountPaise: -input.amountPaise,
      orderId: input.orderId,
      allocations,
      at: input.at,
    });
    transaction.set(walletRef(database, input.customerId), {
      customerId: input.customerId,
      balancePaise: Math.max(0, balance - input.amountPaise),
      updatedAt: input.at,
    }, {merge: true});
  };
}

/** A cancelled order gives back exactly the lots it used, once. */
export async function restoreWalletRedemption(orderId: string, database: FirestoreLike = firestoreDb): Promise<number> {
  const redeemRef = entryRef(database, `redeem_${safeId(orderId)}`);
  const restoreRef = entryRef(database, `restore_${safeId(orderId)}`);
  return database.runTransaction(async (transaction: TransactionLike) => {
    const [redeem, restored] = await Promise.all([transaction.get(redeemRef), transaction.get(restoreRef)]);
    if (!redeem.exists || restored.exists) return 0;
    const data = redeem.data() as {customerId: string; allocations?: LotAllocation[]};
    const allocations = data.allocations ?? [];
    const lotRefs = allocations.map((allocation) => database.collection(WALLET_LOTS).doc(allocation.lotId));
    const lotSnapshots = await Promise.all(lotRefs.map((ref) => transaction.get(ref)));
    const wallet = await transaction.get(walletRef(database, data.customerId));
    const control = await loadEconomicsControl(Date.now(), database);
    const now = Date.now();
    let total = 0;
    allocations.forEach((allocation, index) => {
      const snapshot = lotSnapshots[index]!;
      if (!snapshot.exists) return;
      const lot = normalizeWalletLot(snapshot.id, snapshot.data());
      total += allocation.amountPaise;
      transaction.set(lotRefs[index]!, {
        remainingPaise: lot.remainingPaise + allocation.amountPaise,
        restaurantFundedPaise: lot.restaurantFundedPaise + allocation.restaurantFundedPaise,
        // Money that expired while the order was open gets a short grace period.
        expiresAt: lot.expiresAt > now ? lot.expiresAt : now + control.walletRules.restoreGraceDays * DAY_MS,
        updatedAt: now,
      }, {merge: true});
    });
    const balance = Number((wallet.exists ? wallet.data() as {balancePaise?: unknown} : {}).balancePaise ?? 0);
    transaction.set(restoreRef, {customerId: data.customerId, type: "restore", amountPaise: total, orderId, at: now});
    transaction.set(walletRef(database, data.customerId), {balancePaise: balance + total, updatedAt: now}, {merge: true});
    return total;
  });
}

// ---------------------------------------------------------------------------
// Earning cashback after delivery
// ---------------------------------------------------------------------------

function walletJournal(input: {
  eventType: "cashback_earned" | "cashback_reversed" | "wallet_expired" | "customer_referral_reward";
  eventId: string;
  occurredAt: number;
  customerId: string;
  amountPaise: number;
  platformPaise: number;
  restaurantPaise: number;
  restaurantId: string;
  orderId?: string;
  campaignId?: string;
  attribution: LedgerAttribution;
}): LedgerJournal {
  const wallet = `liability:customer-wallet:${input.customerId}`;
  const restaurant = `liability:restaurant-payable:${input.restaurantId}`;
  const postings: {accountId: string; side: "debit" | "credit"; amountPaise: number; memo: string}[] = [];
  const push = (accountId: string, side: "debit" | "credit", amountPaise: number, memo: string) => {
    if (amountPaise > 0) postings.push({accountId, side, amountPaise, memo});
  };
  if (input.eventType === "cashback_earned") {
    push("expense:cashback", "debit", input.platformPaise, "Scraveit-funded cashback");
    push(restaurant, "debit", input.restaurantPaise, "Restaurant-funded cashback");
    push(wallet, "credit", input.amountPaise, "Cashback added to wallet");
  } else if (input.eventType === "customer_referral_reward") {
    push("expense:customer-referrals", "debit", input.amountPaise, "Customer referral reward");
    push(wallet, "credit", input.amountPaise, "Referral reward added to wallet");
  } else if (input.eventType === "cashback_reversed") {
    push(wallet, "debit", input.amountPaise, "Cashback reversed");
    push("expense:cashback", "credit", input.platformPaise, "Scraveit cashback recovered");
    push(restaurant, "credit", input.restaurantPaise, "Restaurant cashback returned");
  } else {
    push(wallet, "debit", input.amountPaise, "Wallet money expired");
    push("revenue:wallet-breakage", "credit", input.platformPaise, "Expired Scraveit-funded wallet money");
    push(restaurant, "credit", input.restaurantPaise, "Expired restaurant-funded cashback returned");
  }
  return createLedgerJournal({
    eventType: input.eventType,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    ...(input.orderId ? {orderId: input.orderId} : {}),
    actorId: "system:wallet",
    metadata: {
      customerId: input.customerId,
      ...(input.campaignId ? {campaignId: input.campaignId} : {}),
      ...(input.restaurantPaise ? {restaurantId: input.restaurantId} : {}),
      ...input.attribution,
    },
    postings,
  });
}

export interface CashbackResult {
  status: "earned" | "already_earned" | "none" | "blocked";
  amountPaise: number;
  campaignId?: string;
}

/**
 * Credits at most one cashback per delivered order, exactly once. The best
 * eligible campaign wins, then every cap applies: campaign budget, per-customer
 * limit, the daily earning cap, and - for contribution-funded cashback - the
 * allowed share of what this order safely earned.
 */
export async function earnCashbackForDeliveredOrder(
  order: SavrivoOrder,
  attribution: LedgerAttribution,
  database: FirestoreLike = firestoreDb,
): Promise<CashbackResult> {
  if (!order.economics || order.status !== "Delivered" || order.paymentState === "refunded") {
    return {status: "none", amountPaise: 0};
  }
  const earnId = `earn_${safeId(order.id)}`;
  if ((await entryRef(database, earnId).get()).exists) return {status: "already_earned", amountPaise: 0};
  const at = Number(order.deliveredAt ?? order.updatedAt) || Date.now();
  const [control, campaignsSnapshot, economicsDoc, risk, history] = await Promise.all([
    loadEconomicsControl(at, database),
    database.collection(CASHBACK_CAMPAIGNS).where("active", "==", true).limit(100).get(),
    orderEconomicsRef(database, order.id).get(),
    database.collection("customerRisk").doc(order.customerId).get(),
    database.collection("orders").where("customerId", "==", order.customerId).where("status", "==", "Delivered").limit(2).get(),
  ]);
  if (risk.exists && (risk.data() as {blockRewards?: unknown}).blockRewards === true) {
    logger.warn("CASHBACK_BLOCKED_BY_RISK_FLAG", {orderId: order.id, customerId: order.customerId});
    return {status: "blocked", amountPaise: 0};
  }
  const campaigns = campaignsSnapshot.docs.map((doc) => normalizeCashbackCampaign(doc.id, doc.data()));
  if (!campaigns.length) return {status: "none", amountPaise: 0};
  const snapshot = (economicsDoc.exists ? (economicsDoc.data() as {snapshot?: OrderEconomicsSnapshot}).snapshot : undefined);
  const policy = resolveEconomicsPolicy(control.policies, {cityKey: order.economics.cityKey}).policy;
  const safeContributionPaise = snapshot ?
    Math.max(0, snapshot.platform.contributionPaise - snapshot.guardrail.minimumContributionPaise) : 0;
  const usageRefs = campaigns.filter((campaign) => campaign.perCustomerLimit > 0)
    .map((campaign) => database.collection("cashbackCustomerUsage").doc(`${campaign.id}_${order.customerId}`));
  const usageSnapshots = await Promise.all(usageRefs.map((ref) => ref.get()));
  const usesByCampaign: Record<string, number> = {};
  usageSnapshots.forEach((doc) => {
    if (!doc.exists) return;
    const data = doc.data() as {campaignId?: string; count?: number};
    if (data.campaignId) usesByCampaign[data.campaignId] = Number(data.count ?? 0);
  });
  const context = {
    subtotalPaise: order.economics.customer.itemSubtotalPaise,
    restaurantId: order.restaurantId,
    cityKey: order.economics.cityKey,
    zoneKey: order.economics.zoneKey,
    orderedAt: order.createdAt,
    safeContributionPaise,
    policyContributionShareBps: policy.cashbackMaxShareOfContributionBps,
    isFirstOrder: history.size <= 1,
  };
  const candidate = bestCashbackAward(campaigns, context, usesByCampaign);
  if (!candidate) return {status: "none", amountPaise: 0};

  const dayRef = database.collection("walletDailyEarn").doc(`${order.customerId}_${istDayKey(at)}`);
  const campaignRef = database.collection(CASHBACK_CAMPAIGNS).doc(candidate.campaignId);
  const usageRef = database.collection("cashbackCustomerUsage").doc(`${candidate.campaignId}_${order.customerId}`);
  const lotId = `cb_${safeId(order.id)}`;
  const award = await database.runTransaction(async (transaction: TransactionLike): Promise<CashbackAward | null> => {
    const [entry, day, campaignSnap, usage, wallet] = await Promise.all([
      transaction.get(entryRef(database, earnId)),
      transaction.get(dayRef),
      transaction.get(campaignRef),
      transaction.get(usageRef),
      transaction.get(walletRef(database, order.customerId)),
    ]);
    if (entry.exists) return null;
    const live = normalizeCashbackCampaign(candidate.campaignId, campaignSnap.exists ? campaignSnap.data() : null);
    const uses = Number((usage.exists ? usage.data() as {count?: unknown} : {}).count ?? 0);
    const recheck = bestCashbackAward([live], context, {[live.id]: uses});
    if (!recheck) return null;
    const earnedToday = Number((day.exists ? day.data() as {earnedPaise?: unknown} : {}).earnedPaise ?? 0);
    const capped = capDailyEarn(recheck, control.walletRules, earnedToday);
    if (!capped) return null;
    const expiresAt = at + capped.expiryDays * DAY_MS;
    const balance = Number((wallet.exists ? wallet.data() as {balancePaise?: unknown} : {}).balancePaise ?? 0);
    transaction.set(database.collection(WALLET_LOTS).doc(lotId), {
      customerId: order.customerId,
      source: "cashback",
      amountPaise: capped.amountPaise,
      remainingPaise: capped.amountPaise,
      restaurantFundedPaise: capped.restaurantFundedPaise,
      restaurantId: capped.restaurantId,
      campaignId: capped.campaignId,
      orderId: order.id,
      cityKey: order.economics!.cityKey,
      createdAt: at,
      expiresAt,
    });
    transaction.set(entryRef(database, earnId), {
      customerId: order.customerId,
      type: "cashback",
      amountPaise: capped.amountPaise,
      platformFundedPaise: capped.platformFundedPaise,
      restaurantFundedPaise: capped.restaurantFundedPaise,
      lotId,
      campaignId: capped.campaignId,
      orderId: order.id,
      expiresAt,
      at,
    });
    transaction.set(walletRef(database, order.customerId), {
      customerId: order.customerId,
      balancePaise: balance + capped.amountPaise,
      updatedAt: at,
    }, {merge: true});
    if (live.funding !== "restaurant") {
      transaction.set(campaignRef, {usedBudgetPaise: live.usedBudgetPaise + capped.platformFundedPaise}, {merge: true});
    }
    transaction.set(usageRef, {campaignId: live.id, customerId: order.customerId, count: uses + 1, updatedAt: at}, {merge: true});
    transaction.set(dayRef, {customerId: order.customerId, earnedPaise: earnedToday + capped.amountPaise, updatedAt: at}, {merge: true});
    transaction.set(orderEconomicsRef(database, order.id), {
      cashback: {
        campaignId: capped.campaignId,
        amountPaise: capped.amountPaise,
        platformFundedPaise: capped.platformFundedPaise,
        restaurantFundedPaise: capped.restaurantFundedPaise,
        funding: live.funding,
        earnedAt: at,
      },
    }, {merge: true});
    return capped;
  });
  if (!award) return {status: "none", amountPaise: 0};
  await persistLedgerJournalIfAbsent(walletJournal({
    eventType: "cashback_earned",
    eventId: `cashback:${order.id}`,
    occurredAt: at,
    customerId: order.customerId,
    amountPaise: award.amountPaise,
    platformPaise: award.platformFundedPaise,
    restaurantPaise: award.restaurantFundedPaise,
    restaurantId: award.restaurantId || order.restaurantId,
    orderId: order.id,
    campaignId: award.campaignId,
    attribution,
  }), database);
  logger.info("CASHBACK_EARNED", {orderId: order.id, customerId: order.customerId, ...award});
  return {status: "earned", amountPaise: award.amountPaise, campaignId: award.campaignId};
}

/**
 * Refund or cancellation after cashback was earned: takes back whatever of
 * that cashback is still unspent, exactly once. Spent cashback cannot be
 * clawed back from the customer and is reported as unrecovered.
 */
export async function reverseCashbackForOrder(
  order: Pick<SavrivoOrder, "id" | "customerId" | "restaurantId">,
  reason: string,
  attribution: LedgerAttribution,
  database: FirestoreLike = firestoreDb,
): Promise<{recoveredPaise: number; unrecoveredPaise: number}> {
  const earnRef = entryRef(database, `earn_${safeId(order.id)}`);
  const reverseRef = entryRef(database, `reverse_${safeId(order.id)}`);
  const result = await database.runTransaction(async (transaction: TransactionLike) => {
    const [earn, reversed] = await Promise.all([transaction.get(earnRef), transaction.get(reverseRef)]);
    if (!earn.exists || reversed.exists) return null;
    const earned = earn.data() as {lotId: string; amountPaise: number; platformFundedPaise: number; restaurantFundedPaise: number; campaignId: string};
    const lotRef = database.collection(WALLET_LOTS).doc(earned.lotId);
    const [lotSnap, wallet] = await Promise.all([transaction.get(lotRef), transaction.get(walletRef(database, order.customerId))]);
    const lot = normalizeWalletLot(earned.lotId, lotSnap.exists ? lotSnap.data() : null);
    const recoveredPaise = Math.min(lot.remainingPaise, earned.amountPaise);
    const restaurantRecovered = earned.amountPaise > 0 ?
      Math.round(recoveredPaise * earned.restaurantFundedPaise / earned.amountPaise) : 0;
    const now = Date.now();
    const balance = Number((wallet.exists ? wallet.data() as {balancePaise?: unknown} : {}).balancePaise ?? 0);
    if (recoveredPaise > 0) {
      transaction.set(lotRef, {
        remainingPaise: lot.remainingPaise - recoveredPaise,
        restaurantFundedPaise: Math.max(0, lot.restaurantFundedPaise - restaurantRecovered),
        updatedAt: now,
      }, {merge: true});
      transaction.set(walletRef(database, order.customerId), {balancePaise: Math.max(0, balance - recoveredPaise), updatedAt: now}, {merge: true});
    }
    transaction.set(reverseRef, {
      customerId: order.customerId,
      type: "cashback_reversal",
      amountPaise: -recoveredPaise,
      unrecoveredPaise: earned.amountPaise - recoveredPaise,
      orderId: order.id,
      reason: reason.slice(0, 200),
      at: now,
    });
    return {recoveredPaise, restaurantRecovered, unrecoveredPaise: earned.amountPaise - recoveredPaise, campaignId: earned.campaignId, now};
  });
  if (!result) return {recoveredPaise: 0, unrecoveredPaise: 0};
  if (result.recoveredPaise > 0) {
    await persistLedgerJournalIfAbsent(walletJournal({
      eventType: "cashback_reversed",
      eventId: `cashback-reversal:${order.id}`,
      occurredAt: result.now,
      customerId: order.customerId,
      amountPaise: result.recoveredPaise,
      platformPaise: result.recoveredPaise - result.restaurantRecovered,
      restaurantPaise: result.restaurantRecovered,
      restaurantId: order.restaurantId,
      orderId: order.id,
      campaignId: result.campaignId,
      attribution,
    }), database);
  }
  if (result.unrecoveredPaise > 0) {
    logger.warn("CASHBACK_REVERSAL_PARTIAL", {orderId: order.id, unrecoveredPaise: result.unrecoveredPaise});
  }
  return {recoveredPaise: result.recoveredPaise, unrecoveredPaise: result.unrecoveredPaise};
}

/** Credits wallet money for a referral (used by customer referrals). */
export async function creditWalletLot(
  transaction: TransactionLike,
  input: {customerId: string; lotId: string; amountPaise: number; source: WalletLot["source"]; campaignId: string;
    cityKey: string; expiresAt: number; at: number; entryId: string; walletBalancePaise: number},
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  transaction.set(database.collection(WALLET_LOTS).doc(input.lotId), {
    customerId: input.customerId,
    source: input.source,
    amountPaise: input.amountPaise,
    remainingPaise: input.amountPaise,
    restaurantFundedPaise: 0,
    restaurantId: "",
    campaignId: input.campaignId,
    orderId: "",
    cityKey: input.cityKey,
    createdAt: input.at,
    expiresAt: input.expiresAt,
  });
  transaction.set(entryRef(database, input.entryId), {
    customerId: input.customerId,
    type: input.source,
    amountPaise: input.amountPaise,
    lotId: input.lotId,
    campaignId: input.campaignId,
    expiresAt: input.expiresAt,
    at: input.at,
  });
  transaction.set(walletRef(database, input.customerId), {
    customerId: input.customerId,
    balancePaise: input.walletBalancePaise + input.amountPaise,
    updatedAt: input.at,
  }, {merge: true});
}

export {walletRef as customerWalletRef, walletJournal};

/**
 * What the customer should expect back after delivery, for the checkout
 * screen. The real amount is decided at delivery with every cap re-checked.
 */
export async function estimateCashback(
  customerId: string,
  restaurantId: string,
  plan: CheckoutEconomicsPlan,
  priced: {pricing: PricingBreakdown; total: number},
  at: number,
  database: FirestoreLike = firestoreDb,
): Promise<{amount: number; title: string; campaignId: string} | null> {
  const campaigns = (await database.collection(CASHBACK_CAMPAIGNS).where("active", "==", true).limit(100).get())
    .docs.map((doc) => normalizeCashbackCampaign(doc.id, doc.data()));
  if (!campaigns.length) return null;
  const snapshot = finalizeOrderEconomics(plan, priced.pricing, priced.total, restaurantId, "cod", []);
  const history = await database.collection("orders").where("customerId", "==", customerId).limit(1).get();
  const award = bestCashbackAward(campaigns, {
    subtotalPaise: snapshot.customer.itemSubtotalPaise,
    restaurantId,
    cityKey: plan.cityKey,
    zoneKey: plan.zoneKey,
    orderedAt: at,
    safeContributionPaise: Math.max(0, snapshot.platform.contributionPaise - snapshot.guardrail.minimumContributionPaise),
    policyContributionShareBps: plan.policy.cashbackMaxShareOfContributionBps,
    isFirstOrder: history.empty,
  }, {});
  if (!award) return null;
  const campaign = campaigns.find((entry) => entry.id === award.campaignId);
  return {amount: award.amountPaise / 100, title: campaign?.title ?? "Cashback", campaignId: award.campaignId};
}

// ---------------------------------------------------------------------------
// Expiry (scheduled)
// ---------------------------------------------------------------------------

export async function expireWalletLots(now = Date.now(), database: FirestoreLike = firestoreDb): Promise<{expiredLots: number; expiredPaise: number}> {
  const due = await database.collection(WALLET_LOTS).where("expiresAt", "<=", now).limit(500).get();
  let expiredLots = 0;
  let expiredPaise = 0;
  for (const doc of due.docs) {
    const lot = normalizeWalletLot(doc.id, doc.data());
    if (lot.remainingPaise <= 0) continue;
    const expiredEntry = entryRef(database, `expire_${safeId(lot.lotId)}`);
    const result = await database.runTransaction(async (transaction: TransactionLike) => {
      const [current, done, wallet] = await Promise.all([
        transaction.get(database.collection(WALLET_LOTS).doc(lot.lotId)),
        transaction.get(expiredEntry),
        transaction.get(walletRef(database, lot.customerId)),
      ]);
      const live = normalizeWalletLot(lot.lotId, current.exists ? current.data() : null);
      if (done.exists || live.remainingPaise <= 0 || live.expiresAt > now) return null;
      const balance = Number((wallet.exists ? wallet.data() as {balancePaise?: unknown} : {}).balancePaise ?? 0);
      transaction.set(database.collection(WALLET_LOTS).doc(lot.lotId), {remainingPaise: 0, restaurantFundedPaise: 0, expiredAt: now}, {merge: true});
      transaction.set(expiredEntry, {customerId: live.customerId, type: "expiry", amountPaise: -live.remainingPaise, lotId: live.lotId, at: now});
      transaction.set(walletRef(database, live.customerId), {balancePaise: Math.max(0, balance - live.remainingPaise), updatedAt: now}, {merge: true});
      return live;
    });
    if (!result) continue;
    expiredLots += 1;
    expiredPaise += result.remainingPaise;
    const restaurantPart = Math.min(result.restaurantFundedPaise, result.remainingPaise);
    await persistLedgerJournalIfAbsent(walletJournal({
      eventType: "wallet_expired",
      eventId: `wallet-expiry:${result.lotId}`,
      occurredAt: now,
      customerId: result.customerId,
      amountPaise: result.remainingPaise,
      platformPaise: result.remainingPaise - restaurantPart,
      restaurantPaise: restaurantPart,
      restaurantId: result.restaurantId,
      ...(result.orderId ? {orderId: result.orderId} : {}),
      ...(result.campaignId ? {campaignId: result.campaignId} : {}),
      attribution: {cityKey: result.cityKey},
    }), database);
  }
  return {expiredLots, expiredPaise};
}

// ---------------------------------------------------------------------------
// Reads and admin control
// ---------------------------------------------------------------------------

export async function readCustomerWallet(uid: string, database: FirestoreLike = firestoreDb) {
  const now = Date.now();
  const [lots, entries, campaigns, control] = await Promise.all([
    readLots(database, uid),
    database.collection(WALLET_ENTRIES).where("customerId", "==", uid).orderBy("at", "desc").limit(30).get()
      .catch(() => ({docs: []} as unknown as {docs: {id: string; data(): unknown}[]})),
    database.collection(CASHBACK_CAMPAIGNS).where("active", "==", true).limit(50).get(),
    loadEconomicsControl(now, database),
  ]);
  const live = lots.filter((lot) => lot.expiresAt > now && lot.remainingPaise > 0)
    .sort((left, right) => left.expiresAt - right.expiresAt);
  return {
    balancePaise: spendableBalance(lots, now),
    lots: live.map((lot) => ({lotId: lot.lotId, source: lot.source, remainingPaise: lot.remainingPaise, expiresAt: lot.expiresAt})),
    entries: entries.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {id: doc.id, type: data.type, amountPaise: data.amountPaise, orderId: data.orderId ?? "", at: data.at, expiresAt: data.expiresAt ?? null};
    }),
    rules: {
      maxRedeemBpsOfSubtotal: control.walletRules.maxRedeemBpsOfSubtotal,
      maxRedeemPerOrderPaise: control.walletRules.maxRedeemPerOrderPaise,
      minOrderForRedeemPaise: control.walletRules.minOrderForRedeemPaise,
    },
    cashbackCampaigns: campaigns.docs.map((doc) => normalizeCashbackCampaign(doc.id, doc.data()))
      .filter((campaign) => (!campaign.startsAt || now >= campaign.startsAt) && (!campaign.endsAt || now < campaign.endsAt))
      .map((campaign) => ({
        id: campaign.id,
        title: campaign.title,
        kind: campaign.kind,
        percent: campaign.percent,
        flatAmountPaise: campaign.flatAmountPaise,
        maxCashbackPaise: campaign.maxCashbackPaise,
        minimumOrderPaise: campaign.minimumOrderPaise,
        restaurantIds: campaign.restaurantIds,
        cityKeys: campaign.cityKeys,
        expiryDays: campaign.expiryDays,
        funding: campaign.funding === "restaurant" || campaign.funding === "shared" ? "restaurant" : "scraveit",
      })),
  };
}

export async function upsertCashbackCampaignForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: Record<string, unknown> & {campaignId?: string; reason: string},
  database: FirestoreLike = firestoreDb,
) {
  const role = requirePlatformConfigAdminClaim(token);
  const now = Date.now();
  const id = String(input.campaignId || `cb_${now.toString(36)}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const ref = database.collection(CASHBACK_CAMPAIGNS).doc(id);
  const normalized = normalizeCashbackCampaign(id, input);
  if ((normalized.funding === "restaurant" || normalized.funding === "shared") && !normalized.restaurantIds.length) {
    throw new DomainError("failed-precondition", "Restaurant-funded or shared cashback must name the restaurants that agreed to fund it.");
  }
  if (normalized.kind === "percent" && normalized.percent <= 0 || normalized.kind === "flat" && normalized.flatAmountPaise <= 0) {
    throw new DomainError("invalid-argument", "Give a cashback amount.");
  }
  return database.runTransaction(async (transaction: TransactionLike) => {
    const existing = await transaction.get(ref);
    const before = existing.exists ? existing.data() as Record<string, unknown> : null;
    const document = {
      ...normalized,
      usedBudgetPaise: Number(before?.usedBudgetPaise ?? 0) || 0,
      cityKeys: normalized.cityKeys.map(economicsScopeKey),
      updatedAt: now,
      updatedBy: uid,
    };
    transaction.set(ref, document);
    transaction.set(database.collection("audit").doc(`cashback_${id}_${now}`), {
      action: before ? "cashback.update" : "cashback.create", target: id, actorId: uid, actorRole: role,
      reason: String(input.reason ?? "").slice(0, 500), before, after: document, at: now,
    });
    return document;
  });
}

export async function listCashbackCampaignsForAdmin(token: DecodedIdToken, database: FirestoreLike = firestoreDb) {
  requirePlatformConfigAdminClaim(token);
  const snapshot = await database.collection(CASHBACK_CAMPAIGNS).limit(200).get();
  return snapshot.docs.map((doc) => normalizeCashbackCampaign(doc.id, doc.data()));
}

export const DAY_MILLISECONDS = DAY_MS;
