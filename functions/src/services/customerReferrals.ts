import {randomInt} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {economicsScopeKey} from "../domain/economics";
import {haversineKm} from "../domain/order";
import {
  customerReferralProgramOpen,
  referralQualifies,
  referralRiskFlags,
  type ReferralRiskSignals,
} from "../domain/customerPricing";
import {DomainError} from "../errors";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";
import {requirePlatformConfigAdminClaim} from "./authz";
import {loadEconomicsControl} from "./economics";
import {persistLedgerJournalIfAbsent, type LedgerAttribution} from "./ledger";
import {DAY_MILLISECONDS, creditWalletLot, customerWalletRef, walletJournal} from "./wallet";

/**
 * Customer referrals. A code alone earns nothing: both people are rewarded
 * only when the new customer's qualifying delivered order(s) happen (unless an
 * admin deliberately turns on signup rewards). Referrals showing fraud
 * signals wait for an admin decision.
 */

const PROFILES = "customerReferralProfiles";
const CODES = "customerReferralCodes";
const REFERRALS = "customerReferrals";
const INSTALLS = "referralInstallations";
const BUDGET = "programBudgets";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type CustomerReferralStatus = "pending" | "review" | "approved" | "rejected" | "rewarded" | "expired";

function makeCode(): string {
  let code = "SC";
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function normalizeReferralCode(value: unknown): string {
  const raw = String(value ?? "").trim().toUpperCase();
  // A pasted link ends with the code; the domain itself ("SCRAVEIT") must not
  // be mistaken for one, so take the last standalone match.
  const matches = [...raw.matchAll(/(?:^|[^A-Z0-9])(SC[A-Z0-9]{6})(?![A-Z0-9])/g)];
  return matches.length ? matches[matches.length - 1]![1]! : "";
}

function cleanInstallId(value: unknown): string {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : "";
}

/** Returns (and on first call reserves) the customer's own code. */
export async function ensureCustomerReferralCode(
  uid: string,
  installId: string,
  database: FirestoreLike = firestoreDb,
): Promise<string> {
  const profileRef = database.collection(PROFILES).doc(uid);
  const install = cleanInstallId(installId);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = makeCode();
    const code = await database.runTransaction(async (transaction: TransactionLike) => {
      const [profile, taken] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(database.collection(CODES).doc(candidate)),
      ]);
      const current = (profile.exists ? profile.data() : {}) as {code?: string; installIds?: string[]};
      const installIds = [...new Set([...(current.installIds ?? []), ...(install ? [install] : [])])].slice(-10);
      if (current.code) {
        if (install && !(current.installIds ?? []).includes(install)) {
          transaction.set(profileRef, {installIds}, {merge: true});
        }
        return current.code;
      }
      if (taken.exists) return null;
      transaction.set(database.collection(CODES).doc(candidate), {uid, createdAt: Date.now()});
      transaction.set(profileRef, {uid, code: candidate, installIds, createdAt: Date.now()}, {merge: true});
      return candidate;
    });
    if (code) return code;
  }
  throw new DomainError("unavailable", "A referral code could not be created. Try again.");
}

function addressesOf(profile: Record<string, unknown>): {lat: number; lng: number; phone: string}[] {
  const raw = profile.addresses;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as object) : [];
  return list.map((entry) => entry as Record<string, unknown>)
    .filter((entry) => Number.isFinite(Number(entry.lat)) && Number.isFinite(Number(entry.lng)))
    .map((entry) => ({lat: Number(entry.lat), lng: Number(entry.lng), phone: String(entry.phone ?? "").replace(/\D/g, "").slice(-10)}));
}

function phonesOf(profile: Record<string, unknown>): Set<string> {
  const phones = new Set<string>();
  const main = String(profile.phone ?? "").replace(/\D/g, "").slice(-10);
  if (main.length === 10) phones.add(main);
  addressesOf(profile).forEach((address) => address.phone.length === 10 && phones.add(address.phone));
  return phones;
}

function customerCityKey(profile: Record<string, unknown>): string {
  if (profile.city) return economicsScopeKey(profile.city);
  const raw = profile.addresses;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as object) : [];
  const withCity = list.map((entry) => entry as Record<string, unknown>).find((entry) => entry.city);
  return withCity ? economicsScopeKey(withCity.city) : "";
}

/** Links a new customer to the person who invited them. */
export async function applyCustomerReferralCode(
  uid: string,
  input: {code: string; installId: string},
  database: FirestoreLike = firestoreDb,
): Promise<{status: CustomerReferralStatus; flags: string[]; rewardedOnSignup: boolean}> {
  const code = normalizeReferralCode(input.code);
  if (!code) throw new DomainError("invalid-argument", "Enter a valid referral code.");
  const control = await loadEconomicsControl(Date.now(), database);
  const program = control.customerReferral;
  const now = Date.now();
  const [codeDoc, existing, anyOrder, myProfile] = await Promise.all([
    database.collection(CODES).doc(code).get(),
    database.collection(REFERRALS).doc(uid).get(),
    database.collection("orders").where("customerId", "==", uid).limit(1).get(),
    database.collection("users").doc(uid).get(),
  ]);
  if (!codeDoc.exists) throw new DomainError("not-found", "That referral code does not exist.");
  const referrerUid = String((codeDoc.data() as {uid?: string}).uid ?? "");
  if (!referrerUid || referrerUid === uid) throw new DomainError("failed-precondition", "You cannot use your own referral code.");
  if (existing.exists) throw new DomainError("already-exists", "A referral code is already linked to this account.");
  if (!anyOrder.empty) throw new DomainError("failed-precondition", "Referral codes are only for customers who have not ordered yet.");
  const me = (myProfile.exists ? myProfile.data() : {}) as Record<string, unknown>;
  const myCity = customerCityKey(me);
  if (!customerReferralProgramOpen(program, myCity, now)) {
    throw new DomainError("failed-precondition", "The referral programme is not running right now.");
  }
  const [referrerProfile, referrerReferralProfile] = await Promise.all([
    database.collection("users").doc(referrerUid).get(),
    database.collection(PROFILES).doc(referrerUid).get(),
  ]);
  const them = (referrerProfile.exists ? referrerProfile.data() : {}) as Record<string, unknown>;
  const theirInstalls = ((referrerReferralProfile.exists ? referrerReferralProfile.data() : {}) as {installIds?: string[]}).installIds ?? [];
  const install = cleanInstallId(input.installId);
  const installDoc = install ? await database.collection(INSTALLS).doc(install).get() : null;
  const myPhones = phonesOf(me);
  const signals: ReferralRiskSignals = {
    sameDevice: Boolean(install && theirInstalls.includes(install)),
    samePhone: [...phonesOf(them)].some((phone) => myPhones.has(phone)),
    nearbyAddress: addressesOf(me).some((mine) => addressesOf(them).some((theirs) => haversineKm(mine, theirs) < 0.1)),
    deviceUsedByOtherReferral: Boolean(installDoc?.exists && (installDoc.data() as {uid?: string}).uid !== uid),
    // Payment accounts are not exposed by the gateway integration yet; the
    // signal is recorded as unknown (false) and listed as a known gap.
    samePaymentAccount: false,
  };
  const flags = referralRiskFlags(signals);
  const status: CustomerReferralStatus = flags.length && !program.autoApproveFlagged ? "review" : "pending";
  await database.runTransaction(async (transaction: TransactionLike) => {
    const again = await transaction.get(database.collection(REFERRALS).doc(uid));
    if (again.exists) throw new DomainError("already-exists", "A referral code is already linked to this account.");
    transaction.set(database.collection(REFERRALS).doc(uid), {
      referredUid: uid,
      referrerUid,
      code,
      status,
      flags,
      signals,
      installId: install,
      cityKey: myCity,
      appliedAt: now,
      updatedAt: now,
    });
    if (install) transaction.set(database.collection(INSTALLS).doc(install), {uid, code, at: now}, {merge: true});
  });
  let rewardedOnSignup = false;
  if (program.rewardOnSignup && status === "pending") {
    rewardedOnSignup = await rewardReferral(uid, "signup", {cityKey: myCity}, database);
  }
  logger.info("CUSTOMER_REFERRAL_APPLIED", {uid, referrerUid, status, flags});
  return {status, flags, rewardedOnSignup};
}

/**
 * Pays both sides once, from the programme budget. The referral record's
 * status is the guard: only a pending/approved referral can become rewarded.
 */
async function rewardReferral(
  referredUid: string,
  trigger: string,
  attribution: LedgerAttribution,
  database: FirestoreLike,
): Promise<boolean> {
  const control = await loadEconomicsControl(Date.now(), database);
  const program = control.customerReferral;
  const referralRef = database.collection(REFERRALS).doc(referredUid);
  const budgetRef = database.collection(BUDGET).doc("customer_referral");
  const now = Date.now();
  const outcome = await database.runTransaction(async (transaction: TransactionLike) => {
    const referral = await transaction.get(referralRef);
    const data = (referral.exists ? referral.data() : {}) as {status?: string; referrerUid?: string; cityKey?: string};
    if (!referral.exists || (data.status !== "pending" && data.status !== "approved") || !data.referrerUid) return null;
    const [budget, referrerWallet, referredWallet] = await Promise.all([
      transaction.get(budgetRef),
      transaction.get(customerWalletRef(database, data.referrerUid)),
      transaction.get(customerWalletRef(database, referredUid)),
    ]);
    const total = program.referrerRewardPaise + program.refereeRewardPaise;
    const spent = Number((budget.exists ? budget.data() as {spentPaise?: unknown} : {}).spentPaise ?? 0);
    if (program.budgetPaise > 0 && spent + total > program.budgetPaise) {
      transaction.set(referralRef, {status: "pending", budgetBlockedAt: now, updatedAt: now}, {merge: true});
      return "budget";
    }
    const expiresAt = now + program.rewardExpiryDays * DAY_MILLISECONDS;
    const balance = (doc: typeof referrerWallet) => Number((doc.exists ? doc.data() as {balancePaise?: unknown} : {}).balancePaise ?? 0);
    if (program.referrerRewardPaise > 0) {
      await creditWalletLot(transaction, {
        customerId: data.referrerUid, lotId: `ref_${referredUid}_referrer`, amountPaise: program.referrerRewardPaise,
        source: "customer_referral", campaignId: "customer_referral", cityKey: data.cityKey ?? "", expiresAt, at: now,
        entryId: `referral_${referredUid}_referrer`, walletBalancePaise: balance(referrerWallet),
      }, database);
    }
    if (program.refereeRewardPaise > 0) {
      await creditWalletLot(transaction, {
        customerId: referredUid, lotId: `ref_${referredUid}_referee`, amountPaise: program.refereeRewardPaise,
        source: "customer_referral", campaignId: "customer_referral", cityKey: data.cityKey ?? "", expiresAt, at: now,
        entryId: `referral_${referredUid}_referee`, walletBalancePaise: balance(referredWallet),
      }, database);
    }
    transaction.set(budgetRef, {program: "customer_referral", spentPaise: spent + total, updatedAt: now}, {merge: true});
    transaction.set(referralRef, {
      status: "rewarded", rewardedAt: now, trigger,
      referrerRewardPaise: program.referrerRewardPaise, refereeRewardPaise: program.refereeRewardPaise, updatedAt: now,
    }, {merge: true});
    return {referrerUid: data.referrerUid, cityKey: data.cityKey ?? ""};
  });
  if (outcome === "budget") {
    logger.warn("CUSTOMER_REFERRAL_BUDGET_EXHAUSTED", {referredUid});
    return false;
  }
  if (!outcome) return false;
  const journalAttribution = {...attribution, cityKey: attribution.cityKey || outcome.cityKey};
  for (const [customerId, amount, role] of [
    [outcome.referrerUid, program.referrerRewardPaise, "referrer"],
    [referredUid, program.refereeRewardPaise, "referee"],
  ] as const) {
    if (amount <= 0) continue;
    await persistLedgerJournalIfAbsent(walletJournal({
      eventType: "customer_referral_reward",
      eventId: `customer-referral:${referredUid}:${role}`,
      occurredAt: now,
      customerId,
      amountPaise: amount,
      platformPaise: amount,
      restaurantPaise: 0,
      restaurantId: "",
      campaignId: "customer_referral",
      attribution: journalAttribution,
    }), database);
  }
  logger.info("CUSTOMER_REFERRAL_REWARDED", {referredUid, referrerUid: outcome.referrerUid, trigger});
  return true;
}

/** Called for every delivered order; rewards a waiting referral once it qualifies. */
export async function qualifyCustomerReferralOnDelivery(
  order: SavrivoOrder,
  attribution: LedgerAttribution,
  database: FirestoreLike = firestoreDb,
): Promise<boolean> {
  const referral = await database.collection(REFERRALS).doc(order.customerId).get();
  if (!referral.exists) return false;
  const data = referral.data() as {status?: string; appliedAt?: number};
  if (data.status !== "pending" && data.status !== "approved") return false;
  const control = await loadEconomicsControl(Date.now(), database);
  const program = control.customerReferral;
  const now = Date.now();
  const delivered = await database.collection("orders")
    .where("customerId", "==", order.customerId).where("status", "==", "Delivered")
    .limit(Math.max(1, program.minDeliveredOrders)).get();
  const qualifies = referralQualifies({
    program,
    deliveredOrders: delivered.size,
    orderSubtotalPaise: Math.round(Number(order.pricing.subtotal) * 100),
    appliedAt: Number(data.appliedAt ?? 0),
    at: now,
  });
  if (!qualifies) {
    if (now - Number(data.appliedAt ?? 0) > program.qualifyWithinDays * DAY_MILLISECONDS) {
      await database.collection(REFERRALS).doc(order.customerId).set({status: "expired", updatedAt: now}, {merge: true});
    }
    return false;
  }
  return rewardReferral(order.customerId, `order:${order.id}`, attribution, database);
}

export async function readCustomerReferral(uid: string, installId: string, database: FirestoreLike = firestoreDb) {
  const [code, mine, invited, control] = await Promise.all([
    ensureCustomerReferralCode(uid, installId, database),
    database.collection(REFERRALS).doc(uid).get(),
    database.collection(REFERRALS).where("referrerUid", "==", uid).limit(100).get(),
    loadEconomicsControl(Date.now(), database),
  ]);
  const program = control.customerReferral;
  const invitedList = invited.docs.map((doc) => doc.data() as {status?: string});
  return {
    code,
    shareText: `Order food on Scraveit with my code ${code}. You get ₹${Math.round(program.refereeRewardPaise / 100)} in your wallet after your first delivered order.`,
    program: {
      active: program.active,
      referrerRewardPaise: program.referrerRewardPaise,
      refereeRewardPaise: program.refereeRewardPaise,
      minDeliveredOrders: program.minDeliveredOrders,
      minOrderValuePaise: program.minOrderValuePaise,
      qualifyWithinDays: program.qualifyWithinDays,
      rewardOnSignup: program.rewardOnSignup,
    },
    myReferral: mine.exists ? {status: (mine.data() as {status?: string}).status ?? "pending"} : null,
    invited: {
      total: invitedList.length,
      rewarded: invitedList.filter((entry) => entry.status === "rewarded").length,
      waiting: invitedList.filter((entry) => ["pending", "approved", "review"].includes(String(entry.status))).length,
    },
  };
}

export async function listCustomerReferralsForAdmin(token: DecodedIdToken, database: FirestoreLike = firestoreDb) {
  requirePlatformConfigAdminClaim(token);
  const [review, recent, budget] = await Promise.all([
    database.collection(REFERRALS).where("status", "==", "review").limit(100).get(),
    database.collection(REFERRALS).orderBy("appliedAt", "desc").limit(50).get().catch(() => ({docs: []} as unknown as {docs: {data(): unknown}[]})),
    database.collection(BUDGET).doc("customer_referral").get(),
  ]);
  return {
    review: review.docs.map((doc) => doc.data()),
    recent: recent.docs.map((doc) => doc.data()),
    spentPaise: Number((budget.exists ? budget.data() as {spentPaise?: unknown} : {}).spentPaise ?? 0),
  };
}

export async function reviewCustomerReferralForAdmin(
  uid: string,
  token: DecodedIdToken,
  input: {referredUid: string; decision: "approved" | "rejected"; reason: string},
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  const role = requirePlatformConfigAdminClaim(token);
  const ref = database.collection(REFERRALS).doc(input.referredUid);
  const now = Date.now();
  await database.runTransaction(async (transaction: TransactionLike) => {
    const current = await transaction.get(ref);
    if (!current.exists) throw new DomainError("not-found", "Referral not found.");
    if ((current.data() as {status?: string}).status !== "review") {
      throw new DomainError("failed-precondition", "This referral is not waiting for review.");
    }
    transaction.set(ref, {status: input.decision, reviewedBy: uid, reviewReason: input.reason.slice(0, 300), reviewedAt: now, updatedAt: now}, {merge: true});
    transaction.set(database.collection("audit").doc(`customer_referral_${input.referredUid}_${now}`), {
      action: `customer_referral.${input.decision}`, target: input.referredUid, actorId: uid, actorRole: role, reason: input.reason, at: now,
    });
  });
}
