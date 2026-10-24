import {createHash, createHmac} from "node:crypto";
import {logger} from "firebase-functions";
import {defineSecret, defineString} from "firebase-functions/params";
import {REGION} from "../config";
import {DomainError} from "../errors";
import type {SavrivoOrder} from "../types";
import {
  constantTimeStringEqual,
  type PaymentGateway, type PaymentIntent, type PaymentIntentRequest, type VerificationResult,
} from "./payments";

// Cashfree Payments (PG API 2023-08-01). The app opens our own checkout page,
// which hands the payment session to Cashfree's hosted checkout (UPI apps,
// cards, netbanking). An order is marked paid only from a signed webhook that
// we then re-check against Cashfree's own order record.
export const CASHFREE_APP_ID = defineSecret("CASHFREE_APP_ID");
export const CASHFREE_SECRET_KEY = defineSecret("CASHFREE_SECRET_KEY");
/** "sandbox" while testing with test keys; "production" with live keys. */
export const CASHFREE_ENV = defineString("CASHFREE_ENV", {default: "sandbox"});
export const CASHFREE_SECRETS = [CASHFREE_APP_ID, CASHFREE_SECRET_KEY];

const API_VERSION = "2023-08-01";
/** How long a payment link stays open. */
const SESSION_MINUTES = 20;
/** Webhooks older than this are refused (replay protection). */
const WEBHOOK_MAX_AGE_MS = 15 * 60_000;

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  env: "sandbox" | "production";
  /** Base URL of the cashfreeCheckout function (our checkout and return pages). */
  checkoutUrl: string;
  /** URL of the cashfreeWebhook function. */
  webhookUrl: string;
}

function readSecret(secret: {value(): string}): string {
  try {
    return secret.value().trim();
  } catch {
    return "";
  }
}

export function liveCashfreeConfig(): CashfreeConfig {
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "savrivo-app";
  const base = `https://${REGION}-${project}.cloudfunctions.net`;
  let env = "sandbox";
  try { env = CASHFREE_ENV.value(); } catch { /* default */ }
  return {
    appId: readSecret(CASHFREE_APP_ID),
    secretKey: readSecret(CASHFREE_SECRET_KEY),
    env: env === "production" ? "production" : "sandbox",
    checkoutUrl: `${base}/cashfreeCheckout`,
    webhookUrl: `${base}/cashfreeWebhook`,
  };
}

interface CashfreeOrder {
  order_id?: string;
  order_status?: string;
  order_amount?: number;
  payment_session_id?: string;
  order_expiry_time?: string;
}

interface CashfreePayment {
  cf_payment_id?: string | number;
  payment_status?: string;
  payment_amount?: number;
  payment_currency?: string;
}

interface CashfreeRefund {
  cf_refund_id?: string | number;
  refund_id?: string;
  refund_status?: string;
  refund_amount?: number;
}

function paise(rupees: unknown): number {
  return Math.round(Number(rupees) * 100);
}

function tenDigitMobile(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.slice(-10);
  return /^[6-9]\d{9}$/.test(local) ? local : "";
}

export class CashfreeGateway implements PaymentGateway {
  readonly provider = "cashfree" as const;

  constructor(private readonly config: () => CashfreeConfig, private readonly http: typeof fetch = fetch) {}

  get configured(): boolean {
    const c = this.config();
    return Boolean(c.appId && c.secretKey);
  }

  private base(c: CashfreeConfig): string {
    return c.env === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  }

  private async api<T>(c: CashfreeConfig, method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<{status: number; data: T}> {
    const res = await this.http(`${this.base(c)}${path}`, {
      method,
      headers: {
        "x-client-id": c.appId,
        "x-client-secret": c.secretKey,
        "x-api-version": API_VERSION,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(idempotencyKey ? {"x-idempotency-key": idempotencyKey} : {}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const data = await res.json().catch(() => ({})) as T;
    return {status: res.status, data};
  }

  async createIntent(order: SavrivoOrder, request: PaymentIntentRequest): Promise<PaymentIntent> {
    const c = this.config();
    if (!c.appId || !c.secretKey) throw new DomainError("failed-precondition", "Online payment is not available right now. Cash on delivery still works.");
    const phone = tenDigitMobile(order.customerPhone || order.address?.phone);
    if (!phone) throw new DomainError("failed-precondition", "Add a valid mobile number to pay online.");
    const expiresAt = Date.now() + SESSION_MINUTES * 60_000;
    const created = await this.api<CashfreeOrder & {message?: string; code?: string}>(c, "POST", "/orders", {
      order_id: request.merchantOrderId,
      order_amount: paise(order.total) / 100,
      order_currency: "INR",
      customer_details: {
        customer_id: `cust_${createHash("sha256").update(order.customerId).digest("hex").slice(0, 32)}`,
        customer_phone: phone,
        ...(order.customerName ? {customer_name: String(order.customerName).slice(0, 100)} : {}),
      },
      order_meta: {
        return_url: `${c.checkoutUrl}?op=return&order_id={order_id}`,
        notify_url: c.webhookUrl,
      },
      order_expiry_time: new Date(expiresAt).toISOString(),
      order_note: `Scraveit order ${order.id}`.slice(0, 200),
    }, request.idempotencyKey);
    let cf: CashfreeOrder = created.data;
    // A retry of the same attempt: Cashfree already has this order id, so reuse its session.
    if (created.status === 409) cf = (await this.api<CashfreeOrder>(c, "GET", `/orders/${encodeURIComponent(request.merchantOrderId)}`)).data;
    else if (created.status < 200 || created.status >= 300) {
      logger.warn("CASHFREE_CREATE_ORDER_FAILED", {status: created.status, code: created.data.code, message: String(created.data.message ?? "").slice(0, 200)});
      throw new DomainError("unavailable", "Payment could not start. Please try again, or choose cash on delivery.");
    }
    const session = String(cf.payment_session_id ?? "");
    if (!session || cf.order_id !== request.merchantOrderId || paise(cf.order_amount) !== paise(order.total)) {
      throw new DomainError("internal", "Cashfree returned an unexpected payment session.");
    }
    const cfExpiry = Date.parse(String(cf.order_expiry_time ?? ""));
    return {
      provider: "cashfree",
      merchantOrderId: request.merchantOrderId,
      redirectUrl: `${c.checkoutUrl}?op=pay&order_id=${encodeURIComponent(request.merchantOrderId)}&session=${encodeURIComponent(session)}`,
      expiresAt: Number.isFinite(cfExpiry) && cfExpiry > Date.now() ? Math.min(cfExpiry, expiresAt) : expiresAt,
    };
  }

  /** Signature first, then Cashfree's own record must agree before anything is trusted. */
  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: Buffer): Promise<VerificationResult> {
    const c = this.config();
    if (!c.secretKey) return {verified: false, reason: "CASHFREE_NOT_CONFIGURED"};
    if (!rawBody.length) return {verified: false, reason: "EMPTY_CALLBACK"};
    const signature = String(headers["x-webhook-signature"] ?? "");
    const timestamp = String(headers["x-webhook-timestamp"] ?? "");
    const expected = createHmac("sha256", c.secretKey).update(timestamp + rawBody.toString("utf8")).digest("base64");
    if (!signature || !timestamp || !constantTimeStringEqual(signature, expected)) return {verified: false, reason: "BAD_SIGNATURE"};
    const sentAt = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > WEBHOOK_MAX_AGE_MS) return {verified: false, reason: "STALE_WEBHOOK"};

    let body: {type?: string; data?: {order?: CashfreeOrder; payment?: CashfreePayment; refund?: CashfreeRefund & {order_id?: string}}};
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return {verified: false, reason: "BAD_JSON"};
    }
    const rawEventHash = createHash("sha256").update(rawBody).digest("hex");
    const type = String(body.type ?? "");

    if (type === "PAYMENT_SUCCESS_WEBHOOK" || type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
      const orderId = String(body.data?.order?.order_id ?? "");
      const paymentId = String(body.data?.payment?.cf_payment_id ?? "");
      if (!/^SVPAY_[A-F0-9]{32}$/.test(orderId) || !paymentId) return {verified: false, reason: "UNKNOWN_ORDER"};
      const [ord, pays] = await Promise.all([
        this.api<CashfreeOrder>(c, "GET", `/orders/${orderId}`),
        this.api<CashfreePayment[]>(c, "GET", `/orders/${orderId}/payments`),
      ]);
      if (ord.status !== 200 || pays.status !== 200 || !Array.isArray(pays.data)) return {verified: false, reason: "STATUS_CHECK_FAILED"};
      const payment = pays.data.find((p) => String(p.cf_payment_id) === paymentId);
      if (!payment) return {verified: false, reason: "PAYMENT_NOT_FOUND"};
      const succeeded = payment.payment_status === "SUCCESS";
      if (type === "PAYMENT_SUCCESS_WEBHOOK" && (!succeeded || ord.data.order_status !== "PAID")) return {verified: false, reason: "NOT_PAID_AT_CASHFREE"};
      if (type !== "PAYMENT_SUCCESS_WEBHOOK" && succeeded) return {verified: false, reason: "FAILURE_CONTRADICTED"};
      // A failed try while another payment on the same order succeeded is not a failure of the order.
      if (!succeeded && ord.data.order_status === "PAID") return {verified: false, reason: "IGNORED_ORDER_ALREADY_PAID"};
      return {
        verified: true, provider: "cashfree", merchantOrderId: orderId, providerTransactionId: paymentId,
        amountPaise: paise(payment.payment_amount ?? ord.data.order_amount), state: succeeded ? "paid" : "failed", rawEventHash,
      };
    }

    if (type === "REFUND_STATUS_WEBHOOK") {
      const refund = body.data?.refund;
      const orderId = String(refund?.order_id ?? "");
      const refundId = String(refund?.refund_id ?? "");
      if (!/^SVPAY_[A-F0-9]{32}$/.test(orderId) || !refundId) return {verified: false, reason: "UNKNOWN_ORDER"};
      const check = await this.api<CashfreeRefund>(c, "GET", `/orders/${orderId}/refunds/${encodeURIComponent(refundId)}`);
      if (check.status !== 200 || check.data.refund_status !== "SUCCESS") return {verified: false, reason: "IGNORED_REFUND_NOT_SUCCESS"};
      return {
        verified: true, provider: "cashfree", merchantOrderId: orderId, providerTransactionId: String(check.data.cf_refund_id ?? refundId),
        amountPaise: paise(check.data.refund_amount), state: "refunded", rawEventHash,
      };
    }
    return {verified: false, reason: `IGNORED_${type.replace(/[^A-Z_]/g, "").slice(0, 40) || "UNKNOWN"}`};
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[ch] as string));
}

function page(title: string, body: string, script = ""): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    `<title>${escapeHtml(title)}</title><style>body{margin:0;font-family:system-ui,-apple-system,Roboto,sans-serif;background:#f4f7ff;color:#14213d;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center}` +
    "main{padding:32px 24px;max-width:360px}h1{font-size:22px;margin:0 0 8px;color:#1460f0}p{margin:0 0 20px;line-height:1.5;color:#46506a}" +
    "a.btn{display:inline-block;background:#1460f0;color:#fff;text-decoration:none;padding:14px 22px;border-radius:999px;font-weight:600}</style></head>" +
    `<body><main><h1>Scraveit</h1>${body}</main>${script}</body></html>`;
}

/**
 * GET ?op=pay&session=… opens Cashfree's checkout; GET ?op=return is where
 * Cashfree sends the customer afterwards. Payment state is never taken from
 * this page; only the verified webhook changes the order.
 */
export function cashfreeCheckoutPage(query: Record<string, string>, env: CashfreeConfig["env"]): {status: number; html: string} {
  if (query.op === "pay") {
    const session = String(query.session ?? "");
    if (!/^session_[A-Za-z0-9_-]{10,400}$/.test(session)) return {status: 400, html: page("Payment", "<p>This payment link is not valid. Go back to the app and try again.</p>")};
    const script = "<script src=\"https://sdk.cashfree.com/js/v3/cashfree.js\"></script><script>" +
      `(function(){try{var cf=Cashfree({mode:${JSON.stringify(env)}});cf.checkout({paymentSessionId:${JSON.stringify(session)},redirectTarget:"_self"});}` +
      "catch(e){document.getElementById('msg').textContent='Payment page could not open. Go back to the app and try again.';}})();</script>";
    return {status: 200, html: page("Pay securely", "<p id=\"msg\">Opening secure payment…</p>", script)};
  }
  if (query.op === "return") {
    return {status: 200, html: page("Payment", "<p>Payment step finished. Go back to the Scraveit app; your order updates as soon as the payment is confirmed.</p>")};
  }
  return {status: 404, html: page("Not found", "<p>Page not found.</p>")};
}
