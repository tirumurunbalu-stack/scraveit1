import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {summarizeRestaurantSettlement} from "../src/domain/restaurantSettlement";
import {itemId} from "../src/services/financeAutomation";
import {buildRestaurantSettlementJournal} from "../src/services/restaurantSettlements";
import {getRestaurantTaxStatement, restaurantTaxStatementSchema} from "../src/services/restaurantTaxStatement";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const DAY = 86_400_000;
const OCT_1 = Date.UTC(2026, 8, 30, 18, 30); // 1 Oct 2026 00:00 IST

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "finance@example.test"} as unknown as DecodedIdToken;
}

function withholding(orderId: string, recordedAt: number, restaurantId = "restaurant-1") {
  return {
    orderId, restaurantId, financialYear: "26-27", recordedAt,
    gstTcsPaise: 0, gstTcs: {cgstPaise: 0, sgstPaise: 0, igstPaise: 0, basePaise: 0},
    incomeTaxTdsPaise: 31, incomeTaxTdsBasePaise: 31_000, incomeTaxTdsCatchUpBasePaise: 0,
    invoices: [
      {series: "scraveit_restaurant_9_5_26-27", invoiceNo: "SCR/RS/26-27/000041", kind: "restaurant_service_9_5"},
      {series: "scraveit_commission_26-27", invoiceNo: "SCR/CM/26-27/000017", kind: "scraveit_commission"},
    ],
  };
}

describe("restaurant tax statement", () => {
  let database: InMemoryFirestore;

  beforeEach(() => {
    database = new InMemoryFirestore();
    database.seed("private/taxLaw", {scraveitGstin: "37ABCDE1234F1Z5", scraveitCommissionSac: "998599", scraveitAddress: "Naidupeta, AP"});
    database.seed("restaurantPayoutProfiles/restaurant-1", {legalBusinessName: "Spice Garden Foods", panNumber: "ABCDE1234F", gstin: ""});
    database.seed("taxPartnerYears/restaurant-1_26-27", {grossPaise: 4_200_000, tdsDeductedPaise: 4_200});
    database.seed("taxWithholdings/order-1", withholding("order-1", OCT_1 + 2 * DAY));
    database.seed("taxWithholdings/order-2", withholding("order-2", OCT_1 + 40 * DAY));
    database.seed("taxWithholdings/order-other", withholding("order-other", OCT_1 + 3 * DAY, "restaurant-2"));
    database.seed("private/financeAutomation/weeklyRuns/2026-10-26", {attemptedAt: OCT_1 + 25 * DAY});
    database.seed(`private/financeAutomation/weeklyRuns/2026-10-26/items/${itemId("restaurant", "restaurant-1")}`, {
      status: "completed", reason: "Weekly restaurant settlement completed.", amountPaise: 2_295_200, method: "neft",
      referenceId: "HDFCN52026102612345", completedAt: OCT_1 + 25 * DAY,
    });
  });

  it("refuses kitchen staff, who have no finance access", async () => {
    database.seed("restaurantMembers/restaurant-1_staff-1", {active: true, role: "kitchen_staff", permissions: {orders: true}});
    await expect(getRestaurantTaxStatement("staff-1", token(), {restaurantId: "restaurant-1", from: OCT_1, to: OCT_1 + 31 * DAY}, database))
      .rejects.toMatchObject({code: "permission-denied"});
  });

  it("gives an owner only their own orders in the period, with invoices, TDS, the year total and payout runs", async () => {
    database.seed("restaurantMembers/restaurant-1_owner-1", {active: true, role: "restaurant_owner"});
    const result = await getRestaurantTaxStatement("owner-1", token(), {restaurantId: "restaurant-1", from: OCT_1, to: OCT_1 + 31 * DAY}, database);
    expect(result.rows.map((row) => row.orderId)).toEqual(["order-1"]);
    expect(result.rows[0]).toMatchObject({incomeTaxTdsPaise: 31, invoices: [
      {invoiceNo: "SCR/RS/26-27/000041", kind: "restaurant_service_9_5"},
      {invoiceNo: "SCR/CM/26-27/000017", kind: "scraveit_commission"},
    ]});
    expect(result.seller).toMatchObject({legalName: "Spice Garden Foods", panMasked: "ABCDEXXXXF", panFurnished: true, gstin: ""});
    expect(result.issuer).toMatchObject({gstin: "37ABCDE1234F1Z5", commissionSac: "998599", stateCode: "37"});
    expect(result.year).toMatchObject({financialYear: "26-27", grossPaise: 4_200_000, tdsDeductedPaise: 4_200, rateBps: 10});
    expect(result.payoutRuns).toEqual([expect.objectContaining({runDayKey: "2026-10-26", referenceId: "HDFCN52026102612345", method: "neft"})]);
    expect(result.truncated).toBe(false);
  });

  it("accepts at most about three months at a time", () => {
    expect(restaurantTaxStatementSchema.safeParse({restaurantId: "restaurant-1", from: OCT_1, to: OCT_1 + 92 * DAY}).success).toBe(true);
    expect(restaurantTaxStatementSchema.safeParse({restaurantId: "restaurant-1", from: OCT_1, to: OCT_1 + 120 * DAY}).success).toBe(false);
  });
});

describe("settlement history carries the bank reference", () => {
  it("returns each payout's UTR, method and weekly run day", () => {
    const payout = buildRestaurantSettlementJournal({
      settlementId: "weekly:restaurant:2026-10-26:abcdef0123456789abcdef01",
      restaurantId: "restaurant-1", amountPaise: 12_000, occurredAt: 3_000, actorId: "system", method: "neft",
      referenceId: "HDFCN52026102612345",
    });
    const result = summarizeRestaurantSettlement([payout], {
      restaurantId: "restaurant-1", coverageVerified: true, complete: true, truncated: false,
      scannedJournalCount: 1, invalidJournalCount: 0, historyLimit: 10,
    });
    expect(result.settlementHistory[0]).toMatchObject({
      activityType: "settlement", payableMovementPaise: -12_000,
      referenceId: "HDFCN52026102612345", settlementMethod: "neft", payoutRunDayKey: "2026-10-26",
    });
  });
});
