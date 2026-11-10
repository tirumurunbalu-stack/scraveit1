import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {economicsImbalancePaise} from "../src/domain/economics";
import {normalizeEconomicsControl} from "../src/domain/economicsControl";
import {
  beforeFoodGstPaise,
  markedUpPrice,
  markupBill,
  markupBpsOf,
  markupCommissionPaise,
  markupCutPaise,
  markupFees,
  menuPricingOf,
  withoutCustomerTax,
} from "../src/domain/markupPricing";
import {buildPricing, priceCart} from "../src/domain/order";
import {finalizeOrderEconomics, markupCheckoutBill, planCheckoutEconomics, type ServerFees} from "../src/services/economics";
import {orderDeliveryAmounts} from "../src/services/ledger";
import type {CatalogItem, PricingBreakdown} from "../src/types";

const NOW = Date.UTC(2026, 9, 30, 13, 0);
const menu: Record<string, CatalogItem> = {
  biryani: {id: "biryani", name: "Chicken biryani", price: 300,
    variants: [{id: "full", name: "Full", priceDelta: 50}], addOns: [{id: "raita", name: "Raita", price: 20}]},
  thali: {id: "thali", name: "Veg thali", price: 300},
};
const fees: ServerFees = {
  deliveryFee: 25, platformFee: 7, lateNightFee: 0, rainFee: 0, surgeFee: 0,
  riderIncentiveFee: 0, smallOrderThreshold: 0, smallOrderFee: 0,
};
const control = normalizeEconomicsControl({policies: {global: {
  minContributionPaisePerOrder: 800, targetContributionPaisePerOrder: 2_000,
  codHandlingCostPaise: 300, refundReserveBpsOfGmv: 0, supportCostPaisePerOrder: 200, otherVariableCostPaisePerOrder: 0,
}}});

function checkout(selections: Parameters<typeof priceCart>[0], promotion: Parameters<typeof planCheckoutEconomics>[0]["promotion"] = null,
  options: Parameters<typeof priceCart>[2] = {markupBps: 1_000}) {
  const cart = priceCart(selections, menu, options);
  const plan = planCheckoutEconomics({
    control, restaurant: {id: "r1", city: "Nellore"}, address: {area: "Magunta Layout", label: "Home"},
    subtotal: cart.subtotal, fees, paymentMethod: "cod", tip: 0, promotion, defaultCommissionBps: 1_500, now: NOW,
    ...(options.markupBps != null ? {markupCutPaise: markupCutPaise(Math.round(cart.subtotal * 100), cart.markup!)} : {}),
  });
  return {cart, plan};
}

describe("markup pricing", () => {
  it("is on only for markup restaurants, at 10% unless set", () => {
    expect(markupBpsOf({})).toBeNull();
    expect(markupBpsOf({pricingModel: "commission", markupBps: 1_000})).toBeNull();
    expect(markupBpsOf({pricingModel: "markup"})).toBe(1_000);
    expect(markupBpsOf({pricingModel: "markup", markupBps: 1_200})).toBe(1_200);
    expect(markupBpsOf({pricingModel: "markup", markupBps: 90_000})).toBe(1_000);
  });

  it("turns the restaurant's ₹300 into ₹330 for the customer, ₹314.29 + ₹15.71 GST in the books", () => {
    expect(markedUpPrice(300, 1_000)).toBe(330);
    expect(markedUpPrice(19, 1_000)).toBe(21);
    expect(beforeFoodGstPaise(33_000)).toBe(31_429);
    const {items, subtotal, markup} = priceCart([{itemId: "biryani", quantity: 1, variantId: "full", addOnIds: ["raita"]}], menu, {markupBps: 1_000});
    // 330 + 55 + 22: each part marked up the way the menu shows it.
    expect(items[0]).toMatchObject({price: 314.29, variantPrice: 52.38, addOnTotal: 20.95, listPrice: 407, restaurantPrice: 370});
    expect(subtotal).toBe(387.62);
    expect(markup).toEqual({bps: 1_000, listSubtotal: 407, restaurantSubtotal: 370});
    // Ordinary restaurants are priced exactly as before.
    expect(priceCart([{itemId: "biryani", quantity: 1, variantId: "full"}], menu)).toEqual({
      items: [expect.not.objectContaining({listPrice: expect.anything()})], subtotal: 350,
    });
  });

  it("charges the customer ₹330 + fees, pays the restaurant ₹285.71 and balances to the paisa", () => {
    const {cart, plan} = checkout([{itemId: "thali", quantity: 1}]);
    const bill = markupCheckoutBill(cart.markup!, {subtotal: cart.subtotal, plan, tax: null});
    expect(bill).toMatchObject({foodGst: 15.71, tax: 0, discount: 0, restaurantPayout: 285.71, customerTaxPaise: 1_571});
    const {pricing, total} = buildPricing({subtotal: cart.subtotal, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 5, tip: 0,
      taxOverride: bill.customerTaxPaise / 100});
    expect(total).toBe(362); // 330 + 25 + 7: no food GST on top
    const snapshot = finalizeOrderEconomics(plan, pricing, total, "r1", "cod", []);
    expect(snapshot.restaurant.receivablePaise).toBe(28_571);
    expect(snapshot.restaurant.commissionPaise).toBe(2_858);
    expect(snapshot.customer.payablePaise).toBe(36_200);
    expect(economicsImbalancePaise(snapshot)).toBe(0);
  });

  it("keeps the 18% GST on Scraveit's cut out of the restaurant's payout", () => {
    const {cart, plan} = checkout([{itemId: "thali", quantity: 1}]);
    const commissionGst = Math.round(markupCommissionPaise(plan.markupCutPaise!) * 1_800 / 10_000);
    const bill = markupCheckoutBill(cart.markup!, {subtotal: cart.subtotal, plan, tax: null});
    const {pricing, total} = buildPricing({subtotal: cart.subtotal, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 5, tip: 0,
      taxOverride: bill.customerTaxPaise / 100});
    const snapshot = finalizeOrderEconomics(plan, pricing, total, "r1", "cod", [], {commissionTaxPaise: commissionGst});
    expect(commissionGst).toBe(436);
    expect(snapshot.restaurant.receivablePaise).toBe(28_571);
    expect(snapshot.restaurant.commissionPaise + (snapshot.restaurant.commissionTaxPaise ?? 0)).toBe(2_858);
    expect(economicsImbalancePaise(snapshot)).toBe(0);
  });

  it("swaps the engine's food GST for the GST inside the price and keeps GST on fees on top", () => {
    const {cart, plan} = checkout([{itemId: "thali", quantity: 2}]);
    const tax = {versionId: "v1", customerTaxPaise: 3_143 + 126, restaurantTaxPaise: 0, lines: [
      {component: "food", basePaise: 62_858, rateBps: 500, taxPaise: 3_143, inclusive: false},
      {component: "platform_fee", basePaise: 700, rateBps: 1_800, taxPaise: 126, inclusive: false},
    ]} as never;
    const bill = markupCheckoutBill(cart.markup!, {subtotal: cart.subtotal, plan, tax});
    expect(bill.tax).toBe(1.26);
    // ₹660 of food: 628.58 + 31.42 inside it.
    expect(bill.foodGst).toBe(31.42);
    expect(cart.subtotal * 100 + bill.customerTaxPaise - 126).toBe(66_000);
  });

  it("shows a discount GST-included, so item total less discount is what is paid for food", () => {
    const bill = markupBill({
      cart: {bps: 1_000, listSubtotal: 330, restaurantSubtotal: 300},
      subtotalPaise: 31_429, discountPaise: 6_286, restaurantDiscountPaise: 6_286, engineTaxPaise: null, engineFoodTaxPaise: 0,
    });
    expect(bill.discount).toBe(66);
    // Food paid: 330 - 66 = 264 = 251.43 + 12.57 GST.
    expect(31_429 - 6_286 + bill.customerTaxPaise).toBe(26_400);
    expect(bill.restaurantPayout).toBe(222.85);
    expect(withoutCustomerTax(bill)).not.toHaveProperty("customerTaxPaise");
  });

  it("judges the small-order fee on the GST-included food total", () => {
    const small = {...fees, smallOrderThreshold: 150, smallOrderFee: 15};
    expect(markupFees(small, {bps: 1_000, listSubtotal: 150, restaurantSubtotal: 136}).smallOrderFee).toBe(0);
    expect(markupFees(small, {bps: 1_000, listSubtotal: 149, restaurantSubtotal: 135}).smallOrderFee).toBe(15);
    expect(markupFees(small, undefined)).toBe(small);
  });

  it("settles a markup order without an economics snapshot at the restaurant's payout", () => {
    const pricing = {subtotal: 314.29, discount: 0, deliveryFee: 25, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0,
      riderIncentiveFee: 0, platformFee: 7, tax: 15.71, tip: 0, currency: "INR", source: "catalog_snapshot_v3",
      markup: {bps: 1_000, listSubtotal: 330, restaurantSubtotal: 300, foodGst: 15.71, discount: 0, tax: 0, restaurantPayout: 285.71},
    } as PricingBreakdown;
    const amounts = orderDeliveryAmounts({total: 362, pricing}, 1_500);
    expect(amounts.restaurantPayablePaise).toBe(28_571);
    expect(amounts.platformCommissionPaise).toBe(2_858);
    expect(amounts.taxPayablePaise).toBe(1_571);
  });

  it("prices a GST-inclusive restaurant as typed, adds no food GST and charges its usual commission", () => {
    expect(menuPricingOf({})).toEqual({markupBps: null, gstInclusive: false});
    expect(menuPricingOf({pricesIncludeGst: true})).toEqual({markupBps: null, gstInclusive: true});
    expect(menuPricingOf({pricingModel: "markup"})).toEqual({markupBps: 1_000, gstInclusive: true});
    expect(menuPricingOf({pricesIncludeGst: true, storeType: "grocery"})).toEqual({markupBps: null, gstInclusive: false});
    expect(menuPricingOf({pricesIncludeGst: true, storeType: "pharmacy"})).toEqual({markupBps: null, gstInclusive: false});
    const {cart, plan} = checkout([{itemId: "thali", quantity: 1}], null, {gstInclusive: true});
    expect(cart.items[0]).toMatchObject({price: 285.71, listPrice: 300, restaurantPrice: 300});
    expect(cart.markup).toEqual({model: "inclusive", bps: 0, listSubtotal: 300, restaurantSubtotal: 300});
    expect(plan.markupCutPaise).toBeUndefined();
    const bill = markupCheckoutBill(cart.markup!, {subtotal: cart.subtotal, plan, tax: null});
    expect(bill).toMatchObject({model: "inclusive", foodGst: 14.29, tax: 0, discount: 0, customerTaxPaise: 1_429});
    expect(bill).not.toHaveProperty("restaurantPayout");
    const {pricing, total} = buildPricing({subtotal: cart.subtotal, discount: 0, deliveryFee: 25, platformFee: 7, taxRate: 5, tip: 0,
      taxOverride: bill.customerTaxPaise / 100});
    expect(total).toBe(332); // 300 + 25 + 7
    const snapshot = finalizeOrderEconomics(plan, pricing, total, "r1", "cod", []);
    // 15% of the ₹285.71 before GST.
    expect(snapshot.restaurant.commissionPaise).toBe(4_286);
    expect(snapshot.restaurant.receivablePaise).toBe(24_285);
    expect(economicsImbalancePaise(snapshot)).toBe(0);
  });

  it("settles a GST-inclusive order without a snapshot at the usual commission", () => {
    const pricing = {subtotal: 285.71, discount: 0, deliveryFee: 25, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0,
      riderIncentiveFee: 0, platformFee: 7, tax: 14.29, tip: 0, currency: "INR", source: "catalog_snapshot_v3",
      markup: {model: "inclusive", bps: 0, listSubtotal: 300, restaurantSubtotal: 300, foodGst: 14.29, discount: 0, tax: 0},
    } as PricingBreakdown;
    const amounts = orderDeliveryAmounts({total: 332, pricing}, 1_500);
    expect(amounts.platformCommissionPaise).toBe(4_286);
    expect(amounts.restaurantPayablePaise).toBe(24_285);
  });
});
