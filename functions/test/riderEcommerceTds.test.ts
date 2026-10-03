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
import {recordDeliveredOrderTax, reverseOrderTaxWithholding, riderPlatformFeeJournal, withholdingJournal} from "../src/services/taxEngine";
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
    // A refund gives it back and lowers the rider's year.
    await reverseOrderTaxWithholding("o1", at + 100, database);
    expect(db.read("taxRiderYears/r1_26-27")).toBeFalsy();
    expect(db.read("taxRiderEcomYears/r1_26-27")).toMatchObject({grossPaise: 4_99_99_000, tdsDeductedPaise: 0});
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
      riderEcommerceTdsPaise: 0, storeDeliveryTdsPaise: 4, policy: {platformFeeGstRateBps: 1_800, platformFeeSac: "", storeDeliveryFeeBps: 1_000}})!;
    expect(s).toMatchObject({delivery_gross_consideration: 4_000, delivery_gst_collected_for_supplier: 720,
      scraveit_rider_platform_fee: 339, scraveit_rider_platform_fee_gst: 61, store_delivery_tds: 4, rider_ecommerce_tds: 0,
      delivery_supplier_net_settlement: 4_000 + 720 - 400 - 20 - 4});
  });
});
