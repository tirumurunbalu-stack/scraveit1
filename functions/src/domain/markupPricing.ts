/**
 * GST-inclusive menu prices.
 *
 * A restaurant may type its prices with GST included (`pricesIncludeGst: true`,
 * its own switch). Customers then see those prices as they are, no food GST is
 * added at checkout, and Scraveit pays the GST inside them as the e-commerce
 * operator. Commission is charged as usual, on the value before GST.
 *
 * Markup pricing is set per restaurant by Scraveit (admin only):
 * `pricingModel: "markup"`, `markupBps` (1,000 = 10%). Prices always include GST.
 *
 * The restaurant types its menu prices with GST included (say ₹300). Customers
 * see that price plus the markup, GST included (₹330), and no food GST is
 * added at checkout. Scraveit pays the 5% food GST as the e-commerce operator
 * (CGST Act s.9(5)) and pays the restaurant its price less the GST inside it
 * (₹300 / 1.05 = ₹285.71). What is left is Scraveit's cut; the 18% GST on that
 * cut is Scraveit's too, never withheld from the restaurant.
 *
 * Server books stay GST-exclusive (food value before GST, plus GST), so the tax
 * engines, economics and settlement read these orders like any other. Only the
 * customer's view (item total and taxes) is shown GST-inclusive.
 */

export const FOOD_GST_BPS = 500;
export const COMMISSION_GST_BPS = 1_800;
export const DEFAULT_MARKUP_BPS = 1_000;

/** The restaurant's markup, or null when it is on ordinary commission pricing. */
export function markupBpsOf(restaurant: {pricingModel?: unknown; markupBps?: unknown}): number | null {
  if (restaurant.pricingModel !== "markup") return null;
  const raw = restaurant.markupBps;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MARKUP_BPS;
  const bps = Number(raw);
  return Number.isInteger(bps) && bps >= 0 && bps <= 5_000 ? bps : DEFAULT_MARKUP_BPS;
}

/**
 * Whether the restaurant's menu prices include GST: its own switch, or always
 * under markup pricing. Grocery, dairy and health care stores price each product with its own GST.
 */
export function pricesIncludeGst(restaurant: {pricingModel?: unknown; pricesIncludeGst?: unknown; storeType?: unknown}): boolean {
  if (restaurant.storeType === "grocery" || restaurant.storeType === "dairy" || restaurant.storeType === "pharmacy") return false;
  return restaurant.pricingModel === "markup" || restaurant.pricesIncludeGst === true;
}

/** priceCart's options for a restaurant. */
export function menuPricingOf(restaurant: {pricingModel?: unknown; markupBps?: unknown; pricesIncludeGst?: unknown; storeType?: unknown; freebies?: unknown}) {
  return {markupBps: markupBpsOf(restaurant), gstInclusive: pricesIncludeGst(restaurant), freebies: restaurant.freebies};
}

/**
 * What the customer sees for a restaurant price, GST included, in whole rupees.
 * The customer app runs the same formula, so menu and bill always agree.
 */
export function markedUpPrice(restaurantPrice: number, bps: number): number {
  if (!(restaurantPrice > 0)) return 0;
  return Math.round(restaurantPrice * (10_000 + bps) / 10_000);
}

/** The value before the 5% food GST inside a GST-inclusive amount, in paise. */
export function beforeFoodGstPaise(inclusivePaise: number): number {
  return Math.round(inclusivePaise * 10_000 / (10_000 + FOOD_GST_BPS));
}

/** priceCart's extra totals for a restaurant with GST-inclusive prices, in rupees. */
export interface MarkupCart {
  /** "inclusive": GST-inclusive prices on ordinary commission (bps is 0). Absent: markup pricing. */
  model?: "inclusive";
  bps: number;
  /** Food at customer prices, GST included: what the menu showed. */
  listSubtotal: number;
  /** The same food at the restaurant's own prices, GST included. */
  restaurantSubtotal: number;
}

/** Saved on the order's pricing: the bill as the customer saw it, and (markup only) the restaurant's payout. */
export interface MarkupBill {
  model?: "inclusive";
  bps: number;
  listSubtotal: number;
  restaurantSubtotal: number;
  /** GST inside the food, paid by Scraveit u/s 9(5). */
  foodGst: number;
  /** The discount as the customer sees it, GST included. */
  discount: number;
  /** Taxes shown on the customer's bill: GST on fees only. */
  tax: number;
  /** Markup only: paid to the restaurant for the food: its prices less the GST in them, less its own discount. */
  restaurantPayout?: number;
}

/** Markup pricing, where Scraveit's cut replaces the commission rate. */
export function isMarkupCart(cart: MarkupCart | undefined): cart is MarkupCart {
  return !!cart && cart.model !== "inclusive";
}

/**
 * Scraveit's whole cut before any discount: food value before GST at customer
 * prices, less the same at the restaurant's prices. Commission plus its GST.
 */
export function markupCutPaise(subtotalPaise: number, cart: MarkupCart): number {
  return Math.max(0, subtotalPaise - beforeFoodGstPaise(Math.round(cart.restaurantSubtotal * 100)));
}

/** The commission inside the cut once the 18% GST on it is taken out; the tax engines charge GST on this. */
export function markupCommissionPaise(cutPaise: number): number {
  return Math.round(cutPaise * 10_000 / (10_000 + COMMISSION_GST_BPS));
}

/**
 * The customer's tax for a markup order. `engineTaxPaise` is what the tax
 * engine put on the bill (null when no engine ran: the legacy flat food tax),
 * `engineFoodTaxPaise` the food part of it. Food GST is replaced by the GST
 * already inside the customer's prices; GST on fees stays on top.
 */
export function markupBill(input: {
  cart: MarkupCart;
  subtotalPaise: number;
  discountPaise: number;
  restaurantDiscountPaise: number;
  engineTaxPaise: number | null;
  engineFoodTaxPaise: number;
}): MarkupBill & {customerTaxPaise: number} {
  const listPaise = Math.round(input.cart.listSubtotal * 100);
  const feeTaxPaise = input.engineTaxPaise === null ? 0 : Math.max(0, input.engineTaxPaise - input.engineFoodTaxPaise);
  const discountPaise = Math.max(0, input.discountPaise);
  const shownDiscountPaise = Math.min(listPaise, Math.round(discountPaise * (10_000 + FOOD_GST_BPS) / 10_000));
  const foodGstPaise = Math.max(0, (listPaise - shownDiscountPaise) - (input.subtotalPaise - discountPaise));
  const restaurantPaise = beforeFoodGstPaise(Math.round(input.cart.restaurantSubtotal * 100));
  return {
    ...(input.cart.model ? {model: input.cart.model} : {}),
    bps: input.cart.bps,
    listSubtotal: input.cart.listSubtotal,
    restaurantSubtotal: input.cart.restaurantSubtotal,
    foodGst: foodGstPaise / 100,
    discount: shownDiscountPaise / 100,
    tax: feeTaxPaise / 100,
    ...(input.cart.model === "inclusive" ? {} :
      {restaurantPayout: Math.max(0, restaurantPaise - input.restaurantDiscountPaise) / 100}),
    customerTaxPaise: feeTaxPaise + foodGstPaise,
  };
}

/** The bill as saved on the order: without the books-only full tax figure. */
export function withoutCustomerTax(bill: MarkupBill & {customerTaxPaise: number}): MarkupBill {
  const {customerTaxPaise: _books, ...shown} = bill;
  return shown;
}

/** The small-order fee is judged on what the customer sees, GST included. */
export function markupFees<T extends {smallOrderThreshold: number; smallOrderFee: number}>(fees: T, cart: MarkupCart | undefined): T {
  if (!cart || !(fees.smallOrderThreshold > 0) || cart.listSubtotal < fees.smallOrderThreshold) return fees;
  return {...fees, smallOrderFee: 0};
}
