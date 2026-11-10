import {beforeAll, describe, expect, it} from "vitest";

/**
 * The real order code against the Firestore emulator; skipped without one.
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:8765 GCLOUD_PROJECT=demo-savrivo npx vitest run test/priceLock.emulator.test.ts
 */
const emulated = Boolean(process.env.FIRESTORE_EMULATOR_HOST) && String(process.env.GCLOUD_PROJECT).startsWith("demo-");
type Run = {run: (request: unknown) => Promise<Record<string, any>>};
let api: Record<string, Run>;
let db: FirebaseFirestore.Firestore;
const call = (name: string, uid: string, data: unknown) => (api[name] as Run).run({auth: {uid, token: {}}, data, rawRequest: {}, acceptsStreaming: false});
let keyCount = 0;
const newKey = () => `lock_test_key_${Date.now()}_${keyCount += 1}`;
const cart = (rid = "r1", quantity = 2) => ({restaurantId: rid, addressId: "a1", items: [{itemId: `${rid}_dish`, quantity}]});
const preview = async (uid = "u1", rid = "r1", quantity = 2) => {
  const raw = await call("getCheckoutConfiguration", uid, {...cart(rid, quantity), couponCode: "", tip: 0, paymentMethod: "cod", useWallet: false});
  expect(raw.priceLock).toBe(true);
  expect(raw.checkoutPreview, "the preview must succeed").toBeTruthy();
  return Number(raw.checkoutPreview.total);
};
const rain = (rid: string, fee: number) => db.collection("pricingSignals").doc(rid).set(
  {kind: "verified_weather", rainFee: fee, validUntil: Date.now() + 20 * 60 * 1000});
const orderCount = async () => (await db.collection("orders").get()).size;
const place = (uid: string, data: Record<string, unknown>, name = "createCodOrder") => call(name, uid, {idempotencyKey: newKey(), ...cart(), ...data});
const refusal = (error: unknown) => String((error as Error).message);

describe.skipIf(!emulated)("price lock on the real order code", () => {
  beforeAll(async () => {
    const {firestoreDb} = await import("../src/admin");
    db = firestoreDb as unknown as FirebaseFirestore.Firestore;
    api = await import("../src/index") as unknown as Record<string, Run>;
    await db.collection("settings").doc("customer").set({rainFeeEnabled: true, platformFee: 5, taxRate: 5, maxDeliveryKm: 7});
    const point = {lat: 14.1, lng: 79.9};
    for (const rid of ["r1", "r2"]) {
      await db.collection("restaurants").doc(rid).set({id: rid, name: `Store ${rid}`, open: true, ...point, deliveryFee: 30, etaMin: 20, etaMax: 30, city: "Naidupet", address: "1 Market Road", area: "Naidupet", ownerId: `owner_${rid}`});
      await db.collection("menus").doc(rid).collection("items").doc(`${rid}_dish`).set({id: `${rid}_dish`, name: "Dosa", price: 100, available: true, category: "Food"});
    }
    for (const uid of ["u1", "u2"]) {
      await db.collection("users").doc(uid).set({name: "Test", phone: "9000000001", addresses: [
        {id: "a1", label: "Home", address: "1 Main Road", area: "Naidupet", phone: "9000000001", lat: 14.11, lng: 79.91},
      ]});
    }
  }, 60_000);

  it("rain starting after the price was shown doesn't change what is charged", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    await rain("r1", 9);
    const {order} = await place("u1", {quotedTotal: shown});
    expect(order.total).toBe(shown);
    expect(order.pricing.rainFee).toBe(0);
  });

  it("works through createOrder too", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    await rain("r1", 9);
    const {order} = await place("u1", {quotedTotal: shown, paymentMethod: "cod"}, "createOrder");
    expect(order.total).toBe(shown);
  });

  it("a shown rain fee stays after the rain stops", async () => {
    await rain("r1", 9);
    const shown = await preview();
    await db.collection("pricingSignals").doc("r1").delete();
    const {order} = await place("u1", {quotedTotal: shown});
    expect(order.total).toBe(shown);
    expect(order.pricing.rainFee).toBe(9);
  });

  it("older apps send no total and are priced as before", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    await rain("r1", 9);
    const {order} = await place("u1", {});
    expect(order.pricing.rainFee).toBe(9);
    expect(order.total).toBeGreaterThan(shown);
  });

  it("a made-up lower total makes no order and returns the real one", async () => {
    await rain("r1", 9);
    const real = await preview();
    const before = await orderCount();
    await expect(place("u1", {quotedTotal: real - 40})).rejects.toThrow(`PRICE_CHANGED:${real}`);
    expect(await orderCount()).toBe(before);
  });

  it("one customer's saved price doesn't work for another", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview("u1");
    await rain("r1", 9);
    await expect(place("u2", {quotedTotal: shown})).rejects.toThrow("PRICE_CHANGED:");
  });

  it("an expired price is refused only if the price moved, and the next tap goes through on the same key", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    for (const doc of (await db.collection("priceQuotes").get()).docs) await doc.ref.update({expiresAt: Date.now() - 1000});
    const sameKey = newKey();
    const same = await place("u1", {quotedTotal: shown});
    expect(same.order.total).toBe(shown);
    await preview();
    for (const doc of (await db.collection("priceQuotes").get()).docs) await doc.ref.update({expiresAt: Date.now() - 1000});
    await rain("r1", 9);
    let said = "";
    await place("u1", {idempotencyKey: sameKey, quotedTotal: shown}).catch((error) => { said = refusal(error); });
    expect(said).toMatch(/^PRICE_CHANGED:/);
    const fresh = Number(said.split(":")[1]);
    const {order, recovered} = await place("u1", {idempotencyKey: sameKey, quotedTotal: fresh});
    expect(recovered).toBe(false);
    expect(order.total).toBe(fresh);
  });

  it("a changed dish price is never charged silently", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    const dish = db.collection("menus").doc("r1").collection("items").doc("r1_dish");
    await dish.update({price: 120});
    const before = await orderCount();
    await expect(place("u1", {quotedTotal: shown})).rejects.toThrow("PRICE_CHANGED:");
    expect(await orderCount()).toBe(before);
    await dish.update({price: 100});
  });

  it("a moved map pin needs its own price", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    await rain("r1", 9);
    const user = db.collection("users").doc("u1");
    const profile = (await user.get()).data() as {addresses: {lat: number}[]};
    await user.update({addresses: profile.addresses.map((entry) => ({...entry, lat: 14.12}))});
    await expect(place("u1", {quotedTotal: shown})).rejects.toThrow("PRICE_CHANGED:");
    await user.update({addresses: profile.addresses});
  });

  it("real refusals keep their own reason", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    const dish = db.collection("menus").doc("r1").collection("items").doc("r1_dish");
    await dish.update({available: false});
    await expect(place("u1", {quotedTotal: shown})).rejects.toThrow("ITEM_UNAVAILABLE");
    await dish.update({available: true});
  });

  it("retrying a placed order returns that order at its own price", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    const shown = await preview();
    const key = newKey();
    await place("u1", {idempotencyKey: key, quotedTotal: shown});
    const again = await place("u1", {idempotencyKey: key, quotedTotal: shown + 50});
    expect(again.recovered).toBe(true);
    expect(again.order.total).toBe(shown);
  });

  it("a multi-restaurant order keeps the shown fees on every part", async () => {
    await db.collection("pricingSignals").doc("r1").delete();
    await db.collection("pricingSignals").doc("r2").delete();
    await preview("u1", "r1", 3);
    await preview("u1", "r2", 3);
    await rain("r1", 9);
    await rain("r2", 9);
    const result = await call("createClusterOrder", "u1", {
      idempotencyKey: newKey(), addressId: "a1", tip: 0, contactless: false, paymentMethod: "cod",
      parts: [
        {restaurantId: "r1", items: cart("r1", 3).items, instructions: "", quotedSubtotal: 300},
        {restaurantId: "r2", items: cart("r2", 3).items, instructions: "", quotedSubtotal: 300},
      ],
    });
    const orders = await Promise.all((result.orderIds as string[]).map(async (id) => (await db.collection("orders").doc(id).get()).data() as Record<string, any>));
    expect(orders.map((order) => order.pricing.rainFee)).toEqual([0, 0]);
    expect(orders[1]?.pricing.platformFee).toBe(0);
  });

  it("a changed dish price stops a multi-restaurant order before any part exists", async () => {
    const before = await orderCount();
    await expect(call("createClusterOrder", "u1", {
      idempotencyKey: newKey(), addressId: "a1", tip: 0, contactless: false, paymentMethod: "cod",
      parts: [
        {restaurantId: "r1", items: cart("r1", 3).items, instructions: "", quotedSubtotal: 250},
        {restaurantId: "r2", items: cart("r2", 3).items, instructions: "", quotedSubtotal: 300},
      ],
    })).rejects.toThrow("PRICE_CHANGED");
    expect(await orderCount()).toBe(before);
  });
});
