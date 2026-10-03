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
  /** Not registered although its turnover makes registration compulsory. */
  registrationLiable?: boolean;
  /**
   * The seller's own invoice states its GST separately (a regular GST invoice
   * does; a composition bill of supply does not). Defaults from the registration.
   */
  invoiceStatesGstSeparately?: boolean;
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
 * Who supplies the local delivery service.
 * - RIDER (default, Zomato-style): an independent delivery partner supplies it
 *   to the customer through SCRAVEIT as the facilitating ECO, which collects
 *   the charge on the partner's behalf. Rider not liable to register: SCRAVEIT
 *   pays 18% u/s 9(5); GST-registered rider: the rider pays it.
 * - RESTAURANT: the store (restaurant, grocery, dairy, pharmacy, ...) delivers
 *   itself (admin-only selfDelivery). Its GST depends on deliveryTaxTreatment:
 *   - SEPARATE_LOCAL_DELIVERY (default with a customer delivery fee): an 18%
 *     local-delivery service. GST-registered store: the store pays it.
 *     Store not liable to register: SCRAVEIT pays it u/s 9(5).
 *   - COMPOSITE_WITH_PRINCIPAL_SUPPLY: only with an approved, dated
 *     classification naming the principal supply (tax code, type, rate);
 *     never inferred from item values and never implied by selfDelivery.
 * Any supplier (rider or store) liable to register but not registered:
 * REGISTRATION_REQUIRED - blocked, and SCRAVEIT does not take on its GST.
 * - SCRAVEIT: SCRAVEIT itself supplies delivery (not the current model).
 */
export type DeliveryServiceSupplier = "RIDER" | "RESTAURANT" | "SCRAVEIT";
export type DeliveryTaxTreatment = "SEPARATE_LOCAL_DELIVERY" | "COMPOSITE_WITH_PRINCIPAL_SUPPLY";

export interface DeliveryTaxContext {
  deliveryServiceSupplier: DeliveryServiceSupplier;
  /** Store self-delivery only. */
  deliveryTaxTreatment?: DeliveryTaxTreatment;
  riderGstRegistered: boolean;
  riderGstin: string;
  /** Rider's turnover makes registration compulsory. */
  riderRegistrationLiable: boolean;
}

/** At checkout the rider is not known yet: an unregistered rider is assumed and settled on delivery. */
export function checkoutDeliveryContext(supplier: DeliveryServiceSupplier,
  deliveryTaxTreatment: DeliveryTaxTreatment = "SEPARATE_LOCAL_DELIVERY"): DeliveryTaxContext {
  return {deliveryServiceSupplier: supplier, deliveryTaxTreatment, riderGstRegistered: false, riderGstin: "", riderRegistrationLiable: false};
}

/** An approved composite-supply classification for a store's self-delivery. */
export interface CompositeClassification {
  compositeTreatmentApproved: boolean;
  /** IST date YYYY-MM-DD. */
  compositeTreatmentEffectiveFrom: string;
  /** HSN/SAC of the principal supply. */
  principalSupplyTaxCode: string;
  principalSupplyType: "GOODS" | "RESTAURANT_SERVICE";
  /** GST rate of the principal supply (goods only; restaurant service uses the law table). */
  principalSupplyGstRateBps: number;
}

/** The store itself, when it supplies delivery. */
export interface StoreDeliveryContext {
  storeKind: StoreKind;
  storeGstRegistered: boolean;
  /** Store's turnover makes registration compulsory (s.22(1)). */
  storeRegistrationLiable: boolean;
  composite?: CompositeClassification;
}

/** Usable only when approved, in force on the order date and naming its principal supply. */
export function compositeInForce(composite: CompositeClassification | undefined, at: number): composite is CompositeClassification {
  if (!composite || !composite.compositeTreatmentApproved || !composite.principalSupplyTaxCode) return false;
  const from = Date.parse(`${composite.compositeTreatmentEffectiveFrom}T00:00:00+05:30`);
  return Number.isFinite(from) && from <= at;
}

/**
 * Who each customer charge economically belongs to, as the customer terms and
 * rider agreement say - never inferred from the fee's name, never split:
 * - RIDER: consideration for the delivery service (the rider's; for a store's
 *   self-delivery the store's; for SCRAVEIT-supplied delivery SCRAVEIT's).
 * - SCRAVEIT: SCRAVEIT's own platform charge (SCRAVEIT revenue + its GST).
 * - STORE: the restaurant/store's own consideration (restaurant: part of the
 *   restaurant service, 9(5); goods store: the seller's own supply).
 */
export type EconomicOwner = "RIDER" | "SCRAVEIT" | "STORE";

export interface FeeClassification {
  economicOwner: EconomicOwner;
  /** E.g. LOCAL_DELIVERY_SERVICE, SCRAVEIT_PLATFORM_SERVICE, RESTAURANT_SERVICE. */
  taxClassification: string;
  /** The customer terms / rider agreement already say so. */
  contractConfirmed: boolean;
}

export interface FeeOwnership {
  customerDeliveryCharge: FeeClassification;
  deliverySurge: FeeClassification;
  rainDeliveryAmount: FeeClassification;
  lateNightDeliveryAmount: FeeClassification;
  busyKitchenFee: FeeClassification;
}

const fee = (economicOwner: EconomicOwner, taxClassification: string, contractConfirmed: boolean): FeeClassification =>
  Object.freeze({economicOwner, taxClassification, contractConfirmed});

/** Zomato-style: delivery charge and delivery surge are collected for the rider. The rest waits for the contracts. */
export const DEFAULT_FEE_OWNERSHIP: Readonly<FeeOwnership> = Object.freeze({
  customerDeliveryCharge: fee("RIDER", "LOCAL_DELIVERY_SERVICE", true),
  deliverySurge: fee("RIDER", "LOCAL_DELIVERY_SERVICE", true),
  rainDeliveryAmount: fee("RIDER", "LOCAL_DELIVERY_SERVICE", false),
  lateNightDeliveryAmount: fee("RIDER", "LOCAL_DELIVERY_SERVICE", false),
  busyKitchenFee: fee("SCRAVEIT", "SCRAVEIT_PLATFORM_SERVICE", false),
});

const DEFAULT_TAX_CLASS: Record<EconomicOwner, string> = {
  RIDER: "LOCAL_DELIVERY_SERVICE", SCRAVEIT: "SCRAVEIT_PLATFORM_SERVICE", STORE: "STORE_SUPPLY",
};

export function normalizeFeeOwnership(value: unknown): FeeOwnership {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pick = (key: keyof FeeOwnership): FeeClassification => {
    const entry = input[key] && typeof input[key] === "object" ? input[key] as Record<string, unknown> : null;
    if (!entry) return DEFAULT_FEE_OWNERSHIP[key];
    const owner = entry.economicOwner === "SCRAVEIT" || entry.economicOwner === "STORE" || entry.economicOwner === "RIDER"
      ? entry.economicOwner : DEFAULT_FEE_OWNERSHIP[key].economicOwner;
    return {economicOwner: owner, taxClassification: String(entry.taxClassification || DEFAULT_TAX_CLASS[owner]).slice(0, 60),
      contractConfirmed: entry.contractConfirmed === true};
  };
  return {customerDeliveryCharge: pick("customerDeliveryCharge"), deliverySurge: pick("deliverySurge"),
    rainDeliveryAmount: pick("rainDeliveryAmount"), lateNightDeliveryAmount: pick("lateNightDeliveryAmount"),
    busyKitchenFee: pick("busyKitchenFee")};
}

export interface DeliveryConsideration {
  deliveryFee: number;
  deliverySurge: number;
  rainDeliveryAmount: number;
  lateNightDeliveryAmount: number;
}

export interface OrderTaxInput {
  at: number;
  /** Who each customer charge belongs to. */
  feeOwnership?: FeeOwnership;
  /** GST_LIVE: when false no GST, no GST TCS (income-tax TDS base is still worked out). */
  gstApplies?: boolean;
  /** The store's approved composite-supply classification, if any. */
  composite?: CompositeClassification;

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
  supplier: "scraveit" | "scraveit_9_5" | "rider" | "seller";
  /** Local delivery only: why this supplier owes the GST. */
  basis?: "scraveit_own_supply" | "section_9_5" | "rider_registered" | "store_registered" | "store_section_9_5" |
    "composite_goods" | "composite_restaurant_service" | "registration_required";
  /** Supplier liable to register but not registered: blocked, no GST shifted to SCRAVEIT. */
  taxComplianceStatus?: "REGISTRATION_REQUIRED";
  /** Composite only: the approved principal supply it follows. */
  principalSupplyTaxCode?: string;
  /** Delivery only: what makes up the delivery supplier's consideration (basePaise is the total). */
  consideration?: DeliveryConsideration;
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
 * - rider_ecommerce_tds: e-commerce TDS from a rider supplying delivery
 *   through SCRAVEIT (deliveryServiceSupplier RIDER; set on delivery)
 * - rider_contractor_tds: contractor TDS from a rider SCRAVEIT subcontracts
 *   (deliveryServiceSupplier SCRAVEIT; set when earnings are credited)
 * The two rider TDS heads never both apply to the same delivery.
 */
export interface TaxHeads {
  restaurant_gst_9_5: number;
  product_gst: number;
  scraveit_service_gst: number;
  local_delivery_gst_9_5: number;
  gst_tcs_section_52: number;
  seller_income_tax_tds: number;
  /** RIDER supplies delivery through SCRAVEIT: e-commerce TDS on the rider's gross (never with contractor TDS). */
  rider_ecommerce_tds: number;
  /** SCRAVEIT supplies delivery and subcontracts the rider: contractor TDS (never with e-commerce TDS). */
  rider_contractor_tds: number;
}

export const NO_TAX: Readonly<TaxHeads> = Object.freeze({restaurant_gst_9_5: 0, product_gst: 0, scraveit_service_gst: 0,
  local_delivery_gst_9_5: 0, gst_tcs_section_52: 0, rider_ecommerce_tds: 0, seller_income_tax_tds: 0, rider_contractor_tds: 0});

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
    thresholdApplies: boolean;
    /** Whole amount (GST included) and the GST the seller's invoice states separately: the base is decided at the trigger. */
    grossBasePaise?: number; separatelyStatedGstPaise?: number; gstIdentifiedOnInvoice?: boolean};
  /** In paise, one field per tax. TDS heads are 0 here: they are fixed on delivery / on credit. */
  taxHeads: TaxHeads;
  /** REGISTRATION_REQUIRED when the delivery supplier must register first. */
  taxComplianceStatus: "OK" | "REGISTRATION_REQUIRED";
  /** The ownership/tax classification each charge was taxed under. */
  feeOwnership?: FeeOwnership;
  /** Charges owned by the store (goods store: its own supply, outside SCRAVEIT's GST). */
  storeOwnedFeesPaise?: number;
  /** GST TCS u/s 52 on a GST-registered rider's delivery service (withheld from the rider). */
  riderDeliveryTcs: GstSplit & {basePaise: number; rateBps: number; totalPaise: number};
}

/** GST on the delivery fee, by who supplies the delivery. */
export function deliveryGstLines(law: TaxLaw, at: number, deliveryFeePaise: number, delivery: DeliveryTaxContext,
  intraState: boolean, store?: StoreDeliveryContext): ServiceTaxLine[] {
  if (deliveryFeePaise <= 0) return [];
  const line = (supplier: ServiceTaxLine["supplier"], basis: NonNullable<ServiceTaxLine["basis"]>, rateBps: number,
    extra: Partial<ServiceTaxLine> = {}): ServiceTaxLine => {
    const gstPaise = bps(deliveryFeePaise, rateBps);
    return {component: "delivery_fee", supplier, basis, basePaise: deliveryFeePaise, rateBps, gstPaise, chargedTo: "customer",
      ...split(gstPaise, intraState), ...extra};
  };
  const blocked = (supplier: ServiceTaxLine["supplier"]) =>
    [line(supplier, "registration_required", 0, {taxComplianceStatus: "REGISTRATION_REQUIRED"})];
  if (delivery.deliveryServiceSupplier === "RESTAURANT" && store) {
    if (delivery.deliveryTaxTreatment === "COMPOSITE_WITH_PRINCIPAL_SUPPLY" && compositeInForce(store.composite, at)) {
      const composite = store.composite;
      return [composite.principalSupplyType === "RESTAURANT_SERVICE"
        ? line("scraveit_9_5", "composite_restaurant_service", rateAt(law.restaurantServiceGst, at),
          {principalSupplyTaxCode: composite.principalSupplyTaxCode})
        : line("seller", "composite_goods", composite.principalSupplyGstRateBps, {principalSupplyTaxCode: composite.principalSupplyTaxCode})];
    }
    const localRate = rateAt(law.deliveryServiceGst, at);
    if (localRate <= 0) return [];
    if (store.storeGstRegistered) return [line("seller", "store_registered", localRate)];
    if (store.storeRegistrationLiable) return blocked("seller");
    return [line("scraveit_9_5", "store_section_9_5", localRate)];
  }
  const rateBps = rateAt(law.deliveryServiceGst, at);
  if (rateBps <= 0) return [];
  if (delivery.deliveryServiceSupplier === "SCRAVEIT") return [line("scraveit", "scraveit_own_supply", rateBps)];
  if (delivery.riderGstRegistered && delivery.riderGstin.length === 15) return [line("rider", "rider_registered", rateBps)];
  if (delivery.riderRegistrationLiable) return blocked("rider");
  return [line("scraveit_9_5", "section_9_5", rateBps)];
}

/** A supplier that must register first may not deliver: the reason, or "" when it may. */
export function deliveryRegistrationProblem(lines: readonly ServiceTaxLine[]): string {
  const line = lines.find((entry) => entry.taxComplianceStatus === "REGISTRATION_REQUIRED");
  if (!line) return "";
  return line.supplier === "rider"
    ? "This delivery partner must add valid GST registration details before delivering."
    : "This store must add valid GST registration details before it can deliver orders itself.";
}

/** Local-delivery GST that SCRAVEIT itself pays (u/s 9(5) or as its own supply). */
export function isScraveitLocalDeliveryGst(line: ServiceTaxLine): boolean {
  return line.component === "delivery_fee" &&
    (line.basis === "section_9_5" || line.basis === "store_section_9_5" || line.basis === "scraveit_own_supply");
}

/** Self-delivery treatments fixed at checkout (not re-settled on the rider). */
export function isStoreSelfDelivery(line: ServiceTaxLine | undefined): boolean {
  return !!line && (line.basis === "store_registered" || line.basis === "store_section_9_5" ||
    line.basis === "composite_goods" || line.basis === "composite_restaurant_service" ||
    (line.basis === "registration_required" && line.supplier === "seller"));
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
    // Each SKU keeps its own rate; only a declared MIXED_SUPPLY bundle takes its highest component rate.
    const rate = !rule ? 0 : rule.supplyType === "MIXED_SUPPLY" && rule.mixedComponents?.length
      ? Math.max(...rule.mixedComponents.map((component) => component.gstRateBps))
      : rule.taxability === "taxable" ? rule.gstRateBps : 0;
    // Shelf prices include GST: taxable value = value × 100 / (100 + rate).
    const taxableValuePaise = rate > 0 ? Math.round(valuePaise * 10_000 / (10_000 + rate)) : valuePaise;
    return {
      productId: item.productId, name: item.name, quantity: item.quantity,
      hsnCode: rule?.hsnCode ?? "", taxability: isGoods ? (rule ? (rate > 0 ? "taxable" : rule.taxability) : "unclassified") : "taxable",
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
  const ownership = input.feeOwnership ?? DEFAULT_FEE_OWNERSHIP;
  const lateNightPaise = input.fees.lateNightFeePaise + input.fees.riderIncentiveFeePaise;
  const charges: Record<keyof FeeOwnership, number> = {
    customerDeliveryCharge: input.fees.deliveryFeePaise, deliverySurge: input.fees.riderSurgeFeePaise,
    rainDeliveryAmount: input.fees.rainFeePaise, lateNightDeliveryAmount: lateNightPaise, busyKitchenFee: input.fees.kitchenFeePaise,
  };
  const ownedBy = (key: keyof FeeOwnership, owner: EconomicOwner) => ownership[key].economicOwner === owner ? charges[key] : 0;
  const consideration: DeliveryConsideration = {
    deliveryFee: ownedBy("customerDeliveryCharge", "RIDER"),
    deliverySurge: ownedBy("deliverySurge", "RIDER"),
    rainDeliveryAmount: ownedBy("rainDeliveryAmount", "RIDER"),
    lateNightDeliveryAmount: ownedBy("lateNightDeliveryAmount", "RIDER"),
  };
  // A store-owned charge: restaurant -> part of the restaurant service (9(5)); goods store -> the seller's own supply.
  const storeOwnedPaise = (Object.keys(charges) as (keyof FeeOwnership)[]).reduce((sum, key) => sum + ownedBy(key, "STORE"), 0);
  if (!isGoods && storeOwnedPaise > 0) {
    const restaurantLine = services.find((line) => line.component === "restaurant_service");
    if (restaurantLine) {
      restaurantLine.basePaise += storeOwnedPaise;
      restaurantLine.gstPaise = bps(restaurantLine.basePaise, restaurantLine.rateBps);
      Object.assign(restaurantLine, split(restaurantLine.gstPaise, intraState));
    }
  }
  const considerationPaise = consideration.deliveryFee + consideration.deliverySurge + consideration.rainDeliveryAmount +
    consideration.lateNightDeliveryAmount;
  const storeGstRegistered = law.gstTcsRegistrationTypes.includes(input.seller.registrationType) && input.seller.gstin.length === 15;
  services.push(...deliveryGstLines(law, input.at, considerationPaise,
    input.delivery ?? checkoutDeliveryContext("RIDER"), intraState, {storeKind: input.storeKind, storeGstRegistered,
      storeRegistrationLiable: input.seller.registrationLiable === true, ...(input.composite ? {composite: input.composite} : {})})
    .map((line) => ({...line, consideration})));
  service("platform_fee", "scraveit", input.fees.platformFeePaise, platformRate, "customer");
  service("small_order_fee", "scraveit", input.fees.smallOrderFeePaise, platformRate, "customer");
  // Each charge goes whole to its one owner: SCRAVEIT-owned ones are SCRAVEIT's platform services.
  service("customer_delivery_charge", "scraveit", ownedBy("customerDeliveryCharge", "SCRAVEIT"), platformRate, "customer");
  service("late_night_fee", "scraveit", ownedBy("lateNightDeliveryAmount", "SCRAVEIT"), platformRate, "customer");
  service("rain_fee", "scraveit", ownedBy("rainDeliveryAmount", "SCRAVEIT"), platformRate, "customer");
  service("busy_kitchen_fee", "scraveit", ownedBy("busyKitchenFee", "SCRAVEIT"), platformRate, "customer");
  service("rider_surge_fee", "scraveit", ownedBy("deliverySurge", "SCRAVEIT"), platformRate, "customer");
  service("commission", "scraveit", input.commissionPaise, platformRate, "partner");

  const riderDeliveryTcs = riderDeliveryTcsOf(law, input.at, services, intraState);
  const tcsRegistered = law.gstTcsRegistrationTypes.includes(input.seller.registrationType);
  const tcsRate = rateAt(law.gstTcs, input.at);
  // A registered store's own taxable delivery (separate, or composite with taxable goods) joins its TCS base.
  const storeDelivery = services.find((line) => line.component === "delivery_fee" &&
    (line.basis === "store_registered" || line.basis === "composite_goods") && line.gstPaise > 0);
  const tcsBase = (isGoods ? goodsTaxable : 0) + (tcsRegistered && storeDelivery ? storeDelivery.basePaise : 0);
  const tcsApplies = tcsRegistered && tcsBase > 0 && tcsRate > 0;
  const tcsTotal = tcsApplies ? bps(tcsBase, tcsRate) : 0;
  const reason = !isGoods ? (tcsApplies ? "Restaurant food: no TCS (9(5)); TCS on the restaurant's own delivery service"
    : "Restaurant service: GST paid by SCRAVEIT u/s 9(5), no TCS") :
    !tcsRegistered ? (input.seller.registrationType === "unregistered_eco"
      ? "Unregistered seller (Notification 34/2023): no TCS, reported in GSTR-8" : "Seller not GST-registered: no TCS") :
      goodsTaxable <= 0 ? "Only nil/exempt goods: no TCS" : "Section 52 TCS on net taxable supplies";

  const tdsRule = ecomTdsRuleAt(law, input.at);
  const sale = items.reduce((sum, item) => sum + item.valuePaise, 0);
  // A self-delivering store's delivery service is also its sale through SCRAVEIT (GST excluded).
  const storeDeliveryService = services.find((line) => line.component === "delivery_fee" &&
    (line.supplier === "seller" || line.basis === "store_section_9_5"));
  // The seller's invoice fact, not SCRAVEIT's GST switch: a regular GST invoice states the GST separately.
  const invoiceStatesGst = input.seller.invoiceStatesGstSeparately ??
    (input.seller.registrationType === "regular" && input.seller.gstin.length === 15);
  const statedGst = isGoods && tdsRule?.baseExcludesGst !== false && invoiceStatesGst ? goodsTotal : 0;
  const tdsGross = sale +
    (storeDeliveryService && storeDeliveryService.basis !== "registration_required" ? storeDeliveryService.basePaise : 0);
  // Provisional base for a credit-first transaction; the delivery step re-decides it at the actual trigger.
  const tdsBase = sale - statedGst +
    (storeDeliveryService && storeDeliveryService.basis !== "registration_required" ? storeDeliveryService.basePaise : 0);
  const individual = input.seller.entityType === "individual" || input.seller.entityType === "huf";

  const serviceGst = (pick: (line: ServiceTaxLine) => boolean) =>
    services.filter(pick).reduce((sum, line) => sum + line.gstPaise, 0);
  const gstApplied = input.gstApplies !== false;
  const taxHeads: TaxHeads = gstApplied ? {
    ...NO_TAX,
    restaurant_gst_9_5: serviceGst((line) => line.component === "restaurant_service" || line.basis === "composite_restaurant_service"),
    product_gst: goodsTotal + serviceGst((line) => line.basis === "composite_goods"),
    scraveit_service_gst: serviceGst((line) => line.component !== "restaurant_service" && line.component !== "delivery_fee"),
    local_delivery_gst_9_5: serviceGst(isScraveitLocalDeliveryGst),
    gst_tcs_section_52: tcsTotal + riderDeliveryTcs.totalPaise,
  } : {...NO_TAX};
  const customerLines = services.filter((line) => line.chargedTo === "customer");

  return {
    lawVersion: law.version,
    gstApplied,
    pricedAt: input.at,
    taxComplianceStatus: deliveryRegistrationProblem(services) ? "REGISTRATION_REQUIRED" : "OK",
    feeOwnership: ownership,
    storeOwnedFeesPaise: storeOwnedPaise,
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
      ? {basePaise: tcsApplies ? tcsBase : 0, rateBps: tcsApplies ? tcsRate : 0, totalPaise: tcsTotal,
        applies: tcsApplies, reason, ...split(tcsTotal, intraState)}
      : {basePaise: 0, rateBps: 0, totalPaise: 0, applies: false, reason: "GST_LIVE off", ...split(0, intraState)},
    incomeTaxTds: {
      section: tdsRule?.section ?? "",
      basePaise: tdsRule ? Math.max(0, tdsBase) : 0,
      rateBps: !tdsRule ? 0 : input.seller.panFurnished ? tdsRule.rateBps : tdsRule.noPanRateBps,
      individualExemptUptoPaise: tdsRule?.individualExemptUptoPaise ?? 0,
      thresholdApplies: individual && input.seller.panFurnished,
      grossBasePaise: tdsRule ? Math.max(0, tdsGross) : 0,
      separatelyStatedGstPaise: statedGst,
      gstIdentifiedOnInvoice: invoiceStatesGst,
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
