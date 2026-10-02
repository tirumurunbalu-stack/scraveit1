import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {createLedgerJournal, type LedgerJournal} from "../domain/ledger";
import {riderContractorTdsOnCredit, validPan, type RiderTdsYear} from "../domain/riderTds";
import {contractorTdsRuleAt, financialYearLabel} from "../domain/taxLaw";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {LEDGER_JOURNALS_COLLECTION, persistLedgerJournalIfAbsent} from "./ledger";
import {loadTaxSettings, riderTaxClassificationOf, type RiderTaxClassification, type TaxSettings} from "./taxEngine";

/**
 * Applies rider contractor TDS to every credit of rider earnings in the
 * ledger, once per credit: a marker per (journal, rider), a yearly total per
 * rider, and a journal moving the TDS from the rider's payable into the
 * contractor-TDS liability. Runs on a schedule and right before any payout,
 * so a rider is never paid out the TDS part.
 */

export const RIDER_TDS_CREDITS_COLLECTION = "riderTdsCredits";
export const TAX_RIDER_YEARS_COLLECTION = "taxRiderYears";
const SWEEP_DOC = "riderTdsSweep";
const PAGE = 500;
const MAX_PAGES = 40;
/** Journals can be written a little after the moment they record. */
const OVERLAP_MS = 3 * 86_400_000;
const EARNINGS_PREFIX = "liability:rider-earnings:";

export interface RiderTdsCredit {
  sourceJournalId: string;
  riderId: string;
  financialYear: string;
  occurredAt: number;
  creditPaise: number;
  classification: RiderTaxClassification;
  section: string;
  pan: string;
  rateBps: number;
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

export function riderTdsJournal(credit: RiderTdsCredit): LedgerJournal | null {
  if (credit.tdsPaise <= 0) return null;
  return createLedgerJournal({
    eventType: "rider_contractor_tds",
    eventId: `rider-tds:${credit.sourceJournalId}:${credit.riderId}`,
    occurredAt: credit.occurredAt,
    metadata: {riderId: credit.riderId, financialYear: credit.financialYear, sourceJournalId: credit.sourceJournalId,
      section: credit.section.slice(0, 120), rateBps: credit.rateBps},
    postings: [
      {accountId: `${EARNINGS_PREFIX}${credit.riderId}`, side: "debit", amountPaise: credit.tdsPaise,
        memo: "Contractor TDS deducted from rider earnings"},
      {accountId: "liability:rider-contractor-tds-payable", side: "credit", amountPaise: credit.tdsPaise,
        memo: "Rider contractor TDS payable"},
    ],
  });
}

/** Rider earnings credited by one journal, per rider. */
export function riderEarningCredits(journal: {eventType?: unknown; entries?: unknown}): Map<string, number> {
  const credits = new Map<string, number>();
  if (journal.eventType === "rider_contractor_tds" || !Array.isArray(journal.entries)) return credits;
  for (const raw of journal.entries) {
    const entry = record(raw);
    const accountId = String(entry.accountId ?? "");
    if (entry.side !== "credit" || !accountId.startsWith(EARNINGS_PREFIX)) continue;
    const riderId = accountId.slice(EARNINGS_PREFIX.length);
    credits.set(riderId, (credits.get(riderId) ?? 0) + (Number(entry.amountPaise) || 0));
  }
  return credits;
}

export async function applyRiderCredit(settings: TaxSettings, source: {journalId: string; occurredAt: number},
  riderId: string, creditPaise: number, database: FirestoreLike = firestoreDb): Promise<(RiderTdsCredit & {fresh: boolean}) | null> {
  const rule = contractorTdsRuleAt(settings.law, source.occurredAt);
  if (!rule || creditPaise <= 0) return null;
  const financialYear = financialYearLabel(source.occurredAt);
  const markerRef = database.collection(RIDER_TDS_CREDITS_COLLECTION).doc(`${source.journalId}__${riderId}`);
  const yearRef = database.collection(TAX_RIDER_YEARS_COLLECTION).doc(`${riderId}_${financialYear}`);
  const riderRef = database.collection("riders").doc(riderId);
  const credit = await database.runTransaction(async (transaction: TransactionLike) => {
    const marker = await transaction.get(markerRef);
    if (marker.exists) return {credit: marker.data() as RiderTdsCredit, fresh: false};
    const [riderSnap, yearSnap] = [await transaction.get(riderRef), await transaction.get(yearRef)];
    const rider = record(riderSnap.exists ? riderSnap.data() : {});
    const classification = riderTaxClassificationOf(rider.taxClassification, settings.riderTaxClassification);
    const pan = validPan(rider.panNumber) || validPan(record(rider.payoutProfile).panNumber);
    const yearData = record(yearSnap.exists ? yearSnap.data() : {});
    const before: RiderTdsYear = {
      creditedPaise: Number(yearData.creditedPaise ?? 0) || 0,
      largeCreditsPaise: Number(yearData.largeCreditsPaise ?? 0) || 0,
      deductedPaise: Number(yearData.deductedPaise ?? 0) || 0,
    };
    // Employees: salary TDS is worked out by payroll, not per credit.
    const result = classification === "EMPLOYEE"
      ? {rateBps: 0, requiredYtdPaise: 0, tdsPaise: 0, year: {...before, creditedPaise: before.creditedPaise + creditPaise}}
      : riderContractorTdsOnCredit(rule, pan, before, creditPaise);
    const value: RiderTdsCredit = {
      sourceJournalId: source.journalId, riderId, financialYear, occurredAt: source.occurredAt, creditPaise,
      classification, section: classification === "EMPLOYEE" ? "Salary (payroll)" : rule.section, pan,
      rateBps: result.rateBps, requiredYtdPaise: result.requiredYtdPaise, tdsPaise: result.tdsPaise,
    };
    transaction.set(yearRef, {riderId, financialYear, classification, pan, ...result.year,
      updatedAt: source.occurredAt}, {merge: true});
    transaction.set(markerRef, value);
    return {credit: value, fresh: true};
  });
  // Rebuilt from the marker, so a retry after a crash still posts it once.
  const journal = riderTdsJournal(credit.credit);
  if (journal) await persistLedgerJournalIfAbsent(journal, database as never);
  return {...credit.credit, fresh: credit.fresh};
}

/** Applies TDS to all rider credits since the last sweep. No-op until the tax engine is live. */
export async function sweepRiderContractorTds(database: FirestoreLike = firestoreDb, now = Date.now()): Promise<{
  live: boolean; journalsScanned: number; creditsApplied: number; tdsPaise: number; complete: boolean;
}> {
  const settings = await loadTaxSettings(database);
  if (!settings.live) return {live: false, journalsScanned: 0, creditsApplied: 0, tdsPaise: 0, complete: true};
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
      for (const [riderId, credit] of riderEarningCredits(journal)) {
        const applied = await applyRiderCredit(settings, {journalId: doc.id, occurredAt}, riderId, credit, database);
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
  return {live: true, journalsScanned, creditsApplied, tdsPaise, complete};
}
