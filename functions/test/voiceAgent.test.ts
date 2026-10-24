import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {bucket: () => ({})}}));
vi.mock("../src/services/orders", () => ({cancelOrderFromConfirmationCall: vi.fn()}));

import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import {dtmfIntent, greetingText, indianMobile, listenXml} from "../src/domain/voiceAgent";
import type {SavrivoOrder} from "../src/types";
const agent = await import("../src/services/voiceAgent");

const NOW = Date.UTC(2026, 9, 24, 7, 0);

function order(extra: Partial<SavrivoOrder> = {}): SavrivoOrder {
  return {
    id: "ord1", customerId: "cust1", customerName: "Ravi Kumar", customerPhone: "98765 43210", restaurant: "The Waffle Spot",
    items: [{name: "Belgian Waffle", quantity: 2}, {name: "Cold Coffee", quantity: 1}], total: 319.5,
    address: {area: "Naidupeta"}, paymentMethod: "cod", status: "Order placed", ...extra,
  } as unknown as SavrivoOrder;
}

function harness(opts: {decide?: agent.AgentReply; plivoOk?: boolean; cancelResult?: boolean; transcript?: string; lang?: string} = {}) {
  const db = new InMemoryFirestore();
  db.seed("settings/voiceAgent", {enabled: true, defaultLanguage: "te-IN"});
  const audio = new Map<string, Buffer>();
  const requests: Array<{url: string; method: string; body?: string}> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({url, method, ...(typeof init?.body === "string" ? {body: init.body} : {})});
    if (url.includes("text-to-speech")) return new Response(JSON.stringify({audios: [Buffer.from("RIFFwav").toString("base64")]}));
    if (url.includes("speech-to-text")) return new Response(JSON.stringify({transcript: opts.transcript ?? "avunu", language_code: opts.lang ?? "te-IN"}));
    if (url.endsWith("/Call/")) return opts.plivoOk === false ? new Response("no", {status: 401}) : new Response(JSON.stringify({request_uuid: "plivo-1"}), {status: 201});
    if (url.startsWith("https://media.plivo.com/")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response("{}");
  }) as typeof fetch;
  const decide = vi.fn(async () => opts.decide ?? {intent: "confirm" as const, reply: "ok", language: "te-IN" as const, end_call: true});
  const cancelOrder = vi.fn(async () => opts.cancelResult ?? true);
  const deps: agent.VoiceAgentDeps = {
    db, fetch: fakeFetch,
    saveAudio: async (path, wav) => { audio.set(path, wav); },
    loadAudio: async (path) => audio.get(path) ?? null,
    decide, cancelOrder,
    secrets: {plivoId: "MAID", plivoToken: "tok", plivoFrom: "918000000000", sarvamKey: "sk"},
    baseUrl: "https://example.test/voiceAgent", now: () => NOW,
  };
  return {db, deps, audio, requests, decide, cancelOrder};
}

/** The query string Plivo would call back with, taken from the dial request. */
function answerQuery(requests: Array<{url: string; body?: string}>): Record<string, string> {
  const dial = requests.find((r) => r.url.endsWith("/Call/"));
  const answerUrl = new URL(JSON.parse(dial?.body ?? "{}").answer_url);
  return Object.fromEntries(answerUrl.searchParams.entries());
}

describe("order confirmation call", () => {
  it("speaks Telugu or English with the order, amount and keypad options", () => {
    const facts = {firstName: "Ravi", restaurant: "The Waffle Spot", items: [{name: "Waffle", quantity: 2}], total: 319.5, area: ""};
    expect(greetingText(facts, "te-IN")).toContain("319 రూపాయల 50 పైసలు");
    expect(greetingText(facts, "en-IN")).toContain("Total 319 rupees 50 paise, cash on delivery");
    expect(greetingText(facts, "en-IN")).toContain("may be recorded");
    expect(indianMobile("+91 98765-43210")).toBe("919876543210");
    expect(indianMobile("12345")).toBeNull();
    expect(dtmfIntent("1")).toBe("confirm");
    expect(dtmfIntent("2")).toBe("cancel");
    expect(dtmfIntent("9")).toBe("switch_language");
    expect(listenXml("https://a.test/x?a=1&b=2", "https://a.test/t")).toContain("x?a=1&amp;b=2");
  });

  it("does nothing until switched on, and never calls for online or non-new orders", async () => {
    const h = harness();
    h.db.seed("settings/voiceAgent", {enabled: false});
    expect(await agent.startConfirmationCall(order(), h.deps)).toBeNull();
    h.db.seed("settings/voiceAgent", {enabled: true});
    expect(await agent.startConfirmationCall(order({paymentMethod: "upi"}), h.deps)).toBeNull();
    expect(await agent.startConfirmationCall(order({status: "Accepted"}), h.deps)).toBeNull();
    expect(h.requests).toHaveLength(0);
  });

  it("test mode calls only the listed numbers", async () => {
    const h = harness();
    h.db.seed("settings/voiceAgent", {enabled: true, onlyPhones: ["9000000000"]});
    expect(await agent.startConfirmationCall(order(), h.deps)).toBeNull();
    h.db.seed("settings/voiceAgent", {enabled: true, onlyPhones: ["+91 98765 43210"]});
    expect(await agent.startConfirmationCall(order(), h.deps)).toBeTruthy();
  });

  it("rings once per order, then a key press 1 confirms it", async () => {
    const h = harness();
    const callId = await agent.startConfirmationCall(order(), h.deps);
    expect(callId).toBeTruthy();
    expect(await agent.startConfirmationCall(order(), h.deps)).toBeNull();
    const dial = h.requests.filter((r) => r.url.endsWith("/Call/"));
    expect(dial).toHaveLength(1);
    expect(JSON.parse(dial[0]!.body!)).toMatchObject({to: "919876543210", from: "918000000000"});

    const q = answerQuery(h.requests);
    const answer = await agent.handleVoiceWebhook({...q, op: "answer"}, {}, h.deps);
    expect(String(answer.body)).toContain("<GetDigits");
    const audio = await agent.handleVoiceWebhook({...q, op: "audio", n: "1"}, {}, h.deps);
    expect(audio.contentType).toBe("audio/wav");
    const done = await agent.handleVoiceWebhook({...q, op: "turn"}, {Digits: "1"}, h.deps);
    expect(String(done.body)).toContain("<Hangup/>");
    expect(h.db.read("codConfirmations/ord1")).toMatchObject({status: "confirmed", orderCancelled: false});
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it("a spoken cancel goes through Claude and cancels the order", async () => {
    const h = harness({transcript: "vaddu, cancel cheyyandi", decide: {intent: "cancel", reply: "సరే", language: "te-IN", end_call: true}});
    await agent.startConfirmationCall(order(), h.deps);
    const q = answerQuery(h.requests);
    await agent.handleVoiceWebhook({...q, op: "answer"}, {}, h.deps);
    await agent.handleVoiceWebhook({...q, op: "turn"}, {RecordUrl: "https://media.plivo.com/rec.wav", RecordingID: "r1"}, h.deps);
    expect(h.decide).toHaveBeenCalledWith(expect.anything(), "vaddu, cancel cheyyandi", "te-IN");
    expect(h.cancelOrder).toHaveBeenCalledWith("ord1", expect.any(String));
    expect(h.db.read("codConfirmations/ord1")).toMatchObject({status: "cancelled", orderCancelled: true});
    expect(h.requests.some((r) => r.method === "DELETE" && r.url.includes("/Recording/r1/"))).toBe(true);
  });

  it("if the kitchen already started, a cancel becomes a follow-up instead", async () => {
    const h = harness({cancelResult: false});
    await agent.startConfirmationCall(order(), h.deps);
    const q = answerQuery(h.requests);
    await agent.handleVoiceWebhook({...q, op: "turn"}, {Digits: "2"}, h.deps);
    expect(h.db.read("codConfirmations/ord1")).toMatchObject({status: "needs_followup", orderCancelled: false});
  });

  it("questions keep the call going; it ends politely after a few unclear turns without touching the order", async () => {
    const h = harness({transcript: "enti?", decide: {intent: "unclear", reply: "మళ్ళీ చెప్పండి", language: "te-IN", end_call: false}});
    await agent.startConfirmationCall(order(), h.deps);
    const q = answerQuery(h.requests);
    await agent.handleVoiceWebhook({...q, op: "answer"}, {}, h.deps);
    const rec = {RecordUrl: "https://media.plivo.com/rec.wav"};
    for (let i = 0; i < 3; i++) expect(String((await agent.handleVoiceWebhook({...q, op: "turn"}, rec, h.deps)).body)).toContain("<Record");
    expect(String((await agent.handleVoiceWebhook({...q, op: "turn"}, rec, h.deps)).body)).toContain("<Hangup/>");
    expect(h.db.read("codConfirmations/ord1")).toMatchObject({status: "unclear"});
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it("an unanswered call is recorded as no answer", async () => {
    const h = harness();
    await agent.startConfirmationCall(order(), h.deps);
    const q = answerQuery(h.requests);
    await agent.handleVoiceWebhook({...q, op: "hangup"}, {HangupCause: "NO_ANSWER"}, h.deps);
    expect(h.db.read("codConfirmations/ord1")).toMatchObject({status: "no_answer"});
  });

  it("rejects callbacks without the call's own token", async () => {
    const h = harness();
    await agent.startConfirmationCall(order(), h.deps);
    const q = answerQuery(h.requests);
    expect((await agent.handleVoiceWebhook({...q, op: "turn", t: "0".repeat(48)}, {Digits: "2"}, h.deps)).status).toBe(404);
    expect(h.cancelOrder).not.toHaveBeenCalled();
  });

  it("a failed dial is recorded and never retried", async () => {
    const h = harness({plivoOk: false});
    expect(await agent.startConfirmationCall(order(), h.deps)).toBeNull();
    expect(h.db.read("codConfirmations/ord1")).toMatchObject({status: "failed"});
    expect(await agent.startConfirmationCall(order(), h.deps)).toBeNull();
  });
});
