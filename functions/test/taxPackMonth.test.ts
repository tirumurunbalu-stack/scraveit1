import {writeFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {computeOrderEconomics, DEFAULT_ECONOMICS_POLICY, type OrderEconomicsInput} from "../src/domain/economics";
import {computeOrderTax, type OrderTaxInput, type SellerTaxProfile} from "../src/domain/orderTax";
import {buildTaxPack, parseBankStatementCsv, taxPackWorkbook, type TaxPackInput, type TaxPackJournal} from "../src/domain/taxPack";
import {financialYearLabel, normalizeTaxLaw, type ProductTaxRule} from "../src/domain/taxLaw";
import type {FirestoreLike} from "../src/firestoreTypes";
import {recordDeliveredOrderTax, reverseOrderTaxWithholding, withholdingJournal} from "../src/services/taxEngine";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

/**
 * A fake month of orders, run end to end through the tax engine and the tax
 * pack, with fake payouts and a fake bank statement: no real bank needed.
 */
const CONFIRMED_FEES = Object.fromEntries(["customerDeliveryCharge", "deliverySurge", "rainDeliveryAmount", "lateNightDeliveryAmount",
  "busyKitchenFee"].map((key) => [key, {contractConfirmed: true}]));
const law = normalizeTaxLaw({});
const policy = DEFAULT_ECONOMICS_POLICY;
const day = (d: number, h = 13) => Date.parse(`2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00+05:30`);
const nilMilk: ProductTaxRule[] = [{effectiveFrom: 0, effectiveTo: 0, hsnCode: "0401", gstRateBps: 0, taxability: "nil", prepackagedLabelled: false}];
const packedCurd: ProductTaxRule[] = [{effectiveFrom: 0, effectiveTo: 0, hsnCode: "0403", gstRateBps: 500, taxability: "taxable", prepackagedLabelled: true}];
const sellers: Record<string, SellerTaxProfile & {name: string; kind: "restaurant" | "grocery" | "dairy"}> = {
  "highway-cross": {name: "Highway Cross", kind: "restaurant", registrationType: "regular", gstin: "37AAAAA0000A1Z5", ecoEnrolmentNo: "",
    pan: "AAAAA0000A", panFurnished: true, entityType: "firm", stateCode: "37"},
  "sri-dairy": {name: "Sri Dairy", kind: "dairy", registrationType: "regular", gstin: "37BBBBB1111B1Z5", ecoEnrolmentNo: "",
    pan: "BBBBB1111B", panFurnished: true, entityType: "individual", stateCode: "37"},
  "corner-store": {name: "Corner Store", kind: "grocery", registrationType: "unregistered_eco", gstin: "", ecoEnrolmentNo: "EN37000123",
    pan: "CCCCC2222C", panFurnished: true, entityType: "individual", stateCode: "37"},
};

interface Scenario {
  id: string; store: keyof typeof sellers; at: number; method: "upi" | "cod";
  items: {name: string; linePaise: number; rules: ProductTaxRule[]}[];
  delivery: number; trip: number; rain?: number; kitchen?: number; lateFee?: number; lateRider?: number; coupon?: number; tip?: number;
}

const scenarios: Scenario[] = [
  {id: "o-lunch", store: "highway-cross", at: day(2), method: "upi", items: [{name: "Meals", linePaise: 34_000, rules: []}], delivery: 3_900, trip: 2_800},
  {id: "o-rain", store: "highway-cross", at: day(5, 20), method: "cod", items: [{name: "Biryani", linePaise: 34_000, rules: []}], delivery: 3_900, trip: 2_800, rain: 2_900},
  {id: "o-kitchen", store: "highway-cross", at: day(9), method: "upi", items: [{name: "Thali", linePaise: 34_000, rules: []}], delivery: 3_900, trip: 2_800, kitchen: 1_900},
  {id: "o-night", store: "highway-cross", at: day(12, 23), method: "upi", items: [{name: "Dosa", linePaise: 34_000, rules: []}], delivery: 3_900, trip: 2_800, lateFee: 2_000, lateRider: 1_500},
  {id: "o-coupon", store: "highway-cross", at: day(15), method: "upi", items: [{name: "Meals", linePaise: 35_000, rules: []}], delivery: 3_900, trip: 2_800, coupon: 4_000, tip: 2_000},
  {id: "o-milk", store: "sri-dairy", at: day(3, 7), method: "cod", items: [{name: "Milk 1 L", linePaise: 9_000, rules: nilMilk}], delivery: 1_900, trip: 2_500},
  {id: "o-curd", store: "sri-dairy", at: day(10, 8), method: "upi", items: [
    {name: "Milk 1 L", linePaise: 6_600, rules: nilMilk}, {name: "Curd 400 g", linePaise: 10_500, rules: packedCurd}], delivery: 1_900, trip: 2_500},
  {id: "o-grocery", store: "corner-store", at: day(18), method: "cod", items: [{name: "Ghee 500 ml", linePaise: 31_500, rules: packedCurd}], delivery: 3_900, trip: 3_400},
  {id: "o-refunded", store: "sri-dairy", at: day(20, 8), method: "upi", items: [{name: "Curd 400 g", linePaise: 21_000, rules: packedCurd}], delivery: 1_900, trip: 2_500},
];

async function runMonth() {
  const db = new InMemoryFirestore();
  db.seed("private/taxLaw", {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5", tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true,
    feeOwnership: CONFIRMED_FEES, scraveitRiderPlatformFeeSac: "998599", platformFeeSacConfirmed: true});
  const database = db as unknown as FirestoreLike;
  const orders: TaxPackInput["orders"][number][] = [];
  const journals: TaxPackJournal[] = [];
  for (const s of scenarios) {
    const seller = sellers[s.store]!;
    const subtotal = s.items.reduce((sum, item) => sum + item.linePaise, 0);
    const commission = Math.round(subtotal * 1_500 / 10_000);
    const taxInput: OrderTaxInput = {at: s.at, storeKind: seller.kind, seller, customerStateCode: "37",
      items: s.items.map((item, index) => ({productId: `${s.id}-${index}`, name: item.name, quantity: 1, linePaise: item.linePaise, taxRules: item.rules})),
      sellerDiscountPaise: 0, platformDiscountPaise: s.coupon ?? 0,
      fees: {deliveryFeePaise: s.delivery, platformFeePaise: 1_499, smallOrderFeePaise: subtotal < 14_900 ? 900 : 0, lateNightFeePaise: 0,
        rainFeePaise: s.rain ?? 0, kitchenFeePaise: s.kitchen ?? 0, riderSurgeFeePaise: 0, riderIncentiveFeePaise: s.lateFee ?? 0},
      commissionPaise: commission};
    const orderTax = {...computeOrderTax(law, taxInput), financialYear: financialYearLabel(s.at)};
    const economicsInput: OrderEconomicsInput = {cityKey: "nellore", zoneKey: "naidupeta", restaurantId: s.store, paymentMethod: s.method,
      itemSubtotalPaise: subtotal, restaurantDiscountPaise: 0, platformDiscountPaise: s.coupon ?? 0, deliveryFeePaise: s.delivery,
      platformFeePaise: 1_499, smallOrderFeePaise: taxInput.fees.smallOrderFeePaise, lateNightFeePaise: 0, rainFeePaise: s.rain ?? 0,
      surgeFeePaise: s.kitchen ?? 0, riderIncentiveFeePaise: s.lateFee ?? 0, taxPaise: orderTax.customerTaxPaise, tipPaise: s.tip ?? 0,
      commissionBps: 1_500, riderDeliveryPayPaise: s.trip, riderIncentivePayPaise: s.lateRider ?? 0, commissionTaxPaise: orderTax.partnerTaxPaise};
    const snapshot = computeOrderEconomics(economicsInput, policy);
    db.seed(`orderEconomics/${s.id}`, {orderId: s.id, restaurantId: s.store, snapshot, orderTax});
    const deliveredAt = s.at + 40 * 60_000;
    const withholding = await recordDeliveredOrderTax({id: s.id, restaurantId: s.store, deliveredAt}, database);
    if (withholding) {
      const journal = withholdingJournal(withholding);
      if (journal) journals.push(journal as unknown as TaxPackJournal);
    }
    // What the store earned on delivery (the delivery ledger credits its payable).
    journals.push({journalId: `d-${s.id}`, eventType: s.method === "cod" ? "cod_delivery" : "payment", occurredAt: deliveredAt, orderId: s.id,
      metadata: {riderId: "rider-1"}, entries: [{accountId: `liability:restaurant-payable:${s.store}`, side: "credit", amountPaise: snapshot.restaurant.receivablePaise}]});
    orders.push({orderId: s.id, createdAt: s.at, deliveredAt, status: "Delivered", paymentMethod: s.method, restaurantId: s.store,
      storeName: seller.name, storeKind: seller.kind, snapshot, orderTax});
  }
  const reversed = await reverseOrderTaxWithholding("o-refunded", day(21), database);
  journals.push(withholdingJournal(reversed!, true) as unknown as TaxPackJournal);
  journals.push({journalId: "refund-1", eventType: "refund", occurredAt: day(21), orderId: "o-refunded", metadata: {providerTransactionId: "PG-RF-1"},
    entries: [{accountId: "asset:refund", side: "debit", amountPaise: 24_300}]});
  // Weekly payouts with fake bank references.
  const payouts = [
    {store: "highway-cross", at: day(13, 11), amountPaise: 1_00_000, ref: "UTR0001"},
    {store: "sri-dairy", at: day(13, 11), amountPaise: 12_000, ref: "UTR0002"},
    {store: "corner-store", at: day(20, 11), amountPaise: 22_000, ref: "UTR0003"},
  ];
  for (const payout of payouts) {
    journals.push({journalId: `s-${payout.ref}`, eventType: "restaurant_payable", occurredAt: payout.at,
      metadata: {restaurantId: payout.store, referenceId: payout.ref, settlementMethod: "neft"},
      entries: [{accountId: `liability:restaurant-payable:${payout.store}`, side: "debit", amountPaise: payout.amountPaise}]});
  }
  journals.push({journalId: "rp-1", eventType: "rider_payout", occurredAt: day(13, 12), metadata: {riderId: "rider-1", referenceId: "UTR0004", payoutMethod: "upi"},
    entries: [{accountId: "liability:rider-earnings:rider-1", side: "debit", amountPaise: 25_000}]});
  const withholdings = (await Promise.all(scenarios.map((s) => database.collection("taxWithholdings").doc(s.id).get())))
    .filter((doc) => doc.exists).map((doc) => doc.data()) as TaxPackInput["withholdings"];
  const bankCsv = ["Date,Narration,Debit,UTR",
    "2026-10-13,NEFT HIGHWAY CROSS,\"1,000.00\",UTR0001", "2026-10-13,NEFT SRI DAIRY,120.00,UTR0002",
    "2026-10-20,NEFT CORNER STORE,220.00,UTR0003", "2026-10-13,UPI RIDER,250.00,UTR0004"].join("\n");
  const input: TaxPackInput = {from: day(1, 0), to: Date.parse("2026-11-01T00:00:00+05:30"), generatedAt: day(31), orders, withholdings,
    partners: Object.entries(sellers).map(([restaurantId, seller]) => ({restaurantId, name: seller.name, storeKind: seller.kind, gstin: seller.gstin,
      pan: seller.pan, registrationType: seller.registrationType, entityType: seller.entityType, ecoEnrolmentNo: seller.ecoEnrolmentNo})),
    riders: {"rider-1": "Ravi (test rider)"}, journals, bankStatement: parseBankStatementCsv(bankCsv)};
  return {input, bankCsv};
}

const value = (sheets: ReturnType<typeof buildTaxPack>, item: string) =>
  sheets[0]!.rows.find((row) => String(row.item).startsWith(item))!.value;

describe("a test month through the tax pack (no real bank)", () => {
  it("balances every order to the paisa and matches every payout in the bank statement", async () => {
    const {input} = await runMonth();
    const sheets = buildTaxPack(input);
    expect(value(sheets, "Delivered orders")).toBe(9);
    expect(value(sheets, "CHECK: money in vs money out")).toBe(0);
    expect(value(sheets, "CHECK: payouts not found")).toBe(0);
    const bank = sheets.find((sheet) => sheet.name === "Bank match")!;
    expect(bank.rows.every((row) => row.status === "Matched")).toBe(true);

    // GST TCS only from the registered dairy's taxable curd, net of the refunded order.
    const seller = sheets.find((sheet) => sheet.name === "Seller GST & TCS")!;
    const dairy = seller.rows.find((row) => row.store === "Sri Dairy")!;
    expect(dairy).toMatchObject({taxable: 100, exempt: 156, tcsBase: 100, tcsCgst: 0.25, tcsSgst: 0.25, returns: 200});
    const corner = seller.rows.find((row) => row.store === "Corner Store")!;
    expect(corner).toMatchObject({registration: "unregistered_eco", enrolment: "EN37000123", tcsBase: 0});
    // Restaurant food never appears in Section 52 TCS.
    expect(seller.rows.some((row) => row.store === "Highway Cross")).toBe(false);
    expect(value(sheets, "GST payable by Scraveit: restaurant service")).toBe(Math.round(34_000 * 4 * 0.05 + 31_000 * 0.05) / 100);

    // Invoice numbers per series, no gaps.
    const invoices = sheets.find((sheet) => sheet.name === "Invoices")!.rows.map((row) => String(row.invoiceNo));
    expect(invoices.filter((no) => no.startsWith("SCR/RS/26-27/")).sort()).toEqual(
      ["000001", "000002", "000003", "000004", "000005"].map((n) => `SCR/RS/26-27/${n}`));
  });

  it("flags a missing payout, a wrong amount and an unknown bank entry", async () => {
    const {input, bankCsv} = await runMonth();
    const broken = bankCsv.split("\n").filter((line) => !line.includes("UTR0002"))
      .map((line) => line.replace("220.00,UTR0003", "210.00,UTR0003")).concat("2026-10-25,UNKNOWN CREDIT,999.00,UTR9999").join("\n");
    const sheets = buildTaxPack({...input, bankStatement: parseBankStatementCsv(broken)});
    const statuses = sheets.find((sheet) => sheet.name === "Bank match")!.rows.map((row) => row.status);
    expect(statuses).toContain("Missing in bank statement");
    expect(statuses).toContain("Amount differs");
    expect(statuses).toContain("In bank statement, not in Scraveit records");
    expect(value(sheets, "CHECK: payouts not found")).toBe(3);
  });

  it("writes a sample workbook a CA can open", async () => {
    const {input} = await runMonth();
    const buffer = await taxPackWorkbook(buildTaxPack(input), {generatedAt: input.generatedAt, title: "SCRAVEIT test tax pack"});
    expect(buffer.length).toBeGreaterThan(5_000);
    if (process.env.TAX_PACK_SAMPLE) writeFileSync(process.env.TAX_PACK_SAMPLE, buffer);
  });
});
