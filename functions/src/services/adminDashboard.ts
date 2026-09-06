import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {db} from "../admin";
import {ROOT} from "../config";
import {validateLedgerJournal, type LedgerJournal} from "../domain/ledger";
import type {OperationalOrderProjection} from "../domain/operationalOrders";
import {requirePlatformConfigAdminClaim} from "./authz";
import {
  listActiveOperationalOrders,
  listRecentOperationalOrders,
} from "./operationalOrders";
import type {AdminDashboardQueryInput} from "../schemas";

export const ADMIN_LEDGER_MAX_PAGE = 250;
export const ADMIN_LEDGER_ROOT = `${ROOT}/private/financialLedger/journals`;
export const ADMIN_COD_EXPOSURE_MAX_PAGE = 100;
export const ADMIN_COD_EXPOSURE_ROOT = `${ROOT}/riderWallets`;

interface QuerySnapshot {
  val(): unknown;
}

interface QueryReference {
  orderByChild(child: string): QueryReference;
  startAt(value: string | number): QueryReference;
  limitToLast(limit: number): QueryReference;
  get(): Promise<QuerySnapshot>;
}

export interface AdminDashboardDatabase {
  ref(path: string): QueryReference;
}

export interface AdminFinanceSummary {
  readonly scope: "bounded_recent_journals";
  readonly complete: boolean;
  readonly journalCount: number;
  readonly invalidJournalCount: number;
  readonly oldestOccurredAt: number;
  readonly newestOccurredAt: number;
  readonly eventCounts: Readonly<Record<string, number>>;
  /** Signed movement in this bounded window: credit is positive, debit negative. */
  readonly windowNetMovementPaise: Readonly<Record<string, number>>;
}

export interface AdminRiderCodExposure {
  readonly riderId: string;
  readonly codOutstandingPaise: number;
  readonly codOutstandingLimitPaise: number;
  readonly codRemittanceReservedPaise: number;
  readonly availableToRemitPaise: number;
  readonly codBlocked: boolean;
}

export interface AdminCodExposureSummary {
  /** This is a descending, bounded window of wallets with a positive COD balance. */
  readonly scope: "bounded_positive_cod_exposure";
  /** True only when the complete positive-balance set fit in this window and every fetched row was valid. */
  readonly complete: boolean;
  /** True means additional positive-balance wallets exist outside this response. */
  readonly truncated: boolean;
  readonly riderCount: number;
  readonly invalidWalletCount: number;
  readonly riders: readonly AdminRiderCodExposure[];
}

function bounded(value: number): number {
  return Math.max(1, Math.min(ADMIN_LEDGER_MAX_PAGE, Math.trunc(value)));
}

function boundedCod(value: number | undefined): number {
  const parsed = Number(value ?? ADMIN_COD_EXPOSURE_MAX_PAGE);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(ADMIN_COD_EXPOSURE_MAX_PAGE, Math.trunc(parsed)))
    : ADMIN_COD_EXPOSURE_MAX_PAGE;
}

function safePaise(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePaiseFromRupees(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const paise = Math.round(value * 100);
  return Number.isSafeInteger(paise) && Math.abs(value * 100 - paise) <= 0.000_001 ? paise : null;
}

function safeRiderId(value: string): string | null {
  return value.length > 0 && value.length <= 128 && !/[.#$\/\[\]\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function parseRiderCodExposure(riderIdKey: string, value: unknown): AdminRiderCodExposure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const riderId = safeRiderId(riderIdKey);
  const codOutstandingPaise = safePaiseFromRupees(source.codOutstanding);
  const codOutstandingLimitPaise = safePaise(source.codOutstandingLimitPaise ?? 0);
  const codRemittanceReservedPaise = safePaise(source.codRemittanceReservedPaise ?? 0);
  if (!riderId || codOutstandingPaise === null || codOutstandingPaise <= 0 ||
      codOutstandingLimitPaise === null || codRemittanceReservedPaise === null ||
      codRemittanceReservedPaise > codOutstandingPaise ||
      (source.codBlocked !== undefined && typeof source.codBlocked !== "boolean")) return null;
  return {
    riderId,
    codOutstandingPaise,
    codOutstandingLimitPaise,
    codRemittanceReservedPaise,
    availableToRemitPaise: codOutstandingPaise - codRemittanceReservedPaise,
    codBlocked: source.codBlocked === true ||
      (codOutstandingLimitPaise > 0 && codOutstandingPaise >= codOutstandingLimitPaise),
  };
}

interface RecentJournalPage {
  journals: LedgerJournal[];
  invalidJournalCount: number;
}

function journalValues(value: unknown): RecentJournalPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {journals: [], invalidJournalCount: 0};
  }
  const valid: LedgerJournal[] = [];
  let invalidJournalCount = 0;
  for (const candidate of Object.values(value as Record<string, unknown>)) {
    try {
      validateLedgerJournal(candidate as LedgerJournal);
      valid.push(candidate as LedgerJournal);
    } catch {
      invalidJournalCount += 1;
    }
  }
  return {
    journals: valid.sort((left, right) => right.occurredAt - left.occurredAt),
    invalidJournalCount,
  };
}

export async function listRecentLedgerJournals(
  limit: number,
  database: AdminDashboardDatabase = db as unknown as AdminDashboardDatabase,
): Promise<LedgerJournal[]> {
  const snapshot = await database.ref(ADMIN_LEDGER_ROOT)
    .orderByChild("occurredAt")
    .limitToLast(bounded(limit))
    .get();
  return journalValues(snapshot.val()).journals;
}

async function readRecentLedgerPage(
  limit: number,
  database: AdminDashboardDatabase,
): Promise<RecentJournalPage> {
  const snapshot = await database.ref(ADMIN_LEDGER_ROOT)
    .orderByChild("occurredAt")
    .limitToLast(bounded(limit))
    .get();
  const page = journalValues(snapshot.val());
  if (page.invalidJournalCount > 0) {
    logger.error("ADMIN_FINANCE_JOURNAL_VALIDATION_FAILED", {
      invalidJournalCount: page.invalidJournalCount,
      requestedLimit: bounded(limit),
    });
  }
  return page;
}

async function readCodExposure(
  requestedLimit: number | undefined,
  database: AdminDashboardDatabase,
): Promise<AdminCodExposureSummary> {
  const limit = boundedCod(requestedLimit);
  // Fetch one extra row so `truncated` is authoritative without an unbounded count query.
  const snapshot = await database.ref(ADMIN_COD_EXPOSURE_ROOT)
    .orderByChild("codOutstanding")
    .startAt(0.01)
    .limitToLast(limit + 1)
    .get();
  const raw = snapshot.val();
  const containerInvalid = raw !== null && raw !== undefined &&
    (!raw || typeof raw !== "object" || Array.isArray(raw));
  const entries = !containerInvalid && raw && typeof raw === "object"
    ? Object.entries(raw as Record<string, unknown>)
    : [];
  const truncated = entries.length > limit;
  const riders: AdminRiderCodExposure[] = [];
  let invalidWalletCount = containerInvalid ? 1 : 0;
  for (const [riderId, value] of entries) {
    const parsed = parseRiderCodExposure(riderId, value);
    if (parsed) riders.push(parsed);
    else invalidWalletCount += 1;
  }
  riders.sort((left, right) =>
    right.codOutstandingPaise - left.codOutstandingPaise || left.riderId.localeCompare(right.riderId));
  const boundedRiders = riders.slice(0, limit);
  if (invalidWalletCount > 0) {
    logger.error("ADMIN_COD_EXPOSURE_VALIDATION_FAILED", {
      invalidWalletCount,
      requestedLimit: limit,
    });
  }
  return {
    scope: "bounded_positive_cod_exposure",
    complete: !truncated && invalidWalletCount === 0,
    truncated,
    riderCount: boundedRiders.length,
    invalidWalletCount,
    riders: boundedRiders,
  };
}

export function summarizeLedger(
  journals: readonly LedgerJournal[],
  invalidJournalCount = 0,
): AdminFinanceSummary {
  const windowNetMovementPaise: Record<string, number> = {};
  const eventCounts: Record<string, number> = {};
  for (const journal of journals) {
    eventCounts[journal.eventType] = (eventCounts[journal.eventType] ?? 0) + 1;
    for (const entry of journal.entries) {
      const signed = entry.side === "credit" ? entry.amountPaise : -entry.amountPaise;
      windowNetMovementPaise[entry.accountId] = (windowNetMovementPaise[entry.accountId] ?? 0) + signed;
    }
  }
  const occurred = journals.map((journal) => journal.occurredAt);
  return {
    scope: "bounded_recent_journals",
    complete: invalidJournalCount === 0,
    journalCount: journals.length,
    invalidJournalCount,
    oldestOccurredAt: occurred.length ? Math.min(...occurred) : 0,
    newestOccurredAt: occurred.length ? Math.max(...occurred) : 0,
    eventCounts,
    windowNetMovementPaise,
  };
}

function statusCounts(orders: readonly OperationalOrderProjection[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const order of orders) counts[order.status] = (counts[order.status] ?? 0) + 1;
  return counts;
}

/**
 * Returns only bounded, server-produced projections. The response deliberately
 * excludes addresses, phones, item notes and other customer-private order data.
 */
export async function readAdminDashboard(
  token: DecodedIdToken,
  input: AdminDashboardQueryInput,
  database: AdminDashboardDatabase = db as unknown as AdminDashboardDatabase,
): Promise<{
  generatedAt: number;
  scope: "bounded_operational_snapshot";
  activeOrders: OperationalOrderProjection[];
  recentOrders: OperationalOrderProjection[];
  statusCounts: Readonly<Record<string, number>>;
  finance: AdminFinanceSummary;
  codExposure: AdminCodExposureSummary;
}> {
  requirePlatformConfigAdminClaim(token);
  const [activeOrders, recentOrders, journalPage, codExposure] = await Promise.all([
    listActiveOperationalOrders(input.activeLimit),
    listRecentOperationalOrders(input.recentLimit),
    readRecentLedgerPage(input.ledgerLimit, database),
    readCodExposure(input.codLimit, database),
  ]);
  return {
    generatedAt: Date.now(),
    scope: "bounded_operational_snapshot",
    activeOrders,
    recentOrders,
    statusCounts: statusCounts([...activeOrders, ...recentOrders]),
    finance: summarizeLedger(journalPage.journals, journalPage.invalidJournalCount),
    codExposure,
  };
}
