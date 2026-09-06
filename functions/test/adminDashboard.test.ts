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
        limitToLast: (value: number) => {
          memory.queries.push([path, "limitToLast", value]);
          return chain;
        },
        get: async () => ({val: () => memory.values.get(path) ?? null}),
      };
      return chain;
    },
  },
}));

import {
  ADMIN_COD_EXPOSURE_ROOT,
  ADMIN_LEDGER_ROOT,
  readAdminDashboard,
} from "../src/services/adminDashboard";
import {OPERATIONAL_ORDERS_ROOT} from "../src/services/operationalOrders";
import {adminDashboardQuerySchema} from "../src/schemas";

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "operator@example.test"} as unknown as DecodedIdToken;
}

describe("claim-protected bounded admin dashboard", () => {
  beforeEach(() => {
    memory.values.clear();
    memory.queries.length = 0;
  });

  it("rejects legacy email access without a verified admin claim before reading data", async () => {
    await expect(readAdminDashboard(token(), {
      activeLimit: 10, recentLimit: 10, ledgerLimit: 10, codLimit: 10,
    }))
      .rejects.toMatchObject({code: "permission-denied"});
    expect(memory.queries).toEqual([]);
  });

  it("returns bounded privacy-minimized operations and ledger-derived activity", async () => {
    memory.values.set(OPERATIONAL_ORDERS_ROOT, {
      active: {
        version: 1, source: "functions", orderId: "active", customerId: "customer-1",
        restaurantId: "restaurant-1", restaurantName: "Kitchen", riderId: "rider-1",
        status: "Out for delivery", active: true, activeSortKey: "active:0001",
        recentSortKey: "", paymentMethod: "cod", paymentState: "cash_due", total: 125,
        currency: "INR", itemCount: 1, createdAt: 1, updatedAt: 5,
        customerPhone: "must-not-leak",
      },
      recent: {
        version: 1, source: "functions", orderId: "recent", customerId: "customer-2",
        restaurantId: "restaurant-1", restaurantName: "Kitchen", riderId: "rider-2",
        status: "Delivered", active: false, activeSortKey: "", recentSortKey: "recent:0002",
        paymentMethod: "cod", paymentState: "paid", total: 200,
        currency: "INR", itemCount: 2, createdAt: 2, updatedAt: 6, terminalAt: 6,
      },
    });
    const journal = createLedgerJournal({
      eventType: "cod_delivery",
      eventId: "order:recent:delivered:cod",
      orderId: "recent",
      occurredAt: 6,
      postings: [
        {accountId: "asset:cod-receivable:rider-2", side: "debit", amountPaise: 20_000},
        {accountId: "liability:restaurant-payable:restaurant-1", side: "credit", amountPaise: 20_000},
      ],
    });
    memory.values.set(ADMIN_LEDGER_ROOT, {[journal.journalId]: journal});

    const result = await readAdminDashboard(token("ops_admin"), {
      activeLimit: 10, recentLimit: 10, ledgerLimit: 10, codLimit: 10,
    });

    expect(result.activeOrders).toHaveLength(1);
    expect(result.recentOrders).toHaveLength(1);
    expect(result.activeOrders[0]).not.toHaveProperty("address");
    expect(result.activeOrders[0]).not.toHaveProperty("customerPhone");
    expect(result.statusCounts).toEqual({"Out for delivery": 1, Delivered: 1});
    expect(result.finance).toMatchObject({
      scope: "bounded_recent_journals",
      complete: true,
      journalCount: 1,
      invalidJournalCount: 0,
      windowNetMovementPaise: {
        "asset:cod-receivable:rider-2": -20_000,
        "liability:restaurant-payable:restaurant-1": 20_000,
      },
    });
    expect(memory.queries).toContainEqual([ADMIN_LEDGER_ROOT, "orderByChild", "occurredAt"]);
    expect(memory.queries).toContainEqual([ADMIN_LEDGER_ROOT, "limitToLast", 10]);
    expect(memory.queries).toContainEqual([ADMIN_COD_EXPOSURE_ROOT, "orderByChild", "codOutstanding"]);
    expect(memory.queries).toContainEqual([ADMIN_COD_EXPOSURE_ROOT, "startAt", 0.01]);
    expect(memory.queries).toContainEqual([ADMIN_COD_EXPOSURE_ROOT, "limitToLast", 11]);
    expect(result.codExposure).toEqual({
      scope: "bounded_positive_cod_exposure",
      complete: true,
      truncated: false,
      riderCount: 0,
      invalidWalletCount: 0,
      riders: [],
    });
  });

  it("drops invalid projections and reports incomplete financial windows", async () => {
    memory.values.set(OPERATIONAL_ORDERS_ROOT, {
      invalid: {
        version: 1, source: "functions", orderId: "invalid", customerId: "customer-1",
        restaurantId: "restaurant-1", restaurantName: "Kitchen", status: "Not canonical",
        active: true, activeSortKey: "active:1", paymentMethod: "cod", paymentState: "cash_due",
        total: 100, currency: "INR", itemCount: 1, createdAt: 1, updatedAt: 1,
      },
    });
    memory.values.set(ADMIN_LEDGER_ROOT, {tampered: {journalId: "tampered"}});

    const result = await readAdminDashboard(token("ops_admin"), {
      activeLimit: 10, recentLimit: 10, ledgerLimit: 10, codLimit: 10,
    });
    expect(result.activeOrders).toEqual([]);
    expect(result.recentOrders).toEqual([]);
    expect(result.finance).toMatchObject({
      complete: false,
      journalCount: 0,
      invalidJournalCount: 1,
      windowNetMovementPaise: {},
    });
  });

  it("caps direct service page requests above 250", async () => {
    const result = await readAdminDashboard(token("owner"), {
      activeLimit: 999, recentLimit: 999, ledgerLimit: 999, codLimit: 999,
    });
    expect(result.activeOrders).toEqual([]);
    expect(result.recentOrders).toEqual([]);
    expect(memory.queries.filter((query) => query[1] === "limitToLast"))
      .toEqual(expect.arrayContaining([
        [OPERATIONAL_ORDERS_ROOT, "limitToLast", 250],
        [OPERATIONAL_ORDERS_ROOT, "limitToLast", 250],
        [ADMIN_LEDGER_ROOT, "limitToLast", 250],
        [ADMIN_COD_EXPOSURE_ROOT, "limitToLast", 101],
      ]));
  });

  it("returns only a sanitized bounded positive COD exposure window", async () => {
    memory.values.set(ADMIN_COD_EXPOSURE_ROOT, {
      "rider-low": {
        codOutstanding: 10,
        profile: {phone: "must-not-leak"},
        codRemittanceOperations: {secret: {referenceId: "must-not-leak"}},
      },
      "rider-high": {
        codOutstanding: 123.45,
        codOutstandingLimitPaise: 10_000,
        codRemittanceReservedPaise: 345,
        codBlocked: false,
        customerAddress: "must-not-leak",
      },
    });

    const result = await readAdminDashboard(token("owner"), {
      activeLimit: 1, recentLimit: 1, ledgerLimit: 1, codLimit: 3,
    });

    expect(result.codExposure).toEqual({
      scope: "bounded_positive_cod_exposure",
      complete: true,
      truncated: false,
      riderCount: 2,
      invalidWalletCount: 0,
      riders: [
        {
          riderId: "rider-high",
          codOutstandingPaise: 12_345,
          codOutstandingLimitPaise: 10_000,
          codRemittanceReservedPaise: 345,
          availableToRemitPaise: 12_000,
          codBlocked: true,
        },
        {
          riderId: "rider-low",
          codOutstandingPaise: 1_000,
          codOutstandingLimitPaise: 0,
          codRemittanceReservedPaise: 0,
          availableToRemitPaise: 1_000,
          codBlocked: false,
        },
      ],
    });
    expect(JSON.stringify(result.codExposure)).not.toContain("must-not-leak");
    expect(memory.queries).toContainEqual([ADMIN_COD_EXPOSURE_ROOT, "limitToLast", 4]);
  });

  it("marks the COD window truncated and incomplete without leaking malformed wallets", async () => {
    memory.values.set(ADMIN_COD_EXPOSURE_ROOT, {
      "rider-a": {codOutstanding: 30},
      "rider-b": {codOutstanding: 20},
      "rider-invalid": {codOutstanding: "999.00", pan: "must-not-leak"},
    });

    const result = await readAdminDashboard(token("ops_admin"), {
      activeLimit: 1, recentLimit: 1, ledgerLimit: 1, codLimit: 2,
    });

    expect(result.codExposure).toMatchObject({
      scope: "bounded_positive_cod_exposure",
      complete: false,
      truncated: true,
      riderCount: 2,
      invalidWalletCount: 1,
    });
    expect(result.codExposure.riders.map((rider) => rider.riderId)).toEqual(["rider-a", "rider-b"]);
    expect(JSON.stringify(result.codExposure)).not.toContain("pan");
    expect(JSON.stringify(result.codExposure)).not.toContain("999.00");
  });

  it.each([
    {activeLimit: 251, recentLimit: 10, ledgerLimit: 10},
    {activeLimit: 0, recentLimit: 10, ledgerLimit: 10},
    {activeLimit: -1, recentLimit: 10, ledgerLimit: 10},
    {activeLimit: 1.5, recentLimit: 10, ledgerLimit: 10},
    {activeLimit: 10, recentLimit: 10, ledgerLimit: 10, unexpected: true},
    {activeLimit: 10, recentLimit: 10, ledgerLimit: 10, codLimit: 101},
    {activeLimit: 10, recentLimit: 10, ledgerLimit: 10, codLimit: 0},
  ])("rejects unsafe dashboard query input %#", (input) => {
    expect(adminDashboardQuerySchema.safeParse(input).success).toBe(false);
  });

  it("defaults the COD page for existing dashboard clients", () => {
    expect(adminDashboardQuerySchema.parse({activeLimit: 10, recentLimit: 10, ledgerLimit: 10}).codLimit)
      .toBe(100);
  });
});
