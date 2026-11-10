import {beforeAll, beforeEach, describe, expect, it, vi} from "vitest";

/**
 * The real dispatch code against the Firestore and Realtime Database emulators; skipped without them.
 * firebase emulators:exec --project demo-savrivo "npx vitest run test/dispatchBackup.emulator.test.ts"
 */
const emulated = Boolean(process.env.FIRESTORE_EMULATOR_HOST) && Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST) &&
  String(process.env.GCLOUD_PROJECT).startsWith("demo-");

const timeouts: number[] = [];
const offered: string[] = [];
const woken: string[] = [];
vi.mock("firebase-admin/functions", () => ({
  getFunctions: () => ({taskQueue: () => ({enqueue: async (_: unknown, options: {scheduleDelaySeconds: number}) => { timeouts.push(options.scheduleDelaySeconds); }})}),
}));
vi.mock("../src/services/notifications", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  notifyRiderOffer: async (riderId: string) => { offered.push(riderId); },
  notifyRiderWake: async (riderId: string) => { woken.push(riderId); },
  stopRiderOffers: async () => undefined,
  notifyCustomerRiderAssigned: async () => undefined,
}));

const HOUR = 3_600_000;
const POINT = {lat: 14.1, lng: 79.9};
let dispatch: typeof import("../src/services/dispatch");
let fs: FirebaseFirestore.Firestore;
let rtdb: import("firebase-admin/database").Database;

const order = (id: string) => ({
  id, status: "Preparing", customerId: "c1", restaurantId: "r1", restaurant: "Store", createdAt: Date.now(), etaMin: 20, etaMax: 30,
  restaurantLocation: {...POINT, address: "1 Market Road"},
  address: {id: "a1", label: "Home", area: "Naidupet", city: "Naidupet", address: "1 Main Road", lat: 14.12, lng: 79.92, phone: "9000000001"},
  items: [{itemId: "d", name: "Dosa", price: 100, quantity: 1}], paymentMethod: "cod", paymentStatus: "pending",
  pricing: {subtotal: 100, deliveryFee: 16, total: 116, tip: 0, tax: 0, platformFee: 0, packaging: 0, discount: 0, riderPayout: 25},
  total: 116, statusHistory: [{status: "Preparing", at: 1}],
});
const rider = async (riderId: string, ageMs: number, km: number, extra: Record<string, unknown> = {}) => {
  const now = Date.now();
  const presence = {online: true, riderId, riderName: riderId, city: "Naidupet", cityKey: "naidupet", lat: POINT.lat + km / 111, lng: POINT.lng, accuracy: 10, updatedAt: now - ageMs};
  await fs.collection("riderAvailability").doc(riderId).set(presence);
  await rtdb.ref(`/feastly/riderPresence/${riderId}`).set(presence);
  await fs.collection("riders").doc(riderId).set({status: "approved", fullName: riderId, phone: "9000000002"});
  await fs.collection("riderDispatchEligibility").doc(riderId).set({version: 1, riderId, riderName: riderId, approved: true, codBlocked: false, orderBlocked: false, activeLoad: 0, workloadEligible: true, eligible: true, updatedAt: now, ...extra});
};
const queue = async (id: string) => (await fs.collection("dispatchQueue").doc(id).get()).data() as Record<string, any>;
const clear = async () => {
  for (const name of ["riderAvailability", "riderDispatchEligibility", "riderOperationalWorkload", "riderJobs", "riderWallets", "riders", "dispatchQueue", "orders"]) {
    const docs = await fs.collection(name).get();
    await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
  }
  await rtdb.ref("/feastly/riderPresence").remove();
  timeouts.length = 0; offered.length = 0; woken.length = 0;
};
const start = async (id: string) => {
  await fs.collection("orders").doc(id).set(order(id));
  return dispatch.beginSequentialDispatch(order(id) as never);
};
/** The 3-minute (or 45 s) wait running out. */
const expire = async (id: string) => {
  const current = await queue(id);
  const activeOffers = Object.fromEntries(Object.entries(current.activeOffers).map(([riderId, offer]) => [riderId, {...(offer as object), expiresAt: 1}]));
  await fs.collection("dispatchQueue").doc(id).update({activeOffers, currentOffer: {...current.currentOffer, expiresAt: 1}});
  await dispatch.advanceDispatchOffer(id, current.attempt);
};
const offeredAtAgo = async (id: string, riderId: string, ageMs: number) => {
  await fs.collection("dispatchQueue").doc(id).update({[`attemptedRiders.${riderId}`]: Date.now() - ageMs});
};

describe.skipIf(!emulated)("backup ring on the real dispatch code", () => {
  beforeAll(async () => {
    const admin = await import("../src/admin");
    fs = admin.firestoreDb as unknown as FirebaseFirestore.Firestore;
    rtdb = admin.db as never;
    dispatch = await import("../src/services/dispatch");
    await fs.collection("restaurants").doc("r1").set({id: "r1", name: "Store", city: "Naidupet", ...POINT});
  }, 60_000);
  beforeEach(clear, 30_000);

  it("rings a live rider first even when a quiet rider is nearer, for the normal 180 s", async () => {
    await rider("quiet", HOUR, 0.5);
    await rider("live", 10_000, 9);
    const started = await start("o1");
    expect(started?.offeredRiderId).toBe("live");
    expect(timeouts).toEqual([180]);
    expect(offered).toEqual(["live"]);
    expect(woken).toEqual(["quiet"]);
  });

  it("then rings the quiet rider, waiting only 45 s", async () => {
    await rider("quiet", HOUR, 0.5);
    await rider("live", 10_000, 9);
    await start("o1");
    await expire("o1");
    const current = await queue("o1");
    expect(current.offeredRiderId).toBe("quiet");
    expect(timeouts).toEqual([180, 45]);
    expect(current.currentOffer.expiresAt - Date.now()).toBeLessThanOrEqual(45_000);
    expect(current.currentOffer.expiresAt - Date.now()).toBeGreaterThan(30_000);
  });

  it("rings a quiet rider straight away when nobody is live", async () => {
    await rider("quiet", 2 * HOUR, 3);
    const started = await start("o1");
    expect(started?.offeredRiderId).toBe("quiet");
    expect(timeouts).toEqual([45]);
  });

  it("leaves out a rider quiet for over 24 h, offline riders, and busy or blocked riders", async () => {
    await rider("gone", 25 * HOUR, 0.1);
    await rider("cash", HOUR, 0.1, {codBlocked: true, eligible: false});
    await fs.collection("riderWallets").doc("cash").set({codBlocked: true});
    await rider("off", HOUR, 0.1);
    await fs.collection("riderAvailability").doc("off").update({online: false});
    const started = await start("o1");
    expect(offered).toEqual([]);
    expect(started?.status).toBe("exhausted");
  });

  it("doesn't offer a rider waiting at a restaurant, though the service now reports them available", async () => {
    await rider("waiting", 5_000, 0.1, {workloadEligible: false, activeLoad: 1, eligible: false});
    await fs.collection("riderJobs").doc("waiting_held").set({riderId: "waiting", orderId: "held", status: "active", orderStatus: "Assigned", phase: "at_restaurant"});
    const started = await start("o1");
    expect(started?.status).toBe("exhausted");
    expect(offered).toEqual([]);
  });

  it("accepts a quiet rider's Accept but still refuses a quiet rider who wasn't offered as a backup", async () => {
    await rider("quiet", HOUR, 2);
    await start("o1");
    const claimed = await dispatch.claimDispatchOffer("quiet", "o1");
    expect(claimed.riderId).toBe("quiet");

    // Went quiet after being offered as a live rider: the old rule stands.
    await rider("live2", 10_000, 2);
    await start("o2");
    await rtdb.ref("/feastly/riderPresence/live2/updatedAt").set(Date.now() - HOUR);
    await expect(dispatch.claimDispatchOffer("live2", "o2")).rejects.toThrow("Go online with current location");
  }, 30_000);

  it("gives the order back at once to a rider who missed the backup ring and is back on the app", async () => {
    await rider("quiet", HOUR, 2);
    await start("o1");
    await expire("o1");
    expect((await queue("o1")).status).toBe("exhausted");
    await dispatch.beginSequentialDispatch(order("o1") as never);
    expect((await queue("o1")).status, "still quiet: the 5 minute wait applies").toBe("exhausted");
    await rider("quiet", 1_000, 2);
    await dispatch.beginSequentialDispatch(order("o1") as never);
    const current = await queue("o1");
    expect(current.status).toBe("offering");
    expect(current.offeredRiderId).toBe("quiet");
    expect(timeouts.at(-1)).toBe(180);
  });

  it("re-offers a missed order only after the 5 minute wait, and never to a rider who declined", async () => {
    await rider("live", 10_000, 2);
    await start("o1");
    await expire("o1");
    await dispatch.beginSequentialDispatch(order("o1") as never);
    expect((await queue("o1")).status, "inside the 5 minutes").toBe("exhausted");
    await offeredAtAgo("o1", "live", 6 * 60_000);
    await dispatch.beginSequentialDispatch(order("o1") as never);
    expect((await queue("o1")).offeredRiderId).toBe("live");

    await dispatch.declineDispatchOffer("live", "o1");
    expect((await queue("o1")).status).toBe("exhausted");
    await offeredAtAgo("o1", "live", 6 * 60_000);
    await dispatch.beginSequentialDispatch(order("o1") as never);
    expect((await queue("o1")).status, "a no stays a no").toBe("exhausted");
  }, 30_000);
});
