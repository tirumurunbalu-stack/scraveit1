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
  type DeliveryServiceSupplier,
  type DeliveryTaxContext,
} from "../domain/orderTax";
import {normalizeTipTdsTreatment, validPan, type TipTdsTreatment} from "../domain/riderTds";
import {financialYearLabel, normalizeProductTaxRules, normalizeTaxLaw, rateAt, type TaxLaw} from "../domain/taxLaw";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import type {CatalogItem, PricedOrderItem} from "../types";
import type {TaxComputation} from "../domain/taxRules";
import type {CheckoutEconomicsPlan, ServerFees} from "./economics";
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
  /** Who supplies local delivery, for local_delivery_gst_9_5. */
  deliveryServiceSupplier: DeliveryServiceSupplier;
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
    deliveryServiceSupplier: input.deliveryServiceSupplier === "SCRAVEIT" ? "SCRAVEIT" : "RIDER",
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

export interface CheckoutTaxContext {
  settings: TaxSettings;
  restaurant: {storeType?: unknown};
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
      delivery: checkoutDeliveryContext(context.settings.deliveryServiceSupplier),
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
  localDelivery?: {riderId: string; basis: string; gstPaise: number; complianceFlag?: string};
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
  if (sellerTotal + riderTcs <= 0) return null;
  const payables = [
    {accountId: `liability:restaurant-payable:${entry.restaurantId}`, amountPaise: sellerTotal},
    {accountId: `liability:rider-earnings:${entry.localDelivery?.riderId ?? ""}`, amountPaise: riderTcs},
  ].filter((line) => line.amountPaise > 0);
  const tcs = {accountId: "liability:gst-tcs-payable", amountPaise: entry.gstTcsPaise + riderTcs};
  const tds = {accountId: "liability:income-tax-tds-payable", amountPaise: entry.incomeTaxTdsPaise};
  const lines = [tcs, tds].filter((line) => line.amountPaise > 0);
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
        memo: line === tcs ? "GST TCS u/s 52 payable" : "Income-tax e-commerce TDS payable"})),
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
  const deliveryLines = gstApplied ? deliveryGstLines(settings.law, tax.pricedAt ?? Number(order.deliveredAt ?? Date.now()),
    tax.services.find((line) => line.component === "delivery_fee")?.basePaise ?? 0,
    riderDeliveryContext(riderSnap?.exists ? riderSnap.data() : {}, settings.deliveryServiceSupplier), tax.intraState) : [];
  const deliveryLine = deliveryLines[0];
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
    const value: WithholdingRecord = {
      orderId: order.id, restaurantId: order.restaurantId, financialYear: tax.financialYear!,
      gstApplied, tdsApplied, riderDeliveryTcsPaise,
      ...(deliveryLine ? {localDelivery: {riderId, basis: deliveryLine.basis ?? "", gstPaise: deliveryLine.gstPaise,
        ...(deliveryLine.complianceFlag ? {complianceFlag: deliveryLine.complianceFlag} : {})}} : {}),
      gstTcsPaise: sellerTcs,
      gstTcs: {cgstPaise: tax.gstTcs.cgstPaise, sgstPaise: tax.gstTcs.sgstPaise, igstPaise: tax.gstTcs.igstPaise, basePaise: tax.gstTcs.basePaise},
      incomeTaxTdsPaise: tds.tdsPaise, incomeTaxTdsBasePaise: tax.incomeTaxTds.basePaise,
      incomeTaxTdsCatchUpBasePaise: tds.catchUpBasePaise, incomeTaxTdsRequiredYtdPaise: tds.requiredYtdPaise,
      taxHeads: {...NO_TAX, ...(gstApplied ? tax.taxHeads ?? {} : {}),
        ...(gstApplied ? {local_delivery_gst_9_5: deliveryLine && deliveryLine.supplier !== "rider" ? deliveryLine.gstPaise : 0,
          gst_tcs_section_52: sellerTcs + riderDeliveryTcsPaise} : {}),
        seller_income_tax_tds: tds.tdsPaise, rider_contractor_tds: 0},
      invoices, recordedAt,
    };
    if (tdsApplied) transaction.set(yearRef, {restaurantId: order.restaurantId, financialYear: tax.financialYear,
      grossPaise: tds.yearGrossAfterPaise, tdsDeductedPaise: deductedBefore + tds.tdsPaise, updatedAt: recordedAt}, {merge: true});
    transaction.set(markerRef, value);
    return value;
  });
  const journal = withholdingJournal(entry);
  if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
  return entry;
}

/** Returns a refunded order's withholding to the seller and lowers its yearly total. */
export async function reverseOrderTaxWithholding(orderId: string, at: number,
  database: FirestoreLike = firestoreDb): Promise<WithholdingRecord | null> {
  const markerRef = database.collection(TAX_WITHHOLDINGS_COLLECTION).doc(orderId);
  const entry = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    if (!marker.exists) return null;
    const value = marker.data() as WithholdingRecord;
    if (value.reversedAt) return value;
    const yearRef = database.collection(TAX_PARTNER_YEARS_COLLECTION).doc(`${value.restaurantId}_${value.financialYear}`);
    const year = await transaction.get(yearRef);
    const yearData = record(year.exists ? year.data() : {});
    const gross = Number(yearData.grossPaise ?? 0) || 0;
    const deducted = Number(yearData.tdsDeductedPaise ?? 0) || 0;
    if (value.tdsApplied !== false) transaction.set(yearRef, {grossPaise: Math.max(0, gross - value.incomeTaxTdsBasePaise),
      tdsDeductedPaise: Math.max(0, deducted - value.incomeTaxTdsPaise), updatedAt: at}, {merge: true});
    const reversed = {...value, reversedAt: at};
    transaction.set(markerRef, reversed);
    return reversed;
  });
  if (entry) {
    const journal = withholdingJournal(entry, true);
    if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
    logger.info("TAX_WITHHOLDING_REVERSED", {orderId, tcs: entry.gstTcsPaise, tds: entry.incomeTaxTdsPaise});
  }
  return entry;
}

/**
 * Checkout tax from the tax law when the engine is switched on, in the shape
 * checkout already uses (customer tax on the bill, partner tax on commission),
 * plus the full per-order breakdown kept with the order's economics.
 */
export async function lawBasedCheckoutTax(input: {
  restaurant: {id: string; storeType?: unknown};
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
