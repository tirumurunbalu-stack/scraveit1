import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {createLedgerJournal} from "../src/domain/ledger";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  class TrackedFirestore extends InMemoryFirestore {
    collectionsAccessed: string[] = [];
    collection(name: string) {
      this.collectionsAccessed.push(name);
      return super.collection(name);
    }
  }
  return {firestoreDb: new TrackedFirestore()};
});

import {firestoreDb} from "../src/admin";
import {readAdminDashboard} from "../src/services/adminDashboard";
import {LEDGER_JOURNALS_COLLECTION} from "../src/services/ledger";
import {adminDashboardQuerySchema} from "../src/schemas";
import type {InMemoryFirestore} from "./helpers/inMemoryFirestore";

type TrackedFirestore = InMemoryFirestore & {collectionsAccessed: string[]};

const database = firestoreDb as unknown as TrackedFirestore;

function operationalOrderPath(orderId: string): string {
  return `private/operations/operationalOrders/${orderId}`;
}

function journalPath(journalId: string): string {
  return `${LEDGER_JOURNALS_COLLECTION}/${journalId}`;
}

function walletPath(riderId: string): string {
  return `riderWallets/${riderId}`;
}

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "operator@example.test"} as unknown as DecodedIdToken;
}

describe("claim-protected bounded admin dashboard", () => {
  beforeEach(async () => {
    for (const path of database.paths()) await database.doc(path).delete();
    database.collectionsAccessed.length = 0;
  });

  it("rejects legacy email access without a verified admin claim before reading data", async () => {
    await expect(readAdminDashboard(token(), {
      activeLimit: 10, recentLimit: 10, ledgerLimit: 10, codLimit: 10,
    }))
      .rejects.toMatchObject({code: "permission-denied"});
    expect(database.collectionsAccessed).toEqual([]);
  });

  it("returns bounded privacy-minimized operations and ledger-derived activity", async () => {
    database.seed(operationalOrderPath("active"), {
      version: 1, source: "functions", orderId: "active", customerId: "customer-1",
      restaurantId: "restaurant-1", restaurantName: "Kitchen", riderId: "rider-1",
      status: "Out for delivery", active: true, activeSortKey: "active:0001",
      recentSortKey: "", paymentMethod: "cod", paymentState: "cash_due", total: 125,
      currency: "INR", itemCount: 1, createdAt: 1, updatedAt: 5,
      customerPhone: "must-not-leak",
    });
    database.seed(operationalOrderPath("recent"), {
      version: 1, source: "functions", orderId: "recent", customerId: "customer-2",
      restaurantId: "restaurant-1", restaurantName: "Kitchen", riderId: "rider-2",
      status: "Delivered", active: false, activeSortKey: "", recentSortKey: "recent:0002",
      paymentMethod: "cod", paymentState: "paid", total: 200,
      currency: "INR", itemCount: 2, createdAt: 2, updatedAt: 6, terminalAt: 6,
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
    database.seed(journalPath(journal.journalId), journal);

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
    database.seed(operationalOrderPath("invalid"), {
      version: 1, source: "functions", orderId: "invalid", customerId: "customer-1",
      restaurantId: "restaurant-1", restaurantName: "Kitchen", status: "Not canonical",
      active: true, activeSortKey: "active:1", paymentMethod: "cod", paymentState: "cash_due",
      total: 100, currency: "INR", itemCount: 1, createdAt: 1, updatedAt: 1,
    });
    database.seed(journalPath("tampered"), {journalId: "tampered"});

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
    for (let i = 0; i < 260; i += 1) {
      database.seed(journalPath(`journal-${i}`), createLedgerJournal({
        eventType: "cod_delivery",
        eventId: `evt-${i}`,
        occurredAt: i + 1,
        postings: [
          {accountId: "asset:cod-receivable:rider-1", side: "debit", amountPaise: 100},
          {accountId: "liability:restaurant-payable:restaurant-1", side: "credit", amountPaise: 100},
        ],
      }));
    }

    const result = await readAdminDashboard(token("owner"), {
      activeLimit: 999, recentLimit: 999, ledgerLimit: 999, codLimit: 999,
    });
    expect(result.activeOrders).toEqual([]);
    expect(result.recentOrders).toEqual([]);
    expect(result.finance.journalCount).toBe(250);
  });

  it("returns only a sanitized bounded positive COD exposure window", async () => {
    database.seed(walletPath("rider-low"), {
      codOutstanding: 10,
      profile: {phone: "must-not-leak"},
      codRemittanceOperations: {secret: {referenceId: "must-not-leak"}},
    });
    database.seed(walletPath("rider-high"), {
      codOutstanding: 123.45,
      codOutstandingLimitPaise: 10_000,
      codRemittanceReservedPaise: 345,
      codBlocked: false,
      customerAddress: "must-not-leak",
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
  });

  it("marks the COD window truncated and incomplete without leaking malformed wallets", async () => {
    database.seed(walletPath("rider-a"), {codOutstanding: 30});
    database.seed(walletPath("rider-b"), {codOutstanding: 20});
    database.seed(walletPath("rider-invalid"), {codOutstanding: "999.00", pan: "must-not-leak"});

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
