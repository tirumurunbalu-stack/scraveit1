import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  db: {ref: () => { throw new Error("UNEXPECTED_DEFAULT_DB"); }},
}));

import {ROOT} from "../src/config";
import {buildCodOrderDeliveryJournal} from "../src/services/ledger";
import {
  getRestaurantSettlementSummary,
  RESTAURANT_LEDGER_COVERAGE_ROOT,
  type RestaurantSettlementDatabase,
} from "../src/services/restaurantSettlements";
import {LEDGER_JOURNALS_ROOT} from "../src/services/ledger";

class InMemoryQueryDatabase implements RestaurantSettlementDatabase {
  readonly values = new Map<string, unknown>();
  readonly queries: Array<[string, string, unknown]> = [];

  ref(path: string) {
    const chain = {
      orderByChild: (child: string) => {
        this.queries.push([path, "orderByChild", child]);
        return chain;
      },
      limitToLast: (limit: number) => {
        this.queries.push([path, "limitToLast", limit]);
        return chain;
      },
      get: async () => ({val: () => structuredClone(this.values.get(path) ?? null)}),
    };
    return chain;
  }
}

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "finance@example.test"} as unknown as DecodedIdToken;
}

function delivery(orderId: string, occurredAt: number) {
  return buildCodOrderDeliveryJournal({
    grossAmountPaise: 10_000,
    restaurantPayablePaise: 8_000,
    platformCommissionPaise: 1_000,
    platformFeePaise: 500,
    taxPayablePaise: 0,
    riderDeliveryEarningPaise: 500,
    riderTipPaise: 0,
    orderId,
    restaurantId: "restaurant-1",
    riderId: "rider-1",
    occurredAt,
  });
}

describe("authorized bounded restaurant settlement query", () => {
  let database: InMemoryQueryDatabase;

  beforeEach(() => {
    database = new InMemoryQueryDatabase();
    database.values.set(`${RESTAURANT_LEDGER_COVERAGE_ROOT}/restaurant-1`, {
      schemaVersion: 1,
      restaurantId: "restaurant-1",
      historicalBackfillComplete: true,
      verifiedAt: 1,
    });
  });

  it("rejects an unrelated user before reading the immutable ledger", async () => {
    await expect(getRestaurantSettlementSummary("user-1", token(), {
      restaurantId: "restaurant-1",
    }, database)).rejects.toMatchObject({code: "permission-denied"});
    expect(database.queries.some((query) => query[0] === LEDGER_JOURNALS_ROOT)).toBe(false);
  });

  it.each(["restaurant_owner", "restaurant_manager"])(
    "allows an active path-scoped %s membership",
    async (role) => {
      database.values.set(`${ROOT}/restaurantMembers/restaurant-1/member-1`, {active: true, role});
      const journal = delivery("order-1", 1_000);
      database.values.set(LEDGER_JOURNALS_ROOT, {[journal.journalId]: journal});
      const result = await getRestaurantSettlementSummary("member-1", token(), {
        restaurantId: "restaurant-1",
        ledgerLimit: 20,
        historyLimit: 10,
      }, database);
      expect(result).toMatchObject({complete: true, pendingSettlementPaise: 8_000});
    },
  );

  it("does not treat normalized restaurant staff or a cross-restaurant legacy row as finance owners", async () => {
    database.values.set(`${ROOT}/restaurantMembers/restaurant-1/staff-1`, {
      active: true, role: "kitchen_staff", permissions: {orders: true},
    });
    database.values.set(`${ROOT}/staff/staff-1`, {
      active: true, restaurantId: "restaurant-2", role: "restaurant_owner",
    });
    await expect(getRestaurantSettlementSummary("staff-1", token(), {
      restaurantId: "restaurant-1",
    }, database)).rejects.toMatchObject({code: "permission-denied"});
  });

  it.each(["owner", "ops_admin"])("allows a verified platform %s claim without membership reads", async (role) => {
    const journal = delivery("order-1", 1_000);
    database.values.set(LEDGER_JOURNALS_ROOT, {[journal.journalId]: journal});
    const result = await getRestaurantSettlementSummary("admin-1", token(role), {
      restaurantId: "restaurant-1",
      ledgerLimit: 10,
      historyLimit: 5,
    }, database);
    expect(result.pendingSettlementPaise).toBe(8_000);
    expect(database.queries).not.toContainEqual(expect.arrayContaining([`${ROOT}/restaurantMembers/restaurant-1/admin-1`]));
  });

  it("fetches limit + 1 and withholds the current balance when the global window truncates", async () => {
    const one = delivery("order-1", 1_000);
    const two = delivery("order-2", 2_000);
    const three = delivery("order-3", 3_000);
    database.values.set(LEDGER_JOURNALS_ROOT, {
      [one.journalId]: one,
      [two.journalId]: two,
      [three.journalId]: three,
    });
    const result = await getRestaurantSettlementSummary("admin-1", token("owner"), {
      restaurantId: "restaurant-1",
      ledgerLimit: 2,
      historyLimit: 2,
    }, database);
    expect(database.queries).toContainEqual([LEDGER_JOURNALS_ROOT, "orderByChild", "occurredAt"]);
    expect(database.queries).toContainEqual([LEDGER_JOURNALS_ROOT, "limitToLast", 3]);
    expect(result).toMatchObject({
      complete: false,
      truncated: true,
      scannedJournalCount: 3,
      includedJournalCount: 2,
      windowNetPayableMovementPaise: 16_000,
      pendingSettlementPaise: null,
      restaurantDebitBalancePaise: null,
    });
    expect(result.activities.map((activity) => activity.orderId)).toEqual(["order-3", "order-2"]);
  });

  it("reports an invalid/tampered row and never presents a complete balance", async () => {
    const journal = delivery("order-1", 1_000);
    database.values.set(LEDGER_JOURNALS_ROOT, {
      [journal.journalId]: journal,
      tampered: {...journal, journalId: "lj_invalid"},
    });
    const result = await getRestaurantSettlementSummary("admin-1", token("ops_admin"), {
      restaurantId: "restaurant-1",
      ledgerLimit: 10,
      historyLimit: 10,
    }, database);
    expect(result).toMatchObject({
      complete: false,
      invalidJournalCount: 1,
      pendingSettlementPaise: null,
      requiresFinanceReview: true,
    });
  });

  it("fails closed for a legacy restaurant without a verified ledger backfill marker", async () => {
    database.values.delete(`${RESTAURANT_LEDGER_COVERAGE_ROOT}/restaurant-1`);
    const result = await getRestaurantSettlementSummary("admin-1", token("owner"), {
      restaurantId: "restaurant-1",
      ledgerLimit: 10,
      historyLimit: 10,
    }, database);
    expect(result).toMatchObject({
      complete: false,
      coverageVerified: false,
      pendingSettlementPaise: null,
      restaurantDebitBalancePaise: null,
      requiresFinanceReview: true,
    });
  });

  it("rejects unsafe direct-service bounds instead of silently widening reads", async () => {
    await expect(getRestaurantSettlementSummary("admin-1", token("owner"), {
      restaurantId: "restaurant-1",
      ledgerLimit: 2_001,
    }, database)).rejects.toThrow("RESTAURANT_SETTLEMENT_INVALID_LEDGER_LIMIT");
    await expect(getRestaurantSettlementSummary("admin-1", token("owner"), {
      restaurantId: "restaurant-1",
      historyLimit: 101,
    }, database)).rejects.toThrow("RESTAURANT_SETTLEMENT_INVALID_HISTORY_LIMIT");
    expect(database.queries).toEqual([]);
  });
});
