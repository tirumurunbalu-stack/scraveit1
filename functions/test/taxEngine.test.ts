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

function seedOrder(db: InMemoryFirestore, orderId: string) {
  const orderTax = {...computeOrderTax(law, {at, storeKind: "dairy", seller, customerStateCode: "37", items: [curd],
    sellerDiscountPaise: 0, platformDiscountPaise: 0, fees: noFees, commissionPaise: 3_150}), financialYear: financialYearLabel(at)};
  db.seed(`orderEconomics/${orderId}`, {orderId, restaurantId: "dairy-1", orderTax});
  return orderTax;
}

describe("tax on delivery", () => {
  it("reads GSTIN, PAN and State from the partner's private record", () => {
    const profile = sellerTaxProfile({payoutProfile: {gstin: "37aaaaa0000a1z5", panNumber: "AAAAA0000A"}}, "37");
    expect(profile).toMatchObject({registrationType: "regular", stateCode: "37", panFurnished: true});
    expect(sellerTaxProfile({}, "37").registrationType).toBe("unregistered");
    // No PAN furnished: the higher no-PAN TDS rate applies.
    const noPan = computeOrderTax(law, {at, storeKind: "dairy", seller: sellerTaxProfile({taxProfile: {gstin: "37ABCDE1234F1Z5"}}, "37"),
      customerStateCode: "37", items: [curd], sellerDiscountPaise: 0, platformDiscountPaise: 0, fees: noFees, commissionPaise: 0});
    expect(noPan.incomeTaxTds.rateBps).toBe(500);
  });

  it("withholds GST TCS and income-tax TDS once, numbers invoices in sequence, and reverses on refund", async () => {
    const db = new InMemoryFirestore();
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

  it("does nothing for an order priced before the tax engine was switched on", async () => {
    const db = new InMemoryFirestore();
    db.seed("orderEconomics/old", {orderId: "old", restaurantId: "r1"});
    expect(await recordDeliveredOrderTax({id: "old", restaurantId: "r1"}, db as unknown as FirestoreLike)).toBeNull();
  });
});
