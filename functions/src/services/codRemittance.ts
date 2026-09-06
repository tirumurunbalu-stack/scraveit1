import {randomUUID} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {db} from "../admin";
import {ROOT} from "../config";
import {platformConfigHash, platformConfigOperationKey} from "../domain/platformConfigControl";
import {DomainError} from "../errors";
import {
  recordCodRemittanceSchema,
  type RecordCodRemittanceInput,
} from "../schemas";
import {
  persistCodRemittanceLedger,
  type CodRemittanceJournalInput,
  type LedgerTransactionDatabase,
  type PersistedLedgerJournalResult,
} from "./ledger";
import {
  requirePlatformConfigAdminClaim,
  type PlatformConfigAdminRole,
} from "./authz";

type UnknownRecord = Record<string, unknown>;
type CodRemittanceStatus = "reserved" | "completed";
type CodRemittanceIdentityStatus = "registered" | "completed";

interface ValueSnapshot {
  val(): unknown;
}

interface TransactionResult {
  committed: boolean;
  snapshot: ValueSnapshot;
}

interface TransactionReference {
  transaction(
    update: (current: unknown) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<TransactionResult>;
}

export interface CodRemittanceDatabase extends LedgerTransactionDatabase {
  ref(path: string): TransactionReference;
}

interface CodRemittanceOperation {
  schemaVersion: 1;
  operationId: string;
  requestHash: string;
  requestInstanceId: string;
  actorId: string;
  actorRole: PlatformConfigAdminRole;
  riderId: string;
  amountPaise: number;
  method: RecordCodRemittanceInput["method"];
  referenceId?: string;
  status: CodRemittanceStatus;
  reservedAt: number;
  completedAt?: number;
  ledgerJournalId?: string;
}

interface CodRemittanceIdentity {
  schemaVersion: 1;
  operationId: string;
  requestHash: string;
  requestInstanceId: string;
  actorId: string;
  actorRole: PlatformConfigAdminRole;
  riderId: string;
  amountPaise: number;
  method: RecordCodRemittanceInput["method"];
  referenceId?: string;
  status: CodRemittanceIdentityStatus;
  registeredAt: number;
  completedAt?: number;
  ledgerJournalId?: string;
}

export interface CodRemittanceResponse {
  operationId: string;
  riderId: string;
  amountPaise: number;
  remainingOutstandingPaise: number;
  method: RecordCodRemittanceInput["method"];
  status: "completed";
  ledgerJournalId: string;
  completedAt: number;
  idempotent: boolean;
}

export type CodRemittanceLedgerWriter = (
  input: CodRemittanceJournalInput,
  database: LedgerTransactionDatabase,
) => Promise<PersistedLedgerJournalResult>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function safePaiseFromRupees(value: unknown): number {
  const rupees = Number(value ?? 0);
  const paise = Math.round(rupees * 100);
  if (!Number.isFinite(rupees) || !Number.isSafeInteger(paise) || paise < 0 ||
      Math.abs(rupees * 100 - paise) > 0.000_001) {
    throw new DomainError("failed-precondition", "The rider COD balance is invalid and requires finance review.", {
      reason: "COD_WALLET_BALANCE_INVALID",
    });
  }
  return paise;
}

function safeNonNegativePaise(value: unknown, reason: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DomainError("failed-precondition", "The rider COD reservation state requires finance review.", {reason});
  }
  return parsed;
}

function paiseToRupees(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("internal", "COD remittance produced an invalid balance.");
  }
  return Number((value / 100).toFixed(2));
}

function parseOperation(value: unknown): CodRemittanceOperation | null {
  const candidate = record(value);
  if (candidate.schemaVersion !== 1 || typeof candidate.operationId !== "string" ||
      typeof candidate.requestHash !== "string" || typeof candidate.requestInstanceId !== "string" ||
      typeof candidate.actorId !== "string" ||
      (candidate.actorRole !== "owner" && candidate.actorRole !== "ops_admin") ||
      typeof candidate.riderId !== "string" || !Number.isSafeInteger(candidate.amountPaise) ||
      !["cash_deposit", "bank_transfer", "upi"].includes(String(candidate.method)) ||
      (candidate.status !== "reserved" && candidate.status !== "completed") ||
      !Number.isSafeInteger(candidate.reservedAt)) return null;
  if (candidate.referenceId !== undefined && typeof candidate.referenceId !== "string") return null;
  if (candidate.completedAt !== undefined && !Number.isSafeInteger(candidate.completedAt)) return null;
  if (candidate.ledgerJournalId !== undefined && typeof candidate.ledgerJournalId !== "string") return null;
  return candidate as unknown as CodRemittanceOperation;
}

function parseIdentity(value: unknown): CodRemittanceIdentity | null {
  const candidate = record(value);
  if (candidate.schemaVersion !== 1 || typeof candidate.operationId !== "string" ||
      typeof candidate.requestHash !== "string" || typeof candidate.requestInstanceId !== "string" ||
      typeof candidate.actorId !== "string" ||
      (candidate.actorRole !== "owner" && candidate.actorRole !== "ops_admin") ||
      typeof candidate.riderId !== "string" || !Number.isSafeInteger(candidate.amountPaise) ||
      !["cash_deposit", "bank_transfer", "upi"].includes(String(candidate.method)) ||
      (candidate.status !== "registered" && candidate.status !== "completed") ||
      !Number.isSafeInteger(candidate.registeredAt)) return null;
  if (candidate.referenceId !== undefined && typeof candidate.referenceId !== "string") return null;
  if (candidate.completedAt !== undefined && !Number.isSafeInteger(candidate.completedAt)) return null;
  if (candidate.ledgerJournalId !== undefined && typeof candidate.ledgerJournalId !== "string") return null;
  return candidate as unknown as CodRemittanceIdentity;
}

function parseInput(rawInput: unknown): RecordCodRemittanceInput {
  const parsed = recordCodRemittanceSchema.safeParse(rawInput);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ").slice(0, 500);
    throw new DomainError("invalid-argument", message || "Invalid COD remittance request.");
  }
  return parsed.data;
}

function requestHash(input: RecordCodRemittanceInput): string {
  return platformConfigHash({
    operationId: input.operationId,
    riderId: input.riderId,
    amountPaise: input.amountPaise,
    method: input.method,
    referenceId: input.referenceId ?? null,
  });
}

function operationMatches(
  operation: Pick<CodRemittanceOperation, "operationId" | "requestHash" | "actorId" | "riderId">,
  input: RecordCodRemittanceInput,
  hash: string,
  actorId: string,
): boolean {
  return operation.operationId === input.operationId && operation.requestHash === hash &&
    operation.actorId === actorId && operation.riderId === input.riderId;
}

function identityOrConflict(
  raw: unknown,
  input: RecordCodRemittanceInput,
  hash: string,
  actorId: string,
): CodRemittanceIdentity | null {
  if (raw === null || raw === undefined) return null;
  const existing = parseIdentity(raw);
  if (!existing) {
    throw new DomainError("data-loss", "The COD remittance identity record is invalid.", {
      reason: "COD_REMITTANCE_IDENTITY_INVALID",
    });
  }
  if (!operationMatches(existing, input, hash, actorId)) {
    throw new DomainError("already-exists", "Operation id was already used for a different COD remittance.", {
      reason: "COD_REMITTANCE_OPERATION_CONFLICT",
    });
  }
  return existing;
}

function operationOrConflict(
  raw: unknown,
  input: RecordCodRemittanceInput,
  hash: string,
  actorId: string,
): CodRemittanceOperation | null {
  if (raw === null || raw === undefined) return null;
  const existing = parseOperation(raw);
  if (!existing) {
    throw new DomainError("data-loss", "The COD remittance operation record is invalid.", {
      reason: "COD_REMITTANCE_OPERATION_INVALID",
    });
  }
  if (!operationMatches(existing, input, hash, actorId)) {
    throw new DomainError("already-exists", "Operation id was already used for a different COD remittance.", {
      reason: "COD_REMITTANCE_OPERATION_CONFLICT",
    });
  }
  return existing;
}

function defaultDatabase(): CodRemittanceDatabase {
  return db as unknown as CodRemittanceDatabase;
}

function operationPath(input: RecordCodRemittanceInput): string {
  return `${ROOT}/riderWallets/${input.riderId}`;
}

function identityPath(operationKey: string): string {
  return `${ROOT}/private/financeOperations/codRemittances/${operationKey}`;
}

async function registerRemittanceIdentity(
  database: CodRemittanceDatabase,
  input: RecordCodRemittanceInput,
  actorId: string,
  actorRole: PlatformConfigAdminRole,
  hash: string,
  operationKey: string,
  requestInstanceId: string,
  now: number,
): Promise<CodRemittanceIdentity> {
  let abort: DomainError | null = null;
  const result = await database.ref(identityPath(operationKey)).transaction((rawIdentity) => {
    abort = null;
    let existing: CodRemittanceIdentity | null;
    try {
      existing = identityOrConflict(rawIdentity, input, hash, actorId);
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("internal", "COD remittance identity could not be verified.");
      return undefined;
    }
    if (existing) return existing;
    const identity: CodRemittanceIdentity = {
      schemaVersion: 1,
      operationId: input.operationId,
      requestHash: hash,
      requestInstanceId,
      actorId,
      actorRole,
      riderId: input.riderId,
      amountPaise: input.amountPaise,
      method: input.method,
      ...(input.referenceId ? {referenceId: input.referenceId} : {}),
      status: "registered",
      registeredAt: now,
    };
    return identity;
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "COD remittance identity could not be registered safely.");
  }
  const identity = identityOrConflict(result.snapshot.val(), input, hash, actorId);
  if (!identity) throw new DomainError("internal", "COD remittance identity could not be verified.");
  return identity;
}

async function completeRemittanceIdentity(
  database: CodRemittanceDatabase,
  identity: CodRemittanceIdentity,
  input: RecordCodRemittanceInput,
  actorId: string,
  hash: string,
  operationKey: string,
  ledgerJournalId: string,
  completedAt: number,
): Promise<void> {
  let abort: DomainError | null = null;
  const result = await database.ref(identityPath(operationKey)).transaction((rawIdentity) => {
    abort = null;
    let existing: CodRemittanceIdentity | null;
    try {
      existing = identityOrConflict(rawIdentity, input, hash, actorId);
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("internal", "COD remittance identity could not be verified.");
      return undefined;
    }
    if (!existing) {
      abort = new DomainError("not-found", "COD remittance identity was not found.");
      return undefined;
    }
    if (existing.status === "completed" && existing.ledgerJournalId !== ledgerJournalId) {
      abort = new DomainError("data-loss", "COD remittance identity has a different immutable ledger journal.");
      return undefined;
    }
    if (existing.status === "completed") return existing;
    return {...identity, status: "completed", ledgerJournalId, completedAt};
  }, undefined, false);
  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "COD remittance identity could not be completed safely.");
  }
  const completed = identityOrConflict(result.snapshot.val(), input, hash, actorId);
  if (!completed || completed.status !== "completed" || completed.ledgerJournalId !== ledgerJournalId) {
    throw new DomainError("internal", "COD remittance identity completion could not be verified.");
  }
}

async function reserveRemittance(
  database: CodRemittanceDatabase,
  input: RecordCodRemittanceInput,
  actorId: string,
  actorRole: PlatformConfigAdminRole,
  hash: string,
  operationKey: string,
  requestInstanceId: string,
  now: number,
): Promise<CodRemittanceOperation> {
  let abort: DomainError | null = null;
  const result = await database.ref(operationPath(input)).transaction((rawWallet) => {
    abort = null;
    const wallet = record(rawWallet);
    const operations = record(wallet.codRemittanceOperations);
    let existing: CodRemittanceOperation | null;
    try {
      existing = operationOrConflict(operations[operationKey], input, hash, actorId);
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("internal", "COD remittance could not be verified.");
      return undefined;
    }
    if (existing) return wallet;

    let outstandingPaise: number;
    let reservedPaise: number;
    try {
      outstandingPaise = safePaiseFromRupees(wallet.codOutstanding);
      reservedPaise = safeNonNegativePaise(
        wallet.codRemittanceReservedPaise,
        "COD_REMITTANCE_RESERVATION_INVALID",
      );
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("internal", "COD remittance could not be reserved.");
      return undefined;
    }
    const availablePaise = outstandingPaise - reservedPaise;
    if (!Number.isSafeInteger(availablePaise) || availablePaise < 0) {
      abort = new DomainError("failed-precondition", "The rider COD reservation state requires finance review.", {
        reason: "COD_REMITTANCE_RESERVATION_EXCEEDS_BALANCE",
      });
      return undefined;
    }
    if (input.amountPaise > availablePaise) {
      abort = new DomainError("failed-precondition", "Remittance exceeds the rider's available COD outstanding balance.", {
        reason: "COD_REMITTANCE_EXCEEDS_OUTSTANDING",
        outstandingPaise,
        reservedPaise,
        availablePaise,
      });
      return undefined;
    }
    const nextReservedPaise = reservedPaise + input.amountPaise;
    if (!Number.isSafeInteger(nextReservedPaise)) {
      abort = new DomainError("out-of-range", "COD remittance reservation is too large.");
      return undefined;
    }
    const operation: CodRemittanceOperation = {
      schemaVersion: 1,
      operationId: input.operationId,
      requestHash: hash,
      requestInstanceId,
      actorId,
      actorRole,
      riderId: input.riderId,
      amountPaise: input.amountPaise,
      method: input.method,
      ...(input.referenceId ? {referenceId: input.referenceId} : {}),
      status: "reserved",
      reservedAt: now,
    };
    return {
      ...wallet,
      codRemittanceReservedPaise: nextReservedPaise,
      codRemittanceOperations: {...operations, [operationKey]: operation},
      updatedAt: now,
    };
  }, undefined, false);

  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "COD remittance reservation could not be committed safely.");
  }
  const wallet = record(result.snapshot.val());
  const operation = operationOrConflict(
    record(wallet.codRemittanceOperations)[operationKey],
    input,
    hash,
    actorId,
  );
  if (!operation) throw new DomainError("internal", "COD remittance reservation could not be verified.");
  return operation;
}

async function finalizeRemittance(
  database: CodRemittanceDatabase,
  input: RecordCodRemittanceInput,
  actorId: string,
  hash: string,
  operationKey: string,
  ledger: PersistedLedgerJournalResult,
  now: number,
): Promise<{operation: CodRemittanceOperation; remainingOutstandingPaise: number}> {
  let abort: DomainError | null = null;
  let remainingOutstandingPaise = -1;
  const result = await database.ref(operationPath(input)).transaction((rawWallet) => {
    abort = null;
    const wallet = record(rawWallet);
    const operations = record(wallet.codRemittanceOperations);
    let existing: CodRemittanceOperation | null;
    try {
      existing = operationOrConflict(operations[operationKey], input, hash, actorId);
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("internal", "COD remittance could not be verified.");
      return undefined;
    }
    if (!existing) {
      abort = new DomainError("not-found", "COD remittance reservation was not found.");
      return undefined;
    }
    if (existing.status === "completed") {
      if (existing.ledgerJournalId !== ledger.journal.journalId) {
        abort = new DomainError("data-loss", "COD remittance ledger identity does not match the completed operation.");
        return undefined;
      }
      remainingOutstandingPaise = safePaiseFromRupees(wallet.codOutstanding);
      return wallet;
    }

    let outstandingPaise: number;
    let reservedPaise: number;
    try {
      outstandingPaise = safePaiseFromRupees(wallet.codOutstanding);
      reservedPaise = safeNonNegativePaise(
        wallet.codRemittanceReservedPaise,
        "COD_REMITTANCE_RESERVATION_INVALID",
      );
    } catch (error) {
      abort = error instanceof DomainError ? error : new DomainError("internal", "COD remittance could not be finalized.");
      return undefined;
    }
    if (outstandingPaise < input.amountPaise || reservedPaise < input.amountPaise) {
      abort = new DomainError("failed-precondition", "The rider COD balance changed incompatibly during settlement.", {
        reason: "COD_REMITTANCE_FINALIZATION_CONFLICT",
      });
      return undefined;
    }
    remainingOutstandingPaise = outstandingPaise - input.amountPaise;
    const nextReservedPaise = reservedPaise - input.amountPaise;
    const limitPaise = safeNonNegativePaise(wallet.codOutstandingLimitPaise, "COD_LIMIT_INVALID");
    const completed: CodRemittanceOperation = {
      ...existing,
      status: "completed",
      completedAt: now,
      ledgerJournalId: ledger.journal.journalId,
    };
    return {
      ...wallet,
      codOutstanding: paiseToRupees(remainingOutstandingPaise),
      codRemittanceReservedPaise: nextReservedPaise,
      codBlocked: limitPaise > 0 && remainingOutstandingPaise >= limitPaise,
      codRemittanceOperations: {...operations, [operationKey]: completed},
      updatedAt: now,
    };
  }, undefined, false);

  if (!result.committed) {
    throw abort ?? new DomainError("aborted", "COD remittance finalization could not be committed safely.");
  }
  const wallet = record(result.snapshot.val());
  const operation = operationOrConflict(
    record(wallet.codRemittanceOperations)[operationKey],
    input,
    hash,
    actorId,
  );
  if (!operation || operation.status !== "completed" || operation.ledgerJournalId !== ledger.journal.journalId) {
    throw new DomainError("internal", "COD remittance completion could not be verified.");
  }
  if (remainingOutstandingPaise < 0) remainingOutstandingPaise = safePaiseFromRupees(wallet.codOutstanding);
  return {operation, remainingOutstandingPaise};
}

/**
 * Reserves COD against the rider wallet, appends the deterministic immutable
 * journal, then finalizes the mutable compatibility projection. If execution
 * stops between phases, retrying the exact operation id resumes from the
 * stored reservation. A different payload/actor can never reuse that id.
 */
export async function recordRiderCodRemittance(
  actorId: string,
  token: DecodedIdToken,
  rawInput: unknown,
  database: CodRemittanceDatabase = defaultDatabase(),
  now = Date.now(),
  writeLedger: CodRemittanceLedgerWriter = persistCodRemittanceLedger,
): Promise<CodRemittanceResponse> {
  const actorRole = requirePlatformConfigAdminClaim(token);
  const input = parseInput(rawInput);
  const hash = requestHash(input);
  const operationKey = platformConfigOperationKey(input.operationId);
  const requestInstanceId = randomUUID();
  const identity = await registerRemittanceIdentity(
    database,
    input,
    actorId,
    actorRole,
    hash,
    operationKey,
    requestInstanceId,
    now,
  );
  const reserved = await reserveRemittance(
    database,
    input,
    actorId,
    actorRole,
    hash,
    operationKey,
    identity.requestInstanceId,
    identity.registeredAt,
  );

  let ledger: PersistedLedgerJournalResult;
  try {
    ledger = await writeLedger({
      remittanceId: input.operationId,
      riderId: input.riderId,
      amountPaise: input.amountPaise,
      occurredAt: reserved.reservedAt,
      actorId,
      method: input.method,
      ...(input.referenceId ? {referenceId: input.referenceId} : {}),
    }, database);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const ledgerCode = error instanceof Error ? error.message : "UNKNOWN_LEDGER_FAILURE";
    if ([
      "LEDGER_IMMUTABLE_CONFLICT",
      "LEDGER_INVALID_OR_TAMPERED_JOURNAL",
      "LEDGER_JOURNAL_ID_MISMATCH",
    ].includes(ledgerCode)) {
      throw new DomainError(
        "data-loss",
        "COD remittance conflicts with existing immutable ledger evidence. Finance review is required.",
        {reason: "COD_REMITTANCE_LEDGER_CONFLICT", operationId: input.operationId},
      );
    }
    throw new DomainError(
      "unavailable",
      "COD remittance was reserved but its immutable ledger entry is pending. Retry the exact operation id.",
      {reason: "COD_REMITTANCE_LEDGER_PENDING", operationId: input.operationId},
    );
  }

  const finalized = await finalizeRemittance(
    database,
    input,
    actorId,
    hash,
    operationKey,
    ledger,
    now,
  );
  await completeRemittanceIdentity(
    database,
    identity,
    input,
    actorId,
    hash,
    operationKey,
    ledger.journal.journalId,
    finalized.operation.completedAt ?? now,
  );
  const auditId = `cod-remittance-${operationKey.slice(0, 40)}`;
  const auditRecord = {
    id: auditId,
    action: "rider_cod.remittance_recorded",
    target: `riderWallets/${input.riderId}`.slice(0, 200),
    detail: `${input.method}; ${input.amountPaise} paise; remaining ${finalized.remainingOutstandingPaise} paise`,
    actorId,
    actorEmail: String(token.email ?? "").slice(0, 254),
    actorRole,
    at: finalized.operation.completedAt ?? now,
  };
  await database.ref(`${ROOT}/audit/${auditId}`).transaction((current) => current ?? auditRecord, undefined, false);

  return {
    operationId: input.operationId,
    riderId: input.riderId,
    amountPaise: input.amountPaise,
    remainingOutstandingPaise: finalized.remainingOutstandingPaise,
    method: input.method,
    status: "completed",
    ledgerJournalId: ledger.journal.journalId,
    completedAt: finalized.operation.completedAt ?? now,
    idempotent: identity.requestInstanceId !== requestInstanceId ||
      reserved.requestInstanceId !== requestInstanceId || ledger.outcome === "idempotent",
  };
}
