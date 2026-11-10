import {createHmac} from "node:crypto";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {orderRef} from "../src/firestorePaths";
import {CashfreeGateway, cashfreeCheckoutPage, type CashfreeConfig} from "../src/services/cashfree";
import {applyVerifiedPayment, checkOrderPaymentStatus, closeUnpaidPaymentAttempts, initiatePayment, refundCancelledOrderPayment, type PaymentDatabase} from "../src/services/payments";
import type {SavrivoOrder} from "../src/types";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

class Db extends InMemoryFirestore implements PaymentDatabase {}

const SECRET = "cf-test-secret";
const config = (): CashfreeConfig => ({
  appId: "cf-app", secretKey: SECRET, env: "sandbox",
  checkoutUrl: "https://example.test/cashfreeCheckout", webhookUrl: "https://example.test/cashfreeWebhook",
});

function order(overrides: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "SV-CF-ORDER-1", schemaVersion: 3, idempotencyKey: "checkout-idem-1",
    customerId: "customer-1", customerName: "Ravi Kumar", customerPhone: "+91 98765 43210",
    restaurantId: "restaurant-1", restaurant: "The Waffle Spot",
    restaurantLocation: {address: "Main road", lat: 13.9, lng: 79.9},
    items: [{itemId: "i1", name: "Waffle", quantity: 1, price: 100, variant: "", variantPrice: 0, addOns: [], addOnTotal: 0, note: "", diet: "veg"}],
    pricing: {subtotal: 100, discount: 0, deliveryFee: 10, smallOrderFee: 0, lateNightFee: 0, rainFee: 0, surgeFee: 0, platformFee: 5, tax: 4.99, tip: 0, currency: "INR", source: "catalog_snapshot_v3"},
    pricingContext: {distanceKm: 1, platformFeeRule: "test", weatherSeverity: "none", surgeActiveOrders: 0, pricedAt: 1_000},
    total: 119.99, coupon: "", paymentMethod: "upi", paymentProvider: "cashfree", paymentState: "pending",
    paymentPhase: "pending", terminalPhase: "none", deliveryMode: "asap",
    address: {id: "a1", label: "Home", area: "Naidupeta", address: "Door 1", phone: "9876543210", source: "manual", lat: 13.91, lng: 79.91, updatedAt: 1_000},
    instructions: "", contactless: false, status: "Order placed",
    statusHistory: {e1: {status: "Order placed", at: 1_000, actorId: "customer-1", actorRole: "customer"}},
    createdAt: 1_000, updatedAt: 1_000, etaMin: 25, etaMax: 35,
    ...overrides,
  } as SavrivoOrder;
}

/** A tiny stand-in for Cashfree's PG API. */
function fakeCashfree() {
  const orders = new Map<string, {order_id: string; order_amount: number; order_status: string; payment_session_id: string; order_expiry_time: string}>();
  const payments = new Map<string, Array<{cf_payment_id: number; payment_status: string; payment_amount: number}>>();
  const refunds = new Map<string, {cf_refund_id: number; refund_id: string; refund_status: string; refund_amount: number; order_id: string}>();
  const outage = {refunds: false};
  const calls: Array<{method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown>}> = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({method, url, headers: init?.headers as Record<string, string>, ...(body ? {body} : {})});
    const path = url.replace("https://sandbox.cashfree.com/pg", "");
    if (method === "POST" && path === "/orders") {
      const id = String(body?.order_id);
      if (orders.has(id)) return new Response(JSON.stringify({code: "order_already_exists"}), {status: 409});
      const o = {order_id: id, order_amount: Number(body?.order_amount), order_status: "ACTIVE", payment_session_id: `session_${id}abcdef`, order_expiry_time: String(body?.order_expiry_time)};
      orders.set(id, o);
      return new Response(JSON.stringify(o), {status: 200});
    }
    const r = path.match(/^\/orders\/([A-Z0-9_]+)\/refunds(?:\/([A-Z0-9_]+))?$/);
    if (r) {
      if (outage.refunds) return new Response("{}", {status: 503});
      if (method === "GET") {
        const found = refunds.get(r[2] ?? "");
        return found ? new Response(JSON.stringify(found), {status: 200}) : new Response("{}", {status: 404});
      }
      const o = orders.get(r[1]!);
      if (!o || o.order_status !== "PAID") return new Response(JSON.stringify({code: "refund_invalid", message: "order is not paid"}), {status: 400});
      const id = String(body?.refund_id);
      if (refunds.has(id)) return new Response(JSON.stringify({code: "refund_already_exists"}), {status: 409});
      const made = {cf_refund_id: 7000 + refunds.size, refund_id: id, refund_status: "PENDING", refund_amount: Number(body?.refund_amount), order_id: r[1]!};
      refunds.set(id, made);
      return new Response(JSON.stringify(made), {status: 200});
    }
    const m = path.match(/^\/orders\/([A-Z0-9_]+)(\/payments)?$/);
    if (method === "GET" && m) {
      if (m[2]) return new Response(JSON.stringify(payments.get(m[1]!) ?? []), {status: 200});
      const o = orders.get(m[1]!);
      return o ? new Response(JSON.stringify(o), {status: 200}) : new Response("{}", {status: 404});
    }
    if (method === "PATCH" && m && !m[2]) {
      const o = orders.get(m[1]!);
      if (!o) return new Response("{}", {status: 404});
      // Any UPI try left open on the order (even one the customer backed out of, NOT_ATTEMPTED):
      // Cashfree only accepts the request, as it did in production on 2 Nov.
      o.order_status = payments.get(m[1]!)?.some((p) => ["PENDING", "NOT_ATTEMPTED"].includes(p.payment_status)) ? "TERMINATION_REQUESTED" : "TERMINATED";
      return new Response(JSON.stringify(o), {status: 200});
    }
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  return {orders, payments, refunds, outage, calls, http};
}

function signed(body: unknown, at = Date.now()): {headers: Record<string, string>; raw: Buffer} {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac("sha256", SECRET).update(String(at) + raw.toString("utf8")).digest("base64");
  return {headers: {"x-webhook-signature": sig, "x-webhook-timestamp": String(at)}, raw};
}

function paymentWebhook(type: string, orderId: string, cfPaymentId: number, status: string, amount = 119.99) {
  return {type, data: {order: {order_id: orderId, order_amount: amount}, payment: {cf_payment_id: cfPaymentId, payment_status: status, payment_amount: amount}}};
}

async function started() {
  const db = new Db();
  const cf = fakeCashfree();
  const gateway = new CashfreeGateway(config, cf.http);
  const source = order();
  db.seed(orderRef(db, source.id).path, source);
  const intent = await initiatePayment(source.customerId, {customerId: source.customerId, orderId: source.id, provider: "phonepe"}, gateway, db);
  return {db, cf, gateway, source, intent};
}

describe("Cashfree payments", () => {
  it("is off until both keys are set", () => {
    expect(new CashfreeGateway(() => ({...config(), secretKey: ""})).configured).toBe(false);
    expect(new CashfreeGateway(config).configured).toBe(true);
  });

  it("creates a Cashfree order for the exact amount and returns our checkout link", async () => {
    const {cf, intent} = await started();
    const create = cf.calls.find((c) => c.method === "POST");
    expect(create?.body).toMatchObject({order_amount: 119.99, order_currency: "INR", customer_details: {customer_phone: "9876543210"}});
    expect(create?.headers["x-api-version"]).toBe("2023-08-01");
    expect(create?.headers["x-idempotency-key"]).toBeTruthy();
    expect(String((create?.body?.customer_details as Record<string, string>).customer_id)).not.toContain("customer-1");
    expect(intent.provider).toBe("cashfree");
    expect(intent.redirectUrl).toMatch(/^https:\/\/example\.test\/cashfreeCheckout\?op=pay&order_id=SVPAY_[A-F0-9]{32}&session=session_[^&]+&env=sandbox$/);
  });

  it("a retried attempt reuses the session Cashfree already has", async () => {
    const cf = fakeCashfree();
    const gateway = new CashfreeGateway(config, cf.http);
    const req = {merchantOrderId: "SVPAY_0123456789ABCDEF0123456789ABCDEF", idempotencyKey: "k"};
    const first = await gateway.createIntent(order(), req);
    const second = await gateway.createIntent(order(), req);
    expect(second.redirectUrl).toBe(first.redirectUrl);
  });

  it("a signed success webhook that Cashfree confirms marks the order paid, once", async () => {
    const {db, cf, gateway, source, intent} = await started();
    cf.orders.get(intent.merchantOrderId)!.order_status = "PAID";
    cf.payments.set(intent.merchantOrderId, [{cf_payment_id: 555, payment_status: "SUCCESS", payment_amount: 119.99}]);
    const {headers, raw} = signed(paymentWebhook("PAYMENT_SUCCESS_WEBHOOK", intent.merchantOrderId, 555, "SUCCESS"));
    const result = await gateway.verifyWebhook(headers, raw);
    expect(result).toMatchObject({verified: true, provider: "cashfree", state: "paid", amountPaise: 11_999, providerTransactionId: "555"});
    if (!result.verified) throw new Error("not verified");
    await applyVerifiedPayment(result, db);
    await applyVerifiedPayment(result, db);
    expect((db.read(orderRef(db, source.id).path) as SavrivoOrder).paymentState).toBe("paid");
  });

  it("closing an unpaid order terminates it at Cashfree so no payment can land later", async () => {
    const {db, cf, gateway, source, intent} = await started();
    await closeUnpaidPaymentAttempts(source.id, gateway, db);
    expect(cf.orders.get(intent.merchantOrderId)!.order_status).toBe("TERMINATED");
    expect(cf.calls.some((c) => c.method === "PATCH" && c.body?.order_status === "TERMINATED")).toBe(true);
    await closeUnpaidPaymentAttempts(source.id, gateway, db);
  });

  it("won't close an order Cashfree says is paid, or one with a payment in flight", async () => {
    const paid = await started();
    paid.cf.orders.get(paid.intent.merchantOrderId)!.order_status = "PAID";
    await expect(closeUnpaidPaymentAttempts(paid.source.id, paid.gateway, paid.db)).rejects.toMatchObject({code: "already-exists"});
    const busy = await started();
    busy.cf.payments.set(busy.intent.merchantOrderId, [{cf_payment_id: 9, payment_status: "PENDING", payment_amount: 119.99}]);
    await expect(closeUnpaidPaymentAttempts(busy.source.id, busy.gateway, busy.db)).rejects.toMatchObject({code: "unavailable"});
  });

  it("closes an order whose UPI tries were all abandoned, though Cashfree only accepts the request", async () => {
    // Production, 2 Nov 7:39 and 7:48: PhonePe opened and backed out of, then "Cancel this order" or COD.
    const left = await started();
    left.cf.payments.set(left.intent.merchantOrderId, [
      {cf_payment_id: 1, payment_status: "NOT_ATTEMPTED", payment_amount: 119.99},
      {cf_payment_id: 2, payment_status: "USER_DROPPED", payment_amount: 119.99},
    ]);
    await closeUnpaidPaymentAttempts(left.source.id, left.gateway, left.db);
    expect(left.cf.orders.get(left.intent.merchantOrderId)!.order_status).toBe("TERMINATION_REQUESTED");
    // Asked again while Cashfree is still finishing: still closed, without a second terminate.
    await closeUnpaidPaymentAttempts(left.source.id, left.gateway, left.db);
    expect(left.cf.calls.filter((c) => c.method === "PATCH").length).toBe(1);
    // Money that landed meanwhile is never cancelled.
    left.cf.payments.get(left.intent.merchantOrderId)!.push({cf_payment_id: 3, payment_status: "SUCCESS", payment_amount: 119.99});
    await expect(closeUnpaidPaymentAttempts(left.source.id, left.gateway, left.db)).rejects.toMatchObject({code: "already-exists"});
  });

  it("tells the waiting app whether the money came in", async () => {
    const {db, cf, gateway, source, intent} = await started();
    expect(await checkOrderPaymentStatus(source.customerId, source.id, gateway, db)).toBe("not_paid");
    cf.payments.set(intent.merchantOrderId, [{cf_payment_id: 1, payment_status: "PENDING", payment_amount: 119.99}]);
    expect(await checkOrderPaymentStatus(source.customerId, source.id, gateway, db)).toBe("pending");
    cf.payments.set(intent.merchantOrderId, [{cf_payment_id: 1, payment_status: "SUCCESS", payment_amount: 119.99}]);
    expect(await checkOrderPaymentStatus(source.customerId, source.id, gateway, db)).toBe("received");
    await expect(checkOrderPaymentStatus("someone-else", source.id, gateway, db)).rejects.toMatchObject({code: "not-found"});
  });

  it("refuses forged, replayed or contradicted webhooks", async () => {
    const {cf, gateway, intent} = await started();
    const body = paymentWebhook("PAYMENT_SUCCESS_WEBHOOK", intent.merchantOrderId, 555, "SUCCESS");
    const forged = signed(body);
    forged.headers["x-webhook-signature"] = createHmac("sha256", "wrong").update("x").digest("base64");
    expect(await gateway.verifyWebhook(forged.headers, forged.raw)).toMatchObject({verified: false, reason: "BAD_SIGNATURE"});
    const old = signed(body, Date.now() - 60 * 60_000);
    expect(await gateway.verifyWebhook(old.headers, old.raw)).toMatchObject({verified: false, reason: "STALE_WEBHOOK"});
    // Correctly signed, but Cashfree's own record says it isn't paid.
    cf.payments.set(intent.merchantOrderId, [{cf_payment_id: 555, payment_status: "PENDING", payment_amount: 119.99}]);
    const real = signed(body);
    expect(await gateway.verifyWebhook(real.headers, real.raw)).toMatchObject({verified: false, reason: "NOT_PAID_AT_CASHFREE"});
  });

  it("a failed try is recorded as failed, but ignored once another try paid", async () => {
    const {cf, gateway, intent} = await started();
    cf.payments.set(intent.merchantOrderId, [{cf_payment_id: 1, payment_status: "FAILED", payment_amount: 119.99}]);
    const failed = signed(paymentWebhook("PAYMENT_FAILED_WEBHOOK", intent.merchantOrderId, 1, "FAILED"));
    expect(await gateway.verifyWebhook(failed.headers, failed.raw)).toMatchObject({verified: true, state: "failed"});
    cf.orders.get(intent.merchantOrderId)!.order_status = "PAID";
    expect(await gateway.verifyWebhook(failed.headers, failed.raw)).toMatchObject({verified: false, reason: "IGNORED_ORDER_ALREADY_PAID"});
  });

  async function paidOrder() {
    const s = await started();
    s.cf.orders.get(s.intent.merchantOrderId)!.order_status = "PAID";
    s.cf.payments.set(s.intent.merchantOrderId, [{cf_payment_id: 555, payment_status: "SUCCESS", payment_amount: 119.99}]);
    const {headers, raw} = signed(paymentWebhook("PAYMENT_SUCCESS_WEBHOOK", s.intent.merchantOrderId, 555, "SUCCESS"));
    const result = await s.gateway.verifyWebhook(headers, raw);
    if (!result.verified) throw new Error("not verified");
    await applyVerifiedPayment(result, s.db);
    return s;
  }
  function cancel(db: Db, id: string) {
    const current = db.read(orderRef(db, id).path) as SavrivoOrder;
    db.seed(orderRef(db, id).path, {...current, status: "Cancelled"});
  }
  const readOrder = (db: Db, id: string) => db.read(orderRef(db, id).path) as SavrivoOrder;

  it("refunds a paid order in full, once, when it is cancelled", async () => {
    const {db, cf, gateway, source, intent} = await paidOrder();
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("nothing_to_refund");
    expect(cf.refunds.size).toBe(0);
    cancel(db, source.id);
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("refund_started");
    expect([...cf.refunds.values()]).toEqual([expect.objectContaining({order_id: intent.merchantOrderId, refund_amount: 119.99})]);
    expect(readOrder(db, source.id).paymentPhase).toBe("refund_pending");
    // Asked again (trigger retry, sweep): no second refund.
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("already_refunding");
    expect(cf.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refunds")).length).toBe(1);
    // Cashfree's refund webhook finishes it.
    const made = [...cf.refunds.values()][0]!;
    made.refund_status = "SUCCESS";
    const hook = signed({type: "REFUND_STATUS_WEBHOOK", data: {refund: {order_id: intent.merchantOrderId, refund_id: made.refund_id}}});
    const verified = await gateway.verifyWebhook(hook.headers, hook.raw);
    if (!verified.verified) throw new Error("refund webhook not verified");
    await applyVerifiedPayment(verified, db);
    expect(readOrder(db, source.id).paymentState).toBe("refunded");
  });

  it("refunds a payment that lands after the customer gave up on the order", async () => {
    const {db, cf, gateway, source, intent} = await started();
    cancel(db, source.id);
    cf.orders.get(intent.merchantOrderId)!.order_status = "PAID";
    cf.payments.set(intent.merchantOrderId, [{cf_payment_id: 556, payment_status: "SUCCESS", payment_amount: 119.99}]);
    const late = signed(paymentWebhook("PAYMENT_SUCCESS_WEBHOOK", intent.merchantOrderId, 556, "SUCCESS"));
    const result = await gateway.verifyWebhook(late.headers, late.raw);
    if (!result.verified) throw new Error("not verified");
    await applyVerifiedPayment(result, db);
    expect(readOrder(db, source.id)).toMatchObject({status: "Cancelled", paymentState: "paid"});
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("refund_started");
    expect(cf.refunds.size).toBe(1);
  });

  it("keeps trying while Cashfree is down, without ever refunding twice", async () => {
    const {db, cf, gateway, source} = await paidOrder();
    cancel(db, source.id);
    cf.outage.refunds = true;
    await expect(refundCancelledOrderPayment(source.id, gateway, db)).rejects.toMatchObject({code: "unavailable"});
    expect(readOrder(db, source.id).paymentPhase).toBe("refund_pending");
    cf.outage.refunds = false;
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("refund_started");
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("already_refunding");
    expect(cf.refunds.size).toBe(1);
  });

  it("a refund Cashfree refuses is marked failed for a person to check", async () => {
    const {db, cf, gateway, source, intent} = await paidOrder();
    cancel(db, source.id);
    cf.orders.get(intent.merchantOrderId)!.order_status = "ACTIVE"; // Cashfree answers 400: nothing paid to refund
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("rejected");
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("rejected");
    expect(cf.refunds.size).toBe(0);
  });

  it("never refunds cash orders or unpaid ones", async () => {
    const {db, gateway, source} = await started();
    cancel(db, source.id);
    expect(await refundCancelledOrderPayment(source.id, gateway, db)).toBe("nothing_to_refund");
    const cod = new Db();
    cod.seed(orderRef(cod, "SV-COD-1").path, order({id: "SV-COD-1", paymentMethod: "cod", paymentState: "cash_due", status: "Cancelled"}));
    expect(await refundCancelledOrderPayment("SV-COD-1", gateway, cod)).toBe("nothing_to_refund");
  });

  it("acknowledges event types it doesn't act on", async () => {
    const {gateway} = await started();
    const other = signed({type: "SETTLEMENT_WEBHOOK", data: {}});
    expect(await gateway.verifyWebhook(other.headers, other.raw)).toMatchObject({verified: false, reason: "IGNORED_SETTLEMENT_WEBHOOK"});
  });

  it("the checkout page only opens real-looking sessions, safely quoted", () => {
    expect(cashfreeCheckoutPage({op: "pay", session: "session_abcDEF123456"}, "production").html)
      .toContain("Cashfree({mode:\"production\"})");
    expect(cashfreeCheckoutPage({op: "pay", session: "session_x\"><script>alert(1)</script>"}, "sandbox").status).toBe(400);
    expect(cashfreeCheckoutPage({op: "return"}, "sandbox").html).toContain("Go back to the Scraveit app");
  });
});
