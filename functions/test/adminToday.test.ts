import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}}));

const {istDayStart, summarize} = await import("../src/services/adminToday");
const {applicationAlert, stuckReason} = await import("../src/services/adminAlerts");

describe("today at a glance", () => {
  it("starts the day at midnight in India", () => {
    const at = Date.parse("2026-10-05T01:00:00+05:30");
    expect(istDayStart(at)).toBe(Date.parse("2026-10-05T00:00:00+05:30"));
  });
  it("counts sales, Scraveit earnings and delivery time per kind", () => {
    const t0 = Date.parse("2026-10-05T12:00:00+05:30");
    const orders = [
      {id: "a", restaurantId: "r1", status: "Delivered", pricing: {subtotal: 300}, createdAt: t0, deliveredAt: t0 + 30 * 60_000},
      {id: "b", restaurantId: "g1", status: "Delivered", pricing: {subtotal: 200}, createdAt: t0, deliveredAt: t0 + 20 * 60_000},
      {id: "c", restaurantId: "r1", status: "Cancelled", pricing: {subtotal: 999}, createdAt: t0},
      {id: "d", restaurantId: "r1", status: "Preparing", pricing: {subtotal: 150}, createdAt: t0},
    ];
    const economics = new Map([["a", {snapshot: {platform: {contributionPaise: 4_000}, restaurant: {receivablePaise: 20_575}, rider: {totalPaise: 3_500}}}],
      ["b", {snapshot: {platform: {contributionPaise: 2_000}, restaurant: {receivablePaise: 15_000}, rider: {totalPaise: 3_000}}}]]);
    const {all, byKind} = summarize(orders, economics, (id) => (id === "g1" ? "grocery" : "restaurant"));
    expect(all).toMatchObject({orders: 4, delivered: 2, cancelled: 1, salesPaise: 65_000, earnedPaise: 6_000, avgDeliveryMinutes: 25});
    expect(byKind.restaurant).toMatchObject({orders: 3, salesPaise: 45_000, earnedPaise: 4_000, storesEarnedPaise: 20_575, avgDeliveryMinutes: 30});
    expect(byKind.grocery.delivered).toBe(1);
  });
});

describe("urgent alerts", () => {
  it("alerts on a new application and on a signed agreement, once each", () => {
    expect(applicationAlert("u1", {status: "draft"}, {status: "submitted", restaurantName: "Waffle", submittedAt: 1})?.title).toBe("New store application");
    expect(applicationAlert("u1", {status: "submitted"}, {status: "submitted", restaurantName: "Waffle"})).toBeNull();
    expect(applicationAlert("u1", {status: "submitted"}, {status: "submitted", restaurantName: "Waffle", agreement: {status: "signed", signedAt: 2}})?.title).toBe("Agreement signed");
  });
  it("flags orders not accepted, cooking too long or with no rider", () => {
    const now = 1_000_000_000;
    expect(stuckReason({status: "Order placed", createdAt: now - 6 * 60_000}, now)).toMatch(/not accepted/);
    expect(stuckReason({status: "Order placed", createdAt: now - 2 * 60_000}, now)).toBeNull();
    expect(stuckReason({status: "Preparing", updatedAt: now - 40 * 60_000}, now)).toMatch(/cooking/);
    expect(stuckReason({status: "Ready for pickup", updatedAt: now - 11 * 60_000}, now)).toMatch(/no rider/);
    expect(stuckReason({status: "Ready for pickup", riderId: "x", updatedAt: now - 11 * 60_000}, now)).toBeNull();
  });
});

describe("store payouts due", () => {
  it("lists stores with money waiting and flags unverified ledgers", async () => {
    const {readStorePayoutsDue} = await import("../src/services/adminToday");
    const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
    const db = new InMemoryFirestore();
    await db.collection("restaurants").doc("r1").set({name: "Waffle"});
    await db.collection("restaurants").doc("r2").set({name: "Cross"});
    await db.collection("restaurants").doc("r3").set({name: "Old", archived: true});
    await db.collection("restaurants").doc("r4").set({name: "Small"});
    const summaries: Record<string, {pendingSettlementPaise: number | null; requiresFinanceReview: boolean; automation: {minimumSettlementPaise: number}}> = {
      r1: {pendingSettlementPaise: 250_000, requiresFinanceReview: false, automation: {minimumSettlementPaise: 10_000}},
      r2: {pendingSettlementPaise: null, requiresFinanceReview: true, automation: {minimumSettlementPaise: 10_000}},
      r4: {pendingSettlementPaise: 5_000, requiresFinanceReview: false, automation: {minimumSettlementPaise: 10_000}},
    };
    const admin = {savrivoRole: "owner"} as never;
    const out = await readStorePayoutsDue("a", admin, db, async (id) => summaries[id]!);
    expect(out.checked).toBe(3);
    expect(out.stores.map((s) => [s.restaurantId, s.pendingPaise, s.needsReview])).toEqual([["r1", 250_000, false], ["r2", 0, true]]);
  });
});

describe("resubmitted applications", () => {
  it("alerts again after the owner fixes requested changes", async () => {
    const {applicationAlert} = await import("../src/services/adminAlerts");
    const alert = applicationAlert("u1", {status: "changes_requested"}, {status: "submitted", restaurantName: "Waffle", updatedAt: 9});
    expect(alert?.title).toBe("Application updated");
    expect(alert?.key).toBe("app-submitted:u1:9");
  });
});
