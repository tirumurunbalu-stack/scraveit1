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
import {contractorTdsRuleAt, financialYearLabel} from "../domain/taxLaw";
import {DomainError} from "../errors";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {requireOwnerClaim} from "./authz";
import {LEDGER_JOURNALS_COLLECTION, persistLedgerJournalIfAbsent} from "./ledger";
import {loadTaxSettings, type TaxSettings} from "./taxEngine";

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
  if (journal.eventType === "rider_contractor_tds" || journal.eventType === "delivery_gst_settlement" ||
    !Array.isArray(journal.entries)) return [];
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

/** Applies TDS to all rider credits since the last sweep. No-op unless TDS_LIVE is active. */
export async function sweepRiderContractorTds(database: FirestoreLike = firestoreDb, now = Date.now()): Promise<{
  active: boolean; journalsScanned: number; creditsApplied: number; tdsPaise: number; complete: boolean;
}> {
  const settings = await loadTaxSettings(database);
  // Contractor TDS only when SCRAVEIT supplies delivery and subcontracts riders. Under the RIDER
  // model the rider supplies delivery through SCRAVEIT: e-commerce TDS on delivery instead, never both.
  if (!settings.tdsActive || settings.deliveryServiceSupplier !== "SCRAVEIT") {
    return {active: false, journalsScanned: 0, creditsApplied: 0, tdsPaise: 0, complete: true};
  }
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
        const applied = await applyRiderCredit(settings, {journalId: doc.id, occurredAt}, credit, database);
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
  if (tdsPaise > 0 || !complete) logger.info("RIDER_CONTRACTOR_TDS_SWEEP", {journalsScanned, creditsApplied, tdsPaise, complete});
  return {active: true, journalsScanned, creditsApplied, tdsPaise, complete};
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
