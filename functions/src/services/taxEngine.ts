import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {
  computeOrderTax,
  incomeTaxTdsAtDelivery,
  NO_TAX,
  type EntityType,
  type GstRegistrationType,
  type OrderTax,
  type SellerTaxProfile,
  type StoreKind,
  type TaxHeads,
  checkoutDeliveryContext,
  deliveryGstLines,
  isScraveitLocalDeliveryGst,
  isStoreSelfDelivery,
  type DeliveryTaxTreatment,
  normalizeFeeOwnership,
  type FeeOwnership,
  type CompositeClassification,
  type ServiceTaxLine,
  type DeliveryServiceSupplier,
  type DeliveryTaxContext,
} from "../domain/orderTax";
import {deliverySupplierSettlement, type DeliverySupplierSettlement, type SupplierFeePolicy} from "../domain/deliverySupplierSettlement";
import {
  classificationAt,
  normalizeTipTdsTreatment,
  panMatchesEntity,
  riderTdsIdentity,
  validPan,
  type ClassificationEntry,
  type TipTdsTreatment,
} from "../domain/riderTds";
import {ecomTdsRuleAt, financialYearLabel, normalizeProductTaxRules, normalizeTaxLaw, rateAt, type TaxLaw} from "../domain/taxLaw";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {CatalogItem, PricedOrderItem} from "../types";
import type {TaxComputation} from "../domain/taxRules";
import type {CheckoutEconomicsPlan, ServerFees} from "./economics";
import type {DecodedIdToken} from "firebase-admin/auth";
import {DomainError} from "../errors";
import {requireOwnerClaim} from "./authz";
import {persistLedgerJournalIfAbsent} from "./ledger";
import {RESTAURANT_PAYOUT_PROFILES_COLLECTION} from "./restaurantPayoutProfiles";

/**
 * Tax engine: loads the effective-dated tax law (private/taxLaw), each
 * partner's tax profile, and records what happens on delivery:
 * - GST TCS (s.52) and income-tax TDS withheld from the seller, as two
 *   separate liabilities, deducted from what the seller is owed;
 * - invoice numbers in the right series (seller's own for goods, SCRAVEIT's
 *   9(5) series for restaurant food, SCRAVEIT's own for its fees and commission).
 * Two independent switches in private/taxLaw:
 * - GST_LIVE (gstLive + a valid scraveitGstin): restaurant GST u/s 9(5),
 *   product GST, SCRAVEIT service GST, local-delivery GST, GST TCS u/s 52 and
 *   GST tax invoices. Off: checkout keeps its old tax, no invoice is numbered.
 * - TDS_LIVE (tdsLive + a valid scraveitTan + tanVerified): seller e-commerce
 *   TDS and rider contractor TDS. Off: nothing is deducted.
 * GSTIN is for GST, TAN is for TDS: neither switch depends on the other.
 */

export const TAX_LAW_DOC = "taxLaw";
export const TAX_WITHHOLDINGS_COLLECTION = "taxWithholdings";
export const TAX_PARTNER_YEARS_COLLECTION = "taxPartnerYears";
export const INVOICES_COLLECTION = "invoices";
export const INVOICE_SERIES_COLLECTION = "invoiceSeries";

export interface TaxSettings {
  /** GST_LIVE as set. */
  gstLive: boolean;
  /** GST_LIVE and a valid GSTIN: GST is actually charged. */
  gstActive: boolean;
  /** TDS_LIVE as set. */
  tdsLive: boolean;
  /** TDS_LIVE, a valid TAN and TAN_VERIFIED: TDS is actually deducted. */
  tdsActive: boolean;
  scraveitPan: string;
  scraveitTan: string;
  tanVerified: boolean;
  law: TaxLaw;
  /** GST state code used when an address or partner has none (37 = Andhra Pradesh). */
  defaultStateCode: string;
  /** SCRAVEIT's GSTIN, printed on its invoices. */
  scraveitGstin: string;
  /** Customer tips in the rider contractor-TDS base. */
  riderTipTdsTreatment: TipTdsTreatment;
  /** Who supplies local delivery by default (RIDER, Zomato-style); a store marked selfDelivery is RESTAURANT. */
  deliveryServiceSupplier: DeliveryServiceSupplier;
  /** Who each customer charge belongs to (per the customer terms / rider agreement). */
  feeOwnership: FeeOwnership;
  /** SCRAVEIT's platform/facilitation fee to riders and stores: GST rate and SAC, configurable until classified. */
  supplierFeePolicy: SupplierFeePolicy;
}

const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

export function validTan(value: string): boolean {
  return TAN_PATTERN.test(value);
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function validGstin(value: string): boolean {
  return GSTIN_PATTERN.test(value);
}



function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeTaxSettings(value: unknown): TaxSettings {
  const input = record(value);
  const scraveitGstin = String(input.scraveitGstin ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15);
  const scraveitTan = String(input.scraveitTan ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 10);
  const gstLive = input.gstLive === true;
  const tdsLive = input.tdsLive === true;
  const tanVerified = input.tanVerified === true;
  return {
    gstLive,
    gstActive: gstLive && validGstin(scraveitGstin),
    tdsLive,
    tdsActive: tdsLive && validTan(scraveitTan) && tanVerified,
    scraveitPan: validPan(input.scraveitPan),
    scraveitTan,
    tanVerified,
    law: normalizeTaxLaw(input.law),
    defaultStateCode: String(input.defaultStateCode || "37").replace(/[^0-9]/g, "").slice(0, 2) || "37",
    scraveitGstin,
    riderTipTdsTreatment: normalizeTipTdsTreatment(input.riderTipTdsTreatment),
    // RIDER unless deliberately changed; RESTAURANT is per store, never platform-wide.
    deliveryServiceSupplier: input.deliveryServiceSupplier === "SCRAVEIT" ? "SCRAVEIT" : "RIDER",
    feeOwnership: normalizeFeeOwnership(input.feeOwnership),
    supplierFeePolicy: {
      platformFeeTaxMode: input.scraveitRiderPlatformFeeTaxMode === "GST_EXCLUSIVE" ? "GST_EXCLUSIVE" : "GST_INCLUSIVE",
      platformFeeGstRateBps: Math.max(0, Math.min(2_800, Math.round(Number(input.scraveitRiderPlatformFeeGstRateBps ?? 1_800) || 0))),
      platformFeeSac: String(input.scraveitRiderPlatformFeeSac ?? "").replace(/[^0-9]/g, "").slice(0, 6),
      storeDeliveryFeeBps: Math.max(0, Math.min(10_000, Math.round(Number(input.scraveitStoreDeliveryFeeBps ?? 0) || 0))),
    },
  };
}


export async function loadTaxSettings(database: FirestoreLike = firestoreDb): Promise<TaxSettings> {
  const snapshot = await database.collection("private").doc(TAX_LAW_DOC).get().catch(() => null);
  return normalizeTaxSettings(snapshot && snapshot.exists ? snapshot.data() : {});
}

const REGISTRATION_TYPES: readonly GstRegistrationType[] = ["regular", "composition", "unregistered_eco", "unregistered"];
const ENTITY_TYPES: readonly EntityType[] = ["individual", "huf", "company", "firm", "llp", "trust", "other"];

/** A partner's tax profile from its private payout record. */
export function sellerTaxProfile(privateRecord: unknown, defaultStateCode: string): SellerTaxProfile {
  const input = record(privateRecord);
  const tax = record(input.taxProfile);
  // The private record keeps payout fields at the top level (older ones nest them).
  const payout = {...input, ...record(input.payoutProfile)};
  const gstin = String(tax.gstin ?? payout.gstin ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15);
  const pan = String(tax.pan ?? payout.panNumber ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 10);
  const type = String(tax.registrationType ?? "");
  return {
    registrationType: (REGISTRATION_TYPES as readonly string[]).includes(type) ? type as GstRegistrationType :
      gstin.length === 15 ? "regular" : "unregistered",
    gstin,
    ecoEnrolmentNo: String(tax.ecoEnrolmentNo ?? "").slice(0, 40),
    registrationLiable: tax.registrationLiable === true,
    pan,
    panFurnished: tax.panFurnished === true || pan.length === 10,
    entityType: (ENTITY_TYPES as readonly string[]).includes(String(tax.entityType)) ? tax.entityType as EntityType : "other",
    // A GSTIN starts with the State code; otherwise the profile's own, else the default.
    stateCode: (gstin.length === 15 ? gstin.slice(0, 2) : String(tax.stateCode ?? "").replace(/[^0-9]/g, "").slice(0, 2)) ||
      defaultStateCode,
  };
}

export async function loadSellerTaxProfile(restaurantId: string, defaultStateCode: string,
  database: FirestoreLike = firestoreDb): Promise<SellerTaxProfile> {
  const snapshot = await database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId).get().catch(() => null);
  return sellerTaxProfile(snapshot && snapshot.exists ? snapshot.data() : {}, defaultStateCode);
}

export function storeKindOf(restaurant: {storeType?: unknown}): StoreKind {
  const type = String(restaurant.storeType ?? "");
  return type === "grocery" || type === "dairy" || type === "pharmacy" || type === "other" ? type : "restaurant";
}

/** Who supplies delivery for this store's orders. */
export function deliverySupplierFor(settings: TaxSettings, restaurant: {selfDelivery?: unknown}): DeliveryServiceSupplier {
  return restaurant.selfDelivery === true ? "RESTAURANT" : settings.deliveryServiceSupplier;
}

/** A self-delivering store's GST treatment: separate local delivery unless deliberately set composite. */
/** A store's approved composite-supply classification (admin-only fields). */
export function compositeClassificationOf(store: object): CompositeClassification | undefined {
  const restaurant = record(store);
  if (restaurant.compositeTreatmentApproved !== true) return undefined;
  return {
    compositeTreatmentApproved: true,
    compositeTreatmentEffectiveFrom: String(restaurant.compositeTreatmentEffectiveFrom ?? ""),
    principalSupplyTaxCode: String(restaurant.principalSupplyTaxCode ?? "").replace(/[^0-9]/g, "").slice(0, 8),
    principalSupplyType: restaurant.principalSupplyType === "RESTAURANT_SERVICE" ? "RESTAURANT_SERVICE" : "GOODS",
    principalSupplyGstRateBps: Math.max(0, Math.min(4_000, Math.round(Number(restaurant.principalSupplyGstRateBps) || 0))),
  };
}

export function deliveryTaxTreatmentOf(restaurant: {deliveryTaxTreatment?: unknown}): DeliveryTaxTreatment {
  return restaurant.deliveryTaxTreatment === "COMPOSITE_WITH_PRINCIPAL_SUPPLY" ? "COMPOSITE_WITH_PRINCIPAL_SUPPLY" : "SEPARATE_LOCAL_DELIVERY";
}

export interface CheckoutTaxContext {
  settings: TaxSettings;
  restaurant: {storeType?: unknown; selfDelivery?: unknown; deliveryTaxTreatment?: unknown};
  seller: SellerTaxProfile;
  items: readonly PricedOrderItem[];
  menuById: Record<string, CatalogItem>;
  sellerDiscountPaise: number;
  platformDiscountPaise: number;
  fees: {deliveryFee: number; platformFee: number; smallOrderFee: number; lateNightFee: number; rainFee: number;
    surgeFee: number; riderSurgeFee?: number; riderIncentiveFee: number};
  commissionPaise: number;
  at: number;
}

const paise = (rupees: number) => Math.round((Number(rupees) || 0) * 100);

export function checkoutOrderTax(context: CheckoutTaxContext): OrderTax {
  return {
    ...computeOrderTax(context.settings.law, {
      at: context.at,
      gstApplies: context.settings.gstActive,
      feeOwnership: context.settings.feeOwnership,
      ...(compositeClassificationOf(context.restaurant) ? {composite: compositeClassificationOf(context.restaurant)} : {}),
      delivery: checkoutDeliveryContext(deliverySupplierFor(context.settings, context.restaurant),
        deliveryTaxTreatmentOf(context.restaurant)),
      storeKind: storeKindOf(context.restaurant),
      seller: context.seller,
      customerStateCode: context.settings.defaultStateCode,
      items: context.items.map((item) => ({
        productId: item.itemId,
        name: item.name,
        quantity: item.quantity,
        linePaise: paise((item.price + (item.variantPrice ?? 0) + (item.addOnTotal ?? 0)) * item.quantity),
        taxRules: normalizeProductTaxRules((context.menuById[item.itemId] as {taxRules?: unknown} | undefined)?.taxRules),
      })),
      sellerDiscountPaise: context.sellerDiscountPaise,
      platformDiscountPaise: context.platformDiscountPaise,
      fees: {
        deliveryFeePaise: paise(context.fees.deliveryFee),
        platformFeePaise: paise(context.fees.platformFee),
        smallOrderFeePaise: paise(context.fees.smallOrderFee),
        lateNightFeePaise: paise(context.fees.lateNightFee),
        rainFeePaise: paise(context.fees.rainFee),
        kitchenFeePaise: paise(context.fees.surgeFee),
        riderSurgeFeePaise: paise(context.fees.riderSurgeFee ?? 0),
        riderIncentiveFeePaise: paise(context.fees.riderIncentiveFee),
      },
      commissionPaise: context.commissionPaise,
    }),
    financialYear: financialYearLabel(context.at),
  };
}

// ---------------------------------------------------------------------------
// On delivery: withholding and invoice numbers
// ---------------------------------------------------------------------------

export const TAX_RIDER_ECOM_YEARS_COLLECTION = "taxRiderEcomYears";

function supplierPayableAccount(settlement: DeliverySupplierSettlement): string {
  return settlement.delivery_service_supplier === "RESTAURANT"
    ? `liability:restaurant-payable:${settlement.supplier_id}` : `liability:rider-earnings:${settlement.supplier_id}`;
}

/** Passes a GST-registered supplier's own delivery GST from the tax collected to what it is owed. */
export function deliveryGstSettlementJournal(orderId: string, at: number, settlement: DeliverySupplierSettlement): LedgerJournal | null {
  const amount = settlement.delivery_gst_collected_for_supplier;
  if (amount <= 0) return null;
  return createLedgerJournal({
    eventType: "delivery_gst_settlement",
    eventId: `order:${orderId}:delivery-gst`,
    occurredAt: at,
    orderId,
    metadata: {supplier: settlement.delivery_service_supplier, supplierId: settlement.supplier_id,
      ...(settlement.delivery_service_supplier === "RIDER" ? {riderId: settlement.supplier_id} : {restaurantId: settlement.supplier_id})},
    postings: [
      {accountId: "liability:tax-payable", side: "debit", amountPaise: amount, memo: "Delivery GST collected for the supplier"},
      {accountId: supplierPayableAccount(settlement), side: "credit", amountPaise: amount, memo: "Supplier's own delivery GST passed on"},
    ],
  });
}

/**
 * Names what SCRAVEIT keeps from a rider's delivery consideration as its
 * platform/facilitation fee, moved out of the generic platform-fee revenue the
 * operational journal used. GST on the fee is output tax (a liability):
 * GST_INCLUSIVE carves it out of the amount kept; GST_EXCLUSIVE deducts it
 * from the rider on top.
 */
export function riderPlatformFeeJournal(orderId: string, at: number, settlement: DeliverySupplierSettlement,
  reversal = false): LedgerJournal | null {
  const fee = settlement.scraveit_rider_platform_fee;
  const gst = settlement.scraveit_rider_platform_fee_gst;
  if (settlement.delivery_service_supplier !== "RIDER" || fee + gst <= 0) return null;
  const exclusive = settlement.platform_fee_tax_mode === "GST_EXCLUSIVE";
  const kept = exclusive ? fee : fee + gst;
  const debits = [
    {accountId: "revenue:platform-fees", amountPaise: kept, memo: "Retained from the rider's delivery consideration"},
    ...(exclusive && gst > 0 ? [{accountId: `liability:rider-earnings:${settlement.supplier_id}`, amountPaise: gst,
      memo: "GST on SCRAVEIT's fee, charged to the rider on top"}] : []),
  ];
  const credits = [
    ...(fee > 0 ? [{accountId: "revenue:scraveit-rider-platform-fee", amountPaise: fee, memo: "SCRAVEIT platform/facilitation fee to the rider"}] : []),
    ...(gst > 0 ? [{accountId: "liability:tax-payable", amountPaise: gst, memo: "Output GST on SCRAVEIT's fee to the rider"}] : []),
  ];
  return createLedgerJournal({
    eventType: "delivery_settlement",
    eventId: `order:${orderId}:rider-platform-fee${reversal ? ":reversed" : ""}`,
    occurredAt: at,
    orderId,
    metadata: {riderId: settlement.supplier_id, grossDeliveryConsideration: settlement.delivery_gross_consideration,
      platformFeeTaxMode: settlement.platform_fee_tax_mode, platformFeeSac: settlement.scraveit_rider_platform_fee_sac || "pending",
      reversal},
    postings: [
      ...debits.map((line) => ({...line, side: reversal ? "credit" as const : "debit" as const})),
      ...credits.map((line) => ({...line, side: reversal ? "debit" as const : "credit" as const})),
    ],
  });
}

/** What the operational engine paid the rider for this order (trip, shares, incentives), from the ledger. */
async function operationalRiderPay(orderId: string, riderId: string, snapshot: Record<string, unknown>,
  database: FirestoreLike): Promise<number> {
  const snap = await database.collection("ledgerJournals").where("orderId", "==", orderId).get().catch(() => null);
  const account = `liability:rider-earnings:${riderId}`;
  let total = 0;
  let found = false;
  for (const doc of snap?.docs ?? []) {
    const journal = record(doc.data());
    if (["tax_withholding", "tax_withholding_reversal", "delivery_gst_settlement", "delivery_settlement", "rider_contractor_tds"]
      .includes(String(journal.eventType))) continue;
    for (const raw of Array.isArray(journal.entries) ? journal.entries : []) {
      const entry = record(raw);
      if (entry.accountId !== account) continue;
      found = true;
      total += (entry.side === "credit" ? 1 : -1) * (Number(entry.amountPaise) || 0);
    }
  }
  if (found) return Math.max(0, total);
  // Ledger not written yet: the checkout estimate.
  const rider = record(snapshot.rider);
  return (Number(rider.deliveryPayPaise) || 0) + (Number(rider.feeSharePaise) || 0) + (Number(rider.incentivePayPaise) || 0);
}

/** A rider liable to register under s.22(1) but not registered may not take deliveries. */
export function riderRegistrationRequired(rider: unknown): boolean {
  const context = riderDeliveryContext(rider, "RIDER");
  return context.riderRegistrationLiable && !context.riderGstRegistered;
}

export type TdsReversalStatus = "NOT_REQUIRED" | "PENDING_ADJUSTMENT" | "ADJUSTED" | "CLAIMABLE_BY_PARTICIPANT";
export const GST_TCS_PERIODS_COLLECTION = "gstTcsPeriods";

/** IST calendar month, the GSTR-8 period. */
export function tcsPeriodOf(at: number): string {
  return new Date(at + 19_800_000).toISOString().slice(0, 7);
}

export interface WithholdingRecord {
  orderId: string;
  restaurantId: string;
  financialYear: string;
  gstTcsPaise: number;
  gstTcs: {cgstPaise: number; sgstPaise: number; igstPaise: number; basePaise: number};
  incomeTaxTdsPaise: number;
  incomeTaxTdsBasePaise: number;
  incomeTaxTdsCatchUpBasePaise: number;
  /** The seller's year-to-date TDS that should have been deducted after this order. */
  incomeTaxTdsRequiredYtdPaise?: number;
  /** Each tax on its own; the withholding heads are what was actually deducted. */
  taxHeads?: TaxHeads;
  /** GST_LIVE was on when the order was priced (TCS, invoices). */
  gstApplied?: boolean;
  /** TDS_LIVE was on at delivery (seller TDS). */
  tdsApplied?: boolean;
  /** Local delivery GST, settled once the rider is known. */
  localDelivery?: {riderId: string; basis: string; gstPaise: number; taxComplianceStatus?: string};
  /** The delivery's legal/accounting settlement with its supplier (rider or store). */
  deliverySettlement?: DeliverySupplierSettlement;
  /** Refund: Section 52 return adjustment in the refund month's TCS period (never a negative carry-forward). */
  gstTcsReturnAdjustment?: {period: string; sellerReturnedBasePaise: number; sellerAdjustedTcsPaise: number;
    sellerUnadjustedTcsPaise: number; riderAdjustedTcsPaise: number; riderUnadjustedTcsPaise: number};
  /** Refund: income-tax TDS already deducted is kept; any permitted adjustment goes through reconciliation. */
  tdsReversal?: {status: TdsReversalStatus; sellerTdsPaise: number; riderEcommerceTdsPaise: number; returnedGrossPaise: number;
    resolvedAt?: number; resolvedBy?: string; note?: string};
  /** Refund of the delivery charge: the delivery settlement's economic entries, reversed. */
  deliverySettlementReversal?: {reversedAt: number; deliveryGrossConsideration: number; supplierGst: number; platformFee: number;
    platformFeeGst: number; netSettlement: number; operationalPayKept: number; operationalPayKeptClassification: "PENDING_REVIEW"};
  /** RIDER supplier: income-tax e-commerce TDS on the rider's gross delivery consideration. */
  riderEcommerceTds?: {riderId: string; financialYear: string; basePaise: number; rateBps: number; tdsPaise: number;
    requiredYtdPaise: number; catchUpBasePaise: number};
  /** GST TCS u/s 52 withheld from a GST-registered rider's delivery service. */
  riderDeliveryTcsPaise?: number;
  invoices: {series: string; invoiceNo: string; kind: string}[];
  recordedAt: number;
  reversedAt?: number;
}

function sellerSeriesPrefix(restaurantId: string, configured: unknown): string {
  const own = String(configured ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  return own || restaurantId.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6) || "SELLER";
}

/** The invoices one delivered order needs, by series. */
export function invoicePlan(tax: OrderTax, restaurantId: string, sellerPrefix: string): {series: string; prefix: string; kind: string}[] {
  const fy = tax.financialYear ?? "";
  const plan: {series: string; prefix: string; kind: string}[] = [];
  if (tax.storeKind === "restaurant") {
    plan.push({series: `scraveit_restaurant_9_5_${fy}`, prefix: `SCR/RS/${fy}`, kind: "restaurant_service_9_5"});
  } else {
    plan.push({series: `seller_${restaurantId}_${fy}`, prefix: `${sellerPrefix}/${fy}`, kind: "seller_goods"});
  }
  if (tax.services.some((line) => line.chargedTo === "customer" && line.component !== "restaurant_service")) {
    plan.push({series: `scraveit_services_${fy}`, prefix: `SCR/SV/${fy}`, kind: "scraveit_customer_services"});
  }
  if (tax.services.some((line) => line.component === "commission")) {
    plan.push({series: `scraveit_commission_${fy}`, prefix: `SCR/CM/${fy}`, kind: "scraveit_commission"});
  }
  return plan;
}

export function withholdingJournal(entry: WithholdingRecord, reversal = false): LedgerJournal | null {
  const sellerTotal = entry.gstTcsPaise + entry.incomeTaxTdsPaise;
  const riderTcs = entry.riderDeliveryTcsPaise ?? 0;
  const riderTds = entry.riderEcommerceTds?.tdsPaise ?? 0;
  const riderId = entry.riderEcommerceTds?.riderId || entry.localDelivery?.riderId || "";
  if (sellerTotal + riderTcs + riderTds <= 0) return null;
  const payables = [
    {accountId: `liability:restaurant-payable:${entry.restaurantId}`, amountPaise: sellerTotal},
    {accountId: `liability:rider-earnings:${riderId}`, amountPaise: riderTcs + riderTds},
  ].filter((line) => line.amountPaise > 0);
  const tcs = {accountId: "liability:gst-tcs-payable", amountPaise: entry.gstTcsPaise + riderTcs};
  const tds = {accountId: "liability:income-tax-tds-payable", amountPaise: entry.incomeTaxTdsPaise};
  const riderEcom = {accountId: "liability:rider-ecommerce-tds-payable", amountPaise: riderTds};
  const lines = [tcs, tds, riderEcom].filter((line) => line.amountPaise > 0);
  return createLedgerJournal({
    eventType: reversal ? "tax_withholding_reversal" : "tax_withholding",
    eventId: `order:${entry.orderId}:${reversal ? "withholding-reversed" : "withholding"}`,
    occurredAt: reversal ? entry.reversedAt ?? entry.recordedAt : entry.recordedAt,
    orderId: entry.orderId,
    metadata: {restaurantId: entry.restaurantId, financialYear: entry.financialYear},
    postings: reversal ? [
      ...lines.map((line) => ({...line, side: "debit" as const, memo: "Withholding reversed on refund"})),
      ...payables.map((line) => ({...line, side: "credit" as const, memo: "Withholding returned"})),
    ] : [
      ...payables.map((line) => ({...line, side: "debit" as const, memo: "GST TCS / income-tax TDS withheld"})),
      ...lines.map((line) => ({...line, side: "credit" as const,
        memo: line === tcs ? "GST TCS u/s 52 payable" : line === riderEcom ? "Rider e-commerce TDS payable" :
          "Income-tax e-commerce TDS payable"})),
    ],
  });
}

/**
 * Records withholding and invoice numbers for a delivered order, once. Safe
 * to retry: the per-order record is written in the same transaction as the
 * seller's yearly total and the invoice counters, and the journal is rebuilt
 * from that record.
 */
/** A rider's GST position for the delivery service. */
export function riderDeliveryContext(rider: unknown, supplier: DeliveryServiceSupplier): DeliveryTaxContext {
  const input = record(rider);
  const gstin = String(input.riderGstin ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return {deliveryServiceSupplier: supplier, riderGstRegistered: input.riderGstRegistered === true && validGstin(gstin),
    riderGstin: validGstin(gstin) ? gstin : "", riderRegistrationLiable: input.riderRegistrationLiable === true};
}

export async function recordDeliveredOrderTax(
  order: {id: string; restaurantId: string; riderId?: string; deliveredAt?: number; updatedAt?: number},
  database: FirestoreLike = firestoreDb,
): Promise<WithholdingRecord | null> {
  const economics = await database.collection("orderEconomics").doc(order.id).get();
  const tax = economics.exists ? (economics.data() as {orderTax?: OrderTax}).orderTax : undefined;
  if (!tax || !tax.financialYear) return null;
  const settings = await loadTaxSettings(database);
  // Orders priced before this field existed had GST on.
  const gstApplied = tax.gstApplied !== false;
  const tdsApplied = settings.tdsActive;
  if (!gstApplied && !tdsApplied) return null;
  const riderId = String(order.riderId ?? "");
  const riderSnap = riderId ? await database.collection("riders").doc(riderId).get() : null;
  const checkoutDelivery = tax.services.find((line) => line.component === "delivery_fee");
  const selfDelivered = isStoreSelfDelivery(checkoutDelivery);
  // A store's own delivery is settled at checkout; a rider's depends on the rider who delivered.
  const deliveryLines = selfDelivered ? [checkoutDelivery!] : gstApplied ? deliveryGstLines(settings.law, tax.pricedAt ?? Number(order.deliveredAt ?? Date.now()),
    checkoutDelivery?.basePaise ?? 0,
    riderDeliveryContext(riderSnap?.exists ? riderSnap.data() : {}, settings.deliveryServiceSupplier), tax.intraState)
    .map((line) => ({...line, ...(checkoutDelivery?.consideration ? {consideration: checkoutDelivery.consideration} : {})})) : [];
  // With GST off the consideration is still known from checkout (income-tax TDS needs it).
  const deliveryLine = deliveryLines[0] ?? (checkoutDelivery ? checkoutDelivery : undefined);
  const supplier: DeliveryServiceSupplier = selfDelivered ? "RESTAURANT" : settings.deliveryServiceSupplier;
  const pricedAt = tax.pricedAt ?? Number(order.deliveredAt ?? Date.now());
  // RIDER supplier: e-commerce TDS on the rider's gross consideration (never contractor TDS on the same delivery).
  const riderEcomRule = ecomTdsRuleAt(settings.law, pricedAt);
  const classSnap = riderId ? await database.collection("riderTaxClassifications").doc(riderId).get() : null;
  const classification = classificationAt(
    (record(classSnap?.exists ? classSnap.data() : {}).entries as ClassificationEntry[] | undefined) ?? [], pricedAt);
  const identity = riderTdsIdentity(riderSnap?.exists ? riderSnap.data() : {});
  const riderEcomApplies = tdsApplied && supplier === "RIDER" && !!riderId && !!riderEcomRule && !!deliveryLine &&
    classification.taxClassification !== "EMPLOYEE";
  const riderIndividual = (identity.legalEntityType === "INDIVIDUAL" || identity.legalEntityType === "HUF") &&
    panMatchesEntity(identity.legalEntityType, identity.panEntityType);
  const riderEcomYearRef = database.collection(TAX_RIDER_ECOM_YEARS_COLLECTION).doc(`${riderId || "none"}_${tax.financialYear}`);
  const operationalPay = supplier === "RIDER" && riderId
    ? await operationalRiderPay(order.id, riderId, record(record(economics.data()).snapshot), database) : 0;
  const riderDeliveryTcsPaise = deliveryLine?.supplier === "rider" && riderId
    ? Math.round(deliveryLine.basePaise * rateAt(settings.law.gstTcs, tax.pricedAt ?? Date.now()) / 10_000) : 0;
  const markerRef = database.collection(TAX_WITHHOLDINGS_COLLECTION).doc(order.id);
  const yearRef = database.collection(TAX_PARTNER_YEARS_COLLECTION).doc(`${order.restaurantId}_${tax.financialYear}`);
  const profileRef = database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(order.restaurantId);
  const recordedAt = Number(order.deliveredAt ?? order.updatedAt ?? Date.now());
  const entry = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    if (marker.exists) return marker.data() as WithholdingRecord;
    const plan = invoicePlan(tax, order.restaurantId,
      sellerSeriesPrefix(order.restaurantId, record(record((await transaction.get(profileRef)).data()).taxProfile).invoicePrefix));
    const seriesRefs = plan.map((item) => database.collection(INVOICE_SERIES_COLLECTION).doc(item.series));
    const seriesSnaps = await Promise.all(seriesRefs.map((ref) => transaction.get(ref)));
    const year = await transaction.get(yearRef);
    const riderYear = riderEcomApplies ? await transaction.get(riderEcomYearRef) : null;
    const tcsPeriodSnaps = new Map<string, Record<string, unknown>>();
    for (const key of [order.restaurantId, riderId].filter(Boolean)) {
      const id = `${key}_${tcsPeriodOf(recordedAt)}`;
      tcsPeriodSnaps.set(id, record((await transaction.get(database.collection(GST_TCS_PERIODS_COLLECTION).doc(id))).data()));
    }
    const yearData = record(year.exists ? year.data() : {});
    const before = Number(yearData.grossPaise ?? 0) || 0;
    const deductedBefore = Number(yearData.tdsDeductedPaise ?? 0) || 0;
    const tds = tdsApplied ? incomeTaxTdsAtDelivery(tax.incomeTaxTds, before, deductedBefore)
      : {tdsPaise: 0, yearGrossAfterPaise: before, requiredYtdPaise: 0, catchUpBasePaise: 0};
    // No GST tax invoice is numbered unless the order was priced with GST_LIVE on.
    const invoices = (gstApplied ? plan : []).map((item, index) => {
      const next = (Number(record(seriesSnaps[index]!.exists ? seriesSnaps[index]!.data() : {}).last ?? 0) || 0) + 1;
      transaction.set(seriesRefs[index]!, {series: item.series, prefix: item.prefix, last: next, updatedAt: recordedAt}, {merge: true});
      const invoiceNo = `${item.prefix}/${String(next).padStart(6, "0")}`;
      transaction.set(database.collection(INVOICES_COLLECTION).doc(invoiceNo.replace(/\//g, "_")), {
        invoiceNo, series: item.series, kind: item.kind, orderId: order.id, restaurantId: order.restaurantId,
        financialYear: tax.financialYear, issuedAt: recordedAt, taxLawVersion: tax.lawVersion,
      });
      return {series: item.series, invoiceNo, kind: item.kind};
    });
    const sellerTcs = gstApplied ? tax.gstTcs.totalPaise : 0;
    const riderYearData = record(riderYear?.exists ? riderYear.data() : {});
    const riderGrossBefore = Number(riderYearData.grossPaise ?? 0) || 0;
    const riderDeductedBefore = Number(riderYearData.tdsDeductedPaise ?? 0) || 0;
    const riderEcom = riderEcomApplies ? incomeTaxTdsAtDelivery({section: riderEcomRule!.section, basePaise: deliveryLine!.basePaise,
      rateBps: identity.pan ? riderEcomRule!.rateBps : riderEcomRule!.noPanRateBps,
      individualExemptUptoPaise: riderEcomRule!.individualExemptUptoPaise, thresholdApplies: riderIndividual && !!identity.pan},
    riderGrossBefore, riderDeductedBefore) : null;
    const storeDeliveryTds = supplier === "RESTAURANT" && deliveryLine && tax.incomeTaxTds.basePaise > 0
      ? Math.round(tds.tdsPaise * deliveryLine.basePaise / tax.incomeTaxTds.basePaise) : 0;
    const supplierTcs = deliveryLine?.supplier === "rider" ? riderDeliveryTcsPaise :
      deliveryLine && (deliveryLine.basis === "store_registered" || deliveryLine.basis === "composite_goods") && gstApplied
        ? Math.round(deliveryLine.basePaise * rateAt(settings.law.gstTcs, pricedAt) / 10_000) : 0;
    const deliverySettlement = deliveryLine && (supplier !== "RIDER" || riderId) ? deliverySupplierSettlement({
      supplier, supplierId: supplier === "RESTAURANT" ? order.restaurantId : riderId, line: deliveryLine,
      operationalPayPaise: operationalPay, tcsPaise: supplierTcs, riderEcommerceTdsPaise: riderEcom?.tdsPaise ?? 0,
      storeDeliveryTdsPaise: storeDeliveryTds, policy: settings.supplierFeePolicy}) ?? undefined : undefined;
    const value: WithholdingRecord = {
      orderId: order.id, restaurantId: order.restaurantId, financialYear: tax.financialYear!,
      gstApplied, tdsApplied, riderDeliveryTcsPaise,
      ...(deliveryLine ? {localDelivery: {riderId, basis: deliveryLine.basis ?? "", gstPaise: deliveryLine.gstPaise,
        ...(deliveryLine.taxComplianceStatus ? {taxComplianceStatus: deliveryLine.taxComplianceStatus} : {})}} : {}),
      ...(deliverySettlement ? {deliverySettlement} : {}),
      ...(riderEcom ? {riderEcommerceTds: {riderId, financialYear: tax.financialYear!, basePaise: deliveryLine!.basePaise,
        rateBps: identity.pan ? riderEcomRule!.rateBps : riderEcomRule!.noPanRateBps, tdsPaise: riderEcom.tdsPaise,
        requiredYtdPaise: riderEcom.requiredYtdPaise, catchUpBasePaise: riderEcom.catchUpBasePaise}} : {}),
      gstTcsPaise: sellerTcs,
      gstTcs: {cgstPaise: tax.gstTcs.cgstPaise, sgstPaise: tax.gstTcs.sgstPaise, igstPaise: tax.gstTcs.igstPaise, basePaise: tax.gstTcs.basePaise},
      incomeTaxTdsPaise: tds.tdsPaise, incomeTaxTdsBasePaise: tax.incomeTaxTds.basePaise,
      incomeTaxTdsCatchUpBasePaise: tds.catchUpBasePaise, incomeTaxTdsRequiredYtdPaise: tds.requiredYtdPaise,
      taxHeads: {...NO_TAX, ...(gstApplied ? tax.taxHeads ?? {} : {}),
        ...(gstApplied ? {local_delivery_gst_9_5: deliveryLine && isScraveitLocalDeliveryGst(deliveryLine) ? deliveryLine.gstPaise : 0,
          gst_tcs_section_52: sellerTcs + riderDeliveryTcsPaise} : {}),
        ...(gstApplied && deliverySettlement ? {scraveit_service_gst:
          (tax.taxHeads?.scraveit_service_gst ?? 0) + deliverySettlement.scraveit_rider_platform_fee_gst} : {}),
        seller_income_tax_tds: tds.tdsPaise, rider_ecommerce_tds: riderEcom?.tdsPaise ?? 0, rider_contractor_tds: 0},
      invoices, recordedAt,
    };
    if (tdsApplied) transaction.set(yearRef, {restaurantId: order.restaurantId, financialYear: tax.financialYear,
      grossPaise: tds.yearGrossAfterPaise, tdsDeductedPaise: deductedBefore + tds.tdsPaise, updatedAt: recordedAt}, {merge: true});
    // TCS collected per supplier per month: the cap for later return adjustments in that period.
    const period = tcsPeriodOf(recordedAt);
    for (const [key, amount] of [[order.restaurantId, sellerTcs], [riderId, riderDeliveryTcsPaise]] as const) {
      if (!key || amount <= 0) continue;
      const ref = database.collection(GST_TCS_PERIODS_COLLECTION).doc(`${key}_${period}`);
      const current = tcsPeriodSnaps.get(`${key}_${period}`) ?? {};
      transaction.set(ref, {supplierId: key, period, tcsCollectedPaise: (Number(current.tcsCollectedPaise) || 0) + amount,
        updatedAt: recordedAt}, {merge: true});
    }
    if (riderEcom) transaction.set(riderEcomYearRef, {riderId, financialYear: tax.financialYear,
      legalEntityType: identity.legalEntityType, pan: identity.pan, grossPaise: riderEcom.yearGrossAfterPaise,
      tdsDeductedPaise: riderDeductedBefore + riderEcom.tdsPaise, updatedAt: recordedAt}, {merge: true});
    transaction.set(markerRef, value);
    return value;
  });
  const journal = withholdingJournal(entry);
  if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
  if (entry.deliverySettlement) {
    for (const extra of [deliveryGstSettlementJournal(order.id, entry.recordedAt, entry.deliverySettlement),
      riderPlatformFeeJournal(order.id, entry.recordedAt, entry.deliverySettlement)]) {
      if (extra) await persistLedgerJournalIfAbsent(extra, database as never);
    }
  }
  if (entry.localDelivery?.taxComplianceStatus === "REGISTRATION_REQUIRED") {
    logger.error("DELIVERY_SUPPLIER_REGISTRATION_REQUIRED", {orderId: order.id, riderId, basis: entry.localDelivery.basis});
  }
  return entry;
}

/**
 * A refunded (returned) order:
 * - GST TCS: a Section 52 return adjustment in the refund month's period,
 *   capped at the TCS collected from that supplier in that period - no
 *   negative carry-forward. Only the adjusted part goes back to the supplier.
 * - Income-tax TDS: never handed back as cash. Already deducted TDS is kept,
 *   the yearly totals are left alone, and the order is marked
 *   PENDING_ADJUSTMENT for the tax reconciliation (ADJUSTED or
 *   CLAIMABLE_BY_PARTICIPANT later), or NOT_REQUIRED when none was deducted.
 * - Delivery charge refunded: the delivery settlement is reversed (gross
 *   consideration, supplier GST, SCRAVEIT platform fee and its GST); the
 *   rider keeps its operational pay as a SCRAVEIT-funded amount whose tax
 *   treatment is pending.
 */
export async function reverseOrderTaxWithholding(orderId: string, at: number,
  database: FirestoreLike = firestoreDb, options: {deliveryConsiderationRefunded?: boolean} = {}): Promise<WithholdingRecord | null> {
  const deliveryRefunded = options.deliveryConsiderationRefunded !== false;
  const markerRef = database.collection(TAX_WITHHOLDINGS_COLLECTION).doc(orderId);
  const period = tcsPeriodOf(at);
  const entry = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    if (!marker.exists) return null;
    const value = marker.data() as WithholdingRecord;
    if (value.reversedAt) return value;
    const riderId = value.localDelivery?.riderId || value.riderEcommerceTds?.riderId || "";
    const sellerRef = database.collection(GST_TCS_PERIODS_COLLECTION).doc(`${value.restaurantId}_${period}`);
    const riderRef = riderId ? database.collection(GST_TCS_PERIODS_COLLECTION).doc(`${riderId}_${period}`) : null;
    const sellerPeriod = record((await transaction.get(sellerRef)).data());
    const riderPeriod = riderRef ? record((await transaction.get(riderRef)).data()) : {};
    const capacity = (doc: Record<string, unknown>) =>
      Math.max(0, (Number(doc.tcsCollectedPaise) || 0) - (Number(doc.returnAdjustedPaise) || 0));
    const sellerTcs = value.gstTcsPaise;
    const riderTcs = deliveryRefunded ? value.riderDeliveryTcsPaise ?? 0 : 0;
    const sellerAdjusted = Math.min(sellerTcs, capacity(sellerPeriod));
    const riderAdjusted = Math.min(riderTcs, capacity(riderPeriod));
    if (sellerAdjusted > 0) transaction.set(sellerRef, {supplierId: value.restaurantId, period,
      returnAdjustedPaise: (Number(sellerPeriod.returnAdjustedPaise) || 0) + sellerAdjusted, updatedAt: at}, {merge: true});
    if (riderRef && riderAdjusted > 0) transaction.set(riderRef, {supplierId: riderId, period,
      returnAdjustedPaise: (Number(riderPeriod.returnAdjustedPaise) || 0) + riderAdjusted, updatedAt: at}, {merge: true});
    const sellerTds = value.incomeTaxTdsPaise;
    const riderTds = value.riderEcommerceTds?.tdsPaise ?? 0;
    const settlement = value.deliverySettlement;
    const reversed: WithholdingRecord = {
      ...value,
      reversedAt: at,
      gstTcsReturnAdjustment: {period, sellerReturnedBasePaise: value.gstTcs.basePaise, sellerAdjustedTcsPaise: sellerAdjusted,
        sellerUnadjustedTcsPaise: sellerTcs - sellerAdjusted, riderAdjustedTcsPaise: riderAdjusted,
        riderUnadjustedTcsPaise: riderTcs - riderAdjusted},
      tdsReversal: {status: sellerTds + riderTds > 0 ? "PENDING_ADJUSTMENT" : "NOT_REQUIRED", sellerTdsPaise: sellerTds,
        riderEcommerceTdsPaise: riderTds, returnedGrossPaise: value.incomeTaxTdsBasePaise + (value.riderEcommerceTds?.basePaise ?? 0)},
      ...(deliveryRefunded && settlement ? {deliverySettlementReversal: {reversedAt: at,
        deliveryGrossConsideration: settlement.delivery_gross_consideration, supplierGst: settlement.delivery_gst_collected_for_supplier,
        platformFee: settlement.scraveit_rider_platform_fee, platformFeeGst: settlement.scraveit_rider_platform_fee_gst,
        netSettlement: settlement.delivery_supplier_net_settlement, operationalPayKept: settlement.operational_pay,
        operationalPayKeptClassification: "PENDING_REVIEW" as const}} : {}),
    };
    transaction.set(markerRef, reversed);
    return reversed;
  });
  if (entry && entry.reversedAt === at) {
    for (const journal of [tcsReturnAdjustmentJournal(entry), ...deliverySettlementReversalJournals(entry)]) {
      if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
    }
    logger.info("TAX_RETURN_RECORDED", {orderId, tcsAdjustment: entry.gstTcsReturnAdjustment, tds: entry.tdsReversal?.status});
  }
  return entry;
}

/** Gives back only the TCS the return adjustment allowed for that period. */
export function tcsReturnAdjustmentJournal(entry: WithholdingRecord): LedgerJournal | null {
  const adjustment = entry.gstTcsReturnAdjustment;
  if (!adjustment) return null;
  const riderId = entry.localDelivery?.riderId || entry.riderEcommerceTds?.riderId || "";
  const returns = [
    {accountId: `liability:restaurant-payable:${entry.restaurantId}`, amountPaise: adjustment.sellerAdjustedTcsPaise},
    {accountId: `liability:rider-earnings:${riderId}`, amountPaise: riderId ? adjustment.riderAdjustedTcsPaise : 0},
  ].filter((line) => line.amountPaise > 0);
  const total = returns.reduce((sum, line) => sum + line.amountPaise, 0);
  if (total <= 0) return null;
  return createLedgerJournal({
    eventType: "tax_withholding_reversal",
    eventId: `order:${entry.orderId}:tcs-return-adjustment`,
    occurredAt: entry.reversedAt ?? entry.recordedAt,
    orderId: entry.orderId,
    metadata: {restaurantId: entry.restaurantId, period: adjustment.period, kind: "gst_tcs_return_adjustment"},
    postings: [
      {accountId: "liability:gst-tcs-payable", side: "debit", amountPaise: total, memo: "Section 52 return adjustment"},
      ...returns.map((line) => ({...line, side: "credit" as const, memo: "TCS on returned supply adjusted"})),
    ],
  });
}

/** The delivery settlement's economic entries, reversed when the delivery charge was refunded. */
export function deliverySettlementReversalJournals(entry: WithholdingRecord): LedgerJournal[] {
  const settlement = entry.deliverySettlement;
  if (!settlement || !entry.deliverySettlementReversal) return [];
  const at = entry.deliverySettlementReversal.reversedAt;
  const journals: LedgerJournal[] = [];
  const fee = riderPlatformFeeJournal(entry.orderId, at, settlement, true);
  if (fee) journals.push(fee);
  if (settlement.delivery_gst_collected_for_supplier > 0) {
    journals.push(createLedgerJournal({
      eventType: "delivery_gst_settlement",
      eventId: `order:${entry.orderId}:delivery-gst:reversed`,
      occurredAt: at,
      orderId: entry.orderId,
      metadata: {supplier: settlement.delivery_service_supplier, supplierId: settlement.supplier_id, reversal: true},
      postings: [
        {accountId: supplierPayableAccount(settlement), side: "debit", amountPaise: settlement.delivery_gst_collected_for_supplier,
          memo: "Supplier's delivery GST reversed: refunded to the customer"},
        {accountId: "liability:tax-payable", side: "credit", amountPaise: settlement.delivery_gst_collected_for_supplier,
          memo: "Delivery GST to be refunded"},
      ],
    }));
  }
  return journals;
}

/**
 * Tax reconciliation closes a refunded order's TDS: ADJUSTED (a permitted
 * adjustment was made - the TDS goes back to the participant) or
 * CLAIMABLE_BY_PARTICIPANT (deposited TDS stays; the participant claims it).
 */
export async function resolveTdsReversal(uid: string, token: DecodedIdToken,
  input: {orderId: string; status: "ADJUSTED" | "CLAIMABLE_BY_PARTICIPANT"; note: string},
  database: FirestoreLike = firestoreDb, now = Date.now()): Promise<WithholdingRecord> {
  requireOwnerClaim(token);
  const markerRef = database.collection(TAX_WITHHOLDINGS_COLLECTION).doc(input.orderId);
  const entry = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    const value = marker.exists ? marker.data() as WithholdingRecord : null;
    if (!value?.tdsReversal || value.tdsReversal.status !== "PENDING_ADJUSTMENT") {
      throw new DomainError("failed-precondition", "This order has no TDS waiting for reconciliation.");
    }
    const yearRef = database.collection(TAX_PARTNER_YEARS_COLLECTION).doc(`${value.restaurantId}_${value.financialYear}`);
    const riderYearRef = value.riderEcommerceTds ? database.collection(TAX_RIDER_ECOM_YEARS_COLLECTION)
      .doc(`${value.riderEcommerceTds.riderId}_${value.riderEcommerceTds.financialYear}`) : null;
    const year = record((await transaction.get(yearRef)).data());
    const riderYear = riderYearRef ? record((await transaction.get(riderYearRef)).data()) : {};
    if (input.status === "ADJUSTED") {
      if (value.tdsApplied !== false && value.incomeTaxTdsPaise > 0) transaction.set(yearRef, {
        grossPaise: Math.max(0, (Number(year.grossPaise) || 0) - value.incomeTaxTdsBasePaise),
        tdsDeductedPaise: Math.max(0, (Number(year.tdsDeductedPaise) || 0) - value.incomeTaxTdsPaise), updatedAt: now}, {merge: true});
      if (riderYearRef && value.riderEcommerceTds) transaction.set(riderYearRef, {
        grossPaise: Math.max(0, (Number(riderYear.grossPaise) || 0) - value.riderEcommerceTds.basePaise),
        tdsDeductedPaise: Math.max(0, (Number(riderYear.tdsDeductedPaise) || 0) - value.riderEcommerceTds.tdsPaise), updatedAt: now}, {merge: true});
    }
    const resolved = {...value, tdsReversal: {...value.tdsReversal, status: input.status, resolvedAt: now, resolvedBy: uid,
      note: input.note.slice(0, 500)}};
    transaction.set(markerRef, resolved);
    transaction.set(database.collection("taxComplianceAudit").doc(`tds-reversal-${input.orderId}-${now}`), {
      action: "tds_reversal.resolve", orderId: input.orderId, status: input.status, actorId: uid, note: input.note.slice(0, 500), at: now});
    return resolved;
  });
  if (input.status === "ADJUSTED") {
    const sellerTds = entry.incomeTaxTdsPaise;
    const riderTds = entry.riderEcommerceTds?.tdsPaise ?? 0;
    const lines = [
      {accountId: `liability:restaurant-payable:${entry.restaurantId}`, amountPaise: sellerTds, tdsAccount: "liability:income-tax-tds-payable"},
      {accountId: `liability:rider-earnings:${entry.riderEcommerceTds?.riderId ?? ""}`, amountPaise: riderTds,
        tdsAccount: "liability:rider-ecommerce-tds-payable"},
    ].filter((line) => line.amountPaise > 0);
    if (lines.length) {
      await persistLedgerJournalIfAbsent(createLedgerJournal({
        eventType: "tax_withholding_reversal",
        eventId: `order:${entry.orderId}:tds-adjusted`,
        occurredAt: now,
        orderId: entry.orderId,
        metadata: {restaurantId: entry.restaurantId, kind: "tds_adjusted", resolvedBy: uid},
        postings: [
          ...lines.map((line) => ({accountId: line.tdsAccount, side: "debit" as const, amountPaise: line.amountPaise, memo: "TDS adjusted in reconciliation"})),
          ...lines.map((line) => ({accountId: line.accountId, side: "credit" as const, amountPaise: line.amountPaise, memo: "Adjusted TDS returned"})),
        ],
      }), database as never);
    }
  }
  return entry;
}

/**
 * Checkout tax from the tax law when the engine is switched on, in the shape
 * checkout already uses (customer tax on the bill, partner tax on commission),
 * plus the full per-order breakdown kept with the order's economics.
 */
export async function lawBasedCheckoutTax(input: {
  restaurant: {id: string; storeType?: unknown; selfDelivery?: unknown; deliveryTaxTreatment?: unknown};
  items: readonly PricedOrderItem[];
  menuById: Record<string, CatalogItem>;
  plan: CheckoutEconomicsPlan;
  fees: ServerFees;
  subtotal: number;
  at: number;
}, database: FirestoreLike = firestoreDb): Promise<{tax: TaxComputation | null; orderTax: OrderTax} | null> {
  if (!input.plan.engineEnabled) return null;
  const settings = await loadTaxSettings(database);
  if (settings.gstLive && !settings.gstActive) logger.warn("GST_LIVE_WAITING_FOR_GSTIN", {gstinSaved: Boolean(settings.scraveitGstin)});
  if (settings.tdsLive && !settings.tdsActive) logger.warn("TDS_LIVE_WAITING_FOR_TAN", {tanSaved: Boolean(settings.scraveitTan), tanVerified: settings.tanVerified});
  // A self-delivering store that must register first is blocked whatever the switches say.
  if (input.restaurant.selfDelivery === true &&
    deliveryTaxTreatmentOf(input.restaurant) === "SEPARATE_LOCAL_DELIVERY") {
    const store = await loadSellerTaxProfile(input.restaurant.id, settings.defaultStateCode, database);
    if (store.registrationLiable && !(store.gstin.length === 15 && settings.law.gstTcsRegistrationTypes.includes(store.registrationType))) {
      throw new DomainError("failed-precondition", "This store must add valid GST registration details before it can deliver orders itself.",
        {taxComplianceStatus: "REGISTRATION_REQUIRED"});
    }
  }
  // Neither switch on: nothing to record. TDS alone still needs the order's TDS base kept.
  if (!settings.gstActive && !settings.tdsActive) return null;
  const seller = await loadSellerTaxProfile(input.restaurant.id, settings.defaultStateCode, database);
  const subtotalPaise = paise(input.subtotal);
  const sellerDiscountPaise = input.plan.discount.restaurantDiscountPaise;
  const orderTax = checkoutOrderTax({
    settings, restaurant: input.restaurant, seller, items: input.items, menuById: input.menuById,
    sellerDiscountPaise, platformDiscountPaise: input.plan.discount.platformDiscountPaise,
    fees: {
      deliveryFee: input.fees.deliveryFee, platformFee: input.fees.platformFee,
      smallOrderFee: input.fees.smallOrderThreshold > 0 && input.subtotal < input.fees.smallOrderThreshold ? input.fees.smallOrderFee : 0,
      lateNightFee: input.fees.lateNightFee, rainFee: input.fees.rainFee, surgeFee: input.fees.surgeFee,
      riderSurgeFee: input.fees.riderSurgeFee ?? 0, riderIncentiveFee: input.fees.riderIncentiveFee,
    },
    commissionPaise: Math.round((subtotalPaise - sellerDiscountPaise) * input.plan.commissionBps / 10_000),
    at: input.at,
  });
  return {
    orderTax,
    // GST_LIVE off: the customer's bill keeps the old tax.
    tax: !settings.gstActive ? null : {versionId: `law:${orderTax.lawVersion}`, lines: [], customerTaxPaise: orderTax.customerTaxPaise,
      restaurantTaxPaise: orderTax.partnerTaxPaise},
  };
}
