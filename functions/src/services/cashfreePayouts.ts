import {constants, createHash, publicEncrypt} from "node:crypto";
import {logger} from "firebase-functions";
import {defineSecret} from "firebase-functions/params";
import {DomainError} from "../errors";
import {CASHFREE_ENV} from "./cashfree";
import type {FinancePayoutGateway, PayoutGatewayRequest, PayoutGatewayResult} from "./financeAutomation";

// Cashfree Payouts (API 2024-01-01, Standard Transfer V2). Founder 17 Nov 2026:
// weekly delivery-partner payouts go to their bank account (IMPS/NEFT) or UPI ID.
// Our Cloud Functions have no fixed IP, so every call carries the 2FA
// public-key signature (X-Cf-Signature) instead of relying on IP whitelisting.
export const CASHFREE_PAYOUT_CLIENT_ID = defineSecret("CASHFREE_PAYOUT_CLIENT_ID");
export const CASHFREE_PAYOUT_CLIENT_SECRET = defineSecret("CASHFREE_PAYOUT_CLIENT_SECRET");
/** The .pem file from Payouts → Developers → Two-Factor Authentication → Public Key (whole file, with BEGIN/END lines). */
export const CASHFREE_PAYOUT_PUBLIC_KEY = defineSecret("CASHFREE_PAYOUT_PUBLIC_KEY");
export const CASHFREE_PAYOUT_SECRETS = [CASHFREE_PAYOUT_CLIENT_ID, CASHFREE_PAYOUT_CLIENT_SECRET, CASHFREE_PAYOUT_PUBLIC_KEY];

const API_VERSION = "2024-01-01";
const REQUEST_TIMEOUT_MS = 20_000;
/** After a transfer is accepted, how often and how long we wait for the bank's final answer before moving on. */
const STATUS_POLLS = 4;
const STATUS_POLL_GAP_MS = 2_500;

export interface CashfreePayoutConfig {
  clientId: string;
  clientSecret: string;
  publicKeyPem: string;
  env: "sandbox" | "production";
}

type FetchLike = (url: string, init: {method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal}) =>
  Promise<{status: number; text(): Promise<string>}>;

function readSecret(secret: {value(): string}): string {
  try {
    return secret.value().trim();
  } catch {
    return "";
  }
}

export function liveCashfreePayoutConfig(): CashfreePayoutConfig {
  let env = "sandbox";
  try { env = CASHFREE_ENV.value(); } catch { /* default */ }
  return {
    clientId: readSecret(CASHFREE_PAYOUT_CLIENT_ID),
    clientSecret: readSecret(CASHFREE_PAYOUT_CLIENT_SECRET),
    // Secret Manager keeps the pasted file as is; tolerate "\n" written as two characters.
    publicKeyPem: readSecret(CASHFREE_PAYOUT_PUBLIC_KEY).replace(/\\n/g, "\n"),
    env: env === "production" ? "production" : "sandbox",
  };
}

/** Same operation → same Cashfree transfer_id, so a retry can never pay twice (Cashfree rejects a reused id). */
export function cashfreeTransferId(operationId: string): string {
  return `scv_${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

/** X-Cf-Signature: "clientId.unixSeconds" encrypted with Cashfree's public key (RSA-OAEP, SHA-1), base64. Valid ~5 minutes. */
export function cashfreePayoutSignature(clientId: string, publicKeyPem: string, nowMs = Date.now()): string {
  const message = `${clientId}.${Math.floor(nowMs / 1000)}`;
  return publicEncrypt({key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1"}, Buffer.from(message))
    .toString("base64");
}

/** Cashfree allows letters and spaces only in beneficiary_name (max 100). */
export function cashfreeBeneficiaryName(...candidates: string[]): string {
  for (const candidate of candidates) {
    const clean = String(candidate ?? "").replace(/[^A-Za-z ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (clean.length >= 2) return clean;
  }
  return "Delivery Partner";
}

const IN_FLIGHT = new Set(["RECEIVED", "PENDING", "QUEUED", "APPROVAL_PENDING", "VALIDATION_PENDING"]);
const FAILED = new Set(["FAILED", "REJECTED", "REVERSED", "MANUALLY_REJECTED"]);

interface TransferRecord {
  transferId: string;
  cfTransferId: string;
  status: string;
  statusCode: string;
  statusDescription: string;
  utr: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toTransfer(body: Record<string, unknown>): TransferRecord {
  return {
    transferId: String(body.transfer_id ?? ""),
    cfTransferId: String(body.cf_transfer_id ?? ""),
    status: String(body.status ?? "").toUpperCase(),
    statusCode: String(body.status_code ?? "").toUpperCase(),
    statusDescription: String(body.status_description ?? ""),
    utr: String(body.transfer_utr ?? ""),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CashfreePayoutGateway implements FinancePayoutGateway {
  constructor(
    private readonly config: CashfreePayoutConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly wait: (ms: number) => Promise<unknown> = sleep,
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.publicKeyPem.includes("BEGIN"));
  }

  private get baseUrl(): string {
    return this.config.env === "production" ? "https://api.cashfree.com/payout" : "https://sandbox.cashfree.com/payout";
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-version": API_VERSION,
      "x-client-id": this.config.clientId,
      "x-client-secret": this.config.clientSecret,
      "x-cf-signature": cashfreePayoutSignature(this.config.clientId, this.config.publicKeyPem, this.now()),
    };
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<{status: number; json: Record<string, unknown>}> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, headers: this.headers(), ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: controller.signal,
      });
      const raw = await response.text();
      let json: Record<string, unknown> = {};
      try { json = asRecord(JSON.parse(raw)); } catch { /* non-JSON error page */ }
      return {status: response.status, json};
    } finally {
      clearTimeout(timer);
    }
  }

  /** null = Cashfree has no transfer with this id (it was never created). Throws when Cashfree can't be reached. */
  private async lookup(transferId: string): Promise<TransferRecord | null> {
    const {status, json} = await this.call("GET", `/transfers?transfer_id=${encodeURIComponent(transferId)}`);
    if (status === 404) return null;
    if (status >= 200 && status < 300) return toTransfer(json);
    throw new DomainError("unavailable", `Cashfree status check failed (${status} ${String(json.code ?? "")}). Not marked paid; check the Cashfree dashboard.`,
      {reason: "CASHFREE_STATUS_UNAVAILABLE"});
  }

  /** Turns Cashfree's answer into "paid / accepted" (a result) or "not paid" (an error, so the balance stays owed). */
  private async settle(transfer: TransferRecord, request: PayoutGatewayRequest): Promise<PayoutGatewayResult> {
    let current = transfer;
    for (let poll = 0; poll < STATUS_POLLS && IN_FLIGHT.has(current.status); poll += 1) {
      await this.wait(STATUS_POLL_GAP_MS);
      try {
        current = (await this.lookup(current.transferId)) ?? current;
      } catch {
        break;
      }
    }
    if (current.status === "SUCCESS" || IN_FLIGHT.has(current.status)) {
      // Accepted by Cashfree: the money has left our Payouts balance (or is queued to). A later bank
      // reversal shows in the Cashfree dashboard and is fixed by hand.
      logger.info("CASHFREE_PAYOUT_ACCEPTED", {
        entityType: request.entityType, transferId: current.transferId, cfTransferId: current.cfTransferId, status: current.status,
      });
      return {
        provider: "cashfree_payouts",
        providerOperationId: current.cfTransferId || current.transferId,
        referenceId: current.utr || current.cfTransferId || current.transferId,
        completedAt: this.now(),
      };
    }
    const why = [current.statusCode, current.statusDescription].filter(Boolean).join(": ") || current.status || "unknown";
    logger.warn("CASHFREE_PAYOUT_NOT_PAID", {entityType: request.entityType, transferId: current.transferId, status: current.status, why});
    throw new DomainError("failed-precondition", `Cashfree did not pay (${current.status} ${why}). The amount stays owed.`,
      {reason: "CASHFREE_PAYOUT_FAILED"});
  }

  async executePayout(request: PayoutGatewayRequest): Promise<PayoutGatewayResult> {
    if (!this.configured) {
      throw new DomainError("failed-precondition", "Cashfree Payouts keys are not set yet.", {reason: "PAYOUT_GATEWAY_UNCONFIGURED"});
    }
    const amountRupees = Math.round(request.amountPaise) / 100;
    if (!(amountRupees >= 1)) {
      throw new DomainError("failed-precondition", "Cashfree pays Rs 1 or more; this amount stays owed.", {reason: "CASHFREE_PAYOUT_TOO_SMALL"});
    }
    const upi = request.method === "upi";
    const instrument = upi ?
      {vpa: request.upiId.trim()} :
      {bank_account_number: request.bankAccountNumber.replace(/\s+/g, ""), bank_ifsc: request.bankIfsc.trim().toUpperCase()};
    if (upi ? !instrument.vpa : !(instrument as {bank_account_number: string}).bank_account_number) {
      throw new DomainError("failed-precondition", "Payout details are missing.", {reason: "UPI_OR_BANK_DETAILS_REQUIRED"});
    }
    const transferId = cashfreeTransferId(request.operationId);
    const body = {
      transfer_id: transferId,
      transfer_amount: amountRupees,
      transfer_currency: "INR",
      transfer_mode: upi ? "upi" : request.method,
      beneficiary_details: {
        beneficiary_name: cashfreeBeneficiaryName(upi ? request.beneficiaryLabel : request.bankAccountHolderName, request.beneficiaryLabel),
        beneficiary_instrument_details: instrument,
      },
      transfer_remarks: request.entityType === "rider" ? "Scraveit weekly earnings" : "Scraveit weekly settlement",
    };

    let response: {status: number; json: Record<string, unknown>};
    try {
      response = await this.call("POST", "/transfers", body);
    } catch {
      // Timeout or network: the transfer may or may not exist. Ask before deciding.
      const found = await this.lookup(transferId);
      if (!found) {
        throw new DomainError("unavailable", "Cashfree could not be reached; nothing was sent. It will be tried again.",
          {reason: "CASHFREE_UNREACHABLE"});
      }
      return this.settle(found, request);
    }

    const {status, json} = response;
    if (status >= 200 && status < 300) {
      const transfer = toTransfer(json);
      if (transfer.status === "REJECTED" && transfer.statusCode === "DUPLICATE_TRANSFER") {
        const existing = await this.lookup(transferId);
        if (existing) return this.settle(existing, request);
      }
      return this.settle({...transfer, transferId: transfer.transferId || transferId}, request);
    }
    const code = String(json.code ?? "");
    if (status >= 500 || /duplicate|already_exists/i.test(code)) {
      // Cashfree: on 5XX don't send a new transfer, check the status first.
      const existing = await this.lookup(transferId);
      if (existing) return this.settle(existing, request);
      throw new DomainError("unavailable", `Cashfree error ${status}; nothing was sent. It will be tried again.`, {reason: "CASHFREE_UNAVAILABLE"});
    }
    logger.warn("CASHFREE_PAYOUT_REFUSED", {entityType: request.entityType, transferId, status, code, message: String(json.message ?? "")});
    throw new DomainError("failed-precondition", `Cashfree refused the payout (${code || status}: ${String(json.message ?? "")}). The amount stays owed.`,
      {reason: "CASHFREE_PAYOUT_REFUSED"});
  }
}
