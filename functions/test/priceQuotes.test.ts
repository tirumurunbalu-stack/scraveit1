import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore(), db: {}};
});

import {firestoreDb} from "../src/admin";
import {loadPriceQuote, PRICE_QUOTE_VALID_MS, priceQuoteDocId, savePriceQuote} from "../src/services/priceQuotes";

const cart = {restaurantId: "r1", addressId: "a1", lat: 14.1, lng: 79.9, items: [{itemId: "i1", quantity: 2, addOnIds: []}]};
const NOW = 1_800_000_000_000;

describe("price quotes", () => {
  it("are kept per account and per priced cart", () => {
    const id = priceQuoteDocId("u1", cart);
    expect(priceQuoteDocId("u1", {...cart, items: [{itemId: "i1", quantity: 2, addOnIds: []}]})).toBe(id);
    expect(priceQuoteDocId("u2", cart)).not.toBe(id);
    expect(priceQuoteDocId("u1", {...cart, lat: 14.2})).not.toBe(id);
    expect(priceQuoteDocId("u1", {...cart, items: [{itemId: "i1", quantity: 3, addOnIds: []}]})).not.toBe(id);
    expect(priceQuoteDocId("u1", {...cart, items: [{itemId: "i1", quantity: 2, variantId: "large", addOnIds: []}]})).not.toBe(id);
    expect(priceQuoteDocId("u1", {...cart, items: [{itemId: "i1", quantity: 2, addOnIds: ["cheese"]}]})).not.toBe(id);
  });

  it("ignores a dish note, which doesn't change the price", () => {
    const withNote = {...cart, items: [{itemId: "i1", quantity: 2, addOnIds: [], note: "less spicy"}]};
    expect(priceQuoteDocId("u1", withNote)).toBe(priceQuoteDocId("u1", cart));
  });

  it("gives back the saved price until it runs out", async () => {
    await savePriceQuote("u1", cart, {rainFee: 0, note: undefined}, 54.77, NOW);
    expect(await loadPriceQuote("u1", cart, NOW + 1000)).toEqual({fees: {rainFee: 0}, total: 54.77});
    expect(await loadPriceQuote("u1", cart, NOW + PRICE_QUOTE_VALID_MS + 1)).toBeNull();
    expect(await loadPriceQuote("u2", cart, NOW + 1000)).toBeNull();
  });

  it("never fails the price or the order when the database does", async () => {
    const spy = vi.spyOn(firestoreDb, "collection").mockImplementation(() => { throw new Error("down"); });
    await expect(savePriceQuote("u1", cart, {}, 10, NOW)).resolves.toBeUndefined();
    await expect(loadPriceQuote("u1", cart, NOW)).resolves.toBeNull();
    spy.mockRestore();
  });
});
