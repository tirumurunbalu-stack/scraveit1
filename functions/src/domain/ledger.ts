import {createHash} from "node:crypto";

export const LEDGER_CURRENCY = "INR" as const;

export const LEDGER_EVENT_TYPES = [
  "cod_delivery",
  "cod_collection",
  "cod_remittance",
  "restaurant_payable",
  "platform_commission",
  "platform_fee",
  "rider_earning",
  "rider_incentive",
  "rider_referral_reward",
  "rider_payout",
  "rider_tip",
  "payment",
  "refund",
  "adjustment",
] as const;

export type LedgerEventType = typeof LEDGER_EVENT_TYPES[number];
export type LedgerSide = "debit" | "credit";
export type LedgerMetadataValue = string | number | boolean | null;
export type LedgerMetadata = Readonly<Record<string, LedgerMetadataValue>>;

export interface LedgerPostingInput {
  accountId: string;
  side: LedgerSide;
  amountPaise: number;
  memo?: string;
}

export interface LedgerJournalInput {
  eventType: LedgerEventType;
  eventId: string;
  occurredAt: number;
  postings: readonly LedgerPostingInput[];
  orderId?: string;
  actorId?: string;
  metadata?: LedgerMetadata;
}

export interface LedgerEntry {
  readonly entryId: string;
  readonly journalId: string;
  readonly accountId: string;
  readonly side: LedgerSide;
  readonly amountPaise: number;
  readonly currency: typeof LEDGER_CURRENCY;
  readonly memo?: string;
}

export interface LedgerJournal {
  readonly schemaVersion: 1;
  readonly journalId: string;
  readonly eventType: LedgerEventType;
  readonly eventId: string;
  readonly occurredAt: number;
  readonly currency: typeof LEDGER_CURRENCY;
  readonly orderId?: string;
  readonly actorId?: string;
  readonly metadata: LedgerMetadata;
  readonly entries: readonly LedgerEntry[];
  readonly debitTotalPaise: number;
  readonly creditTotalPaise: number;
  readonly fingerprint: string;
}

export type ImmutableJournalWrite =
  | {readonly outcome: "insert"; readonly journal: LedgerJournal}
  | {readonly outcome: "idempotent"; readonly journal: LedgerJournal};

const eventTypes = new Set<string>(LEDGER_EVENT_TYPES);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

function fail(code: string): never {
  throw new Error(code);
}

function requireIdentifier(value: string, code: string): string {
  const normalized = String(value ?? "").trim();
  if (!identifierPattern.test(normalized)) fail(code);
  return normalized;
}

function requireOptionalIdentifier(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  return requireIdentifier(value, code);
}

function requirePaise(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("LEDGER_INVALID_AMOUNT_PAISE");
  return value;
}

function addPaise(total: number, amount: number): number {
  const result = total + amount;
  if (!Number.isSafeInteger(result)) fail("LEDGER_TOTAL_OVERFLOW");
  return result;
}

function normalizeMemo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 300) fail("LEDGER_INVALID_MEMO");
  return normalized;
}

function normalizeMetadata(metadata: LedgerMetadata | undefined): LedgerMetadata {
  if (metadata === undefined) return Object.freeze({});
  if (Object.getPrototypeOf(metadata) !== Object.prototype && Object.getPrototypeOf(metadata) !== null) {
    fail("LEDGER_INVALID_METADATA");
  }
  const normalized: Record<string, LedgerMetadataValue> = {};
  for (const key of Object.keys(metadata).sort()) {
    if (!identifierPattern.test(key)) fail("LEDGER_INVALID_METADATA_KEY");
    const value = metadata[key];
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      fail("LEDGER_INVALID_METADATA_VALUE");
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      fail("LEDGER_INVALID_METADATA_VALUE");
    }
    if (typeof value === "string" && value.length > 500) fail("LEDGER_INVALID_METADATA_VALUE");
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function postingSortKey(posting: Omit<LedgerPostingInput, "memo"> & {memo?: string}): string {
  return canonicalize([posting.accountId, posting.side, posting.amountPaise, posting.memo ?? ""]);
}

function immutableBody(journal: Omit<LedgerJournal, "fingerprint">): unknown {
  return {
    schemaVersion: journal.schemaVersion,
    journalId: journal.journalId,
    eventType: journal.eventType,
    eventId: journal.eventId,
    occurredAt: journal.occurredAt,
    currency: journal.currency,
    orderId: journal.orderId ?? null,
    actorId: journal.actorId ?? null,
    metadata: journal.metadata,
    entries: journal.entries.map((entry) => ({
      entryId: entry.entryId,
      journalId: entry.journalId,
      accountId: entry.accountId,
      side: entry.side,
      amountPaise: entry.amountPaise,
      currency: entry.currency,
      memo: entry.memo ?? null,
    })),
    debitTotalPaise: journal.debitTotalPaise,
    creditTotalPaise: journal.creditTotalPaise,
  };
}

export function deterministicJournalId(eventType: LedgerEventType, eventId: string): string {
  if (!eventTypes.has(eventType)) fail("LEDGER_UNSUPPORTED_EVENT_TYPE");
  const normalizedEventId = requireIdentifier(eventId, "LEDGER_INVALID_EVENT_ID");
  return `lj_${hash(`ledger:v1:${eventType}:${normalizedEventId}`).slice(0, 40)}`;
}

export function deterministicEntryId(journalId: string, index: number): string {
  const normalizedJournalId = requireIdentifier(journalId, "LEDGER_INVALID_JOURNAL_ID");
  if (!Number.isSafeInteger(index) || index < 0) fail("LEDGER_INVALID_ENTRY_INDEX");
  return `le_${hash(`entry:v1:${normalizedJournalId}:${index}`).slice(0, 40)}`;
}

export function createLedgerJournal(input: LedgerJournalInput): LedgerJournal {
  if (!eventTypes.has(input.eventType)) fail("LEDGER_UNSUPPORTED_EVENT_TYPE");
  const eventId = requireIdentifier(input.eventId, "LEDGER_INVALID_EVENT_ID");
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt <= 0) fail("LEDGER_INVALID_OCCURRED_AT");
  if (!Array.isArray(input.postings) || input.postings.length < 2 || input.postings.length > 100) {
    fail("LEDGER_INVALID_POSTING_COUNT");
  }

  const journalId = deterministicJournalId(input.eventType, eventId);
  const normalizedPostings = input.postings.map((posting) => {
    if (posting.side !== "debit" && posting.side !== "credit") fail("LEDGER_INVALID_SIDE");
    return {
      accountId: requireIdentifier(posting.accountId, "LEDGER_INVALID_ACCOUNT_ID"),
      side: posting.side,
      amountPaise: requirePaise(posting.amountPaise),
      memo: normalizeMemo(posting.memo),
    };
  }).sort((left, right) => postingSortKey(left).localeCompare(postingSortKey(right)));

  let debitTotalPaise = 0;
  let creditTotalPaise = 0;
  const entries = normalizedPostings.map((posting, index): LedgerEntry => {
    if (posting.side === "debit") debitTotalPaise = addPaise(debitTotalPaise, posting.amountPaise);
    else creditTotalPaise = addPaise(creditTotalPaise, posting.amountPaise);
    return Object.freeze({
      entryId: deterministicEntryId(journalId, index),
      journalId,
      accountId: posting.accountId,
      side: posting.side,
      amountPaise: posting.amountPaise,
      currency: LEDGER_CURRENCY,
      ...(posting.memo === undefined ? {} : {memo: posting.memo}),
    });
  });

  if (debitTotalPaise !== creditTotalPaise) fail("LEDGER_UNBALANCED_JOURNAL");
  if (debitTotalPaise <= 0) fail("LEDGER_EMPTY_JOURNAL");

  const body: Omit<LedgerJournal, "fingerprint"> = {
    schemaVersion: 1,
    journalId,
    eventType: input.eventType,
    eventId,
    occurredAt: input.occurredAt,
    currency: LEDGER_CURRENCY,
    ...(requireOptionalIdentifier(input.orderId, "LEDGER_INVALID_ORDER_ID") === undefined ? {} : {orderId: requireOptionalIdentifier(input.orderId, "LEDGER_INVALID_ORDER_ID")}),
    ...(requireOptionalIdentifier(input.actorId, "LEDGER_INVALID_ACTOR_ID") === undefined ? {} : {actorId: requireOptionalIdentifier(input.actorId, "LEDGER_INVALID_ACTOR_ID")}),
    metadata: normalizeMetadata(input.metadata),
    entries: Object.freeze(entries),
    debitTotalPaise,
    creditTotalPaise,
  };
  const fingerprint = hash(canonicalize(immutableBody(body)));
  return Object.freeze({...body, fingerprint});
}

export function validateLedgerJournal(journal: LedgerJournal): void {
  const rebuilt = createLedgerJournal({
    eventType: journal.eventType,
    eventId: journal.eventId,
    occurredAt: journal.occurredAt,
    orderId: journal.orderId,
    actorId: journal.actorId,
    metadata: journal.metadata,
    postings: journal.entries.map((entry) => ({
      accountId: entry.accountId,
      side: entry.side,
      amountPaise: entry.amountPaise,
      memo: entry.memo,
    })),
  });
  if (canonicalize(journal) !== canonicalize(rebuilt)) fail("LEDGER_INVALID_OR_TAMPERED_JOURNAL");
}

export function ledgerJournalsEqual(left: LedgerJournal, right: LedgerJournal): boolean {
  validateLedgerJournal(left);
  validateLedgerJournal(right);
  return left.journalId === right.journalId && left.fingerprint === right.fingerprint &&
    canonicalize(left) === canonicalize(right);
}

export function resolveImmutableJournalWrite(
  existing: LedgerJournal | null | undefined,
  candidate: LedgerJournal,
): ImmutableJournalWrite {
  validateLedgerJournal(candidate);
  if (!existing) return {outcome: "insert", journal: candidate};
  validateLedgerJournal(existing);
  if (existing.journalId !== candidate.journalId) fail("LEDGER_JOURNAL_ID_MISMATCH");
  if (!ledgerJournalsEqual(existing, candidate)) fail("LEDGER_IMMUTABLE_CONFLICT");
  return {outcome: "idempotent", journal: existing};
}
