import {randomBytes} from "node:crypto";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {priceCart, roundMoney} from "../domain/order";
import {DomainError} from "../errors";
import type {SavrivoOrder} from "../types";
import {loadAccountAge} from "./accountAge";
import {loadCustomerAddress, loadRestaurantAndMenu} from "./catalog";
import {notifyUserChat} from "./notifications";
import {createAuthoritativeOrder} from "./orders";

/**
 * "Ask a parent to pay": an under-18 whose parent approved their account sends
 * the cart to that parent, who places and pays for it from their own app.
 *
 *  - No money is held for the child, so this is not a wallet or prepaid
 *    instrument (RBI Master Direction on PPIs does not apply). The parent pays
 *    the order directly, by cash at the door or online once payments are live.
 *  - The order is the child's (their address, their delivery OTP, their
 *    tracking). The parent is recorded as `payerUid` and can start the online
 *    payment for it.
 *  - Prices are always worked out again on the server when the parent approves;
 *    the request only carries what the child picked.
 */

type Rec = Record<string, unknown>;

/** How long the parent has to answer before the request lapses. */
export const PARENT_PAY_TTL_MS = 30 * 60 * 1000;

const requests = () => firestoreDb.collection("parentPayRequests");

export interface ParentPayRequestInput {
  restaurantId: string;
  addressId: string;
  items: Array<{itemId: string; quantity: number; variantId?: string; addOnIds: string[]; note: string}>;
  instructions: string;
  contactless: boolean;
  tip: number;
  /** What the child's checkout showed, so the parent sees the same figure. Re-priced on approval. */
  shownTotal?: number;
}

/** Is a request still open for the parent to answer? */
export function parentPayOpen(request: Rec | null, now: number): boolean {
  return !!request && request.status === "pending" && Number(request.expiresAt ?? 0) > now;
}

/** The figure the parent sees: the child's shown total, kept within sensible bounds of the server's food total. */
export function shownEstimate(subtotal: number, shownTotal: number | undefined): number {
  const shown = Number(shownTotal);
  if (!Number.isFinite(shown) || shown < subtotal || shown > subtotal * 2 + 300) return roundMoney(subtotal);
  return roundMoney(shown);
}

async function linkedParent(uid: string): Promise<{parentUid: string; parentName: string}> {
  const me = await loadAccountAge(uid);
  if (!me || me.minor !== true || !me.parentUid) {
    throw new DomainError("failed-precondition", "Ask a parent to pay is for under-18 accounts with a linked parent.");
  }
  if (me.parentStatus !== "approved") throw new DomainError("failed-precondition", "Your parent needs to approve your account first.");
  return {parentUid: String(me.parentUid), parentName: String(me.parentName ?? "")};
}

async function childName(uid: string): Promise<string> {
  const user = await firestoreDb.collection("users").doc(uid).get().catch(() => null);
  return user?.exists ? String((user.data() as Rec).name ?? "").slice(0, 60) : "";
}

export async function parentPayRequest(uid: string, input: ParentPayRequestInput, now = Date.now()) {
  const {parentUid, parentName} = await linkedParent(uid);
  const [{restaurant, menuById}, {address}] = await Promise.all([
    loadRestaurantAndMenu(input.restaurantId),
    loadCustomerAddress(uid, input.addressId),
  ]);
  let priced: ReturnType<typeof priceCart>;
  try {
    priced = priceCart(input.items, menuById);
  } catch {
    throw new DomainError("failed-precondition", "Something in your cart changed. Check your cart and try again.");
  }
  // One open request per child: a new one replaces the last.
  const open = await requests().where("childUid", "==", uid).where("status", "==", "pending").limit(5).get();
  await Promise.all(open.docs.map((doc) => doc.ref.set({status: "replaced", respondedAt: now}, {merge: true})));

  const id = `pp_${randomBytes(10).toString("hex")}`;
  const name = await childName(uid);
  const record = {
    id, childUid: uid, childName: name, parentUid, parentName,
    restaurantId: restaurant.id, restaurantName: String(restaurant.name ?? "").slice(0, 120),
    addressId: input.addressId,
    addressLabel: String(address.label || address.area || "").slice(0, 80),
    addressLine: String(address.address ?? "").slice(0, 200),
    cart: input.items,
    lines: priced.items.map((item) => ({
      name: item.name, quantity: item.quantity, variant: item.variant,
      amount: roundMoney((item.price + item.variantPrice + item.addOnTotal) * item.quantity),
    })),
    subtotal: priced.subtotal,
    estimate: shownEstimate(priced.subtotal, input.shownTotal),
    instructions: input.instructions, contactless: input.contactless, tip: input.tip,
    status: "pending", createdAt: now, expiresAt: now + PARENT_PAY_TTL_MS,
  };
  await requests().doc(id).set(record);
  await notifyUserChat({
    uid: parentUid, key: `parent-pay:${id}`,
    title: `${name || "Your child"} asked you to pay`,
    body: `₹${record.estimate} from ${record.restaurantName}. Open Scraveit to pay or decline.`,
    data: {route: "home"},
  }).catch((error) => logger.warn("PARENT_PAY_PUSH_FAILED", {error: String(error)}));
  return {requestId: id, status: "pending", parentName, estimate: record.estimate, expiresAt: record.expiresAt};
}

export async function parentPayCancel(uid: string, input: {requestId: string}, now = Date.now()) {
  const ref = requests().doc(input.requestId);
  const snap = await ref.get();
  const request = snap.exists ? snap.data() as Rec : null;
  if (!request || request.childUid !== uid) throw new DomainError("not-found", "That request isn't yours.");
  if (request.status !== "pending") return {status: String(request.status)};
  await ref.set({status: "cancelled", respondedAt: now}, {merge: true});
  return {status: "cancelled"};
}

export async function parentPayRespond(
  uid: string,
  input: {requestId: string; approve: boolean; paymentMethod: "cod" | "upi"},
  options: {onlineAvailable: boolean},
  now = Date.now(),
) {
  const ref = requests().doc(input.requestId);
  const snap = await ref.get();
  const request = snap.exists ? snap.data() as Rec : null;
  if (!request || request.parentUid !== uid) throw new DomainError("not-found", "That request isn't for you.");
  const childUid = String(request.childUid);
  const name = String(request.childName || "your child");

  // A second tap after the order went through just returns the same order.
  if (request.status === "approved" && request.orderId) return {status: "approved", orderId: String(request.orderId), order: null};
  if (!parentPayOpen(request, now)) {
    throw new DomainError("failed-precondition", request.status === "pending" ? "This request has expired. Ask them to send it again." : "This request was already answered.");
  }

  if (!input.approve) {
    await ref.set({status: "declined", respondedAt: now}, {merge: true});
    await notifyUserChat({uid: childUid, key: `parent-pay-reply:${input.requestId}`, title: "Your parent didn't pay for this order",
      body: `${request.restaurantName ?? "Your order"} wasn't placed.`, data: {route: "cart"}}).catch(() => undefined);
    return {status: "declined", orderId: "", order: null};
  }

  if (input.paymentMethod !== "cod" && !options.onlineAvailable) {
    throw new DomainError("failed-precondition", "Online payment isn't available yet. Choose cash on delivery.");
  }
  // Still linked and approved? (The parent may have revoked in the meantime.)
  const age = await loadAccountAge(childUid);
  if (!age || age.parentUid !== uid || age.parentStatus !== "approved") {
    throw new DomainError("failed-precondition", `${name}'s account is no longer linked to you.`);
  }

  let placed: Awaited<ReturnType<typeof createAuthoritativeOrder>>;
  try {
    placed = await createAuthoritativeOrder(childUid, {
      idempotencyKey: `parentpay_${input.requestId}`,
      restaurantId: String(request.restaurantId),
      addressId: String(request.addressId),
      items: request.cart as ParentPayRequestInput["items"],
      couponCode: "",
      tip: Number(request.tip ?? 0),
      deliveryMode: "asap",
      instructions: String(request.instructions ?? ""),
      contactless: request.contactless === true,
      useWallet: false,
      paymentMethod: input.paymentMethod,
      ...(input.paymentMethod === "upi" ? {paymentProvider: "cashfree" as const} : {}),
    }, {payerUid: uid});
  } catch (error) {
    await ref.set({lastError: error instanceof Error ? error.message.slice(0, 200) : "failed", updatedAt: now}, {merge: true});
    throw error;
  }
  const order: SavrivoOrder = placed.order;
  await ref.set({status: "approved", orderId: order.id, total: order.total, paymentMethod: order.paymentMethod, respondedAt: now,
    ...orderMirror(order)}, {merge: true});
  await notifyUserChat({uid: childUid, key: `parent-pay-reply:${input.requestId}`, title: "Your order is placed",
    body: input.paymentMethod === "cod" ? `Your parent placed it. Pay ₹${order.total} in cash at the door.` : "Your parent is paying for it now.",
    data: {route: "orders"}}).catch(() => undefined);
  return {status: "approved", orderId: order.id, order: {id: order.id, customerId: order.customerId, total: order.total, paymentMethod: order.paymentMethod, paymentProvider: order.paymentProvider ?? "", paymentState: order.paymentState}};
}

// ---- The parent follows the order they paid for ----

const IDEMPOTENCY_PREFIX = "parentpay_";

/** The parent-pay request behind an order, if a parent placed it. */
export function parentPayRequestId(order: Pick<SavrivoOrder, "idempotencyKey" | "payerUid">): string {
  const key = String(order.idempotencyKey ?? "");
  return order.payerUid && key.startsWith(IDEMPOTENCY_PREFIX) ? key.slice(IDEMPOTENCY_PREFIX.length) : "";
}

/** What the parent's card shows about the order. No address, OTP or rider phone. */
export function orderMirror(order: SavrivoOrder): Rec {
  return {
    orderStatus: order.status,
    orderStatusAt: Number(order.updatedAt ?? Date.now()),
    orderPaymentState: order.paymentState,
    total: order.total,
    riderName: (String(order.riderName ?? "").split(" ")[0] ?? "").slice(0, 40),
    etaMax: Number(order.etaMax ?? 0),
    ...(order.status === "Delivered" ? {deliveredAt: Number(order.updatedAt ?? Date.now())} : {}),
  };
}

/** The pushes a parent gets as the order moves. Other steps update the card quietly. */
export function parentStatusNotice(status: string, childName: string): {title: string; body: string} | null {
  const who = childName || "your child";
  if (status === "Accepted") return {title: "The restaurant accepted it", body: `They're making ${who}'s order.`};
  if (status === "Out for delivery") return {title: "On the way", body: `${who}'s order is out for delivery.`};
  if (status === "Delivered") return {title: "Delivered", body: `${who}'s order was delivered.`};
  if (status === "Cancelled") return {title: "Order cancelled", body: `${who}'s order was cancelled.`};
  return null;
}

export async function mirrorOrderToParent(order: SavrivoOrder, before: SavrivoOrder | undefined): Promise<void> {
  const requestId = parentPayRequestId(order);
  if (!requestId) return;
  const ref = requests().doc(requestId);
  const snap = await ref.get();
  const request = snap.exists ? snap.data() as Rec : null;
  if (!request || request.orderId !== order.id || request.parentUid !== order.payerUid) return;
  await ref.set(orderMirror(order), {merge: true});
  if (before?.status === order.status) return;
  const notice = parentStatusNotice(order.status, String(request.childName ?? ""));
  if (!notice) return;
  await notifyUserChat({uid: String(order.payerUid), key: `parent-pay-status:${order.id}:${order.status}`,
    title: notice.title, body: notice.body, data: {route: "home"}}).catch(() => undefined);
}
