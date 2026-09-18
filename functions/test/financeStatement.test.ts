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

describe("who the period's money belongs to", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.queries.length = 0;
  });

  const load = async (journals: ReturnType<typeof createLedgerJournal>[]) => {
    const map: Record<string, unknown> = {};
    journals.forEach((j) => { map[j.journalId] = j; });
    memory.values.set(ADMIN_LEDGER_ROOT, map);
    return readFinanceStatement(token("owner"), {startAt: 0, endAt: 100_000});
  };

  /** Exactly the postings `allocationCredits` in services/ledger.ts makes on
   *  every delivered order: one balanced journal crediting the restaurant,
   *  the platform's two revenue accounts, tax, and the rider's earning+tip. */
  function orderDelivered(eventId: string, occurredAt: number, restaurantId: string, riderId: string) {
    return createLedgerJournal({
      eventType: "payment",
      eventId,
      occurredAt,
      postings: [
        {accountId: `liability:customer-order-funds:${eventId}`, side: "debit", amountPaise: 40_000},
        {accountId: `liability:restaurant-payable:${restaurantId}`, side: "credit", amountPaise: 24_000},
        {accountId: "revenue:platform-commission", side: "credit", amountPaise: 6_000},
        {accountId: "revenue:platform-fees", side: "credit", amountPaise: 2_000},
        {accountId: "liability:tax-payable", side: "credit", amountPaise: 1_000},
        {accountId: `liability:rider-earnings:${riderId}`, side: "credit", amountPaise: 6_000},
        {accountId: `liability:rider-tips:${riderId}`, side: "credit", amountPaise: 1_000},
      ],
    });
  }

  /** Exactly buildRestaurantSettlementJournal's shape: an actual payout run
   *  clearing what the restaurant was owed. */
  function restaurantSettled(eventId: string, occurredAt: number, restaurantId: string, amountPaise: number) {
    return createLedgerJournal({
      eventType: "restaurant_payable",
      eventId,
      occurredAt,
      postings: [
        {accountId: `liability:restaurant-payable:${restaurantId}`, side: "debit", amountPaise},
        {accountId: "asset:restaurant-settlement-clearing", side: "credit", amountPaise},
      ],
    });
  }

  /** Exactly buildRiderPayoutJournal's shape. */
  function riderPaidOut(eventId: string, occurredAt: number, riderId: string, earningsPaise: number, tipsPaise: number) {
    const postings = [];
    if (earningsPaise > 0) postings.push({accountId: `liability:rider-earnings:${riderId}`, side: "debit" as const, amountPaise: earningsPaise});
    if (tipsPaise > 0) postings.push({accountId: `liability:rider-tips:${riderId}`, side: "debit" as const, amountPaise: tipsPaise});
    postings.push({accountId: "asset:rider-payout-clearing", side: "credit" as const, amountPaise: earningsPaise + tipsPaise});
    return createLedgerJournal({eventType: "rider_payout", eventId, occurredAt, postings});
  }

  /** Exactly buildRestaurantRefundRecoveryAllocationJournal's shape: an
   *  explicit clawback of what a restaurant was owed, not a payout. */
  function restaurantRefundClawback(eventId: string, occurredAt: number, restaurantId: string, amountPaise: number) {
    return createLedgerJournal({
      eventType: "adjustment",
      eventId,
      occurredAt,
      postings: [
        {accountId: `liability:restaurant-payable:${restaurantId}`, side: "debit", amountPaise},
        {accountId: `asset:refund-settlement-recovery:${eventId}`, side: "credit", amountPaise},
      ],
    });
  }

  /** Exactly buildRiderIncentiveJournal's shape: a reward funded from a
   *  platform expense account, credited straight to the rider's earnings. */
  function riderIncentive(eventId: string, occurredAt: number, riderId: string, amountPaise: number) {
    return createLedgerJournal({
      eventType: "rider_incentive",
      eventId,
      occurredAt,
      postings: [
        {accountId: "expense:rider-rewards:per_order_bonus", side: "debit", amountPaise},
        {accountId: `liability:rider-earnings:${riderId}`, side: "credit", amountPaise},
      ],
    });
  }

  it("splits one delivered order into the restaurant's, the rider's and the platform's share", async () => {
    const result = await load([orderDelivered("o1", 100, "r1", "rd1")]);
    expect(result.allocation).toEqual({
      restaurantPaise: 24_000,
      riderPaise: 6_000 + 1_000,
      platformPaise: 6_000 + 2_000,
    });
    // Sanity check against the source of truth: everyone's share plus tax
    // must equal what the customer actually paid.
    const total = result.allocation.restaurantPaise + result.allocation.riderPaise + result.allocation.platformPaise;
    expect(total + 1_000 /* tax */).toBe(40_000);
  });

  it("adds several orders together", async () => {
    const result = await load([
      orderDelivered("o1", 100, "r1", "rd1"),
      orderDelivered("o2", 200, "r1", "rd2"),
    ]);
    expect(result.allocation.restaurantPaise).toBe(24_000 * 2);
    expect(result.allocation.riderPaise).toBe(7_000 * 2);
    expect(result.allocation.platformPaise).toBe(8_000 * 2);
  });

  it("counts an actual restaurant settlement run as the restaurant's money too", async () => {
    const result = await load([
      orderDelivered("o1", 100, "r1", "rd1"),
      restaurantSettled("s1", 150, "r1", 24_000),
    ]);
    // Both the order's accrual and the payout that actually cleared it count
    // as real restaurant-bound money that moved in this period.
    expect(result.allocation.restaurantPaise).toBe(24_000 + 24_000);
  });

  it("counts an actual rider payout run as the rider's money too", async () => {
    const result = await load([
      orderDelivered("o1", 100, "r1", "rd1"),
      riderPaidOut("p1", 150, "rd1", 6_000, 1_000),
    ]);
    expect(result.allocation.riderPaise).toBe(7_000 + 7_000);
  });

  it("does not count a settlement-run debit for the wrong party's account", async () => {
    // A restaurant_payable event only clears restaurant-payable; it must
    // never be read as rider money, and vice versa.
    const result = await load([restaurantSettled("s1", 100, "r1", 24_000)]);
    expect(result.allocation.riderPaise).toBe(0);
    expect(result.allocation.platformPaise).toBe(0);
  });

  it("leaves out a refund clawback rather than guessing whether it was a real reduction", async () => {
    const result = await load([
      orderDelivered("o1", 100, "r1", "rd1"),
      restaurantRefundClawback("adj1", 150, "r1", 24_000),
    ]);
    // The clawback debit is deliberately not subtracted: unlike a settlement
    // run's debit, an adjustment's event type alone cannot prove what kind of
    // change it represents, so this statement reports only what it can name
    // with certainty rather than silently netting a plausible-looking figure.
    expect(result.allocation.restaurantPaise).toBe(24_000);
  });

  it("nets a rider reward expense out of platform revenue", async () => {
    const result = await load([
      orderDelivered("o1", 100, "r1", "rd1"),
      riderIncentive("i1", 150, "rd1", 1_000),
    ]);
    expect(result.allocation.platformPaise).toBe(8_000 - 1_000);
    // And the reward itself is real money the rider received.
    expect(result.allocation.riderPaise).toBe(7_000 + 1_000);
  });

  it("can report a loss period honestly rather than floor it at zero", async () => {
    const result = await load([riderIncentive("i1", 100, "rd1", 5_000)]);
    expect(result.allocation.platformPaise).toBe(-5_000);
  });

  it("reports zero allocation for an empty period rather than throwing", async () => {
    const result = await load([]);
    expect(result.allocation).toEqual({restaurantPaise: 0, riderPaise: 0, platformPaise: 0});
  });

  it("allocates only over the journals it was actually given, truncation included", async () => {
    // summarizeAllocation runs on `bounded_`, the same truncated/validated set
    // totalsByEventType already runs on - so a page limit or an invalid
    // journal must shrink the allocation exactly the way it shrinks the
    // per-event totals, never silently include what didn't make the page.
    const result = await load([
      orderDelivered("o1", 100, "r1", "rd1"),
      orderDelivered("o2", 200, "r1", "rd1"),
      orderDelivered("o3", 300, "r1", "rd1"),
    ]);
    const limited = await readFinanceStatement(token("owner"), {startAt: 0, endAt: 100_000, limit: 2});
    expect(limited.truncated).toBe(true);
    expect(limited.allocation.restaurantPaise).toBe(24_000 * 2);
    expect(limited.allocation.restaurantPaise).toBeLessThan(result.allocation.restaurantPaise);
  });
});
