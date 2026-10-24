import Anthropic from "@anthropic-ai/sdk";
import {randomBytes, timingSafeEqual} from "node:crypto";
import {logger} from "firebase-functions";
import {defineSecret} from "firebase-functions/params";
import {z} from "zod";
import {firestoreDb, storage} from "../admin";
import {REGION} from "../config";
import {
  AGENT_REPLY_SCHEMA, AGENT_SYSTEM_PROMPT, MAX_TURNS, closingText, dtmfIntent, greetingText, hangupXml, indianMobile,
  listenXml, orderFactsText, outcomeFor, sorryRepeatText, voiceLang,
  type VoiceIntent, type VoiceLang, type VoiceOrderFacts, type VoiceOutcome,
} from "../domain/voiceAgent";
import type {FirestoreLike} from "../firestoreTypes";
import type {SavrivoOrder} from "../types";
import {cancelOrderFromConfirmationCall} from "./orders";

// Order confirmation calls: Plivo places the call and plays audio, Sarvam AI
// turns Telugu/English speech into text and text into speech, and Claude
// decides what the customer meant and what to say next.
export const PLIVO_AUTH_ID = defineSecret("PLIVO_AUTH_ID");
export const PLIVO_AUTH_TOKEN = defineSecret("PLIVO_AUTH_TOKEN");
export const PLIVO_FROM_NUMBER = defineSecret("PLIVO_FROM_NUMBER");
export const SARVAM_API_KEY = defineSecret("SARVAM_API_KEY");
export const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
export const VOICE_AGENT_SECRETS = [PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_FROM_NUMBER, SARVAM_API_KEY, ANTHROPIC_API_KEY];

const CALLS = "voiceCalls";
const RESULTS = "codConfirmations";
const AGENT_MODEL = "claude-opus-5-5";

export interface VoiceAgentSettings {
  enabled: boolean;
  defaultLanguage: VoiceLang;
  /** While non-empty, only these numbers are called (for testing). */
  onlyPhones: string[];
  /** Don't call for orders below this total (₹). */
  minTotal: number;
}

interface CallTurn {who: "agent" | "customer"; text: string; lang: VoiceLang; at: number; via?: "speech" | "keypad"}

interface CallRecord {
  id: string;
  orderId: string;
  customerId: string;
  to: string;
  token: string;
  status: "dialing" | "in_progress" | "completed" | "no_answer" | "failed";
  outcome?: VoiceOutcome;
  lang: VoiceLang;
  facts: VoiceOrderFacts;
  turns: CallTurn[];
  audioCount: number;
  providerCallId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VoiceAgentDeps {
  db: FirestoreLike;
  fetch: typeof fetch;
  saveAudio: (path: string, wav: Buffer) => Promise<void>;
  loadAudio: (path: string) => Promise<Buffer | null>;
  decide: (call: CallRecord, utterance: string, lang: VoiceLang) => Promise<AgentReply>;
  cancelOrder: (orderId: string, callId: string) => Promise<boolean>;
  secrets: {plivoId: string; plivoToken: string; plivoFrom: string; sarvamKey: string};
  baseUrl: string;
  now: () => number;
}

const agentReplySchema = z.object({
  intent: z.enum(["confirm", "cancel", "change_request", "question", "unclear", "wrong_person", "call_later"]),
  reply: z.string().min(1).max(600),
  language: z.enum(["te-IN", "en-IN"]),
  end_call: z.boolean(),
});
export type AgentReply = z.infer<typeof agentReplySchema>;

export async function loadVoiceAgentSettings(db: FirestoreLike): Promise<VoiceAgentSettings> {
  const snap = await db.collection("settings").doc("voiceAgent").get();
  const raw = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    defaultLanguage: voiceLang(raw.defaultLanguage),
    onlyPhones: Array.isArray(raw.onlyPhones) ? raw.onlyPhones.map(indianMobile).filter((p): p is string => Boolean(p)) : [],
    minTotal: Number.isFinite(Number(raw.minTotal)) ? Number(raw.minTotal) : 0,
  };
}

export function liveDeps(): VoiceAgentDeps {
  const bucket = storage.bucket();
  const anthropic = new Anthropic({apiKey: ANTHROPIC_API_KEY.value(), maxRetries: 1, timeout: 12_000});
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "savrivo-app";
  return {
    db: firestoreDb,
    fetch,
    saveAudio: async (path, wav) => { await bucket.file(path).save(wav, {contentType: "audio/wav", resumable: false}); },
    loadAudio: async (path) => {
      const file = bucket.file(path);
      const [exists] = await file.exists();
      return exists ? (await file.download())[0] : null;
    },
    decide: (call, utterance, lang) => decideWithClaude(anthropic, call, utterance, lang),
    cancelOrder: cancelOrderFromConfirmationCall,
    secrets: {
      plivoId: PLIVO_AUTH_ID.value(), plivoToken: PLIVO_AUTH_TOKEN.value(),
      plivoFrom: PLIVO_FROM_NUMBER.value(), sarvamKey: SARVAM_API_KEY.value(),
    },
    baseUrl: `https://${REGION}-${project}.cloudfunctions.net/voiceAgent`,
    now: Date.now,
  };
}

/** Claude reads the call so far and the customer's latest words, and returns the intent and the next line. */
async function decideWithClaude(client: Anthropic, call: CallRecord, utterance: string, lang: VoiceLang): Promise<AgentReply> {
  const transcript = call.turns.map((t) => `${t.who === "agent" ? "Assistant" : "Customer"}: ${t.text}`).join("\n");
  try {
    const response = await client.beta.messages.create({
      model: AGENT_MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {effort: "low", format: {type: "json_schema", schema: AGENT_REPLY_SCHEMA}},
      system: AGENT_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `${orderFactsText(call.facts)}\n\nCall so far:\n${transcript}\n\nCustomer just said (detected ${lang}): ${utterance || "(silence)"}`,
      }],
    });
    if (response.stop_reason === "refusal") throw new Error("refusal");
    const text = response.content.find((b) => b.type === "text");
    const parsed = agentReplySchema.safeParse(JSON.parse(text && text.type === "text" ? text.text : "{}"));
    if (parsed.success) return parsed.data;
    throw new Error("unparseable reply");
  } catch (error) {
    if (error instanceof Anthropic.APIError) logger.warn("VOICE_AGENT_CLAUDE_FAILED", {status: error.status, callId: call.id});
    else logger.warn("VOICE_AGENT_CLAUDE_FAILED", {error: error instanceof Error ? error.message : "unknown", callId: call.id});
    return {intent: "unclear", reply: sorryRepeatText(lang), language: lang, end_call: false};
  }
}

function plivoAuth(deps: VoiceAgentDeps): string {
  return "Basic " + Buffer.from(`${deps.secrets.plivoId}:${deps.secrets.plivoToken}`).toString("base64");
}

/** Sarvam text-to-speech, 8 kHz WAV for the phone line. */
async function speak(deps: VoiceAgentDeps, text: string, lang: VoiceLang): Promise<Buffer> {
  const res = await deps.fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {"api-subscription-key": deps.secrets.sarvamKey, "Content-Type": "application/json"},
    body: JSON.stringify({text, target_language_code: lang, model: "bulbul:v2", speaker: "anushka", speech_sample_rate: 8000}),
  });
  if (!res.ok) throw new Error(`TTS_HTTP_${res.status}`);
  const body = await res.json() as {audios?: string[]};
  const audio = body.audios?.[0];
  if (!audio) throw new Error("TTS_EMPTY");
  return Buffer.from(audio, "base64");
}

/** Sarvam speech-to-text with automatic Telugu/English detection. */
async function transcribe(deps: VoiceAgentDeps, wav: Buffer, fallback: VoiceLang): Promise<{text: string; lang: VoiceLang}> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], {type: "audio/wav"}), "reply.wav");
  form.append("model", "saarika:v2.5");
  form.append("language_code", "unknown");
  const res = await deps.fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST", headers: {"api-subscription-key": deps.secrets.sarvamKey}, body: form,
  });
  if (!res.ok) throw new Error(`STT_HTTP_${res.status}`);
  const body = await res.json() as {transcript?: string; language_code?: string};
  return {text: String(body.transcript ?? "").trim().slice(0, 500), lang: voiceLang(body.language_code, fallback)};
}

/** Synthesizes a line, stores it, and returns the URL Plivo fetches it from. */
async function prompt(deps: VoiceAgentDeps, call: CallRecord, text: string, lang: VoiceLang): Promise<string> {
  const n = call.audioCount + 1;
  await deps.saveAudio(`private/voice-agent/${call.id}/${n}.wav`, await speak(deps, text, lang));
  call.audioCount = n;
  call.turns.push({who: "agent", text, lang, at: deps.now()});
  return callUrl(deps, call, "audio", {n: String(n)});
}

function callUrl(deps: VoiceAgentDeps, call: CallRecord, op: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({op, call: call.id, t: call.token, ...extra});
  return `${deps.baseUrl}?${q.toString()}`;
}

function factsFrom(order: SavrivoOrder): VoiceOrderFacts {
  return {
    firstName: String(order.customerName ?? "").trim().split(/\s+/)[0]?.slice(0, 30) ?? "",
    restaurant: String(order.restaurant ?? "").slice(0, 80),
    items: (order.items ?? []).map((i) => ({name: String(i.name).slice(0, 60), quantity: Number(i.quantity) || 1})),
    total: Number(order.total) || 0,
    area: String(order.address?.area ?? "").slice(0, 80),
  };
}

/**
 * Called once per new COD order. Prepares the greeting, then asks Plivo to
 * ring the customer. Returns the call id, or null when no call is due.
 */
export async function startConfirmationCall(order: SavrivoOrder, deps: VoiceAgentDeps): Promise<string | null> {
  if (order.paymentMethod !== "cod" || order.status !== "Order placed") return null;
  const settings = await loadVoiceAgentSettings(deps.db);
  if (!settings.enabled || Number(order.total) < settings.minTotal) return null;
  const to = indianMobile(order.customerPhone || order.address?.phone);
  if (!to) {
    logger.info("VOICE_CONFIRM_SKIPPED_NO_MOBILE", {orderId: order.id});
    return null;
  }
  if (settings.onlyPhones.length && !settings.onlyPhones.includes(to)) return null;
  const resultRef = deps.db.collection(RESULTS).doc(order.id);
  if ((await resultRef.get()).exists) return null;

  const now = deps.now();
  const call: CallRecord = {
    id: `${order.id}-${now.toString(36)}`, orderId: order.id, customerId: order.customerId, to,
    token: randomBytes(24).toString("hex"), status: "dialing", lang: settings.defaultLanguage,
    facts: factsFrom(order), turns: [], audioCount: 0, createdAt: now, updatedAt: now,
  };
  await prompt(deps, call, greetingText(call.facts, call.lang), call.lang);
  await resultRef.set({orderId: order.id, callId: call.id, status: "calling", at: now});
  const res = await deps.fetch(`https://api.plivo.com/v1/Account/${deps.secrets.plivoId}/Call/`, {
    method: "POST",
    headers: {"Authorization": plivoAuth(deps), "Content-Type": "application/json"},
    body: JSON.stringify({
      from: deps.secrets.plivoFrom, to,
      answer_url: callUrl(deps, call, "answer"), answer_method: "POST",
      hangup_url: callUrl(deps, call, "hangup"), hangup_method: "POST",
      ring_timeout: 30, time_limit: 180,
    }),
  });
  if (!res.ok) {
    call.status = "failed";
    await deps.db.collection(CALLS).doc(call.id).set({...call, error: `PLIVO_HTTP_${res.status}`});
    await resultRef.set({orderId: order.id, callId: call.id, status: "failed", at: deps.now()});
    logger.warn("VOICE_CONFIRM_DIAL_FAILED", {orderId: order.id, status: res.status});
    return null;
  }
  const body = await res.json().catch(() => ({})) as {request_uuid?: string};
  if (body.request_uuid) call.providerCallId = body.request_uuid;
  await deps.db.collection(CALLS).doc(call.id).set(call);
  logger.info("VOICE_CONFIRM_DIALING", {orderId: order.id, callId: call.id});
  return call.id;
}

async function loadCall(deps: VoiceAgentDeps, id: string, token: string): Promise<CallRecord | null> {
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(id) || !/^[a-f0-9]{48}$/.test(token)) return null;
  const snap = await deps.db.collection(CALLS).doc(id).get();
  if (!snap.exists) return null;
  const call = snap.data() as CallRecord;
  const a = Buffer.from(call.token), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? call : null;
}

async function finish(deps: VoiceAgentDeps, call: CallRecord, outcome: VoiceOutcome): Promise<string> {
  call.outcome = outcome;
  call.status = "completed";
  let orderCancelled = false;
  if (outcome === "cancelled") orderCancelled = await deps.cancelOrder(call.orderId, call.id);
  const spoken = outcome === "cancelled" && !orderCancelled ? "needs_followup" : outcome;
  const url = await prompt(deps, call, closingText(spoken, call.lang), call.lang);
  call.updatedAt = deps.now();
  await deps.db.collection(CALLS).doc(call.id).set(call);
  await deps.db.collection(RESULTS).doc(call.orderId).set({
    orderId: call.orderId, callId: call.id, status: spoken, orderCancelled, at: call.updatedAt,
  });
  logger.info("VOICE_CONFIRM_RESULT", {orderId: call.orderId, callId: call.id, outcome: spoken});
  return hangupXml(url);
}

/** One customer turn: a key press or a recording. Returns the XML for what happens next. */
async function handleTurn(deps: VoiceAgentDeps, call: CallRecord, params: Record<string, string>): Promise<string> {
  const customerTurns = call.turns.filter((t) => t.who === "customer").length;
  let intent: VoiceIntent | null = null, reply = "", lang = call.lang, endCall = false;
  const key = dtmfIntent(params.Digits);
  if (key === "switch_language") {
    call.lang = call.lang === "te-IN" ? "en-IN" : "te-IN";
    call.turns.push({who: "customer", text: "[pressed 9]", lang: call.lang, at: deps.now(), via: "keypad"});
    const url = await prompt(deps, call, greetingText(call.facts, call.lang), call.lang);
    await deps.db.collection(CALLS).doc(call.id).set(call);
    return listenXml(url, callUrl(deps, call, "turn"));
  }
  if (key) {
    intent = key;
    call.turns.push({who: "customer", text: `[pressed ${params.Digits}]`, lang, at: deps.now(), via: "keypad"});
  } else if (params.RecordUrl && /^https:\/\//.test(params.RecordUrl)) {
    const rec = await deps.fetch(params.RecordUrl, {headers: {Authorization: plivoAuth(deps)}});
    const heard = rec.ok ? await transcribe(deps, Buffer.from(await rec.arrayBuffer()), call.lang) : {text: "", lang: call.lang};
    // We keep only the transcript; ask Plivo to delete its copy of the customer's voice.
    if (params.RecordingID) {
      deps.fetch(`https://api.plivo.com/v1/Account/${deps.secrets.plivoId}/Recording/${encodeURIComponent(params.RecordingID)}/`,
        {method: "DELETE", headers: {Authorization: plivoAuth(deps)}}).catch(() => undefined);
    }
    lang = heard.lang;
    call.turns.push({who: "customer", text: heard.text || "(silence)", lang, at: deps.now(), via: "speech"});
    const decided = await deps.decide(call, heard.text, lang);
    intent = decided.intent; reply = decided.reply; lang = decided.language; endCall = decided.end_call;
  } else {
    call.turns.push({who: "customer", text: "(silence)", lang, at: deps.now()});
    intent = "unclear";
  }
  call.lang = lang;
  const outcome = intent ? outcomeFor(intent) : null;
  if (outcome) return finish(deps, call, outcome);
  if (endCall || customerTurns + 1 >= MAX_TURNS) return finish(deps, call, "unclear");
  const url = await prompt(deps, call, reply || sorryRepeatText(lang), lang);
  call.updatedAt = deps.now();
  await deps.db.collection(CALLS).doc(call.id).set(call);
  return listenXml(url, callUrl(deps, call, "turn"));
}

export interface WebhookResult {status: number; contentType: string; body: string | Buffer}

/** Every Plivo callback and audio fetch lands here; each URL carries the call's own secret token. */
export async function handleVoiceWebhook(query: Record<string, string>, params: Record<string, string>,
  deps: VoiceAgentDeps): Promise<WebhookResult> {
  const xml = (body: string): WebhookResult => ({status: 200, contentType: "application/xml", body});
  const call = await loadCall(deps, String(query.call ?? ""), String(query.t ?? ""));
  if (!call) return {status: 404, contentType: "text/plain", body: "not found"};
  switch (query.op) {
    case "audio": {
      const n = Number(query.n);
      const wav = Number.isInteger(n) && n > 0 ? await deps.loadAudio(`private/voice-agent/${call.id}/${n}.wav`) : null;
      return wav ? {status: 200, contentType: "audio/wav", body: wav} : {status: 404, contentType: "text/plain", body: "not found"};
    }
    case "answer": {
      call.status = "in_progress";
      call.updatedAt = deps.now();
      await deps.db.collection(CALLS).doc(call.id).set(call);
      return xml(listenXml(callUrl(deps, call, "audio", {n: "1"}), callUrl(deps, call, "turn")));
    }
    case "turn": {
      if (call.status === "completed") return xml("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      try {
        return xml(await handleTurn(deps, call, params));
      } catch (error) {
        logger.warn("VOICE_CONFIRM_TURN_FAILED", {callId: call.id, error: error instanceof Error ? error.message : "unknown"});
        await deps.db.collection(RESULTS).doc(call.orderId).set({orderId: call.orderId, callId: call.id, status: "unclear", at: deps.now()});
        return xml("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Hangup/></Response>");
      }
    }
    case "hangup": {
      if (call.status !== "completed") {
        const answered = call.status === "in_progress";
        call.status = answered ? "completed" : "no_answer";
        call.outcome = call.outcome ?? (answered ? "unclear" : "no_answer");
        call.updatedAt = deps.now();
        await deps.db.collection(CALLS).doc(call.id).set({...call, hangupCause: String(params.HangupCause ?? "").slice(0, 60)});
        await deps.db.collection(RESULTS).doc(call.orderId).set({
          orderId: call.orderId, callId: call.id, status: call.outcome, at: call.updatedAt,
        });
      }
      return {status: 200, contentType: "text/plain", body: "ok"};
    }
    default:
      return {status: 400, contentType: "text/plain", body: "bad request"};
  }
}
