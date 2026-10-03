import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {createLedgerJournal} from "../src/domain/ledger";
import {
  applyTdsOffset,
  DEFAULT_RIDER_PAYMENT_CATEGORIES,
  PERQUISITE_RULE,
  perquisiteTdsOnCredit,
  riderPaymentCategoryOf,
  tdsRouteOf,
} from "../src/domain/riderPaymentTax";
import type {FirestoreLike} from "../src/firestoreTypes";
import {sweepRiderContractorTds} from "../src/services/riderTds";
import {normalizeTaxSettings} from "../src/services/taxEngine";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const at = Date.parse("2026-10-10T12:00:00+05:30");
const CONFIRMED_FEES = Object.fromEntries(["customerDeliveryCharge", "deliverySurge", "rainDeliveryAmount", "lateNightDeliveryAmount",
  "busyKitchenFee"].map((key) => [key, {contractConfirmed: true}]));
const TDS_ON = {tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true, feeOwnership: CONFIRMED_FEES};

describe("rider payment tax categories (RIDER-supplier model)", () => {
  const map = DEFAULT_RIDER_PAYMENT_CATEGORIES;
  it("defaults delivery-linked incentives to delivery consideration (8(v)) and referrals to their own category", () => {
    expect(riderPaymentCategoryOf("rider_incentive", undefined, map)).toBe("DELIVERY_SERVICE_CONSIDERATION");
    expect(tdsRouteOf("DELIVERY_SERVICE_CONSIDERATION", map)).toBe("ECOMMERCE_8V");
    expect(riderPaymentCategoryOf("rider_referral_reward", undefined, map)).toBe("REFERRAL_SERVICE");
    expect(tdsRouteOf("REFERRAL_SERVICE", map)).toBe("NONE");
    expect(tdsRouteOf("REFERRAL_SERVICE", {...map, referralTdsTreatment: "BUSINESS_INCENTIVE_OR_PERQUISITE"})).toBe("PERQUISITE_8IV");
    expect(tdsRouteOf("BUSINESS_INCENTIVE_OR_PERQUISITE", map)).toBe("PERQUISITE_8IV");
    expect(tdsRouteOf("REIMBURSEMENT", map)).toBe("NONE");
    expect(tdsRouteOf("EX_GRATIA", map)).toBe("NONE");
    // An explicit tag on the journal wins.
    expect(riderPaymentCategoryOf("rider_incentive", "EX_GRATIA", map)).toBe("EX_GRATIA");
  });

  it("applies business-benefit TDS at 10% only once the year's value exceeds ₹20,000, then on the whole year", () => {
    expect(perquisiteTdsOnCredit(PERQUISITE_RULE, 19_000_00, 0, 1_000_00).tdsPaise).toBe(0);
    expect(perquisiteTdsOnCredit(PERQUISITE_RULE, 19_000_00, 0, 1_000_01).tdsPaise).toBe(Math.round(20_000_01 * 0.1));
    expect(perquisiteTdsOnCredit(PERQUISITE_RULE, 25_000_00, 2_50_000, 1_000_00).tdsPaise).toBe(10_000);
  });

  it("sets returned TDS off oldest first, partially, within one PAN + tax year + provision + account only", () => {
    const scope = {participantKey: "rider:r1", pan: "ABCPR1234K", provision: "ECOMMERCE_TDS" as const, financialYear: "26-27"};
    const source = (orderId: string, createdAt: number, amount: number, overrides = {}) => ({orderId, participantKey: "rider:r1",
      pan: "ABCPR1234K", provision: "ECOMMERCE_TDS" as const, financialYear: "26-27", createdAt, originalOffsetPaise: amount,
      offsetUsedPaise: 0, offsetRemainingPaise: amount, ...overrides});
    const pool = {provision: "ECOMMERCE_TDS" as const, pan: "ABCPR1234K", financialYear: "26-27", sources: [
      source("newer", 20, 50), source("older", 10, 30),
      source("otherPan", 1, 99, {pan: "ZZZPZ9999Z"}), source("contractor", 1, 99, {provision: "CONTRACTOR_TDS"}),
      source("lastYear", 1, 99, {financialYear: "25-26"}), source("otherRider", 1, 99, {participantKey: "rider:r2"})]};
    const first = applyTdsOffset(pool, 60, scope);
    expect(first).toMatchObject({offsetPaise: 60, tdsActuallyDeductedPaise: 0,
      usage: [{orderId: "older", usedPaise: 30, offsetRemainingPaise: 0}, {orderId: "newer", usedPaise: 30, offsetRemainingPaise: 20}]});
    expect(first.pool.sources.find((entry) => entry.orderId === "newer")).toMatchObject({offsetUsedPaise: 30, offsetRemainingPaise: 20});
    expect(applyTdsOffset(first.pool, 100, scope)).toMatchObject({offsetPaise: 20, tdsActuallyDeductedPaise: 80});
    expect(first.pool.sources.filter((entry) => entry.offsetRemainingPaise === 99)).toHaveLength(4);
  });
});

function credit(id: string, eventType: "rider_incentive" | "rider_referral_reward", paise: number, metadata: Record<string, string> = {}) {
  return createLedgerJournal({eventType, eventId: id, occurredAt: at, metadata: {riderId: "r1", ...metadata}, postings: [
    {accountId: "expense:rider-rewards", side: "debit", amountPaise: paise},
    {accountId: "liability:rider-earnings:r1", side: "credit", amountPaise: paise},
  ]});
}

describe("the sweep under the RIDER model taxes SCRAVEIT payments by category, never contractor TDS", () => {
  it("quest bonus: e-commerce TDS 0.1%; referral: recorded, no TDS; perquisite: 10% past ₹20,000", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", TDS_ON);
    db.seed("riders/r1", {panNumber: "ABCCR1234K", legalEntityType: "COMPANY"});
    const journals = [credit("quest", "rider_incentive", 1_000_00),
      credit("referral", "rider_referral_reward", 5_000_00),
      credit("gift", "rider_incentive", 25_000_00, {riderPaymentTaxCategory: "BUSINESS_INCENTIVE_OR_PERQUISITE"})];
    for (const journal of journals) db.seed(`ledgerJournals/${journal.journalId}`, JSON.parse(JSON.stringify(journal)));
    const result = await sweepRiderContractorTds(db as unknown as FirestoreLike, at + 10);
    expect(result).toMatchObject({active: true, model: "RIDER"});
    const markers = db.paths().filter((path) => path.startsWith("riderTdsCredits/")).map((path) => db.read(path) as Record<string, unknown>);
    const byCategory = Object.fromEntries(markers.map((marker) => [marker.riderPaymentTaxCategory, marker]));
    expect(byCategory.DELIVERY_SERVICE_CONSIDERATION).toMatchObject({tdsRoute: "ECOMMERCE_8V", tdsPaise: 100});
    expect(byCategory.REFERRAL_SERVICE).toMatchObject({tdsRoute: "NONE", tdsPaise: 0});
    expect(byCategory.BUSINESS_INCENTIVE_OR_PERQUISITE).toMatchObject({tdsRoute: "PERQUISITE_8IV", tdsPaise: 2_50_000});
    expect(db.read("taxRiderEcomYears/r1_26-27")).toMatchObject({grossPaise: 1_000_00});
    const types = db.paths().filter((path) => /^ledgerJournals\/[^/]+$/.test(path)).map((path) => (db.read(path) as {eventType: string}).eventType);
    expect(types).toContain("rider_ecommerce_tds");
    expect(types).toContain("rider_perquisite_tds");
    expect(types).not.toContain("rider_contractor_tds");
  });
});

describe("going live", () => {
  it("blocks GST_LIVE and TDS_LIVE separately, each only by what changes its own result", () => {
    const base = {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5", tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true};
    const unconfirmed = normalizeTaxSettings(base);
    expect(unconfirmed.gstActivationBlockers).toEqual(["FEE_CLASSIFICATION_UNCONFIRMED:rainDeliveryAmount",
      "FEE_CLASSIFICATION_UNCONFIRMED:lateNightDeliveryAmount", "FEE_CLASSIFICATION_UNCONFIRMED:busyKitchenFee",
      "PLATFORM_SERVICE_SAC_PENDING_CONFIRMATION"]);
    // Busy-kitchen belongs to SCRAVEIT: it changes no TDS base, so it does not block TDS.
    expect(unconfirmed.tdsActivationBlockers).toEqual(["TDS_BASE_CLASSIFICATION_UNCONFIRMED:rainDeliveryAmount",
      "TDS_BASE_CLASSIFICATION_UNCONFIRMED:lateNightDeliveryAmount"]);
    // Rain and late night confirmed; SAC and busy-kitchen still pending: TDS can go live, GST cannot.
    const tdsReady = normalizeTaxSettings({...base, feeOwnership: {rainDeliveryAmount: {contractConfirmed: true},
      lateNightDeliveryAmount: {contractConfirmed: true}}});
    expect(tdsReady).toMatchObject({tdsActive: true, gstActive: false, tdsActivationBlockers: []});
    expect(tdsReady.gstActivationBlockers).toEqual(["FEE_CLASSIFICATION_UNCONFIRMED:busyKitchenFee",
      "PLATFORM_SERVICE_SAC_PENDING_CONFIRMATION"]);
    // A busy-kitchen fee owned by the store would change the store's base: then it blocks TDS too.
    expect(normalizeTaxSettings({...base, feeOwnership: {rainDeliveryAmount: {contractConfirmed: true},
      lateNightDeliveryAmount: {contractConfirmed: true}, busyKitchenFee: {economicOwner: "STORE"}}}).tdsActivationBlockers)
      .toEqual(["TDS_BASE_CLASSIFICATION_UNCONFIRMED:busyKitchenFee"]);
    expect(normalizeTaxSettings({...base, feeOwnership: CONFIRMED_FEES, scraveitRiderPlatformFeeSac: "998599",
      platformFeeSacConfirmed: true})).toMatchObject({gstActive: true, tdsActive: true, gstActivationBlockers: [], tdsActivationBlockers: []});
  });

  it("keeps the platform-service SAC PENDING_CONFIRMATION (998599 as candidate) at 18% until confirmed", () => {
    const settings = normalizeTaxSettings({});
    expect(settings.supplierFeePolicy).toMatchObject({platformFeeSac: "PENDING_CONFIRMATION", platformFeeSacCandidate: "998599",
      platformFeeGstRateBps: 1_800});
    expect(normalizeTaxSettings({scraveitRiderPlatformFeeSac: "998599"}).supplierFeePolicy.platformFeeSac).toBe("PENDING_CONFIRMATION");
    expect(normalizeTaxSettings({scraveitRiderPlatformFeeSac: "998599", platformFeeSacConfirmed: true}).supplierFeePolicy.platformFeeSac)
      .toBe("998599");
  });
});
