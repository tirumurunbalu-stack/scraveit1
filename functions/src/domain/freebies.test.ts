import {describe, expect, it} from "vitest";
import {priceCart} from "./order";
import type {CatalogItem} from "../types";

const menu = {
  box: {id: "box", name: "Crispy Box", price: 299, diet: "nonveg"},
  wings: {id: "wings", name: "6 Wings", price: 270, diet: "nonveg"},
} as unknown as Record<string, CatalogItem>;
const fries = {id: "f1", title: "Free French fries", freeItem: "French Fries", diet: "veg", trigger: "items", itemIds: ["box"], active: true};
const sweet = {id: "f2", title: "Finish sweetly", freeItem: "Gulab Jamun", trigger: "amount", minimumOrder: 499, active: true};

describe("free-item offers", () => {
  it("adds one free item per chosen dish at ₹0, leaving the item total alone", () => {
    const {items, subtotal} = priceCart([{itemId: "box", quantity: 2}, {itemId: "wings", quantity: 1}], menu, {freebies: [fries]});
    expect(subtotal).toBe(868);
    expect(items.at(-1)).toMatchObject({name: "French Fries", quantity: 2, price: 0, free: true, freebieId: "f1", note: "Free French fries"});
  });
  it("gives the minimum-order item only once the item total reaches it", () => {
    expect(priceCart([{itemId: "box", quantity: 1}], menu, {freebies: [sweet]}).items).toHaveLength(1);
    const {items} = priceCart([{itemId: "box", quantity: 1}, {itemId: "wings", quantity: 1}], menu, {freebies: [sweet]});
    expect(items.at(-1)).toMatchObject({name: "Gulab Jamun", quantity: 1, price: 0});
  });
  it("skips paused and malformed offers", () => {
    const {items} = priceCart([{itemId: "box", quantity: 3}], menu, {freebies: [{...fries, active: false}, {id: "x", trigger: "items", itemIds: []}, "junk"]});
    expect(items).toHaveLength(1);
  });
});
