import type {DecodedIdToken} from "firebase-admin/auth";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }}}));

import {ROOT} from "../src/config";
import {platformConfigOperationKey} from "../src/domain/platformConfigControl";
import {
  recordRiderCodRemittance,
  type CodRemittanceDatabase,
  type CodRemittanceLedgerWriter,
} from "../src/services/codRemittance";
import {persistCodRemittanceLedger, type LedgerTransactionResult} from "../src/services/ledger";

class InMemoryDatabase implements CodRemittanceDatabase {
  readonly values = new Map<string, unknown>();
  readonly transactions: string[] = [];

  ref(path: string) {
    return {
      transaction: async (update: (current: unknown) => unknown): Promise<LedgerTransactionResult> => {
        this.transactions.push(path);
        const next = update(this.values.get(path) ?? null);
        if (next === undefined) {
          return {committed: false, snapshot: {val: () => this.values.get(path) ?? null}};
        }
        this.values.set(path, structuredClone(next));
        return {committed: true, snapshot: {val: () => structuredClone(this.values.get(path) ?? null)}};
      },
    };
  }
}

function token(role?: string, email = "operator@example.test"): DecodedIdToken {
  return {savrivoRole: role, email} as unknown as DecodedIdToken;
}

const input = {
  operationId: "cod-remit-20260824-0001",
  riderId: "rider-1",
  amountPaise: 6_000,
  method: "upi" as const,
  referenceId: "UTR-20260824-0001",
};

function wallet(database: InMemoryDatabase): Record<string, unknown> {
  return database.values.get(`${ROOT}/riderWallets/${input.riderId}`) as Record<string, unknown>;
}

function seedWallet(database: InMemoryDatabase, outstandingRupees = 100): void {
  database.values.set(`${ROOT}/riderWallets/${input.riderId}`, {
    codOutstanding: outstandingRupees,
    codOutstandingLimitPaise: 8_000,
    codBlocked: true,
    codEntries: {"order-1": {amount: outstandingRupees, status: "pending_return"}},
  });
}

describe("COD remittance control plane", () => {
  it("requires a verified owner or operations-admin custom claim", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    await expect(recordRiderCodRemittance("legacy-admin", token(undefined), input, database, 1_000))
      .rejects.toMatchObject({code: "permission-denied"});
    await expect(recordRiderCodRemittance("legacy-admin", token(undefined, "legacy-owner@example.test"), input, database, 1_000))
      .rejects.toMatchObject({code: "permission-denied"});
    expect(database.transactions).toEqual([]);
  });

  it.each(["owner", "ops_admin"])("records a balanced remittance for a %s claim", async (role) => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    const result = await recordRiderCodRemittance("admin-1", token(role), input, database, 2_000);
    expect(result).toMatchObject({
      operationId: input.operationId,
      amountPaise: 6_000,
      remainingOutstandingPaise: 4_000,
      status: "completed",
      idempotent: false,
    });
    expect(wallet(database)).toMatchObject({
      codOutstanding: 40,
      codRemittanceReservedPaise: 0,
      codBlocked: false,
    });
    expect(result.ledgerJournalId).toMatch(/^lj_[a-f0-9]{40}$/);
  });

  it("makes an exact retry idempotent without reducing the wallet twice", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    const first = await recordRiderCodRemittance("admin-1", token("owner"), input, database, 2_000);
    const retry = await recordRiderCodRemittance("admin-1", token("owner"), input, database, 9_000);
    expect(retry).toMatchObject({
      idempotent: true,
      remainingOutstandingPaise: 4_000,
      ledgerJournalId: first.ledgerJournalId,
      completedAt: 2_000,
    });
    expect(wallet(database).codOutstanding).toBe(40);
  });

  it("rejects changed-payload or changed-actor reuse of an operation id", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    await recordRiderCodRemittance("admin-1", token("owner"), input, database, 2_000);
    await expect(recordRiderCodRemittance("admin-1", token("owner"), {
      ...input,
      amountPaise: 5_000,
    }, database, 3_000)).rejects.toMatchObject({code: "already-exists"});
    await expect(recordRiderCodRemittance("admin-2", token("ops_admin"), input, database, 3_000))
      .rejects.toMatchObject({code: "already-exists"});
    database.values.set(`${ROOT}/riderWallets/rider-2`, {codOutstanding: 100});
    await expect(recordRiderCodRemittance("admin-1", token("owner"), {
      ...input,
      riderId: "rider-2",
    }, database, 3_000)).rejects.toMatchObject({code: "already-exists"});
    expect(wallet(database).codOutstanding).toBe(40);
  });

  it("rejects an over-remittance before writing a journal", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database, 50);
    const ledger = vi.fn<CodRemittanceLedgerWriter>();
    await expect(recordRiderCodRemittance("admin-1", token("owner"), {
      ...input,
      amountPaise: 5_001,
    }, database, 2_000, ledger)).rejects.toMatchObject({
      code: "failed-precondition",
      details: {reason: "COD_REMITTANCE_EXCEEDS_OUTSTANDING"},
    });
    expect(ledger).not.toHaveBeenCalled();
    expect(wallet(database).codOutstanding).toBe(50);
  });

  it("allows only one of two concurrent remittances that exceed the shared available balance", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database, 100);
    const firstInput = {...input, operationId: "cod-remit-concurrent-0001", amountPaise: 7_000};
    const secondInput = {...input, operationId: "cod-remit-concurrent-0002", amountPaise: 7_000};
    const results = await Promise.allSettled([
      recordRiderCodRemittance("admin-1", token("owner"), firstInput, database, 2_000),
      recordRiderCodRemittance("admin-1", token("owner"), secondInput, database, 2_001),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(wallet(database).codOutstanding).toBe(30);
    expect(wallet(database).codRemittanceReservedPaise).toBe(0);
  });

  it("keeps a failed ledger operation reserved and completes it on an exact retry", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    const failingLedger: CodRemittanceLedgerWriter = async () => {
      throw new Error("TRANSIENT_LEDGER_FAILURE");
    };
    await expect(recordRiderCodRemittance(
      "admin-1",
      token("owner"),
      input,
      database,
      2_000,
      failingLedger,
    )).rejects.toMatchObject({
      code: "unavailable",
      details: {reason: "COD_REMITTANCE_LEDGER_PENDING"},
    });
    const operationKey = platformConfigOperationKey(input.operationId);
    expect(wallet(database)).toMatchObject({
      codOutstanding: 100,
      codRemittanceReservedPaise: 6_000,
      codRemittanceOperations: {
        [operationKey]: {status: "reserved", reservedAt: 2_000},
      },
    });

    const recovered = await recordRiderCodRemittance(
      "admin-1",
      token("owner"),
      input,
      database,
      9_000,
      persistCodRemittanceLedger,
    );
    expect(recovered).toMatchObject({
      idempotent: true,
      completedAt: 9_000,
      remainingOutstandingPaise: 4_000,
    });
    expect(wallet(database)).toMatchObject({
      codOutstanding: 40,
      codRemittanceReservedPaise: 0,
    });
  });

  it("recovers when the immutable journal was written before the process failed", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    const writeThenFail: CodRemittanceLedgerWriter = async (journalInput, ledgerDatabase) => {
      await persistCodRemittanceLedger(journalInput, ledgerDatabase);
      throw new Error("PROCESS_FAILED_AFTER_LEDGER_WRITE");
    };
    await expect(recordRiderCodRemittance(
      "admin-1",
      token("owner"),
      input,
      database,
      2_000,
      writeThenFail,
    )).rejects.toMatchObject({
      code: "unavailable",
      details: {reason: "COD_REMITTANCE_LEDGER_PENDING"},
    });
    expect(wallet(database)).toMatchObject({
      codOutstanding: 100,
      codRemittanceReservedPaise: 6_000,
    });

    const recovered = await recordRiderCodRemittance(
      "admin-1",
      token("owner"),
      input,
      database,
      9_000,
      persistCodRemittanceLedger,
    );
    expect(recovered).toMatchObject({
      idempotent: true,
      completedAt: 9_000,
      remainingOutstandingPaise: 4_000,
    });
    expect(wallet(database)).toMatchObject({
      codOutstanding: 40,
      codRemittanceReservedPaise: 0,
    });
  });

  it("surfaces immutable-ledger conflicts as finance-review data loss, not a retryable outage", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    const conflictingLedger: CodRemittanceLedgerWriter = async () => {
      throw new Error("LEDGER_IMMUTABLE_CONFLICT");
    };
    await expect(recordRiderCodRemittance(
      "admin-1",
      token("owner"),
      input,
      database,
      2_000,
      conflictingLedger,
    )).rejects.toMatchObject({
      code: "data-loss",
      details: {reason: "COD_REMITTANCE_LEDGER_CONFLICT"},
    });
    expect(wallet(database)).toMatchObject({
      codOutstanding: 100,
      codRemittanceReservedPaise: 6_000,
    });
  });

  it("validates integer paise, operation identity, methods, and electronic references", async () => {
    const database = new InMemoryDatabase();
    seedWallet(database);
    await expect(recordRiderCodRemittance("admin-1", token("owner"), {
      ...input,
      amountPaise: 1.5,
    }, database)).rejects.toMatchObject({code: "invalid-argument"});
    await expect(recordRiderCodRemittance("admin-1", token("owner"), {
      ...input,
      operationId: "short",
    }, database)).rejects.toMatchObject({code: "invalid-argument"});
    await expect(recordRiderCodRemittance("admin-1", token("owner"), {
      ...input,
      referenceId: undefined,
    }, database)).rejects.toMatchObject({code: "invalid-argument"});
    expect(database.transactions).toEqual([]);
  });
});
