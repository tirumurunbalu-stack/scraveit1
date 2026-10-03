import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {
  classificationAt,
  classificationChangeProblem,
  EMPTY_RIDER_TDS_YEAR,
  panMatchesEntity,
  riderTdsIdentity,
  riderContractorTdsOnCredit,
  type ClassificationEntry,
  type RiderCreditComponent,
  type RiderTaxClassification,
  type RiderTdsYear,
  type TipTdsTreatment,
} from "../domain/riderTds";
import {contractorTdsRuleAt, ecomTdsRuleAt, financialYearLabel} from "../domain/taxLaw";
import {DomainError} from "../errors";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {requireOwnerClaim} from "./authz";
import {LEDGER_JOURNALS_COLLECTION, persistLedgerJournalIfAbsent} from "./ledger";
import {incomeTaxTdsAtDelivery} from "../domain/orderTax";
import {
  applyTdsOffset,
  PERQUISITE_RULE,
  perquisiteTdsOnCredit,
  riderPaymentCategoryOf,
  tdsRouteOf,
  type RiderPaymentTaxCategory,
  type TdsOffsetSource,
} from "../domain/riderPaymentTax";
import {
  loadTaxSettings,
  TAX_RIDER_ECOM_YEARS_COLLECTION,
  TDS_OFFSETS_COLLECTION,
  tdsOffsetPoolId,
  type TaxSettings,
} from "./taxEngine";

/**
 * Applies rider contractor TDS to every rider credit in the ledger, once per
 * credit: a marker per (journal, rider, component), a yearly total per rider,
 * and a journal moving the TDS from what the rider is owed into the
 * contractor-TDS liability. Runs on a schedule and right before any payout,
 * so a rider is never paid out the TDS part. Only while TDS_LIVE is active
 * and SCRAVEIT is the delivery supplier (deliveryServiceSupplier SCRAVEIT).
 */

export const RIDER_TDS_CREDITS_COLLECTION = "riderTdsCredits";
export const TAX_RIDER_YEARS_COLLECTION = "taxRiderYears";
export const RIDER_TAX_CLASSIFICATIONS_COLLECTION = "riderTaxClassifications";
export const TAX_COMPLIANCE_AUDIT_COLLECTION = "taxComplianceAudit";
const SWEEP_DOC = "riderTdsSweep";
const PAGE = 500;
const MAX_PAGES = 40;
/** Journals can be written a little after the moment they record. */
const OVERLAP_MS = 3 * 86_400_000;
const ACCOUNT_PREFIX: Record<RiderCreditComponent, string> = {
  rider_earning: "liability:rider-earnings:",
  customer_tip: "liability:rider-tips:",
};

export interface RiderTdsCredit {
  sourceJournalId: string;
  riderId: string;
  component: RiderCreditComponent;
  financialYear: string;
  occurredAt: number;
  creditPaise: number;
  classification: RiderTaxClassification;
  classificationEffectiveFrom: string;
  section: string;
  legalEntityType: string;
  pan: string;
  panEntityType: string;
  panVerified: boolean;
  entityPanMismatch: boolean;
  tipTdsTreatment: TipTdsTreatment;
  rateBps: number;
  rateReason: string;
  requiredYtdPaise: number;
  /** rider_contractor_tds for this credit. */
  tdsPaise: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function financialYearStart(at: number): number {
  const ist = new Date(at + 19_800_000);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return Date.UTC(year, 3, 1) - 19_800_000;
}

export {riderTdsIdentity} from "../domain/riderTds";

function classificationEntries(value: unknown): ClassificationEntry[] {
  const entries = record(value).entries;
  return Array.isArray(entries) ? entries.map((entry) => entry as ClassificationEntry) : [];
}

export function riderTdsJournal(credit: RiderTdsCredit): LedgerJournal | null {
  if (credit.tdsPaise <= 0) return null;
  return createLedgerJournal({
    eventType: "rider_contractor_tds",
    eventId: `rider-tds:${credit.sourceJournalId}:${credit.riderId}:${credit.component}`,
    occurredAt: credit.occurredAt,
    metadata: {riderId: credit.riderId, financialYear: credit.financialYear, sourceJournalId: credit.sourceJournalId,
      component: credit.component, section: credit.section.slice(0, 120), rateBps: credit.rateBps},
    postings: [
      {accountId: `${ACCOUNT_PREFIX[credit.component]}${credit.riderId}`, side: "debit", amountPaise: credit.tdsPaise,
        memo: "Contractor TDS deducted"},
      {accountId: "liability:rider-contractor-tds-payable", side: "credit", amountPaise: credit.tdsPaise,
        memo: "Rider contractor TDS payable"},
    ],
  });
}

/** What one journal credits to riders: earnings and customer tips kept apart. */
export function riderCredits(journal: {eventType?: unknown; entries?: unknown}): {riderId: string; component: RiderCreditComponent; amountPaise: number}[] {
  // Own TDS journals, and GST passed on to a registered rider (TDS is on the value excluding GST).
  if (["rider_contractor_tds", "rider_ecommerce_tds", "rider_perquisite_tds", "delivery_gst_settlement", "delivery_settlement",
    "tax_withholding", "tax_withholding_reversal"].includes(String(journal.eventType)) || !Array.isArray(journal.entries)) return [];
  const totals = new Map<string, {riderId: string; component: RiderCreditComponent; amountPaise: number}>();
  for (const raw of journal.entries) {
    const entry = record(raw);
    if (entry.side !== "credit") continue;
    const accountId = String(entry.accountId ?? "");
    for (const component of ["rider_earning", "customer_tip"] as const) {
      if (!accountId.startsWith(ACCOUNT_PREFIX[component])) continue;
      const riderId = accountId.slice(ACCOUNT_PREFIX[component].length);
      const key = `${riderId}|${component}`;
      const row = totals.get(key) ?? {riderId, component, amountPaise: 0};
      row.amountPaise += Number(entry.amountPaise) || 0;
      totals.set(key, row);
    }
  }
  return [...totals.values()].filter((row) => row.amountPaise > 0);
}

export async function applyRiderCredit(settings: TaxSettings, source: {journalId: string; occurredAt: number},
  credit: {riderId: string; component: RiderCreditComponent; amountPaise: number},
  database: FirestoreLike = firestoreDb): Promise<(RiderTdsCredit & {fresh: boolean}) | null> {
  const rule = contractorTdsRuleAt(settings.law, source.occurredAt);
  if (!rule || credit.amountPaise <= 0) return null;
  const {riderId, component} = credit;
  const financialYear = financialYearLabel(source.occurredAt);
  const markerRef = database.collection(RIDER_TDS_CREDITS_COLLECTION).doc(`${source.journalId}__${riderId}__${component}`);
  const yearRef = database.collection(TAX_RIDER_YEARS_COLLECTION).doc(`${riderId}_${financialYear}`);
  const riderRef = database.collection("riders").doc(riderId);
  const classRef = database.collection(RIDER_TAX_CLASSIFICATIONS_COLLECTION).doc(riderId);
  const result = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    if (marker.exists) return {credit: marker.data() as RiderTdsCredit, fresh: false};
    const riderSnap = await transaction.get(riderRef);
    const classSnap = await transaction.get(classRef);
    const yearSnap = await transaction.get(yearRef);
    const identity = riderTdsIdentity(riderSnap.exists ? riderSnap.data() : {});
    const classification = classificationAt(classificationEntries(classSnap.exists ? classSnap.data() : {}), source.occurredAt);
    const yearData = record(yearSnap.exists ? yearSnap.data() : {});
    const before: RiderTdsYear = {
      earningsPaise: Number(yearData.earningsPaise ?? 0) || 0,
      tipsPaise: Number(yearData.tipsPaise ?? 0) || 0,
      largeCreditsPaise: Number(yearData.largeCreditsPaise ?? 0) || 0,
      deductedPaise: Number(yearData.deductedPaise ?? 0) || 0,
    };
    const employee = classification.taxClassification === "EMPLOYEE";
    // Employees: salary TDS is worked out by payroll, not per credit.
    const outcome = employee
      ? {rateBps: 0, rateReason: "payroll", requiredYtdPaise: 0, tdsPaise: 0, year: {...before,
        earningsPaise: before.earningsPaise + (component === "rider_earning" ? credit.amountPaise : 0),
        tipsPaise: before.tipsPaise + (component === "customer_tip" ? credit.amountPaise : 0)}}
      : riderContractorTdsOnCredit(rule, identity, before, credit, settings.riderTipTdsTreatment);
    const value: RiderTdsCredit = {
      sourceJournalId: source.journalId, riderId, component, financialYear, occurredAt: source.occurredAt,
      creditPaise: credit.amountPaise, classification: classification.taxClassification,
      classificationEffectiveFrom: classification.classificationEffectiveFrom,
      section: employee ? "Salary (payroll)" : rule.section,
      legalEntityType: identity.legalEntityType, pan: identity.pan, panEntityType: identity.panEntityType,
      panVerified: identity.panVerified, entityPanMismatch: !panMatchesEntity(identity.legalEntityType, identity.panEntityType),
      tipTdsTreatment: settings.riderTipTdsTreatment,
      rateBps: outcome.rateBps, rateReason: outcome.rateReason, requiredYtdPaise: outcome.requiredYtdPaise, tdsPaise: outcome.tdsPaise,
    };
    transaction.set(yearRef, {riderId, financialYear, classification: classification.taxClassification,
      legalEntityType: identity.legalEntityType, pan: identity.pan, panVerified: identity.panVerified,
      ...outcome.year, updatedAt: source.occurredAt}, {merge: true});
    transaction.set(markerRef, value);
    return {credit: value, fresh: true};
  });
  // Rebuilt from the marker, so a retry after a crash still posts it once.
  const journal = riderTdsJournal(result.credit);
  if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
  return {...result.credit, fresh: result.fresh};
}

export const TAX_RIDER_PERQUISITE_YEARS_COLLECTION = "taxRiderPerquisiteYears";

export interface RiderPlatformPayment {
  sourceJournalId: string;
  riderId: string;
  component: RiderCreditComponent;
  financialYear: string;
  occurredAt: number;
  amountPaise: number;
  riderPaymentTaxCategory: RiderPaymentTaxCategory | "CUSTOMER_TIP";
  tdsRoute: "ECOMMERCE_8V" | "PERQUISITE_8IV" | "NONE";
  section: string;
  rateBps: number;
  tdsNormallyDuePaise: number;
  offsetPaise: number;
  tdsPaise: number;
}

export function riderPlatformPaymentJournal(payment: RiderPlatformPayment): LedgerJournal | null {
  if (payment.tdsPaise <= 0 || payment.tdsRoute === "NONE") return null;
  const ecommerce = payment.tdsRoute === "ECOMMERCE_8V";
  return createLedgerJournal({
    eventType: ecommerce ? "rider_ecommerce_tds" : "rider_perquisite_tds",
    eventId: `rider-pay-tds:${payment.sourceJournalId}:${payment.riderId}:${payment.component}`,
    occurredAt: payment.occurredAt,
    metadata: {riderId: payment.riderId, financialYear: payment.financialYear, sourceJournalId: payment.sourceJournalId,
      riderPaymentTaxCategory: payment.riderPaymentTaxCategory, section: payment.section.slice(0, 120), rateBps: payment.rateBps},
    postings: [
      {accountId: `${ACCOUNT_PREFIX[payment.component]}${payment.riderId}`, side: "debit", amountPaise: payment.tdsPaise,
        memo: ecommerce ? "Rider e-commerce TDS deducted" : "Business benefit/perquisite TDS deducted"},
      {accountId: ecommerce ? "liability:rider-ecommerce-tds-payable" : "liability:rider-perquisite-tds-payable", side: "credit",
        amountPaise: payment.tdsPaise, memo: ecommerce ? "Rider e-commerce TDS payable" : "Perquisite TDS payable"},
    ],
  });
}

/**
 * RIDER-supplier model: one SCRAVEIT-funded payment to a rider outside a
 * delivery settlement, taxed by its riderPaymentTaxCategory - e-commerce TDS
 * (shares the rider's e-commerce year and offset pool with deliveries),
 * perquisite TDS, or recorded with no deduction. Once per credit.
 */
export async function applyRiderPlatformPayment(settings: TaxSettings,
  source: {journalId: string; occurredAt: number; eventType: string; category: unknown},
  credit: {riderId: string; component: RiderCreditComponent; amountPaise: number},
  database: FirestoreLike = firestoreDb): Promise<(RiderPlatformPayment & {fresh: boolean}) | null> {
  if (credit.amountPaise <= 0) return null;
  const {riderId, component} = credit;
  const map = settings.riderPaymentTaxCategories;
  const category = component === "customer_tip" ? "CUSTOMER_TIP" as const
    : riderPaymentCategoryOf(source.eventType, source.category, map);
  const route = category === "CUSTOMER_TIP"
    ? (settings.riderTipTdsTreatment === "INCLUDED" ? "ECOMMERCE_8V" as const : "NONE" as const)
    : tdsRouteOf(category, map);
  const financialYear = financialYearLabel(source.occurredAt);
  const markerRef = database.collection(RIDER_TDS_CREDITS_COLLECTION).doc(`${source.journalId}__${riderId}__${component}`);
  const riderRef = database.collection("riders").doc(riderId);
  const classRef = database.collection(RIDER_TAX_CLASSIFICATIONS_COLLECTION).doc(riderId);
  const ecomYearRef = database.collection(TAX_RIDER_ECOM_YEARS_COLLECTION).doc(`${riderId}_${financialYear}`);
  const poolRef = database.collection(TDS_OFFSETS_COLLECTION).doc(tdsOffsetPoolId("rider", riderId, financialYear));
  const perqYearRef = database.collection(TAX_RIDER_PERQUISITE_YEARS_COLLECTION).doc(`${riderId}_${financialYear}`);
  const result = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    if (marker.exists) return {payment: marker.data() as RiderPlatformPayment, fresh: false};
    const rider = (await transaction.get(riderRef)).data();
    const classSnap = await transaction.get(classRef);
    const ecomYear = record((await transaction.get(ecomYearRef)).data());
    const poolData = (await transaction.get(poolRef)).data();
    const perqYear = record((await transaction.get(perqYearRef)).data());
    const employee = classificationAt(classificationEntries(classSnap.exists ? classSnap.data() : {}), source.occurredAt)
      .taxClassification === "EMPLOYEE";
    const effectiveRoute = employee ? "NONE" as const : route;
    let section = "";
    let rateBps = 0;
    let due = 0;
    let offset = 0;
    let deducted = 0;
    if (effectiveRoute === "ECOMMERCE_8V") {
      const rule = ecomTdsRuleAt(settings.law, source.occurredAt);
      const identity = riderTdsIdentity(rider);
      const individual = (identity.legalEntityType === "INDIVIDUAL" || identity.legalEntityType === "HUF") &&
        panMatchesEntity(identity.legalEntityType, identity.panEntityType);
      if (rule) {
        section = rule.section;
        rateBps = identity.pan ? rule.rateBps : rule.noPanRateBps;
        const before = Number(ecomYear.grossPaise) || 0;
        const deductedBefore = Number(ecomYear.tdsDeductedPaise) || 0;
        const outcome = incomeTaxTdsAtDelivery({section, basePaise: credit.amountPaise, rateBps,
          individualExemptUptoPaise: rule.individualExemptUptoPaise, thresholdApplies: individual && !!identity.pan}, before, deductedBefore);
        const pool = {participantKey: `rider:${riderId}`, financialYear,
          sources: Array.isArray(record(poolData).sources) ? record(poolData).sources as TdsOffsetSource[] : []};
        const applied = applyTdsOffset(pool, outcome.tdsPaise);
        due = outcome.tdsPaise;
        offset = applied.offsetPaise;
        deducted = applied.tdsActuallyDeductedPaise;
        transaction.set(ecomYearRef, {riderId, financialYear, grossPaise: outcome.yearGrossAfterPaise,
          tdsDeductedPaise: deductedBefore + due, updatedAt: source.occurredAt}, {merge: true});
        if (offset > 0) transaction.set(poolRef, {...applied.pool, updatedAt: source.occurredAt});
      }
    } else if (effectiveRoute === "PERQUISITE_8IV") {
      section = PERQUISITE_RULE.section;
      rateBps = PERQUISITE_RULE.rateBps;
      const outcome = perquisiteTdsOnCredit(PERQUISITE_RULE, Number(perqYear.valuePaise) || 0, Number(perqYear.deductedPaise) || 0,
        credit.amountPaise);
      due = outcome.tdsPaise;
      deducted = outcome.tdsPaise;
      transaction.set(perqYearRef, {riderId, financialYear, valuePaise: outcome.yearValueAfterPaise,
        deductedPaise: (Number(perqYear.deductedPaise) || 0) + deducted, updatedAt: source.occurredAt}, {merge: true});
    }
    const payment: RiderPlatformPayment = {sourceJournalId: source.journalId, riderId, component, financialYear,
      occurredAt: source.occurredAt, amountPaise: credit.amountPaise, riderPaymentTaxCategory: category, tdsRoute: effectiveRoute,
      section: employee ? "Salary (payroll)" : section, rateBps, tdsNormallyDuePaise: due, offsetPaise: offset, tdsPaise: deducted};
    transaction.set(markerRef, payment);
    return {payment, fresh: true};
  });
  const journal = riderPlatformPaymentJournal(result.payment);
  if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
  return {...result.payment, fresh: result.fresh};
}

/** Applies TDS to all rider credits since the last sweep. No-op unless TDS_LIVE is active. */
export async function sweepRiderContractorTds(database: FirestoreLike = firestoreDb, now = Date.now()): Promise<{
  active: boolean; model: string; journalsScanned: number; creditsApplied: number; tdsPaise: number; complete: boolean;
}> {
  const settings = await loadTaxSettings(database);
  if (!settings.tdsActive) return {active: false, model: settings.deliveryServiceSupplier, journalsScanned: 0, creditsApplied: 0,
    tdsPaise: 0, complete: true};
  // SCRAVEIT supplies delivery and subcontracts riders: contractor TDS on every credit. RIDER supplies delivery:
  // the delivery itself is settled per order (e-commerce TDS); here only SCRAVEIT's other payments, by tax category.
  const contractorModel = settings.deliveryServiceSupplier === "SCRAVEIT";
  const sweepRef = database.collection("private").doc(SWEEP_DOC);
  const sweepSnap = await sweepRef.get();
  const scannedThrough = Number(record(sweepSnap.exists ? sweepSnap.data() : {}).scannedThrough ?? 0) ||
    financialYearStart(now);
  let cursor = Math.max(0, scannedThrough - OVERLAP_MS);
  let journalsScanned = 0;
  let creditsApplied = 0;
  let tdsPaise = 0;
  let newest = scannedThrough;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const snap = await database.collection(LEDGER_JOURNALS_COLLECTION).where("occurredAt", ">=", cursor)
      .orderBy("occurredAt").limit(PAGE).get();
    for (const doc of snap.docs) {
      const journal = record(doc.data());
      const occurredAt = Number(journal.occurredAt) || 0;
      journalsScanned += 1;
      newest = Math.max(newest, occurredAt);
      for (const credit of riderCredits(journal)) {
        // RIDER model: an order's own rider pay (incl. per-order incentives) belongs to its delivery settlement.
        if (!contractorModel && journal.orderId && credit.component === "rider_earning") continue;
        const applied = contractorModel
          ? await applyRiderCredit(settings, {journalId: doc.id, occurredAt}, credit, database)
          : await applyRiderPlatformPayment(settings, {journalId: doc.id, occurredAt, eventType: String(journal.eventType ?? ""),
            category: record(journal.metadata).riderPaymentTaxCategory}, credit, database);
        if (applied?.fresh) {
          creditsApplied += 1;
          tdsPaise += applied.tdsPaise;
        }
      }
    }
    if (snap.docs.length < PAGE) {
      complete = true;
      break;
    }
    const last = Number(record(snap.docs[snap.docs.length - 1]!.data()).occurredAt) || cursor;
    // A full page all at one instant cannot advance; move past it.
    cursor = last > cursor ? last : last + 1;
  }
  await sweepRef.set({scannedThrough: newest, sweptAt: now}, {merge: true});
  if (tdsPaise > 0 || !complete) logger.info("RIDER_TDS_SWEEP", {model: settings.deliveryServiceSupplier, journalsScanned, creditsApplied, tdsPaise, complete});
  return {active: true, model: settings.deliveryServiceSupplier, journalsScanned, creditsApplied, tdsPaise, complete};
}

// ---------------------------------------------------------------------------
// Restricted compliance control: contractor / employee
// ---------------------------------------------------------------------------

export const CLASSIFICATION_REASONS = [
  "INDEPENDENT_DELIVERY_PARTNER",
  "ONBOARDED_AS_EMPLOYEE",
  "EMPLOYMENT_ENDED",
  "CORRECTION_APPROVED_BY_CA",
] as const;

export interface ClassificationChangeInput {
  riderId: string;
  taxClassification: RiderTaxClassification;
  effectiveFrom: string;
  reason: typeof CLASSIFICATION_REASONS[number];
  note: string;
}

/**
 * Records a contractor/employee change for one rider. Owner (Super Admin)
 * only, dated from today or later, appended to the rider's history and to an
 * immutable audit record: never an edit of the past.
 */
export async function setRiderTaxClassification(uid: string, token: DecodedIdToken, input: ClassificationChangeInput,
  database: FirestoreLike = firestoreDb, now = Date.now()): Promise<{entries: ClassificationEntry[]; auditId: string}> {
  requireOwnerClaim(token);
  if (input.taxClassification === "EMPLOYEE" && input.reason !== "ONBOARDED_AS_EMPLOYEE" && input.reason !== "CORRECTION_APPROVED_BY_CA") {
    throw new DomainError("invalid-argument", "EMPLOYEE is only for a rider actually onboarded on payroll.");
  }
  if (!input.note.trim()) throw new DomainError("invalid-argument", "Add a note explaining the change.");
  const classRef = database.collection(RIDER_TAX_CLASSIFICATIONS_COLLECTION).doc(input.riderId);
  const riderRef = database.collection("riders").doc(input.riderId);
  const auditId = `rider-classification-${input.riderId}-${now}`;
  const auditRef = database.collection(TAX_COMPLIANCE_AUDIT_COLLECTION).doc(auditId);
  const entries = await database.runTransaction(async (transaction: TransactionLike) => {
    const rider = await transaction.get(riderRef);
    if (!rider.exists) throw new DomainError("not-found", "That rider does not exist.");
    const current = await transaction.get(classRef);
    const existing = classificationEntries(current.exists ? current.data() : {});
    const problem = classificationChangeProblem(existing, {effectiveFrom: input.effectiveFrom, now});
    if (problem) throw new DomainError("failed-precondition", problem);
    const entry: ClassificationEntry = {
      taxClassification: input.taxClassification, classificationEffectiveFrom: input.effectiveFrom,
      classificationReason: input.reason, changedBy: uid, changedAt: now,
    };
    const next = [...existing, entry];
    transaction.set(classRef, {riderId: input.riderId, entries: next, updatedAt: now});
    transaction.set(auditRef, {id: auditId, action: "rider_tax_classification.change", riderId: input.riderId,
      before: classificationAt(existing, now), after: entry, note: input.note.trim().slice(0, 500),
      actorId: uid, actorEmail: String(token.email ?? "").slice(0, 254), at: now});
    return next;
  });
  return {entries, auditId};
}
