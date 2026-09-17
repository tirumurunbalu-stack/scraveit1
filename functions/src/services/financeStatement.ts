import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db} from "../admin";
import {ADMIN_LEDGER_ROOT} from "./adminDashboard";
import {validateLedgerJournal, type LedgerEventType, type LedgerJournal} from "../domain/ledger";
import {requirePlatformConfigAdminClaim} from "./authz";

export const FINANCE_STATEMENT_MAX_PAGE = 3000;

interface QuerySnapshot {
  val(): unknown;
}

interface QueryReference {
  orderByChild(child: string): QueryReference;
  startAt(value: number): QueryReference;
  endAt(value: number): QueryReference;
  limitToFirst(limit: number): QueryReference;
  get(): Promise<QuerySnapshot>;
}

export interface FinanceStatementDatabase {
  ref(path: string): QueryReference;
}

export interface FinanceStatementEntryLeg {
  readonly accountId: string;
  readonly side: "debit" | "credit";
  readonly amountPaise: number;
}

export interface FinanceStatementEntry {
  readonly journalId: string;
  readonly occurredAt: number;
  readonly eventType: LedgerEventType;
  readonly orderId?: string;
  readonly actorId?: string;
  readonly grossPaise: number;
  readonly legs: readonly FinanceStatementEntryLeg[];
}

export interface FinanceStatementTypeTotal {
  readonly eventType: LedgerEventType;
  readonly count: number;
  readonly grossPaise: number;
}

export interface FinanceStatement {
  readonly scope: "bounded_period_journals";
  readonly startAt: number;
  readonly endAt: number;
  /** False when the period holds more transactions than this bounded page - the
   * itemized entries AND the totals below cover only the fetched page, never a
   * silently-wrong "complete" figure for the whole period. */
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly invalidJournalCount: number;
  readonly entryCount: number;
  readonly totalsByEventType: readonly FinanceStatementTypeTotal[];
  readonly entries: readonly FinanceStatementEntry[];
}

function bounded(value: number | undefined): number {
  const parsed = Number(value ?? FINANCE_STATEMENT_MAX_PAGE);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(FINANCE_STATEMENT_MAX_PAGE, Math.trunc(parsed))) : FINANCE_STATEMENT_MAX_PAGE;
}

function toEntry(journal: LedgerJournal): FinanceStatementEntry {
  return {
    journalId: journal.journalId,
    occurredAt: journal.occurredAt,
    eventType: journal.eventType,
    ...(journal.orderId ? {orderId: journal.orderId} : {}),
    ...(journal.actorId ? {actorId: journal.actorId} : {}),
    grossPaise: journal.debitTotalPaise,
    legs: journal.entries.map((entry) => ({accountId: entry.accountId, side: entry.side, amountPaise: entry.amountPaise})),
  };
}

function summarizeByEventType(journals: readonly LedgerJournal[]): FinanceStatementTypeTotal[] {
  const totals = new Map<LedgerEventType, {count: number; grossPaise: number}>();
  for (const journal of journals) {
    const current = totals.get(journal.eventType) ?? {count: 0, grossPaise: 0};
    current.count += 1;
    current.grossPaise += journal.debitTotalPaise;
    totals.set(journal.eventType, current);
  }
  return Array.from(totals.entries())
    .map(([eventType, value]) => ({eventType, count: value.count, grossPaise: value.grossPaise}))
    .sort((left, right) => right.grossPaise - left.grossPaise);
}

/**
 * A bounded, itemized slice of the immutable ledger for an explicit
 * [startAt, endAt) window - the same journals `occurredAt`-indexed read used
 * everywhere else in admin finance, just with an explicit range instead of
 * "most recent N". The caller (web admin) decides what a day/week/month/year
 * means in wall-clock terms and passes the resulting epoch boundaries; this
 * function only knows how to read a bounded, validated page in between them.
 */
export async function readFinanceStatement(
  token: DecodedIdToken,
  input: {startAt: number; endAt: number; limit?: number},
  database: FinanceStatementDatabase = db as unknown as FinanceStatementDatabase,
): Promise<FinanceStatement> {
  requirePlatformConfigAdminClaim(token);
  const limit = bounded(input.limit);
  // Fetch one extra row so `truncated` is authoritative without a separate count query.
  const snapshot = await database.ref(ADMIN_LEDGER_ROOT)
    .orderByChild("occurredAt")
    .startAt(input.startAt)
    .endAt(input.endAt - 1)
    .limitToFirst(limit + 1)
    .get();
  const raw = snapshot.val();
  const containerInvalid = raw !== null && raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw));
  const candidates = !containerInvalid && raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
  const journals: LedgerJournal[] = [];
  let invalidJournalCount = containerInvalid ? 1 : 0;
  for (const candidate of candidates) {
    try {
      validateLedgerJournal(candidate as LedgerJournal);
      journals.push(candidate as LedgerJournal);
    } catch {
      invalidJournalCount += 1;
    }
  }
  journals.sort((left, right) => right.occurredAt - left.occurredAt);
  const truncated = journals.length > limit;
  const bounded_ = truncated ? journals.slice(0, limit) : journals;
  if (invalidJournalCount > 0) {
    logger.error("FINANCE_STATEMENT_JOURNAL_VALIDATION_FAILED", {
      invalidJournalCount,
      startAt: input.startAt,
      endAt: input.endAt,
    });
  }
  return {
    scope: "bounded_period_journals",
    startAt: input.startAt,
    endAt: input.endAt,
    complete: !truncated && invalidJournalCount === 0,
    truncated,
    invalidJournalCount,
    entryCount: bounded_.length,
    totalsByEventType: summarizeByEventType(bounded_),
    entries: bounded_.map(toEntry),
  };
}
