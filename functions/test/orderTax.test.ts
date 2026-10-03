import {describe, expect, it} from "vitest";
import {
  checkoutDeliveryContext,
  computeOrderTax,
  incomeTaxTdsAtDelivery,
  type CompositeClassification,
  type OrderTaxInput,
  type SellerTaxProfile,
} from "../src/domain/orderTax";
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

describe("seven taxes kept apart", () => {
  const restaurantOrder = (overrides: Partial<OrderTaxInput> = {}) => order({storeKind: "restaurant", commissionPaise: 5_100,
    items: [{productId: "meals", name: "Meals", quantity: 1, linePaise: 34_000, taxRules: []}],
    fees: {...noFees, deliveryFeePaise: 3_900, platformFeePaise: 1_499}, ...overrides});

  it("fills each GST head on its own; the TDS heads wait for delivery / credit", () => {
    const restaurant = computeOrderTax(law, restaurantOrder());
    expect(Object.keys(restaurant.taxHeads).sort()).toEqual(["gst_tcs_section_52", "local_delivery_gst_9_5", "product_gst",
      "restaurant_gst_9_5", "rider_contractor_tds", "rider_ecommerce_tds", "scraveit_service_gst", "seller_income_tax_tds"]);
    expect(restaurant.taxHeads).toMatchObject({restaurant_gst_9_5: 1_700, local_delivery_gst_9_5: 702,
      scraveit_service_gst: 270 + 918, product_gst: 0, seller_income_tax_tds: 0, rider_contractor_tds: 0});
    const curd = computeOrderTax(law, order({items: [
      {productId: "curd", name: "Curd", quantity: 1, linePaise: 10_500, taxRules: [rule(500, "taxable", "0403", true)]}]}));
    expect(curd.taxHeads).toMatchObject({product_gst: 500, gst_tcs_section_52: 50, restaurant_gst_9_5: 0});
  });

  it("charges no GST at all while GST_LIVE is off, but still knows the seller-TDS base", () => {
    const off = computeOrderTax(law, restaurantOrder({gstApplies: false}));
    expect(off.gstApplied).toBe(false);
    expect(off.customerTaxPaise).toBe(0);
    expect(off.services).toEqual([]);
    expect(Object.values(off.taxHeads).every((value) => value === 0)).toBe(true);
    expect(off.incomeTaxTds.basePaise).toBe(34_000);
  });

  it("taxes local delivery at 18% for every store kind, by who supplies it", () => {
    const fee = {...noFees, deliveryFeePaise: 3_900};
    for (const storeKind of ["restaurant", "grocery", "dairy", "pharmacy"] as const) {
      const unregistered = computeOrderTax(law, order({storeKind, fees: fee,
        delivery: {deliveryServiceSupplier: "RIDER", riderGstRegistered: false, riderGstin: "", riderRegistrationLiable: false}}));
      const line = unregistered.services.find((entry) => entry.component === "delivery_fee")!;
      expect(line).toMatchObject({supplier: "scraveit_9_5", basis: "section_9_5", rateBps: 1_800, gstPaise: 702});
      expect(unregistered.taxHeads.local_delivery_gst_9_5).toBe(702);
    }
    const own = computeOrderTax(law, order({fees: fee,
      delivery: {deliveryServiceSupplier: "SCRAVEIT", riderGstRegistered: false, riderGstin: "", riderRegistrationLiable: false}}));
    expect(own.services[0]).toMatchObject({supplier: "scraveit", basis: "scraveit_own_supply"});
    expect(own.taxHeads).toMatchObject({local_delivery_gst_9_5: 702, scraveit_service_gst: 0});
    const registered = computeOrderTax(law, order({fees: fee,
      delivery: {deliveryServiceSupplier: "RIDER", riderGstRegistered: true, riderGstin: "37ABCPR1234K1Z5", riderRegistrationLiable: true}}));
    expect(registered.services[0]).toMatchObject({supplier: "rider", basis: "rider_registered"});
    expect(registered.taxHeads.local_delivery_gst_9_5).toBe(0);
    expect(registered.riderDeliveryTcs).toMatchObject({basePaise: 3_900, rateBps: 50, totalPaise: 20});
    expect(registered.taxHeads.gst_tcs_section_52).toBe(20);
    // Liable to register but not registered: blocked, SCRAVEIT does not take on the GST u/s 9(5).
    const liable = computeOrderTax(law, order({fees: fee,
      delivery: {deliveryServiceSupplier: "RIDER", riderGstRegistered: false, riderGstin: "", riderRegistrationLiable: true}}));
    expect(liable.services[0]).toMatchObject({basis: "registration_required", taxComplianceStatus: "REGISTRATION_REQUIRED", gstPaise: 0});
    expect(liable.taxComplianceStatus).toBe("REGISTRATION_REQUIRED");
    expect(liable.taxHeads.local_delivery_gst_9_5).toBe(0);
  });

  it("has no local delivery GST before 22 September 2025", () => {
    const before = computeOrderTax(law, order({at: Date.parse("2025-09-21T12:00:00+05:30"), fees: {...noFees, deliveryFeePaise: 3_900}}));
    expect(before.taxHeads.local_delivery_gst_9_5).toBe(0);
  });
});

describe("delivery consideration", () => {
  it("counts surge, rain and late-night amounts as the rider's consideration unless classified as SCRAVEIT charges", () => {
    const fees = {...noFees, deliveryFeePaise: 4_000, riderSurgeFeePaise: 1_000, rainFeePaise: 2_000, riderIncentiveFeePaise: 1_500,
      platformFeePaise: 1_499};
    const rider = computeOrderTax(law, order({fees}));
    const line = rider.services.find((entry) => entry.component === "delivery_fee")!;
    expect(line.basePaise).toBe(4_000 + 1_000 + 2_000 + 1_500);
    expect(line.consideration).toEqual({deliveryFee: 4_000, deliverySurge: 1_000, rainDeliveryAmount: 2_000, lateNightDeliveryAmount: 1_500});
    expect(rider.services.map((entry) => entry.component).sort()).toEqual(["delivery_fee", "platform_fee"]);
    const split = computeOrderTax(law, order({fees, deliveryComponents: {deliverySurge: "SCRAVEIT_CHARGE",
      rainDeliveryAmount: "RIDER_CONSIDERATION", lateNightDeliveryAmount: "SCRAVEIT_CHARGE"}}));
    expect(split.services.find((entry) => entry.component === "delivery_fee")!.basePaise).toBe(6_000);
    expect(split.services.find((entry) => entry.component === "rider_surge_fee")).toMatchObject({supplier: "scraveit", basePaise: 1_000});
    expect(split.services.find((entry) => entry.component === "late_night_fee")).toMatchObject({supplier: "scraveit", basePaise: 1_500});
  });
});

describe("store self-delivery (selfDelivery, admin only)", () => {
  const separate = checkoutDeliveryContext("RESTAURANT");
  const composite = checkoutDeliveryContext("RESTAURANT", "COMPOSITE_WITH_PRINCIPAL_SUPPLY");
  const unregisteredStore: SellerTaxProfile = {...registered, registrationType: "unregistered", gstin: ""};
  const meals = [{productId: "meals", name: "Meals", quantity: 1, linePaise: 34_000, taxRules: []}];
  const ghee = [{productId: "ghee", name: "Ghee", quantity: 1, linePaise: 31_500, taxRules: [rule(500, "taxable", "0405", true)]},
    {productId: "milk", name: "Milk", quantity: 1, linePaise: 6_600, taxRules: [rule(0, "nil", "0401")]}];
  const fee = {...noFees, deliveryFeePaise: 4_000};
  const deliveryLine = (tax: ReturnType<typeof computeOrderTax>) => tax.services.find((line) => line.component === "delivery_fee");

  it("1. restaurant, GST-registered, separate delivery fee: 5% food by SCRAVEIT u/s 9(5) and 18% delivery by the restaurant", () => {
    const tax = computeOrderTax(law, order({storeKind: "restaurant", items: meals, fees: fee, delivery: separate}));
    expect(deliveryLine(tax)).toMatchObject({supplier: "seller", basis: "store_registered", rateBps: 1_800, gstPaise: 720});
    expect(tax.taxHeads).toMatchObject({restaurant_gst_9_5: 1_700, local_delivery_gst_9_5: 0});
    // The registered restaurant's delivery is its own supply through the ECO: TCS on it, never on the 9(5) food.
    expect(tax.gstTcs).toMatchObject({applies: true, basePaise: 4_000, totalPaise: 20});
  });

  it("2. restaurant, not registered, separate delivery fee: SCRAVEIT pays both restaurant 9(5) and local-delivery 9(5), apart", () => {
    const tax = computeOrderTax(law, order({storeKind: "restaurant", seller: unregisteredStore, items: meals, fees: fee, delivery: separate}));
    expect(deliveryLine(tax)).toMatchObject({supplier: "scraveit_9_5", basis: "store_section_9_5", rateBps: 1_800, gstPaise: 720});
    expect(tax.taxHeads).toMatchObject({restaurant_gst_9_5: 1_700, local_delivery_gst_9_5: 720});
    // The store owes nothing to register for: SCRAVEIT pays u/s 9(5), and none of it enters the s.52 TCS base.
    expect(tax.gstTcs.basePaise).toBe(0);
  });

  it("3. grocery, GST-registered, separate delivery fee: the store pays 18%, SCRAVEIT nothing", () => {
    const tax = computeOrderTax(law, order({storeKind: "grocery", items: ghee, fees: fee, delivery: separate}));
    expect(deliveryLine(tax)).toMatchObject({supplier: "seller", basis: "store_registered", rateBps: 1_800, gstPaise: 720});
    expect(tax.taxHeads).toMatchObject({local_delivery_gst_9_5: 0, product_gst: 1_500});
    expect(tax.gstTcs.basePaise).toBe(30_000 + 4_000);
  });

  it("4. grocery, not registered, separate delivery fee: SCRAVEIT pays 18% u/s 9(5)", () => {
    for (const storeKind of ["grocery", "dairy", "pharmacy", "other"] as const) {
      const tax = computeOrderTax(law, order({storeKind, seller: unregisteredStore, items: ghee, fees: fee, delivery: separate}));
      expect(deliveryLine(tax)).toMatchObject({supplier: "scraveit_9_5", basis: "store_section_9_5", gstPaise: 720});
      expect(tax.taxHeads.local_delivery_gst_9_5).toBe(720);
    }
  });

  const approved = (overrides: Partial<CompositeClassification> = {}): CompositeClassification => ({
    compositeTreatmentApproved: true, compositeTreatmentEffectiveFrom: "2026-10-01", principalSupplyTaxCode: "0405",
    principalSupplyType: "GOODS", principalSupplyGstRateBps: 500, ...overrides});

  it("5. composite supply only with an explicit, approved, dated principal supply - never inferred from item values", () => {
    const tax = computeOrderTax(law, order({storeKind: "grocery", items: ghee, fees: fee, delivery: composite,
      composite: approved({principalSupplyTaxCode: "0401", principalSupplyGstRateBps: 0})}));
    // The approved principal (nil-rated milk, the cheaper item) decides, not the ₹315 ghee.
    expect(deliveryLine(tax)).toMatchObject({supplier: "seller", basis: "composite_goods", principalSupplyTaxCode: "0401", rateBps: 0});
    const restaurant = computeOrderTax(law, order({storeKind: "restaurant", seller: unregisteredStore, items: meals, fees: fee,
      delivery: composite, composite: approved({principalSupplyType: "RESTAURANT_SERVICE", principalSupplyTaxCode: "996331"})}));
    expect(deliveryLine(restaurant)).toMatchObject({basis: "composite_restaurant_service", rateBps: 500});
    expect(restaurant.taxHeads).toMatchObject({restaurant_gst_9_5: 1_700 + 200, local_delivery_gst_9_5: 0});
    // Not approved, not yet in force, or no principal named: treated as a separate local-delivery service.
    for (const notReady of [undefined, approved({compositeTreatmentApproved: false}), approved({compositeTreatmentEffectiveFrom: "2026-12-01"}),
      approved({principalSupplyTaxCode: ""})]) {
      const fallback = computeOrderTax(law, order({storeKind: "grocery", items: ghee, fees: fee, delivery: composite,
        ...(notReady ? {composite: notReady} : {})}));
      expect(deliveryLine(fallback)).toMatchObject({basis: "store_registered", rateBps: 1_800});
    }
    expect(checkoutDeliveryContext("RESTAURANT").deliveryTaxTreatment).toBe("SEPARATE_LOCAL_DELIVERY");
  });

  it("keeps every SKU of an individually priced basket at its own rate (no merging)", () => {
    const basket = [
      {productId: "ghee", name: "Ghee", quantity: 1, linePaise: 31_500, taxRules: [rule(500, "taxable", "0405", true)]},
      {productId: "milk", name: "Milk", quantity: 1, linePaise: 6_600, taxRules: [rule(0, "nil", "0401")]},
      {productId: "soap", name: "Soap", quantity: 1, linePaise: 11_800, taxRules: [rule(1_800, "taxable", "3401", true)]},
    ];
    for (const delivery of [separate, composite, undefined]) {
      const tax = computeOrderTax(law, order({storeKind: "grocery", items: basket, fees: fee, ...(delivery ? {delivery} : {}),
        composite: approved()}));
      expect(tax.items.map((item) => item.gstRateBps)).toEqual([500, 0, 1_800]);
      expect(tax.goodsGst.totalPaise).toBe(1_500 + 0 + 1_800);
    }
  });

  it("taxes a declared mixed supply sold for one price at its highest component rate", () => {
    const hamper = {productId: "hamper", name: "Festival hamper", quantity: 1, linePaise: 11_800, taxRules: [{
      ...rule(0, "taxable", "9803"), supplyType: "MIXED_SUPPLY" as const,
      mixedComponents: [{hsnCode: "0401", gstRateBps: 0}, {hsnCode: "1704", gstRateBps: 500}, {hsnCode: "3401", gstRateBps: 1_800}]}]};
    const tax = computeOrderTax(law, order({storeKind: "grocery", items: [hamper]}));
    expect(tax.items[0]).toMatchObject({gstRateBps: 1_800, taxability: "taxable", taxableValuePaise: 10_000});
  });

  it("blocks a store liable to register but not registered; SCRAVEIT does not assume 9(5)", () => {
    const liable = computeOrderTax(law, order({storeKind: "grocery", seller: {...unregisteredStore, registrationLiable: true},
      items: ghee, fees: fee, delivery: separate}));
    expect(deliveryLine(liable)).toMatchObject({basis: "registration_required", taxComplianceStatus: "REGISTRATION_REQUIRED", gstPaise: 0});
    expect(liable.taxComplianceStatus).toBe("REGISTRATION_REQUIRED");
    expect(liable.taxHeads.local_delivery_gst_9_5).toBe(0);
  });

  it("6. RIDER stays the default and unchanged", () => {
    const tax = computeOrderTax(law, order({storeKind: "restaurant", items: meals, fees: fee}));
    expect(deliveryLine(tax)).toMatchObject({supplier: "scraveit_9_5", basis: "section_9_5", rateBps: 1_800, gstPaise: 720});
    expect(tax.taxHeads).toMatchObject({restaurant_gst_9_5: 1_700, local_delivery_gst_9_5: 720});
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
    // required_TDS_YTD − TDS_already_deducted
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 2_000_00}, 5_01_000_00, crossing.tdsPaise).tdsPaise).toBe(200);
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 2_000_00}, 5_01_000_00, crossing.tdsPaise).requiredYtdPaise)
      .toBe(Math.round(5_03_000_00 * 10 / 10_000));
  });
  it("never deducts twice when earlier TDS already covers the year", () => {
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 1_00}, 6_00_000_00, 60_000).tdsPaise).toBe(0);
  });
  it("charges an individual without PAN the e-commerce 5% from the first rupee (not the contractor 20%)", () => {
    const noPan = computeOrderTax(law, order({seller: {...registered, entityType: "individual", pan: "", panFurnished: false},
      items: [{productId: "x", name: "X", quantity: 1, linePaise: 10_000, taxRules: [rule(0, "nil", "0401")]}]}));
    expect(noPan.incomeTaxTds).toMatchObject({rateBps: 500, thresholdApplies: false});
    expect(incomeTaxTdsAtDelivery(noPan.incomeTaxTds, 0).tdsPaise).toBe(500);
  });
  it("has no threshold for a company or firm", () => {
    expect(incomeTaxTdsAtDelivery({...base, basePaise: 50_000, thresholdApplies: false}, 0).tdsPaise).toBe(50);
  });
});
