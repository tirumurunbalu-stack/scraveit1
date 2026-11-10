import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {createLedgerJournal, type LedgerJournal} from "../src/domain/ledger";
import {buildCodOrderDeliveryJournal, ledgerPartyEntryId} from "../src/services/ledger";
import {getRestaurantPayoutReport} from "../src/services/restaurantPayoutReport";
import {buildRestaurantRefundRecoveryAllocationJournal, buildRestaurantSettlementJournal} from "../src/services/restaurantSettlements";
import {withholdingJournal} from "../src/services/taxEngine";
import {
  getTdsCommissionClaims,
  listTdsCommissionClaimsForReview,
  reviewTdsCommissionClaim,
  submitTdsCommissionClaim,
} from "../src/services/tdsCommissionClaims";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+05:30`);
const FROM = at("2026-10-14", 0), TO = at("2026-10-21", 0), NOW = at("2026-10-30");

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "finance@example.test"} as unknown as DecodedIdToken;
}

function seed(database: InMemoryFirestore, journal: LedgerJournal | null) {
  if (!journal) return;
  const party = "restaurant:r1";
  database.seed(`ledgerPartyJournals/${ledgerPartyEntryId(party, journal.journalId)}`,
    {party, journalId: journal.journalId, occurredAt: journal.occurredAt, journal: JSON.parse(JSON.stringify(journal))});
}

function order(orderId: string, occurredAt: number, restaurantPayablePaise: number) {
  return buildCodOrderDeliveryJournal({orderId, restaurantId: "r1", riderId: "rider-1", occurredAt,
    grossAmountPaise: restaurantPayablePaise + 9_000, restaurantPayablePaise, platformCommissionPaise: 5_000, platformFeePaise: 0,
    taxPayablePaise: 900, riderDeliveryEarningPaise: 3_100, riderTipPaise: 0});
}

function tds(orderId: string, recordedAt: number, tdsPaise: number, tcsPaise = 0) {
  return withholdingJournal({orderId, restaurantId: "r1", recordedAt, financialYear: "26-27", gstTcsPaise: tcsPaise,
    incomeTaxTdsPaise: tdsPaise} as never);
}

function payout(id: string, occurredAt: number, amountPaise: number, referenceId: string) {
  return buildRestaurantSettlementJournal({settlementId: id, restaurantId: "r1", amountPaise, occurredAt, actorId: "system",
    method: "neft", referenceId});
}

function adjustment(eventId: string, occurredAt: number, movementPaise: number, adjustmentKind: string, reason: string) {
  const payable = {accountId: "liability:restaurant-payable:r1", amountPaise: Math.abs(movementPaise)};
  const other = {accountId: "revenue:advertising", amountPaise: Math.abs(movementPaise)};
  return createLedgerJournal({eventType: "adjustment", eventId, occurredAt, metadata: {restaurantId: "r1", adjustmentKind, reason},
    postings: movementPaise < 0 ? [{...payable, side: "debit"}, {...other, side: "credit"}] : [{...other, side: "debit"}, {...payable, side: "credit"}]});
}

describe("restaurant payout report", () => {
  let database: InMemoryFirestore;

  beforeEach(() => {
    database = new InMemoryFirestore();
    database.seed("restaurantMembers/r1_owner-1", {active: true, role: "restaurant_owner"});
    database.seed("restaurants/r1", {name: "Rice Box", address: "23-4", area: "Magunta Layout", city: "Nellore"});
    database.seed("restaurantPayoutProfiles/r1", {legalBusinessName: "Rice Box Foods", panNumber: "ABCDE1234F", bankName: "HDFC Bank",
      bankAccountNumber: "50100012345678", bankIfsc: "HDFC0001234", taxProfile: {tan: "HYDR12345E", entityType: "firm"}});
    database.seed("private/taxLaw", {scraveitGstin: "37AAACS0000A1Z5", scraveitTcsGstin: "37AAACS0000A1C1", scraveitPan: "AAACS0000A",
      scraveitAddress: "Naidupeta, AP"});
    // Paid before the period: order o0, then the weekly payout of 13 Oct.
    seed(database, order("o0", at("2026-10-06"), 10_000));
    seed(database, payout("weekly:restaurant:2026-10-13:aa", at("2026-10-13", 11), 10_000, "HDFCN52026101300001"));
    // Carried into the period: o1, delivered after that payout.
    seed(database, order("o1", at("2026-10-13", 20), 20_000));
    seed(database, tds("o1", at("2026-10-13", 20), 20));
    // In the period.
    seed(database, order("o2", at("2026-10-15"), 30_000));
    seed(database, tds("o2", at("2026-10-15"), 30, 150));
    seed(database, buildRestaurantRefundRecoveryAllocationJournal({adjustmentId: "rr1", restaurantId: "r1", orderId: "o1", amountPaise: 5_000,
      occurredAt: at("2026-10-16"), actorId: "ops", reason: "Wrong item sent; customer refunded"}));
    seed(database, adjustment("sponsored-listing:sl_1", at("2026-10-17"), -23_600, "sponsored_listing", ""));
    seed(database, adjustment("tds-commission-refund:tdc_1", at("2026-10-18"), 600, "tds_on_commission_refund", "TDS on commission, Q2"));
  });

  it("starts from the balance carried after the last payout and adds up to the payout's UTR", async () => {
    const due = 19_980 + 30_000 - 180 - 5_000 - 23_600 + 600;
    seed(database, payout("weekly:restaurant:2026-10-20:bb", at("2026-10-20", 11), due, "HDFCN52026102000002"));
    seed(database, order("o3", at("2026-10-22"), 40_000));

    const report = await getRestaurantPayoutReport("owner-1", token(), {restaurantId: "r1", from: FROM, to: TO}, database, NOW);
    expect(report.opening).toEqual({basis: "after_payout", balancePaise: 19_980});
    expect(report.periodNetPaise).toBe(30_000 - 180 - 5_000 - 23_600 + 600);
    expect(report.paidOutPaise).toBe(due);
    expect(report.closingPaise).toBe(0);
    expect(report.pendingPaise).toBe(0);
    expect(report.tdsPaise).toBe(30);
    expect(report.tcsPaise).toBe(150);
    expect(report.totals.ads).toEqual({count: 1, paise: -23_600});
    expect(report.totals.refund_recovery).toEqual({count: 1, paise: -5_000});
    expect(report.totals.tds_commission_refund).toEqual({count: 1, paise: 600});

    const o2 = report.orders.find((row) => row.orderId === "o2")!;
    expect(o2).toMatchObject({earningPaise: 30_000, tdsPaise: 30, tcsPaise: 150, netPaise: 29_820, paymentMethod: "cod",
      settlement: {status: "paid", utr: "HDFCN52026102000002", method: "neft", at: at("2026-10-20", 11)}});
    expect(report.orders.find((row) => row.orderId === "o1")).toMatchObject({refundRecoveredPaise: 5_000, netPaise: -5_000});
    expect(report.orders.map((row) => row.orderId)).not.toContain("o3");
    expect(report.adjustments.map((line) => [line.kind, line.movementPaise, line.reason])).toEqual([
      ["refund_recovery", -5_000, "Wrong item sent; customer refunded"], ["ads", -23_600, ""], ["tds_commission_refund", 600, "TDS on commission, Q2"]]);
    expect(report.payouts).toEqual([expect.objectContaining({amountPaise: due, utr: "HDFCN52026102000002", runDayKey: "2026-10-20", coversLines: 5, coversPaise: 1_820})]);
    expect(report.restaurant).toMatchObject({legalName: "Rice Box Foods", panMasked: "ABCDEXXXXF", tan: "HYDR12345E",
      payoutTo: "HDFC Bank ••••5678", address: "23-4, Magunta Layout, Nellore"});
    expect(report.scraveit).toMatchObject({gstin: "37AAACS0000A1Z5", tcsGstin: "37AAACS0000A1C1", pan: "AAACS0000A"});
  });

  it("marks lines pending until a payout, and a smaller payout pays the oldest first", async () => {
    let report = await getRestaurantPayoutReport("owner-1", token(), {restaurantId: "r1", from: FROM, to: TO}, database, NOW);
    expect(report.payouts).toEqual([]);
    expect(report.closingPaise).toBe(19_980 + report.periodNetPaise);
    expect(report.orders.find((row) => row.orderId === "o2")!.settlement).toEqual({status: "pending", at: null, utr: "", method: ""});

    seed(database, payout("manual-1", at("2026-10-22"), 20_000, "N123456789012345"));
    report = await getRestaurantPayoutReport("owner-1", token(), {restaurantId: "r1", from: FROM, to: TO}, database, NOW);
    // ₹200 pays the carried o1 (₹199.80 after TDS) first, then 20 paise of o2; the rest waits.
    expect(report.orders.find((row) => row.orderId === "o2")!.settlement).toMatchObject({status: "part_paid", utr: "N123456789012345"});
    expect(report.adjustments.every((line) => line.settlement.status === "pending")).toBe(true);
    expect(report.settledPaise).toBe(20);
  });

  it("knows the opening balance from the first entry, and says when it can't", async () => {
    const fresh = new InMemoryFirestore();
    fresh.seed("restaurantMembers/r1_owner-1", {active: true, role: "restaurant_owner"});
    seed(fresh, order("o1", at("2026-10-10"), 20_000));
    expect((await getRestaurantPayoutReport("owner-1", token(), {restaurantId: "r1", from: FROM, to: TO}, fresh, NOW)).opening)
      .toEqual({basis: "from_start", balancePaise: 20_000});
    seed(fresh, order("old", at("2026-08-01"), 1_000));
    expect((await getRestaurantPayoutReport("owner-1", token(), {restaurantId: "r1", from: FROM, to: TO}, fresh, NOW)).opening)
      .toEqual({basis: "unknown", balancePaise: null});
  });

  it("is for owners and managers only", async () => {
    database.seed("restaurantMembers/r1_cook-1", {active: true, role: "kitchen_staff", permissions: {orders: true}});
    await expect(getRestaurantPayoutReport("cook-1", token(), {restaurantId: "r1", from: FROM, to: TO}, database, NOW))
      .rejects.toMatchObject({code: "permission-denied"});
  });
});

describe("TDS on commission claims", () => {
  let database: InMemoryFirestore;
  const claim = {restaurantId: "r1", financialYear: "26-27", quarter: 2, commissionPaise: 3_000_000, tdsPaise: 60_000,
    deductorTan: "hydr12345e", certificateNo: "ABC1234", challanBsrCode: "0510308", challanSerialNo: "12345", challanDate: "2026-10-07"};

  beforeEach(() => {
    database = new InMemoryFirestore();
    database.seed("restaurantMembers/r1_owner-1", {active: true, role: "restaurant_owner"});
    database.seed("restaurants/r1", {name: "Rice Box"});
  });

  it("is sent once per certificate, checked by Scraveit, and added back to the payout", async () => {
    const sent = await submitTdsCommissionClaim("owner-1", token(), {...claim, deductorTan: "HYDR12345E"}, database, NOW);
    expect(sent).toMatchObject({status: "submitted", tdsPaise: 60_000, restaurantName: "Rice Box"});
    expect((await submitTdsCommissionClaim("owner-1", token(), {...claim, deductorTan: "HYDR12345E"}, database, NOW)).claimId).toBe(sent.claimId);
    expect((await getTdsCommissionClaims("owner-1", token(), {restaurantId: "r1"}, database)).claims).toHaveLength(1);

    await expect(reviewTdsCommissionClaim("owner-1", token(), {claimId: sent.claimId, decision: "approve", note: ""}, database, NOW))
      .rejects.toMatchObject({code: "permission-denied"});
    expect((await listTdsCommissionClaimsForReview("ops", token("ops_admin"), {status: "submitted"}, database)).claims).toHaveLength(1);
    const approved = await reviewTdsCommissionClaim("ops", token("ops_admin"), {claimId: sent.claimId, decision: "approve", note: ""}, database, NOW);
    expect(approved.status).toBe("approved");
    const journal = database.paths().filter((path) => path.startsWith("ledgerJournals/")).map((path) => database.read(path) as LedgerJournal)[0]!;
    expect(journal.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({accountId: "liability:restaurant-payable:r1", side: "credit", amountPaise: 60_000})]));
    await expect(reviewTdsCommissionClaim("ops", token("ops_admin"), {claimId: sent.claimId, decision: "reject", note: "Not in 26AS"}, database, NOW))
      .rejects.toMatchObject({code: "failed-precondition"});

    // The refund shows in that period's payout report as an addition.
    const report = await getRestaurantPayoutReport("owner-1", token(), {restaurantId: "r1", from: NOW - DAY, to: NOW + DAY}, database, NOW);
    expect(report.totals.tds_commission_refund).toEqual({count: 1, paise: 60_000});
  });
});
