import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, auth: {}, storage: {}, messaging: {}}));

const {isOpeningSoon, OPENING_SOON_MESSAGE} = await import("../src/services/openingSoon");
const {orderRule, cleanTestAccounts, REAL_CUSTOMER_TEST_STORE_MESSAGE, NO_TEST_ORDERS_MESSAGE} =
  await import("../src/services/testAccounts");

describe("opening soon (pre-launch) switch", () => {
  it("is on only when settings/customer.openingSoon is exactly true", () => {
    expect(isOpeningSoon({openingSoon: true})).toBe(true);
    expect(isOpeningSoon({openingSoon: false})).toBe(false);
    expect(isOpeningSoon({openingSoon: "true"})).toBe(false);
    expect(isOpeningSoon({})).toBe(false);
    expect(isOpeningSoon(null)).toBe(false);
    expect(OPENING_SOON_MESSAGE).toMatch(/opening soon/i);
  });
});

describe("who may order (test accounts + opening soon)", () => {
  it("refuses real customers while opening soon, and lets them order after launch", () => {
    expect(orderRule({testCustomer: false, testStore: false, openingSoon: true})).toBe(OPENING_SOON_MESSAGE);
    expect(orderRule({testCustomer: false, testStore: false, openingSoon: false})).toBeNull();
  });

  it("lets test customers order from test stores, before and after launch", () => {
    expect(orderRule({testCustomer: true, testStore: true, openingSoon: true})).toBeNull();
    expect(orderRule({testCustomer: true, testStore: true, openingSoon: false})).toBeNull();
  });

  it("lets test customers order from real stores too, and keeps real customers away from test stores", () => {
    expect(orderRule({testCustomer: true, testStore: false, openingSoon: true})).toBeNull();
    expect(orderRule({testCustomer: true, testStore: false, openingSoon: false})).toBeNull();
    expect(orderRule({testCustomer: false, testStore: true, openingSoon: false})).toBe(REAL_CUSTOMER_TEST_STORE_MESSAGE);
    expect(orderRule({testCustomer: false, testStore: true, openingSoon: true})).toBe(REAL_CUSTOMER_TEST_STORE_MESSAGE);
  });

  it("keeps test customers away from live stores handed to their restaurant (Waffle Spot)", () => {
    expect(orderRule({testCustomer: true, testStore: false, openingSoon: true, noTestOrders: true})).toBe(NO_TEST_ORDERS_MESSAGE);
    expect(orderRule({testCustomer: true, testStore: false, openingSoon: false, noTestOrders: true})).toBe(NO_TEST_ORDERS_MESSAGE);
    // Real customers are not affected by the list: after launch they order there as usual.
    expect(orderRule({testCustomer: false, testStore: false, openingSoon: false, noTestOrders: true})).toBeNull();
    expect(orderRule({testCustomer: false, testStore: false, openingSoon: true, noTestOrders: true})).toBe(OPENING_SOON_MESSAGE);
  });

  it("cleans the lists: lower-case unique emails, valid store ids, at most 50 each", () => {
    const clean = cleanTestAccounts({
      customers: [" A@Gmail.com ", "a@gmail.com", "not an email", "", 5],
      deliveryPartners: ["rider@example.com"],
      restaurants: "x",
      storeIds: ["store-1", "bad id!", "store-1"],
    });
    expect(clean.customers).toEqual(["a@gmail.com"]);
    expect(clean.deliveryPartners).toEqual(["rider@example.com"]);
    expect(clean.restaurants).toEqual([]);
    expect(clean.storeIds).toEqual(["store-1"]);
    expect(cleanTestAccounts({customers: Array.from({length: 60}, (_, i) => `u${i}@x.com`)}).customers).toHaveLength(50);
  });
});

describe("test account lookups never block real orders", () => {
  it("treats everyone as real when the lists can't be read", async () => {
    vi.resetModules();
    vi.doMock("../src/admin", () => ({
      firestoreDb: {collection: () => ({doc: () => ({get: async () => { throw new Error("firestore down"); }})})},
      auth: {getUsers: async () => { throw new Error("auth down"); }}, storage: {}, messaging: {},
    }));
    const fresh = await import("../src/services/testAccounts");
    expect(await fresh.isTestStore("store-1")).toBe(false);
    expect(await fresh.isTestCustomer("u1")).toBe(false);
    expect((await fresh.testDeliveryPartnerUids()).size).toBe(0);
    vi.doUnmock("../src/admin");
  });

  it("finds test customers and partners by verified email only", async () => {
    vi.resetModules();
    vi.doMock("../src/admin", () => ({
      firestoreDb: {collection: () => ({doc: () => ({get: async () => ({exists: true, data: () => ({
        customers: ["me@x.com", "new@x.com"], deliveryPartners: ["me@x.com"], restaurants: [], storeIds: ["test-store"],
      })})})})},
      auth: {getUsers: async (ids: Array<{email: string}>) => ({users: ids.flatMap(({email}) =>
        email === "me@x.com" ? [{uid: "u-me", email, emailVerified: true}] : [])})},
      storage: {}, messaging: {},
    }));
    const fresh = await import("../src/services/testAccounts");
    expect(await fresh.isTestCustomer("u-me")).toBe(true);
    expect(await fresh.isTestCustomer("someone-else")).toBe(false);
    expect([...(await fresh.testDeliveryPartnerUids())]).toEqual(["u-me"]);
    expect(await fresh.isTestStore("test-store")).toBe(true);
    expect(await fresh.isTestStore("spicy-box")).toBe(false);
    vi.doUnmock("../src/admin");
  });
});
