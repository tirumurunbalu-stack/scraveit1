import {describe, expect, it} from "vitest";
import {computeOrderTax, incomeTaxTdsAtDelivery, type OrderTaxInput, type SellerTaxProfile} from "../src/domain/orderTax";
import {BASELINE_TAX_LAW, financialYearLabel, normalizeTaxLaw, type ProductTaxRule} from "../src/domain/taxLaw";

const law = normalizeTaxLaw({});
const at = Date.parse("2026-10-10T12:00:00+05:30");
const rule = (gstRateBps: number, taxability: ProductTaxRule["taxability"], hsnCode: string, prepackagedLabelled = false): ProductTaxRule =>
  ({effectiveFrom: Date.parse("2025-09-22T00:00:00+05:30"), effectiveTo: 0, hsnCode, gstRateBps, taxability, prepackagedLabelled});
const registered: SellerTaxProfile = {registrationType: "regular", gstin: "37ABCDE1234F1Z5", ecoEnrolmentNo: "",
  pan: "ABCDE1234F", panFurnished: true, entityType: "firm", stateCode: "37"};
const noFees = {deliveryFeePaise: 0, platformFeePaise: 0, smallOrderFeePaise: 0, lateNightFeePaise: 0, rainFeePaise: 0,
  kitchenFeePaise: 0, riderSurgeFeePaise: 0, riderIncentiveFeePaise: 0};
const order = (overrides: Partial<OrderTaxInput>): OrderTaxInput => ({
  at, storeKind: "dairy", seller: registered, customerStateCode: "37", items: [], sellerDiscountPaise: 0,
  platformDiscountPaise: 0, fees: noFees, commissionPaise: 0, ...overrides,
});

describe("tax law tables", () => {
  it("uses 0.5% GST TCS from 10 July 2024 and 1% before", () => {
    const milkAndGhee = (when: number) => computeOrderTax(law, order({at: when, items: [
      {productId: "ghee", name: "Ghee 500 ml", quantity: 1, linePaise: 31_500, taxRules: [{...rule(500, "taxable", "0405", true), effectiveFrom: 0}]},
    ]}));
    expect(milkAndGhee(at).gstTcs.rateBps).toBe(50);
    expect(milkAndGhee(Date.parse("2024-07-09T12:00:00+05:30")).gstTcs.rateBps).toBe(100);
  });

  it("names the financial year April to March", () => {
    expect(financialYearLabel(Date.parse("2026-10-02T10:00:00+05:30"))).toBe("26-27");
    expect(financialYearLabel(Date.parse("2027-03-31T23:00:00+05:30"))).toBe("26-27");
    expect(financialYearLabel(Date.parse("2027-04-01T00:30:00+05:30"))).toBe("27-28");
  });

  it("ships the September 2025 dairy treatment as product guides", () => {
    const guide = (key: string) => BASELINE_TAX_LAW.hsnGuides.find((entry) => entry.key === key)!.rule;
    expect(guide("milk").gstRateBps).toBe(0);
    expect(guide("paneer").taxability).toBe("nil");
    expect(guide("curd_loose").gstRateBps).toBe(0);
    expect(guide("curd_packed").gstRateBps).toBe(500);
    expect(guide("butter_ghee").gstRateBps).toBe(500);
  });
});

describe("dairy and grocery orders", () => {
  it("charges no GST and no TCS on nil-rated milk, but still has an income-tax TDS base", () => {
    const tax = computeOrderTax(law, order({items: [
      {productId: "milk", name: "Milk 1 L", quantity: 2, linePaise: 13_200, taxRules: [rule(0, "nil", "0401")]},
    ]}));
    expect(tax.goodsGst.totalPaise).toBe(0);
    expect(tax.gstTcs.applies).toBe(false);
    expect(tax.gstTcs.totalPaise).toBe(0);
    expect(tax.incomeTaxTds.basePaise).toBe(13_200);
    expect(tax.incomeTaxTds.rateBps).toBe(10);
  });

  it("takes GST out of the shelf price per product and charges TCS only on the taxable part", () => {
    const tax = computeOrderTax(law, order({items: [
      {productId: "milk", name: "Milk", quantity: 1, linePaise: 6_600, taxRules: [rule(0, "nil", "0401")]},
      {productId: "curd", name: "Curd 400 g (packed)", quantity: 1, linePaise: 5_250, taxRules: [rule(500, "taxable", "0403", true)]},
    ]}));
    // ₹52.50 incl. 5% GST → taxable ₹50.00 + GST ₹2.50 (₹1.25 CGST + ₹1.25 SGST).
    expect(tax.items[1]).toMatchObject({taxableValuePaise: 5_000, cgstPaise: 125, sgstPaise: 125, igstPaise: 0});
    expect(tax.goodsGst.taxableValuePaise).toBe(5_000);
    expect(tax.goodsGst.exemptValuePaise).toBe(6_600);
    // 0.5% of ₹50 = 25 paise, split CGST/SGST intra-State.
    expect(tax.gstTcs).toMatchObject({applies: true, basePaise: 5_000, totalPaise: 25, cgstPaise: 12, sgstPaise: 13});
    // TDS base excludes the separately shown GST: ₹66 + ₹50.
    expect(tax.incomeTaxTds.basePaise).toBe(11_600);
  });

  it("uses IGST TCS when the seller and customer are in different States", () => {
    const tax = computeOrderTax(law, order({customerStateCode: "33", items: [
      {productId: "ghee", name: "Ghee", quantity: 1, linePaise: 31_500, taxRules: [rule(500, "taxable", "0405", true)]},
    ]}));
    expect(tax.intraState).toBe(false);
    expect(tax.gstTcs).toMatchObject({cgstPaise: 0, sgstPaise: 0, igstPaise: 150});
  });

  it("collects no TCS from an unregistered seller under Notification 34/2023", () => {
    const tax = computeOrderTax(law, order({
      seller: {...registered, registrationType: "unregistered_eco", gstin: "", ecoEnrolmentNo: "EN123"},
      items: [{productId: "ghee", name: "Ghee", quantity: 1, linePaise: 31_500, taxRules: [rule(500, "taxable", "0405", true)]}],
    }));
    expect(tax.gstTcs.applies).toBe(false);
    expect(tax.gstTcs.reason).toContain("34/2023");
  });

  it("uses the product rule valid on the order date, not today's", () => {
    const rules: ProductTaxRule[] = [
      {...rule(1_200, "taxable", "0405", true), effectiveFrom: 0, effectiveTo: Date.parse("2025-09-22T00:00:00+05:30")},
      rule(500, "taxable", "0405", true),
    ];
    const before = computeOrderTax(law, order({at: Date.parse("2025-09-01T12:00:00+05:30"),
      items: [{productId: "butter", name: "Butter", quantity: 1, linePaise: 11_200, taxRules: rules}]}));
    const after = computeOrderTax(law, order({items: [{productId: "butter", name: "Butter", quantity: 1, linePaise: 10_500, taxRules: rules}]}));
    expect(before.items[0]!.gstRateBps).toBe(1_200);
    expect(after.items[0]!.gstRateBps).toBe(500);
  });
});

describe("restaurant orders", () => {
  it("puts food GST on SCRAVEIT under 9(5), adds it to the bill, and collects no TCS", () => {
    const tax = computeOrderTax(law, order({storeKind: "restaurant", sellerDiscountPaise: 6_000,
      items: [{productId: "dosa", name: "Dosa", quantity: 1, linePaise: 34_000, taxRules: []}],
      fees: {...noFees, deliveryFeePaise: 3_900, platformFeePaise: 1_499}, commissionPaise: 4_200}));
    const line = (component: string) => tax.services.find((entry) => entry.component === component)!;
    expect(line("restaurant_service")).toMatchObject({supplier: "scraveit_9_5", basePaise: 28_000, gstPaise: 1_400});
    expect(line("delivery_fee")).toMatchObject({supplier: "scraveit_9_5", gstPaise: 702});
    expect(line("platform_fee").gstPaise).toBe(270);
    expect(line("commission")).toMatchObject({chargedTo: "partner", gstPaise: 756});
    expect(tax.customerTaxPaise).toBe(1_400 + 702 + 270);
    expect(tax.partnerTaxPaise).toBe(756);
    expect(tax.gstTcs.applies).toBe(false);
    expect(tax.incomeTaxTds.basePaise).toBe(28_000);
  });
});

describe("income-tax TDS through the year", () => {
  const base = {section: "393", rateBps: 10, individualExemptUptoPaise: 5_00_000_00, thresholdApplies: true};
  it("charges nothing to an individual with PAN while the year stays within ₹5 lakh", () => {
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 50_000}, 1_00_000_00).tdsPaise).toBe(0);
  });
  it("catches up the whole year on the order that crosses ₹5 lakh, then charges each order", () => {
    const crossing = incomeTaxTdsAtDelivery({...base, basePaise: 2_000_00}, 4_99_000_00);
    expect(crossing.tdsPaise).toBe(Math.round(5_01_000_00 * 10 / 10_000));
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 2_000_00}, 5_01_000_00).tdsPaise).toBe(200);
  });
  it("has no threshold for a company or firm", () => {
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 50_000, thresholdApplies: false}, 0).tdsPaise).toBe(50);
  });
});
