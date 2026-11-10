import type {DecodedIdToken} from "firebase-admin/auth";
import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {summarizeRestaurantSettlement} from "../src/domain/restaurantSettlement";
import {
  bookSponsoredListing,
  cancelSponsoredListing,
  getSponsoredListings,
  sponsoredQuote,
} from "../src/services/sponsoredListings";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const NOW = Date.parse("2026-10-30T10:00:00+05:30");
const CONFIRMED_FEES = Object.fromEntries(["customerDeliveryCharge", "deliverySurge", "rainDeliveryAmount", "lateNightDeliveryAmount",
  "busyKitchenFee"].map((key) => [key, {contractConfirmed: true}]));
const GST_ON = {gstLive: true, scraveitGstin: "37ABVCS0396N1Z5", feeOwnership: CONFIRMED_FEES, scraveitRiderPlatformFeeSac: "998599", platformFeeSacConfirmed: true};

function token(role?: string): DecodedIdToken {
  return {savrivoRole: role, email: "owner@example.test"} as unknown as DecodedIdToken;
}

type StoredJournal = {entries: {accountId: string; side: string; amountPaise: number}[]};
function journals(database: InMemoryFirestore): StoredJournal[] {
  return database.paths().filter((path) => /^ledgerJournals\/[^/]+$/.test(path)).map((path) => database.read(path) as StoredJournal);
}

function payableMovement(database: InMemoryFirestore, restaurantId: string): number {
  return journals(database).flatMap((journal) => journal.entries)
    .filter((entry) => entry.accountId === `liability:restaurant-payable:${restaurantId}`)
    .reduce((sum, entry) => sum + (entry.side === "credit" ? entry.amountPaise : -entry.amountPaise), 0);
}

describe("top placement (sponsored listings)", () => {
  let database: InMemoryFirestore;

  beforeEach(() => {
    database = new InMemoryFirestore();
    database.seed("settings/sponsoredListings", {dailyPricePaise: 20_000, slotsPerCity: 2, maxDays: 30});
    database.seed("restaurants/r1", {name: "Waffle Spot", city: "Naidupeta"});
    database.seed("restaurants/r2", {name: "Highway Cross", city: "Naidupeta"});
    database.seed("restaurants/r3", {name: "Spice Garden", city: "Naidupeta"});
    database.seed("restaurantMembers/r1_owner-1", {active: true, role: "restaurant_owner"});
    database.seed("restaurantMembers/r2_owner-2", {active: true, role: "restaurant_owner"});
    database.seed("restaurantMembers/r3_owner-3", {active: true, role: "restaurant_owner"});
    database.seed("restaurantMembers/r1_manager-1", {active: true, role: "restaurant_manager"});
    database.seed("restaurantPayoutProfiles/r1", {legalBusinessName: "Waffle Spot Foods", taxProfile: {stateCode: "37"}});
  });

  const book = (uid: string, restaurantId: string, startDay: string, days: number, expectedTotalPaise: number, requestId = `req-${restaurantId}-${startDay}`) =>
    bookSponsoredListing(uid, token(), {restaurantId, startDay, days, expectedTotalPaise, requestId}, database, NOW);

  it("charges the price to the payout, holds the slots and lists the store, without GST while GST is off", async () => {
    const booking = await book("owner-1", "r1", "2026-10-31", 3, 60_000);
    expect(booking).toMatchObject({status: "upcoming", days: 3, pricePaise: 60_000, gstPaise: 0, totalPaise: 60_000, invoiceNo: ""});
    expect(booking.startAt).toBe(Date.parse("2026-10-31T00:00:00+05:30"));
    expect(booking.endAt).toBe(Date.parse("2026-11-03T00:00:00+05:30"));
    expect(payableMovement(database, "r1")).toBe(-60_000);
    expect(database.read(`sponsoredListings/${booking.bookingId}`)).toEqual({restaurantId: "r1", cityKey: "naidupeta", startAt: booking.startAt, endAt: booking.endAt});
    expect(database.read("sponsoredSlotDays/naidupeta_2026-11-02")).toMatchObject({restaurants: {r1: booking.bookingId}});
    expect(database.read("sponsoredSlotDays/naidupeta_2026-11-03")).toBeNull();

    const page = await getSponsoredListings("owner-1", token(), {restaurantId: "r1"}, database, NOW);
    expect(page).toMatchObject({city: "Naidupeta", dailyPricePaise: 20_000, gstActive: false, slotsPerCity: 2, canBook: true, notBookable: ""});
    expect(page.availability.slice(0, 3)).toEqual([
      {day: "2026-10-30", left: 2, mine: false}, {day: "2026-10-31", left: 1, mine: true}, {day: "2026-11-01", left: 1, mine: true}]);
    expect(page.bookings.map((b) => b.bookingId)).toEqual([booking.bookingId]);
  });

  it("adds 18% GST with a tax invoice once GST is live, and the settlement shows it as a deduction", async () => {
    database.seed("private/taxLaw", GST_ON);
    database.seed("restaurantPayoutProfiles/r1", {taxProfile: {stateCode: "37"}, gstin: "37AAAAA0000A1Z5"});
    const page = await getSponsoredListings("owner-1", token(), {restaurantId: "r1"}, database, NOW);
    expect(page).toMatchObject({gstActive: true, gstRateBps: 1_800, sac: "998365"});
    expect(sponsoredQuote(20_000, 2, true, true)).toEqual({pricePaise: 40_000, gstPaise: 7_200, cgstPaise: 3_600, sgstPaise: 3_600, igstPaise: 0, totalPaise: 47_200});
    const booking = await book("owner-1", "r1", "2026-11-01", 2, 47_200);
    expect(booking).toMatchObject({pricePaise: 40_000, gstPaise: 7_200, totalPaise: 47_200, invoiceNo: "AD2627/000001"});
    expect(database.read("invoices/scraveit_ads_26-27_1")).toMatchObject({kind: "scraveit_advertising", taxableValuePaise: 40_000,
      recipientGstin: "37AAAAA0000A1Z5", gst: {rateBps: 1_800, sac: "998365", cgstPaise: 3_600, sgstPaise: 3_600, igstPaise: 0}});
    const stored = journals(database) as never[];
    const summary = summarizeRestaurantSettlement(stored, {restaurantId: "r1", coverageVerified: true, complete: true, truncated: false,
      scannedJournalCount: stored.length, invalidJournalCount: 0, historyLimit: 100});
    expect(summary.settlementHistory).toEqual([expect.objectContaining({activityType: "adjustment", payableMovementPaise: -47_200})]);

    // Cancelled before the start: a credit note against that invoice, and the money back.
    const cancelled = await cancelSponsoredListing("owner-1", token(), {restaurantId: "r1", bookingId: booking.bookingId}, database, NOW);
    expect(cancelled.creditNoteNo).toBe("ADCN2627/000001");
    expect(database.read("invoices/scraveit_ads_cn_26-27_1")).toMatchObject({kind: "scraveit_advertising_credit_note", againstInvoiceNo: "AD2627/000001"});
    expect(payableMovement(database, "r1")).toBe(0);
  });

  it("charges IGST to a store in another state", async () => {
    database.seed("private/taxLaw", GST_ON);
    database.seed("restaurantPayoutProfiles/r1", {gstin: "33AAAAA0000A1Z5"});
    await book("owner-1", "r1", "2026-11-01", 1, 23_600);
    expect(database.read("invoices/scraveit_ads_26-27_1")).toMatchObject({gst: {cgstPaise: 0, sgstPaise: 0, igstPaise: 3_600}});
  });

  it("refuses a day when the city's top places are all taken, and books nothing", async () => {
    await book("owner-2", "r2", "2026-11-05", 1, 20_000);
    await book("owner-3", "r3", "2026-11-04", 3, 60_000);
    await expect(book("owner-1", "r1", "2026-11-03", 3, 60_000)).rejects.toMatchObject({code: "failed-precondition",
      message: "All top places in Naidupeta are taken on 2026-11-05."});
    expect(payableMovement(database, "r1")).toBe(0);
    expect(database.read("sponsoredSlotDays/naidupeta_2026-11-03")).toBeNull();
  });

  it("won't book the same store twice on one day", async () => {
    await book("owner-1", "r1", "2026-11-01", 2, 40_000);
    await expect(book("owner-1", "r1", "2026-11-02", 2, 40_000, "another-request")).rejects.toMatchObject({code: "failed-precondition"});
  });

  it("lets only the owner book; a manager can look", async () => {
    await expect(book("manager-1", "r1", "2026-11-01", 1, 20_000)).rejects.toMatchObject({code: "permission-denied"});
    await expect(book("owner-2", "r1", "2026-11-01", 1, 20_000)).rejects.toMatchObject({code: "permission-denied"});
    const page = await getSponsoredListings("manager-1", token(), {restaurantId: "r1"}, database, NOW);
    expect(page.canBook).toBe(false);
    database.seed("restaurantMembers/r1_cook-1", {active: true, role: "kitchen_staff", permissions: {orders: true}});
    await expect(getSponsoredListings("cook-1", token(), {restaurantId: "r1"}, database, NOW)).rejects.toMatchObject({code: "permission-denied"});
  });

  it("refuses a total the owner didn't see, past days, too many days and a city price change", async () => {
    await expect(book("owner-1", "r1", "2026-11-01", 1, 19_900)).rejects.toMatchObject({message: "The price has changed. Check the new total and book again."});
    await expect(book("owner-1", "r1", "2026-10-29", 1, 20_000)).rejects.toMatchObject({code: "invalid-argument"});
    await expect(book("owner-1", "r1", "2026-11-01", 31, 620_000)).rejects.toMatchObject({code: "invalid-argument"});
    database.seed("settings/sponsoredListings", {dailyPricePaise: 20_000, cityDailyPricePaise: {Naidupeta: 15_000}});
    expect((await getSponsoredListings("owner-1", token(), {restaurantId: "r1"}, database, NOW)).dailyPricePaise).toBe(15_000);
    await expect(book("owner-1", "r1", "2026-11-01", 1, 15_000)).resolves.toMatchObject({totalPaise: 15_000});
  });

  it("charges a retried request once", async () => {
    const first = await book("owner-1", "r1", "2026-11-01", 2, 40_000, "same-request");
    const again = await book("owner-1", "r1", "2026-11-01", 2, 40_000, "same-request");
    expect(again.bookingId).toBe(first.bookingId);
    expect(payableMovement(database, "r1")).toBe(-40_000);
  });

  it("cancels before the start with a full refund and frees the days; not once it has started", async () => {
    const booking = await book("owner-1", "r1", "2026-11-01", 2, 40_000);
    const cancelled = await cancelSponsoredListing("owner-1", token(), {restaurantId: "r1", bookingId: booking.bookingId}, database, NOW);
    expect(cancelled.status).toBe("cancelled");
    expect(payableMovement(database, "r1")).toBe(0);
    expect(database.read(`sponsoredListings/${booking.bookingId}`)).toBeNull();
    expect(database.read("sponsoredSlotDays/naidupeta_2026-11-01")).toMatchObject({restaurants: {}});
    // Cancelling again changes nothing.
    await cancelSponsoredListing("owner-1", token(), {restaurantId: "r1", bookingId: booking.bookingId}, database, NOW);
    expect(payableMovement(database, "r1")).toBe(0);

    const live = await book("owner-1", "r1", "2026-10-30", 1, 20_000, "today-request");
    expect(live.status).toBe("live");
    await expect(cancelSponsoredListing("owner-1", token(), {restaurantId: "r1", bookingId: live.bookingId}, database, NOW))
      .rejects.toMatchObject({code: "failed-precondition"});
  });

  it("is paused when Scraveit switches it off, and needs the outlet's city", async () => {
    database.seed("settings/sponsoredListings", {enabled: false});
    expect((await getSponsoredListings("owner-1", token(), {restaurantId: "r1"}, database, NOW)).notBookable).toBe("Top placement is paused by Scraveit.");
    await expect(book("owner-1", "r1", "2026-11-01", 1, 19_900)).rejects.toMatchObject({code: "failed-precondition"});
    database.seed("settings/sponsoredListings", {});
    database.seed("restaurants/r1", {name: "Waffle Spot", city: ""});
    await expect(book("owner-1", "r1", "2026-11-01", 1, 19_900)).rejects.toMatchObject({message: "Your outlet has no city yet. Ask Scraveit to add it."});
  });
});
