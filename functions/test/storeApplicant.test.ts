import {beforeEach, describe, expect, it, vi} from "vitest";

// A store owner who applied hears from Scraveit on their phone: rate confirmed, changes asked for,
// approved. Their phone may register for notifications before approval because they applied.

const {queued} = vi.hoisted(() => ({queued: [] as Array<Record<string, unknown>>}));

vi.mock("../src/admin", () => ({
  firestoreDb: {},
  messaging: {sendEachForMulticast: vi.fn(async () => ({successCount: 0, failureCount: 0, responses: []}))},
  storage: {bucket: () => ({})},
}));

vi.mock("../src/services/outbox", async () => {
  const {createNotificationOutboxRecord} = await import("../src/domain/outbox");
  return {
    // The real record builder checks the message is one the outbox accepts.
    enqueueNotification: vi.fn(async (input: Parameters<typeof createNotificationOutboxRecord>[0]) => {
      const record = createNotificationOutboxRecord(input, Date.now());
      queued.push(record as unknown as Record<string, unknown>);
      return record;
    }),
    processNotification: vi.fn(async () => ({status: "delivered"})),
  };
});

import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
const {applicantUpdate} = await import("../src/services/restaurantOnboarding");
const {hasStoreApplication} = await import("../src/services/deviceTokens");
const {notifyStoreApplicant} = await import("../src/services/notifications");

const app = (extra: Record<string, unknown> = {}) => ({uid: "owner1", restaurantName: "Pizza and burgers", storeType: "restaurant", status: "submitted", ...extra});
const terms = (commissionBps: number, termMonths = 12, setAt = 1000) => ({commissionBps, termMonths, note: "", setAt, setBy: "admin1"});

describe("what the owner is told", () => {
  it("tells them when their rate is first confirmed", () => {
    const update = applicantUpdate("owner1", app(), app({terms: terms(2000)}));
    expect(update).toEqual({uid: "owner1", key: "rate:owner1:2000:12:1000", title: "Your rate is confirmed",
      body: "20% commission for 12 months. Open the app to read and sign your agreement."});
  });

  it("tells them when the rate changes, and to sign again if they had signed", () => {
    expect(applicantUpdate("owner1", app({terms: terms(2000)}), app({terms: terms(1850, 12, 2000)}))?.title).toBe("Your rate was updated");
    const resign = applicantUpdate("owner1", app({terms: terms(2000), agreement: {status: "signed"}}),
      app({terms: terms(1800, 24, 2000), agreement: {status: "superseded"}}));
    expect(resign?.body).toBe("18% commission for 24 months. Open the app to sign your agreement again.");
  });

  it("stays quiet when nothing they need to know changed", () => {
    // Confirmed again with the same numbers, the owner editing their details, or a new application.
    expect(applicantUpdate("owner1", app({terms: terms(2000)}), app({terms: terms(2000, 12, 5000)}))).toBeNull();
    expect(applicantUpdate("owner1", app({terms: terms(2000)}), app({terms: terms(2000), phone: "98765"}))).toBeNull();
    expect(applicantUpdate("owner1", null, app())).toBeNull();
    expect(applicantUpdate("owner1", app(), null)).toBeNull();
    expect(applicantUpdate("owner1", app(), app({uid: ""}))).toBeNull();
  });

  it("tells them when Scraveit asks for changes, with the message", () => {
    const update = applicantUpdate("owner1", app(), app({status: "changes_requested", reviewMessage: "Clearer FSSAI photo please", reviewedAt: 7}));
    expect(update).toMatchObject({key: "changes:owner1:7", title: "Scraveit asked for a few changes", body: "Clearer FSSAI photo please"});
    expect(applicantUpdate("owner1", app({status: "changes_requested"}), app({status: "changes_requested", phone: "1"}))).toBeNull();
  });

  it("tells them once when they're approved, and nothing about later edits", () => {
    const update = applicantUpdate("owner1", app({terms: terms(2000)}), app({terms: terms(2000), status: "approved"}));
    expect(update).toMatchObject({key: "approved:owner1", title: "You're approved!",
      body: "Pizza and burgers is on Scraveit. Open the app to switch on your restaurant."});
    expect(applicantUpdate("owner1_grocery", app({storeType: "grocery"}), app({storeType: "grocery", status: "approved"}))?.body)
      .toContain("switch on your store");
    expect(applicantUpdate("owner1", app({status: "approved"}), app({status: "approved", terms: terms(1500)}))).toBeNull();
  });
});

describe("the notification", () => {
  beforeEach(() => { queued.length = 0; });

  it("goes to the owner's Restaurant app, on the status channel, once per event", async () => {
    await notifyStoreApplicant({uid: "owner1", key: "rate:owner1:2000:12:1000", title: "Your rate is confirmed", body: "20% commission for 12 months."});
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      eventType: "STORE_APPLICATION",
      deduplicationKey: "store-applicant:rate:owner1:2000:12:1000",
      recipient: {kind: "user", id: "owner1", app: "restaurant"},
      message: {
        notification: {title: "Your rate is confirmed", body: "20% commission for 12 months."},
        data: {type: "STORE_APPLICATION"},
        android: {priority: "high", notification: {channelId: "savrivo_order_status"}},
      },
    });
  });
});

describe("registering the phone before approval", () => {
  it("is allowed for someone with a store application of their own", async () => {
    const db = new InMemoryFirestore();
    expect(await hasStoreApplication("owner1", db as never)).toBe(false);
    await db.collection("restaurantApplications").doc("owner1_dairy").set({uid: "owner1", status: "submitted"});
    expect(await hasStoreApplication("owner1", db as never)).toBe(true);
  });

  it("isn't allowed through someone else's application", async () => {
    const db = new InMemoryFirestore();
    await db.collection("restaurantApplications").doc("owner2").set({uid: "owner1", status: "submitted"});
    expect(await hasStoreApplication("owner2", db as never)).toBe(false);
  });
});
