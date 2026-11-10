import {createHash} from "node:crypto";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";

/**
 * The price a customer was shown. getCheckoutConfiguration saves it for that
 * exact cart and Place order charges it, so rain, demand or a settings change
 * after the customer saw the total can't change what they pay. It lives only
 * on the server: the app just says which total it showed, and that counts only
 * when it matches what the server itself quoted this account for this cart.
 */
export const PRICE_QUOTE_VALID_MS = 15 * 60 * 1000;

/** What the fees depend on. Coupon, tip and wallet are not fees: the shown total has to match for those. */
export interface PriceQuoteCart {
  restaurantId: string;
  addressId: string;
  lat: number;
  lng: number;
  items: readonly {itemId: string; quantity: number; variantId?: string | undefined; addOnIds: readonly string[]}[];
}

export function priceQuoteDocId(uid: string, cart: PriceQuoteCart): string {
  const key = JSON.stringify([
    cart.restaurantId, cart.addressId, cart.lat, cart.lng,
    cart.items.map((line) => [line.itemId, line.quantity, line.variantId ?? "", line.addOnIds]),
  ]);
  return createHash("sha256").update(`${uid}\n${key}`).digest("hex");
}

/** Never fails the preview: with no saved quote the order is priced fresh and compared to the shown total. */
export async function savePriceQuote(uid: string, cart: PriceQuoteCart, fees: unknown, total: number, now: number): Promise<void> {
  try {
    await firestoreDb.collection("priceQuotes").doc(priceQuoteDocId(uid, cart)).set({
      uid,
      restaurantId: cart.restaurantId,
      fees: JSON.parse(JSON.stringify(fees)) as unknown,
      total,
      quotedAt: now,
      expiresAt: now + PRICE_QUOTE_VALID_MS,
      // Firestore's TTL policy can delete old quotes from this field.
      expireAt: new Date(now + PRICE_QUOTE_VALID_MS + 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    logger.warn("PRICE_QUOTE_SAVE_FAILED", {uid, restaurantId: cart.restaurantId, error});
  }
}

/** The saved quote for this account and cart while it is still valid; a read failure never blocks an order. */
export async function loadPriceQuote<F>(uid: string, cart: PriceQuoteCart, now: number): Promise<{fees: F; total: number} | null> {
  try {
    const snapshot = await firestoreDb.collection("priceQuotes").doc(priceQuoteDocId(uid, cart)).get();
    const quote = snapshot.exists ? snapshot.data() as {uid?: unknown; fees?: unknown; total?: unknown; expiresAt?: unknown} : null;
    if (!quote || quote.uid !== uid || !quote.fees || !Number.isFinite(Number(quote.total)) || !(Number(quote.expiresAt) > now)) return null;
    return {fees: quote.fees as F, total: Number(quote.total)};
  } catch (error) {
    logger.warn("PRICE_QUOTE_READ_FAILED", {uid, restaurantId: cart.restaurantId, error});
    return null;
  }
}
