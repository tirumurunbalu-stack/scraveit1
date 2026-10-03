import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {deliverySupplierSettlement} from "../src/domain/deliverySupplierSettlement";
import {createLedgerJournal} from "../src/domain/ledger";
import {computeOrderTax, type SellerTaxProfile} from "../src/domain/orderTax";
import {financialYearLabel, normalizeTaxLaw} from "../src/domain/taxLaw";
import type {FirestoreLike} from "../src/firestoreTypes";
import {sweepRiderContractorTds} from "../src/services/riderTds";
import type {DecodedIdToken} from "firebase-admin/auth";
import {platformFeeSplit} from "../src/domain/deliverySupplierSettlement";
import {normalizeFeeOwnership} from "../src/domain/orderTax";
import {
  deliverySettlementReversalJournals,
  recordDeliveredOrderTax,
  resolveTdsReversal,
  reverseOrderTaxWithholding,
  riderPlatformFeeJournal,
  tcsReturnAdjustmentJournal,
  withholdingJournal,
} from "../src/services/taxEngine";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const at = Date.parse("2026-10-10T12:00:00+05:30");
const law = normalizeTaxLaw({});
const seller: SellerTaxProfile = {registrationType: "regular", gstin: "37ABCDE1234F1Z5", ecoEnrolmentNo: "", pan: "ABCDE1234F",
  panFurnished: true, entityType: "firm", stateCode: "37"};
const LIVE = {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5", tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true};
const DELIVERY_FEE = 6_000; // ₹60 customer delivery charge
const TRIP_PAY = 4_500; // ₹45 operational rider pay

function setup(rider: Record<string, unknown>, settings: Record<string, unknown> = LIVE, tripPay = TRIP_PAY) {
  const db = new InMemoryFirestore();
  db.seed("private/taxLaw", settings);
  db.seed("riders/r1", rider);
  const orderTax = {...computeOrderTax(law, {at, storeKind: "restaurant", seller, customerStateCode: "37",
    items: [{productId: "m", name: "Meals", quantity: 1, linePaise: 34_000, taxRules: []}], sellerDiscountPaise: 0,
    platformDiscountPaise: 0, commissionPaise: 5_100, fees: {deliveryFeePaise: DELIVERY_FEE, platformFeePaise: 1_499,
      smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 0, kitchenFeePaise: 0, riderSurgeFeePaise: 0, riderIncentiveFeePaise: 0}}),
  financialYear: financialYearLabel(at)};
  db.seed("orderEconomics/o1", {orderId: "o1", restaurantId: "rest-1", orderTax, snapshot: {}});
  // The operational delivery journal: the rider is paid its trip pay.
  const delivery = createLedgerJournal({eventType: "payment", eventId: "o1-delivered", occurredAt: at, orderId: "o1", postings: [
    {accountId: "asset:gateway", side: "debit", amountPaise: tripPay},
    {accountId: "liability:rider-earnings:r1", side: "credit", amountPaise: tripPay}]});
  db.seed(`ledgerJournals/${delivery.journalId}`, JSON.parse(JSON.stringify(delivery)));
  return {db, database: db as unknown as FirestoreLike};
}
const deliver = (database: FirestoreLike) => recordDeliveredOrderTax({id: "o1", restaurantId: "rest-1", riderId: "r1", deliveredAt: at + 1}, database);
const PERSON = {panNumber: "ABCPR1234K", legalEntityType: "INDIVIDUAL"};

describe("RIDER supplies delivery through SCRAVEIT: e-commerce TDS, never contractor TDS", () => {
  it("unregistered rider within ₹5 lakh: SCRAVEIT pays 9(5) GST, no TCS, rider_ecommerce_tds 0, contractor 0", async () => {
    const {database} = setup(PERSON);
    const entry = (await deliver(database))!;
    expect(entry.taxHeads).toMatchObject({local_delivery_gst_9_5: 1_080, rider_ecommerce_tds: 0, rider_contractor_tds: 0});
    expect(entry.riderEcommerceTds).toMatchObject({basePaise: DELIVERY_FEE, rateBps: 10, tdsPaise: 0});
    expect(entry.deliverySettlement).toMatchObject({delivery_service_supplier: "RIDER", delivery_gross_consideration: DELIVERY_FEE,
      delivery_gst_9_5_paid_by_scraveit: 1_080, delivery_gst_collected_for_supplier: 0, delivery_supplier_gst_tcs: 0,
      rider_contractor_tds: 0, operational_pay: TRIP_PAY});
    expect((await sweepRiderContractorTds(database, at + 10)).active).toBe(false);
  });

  it("names SCRAVEIT's ₹15 as an explicit platform fee + GST, not a delivery margin; the rider's gross stays ₹60", async () => {
    const {database} = setup(PERSON);
    const s = (await deliver(database))!.deliverySettlement!;
    expect(s.scraveit_rider_platform_fee + s.scraveit_rider_platform_fee_gst).toBe(DELIVERY_FEE - TRIP_PAY);
    expect(s).toMatchObject({scraveit_rider_platform_fee: 1_271, scraveit_rider_platform_fee_gst: 229, bonuses_adjustments: 0,
      delivery_supplier_net_settlement: TRIP_PAY});
    const journal = riderPlatformFeeJournal("o1", at, s)!;
    expect(journal.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "revenue:platform-fees", side: "debit", amountPaise: 1_500}),
      expect.objectContaining({accountId: "revenue:scraveit-rider-platform-fee", side: "credit", amountPaise: 1_271}),
      expect.objectContaining({accountId: "liability:tax-payable", side: "credit", amountPaise: 229})]));
  });

  it("catches up 0.1% on the whole year once an individual rider passes ₹5 lakh", async () => {
    const {db, database} = setup(PERSON);
    db.seed("taxRiderEcomYears/r1_26-27", {grossPaise: 4_99_99_000, tdsDeductedPaise: 0});
    const entry = (await deliver(database))!;
    expect(entry.riderEcommerceTds!.tdsPaise).toBe(Math.round((4_99_99_000 + DELIVERY_FEE) * 10 / 10_000));
    expect(entry.taxHeads!.rider_ecommerce_tds).toBe(entry.riderEcommerceTds!.tdsPaise);
    expect(withholdingJournal(entry)!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "liability:rider-ecommerce-tds-payable", side: "credit", amountPaise: entry.riderEcommerceTds!.tdsPaise})]));
    // A refund never hands TDS back as cash: kept, marked for reconciliation, rider year unchanged.
    const deducted = entry.riderEcommerceTds!.tdsPaise;
    const refunded = (await reverseOrderTaxWithholding("o1", at + 100, database))!;
    expect(refunded.tdsReversal).toMatchObject({status: "PENDING_ADJUSTMENT", riderEcommerceTdsPaise: deducted});
    expect(db.read("taxRiderEcomYears/r1_26-27")).toMatchObject({grossPaise: 4_99_99_000 + DELIVERY_FEE, tdsDeductedPaise: deducted});
  });

  it("gives a company rider no ₹5 lakh exemption, and a rider without PAN the e-commerce 5%", async () => {
    const company = setup({panNumber: "ABCCR1234K", legalEntityType: "COMPANY"});
    expect((await deliver(company.database))!.riderEcommerceTds).toMatchObject({rateBps: 10, tdsPaise: 6});
    const noPan = setup({legalEntityType: "INDIVIDUAL"});
    expect((await deliver(noPan.database))!.riderEcommerceTds).toMatchObject({rateBps: 500, tdsPaise: 300});
  });

  it("settles a GST-registered rider: gross + own GST − fee − fee GST − TCS − e-commerce TDS = net", async () => {
    const {database} = setup({...PERSON, riderGstRegistered: true, riderGstin: "37ABCPR1234K1Z5"});
    const entry = (await deliver(database))!;
    const s = entry.deliverySettlement!;
    expect(s).toMatchObject({delivery_gst_collected_for_supplier: 1_080, delivery_gst_9_5_paid_by_scraveit: 0, delivery_supplier_gst_tcs: 30});
    expect(entry.taxHeads!.local_delivery_gst_9_5).toBe(0);
    expect(s.delivery_supplier_net_settlement).toBe(s.delivery_gross_consideration + s.delivery_gst_collected_for_supplier -
      s.scraveit_rider_platform_fee - s.scraveit_rider_platform_fee_gst - s.delivery_supplier_gst_tcs - s.rider_ecommerce_tds +
      s.bonuses_adjustments);
    expect(s.delivery_supplier_net_settlement).toBe(TRIP_PAY + 1_080 - 30 - s.rider_ecommerce_tds);
  });

  it("shows a guarantee above the consideration as a SCRAVEIT top-up, not as rider revenue of ₹70", async () => {
    const {database} = setup(PERSON, LIVE, 7_000);
    const s = (await deliver(database))!.deliverySettlement!;
    expect(s).toMatchObject({delivery_gross_consideration: DELIVERY_FEE, scraveit_rider_platform_fee: 0,
      scraveit_rider_platform_fee_gst: 0, bonuses_adjustments: 1_000, delivery_supplier_net_settlement: 7_000});
  });

  it("uses contractor TDS only when SCRAVEIT supplies delivery: no e-commerce TDS then", async () => {
    const {database} = setup(PERSON, {...LIVE, deliveryServiceSupplier: "SCRAVEIT"});
    const entry = (await deliver(database))!;
    expect(entry.riderEcommerceTds).toBeUndefined();
    expect(entry.taxHeads!.rider_ecommerce_tds).toBe(0);
    expect(entry.deliverySettlement).toMatchObject({delivery_service_supplier: "SCRAVEIT", scraveit_rider_platform_fee: 0});
    expect((await sweepRiderContractorTds(database, at + 10)).active).toBe(true);
  });

  it("leaves an EMPLOYEE rider to payroll: neither rider TDS", async () => {
    const {db, database} = setup(PERSON);
    db.seed("riderTaxClassifications/r1", {entries: [{taxClassification: "EMPLOYEE", classificationEffectiveFrom: "2026-10-01",
      classificationReason: "ONBOARDED_AS_EMPLOYEE", changedBy: "owner", changedAt: at}]});
    const entry = (await deliver(database))!;
    expect(entry.riderEcommerceTds).toBeUndefined();
    expect(entry.taxHeads).toMatchObject({rider_ecommerce_tds: 0, rider_contractor_tds: 0});
  });
});

describe("store self-delivery settlement", () => {
  it("treats the ₹40 as the store's gross and names SCRAVEIT's share as its fee", () => {
    const line = {component: "delivery_fee", supplier: "seller" as const, basis: "store_registered" as const, basePaise: 4_000,
      rateBps: 1_800, gstPaise: 720, chargedTo: "customer" as const, cgstPaise: 360, sgstPaise: 360, igstPaise: 0};
    const s = deliverySupplierSettlement({supplier: "RESTAURANT", supplierId: "store-1", line, operationalPayPaise: 0, tcsPaise: 20,
      riderEcommerceTdsPaise: 0, storeDeliveryTdsPaise: 4, policy: {platformFeeTaxMode: "GST_INCLUSIVE", platformFeeGstRateBps: 1_800,
        platformFeeSac: "", storeDeliveryFeeBps: 1_000}})!;
    expect(s).toMatchObject({delivery_gross_consideration: 4_000, delivery_gst_collected_for_supplier: 720,
      scraveit_rider_platform_fee: 339, scraveit_rider_platform_fee_gst: 61, store_delivery_tds: 4, rider_ecommerce_tds: 0,
      delivery_supplier_net_settlement: 4_000 + 720 - 400 - 20 - 4});
  });
});

describe("SCRAVEIT platform fee: GST-inclusive or GST-exclusive", () => {
  it("GST_INCLUSIVE: ₹15 kept = ₹12.71 fee + ₹2.29 GST; the rider is deducted ₹15", async () => {
    expect(platformFeeSplit(1_500, 1_800, "GST_INCLUSIVE")).toEqual({fee: 1_271, gst: 229});
    const {database} = setup(PERSON, {...LIVE, scraveitRiderPlatformFeeTaxMode: "GST_INCLUSIVE"});
    const s = (await deliver(database))!.deliverySettlement!;
    expect(s).toMatchObject({platform_fee_tax_mode: "GST_INCLUSIVE", scraveit_rider_platform_fee: 1_271,
      scraveit_rider_platform_fee_gst: 229, scraveit_platform_deduction_total: 1_500, delivery_supplier_net_settlement: TRIP_PAY});
  });

  it("GST_EXCLUSIVE: ₹15 fee is SCRAVEIT revenue, ₹2.70 GST on top is output tax; the rider is deducted ₹17.70", async () => {
    expect(platformFeeSplit(1_500, 1_800, "GST_EXCLUSIVE")).toEqual({fee: 1_500, gst: 270});
    const {database} = setup(PERSON, {...LIVE, scraveitRiderPlatformFeeTaxMode: "GST_EXCLUSIVE"});
    const s = (await deliver(database))!.deliverySettlement!;
    expect(s).toMatchObject({platform_fee_tax_mode: "GST_EXCLUSIVE", scraveit_rider_platform_fee: 1_500,
      scraveit_rider_platform_fee_gst: 270, scraveit_platform_deduction_total: 1_770, delivery_supplier_net_settlement: TRIP_PAY - 270});
    const journal = riderPlatformFeeJournal("o1", at, s)!;
    expect(journal.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "revenue:platform-fees", side: "debit", amountPaise: 1_500}),
      expect.objectContaining({accountId: "liability:rider-earnings:r1", side: "debit", amountPaise: 270}),
      expect.objectContaining({accountId: "revenue:scraveit-rider-platform-fee", side: "credit", amountPaise: 1_500}),
      expect.objectContaining({accountId: "liability:tax-payable", side: "credit", amountPaise: 270})]));
  });

  it("keeps the fee's SAC pending until it is classified", async () => {
    const {database} = setup(PERSON);
    expect((await deliver(database))!.deliverySettlement!.scraveit_rider_platform_fee_sac).toBe("");
  });
});

describe("rider e-commerce TDS base excludes the rider's separately stated GST", () => {
  it("registered company rider: 0.1% of ₹60, not of ₹60 + ₹10.80 GST", async () => {
    const {database} = setup({panNumber: "ABCCR1234K", legalEntityType: "COMPANY", riderGstRegistered: true, riderGstin: "37ABCCR1234K1Z5"});
    const entry = (await deliver(database))!;
    expect(entry.riderEcommerceTds).toMatchObject({basePaise: DELIVERY_FEE, tdsPaise: 6});
    expect(entry.deliverySettlement).toMatchObject({rider_gross_service_value: DELIVERY_FEE, rider_supplier_gst: 1_080,
      rider_ecommerce_tds_base: DELIVERY_FEE, gst_separately_stated: true});
  });
});

describe("refunds and reversals", () => {
  const owner = {uid: "owner-1", savrivoRole: "owner"} as unknown as DecodedIdToken;
  const registered = {...PERSON, riderGstRegistered: true, riderGstin: "37ABCPR1234K1Z5"};

  it("same-month refund: TCS return adjustment for that period; TDS kept; settlement and platform fee reversed", async () => {
    const {db, database} = setup(registered);
    db.seed("taxRiderEcomYears/r1_26-27", {grossPaise: 6_00_000_00, tdsDeductedPaise: 60_000});
    const delivered = (await deliver(database))!;
    const refunded = (await reverseOrderTaxWithholding("o1", at + 1_000, database))!;
    expect(refunded.gstTcsReturnAdjustment).toMatchObject({period: "2026-10", riderAdjustedTcsPaise: 30, riderUnadjustedTcsPaise: 0});
    expect(tcsReturnAdjustmentJournal(refunded)!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "liability:gst-tcs-payable", side: "debit", amountPaise: 30})]));
    expect(refunded.tdsReversal).toMatchObject({status: "PENDING_ADJUSTMENT", riderEcommerceTdsPaise: delivered.riderEcommerceTds!.tdsPaise});
    // The TDS stays deducted: no cash back to the rider from the TDS liability.
    expect(withholdingJournal(refunded, true)).toBeTruthy();
    expect(db.paths().some((path) => path.includes("ledgerJournals/") &&
      JSON.stringify(db.read(path)).includes("tds-adjusted"))).toBe(false);
    expect(refunded.deliverySettlementReversal).toMatchObject({deliveryGrossConsideration: DELIVERY_FEE, supplierGst: 1_080,
      platformFee: 1_271, platformFeeGst: 229, operationalPayKept: TRIP_PAY, operationalPayKeptClassification: "PENDING_REVIEW"});
    const [feeReversal, gstReversal] = deliverySettlementReversalJournals(refunded);
    expect(feeReversal!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "revenue:scraveit-rider-platform-fee", side: "debit", amountPaise: 1_271}),
      expect.objectContaining({accountId: "liability:tax-payable", side: "debit", amountPaise: 229})]));
    expect(gstReversal!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "liability:rider-earnings:r1", side: "debit", amountPaise: 1_080})]));
  });

  it("refund in a month with no TCS collected from that supplier: no negative carry-forward, nothing handed back", async () => {
    const {database} = setup(registered);
    await deliver(database);
    const nextMonth = Date.parse("2026-11-05T12:00:00+05:30");
    const refunded = (await reverseOrderTaxWithholding("o1", nextMonth, database))!;
    expect(refunded.gstTcsReturnAdjustment).toMatchObject({period: "2026-11", riderAdjustedTcsPaise: 0, riderUnadjustedTcsPaise: 30});
    expect(tcsReturnAdjustmentJournal(refunded)).toBeNull();
  });

  it("marks NOT_REQUIRED when no TDS was deducted, and keeps the settlement when the delivery charge is not refunded", async () => {
    // GST live, TDS off: nothing was deducted.
    const {database} = setup(PERSON, {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5"});
    await deliver(database);
    const refunded = (await reverseOrderTaxWithholding("o1", at + 1_000, database, {deliveryConsiderationRefunded: false}))!;
    expect(refunded.tdsReversal!.status).toBe("NOT_REQUIRED");
    expect(refunded.deliverySettlementReversal).toBeUndefined();
    expect(deliverySettlementReversalJournals(refunded)).toEqual([]);
  });

  it("closes pending TDS in reconciliation: ADJUSTED returns it, CLAIMABLE_BY_PARTICIPANT keeps it deposited", async () => {
    for (const status of ["ADJUSTED", "CLAIMABLE_BY_PARTICIPANT"] as const) {
      const {db, database} = setup(PERSON);
      db.seed("taxRiderEcomYears/r1_26-27", {grossPaise: 6_00_000_00, tdsDeductedPaise: 60_000});
      const delivered = (await deliver(database))!;
      await reverseOrderTaxWithholding("o1", at + 1_000, database);
      await expect(resolveTdsReversal("ops", {savrivoRole: "ops_admin"} as unknown as DecodedIdToken,
        {orderId: "o1", status, note: "x"}, database)).rejects.toThrow(/owner/);
      const resolved = await resolveTdsReversal("owner-1", owner, {orderId: "o1", status, note: "Q3 return reviewed"}, database, at + 2_000);
      expect(resolved.tdsReversal).toMatchObject({status, resolvedBy: "owner-1"});
      const year = db.read("taxRiderEcomYears/r1_26-27") as {tdsDeductedPaise: number};
      expect(year.tdsDeductedPaise).toBe(status === "ADJUSTED" ? 60_000 : 60_000 + delivered.riderEcommerceTds!.tdsPaise);
      await expect(resolveTdsReversal("owner-1", owner, {orderId: "o1", status, note: "again"}, database)).rejects.toThrow(/no TDS waiting/);
    }
  });
});

describe("every charge has one economic owner", () => {
  it("rain owned by SCRAVEIT is SCRAVEIT revenue + its GST, whole; a kitchen fee owned by the restaurant is restaurant service", () => {
    const tax = computeOrderTax(law, {at, storeKind: "restaurant", seller, customerStateCode: "37",
      items: [{productId: "m", name: "Meals", quantity: 1, linePaise: 34_000, taxRules: []}], sellerDiscountPaise: 0,
      platformDiscountPaise: 0, commissionPaise: 0, feeOwnership: normalizeFeeOwnership({
        rainDeliveryAmount: {economicOwner: "SCRAVEIT", taxClassification: "SCRAVEIT_PLATFORM_SERVICE", contractConfirmed: true},
        busyKitchenFee: {economicOwner: "STORE", taxClassification: "RESTAURANT_SERVICE", contractConfirmed: true}}),
      fees: {deliveryFeePaise: DELIVERY_FEE, platformFeePaise: 0, smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 2_000,
        kitchenFeePaise: 1_000, riderSurgeFeePaise: 500, riderIncentiveFeePaise: 0}});
    expect(tax.services.find((line) => line.component === "rain_fee")).toMatchObject({supplier: "scraveit", basePaise: 2_000, gstPaise: 360});
    expect(tax.services.find((line) => line.component === "delivery_fee")).toMatchObject({basePaise: DELIVERY_FEE + 500,
      consideration: {deliveryFee: DELIVERY_FEE, deliverySurge: 500, rainDeliveryAmount: 0}});
    expect(tax.services.find((line) => line.component === "restaurant_service")).toMatchObject({basePaise: 35_000, gstPaise: 1_750});
    expect(tax.services.some((line) => line.component === "busy_kitchen_fee")).toBe(false);
    expect(tax.feeOwnership!.rainDeliveryAmount).toMatchObject({economicOwner: "SCRAVEIT", contractConfirmed: true});
    // Defaults: delivery charge and delivery surge are the rider's by contract; rain / late night await the contracts.
    const defaults = normalizeFeeOwnership({});
    expect(defaults.customerDeliveryCharge).toMatchObject({economicOwner: "RIDER", contractConfirmed: true});
    expect(defaults.deliverySurge).toMatchObject({economicOwner: "RIDER", contractConfirmed: true});
    expect(defaults.rainDeliveryAmount.contractConfirmed).toBe(false);
  });
});
