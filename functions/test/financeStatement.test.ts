import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {createLedgerJournal} from "../src/domain/ledger";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  queries: [] as Array<[string, string, unknown]>,
}));

vi.mock("../src/admin", () => ({
  db: {
    ref: (path: string) => {
      const chain = {
        orderByChild: (child: string) => {
          memory.queries.push([path, "orderByChild", child]);
          return chain;
        },
        startAt: (value: unknown) => {
          memory.queries.push([path, "startAt", value]);
          return chain;
        },
        endAt: (value: unknown) => {
          memory.queries.push([path, "endAt", value]);
          return chain;
        },
        limitToFirst: (value: number) => {
          memory.queries.push([path, "limitToFirst", value]);
          return chain;
        },
        get: async () => ({val: () => memory.values.get(path) ?? null}),
      };
      return chain;
    },
  },
}));

import {ADMIN_LEDGER_ROOT} from "../src/services/adminDashboard";
import {readFinanceStatement} from "../src/services/financeStatement";
import {financeStatementQuerySchema} from "../src/schemas";

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "operator@example.test"} as unknown as DecodedIdToken;
}

function journal(eventId: string, occurredAt: number, grossPaise: number, eventType: "payment" | "rider_payout" = "payment") {
  return createLedgerJournal({
    eventType,
    eventId,
    occurredAt,
    postings: [
      {accountId: "asset:cash", side: "debit", amountPaise: grossPaise},
      {accountId: "revenue:platform-commission", side: "credit", amountPaise: grossPaise},
    ],
  });
}

describe("finance statement (bounded window ledger read)", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.queries.length = 0;
  });

  it("rejects a caller without a verified owner/ops-admin claim before reading anything", async () => {
    await expect(readFinanceStatement(token(), {startAt: 0, endAt: 1000}))
      .rejects.toMatchObject({code: "permission-denied"});
    expect(memory.queries).toEqual([]);
  });

  it("itemizes journals within the window and totals them by event type", async () => {
    const j1 = journal("evt-1", 100, 5_000, "payment");
    const j2 = journal("evt-2", 200, 3_000, "payment");
    const j3 = journal("evt-3", 300, 2_000, "rider_payout");
    memory.values.set(ADMIN_LEDGER_ROOT, {[j1.journalId]: j1, [j2.journalId]: j2, [j3.journalId]: j3});

    const result = await readFinanceStatement(token("owner"), {startAt: 0, endAt: 1000});

    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.entryCount).toBe(3);
    expect(result.entries.map((e) => e.journalId)).toEqual([j3.journalId, j2.journalId, j1.journalId]);
    expect(result.totalsByEventType).toEqual([
      {eventType: "payment", count: 2, grossPaise: 8_000},
      {eventType: "rider_payout", count: 1, grossPaise: 2_000},
    ]);
  });

  it("queries the ledger with an [startAt, endAt) range and a page bound one past the limit", async () => {
    memory.values.set(ADMIN_LEDGER_ROOT, {});
    await readFinanceStatement(token("owner"), {startAt: 100, endAt: 1000, limit: 50});
    expect(memory.queries).toEqual([
      [ADMIN_LEDGER_ROOT, "orderByChild", "occurredAt"],
      [ADMIN_LEDGER_ROOT, "startAt", 100],
      [ADMIN_LEDGER_ROOT, "endAt", 999],
      [ADMIN_LEDGER_ROOT, "limitToFirst", 51],
    ]);
  });

  it("reports truncated and marks the page incomplete when more journals exist than the limit", async () => {
    const journals: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      const j = journal("evt-" + i, 100 + i, 1_000);
      journals[j.journalId] = j;
    }
    memory.values.set(ADMIN_LEDGER_ROOT, journals);

    const result = await readFinanceStatement(token("ops_admin"), {startAt: 0, endAt: 1000, limit: 3});
    expect(result.entryCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("rejects an inverted or empty window at the schema layer", () => {
    expect(() => financeStatementQuerySchema.parse({startAt: 1000, endAt: 1000})).toThrow();
    expect(() => financeStatementQuerySchema.parse({startAt: 1000, endAt: 500})).toThrow();
    expect(financeStatementQuerySchema.parse({startAt: 0, endAt: 1000})).toMatchObject({startAt: 0, endAt: 1000});
  });
});
