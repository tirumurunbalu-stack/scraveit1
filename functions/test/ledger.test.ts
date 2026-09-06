import {describe, expect, it} from "vitest";
import {
  LEDGER_CURRENCY,
  LEDGER_EVENT_TYPES,
  createLedgerJournal,
  deterministicJournalId,
  ledgerJournalsEqual,
  resolveImmutableJournalWrite,
  validateLedgerJournal,
  type LedgerEventType,
  type LedgerJournalInput,
} from "../src/domain/ledger";

function input(overrides: Partial<LedgerJournalInput> = {}): LedgerJournalInput {
  return {
    eventType: "payment",
    eventId: "phonepe:merchant-order-1",
    occurredAt: 1_700_000_000_000,
    orderId: "SV-ORDER-1",
    actorId: "system:phonepe-webhook",
    metadata: {provider: "phonepe", providerTransactionId: "txn-1"},
    postings: [
      {accountId: "asset:gateway-clearing", side: "debit", amountPaise: 12_100},
      {accountId: "liability:customer-funds", side: "credit", amountPaise: 12_100},
    ],
    ...overrides,
  };
}

describe("immutable financial ledger primitives", () => {
  it("supports every required production event category", () => {
    expect(LEDGER_EVENT_TYPES).toEqual([
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
    ] satisfies LedgerEventType[]);
  });

  it("creates a balanced INR journal using integer paise", () => {
    const journal = createLedgerJournal(input());
    expect(journal.currency).toBe(LEDGER_CURRENCY);
    expect(journal.debitTotalPaise).toBe(12_100);
    expect(journal.creditTotalPaise).toBe(12_100);
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries.every((entry) => entry.currency === "INR" && Number.isInteger(entry.amountPaise))).toBe(true);
    expect(() => validateLedgerJournal(journal)).not.toThrow();
  });

  it("derives deterministic IDs independent of posting input order", () => {
    const first = createLedgerJournal(input());
    const second = createLedgerJournal(input({postings: [...input().postings].reverse()}));
    expect(first.journalId).toBe(deterministicJournalId("payment", "phonepe:merchant-order-1"));
    expect(first.entries.map((entry) => entry.entryId)).toEqual(second.entries.map((entry) => entry.entryId));
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(ledgerJournalsEqual(first, second)).toBe(true);
  });

  it("rejects zero, negative, fractional, unsafe, and unbalanced amounts", () => {
    for (const amountPaise of [0, -1, 10.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createLedgerJournal(input({
        postings: [
          {accountId: "asset:cash", side: "debit", amountPaise},
          {accountId: "liability:cod", side: "credit", amountPaise: 100},
        ],
      }))).toThrow("LEDGER_INVALID_AMOUNT_PAISE");
    }
    expect(() => createLedgerJournal(input({
      postings: [
        {accountId: "asset:cash", side: "debit", amountPaise: 100},
        {accountId: "liability:cod", side: "credit", amountPaise: 99},
      ],
    }))).toThrow("LEDGER_UNBALANCED_JOURNAL");
  });

  it("returns an idempotent no-replacement decision for an exact retry", () => {
    const existing = createLedgerJournal(input());
    const retry = createLedgerJournal(input());
    expect(resolveImmutableJournalWrite(null, existing)).toEqual({outcome: "insert", journal: existing});
    const resolved = resolveImmutableJournalWrite(existing, retry);
    expect(resolved).toEqual({outcome: "idempotent", journal: existing});
    expect(resolved.journal).toBe(existing);
  });

  it("forbids silent replacement under the same deterministic event identity", () => {
    const existing = createLedgerJournal(input());
    const conflicting = createLedgerJournal(input({
      postings: [
        {accountId: "asset:gateway-clearing", side: "debit", amountPaise: 12_200},
        {accountId: "liability:customer-funds", side: "credit", amountPaise: 12_200},
      ],
    }));
    expect(conflicting.journalId).toBe(existing.journalId);
    expect(() => resolveImmutableJournalWrite(existing, conflicting)).toThrow("LEDGER_IMMUTABLE_CONFLICT");
  });

  it("detects a tampered persisted journal rather than trusting its fingerprint", () => {
    const journal = createLedgerJournal(input());
    const tampered = {
      ...journal,
      entries: journal.entries.map((entry, index) => index === 0 ? {...entry, amountPaise: 1} : entry),
    } as typeof journal;
    expect(() => validateLedgerJournal(tampered)).toThrow();
    expect(() => resolveImmutableJournalWrite(tampered, journal)).toThrow();
  });

  it("freezes journals, entries, entry arrays, and metadata", () => {
    const journal = createLedgerJournal(input());
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.entries)).toBe(true);
    expect(Object.isFrozen(journal.entries[0])).toBe(true);
    expect(Object.isFrozen(journal.metadata)).toBe(true);
  });

  it("represents COD collection and remittance as separate balanced events", () => {
    const collected = createLedgerJournal(input({
      eventType: "cod_collection",
      eventId: "SV-ORDER-1:collected",
      postings: [
        {accountId: "asset:rider-cash:rider-1", side: "debit", amountPaise: 14_000},
        {accountId: "liability:cod-outstanding:rider-1", side: "credit", amountPaise: 14_000},
      ],
    }));
    const remitted = createLedgerJournal(input({
      eventType: "cod_remittance",
      eventId: "remittance:batch-1",
      orderId: undefined,
      postings: [
        {accountId: "asset:bank", side: "debit", amountPaise: 14_000},
        {accountId: "asset:rider-cash:rider-1", side: "credit", amountPaise: 14_000},
      ],
    }));
    expect(collected.journalId).not.toBe(remitted.journalId);
    expect(collected.debitTotalPaise).toBe(collected.creditTotalPaise);
    expect(remitted.debitTotalPaise).toBe(remitted.creditTotalPaise);
  });
});
