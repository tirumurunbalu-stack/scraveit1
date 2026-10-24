import {logger} from "firebase-functions";
import {defineSecret} from "firebase-functions/params";
import {firestoreDb} from "../admin";
import {DomainError} from "../errors";
import {FieldValue, type FirestoreLike} from "../firestoreTypes";
import {notifyCallEnded, notifyCallIncoming} from "./notifications";

// Voice and video calls between friends. The phones talk to each other over WebRTC; the call
// document (calls/{callId}) carries the offer, answer and status, and Cloudflare's TURN relay
// carries the media when two mobile networks can't reach each other directly.
export const CLOUDFLARE_TURN_KEY_ID = defineSecret("CLOUDFLARE_TURN_KEY_ID");
export const CLOUDFLARE_TURN_API_TOKEN = defineSecret("CLOUDFLARE_TURN_API_TOKEN");
export const CALL_SECRETS = [CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN];

type Rec = Record<string, unknown>;
const STUN_ONLY = [{urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]}];
const ENDED = ["ended", "missed", "cancelled", "declined", "busy"];

function secret(s: {value(): string}): string {
  try { return s.value().trim(); } catch { return ""; }
}

/** Short-lived TURN credentials for one call (an hour), or plain STUN if TURN isn't set up yet. */
export async function callIceServers(uid: string, http: typeof fetch = fetch): Promise<{iceServers: Array<Rec>; relay: boolean}> {
  if (!uid) throw new DomainError("unauthenticated", "Sign in to call.");
  const keyId = secret(CLOUDFLARE_TURN_KEY_ID), token = secret(CLOUDFLARE_TURN_API_TOKEN);
  if (!keyId || !token) return {iceServers: STUN_ONLY, relay: false};
  try {
    const res = await http(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {"Authorization": `Bearer ${token}`, "Content-Type": "application/json"},
      body: JSON.stringify({ttl: 3600}),
    });
    if (!res.ok) throw new Error(`TURN_HTTP_${res.status}`);
    const body = await res.json() as {iceServers?: Rec | Rec[]};
    const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    const clean = list.filter((s) => s && (typeof s.urls === "string" || Array.isArray(s.urls)));
    if (!clean.length) throw new Error("TURN_EMPTY");
    return {iceServers: STUN_ONLY.concat(clean as never[]), relay: true};
  } catch (error) {
    logger.warn("CALL_TURN_UNAVAILABLE", {error: error instanceof Error ? error.message : "unknown"});
    return {iceServers: STUN_ONLY, relay: false};
  }
}

function callLength(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A call document changed: ring the friend's phone when it starts, stop the ringing when it
 * stops, and leave a line in the chat ("Missed video call", "Voice call · 4:12").
 */
export async function onCallWritten(callId: string, before: Rec | null, after: Rec | null, db: FirestoreLike = firestoreDb, now = Date.now()): Promise<void> {
  if (!after) return;
  const from = String(after.from ?? ""), to = String(after.to ?? ""), pairId = String(after.pairId ?? ""), kind = after.kind === "video" ? "video" : "audio";
  if (!from || !to || !pairId) return;
  const status = String(after.status ?? ""), was = before ? String(before.status ?? "") : "";
  const pairSnap = await db.collection("friendships").doc(pairId).get();
  const pair = pairSnap.exists ? pairSnap.data() as Rec : null;
  if (!pair || pair.status !== "accepted") return;
  const names = (pair.names ?? {}) as Record<string, string>;
  const caller = names[from] || "A friend";

  if (!before && status === "ringing") {
    await notifyCallIncoming({uid: to, callId, pairId, kind, fromName: caller})
      .catch((error) => logger.warn("CALL_PUSH_FAILED", {callId, error: String(error)}));
    return;
  }
  if (was === status || !ENDED.includes(status)) return;
  const answered = Number(after.answeredAt ?? 0) > 0;
  const missed = !answered && (status === "missed" || status === "cancelled" || (status === "ended" && was === "ringing"));
  if (was === "ringing" || missed) {
    await notifyCallEnded({uid: to, callId, pairId, missed, kind, fromName: caller})
      .catch((error) => logger.warn("CALL_PUSH_FAILED", {callId, error: String(error)}));
  }
  // One line in the chat, written once per call.
  const card: Rec = answered && (status === "ended")
    ? {type: "call", kind, status: "done", ms: Math.max(0, Number(after.endedAt ?? now) - Number(after.answeredAt))}
    : {type: "call", kind, status: status === "declined" ? "declined" : status === "busy" ? "busy" : "missed"};
  await db.collection("chats").doc(pairId).collection("messages").doc(`call_${callId}`).set({
    // A server timestamp like every other message, so the line sorts into place in the thread.
    from, text: "", card, at: FieldValue.serverTimestamp(), system: true,
  }).catch((error) => logger.warn("CALL_LOG_FAILED", {callId, error: String(error)}));
}

/** What the chat list shows for a call line. */
export function callPreview(card: Rec): string {
  const what = card.kind === "video" ? "video call" : "voice call";
  if (card.status === "done") return `📞 ${what[0]!.toUpperCase()}${what.slice(1)} · ${callLength(Number(card.ms) || 0)}`;
  if (card.status === "declined") return `📞 Declined ${what}`;
  return `📞 Missed ${what}`;
}
