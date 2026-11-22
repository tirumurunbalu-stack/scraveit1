import {createHmac} from "node:crypto";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import type {SavrivoOrder} from "../src/types";
const hooks = await import("../src/services/orderWebhooks");

const token = {} as DecodedIdToken;
const NOW = Date.parse("2026-11-22T20:00:00+05:30");
const publicDns = async () => ["203.0.113.10"];

function setup() {
  const db = new InMemoryFirestore();
  db.seed("restaurantMembers/r1_owner1", {role: "restaurant_owner", active: true});
  db.seed("restaurantMembers/r1_staff1", {role: "restaurant_staff", active: true});
  return db;
}

function order(over: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "123456789012345", restaurantId: "r1", status: "Order placed", paymentMethod: "cod", createdAt: NOW,
    customerName: "Ravi Kumar", customerPhone: "+919000000000", instructions: "Less spicy",
    items: [{itemId: "d1", name: "Biryani", quantity: 2, price: 200, variant: "Full", variantPrice: 0,
      addOns: [{name: "Raita", price: 20}], addOnTotal: 20, note: "", diet: "nonveg"}],
    pricing: {subtotal: 440},
    ...over,
  } as unknown as SavrivoOrder;
}

describe("own billing software link", () => {
  it("only accepts a public https address", async () => {
    await expect(hooks.checkWebhookUrl("http://pos.example.com/h", publicDns)).rejects.toThrow(/https/);
    await expect(hooks.checkWebhookUrl("https://localhost/h", publicDns)).rejects.toThrow(/public/);
    await expect(hooks.checkWebhookUrl("https://10.0.0.5/h", publicDns)).rejects.toThrow(/local/);
    await expect(hooks.checkWebhookUrl("https://pos.example.com/h", async () => ["169.254.169.254"])).rejects.toThrow(/local/);
    await expect(hooks.checkWebhookUrl("https://pos.example.com/h", publicDns)).resolves.toBe("https://pos.example.com/h");
  });

  it("owner saves the address and gets a secret; staff cannot", async () => {
    const db = setup();
    await expect(hooks.restaurantOrderWebhook("staff1", token, {action: "get", restaurantId: "r1"}, db)).rejects.toThrow(/owner or a manager/);
    // A public IP literal avoids a real DNS lookup in the test.
    const saved = await hooks.restaurantOrderWebhook("owner1", token, {action: "save", restaurantId: "r1", url: "https://203.0.113.10/orders"}, db, async () => 200, NOW);
    expect(saved.connected).toBe(true);
    expect(String(saved.secret)).toMatch(/^[0-9a-f]{48}$/);
    const again = await hooks.restaurantOrderWebhook("owner1", token, {action: "save", restaurantId: "r1", url: "https://203.0.113.10/new"}, db, async () => 200, NOW + 1);
    expect(again.secret).toBe(saved.secret);
  });

  it("sends each order once per status, signed, with no phone or address", async () => {
    const db = setup();
    const posts: Array<{url: string; body: string; headers: Record<string, string>}> = [];
    const post = async (url: string, body: string, headers: Record<string, string>) => { posts.push({url, body, headers}); return 200; };
    const saved = await hooks.restaurantOrderWebhook("owner1", token, {action: "save", restaurantId: "r1", url: "https://203.0.113.10/orders"}, db, post, NOW);

    await hooks.relayOrderChange(null, order(), db, post, NOW);
    await hooks.relayOrderChange(null, order(), db, post, NOW); // trigger ran twice
    await hooks.relayOrderChange(order(), order({riderId: "x"} as Partial<SavrivoOrder>), db, post, NOW); // no status change
    await hooks.relayOrderChange(order(), order({status: "Accepted"}), db, post, NOW);
    expect(posts.map((p) => JSON.parse(p.body).event)).toEqual(["order.placed", "order.accepted"]);

    const first = posts[0]!;
    expect(first.headers["x-scraveit-signature"]).toBe("sha256=" + createHmac("sha256", String(saved.secret)).update(first.body).digest("hex"));
    const body = JSON.parse(first.body);
    expect(body.order).toMatchObject({id: "123456789012345", payment: "cash_on_delivery", itemCount: 2, itemTotal: 440, customerFirstName: "Ravi"});
    expect(first.body).not.toContain("9000000000");
  });

  it("waits for online payment and split-cart release; skips when switched off", async () => {
    const db = setup();
    const posts: string[] = [];
    const post = async (_u: string, body: string) => { posts.push(JSON.parse(body).event); return 200; };
    await hooks.restaurantOrderWebhook("owner1", token, {action: "save", restaurantId: "r2x", url: "https://203.0.113.10/o"}, db, post, NOW).catch(() => undefined);
    db.seed("restaurantMembers/r3_owner1", {role: "restaurant_owner", active: true});
    await hooks.restaurantOrderWebhook("owner1", token, {action: "save", restaurantId: "r3", url: "https://203.0.113.10/o"}, db, post, NOW);
    const unpaid = order({restaurantId: "r3", id: "o2", paymentMethod: "upi", paymentState: "pending"} as Partial<SavrivoOrder>);
    await hooks.relayOrderChange(null, unpaid, db, post, NOW);
    expect(posts).toEqual([]);
    await hooks.relayOrderChange(unpaid, {...unpaid, paymentState: "paid"} as SavrivoOrder, db, post, NOW);
    expect(posts).toEqual(["order.placed"]);
    const held = order({restaurantId: "r3", id: "o3", clusterHold: true} as Partial<SavrivoOrder>);
    await hooks.relayOrderChange(null, held, db, post, NOW);
    await hooks.relayOrderChange(held, {...held, clusterHold: false} as SavrivoOrder, db, post, NOW);
    expect(posts).toEqual(["order.placed", "order.placed"]);
    await hooks.restaurantOrderWebhook("owner1", token, {action: "off", restaurantId: "r3"}, db, post, NOW);
    await hooks.relayOrderChange(null, order({restaurantId: "r3", id: "o4"}), db, post, NOW + 120_000);
    expect(posts).toHaveLength(2);
  });

  it("test button reports what their software answered", async () => {
    const db = setup();
    await hooks.restaurantOrderWebhook("owner1", token, {action: "save", restaurantId: "r1", url: "https://203.0.113.10/orders"}, db, async () => 200, NOW);
    const bad = await hooks.restaurantOrderWebhook("owner1", token, {action: "test", restaurantId: "r1"}, db, async () => 401, NOW + 5);
    expect(bad).toMatchObject({testOk: false, lastStatus: 401, lastError: "Your software answered 401"});
    const good = await hooks.restaurantOrderWebhook("owner1", token, {action: "test", restaurantId: "r1"}, db, async () => 204, NOW + 6);
    expect(good).toMatchObject({testOk: true, lastStatus: 204});
  });
});
