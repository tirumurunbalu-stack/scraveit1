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

  it("sets returned TDS off oldest first: due − offset = deducted", () => {
    const pool = {participantKey: "rider:r1", financialYear: "26-27",
      sources: [{orderId: "a", amountPaise: 30, remainingPaise: 30}, {orderId: "b", amountPaise: 50, remainingPaise: 50}]};
    const result = applyTdsOffset(pool, 60);
    expect(result).toMatchObject({offsetPaise: 60, tdsActuallyDeductedPaise: 0, fullyApplied: ["a"]});
    expect(result.pool.sources.map((source) => source.remainingPaise)).toEqual([0, 20]);
    expect(applyTdsOffset(result.pool, 100)).toMatchObject({offsetPaise: 20, tdsActuallyDeductedPaise: 80, fullyApplied: ["b"]});
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
  it("cannot activate GST or TDS while any fee classification is unconfirmed", () => {
    const base = {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5", tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true};
    const unconfirmed = normalizeTaxSettings(base);
    expect(unconfirmed).toMatchObject({gstActive: false, tdsActive: false});
    expect(unconfirmed.activationBlockers).toEqual(["FEE_CLASSIFICATION_UNCONFIRMED:rainDeliveryAmount",
      "FEE_CLASSIFICATION_UNCONFIRMED:lateNightDeliveryAmount", "FEE_CLASSIFICATION_UNCONFIRMED:busyKitchenFee"]);
    expect(normalizeTaxSettings({...base, feeOwnership: CONFIRMED_FEES})).toMatchObject({gstActive: true, tdsActive: true,
      activationBlockers: []});
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
