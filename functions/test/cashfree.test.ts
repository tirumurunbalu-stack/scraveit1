import {createHmac} from "node:crypto";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {orderRef} from "../src/firestorePaths";
import {CashfreeGateway, cashfreeCheckoutPage, type CashfreeConfig} from "../src/services/cashfree";
import {applyVerifiedPayment, initiatePayment, type PaymentDatabase} from "../src/services/payments";
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
    const m = path.match(/^\/orders\/([A-Z0-9_]+)(\/payments)?$/);
    if (method === "GET" && m) {
      if (m[2]) return new Response(JSON.stringify(payments.get(m[1]!) ?? []), {status: 200});
      const o = orders.get(m[1]!);
      return o ? new Response(JSON.stringify(o), {status: 200}) : new Response("{}", {status: 404});
    }
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  return {orders, payments, calls, http};
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
