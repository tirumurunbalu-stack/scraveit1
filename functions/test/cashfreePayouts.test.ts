import {constants, generateKeyPairSync, privateDecrypt} from "node:crypto";
import {describe, expect, it} from "vitest";
import {
  CashfreePayoutGateway, cashfreeBeneficiaryName, cashfreePayoutSignature, cashfreeTransferId,
} from "../src/services/cashfreePayouts";

const {publicKey, privateKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
const PEM = publicKey.export({type: "spki", format: "pem"}).toString();
const config = {clientId: "CF_CLIENT", clientSecret: "secret", publicKeyPem: PEM, env: "production" as const};

const bankRequest = {
  entityType: "rider" as const, entityId: "rider-1", amountPaise: 123_456, method: "imps" as const,
  operationId: "weekly:rider:2026-W47:abc", beneficiaryLabel: "Shaik Sabdhar", upiId: "",
  bankAccountHolderName: "SHAIK SABDHAR", bankAccountNumber: "1234 5678 9012", bankIfsc: "sbin0001234",
};

type Reply = {status: number; body: unknown} | Error;
function fakeFetch(replies: Reply[]) {
  const calls: Array<{url: string; method: string; headers: Record<string, string>; body?: unknown}> = [];
  const impl = async (url: string, init: {method: string; headers: Record<string, string>; body?: string}) => {
    calls.push({url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined});
    const next = replies.shift();
    if (!next) throw new Error("no reply queued");
    if (next instanceof Error) throw next;
    return {status: next.status, text: async () => JSON.stringify(next.body)};
  };
  return {impl, calls};
}
const gateway = (replies: Reply[]) => {
  const fake = fakeFetch(replies);
  return {gw: new CashfreePayoutGateway(config, fake.impl, async () => undefined, () => 1_800_000_000_000), calls: fake.calls};
};

describe("Cashfree Payouts connector", () => {
  it("makes a stable, Cashfree-safe transfer id per payout", () => {
    const id = cashfreeTransferId("weekly:rider:2026-W47:abc");
    expect(id).toMatch(/^[A-Za-z0-9_]{1,40}$/);
    expect(cashfreeTransferId("weekly:rider:2026-W47:abc")).toBe(id);
    expect(cashfreeTransferId("weekly:rider:2026-W48:abc")).not.toBe(id);
  });

  it("signs clientId.unixSeconds with the public key (RSA-OAEP SHA-1)", () => {
    const signature = cashfreePayoutSignature("CF_CLIENT", PEM, 1_800_000_000_123);
    const plain = privateDecrypt({key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1"},
      Buffer.from(signature, "base64")).toString();
    expect(plain).toBe("CF_CLIENT.1800000000");
  });

  it("keeps beneficiary names to letters and spaces", () => {
    expect(cashfreeBeneficiaryName("K. Balaji (Rider)")).toBe("K Balaji Rider");
    expect(cashfreeBeneficiaryName("", "9")).toBe("Delivery Partner");
  });

  it("is not configured without all three keys", () => {
    expect(new CashfreePayoutGateway({...config, publicKeyPem: ""}).configured).toBe(false);
    expect(new CashfreePayoutGateway(config).configured).toBe(true);
  });

  it("pays a bank account by IMPS and returns the UTR", async () => {
    const {gw, calls} = gateway([{status: 200, body: {transfer_id: "x", cf_transfer_id: "9001", status: "SUCCESS", transfer_utr: "UTR123"}}]);
    const result = await gw.executePayout(bankRequest);
    expect(result).toMatchObject({provider: "cashfree_payouts", providerOperationId: "9001", referenceId: "UTR123"});
    expect(calls[0].url).toBe("https://api.cashfree.com/payout/transfers");
    expect(calls[0].headers["x-api-version"]).toBe("2024-01-01");
    expect(calls[0].headers["x-cf-signature"]).toBeTruthy();
    expect(calls[0].body).toMatchObject({
      transfer_id: cashfreeTransferId(bankRequest.operationId), transfer_amount: 1234.56, transfer_mode: "imps",
      beneficiary_details: {beneficiary_name: "SHAIK SABDHAR",
        beneficiary_instrument_details: {bank_account_number: "123456789012", bank_ifsc: "SBIN0001234"}},
    });
  });

  it("pays a UPI ID", async () => {
    const {gw, calls} = gateway([{status: 200, body: {cf_transfer_id: "9002", status: "SUCCESS"}}]);
    await gw.executePayout({...bankRequest, method: "upi", upiId: "shaik@okaxis"});
    expect(calls[0].body).toMatchObject({transfer_mode: "upi", beneficiary_details: {beneficiary_instrument_details: {vpa: "shaik@okaxis"}}});
  });

  it("waits for a received transfer and accepts it even if the bank is still processing", async () => {
    const {gw, calls} = gateway([
      {status: 200, body: {transfer_id: "t", cf_transfer_id: "9003", status: "RECEIVED"}},
      {status: 200, body: {transfer_id: "t", cf_transfer_id: "9003", status: "PENDING"}},
      {status: 200, body: {transfer_id: "t", cf_transfer_id: "9003", status: "SUCCESS", transfer_utr: "UTR9"}},
    ]);
    expect((await gw.executePayout(bankRequest)).referenceId).toBe("UTR9");
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("throws (amount stays owed) when Cashfree fails the transfer", async () => {
    const {gw} = gateway([{status: 200, body: {transfer_id: "t", status: "FAILED", status_code: "INVALID_IFSC_FAIL"}}]);
    await expect(gw.executePayout(bankRequest)).rejects.toThrow(/did not pay/);
  });

  it("throws when Cashfree refuses the request", async () => {
    const {gw} = gateway([{status: 400, body: {code: "beneficiary_details.beneficiary_instrument_details.bank_ifsc_invalid", message: "bad ifsc"}}]);
    await expect(gw.executePayout(bankRequest)).rejects.toThrow(/refused/);
  });

  it("never pays twice: a reused transfer id reads the first transfer's result", async () => {
    const {gw, calls} = gateway([
      {status: 200, body: {transfer_id: "t", status: "REJECTED", status_code: "DUPLICATE_TRANSFER"}},
      {status: 200, body: {transfer_id: "t", cf_transfer_id: "9004", status: "SUCCESS"}},
    ]);
    expect((await gw.executePayout(bankRequest)).providerOperationId).toBe("9004");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("after a timeout, checks Cashfree first: found → accepted, not found → not paid", async () => {
    const found = gateway([new Error("timeout"), {status: 200, body: {transfer_id: "t", cf_transfer_id: "9005", status: "SUCCESS"}}]);
    expect((await found.gw.executePayout(bankRequest)).providerOperationId).toBe("9005");
    const missing = gateway([new Error("timeout"), {status: 404, body: {code: "transfer_id_not_found"}}]);
    await expect(missing.gw.executePayout(bankRequest)).rejects.toThrow(/nothing was sent/);
  });

  it("on a 5XX checks the status instead of sending again", async () => {
    const {gw, calls} = gateway([
      {status: 500, body: {code: "internal_server_error"}},
      {status: 404, body: {code: "transfer_id_not_found"}},
    ]);
    await expect(gw.executePayout(bankRequest)).rejects.toThrow(/nothing was sent/);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("refuses amounts under Rs 1 and missing details without calling Cashfree", async () => {
    const {gw, calls} = gateway([]);
    await expect(gw.executePayout({...bankRequest, amountPaise: 50})).rejects.toThrow(/Rs 1/);
    await expect(gw.executePayout({...bankRequest, bankAccountNumber: ""})).rejects.toThrow(/missing/);
    expect(calls).toHaveLength(0);
  });
});
