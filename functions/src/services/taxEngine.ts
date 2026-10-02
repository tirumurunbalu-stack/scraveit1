import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {
  computeOrderTax,
  incomeTaxTdsAtDelivery,
  type EntityType,
  type GstRegistrationType,
  type OrderTax,
  type SellerTaxProfile,
  type StoreKind,
} from "../domain/orderTax";
import {financialYearLabel, normalizeProductTaxRules, normalizeTaxLaw, type TaxLaw} from "../domain/taxLaw";
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
 * Off until private/taxLaw.enabled is true; checkout then keeps its old tax.
 */

export const TAX_LAW_DOC = "taxLaw";
export const TAX_WITHHOLDINGS_COLLECTION = "taxWithholdings";
export const TAX_PARTNER_YEARS_COLLECTION = "taxPartnerYears";
export const INVOICES_COLLECTION = "invoices";
export const INVOICE_SERIES_COLLECTION = "invoiceSeries";

export interface TaxSettings {
  enabled: boolean;
  law: TaxLaw;
  /** GST state code used when an address or partner has none (37 = Andhra Pradesh). */
  defaultStateCode: string;
  /** SCRAVEIT's GSTIN, printed on its invoices. */
  scraveitGstin: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeTaxSettings(value: unknown): TaxSettings {
  const input = record(value);
  return {
    enabled: input.enabled === true,
    law: normalizeTaxLaw(input.law),
    defaultStateCode: String(input.defaultStateCode || "37").replace(/[^0-9]/g, "").slice(0, 2) || "37",
    scraveitGstin: String(input.scraveitGstin ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15),
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
  const payout = record(input.payoutProfile);
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
  return restaurant.storeType === "grocery" || restaurant.storeType === "dairy" ? restaurant.storeType : "restaurant";
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
  const total = entry.gstTcsPaise + entry.incomeTaxTdsPaise;
  if (total <= 0) return null;
  const payable = {accountId: `liability:restaurant-payable:${entry.restaurantId}`, amountPaise: total};
  const tcs = {accountId: "liability:gst-tcs-payable", amountPaise: entry.gstTcsPaise};
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
      {...payable, side: "credit" as const, memo: "Withholding returned to the seller"},
    ] : [
      {...payable, side: "debit" as const, memo: "GST TCS and income-tax TDS withheld"},
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
export async function recordDeliveredOrderTax(
  order: {id: string; restaurantId: string; deliveredAt?: number; updatedAt?: number},
  database: FirestoreLike = firestoreDb,
): Promise<WithholdingRecord | null> {
  const economics = await database.collection("orderEconomics").doc(order.id).get();
  const tax = economics.exists ? (economics.data() as {orderTax?: OrderTax}).orderTax : undefined;
  if (!tax || !tax.financialYear) return null;
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
    const before = Number(record(year.exists ? year.data() : {}).grossPaise ?? 0) || 0;
    const tds = incomeTaxTdsAtDelivery(tax.incomeTaxTds, before);
    const invoices = plan.map((item, index) => {
      const next = (Number(record(seriesSnaps[index]!.exists ? seriesSnaps[index]!.data() : {}).last ?? 0) || 0) + 1;
      transaction.set(seriesRefs[index]!, {series: item.series, prefix: item.prefix, last: next, updatedAt: recordedAt}, {merge: true});
      const invoiceNo = `${item.prefix}/${String(next).padStart(6, "0")}`;
      transaction.set(database.collection(INVOICES_COLLECTION).doc(invoiceNo.replace(/\//g, "_")), {
        invoiceNo, series: item.series, kind: item.kind, orderId: order.id, restaurantId: order.restaurantId,
        financialYear: tax.financialYear, issuedAt: recordedAt, taxLawVersion: tax.lawVersion,
      });
      return {series: item.series, invoiceNo, kind: item.kind};
    });
    const value: WithholdingRecord = {
      orderId: order.id, restaurantId: order.restaurantId, financialYear: tax.financialYear!,
      gstTcsPaise: tax.gstTcs.totalPaise,
      gstTcs: {cgstPaise: tax.gstTcs.cgstPaise, sgstPaise: tax.gstTcs.sgstPaise, igstPaise: tax.gstTcs.igstPaise, basePaise: tax.gstTcs.basePaise},
      incomeTaxTdsPaise: tds.tdsPaise, incomeTaxTdsBasePaise: tax.incomeTaxTds.basePaise,
      incomeTaxTdsCatchUpBasePaise: tds.catchUpBasePaise, invoices, recordedAt,
    };
    transaction.set(yearRef, {restaurantId: order.restaurantId, financialYear: tax.financialYear,
      grossPaise: tds.yearGrossAfterPaise, updatedAt: recordedAt}, {merge: true});
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
    const gross = Number(record(year.exists ? year.data() : {}).grossPaise ?? 0) || 0;
    transaction.set(yearRef, {grossPaise: Math.max(0, gross - value.incomeTaxTdsBasePaise), updatedAt: at}, {merge: true});
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
}, database: FirestoreLike = firestoreDb): Promise<{tax: TaxComputation; orderTax: OrderTax} | null> {
  if (!input.plan.engineEnabled) return null;
  const settings = await loadTaxSettings(database);
  if (!settings.enabled) return null;
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
    tax: {versionId: `law:${orderTax.lawVersion}`, lines: [], customerTaxPaise: orderTax.customerTaxPaise,
      restaurantTaxPaise: orderTax.partnerTaxPaise},
  };
}
