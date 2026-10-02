import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {computeOrderTax} from "../src/domain/orderTax";
import {financialYearLabel, normalizeTaxLaw} from "../src/domain/taxLaw";
import type {FirestoreLike} from "../src/firestoreTypes";
import {
  recordDeliveredOrderTax,
  reverseOrderTaxWithholding,
  deliverySupplierFor,
  deliveryTaxTreatmentOf,
  normalizeTaxSettings,
  sellerTaxProfile,
  withholdingJournal,
} from "../src/services/taxEngine";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const at = Date.parse("2026-10-10T12:00:00+05:30");
const law = normalizeTaxLaw({});
const seller = sellerTaxProfile({taxProfile: {registrationType: "regular", gstin: "37ABCDE1234F1Z5", pan: "ABCDE1234F", entityType: "firm"}}, "37");
const curd = {productId: "curd", name: "Curd 400 g", quantity: 4, linePaise: 4 * 5_250,
  taxRules: [{effectiveFrom: 0, effectiveTo: 0, hsnCode: "0403", gstRateBps: 500, taxability: "taxable" as const, prepackagedLabelled: true}]};
const noFees = {deliveryFeePaise: 3_900, platformFeePaise: 1_499, smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 0,
  kitchenFeePaise: 0, riderSurgeFeePaise: 0, riderIncentiveFeePaise: 0};

const GST_ON = {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5"};
const TDS_ON = {tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true};

function seedOrder(db: InMemoryFirestore, orderId: string, gstApplies = true) {
  const orderTax = {...computeOrderTax(law, {at, gstApplies, storeKind: "dairy", seller, customerStateCode: "37", items: [curd],
    sellerDiscountPaise: 0, platformDiscountPaise: 0, fees: noFees, commissionPaise: 3_150}), financialYear: financialYearLabel(at)};
  db.seed(`orderEconomics/${orderId}`, {orderId, restaurantId: "dairy-1", orderTax});
  return orderTax;
}

describe("tax on delivery", () => {
  it("reads GSTIN, PAN and State from the partner's private record", () => {
    const profile = sellerTaxProfile({payoutProfile: {gstin: "37aaaaa0000a1z5", panNumber: "AAAAA0000A"}}, "37");
    expect(profile).toMatchObject({registrationType: "regular", stateCode: "37", panFurnished: true});
    expect(sellerTaxProfile({}, "37").registrationType).toBe("unregistered");
    expect(sellerTaxProfile({gstin: "37BBBBB1111B1Z5", panNumber: "BBBBB1111B"}, "37"))
      .toMatchObject({registrationType: "regular", panFurnished: true});
    // No PAN furnished: the higher no-PAN TDS rate applies.
    const noPan = computeOrderTax(law, {at, storeKind: "dairy", seller: sellerTaxProfile({taxProfile: {gstin: "37ABCDE1234F1Z5"}}, "37"),
      customerStateCode: "37", items: [curd], sellerDiscountPaise: 0, platformDiscountPaise: 0, fees: noFees, commissionPaise: 0});
    expect(noPan.incomeTaxTds.rateBps).toBe(500);
  });

  it("withholds GST TCS and income-tax TDS once, numbers invoices in sequence, and reverses on refund", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", {...GST_ON, ...TDS_ON});
    db.seed("restaurantPayoutProfiles/dairy-1", {taxProfile: {invoicePrefix: "MILKY"}});
    const tax = seedOrder(db, "o1");
    seedOrder(db, "o2");
    const database = db as unknown as FirestoreLike;

    const first = await recordDeliveredOrderTax({id: "o1", restaurantId: "dairy-1", deliveredAt: at}, database);
    const again = await recordDeliveredOrderTax({id: "o1", restaurantId: "dairy-1", deliveredAt: at}, database);
    const second = await recordDeliveredOrderTax({id: "o2", restaurantId: "dairy-1", deliveredAt: at + 1}, database);

    // ₹210 of packed curd: taxable ₹200, 0.5% TCS = ₹1.00; 0.1% TDS on ₹200 = 20 paise.
    expect(first).toMatchObject({gstTcsPaise: 100, incomeTaxTdsPaise: 20, incomeTaxTdsBasePaise: 20_000});
    expect(again).toEqual(first);
    expect(tax.gstTcs).toMatchObject({cgstPaise: 50, sgstPaise: 50});
    const numbers = (entry: typeof first) => entry!.invoices.map((invoice) => invoice.invoiceNo);
    expect(numbers(first)).toEqual(["MILKY/26-27/000001", "SCR/SV/26-27/000001", "SCR/CM/26-27/000001"]);
    expect(numbers(second)).toEqual(["MILKY/26-27/000002", "SCR/SV/26-27/000002", "SCR/CM/26-27/000002"]);
    expect(db.read("taxPartnerYears/dairy-1_26-27")).toMatchObject({grossPaise: 40_000});

    const journal = withholdingJournal(first!)!;
    const debits = journal.entries.filter((entry) => entry.side === "debit").reduce((sum, entry) => sum + entry.amountPaise, 0);
    const credits = journal.entries.filter((entry) => entry.side === "credit").reduce((sum, entry) => sum + entry.amountPaise, 0);
    expect(debits).toBe(120);
    expect(credits).toBe(120);
    expect(journal.entries.map((entry) => entry.accountId).sort()).toEqual([
      "liability:gst-tcs-payable", "liability:income-tax-tds-payable", "liability:restaurant-payable:dairy-1"]);

    const reversed = await reverseOrderTaxWithholding("o1", at + 10, database);
    expect(reversed?.reversedAt).toBe(at + 10);
    expect(db.read("taxPartnerYears/dairy-1_26-27")).toMatchObject({grossPaise: 20_000});
    expect(await reverseOrderTaxWithholding("o1", at + 20, database)).toMatchObject({reversedAt: at + 10});
  });

  it("keeps GST_LIVE and TDS_LIVE independent: GSTIN for GST, TAN + TAN_VERIFIED for TDS", () => {
    expect(normalizeTaxSettings({})).toMatchObject({gstActive: false, tdsActive: false});
    expect(normalizeTaxSettings(GST_ON)).toMatchObject({gstActive: true, tdsActive: false});
    expect(normalizeTaxSettings(TDS_ON)).toMatchObject({gstActive: false, tdsActive: true});
    expect(normalizeTaxSettings({gstLive: true})).toMatchObject({gstActive: false});
    expect(normalizeTaxSettings({...TDS_ON, tanVerified: false})).toMatchObject({tdsActive: false});
    expect(normalizeTaxSettings({...TDS_ON, scraveitTan: "VPNS3649"})).toMatchObject({tdsActive: false});
    expect(normalizeTaxSettings({}).riderTipTdsTreatment).toBe("PENDING_REVIEW");
    // Zomato-style default: the rider supplies delivery through SCRAVEIT; RESTAURANT only per store.
    expect(normalizeTaxSettings({}).deliveryServiceSupplier).toBe("RIDER");
    expect(normalizeTaxSettings({deliveryServiceSupplier: "RESTAURANT"}).deliveryServiceSupplier).toBe("RIDER");
    expect(deliverySupplierFor(normalizeTaxSettings({}), {selfDelivery: true})).toBe("RESTAURANT");
    expect(deliverySupplierFor(normalizeTaxSettings({}), {})).toBe("RIDER");
    expect(deliveryTaxTreatmentOf({})).toBe("SEPARATE_LOCAL_DELIVERY");
    expect(deliveryTaxTreatmentOf({deliveryTaxTreatment: "COMPOSITE_WITH_PRINCIPAL_SUPPLY"})).toBe("COMPOSITE_WITH_PRINCIPAL_SUPPLY");
  });

  it("with GST_LIVE off and TDS_LIVE on: seller TDS only, no TCS, no GST invoice", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", TDS_ON);
    seedOrder(db, "o1", false);
    const entry = await recordDeliveredOrderTax({id: "o1", restaurantId: "dairy-1", deliveredAt: at}, db as unknown as FirestoreLike);
    expect(entry).toMatchObject({gstApplied: false, tdsApplied: true, gstTcsPaise: 0, incomeTaxTdsPaise: 20, invoices: []});
    expect(entry!.taxHeads).toMatchObject({seller_income_tax_tds: 20, gst_tcs_section_52: 0, product_gst: 0});
    expect(withholdingJournal(entry!)!.entries.map((line) => line.accountId).sort())
      .toEqual(["liability:income-tax-tds-payable", "liability:restaurant-payable:dairy-1"]);
  });

  it("with GST_LIVE on and TDS_LIVE off: TCS and invoices, no TDS, the seller's TDS year untouched", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", GST_ON);
    seedOrder(db, "o1");
    const entry = await recordDeliveredOrderTax({id: "o1", restaurantId: "dairy-1", deliveredAt: at}, db as unknown as FirestoreLike);
    expect(entry).toMatchObject({gstApplied: true, tdsApplied: false, gstTcsPaise: 100, incomeTaxTdsPaise: 0});
    expect(entry!.invoices.length).toBeGreaterThan(0);
    expect(db.read("taxPartnerYears/dairy-1_26-27")).toBeFalsy();
  });

  it("settles local delivery GST on the actual rider: a GST-registered rider charges it and has TCS withheld", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", GST_ON);
    db.seed("riders/r9", {riderGstRegistered: true, riderGstin: "37ABCPR1234K1Z5"});
    seedOrder(db, "o1");
    seedOrder(db, "o2");
    const database = db as unknown as FirestoreLike;
    const registered = await recordDeliveredOrderTax({id: "o1", restaurantId: "dairy-1", riderId: "r9", deliveredAt: at}, database);
    expect(registered!.localDelivery).toMatchObject({riderId: "r9", basis: "rider_registered"});
    expect(registered!.taxHeads).toMatchObject({local_delivery_gst_9_5: 0, gst_tcs_section_52: 100 + 20});
    expect(withholdingJournal(registered!)!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "liability:rider-earnings:r9", side: "debit", amountPaise: 20})]));
    const unregistered = await recordDeliveredOrderTax({id: "o2", restaurantId: "dairy-1", riderId: "r1", deliveredAt: at}, database);
    expect(unregistered!.localDelivery).toMatchObject({basis: "section_9_5", gstPaise: 702});
    expect(unregistered!.taxHeads!.local_delivery_gst_9_5).toBe(702);
  });

  it("does nothing for an order priced before the tax engine was switched on", async () => {
    const db = new InMemoryFirestore();
    db.seed("orderEconomics/old", {orderId: "old", restaurantId: "r1"});
    expect(await recordDeliveredOrderTax({id: "old", restaurantId: "r1"}, db as unknown as FirestoreLike)).toBeNull();
  });
});
