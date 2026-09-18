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

/**
 * The same period's money, regrouped by who it belongs to instead of by
 * event type - "how much of this is the restaurant's, the rider's, mine" -
 * which is what an operator actually wants from a bank-statement view, not a
 * list of internal event names.
 */
export interface FinanceStatementAllocation {
  readonly restaurantPaise: number;
  readonly riderPaise: number;
  readonly platformPaise: number;
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
  readonly allocation: FinanceStatementAllocation;
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

const RESTAURANT_PAYABLE_PREFIX = "liability:restaurant-payable:";
const RIDER_EARNINGS_PREFIX = "liability:rider-earnings:";
const RIDER_TIPS_PREFIX = "liability:rider-tips:";
const REVENUE_PREFIX = "revenue:";
const EXPENSE_PREFIX = "expense:";

/**
 * Regroups a period's journals by who the money belongs to, straight from the
 * account IDs every posting already carries - no new bookkeeping, just a
 * different lens on the same double-entry legs `totalsByEventType` already
 * summarizes by event name.
 *
 * Every order-delivery journal (`cod_delivery`/`payment`) credits exactly
 * one of `liability:restaurant-payable:<id>`, `liability:rider-earnings:<id>`,
 * `liability:rider-tips:<id>` and the platform's own `revenue:*` accounts in
 * the same balanced entry (see `allocationCredits` in `services/ledger.ts`) -
 * so summing those credits across the period answers "how much did each
 * party earn from what was delivered here" directly and unambiguously.
 *
 * A genuine settlement run (`restaurant_payable`/`rider_payout` event types)
 * later *debits* that same liability account to clear it when the money
 * actually leaves the platform - that debit is added too, because it is
 * real money reaching that party, just through a different kind of journal.
 * A debit from any other event type (for example an explicit refund
 * clawback) is deliberately left out rather than guessed at: this statement
 * only reports movements it can name with certainty, not net a liability
 * balance across dissimilar event types.
 *
 * Platform revenue nets `revenue:*` credits against `expense:*` debits (rider
 * reward campaigns are funded from an expense account, per
 * `buildRiderIncentiveJournal`/`buildReferralRewardJournal`), so the figure
 * is commission and fees earned minus what the platform actually spent on
 * rider rewards in the same period - not a full profit-and-loss statement,
 * since costs outside this ledger (infrastructure, payroll, ...) play no
 * part in it.
 */
function summarizeAllocation(journals: readonly LedgerJournal[]): FinanceStatementAllocation {
  let restaurantPaise = 0;
  let riderPaise = 0;
  let platformPaise = 0;
  for (const journal of journals) {
    for (const entry of journal.entries) {
      const isRestaurantPayable = entry.accountId.startsWith(RESTAURANT_PAYABLE_PREFIX);
      const isRiderPayable = entry.accountId.startsWith(RIDER_EARNINGS_PREFIX) || entry.accountId.startsWith(RIDER_TIPS_PREFIX);
      if (entry.side === "credit") {
        if (isRestaurantPayable) restaurantPaise += entry.amountPaise;
        else if (isRiderPayable) riderPaise += entry.amountPaise;
        else if (entry.accountId.startsWith(REVENUE_PREFIX)) platformPaise += entry.amountPaise;
      } else {
        if (isRestaurantPayable && journal.eventType === "restaurant_payable") restaurantPaise += entry.amountPaise;
        else if (isRiderPayable && journal.eventType === "rider_payout") riderPaise += entry.amountPaise;
        else if (entry.accountId.startsWith(EXPENSE_PREFIX)) platformPaise -= entry.amountPaise;
      }
    }
  }
  return {restaurantPaise, riderPaise, platformPaise};
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
    allocation: summarizeAllocation(bounded_),
    entries: bounded_.map(toEntry),
  };
}
