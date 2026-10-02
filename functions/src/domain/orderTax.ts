import {
  ecomTdsRuleAt,
  productTaxRuleAt,
  rateAt,
  type ProductTaxRule,
  type TaxLaw,
} from "./taxLaw";

/**
 * Tax on one order, from the tax-law tables in force on the order date.
 *
 * Three separate things, never mixed:
 * - GST on what is sold: goods GST is per product and is the seller's
 *   liability (inside the shelf price); restaurant food is taxed on SCRAVEIT
 *   under s.9(5); SCRAVEIT's own fees and commission carry its own GST.
 * - GST TCS u/s 52: collected by SCRAVEIT from a registered goods seller on
 *   the net value of its taxable supplies. Never on restaurant (9(5)) value,
 *   never on nil/exempt goods, never from unregistered sellers.
 * - Income-tax e-commerce TDS: on the seller's gross sales, independent of
 *   GST (nil-rated milk can still attract it). The yearly ₹5 lakh threshold
 *   for individuals/HUFs is applied at delivery with the seller's running total.
 */

/** Restaurant food is a service; every other kind sells goods. */
export type StoreKind = "restaurant" | "grocery" | "dairy" | "pharmacy" | "other";
export type GstRegistrationType = "regular" | "composition" | "unregistered_eco" | "unregistered";
export type EntityType = "individual" | "huf" | "company" | "firm" | "llp" | "trust" | "other";

export interface SellerTaxProfile {
  registrationType: GstRegistrationType;
  gstin: string;
  /** Enrolment number for an unregistered seller under Notification 34/2023. */
  ecoEnrolmentNo: string;
  pan: string;
  /** PAN (or Aadhaar) has been furnished to SCRAVEIT. */
  panFurnished: boolean;
  entityType: EntityType;
  /** GST state code, e.g. "37" for Andhra Pradesh. */
  stateCode: string;
}

export interface TaxOrderItem {
  productId: string;
  name: string;
  quantity: number;
  /** What the customer is charged for the line before discounts, GST inside for goods. */
  linePaise: number;
  taxRules: readonly ProductTaxRule[];
}

/**
 * Who supplies the local delivery service. SCRAVEIT: its own taxable supply.
 * RIDER: the rider supplies it through SCRAVEIT, so SCRAVEIT pays the GST u/s
 * 9(5) unless the rider is GST-registered (then the rider charges it).
 */
export type DeliveryServiceSupplier = "SCRAVEIT" | "RIDER";

export interface DeliveryTaxContext {
  deliveryServiceSupplier: DeliveryServiceSupplier;
  riderGstRegistered: boolean;
  riderGstin: string;
  /** Rider's turnover makes registration compulsory. */
  riderRegistrationLiable: boolean;
}

/** At checkout the rider is not known yet: an unregistered rider is assumed and settled on delivery. */
export function checkoutDeliveryContext(supplier: DeliveryServiceSupplier): DeliveryTaxContext {
  return {deliveryServiceSupplier: supplier, riderGstRegistered: false, riderGstin: "", riderRegistrationLiable: false};
}

export interface OrderTaxInput {
  at: number;
  /** GST_LIVE: when false no GST, no GST TCS (income-tax TDS base is still worked out). */
  gstApplies?: boolean;
  delivery?: DeliveryTaxContext;
  storeKind: StoreKind;
  seller: SellerTaxProfile;
  customerStateCode: string;
  items: readonly TaxOrderItem[];
  /** Offer funded by the seller (reduces its sale). */
  sellerDiscountPaise: number;
  /** Offer funded by SCRAVEIT (the seller still sells at its own price). */
  platformDiscountPaise: number;
  fees: {
    deliveryFeePaise: number;
    platformFeePaise: number;
    smallOrderFeePaise: number;
    lateNightFeePaise: number;
    rainFeePaise: number;
    kitchenFeePaise: number;
    riderSurgeFeePaise: number;
    riderIncentiveFeePaise: number;
  };
  commissionPaise: number;
}

export interface GstSplit {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
}

export interface TaxedItem extends GstSplit {
  productId: string;
  name: string;
  quantity: number;
  hsnCode: string;
  taxability: ProductTaxRule["taxability"] | "unclassified";
  gstRateBps: number;
  /** Line value after the seller's discount share, GST inside. */
  valuePaise: number;
  taxableValuePaise: number;
}

export interface ServiceTaxLine extends GstSplit {
  component: string;
  /** Who supplies it (and owes the GST). */
  supplier: "scraveit" | "scraveit_9_5" | "rider";
  /** Local delivery only: why this supplier owes the GST. */
  basis?: "scraveit_own_supply" | "section_9_5" | "rider_registered";
  /** Local delivery only: the rider should be registered but is not (still taxed u/s 9(5)). */
  complianceFlag?: "RIDER_MUST_REGISTER";
  basePaise: number;
  rateBps: number;
  gstPaise: number;
  /** Charged to the customer (added to the bill) or to the partner (settlement). */
  chargedTo: "customer" | "partner";
}

/**
 * The seven taxes SCRAVEIT handles, always kept apart: never add GST, GST-TCS
 * and income-tax TDS together into one "tax" figure.
 * GST (GST_LIVE):
 * - restaurant_gst_9_5: 5% on restaurant service, paid by SCRAVEIT u/s 9(5)
 * - product_gst: GST inside goods shelf prices, owed by the seller
 * - scraveit_service_gst: GST on SCRAVEIT's own fees and commission
 * - local_delivery_gst_9_5: 18% on local delivery (u/s 9(5) from 22 Sep 2025
 *   when an unregistered rider supplies it; SCRAVEIT's own supply when it
 *   delivers itself); 0 when a GST-registered rider charges it
 * - gst_tcs_section_52: GST collected at source from registered suppliers
 * Income-tax (TDS_LIVE):
 * - seller_income_tax_tds: e-commerce TDS from sellers (set on delivery)
 * - rider_contractor_tds: contractor TDS from riders (set when earnings are credited)
 */
export interface TaxHeads {
  restaurant_gst_9_5: number;
  product_gst: number;
  scraveit_service_gst: number;
  local_delivery_gst_9_5: number;
  gst_tcs_section_52: number;
  seller_income_tax_tds: number;
  rider_contractor_tds: number;
}

export const NO_TAX: Readonly<TaxHeads> = Object.freeze({restaurant_gst_9_5: 0, product_gst: 0, scraveit_service_gst: 0,
  local_delivery_gst_9_5: 0, gst_tcs_section_52: 0, seller_income_tax_tds: 0, rider_contractor_tds: 0});

export interface OrderTax {
  lawVersion: string;
  /** GST_LIVE was on when the order was priced. */
  gstApplied: boolean;
  /** When the order was priced: the tax-law date. */
  pricedAt?: number;
  financialYear?: string;
  storeKind: StoreKind;
  intraState: boolean;
  items: TaxedItem[];
  /** Goods GST inside the shelf prices; the seller owes it. */
  goodsGst: GstSplit & {totalPaise: number; taxableValuePaise: number; exemptValuePaise: number};
  services: ServiceTaxLine[];
  /** Added to the customer's bill. */
  customerTaxPaise: number;
  /** Charged to the partner through its settlement (GST on commission). */
  partnerTaxPaise: number;
  gstTcs: GstSplit & {basePaise: number; rateBps: number; totalPaise: number; applies: boolean; reason: string};
  /** Base and rate only; the amount is settled at delivery with the seller's yearly total. */
  incomeTaxTds: {section: string; basePaise: number; rateBps: number; individualExemptUptoPaise: number;
    thresholdApplies: boolean};
  /** In paise, one field per tax. TDS heads are 0 here: they are fixed on delivery / on credit. */
  taxHeads: TaxHeads;
  /** GST TCS u/s 52 on a GST-registered rider's delivery service (withheld from the rider). */
  riderDeliveryTcs: GstSplit & {basePaise: number; rateBps: number; totalPaise: number};
}

/** GST on the delivery fee, by who supplies the delivery. */
export function deliveryGstLines(law: TaxLaw, at: number, deliveryFeePaise: number, delivery: DeliveryTaxContext,
  intraState: boolean): ServiceTaxLine[] {
  const rateBps = rateAt(law.deliveryServiceGst, at);
  if (deliveryFeePaise <= 0 || rateBps <= 0) return [];
  const gstPaise = bps(deliveryFeePaise, rateBps);
  const base = {component: "delivery_fee", basePaise: deliveryFeePaise, rateBps, gstPaise, chargedTo: "customer" as const,
    ...split(gstPaise, intraState)};
  if (delivery.deliveryServiceSupplier === "SCRAVEIT") return [{...base, supplier: "scraveit", basis: "scraveit_own_supply"}];
  if (delivery.riderGstRegistered && delivery.riderGstin.length === 15) return [{...base, supplier: "rider", basis: "rider_registered"}];
  return [{...base, supplier: "scraveit_9_5", basis: "section_9_5",
    ...(delivery.riderRegistrationLiable ? {complianceFlag: "RIDER_MUST_REGISTER" as const} : {})}];
}

function riderDeliveryTcsOf(law: TaxLaw, at: number, services: readonly ServiceTaxLine[], intraState: boolean) {
  const line = services.find((entry) => entry.component === "delivery_fee" && entry.supplier === "rider");
  const rateBps = line ? rateAt(law.gstTcs, at) : 0;
  const totalPaise = line ? bps(line.basePaise, rateBps) : 0;
  return {basePaise: line?.basePaise ?? 0, rateBps, totalPaise, ...split(totalPaise, intraState)};
}

function split(totalPaise: number, intraState: boolean): GstSplit {
  if (!intraState) return {cgstPaise: 0, sgstPaise: 0, igstPaise: totalPaise};
  const cgst = Math.floor(totalPaise / 2);
  return {cgstPaise: cgst, sgstPaise: totalPaise - cgst, igstPaise: 0};
}

function bps(base: number, rate: number): number {
  return Math.round(base * rate / 10_000);
}

/** Spreads an amount across lines in proportion to their values, exactly. */
function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const shares = weights.map((weight) => Math.floor(total * weight / sum));
  let rest = total - shares.reduce((acc, value) => acc + value, 0);
  for (let i = 0; rest > 0 && i < shares.length; i += 1, rest -= 1) shares[i] = (shares[i] ?? 0) + 1;
  return shares;
}

export function computeOrderTax(law: TaxLaw, input: OrderTaxInput): OrderTax {
  const intraState = !input.seller.stateCode || !input.customerStateCode ||
    input.seller.stateCode === input.customerStateCode;
  const values = input.items.map((item) => Math.max(0, Math.round(item.linePaise)));
  const sellerShares = allocate(Math.min(input.sellerDiscountPaise, values.reduce((a, b) => a + b, 0)), values);
  const isGoods = input.storeKind !== "restaurant";

  const items: TaxedItem[] = input.items.map((item, index) => {
    const valuePaise = Math.max(0, (values[index] ?? 0) - (sellerShares[index] ?? 0));
    const rule = isGoods ? productTaxRuleAt(item.taxRules, input.at) : null;
    const rate = rule && rule.taxability === "taxable" ? rule.gstRateBps : 0;
    // Shelf prices include GST: taxable value = value × 100 / (100 + rate).
    const taxableValuePaise = rate > 0 ? Math.round(valuePaise * 10_000 / (10_000 + rate)) : valuePaise;
    return {
      productId: item.productId, name: item.name, quantity: item.quantity,
      hsnCode: rule?.hsnCode ?? "", taxability: isGoods ? (rule?.taxability ?? "unclassified") : "taxable",
      gstRateBps: rate, valuePaise, taxableValuePaise,
      ...split(valuePaise - taxableValuePaise, intraState),
    };
  });

  const goodsTotal = isGoods ? items.reduce((sum, item) => sum + (item.valuePaise - item.taxableValuePaise), 0) : 0;
  const goodsTaxable = isGoods ? items.filter((item) => item.gstRateBps > 0)
    .reduce((sum, item) => sum + item.taxableValuePaise, 0) : 0;
  const goodsExempt = isGoods ? items.filter((item) => item.gstRateBps === 0)
    .reduce((sum, item) => sum + item.valuePaise, 0) : 0;

  const services: ServiceTaxLine[] = [];
  const service = (component: string, supplier: ServiceTaxLine["supplier"], basePaise: number, rateBps: number,
    chargedTo: ServiceTaxLine["chargedTo"]) => {
    if (basePaise <= 0 || rateBps <= 0) return;
    const gstPaise = bps(basePaise, rateBps);
    services.push({component, supplier, basePaise, rateBps, gstPaise, chargedTo, ...split(gstPaise, intraState)});
  };
  if (!isGoods) {
    const food = values.reduce((a, b) => a + b, 0) - input.sellerDiscountPaise - input.platformDiscountPaise;
    service("restaurant_service", "scraveit_9_5", Math.max(0, food), rateAt(law.restaurantServiceGst, input.at), "customer");
  }
  const platformRate = rateAt(law.platformServiceGst, input.at);
  services.push(...deliveryGstLines(law, input.at, input.fees.deliveryFeePaise,
    input.delivery ?? checkoutDeliveryContext("RIDER"), intraState));
  service("platform_fee", "scraveit", input.fees.platformFeePaise, platformRate, "customer");
  service("small_order_fee", "scraveit", input.fees.smallOrderFeePaise, platformRate, "customer");
  service("late_night_fee", "scraveit", input.fees.lateNightFeePaise + input.fees.riderIncentiveFeePaise, platformRate, "customer");
  service("rain_fee", "scraveit", input.fees.rainFeePaise, platformRate, "customer");
  service("busy_kitchen_fee", "scraveit", input.fees.kitchenFeePaise, platformRate, "customer");
  service("rider_surge_fee", "scraveit", input.fees.riderSurgeFeePaise, platformRate, "customer");
  service("commission", "scraveit", input.commissionPaise, platformRate, "partner");

  const riderDeliveryTcs = riderDeliveryTcsOf(law, input.at, services, intraState);
  const tcsRegistered = law.gstTcsRegistrationTypes.includes(input.seller.registrationType);
  const tcsRate = rateAt(law.gstTcs, input.at);
  const tcsApplies = isGoods && tcsRegistered && goodsTaxable > 0 && tcsRate > 0;
  const tcsTotal = tcsApplies ? bps(goodsTaxable, tcsRate) : 0;
  const reason = !isGoods ? "Restaurant service: GST paid by SCRAVEIT u/s 9(5), no TCS" :
    !tcsRegistered ? (input.seller.registrationType === "unregistered_eco"
      ? "Unregistered seller (Notification 34/2023): no TCS, reported in GSTR-8" : "Seller not GST-registered: no TCS") :
      goodsTaxable <= 0 ? "Only nil/exempt goods: no TCS" : "Section 52 TCS on net taxable supplies";

  const tdsRule = ecomTdsRuleAt(law, input.at);
  const sale = items.reduce((sum, item) => sum + item.valuePaise, 0);
  const tdsBase = isGoods && tdsRule?.baseExcludesGst !== false ? sale - goodsTotal : sale;
  const individual = input.seller.entityType === "individual" || input.seller.entityType === "huf";

  const serviceGst = (pick: (line: ServiceTaxLine) => boolean) =>
    services.filter(pick).reduce((sum, line) => sum + line.gstPaise, 0);
  const gstApplied = input.gstApplies !== false;
  const taxHeads: TaxHeads = gstApplied ? {
    ...NO_TAX,
    restaurant_gst_9_5: serviceGst((line) => line.component === "restaurant_service"),
    product_gst: goodsTotal,
    scraveit_service_gst: serviceGst((line) => line.component !== "restaurant_service" && line.component !== "delivery_fee"),
    local_delivery_gst_9_5: serviceGst((line) => line.component === "delivery_fee" && line.supplier !== "rider"),
    gst_tcs_section_52: tcsTotal + riderDeliveryTcs.totalPaise,
  } : {...NO_TAX};
  const customerLines = services.filter((line) => line.chargedTo === "customer");

  return {
    lawVersion: law.version,
    gstApplied,
    pricedAt: input.at,
    taxHeads,
    riderDeliveryTcs: gstApplied ? riderDeliveryTcs : {basePaise: 0, rateBps: 0, totalPaise: 0, ...split(0, intraState)},
    storeKind: input.storeKind,
    intraState,
    items,
    goodsGst: gstApplied
      ? {...split(goodsTotal, intraState), totalPaise: goodsTotal, taxableValuePaise: goodsTaxable, exemptValuePaise: goodsExempt}
      : {...split(0, intraState), totalPaise: 0, taxableValuePaise: 0, exemptValuePaise: 0},
    services: gstApplied ? services : [],
    customerTaxPaise: gstApplied ? customerLines.reduce((sum, line) => sum + line.gstPaise, 0) : 0,
    partnerTaxPaise: gstApplied ? services.filter((line) => line.chargedTo === "partner").reduce((sum, line) => sum + line.gstPaise, 0) : 0,
    gstTcs: gstApplied
      ? {basePaise: tcsApplies ? goodsTaxable : 0, rateBps: tcsApplies ? tcsRate : 0, totalPaise: tcsTotal,
        applies: tcsApplies, reason, ...split(tcsTotal, intraState)}
      : {basePaise: 0, rateBps: 0, totalPaise: 0, applies: false, reason: "GST_LIVE off", ...split(0, intraState)},
    incomeTaxTds: {
      section: tdsRule?.section ?? "",
      basePaise: tdsRule ? Math.max(0, tdsBase) : 0,
      rateBps: !tdsRule ? 0 : input.seller.panFurnished ? tdsRule.rateBps : tdsRule.noPanRateBps,
      individualExemptUptoPaise: tdsRule?.individualExemptUptoPaise ?? 0,
      thresholdApplies: individual && input.seller.panFurnished,
    },
  };
}

/**
 * Seller e-commerce TDS due on one delivered order, as a year-to-date
 * catch-up: required_TDS_YTD = rate × gross_YTD (nil while an individual/HUF
 * with PAN stays at or below the limit), TDS_now = required − already
 * deducted. The first order over the limit therefore also covers the earlier
 * orders, and rounding never drifts. Companies, firms, LLPs and others get no
 * exemption: TDS from the first rupee.
 */
export function incomeTaxTdsAtDelivery(tax: OrderTax["incomeTaxTds"], yearGrossBeforePaise: number,
  tdsDeductedBeforePaise = 0): {
  tdsPaise: number; yearGrossAfterPaise: number; requiredYtdPaise: number; catchUpBasePaise: number;
} {
  const after = yearGrossBeforePaise + tax.basePaise;
  const exempt = tax.thresholdApplies && after <= tax.individualExemptUptoPaise;
  const requiredYtdPaise = tax.rateBps <= 0 || exempt ? 0 : bps(after, tax.rateBps);
  const tdsPaise = tax.basePaise <= 0 ? 0 : Math.max(0, requiredYtdPaise - tdsDeductedBeforePaise);
  const crossingNow = tax.thresholdApplies && !exempt && yearGrossBeforePaise <= tax.individualExemptUptoPaise;
  return {tdsPaise, yearGrossAfterPaise: after, requiredYtdPaise, catchUpBasePaise: crossingNow ? yearGrossBeforePaise : 0};
}
