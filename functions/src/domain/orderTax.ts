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

export type StoreKind = "restaurant" | "grocery" | "dairy";
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

export interface OrderTaxInput {
  at: number;
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
  supplier: "scraveit" | "scraveit_9_5";
  basePaise: number;
  rateBps: number;
  gstPaise: number;
  /** Charged to the customer (added to the bill) or to the partner (settlement). */
  chargedTo: "customer" | "partner";
}

export interface OrderTax {
  lawVersion: string;
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
  service("delivery_fee", "scraveit_9_5", input.fees.deliveryFeePaise, rateAt(law.deliveryServiceGst, input.at), "customer");
  service("platform_fee", "scraveit", input.fees.platformFeePaise, platformRate, "customer");
  service("small_order_fee", "scraveit", input.fees.smallOrderFeePaise, platformRate, "customer");
  service("late_night_fee", "scraveit", input.fees.lateNightFeePaise + input.fees.riderIncentiveFeePaise, platformRate, "customer");
  service("rain_fee", "scraveit", input.fees.rainFeePaise, platformRate, "customer");
  service("busy_kitchen_fee", "scraveit", input.fees.kitchenFeePaise, platformRate, "customer");
  service("rider_surge_fee", "scraveit", input.fees.riderSurgeFeePaise, platformRate, "customer");
  service("commission", "scraveit", input.commissionPaise, platformRate, "partner");

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

  return {
    lawVersion: law.version,
    storeKind: input.storeKind,
    intraState,
    items,
    goodsGst: {...split(goodsTotal, intraState), totalPaise: goodsTotal, taxableValuePaise: goodsTaxable, exemptValuePaise: goodsExempt},
    services,
    customerTaxPaise: services.filter((line) => line.chargedTo === "customer").reduce((sum, line) => sum + line.gstPaise, 0),
    partnerTaxPaise: services.filter((line) => line.chargedTo === "partner").reduce((sum, line) => sum + line.gstPaise, 0),
    gstTcs: {basePaise: tcsApplies ? goodsTaxable : 0, rateBps: tcsApplies ? tcsRate : 0, totalPaise: tcsTotal,
      applies: tcsApplies, reason, ...split(tcsTotal, intraState)},
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
 * Income-tax TDS for one delivered order, given the seller's gross through the
 * platform earlier in the same financial year. An individual/HUF with PAN owes
 * nothing while the year's gross stays at or below the limit; once it is
 * crossed, TDS applies to the whole year's gross, so the first order over the
 * limit also catches up the earlier orders.
 */
export function incomeTaxTdsAtDelivery(tax: OrderTax["incomeTaxTds"], yearGrossBeforePaise: number): {
  tdsPaise: number; yearGrossAfterPaise: number; catchUpBasePaise: number;
} {
  const after = yearGrossBeforePaise + tax.basePaise;
  if (tax.rateBps <= 0 || tax.basePaise <= 0) return {tdsPaise: 0, yearGrossAfterPaise: after, catchUpBasePaise: 0};
  if (!tax.thresholdApplies) return {tdsPaise: bps(tax.basePaise, tax.rateBps), yearGrossAfterPaise: after, catchUpBasePaise: 0};
  if (after <= tax.individualExemptUptoPaise) return {tdsPaise: 0, yearGrossAfterPaise: after, catchUpBasePaise: 0};
  const crossingNow = yearGrossBeforePaise <= tax.individualExemptUptoPaise;
  const base = crossingNow ? after : tax.basePaise;
  return {tdsPaise: bps(base, tax.rateBps), yearGrossAfterPaise: after, catchUpBasePaise: crossingNow ? yearGrossBeforePaise : 0};
}
