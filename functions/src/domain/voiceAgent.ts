/**
 * The COD confirmation call: what the agent says, how keypad presses and
 * spoken answers map to an outcome, and the Plivo XML that runs each turn.
 * Pure functions only; services/voiceAgent.ts does the I/O.
 */

export type VoiceLang = "te-IN" | "en-IN";
export type VoiceIntent = "confirm" | "cancel" | "change_request" | "question" | "unclear" | "wrong_person" | "call_later";
export type VoiceOutcome = "confirmed" | "cancelled" | "needs_followup" | "wrong_number" | "no_answer" | "unclear";

/** At most this many back-and-forths after the greeting; then the call ends politely. */
export const MAX_TURNS = 4;
export const VOICE_LANGS: readonly VoiceLang[] = ["te-IN", "en-IN"];

export interface VoiceOrderFacts {
  firstName: string;
  restaurant: string;
  items: Array<{name: string; quantity: number}>;
  total: number;
  area: string;
}

export function voiceLang(value: unknown, fallback: VoiceLang = "te-IN"): VoiceLang {
  const v = String(value ?? "");
  if (v.startsWith("te")) return "te-IN";
  if (v.startsWith("en")) return "en-IN";
  return fallback;
}

/** Indian mobile → E.164 digits without "+", as Plivo expects; null if it isn't one. */
export function indianMobile(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) :
    digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(local) ? `91${local}` : null;
}

function spokenAmount(total: number, lang: VoiceLang): string {
  const paise = Math.round(Math.max(0, total) * 100);
  const rupees = Math.floor(paise / 100), rest = paise % 100;
  if (lang === "te-IN") return rest ? `${rupees} రూపాయల ${rest} పైసలు` : `${rupees} రూపాయలు`;
  return rest ? `${rupees} rupees ${rest} paise` : `${rupees} rupees`;
}

function spokenItems(items: VoiceOrderFacts["items"], lang: VoiceLang): string {
  const shown = items.slice(0, 3).map((i) => `${Math.max(1, Math.round(i.quantity))} ${i.name}`);
  const more = items.length - shown.length;
  if (!more) return shown.join(", ");
  return lang === "te-IN" ? `${shown.join(", ")}, ఇంకా ${more} ఐటమ్స్` : `${shown.join(", ")} and ${more} more`;
}

export function greetingText(facts: VoiceOrderFacts, lang: VoiceLang): string {
  const name = facts.firstName.trim();
  const items = spokenItems(facts.items, lang), amount = spokenAmount(facts.total, lang);
  if (lang === "te-IN") {
    return `నమస్కారం${name ? ` ${name} గారు` : ""}. ఇది Scraveit ఆటోమేటెడ్ అసిస్టెంట్, ఈ కాల్ రికార్డ్ కావచ్చు. ` +
      `${facts.restaurant} నుండి మీ ఆర్డర్: ${items}. మొత్తం ${amount}, క్యాష్ ఆన్ డెలివరీ. ` +
      "ఆర్డర్ కన్ఫర్మ్ చేయాలా? అవును అని చెప్పండి, లేదా కన్ఫర్మ్ కోసం 1, క్యాన్సిల్ కోసం 2 నొక్కండి. For English, press 9.";
  }
  return `Hello${name ? ` ${name}` : ""}, this is Scraveit's automated assistant, and this call may be recorded. ` +
    `Your order from ${facts.restaurant}: ${items}. Total ${amount}, cash on delivery. ` +
    "Shall I confirm it? Say yes, or press 1 to confirm and 2 to cancel. తెలుగు కోసం 9 నొక్కండి.";
}

export function closingText(outcome: VoiceOutcome, lang: VoiceLang): string {
  const te = lang === "te-IN";
  switch (outcome) {
    case "confirmed": return te ? "ధన్యవాదాలు! మీ ఆర్డర్ కన్ఫర్మ్ అయింది. త్వరలో మీ దగ్గరికి వస్తుంది." :
      "Thank you! Your order is confirmed and on its way soon.";
    case "cancelled": return te ? "సరే, మీ ఆర్డర్ క్యాన్సిల్ చేశాం. మీకు ఎలాంటి ఛార్జీ లేదు. ధన్యవాదాలు." :
      "Okay, your order is cancelled and you won't be charged. Thank you.";
    case "wrong_number": return te ? "క్షమించండి, ఇబ్బంది పెట్టినందుకు. ధన్యవాదాలు." : "Sorry for the trouble. Goodbye.";
    case "needs_followup": return te ? "సరే, మా టీమ్ మీకు త్వరలో కాల్ చేస్తుంది. ధన్యవాదాలు." :
      "Okay, our team will call you back shortly. Thank you.";
    default: return te ? "మీ ఆర్డర్ అలాగే ఉంటుంది. ఏదైనా మార్పు ఉంటే యాప్‌లో చేయండి. ధన్యవాదాలు." :
      "Your order stays as it is. You can change it in the app. Thank you.";
  }
}

export function sorryRepeatText(lang: VoiceLang): string {
  return lang === "te-IN" ? "క్షమించండి, సరిగ్గా వినపడలేదు. ఆర్డర్ కన్ఫర్మ్ చేయాలా? కన్ఫర్మ్ కోసం 1, క్యాన్సిల్ కోసం 2 నొక్కండి." :
    "Sorry, I didn't catch that. Shall I confirm your order? Press 1 to confirm or 2 to cancel.";
}

/** A keypad press: 1 confirm, 2 cancel, 9 switch language. */
export function dtmfIntent(digits: unknown): VoiceIntent | "switch_language" | null {
  const d = String(digits ?? "").trim().slice(0, 1);
  if (d === "1") return "confirm";
  if (d === "2") return "cancel";
  if (d === "9") return "switch_language";
  return null;
}

/** What the call settles. Anything not plainly confirm/cancel never touches the order. */
export function outcomeFor(intent: VoiceIntent): VoiceOutcome | null {
  switch (intent) {
    case "confirm": return "confirmed";
    case "cancel": return "cancelled";
    case "wrong_person": return "wrong_number";
    case "change_request":
    case "call_later": return "needs_followup";
    default: return null;
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Play the prompt and wait for one key (barge-in); if no key comes, record
 * up to 10 s of speech, ending after 2 s of silence. Both post to `turnUrl`.
 */
export function listenXml(audioUrl: string, turnUrl: string): string {
  const a = escapeXml(audioUrl), t = escapeXml(turnUrl);
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response>" +
    `<GetDigits action="${t}" method="POST" numDigits="1" timeout="1" validDigits="129" retries="1"><Play>${a}</Play></GetDigits>` +
    `<Record action="${t}" method="POST" fileFormat="wav" maxLength="10" timeout="2" playBeep="false" finishOnKey="#"/>` +
    "</Response>";
}

export function hangupXml(audioUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escapeXml(audioUrl)}</Play><Hangup/></Response>`;
}

export const AGENT_SYSTEM_PROMPT = [
  "You are Scraveit's phone assistant, confirming a cash-on-delivery food order on a live call in Andhra Pradesh, India.",
  "The customer speaks Telugu, English, or a mix. Reply in the language they used last (te-IN or en-IN); Telugu replies are in Telugu script.",
  "Keep every reply to one or two short spoken sentences: no lists, no emoji, no markdown, nothing that cannot be read aloud.",
  "Decide the customer's intent from their latest words in the context of the call:",
  "- confirm: they clearly agree to receive and pay for the order (yes, ok, avunu, confirm, send it).",
  "- cancel: they clearly do not want the order. If they sound unsure, use unclear and ask them to confirm or cancel.",
  "- change_request: they want a different address, time, item or quantity. Tell them the team will call back; do not promise the change.",
  "- question: they ask something about the order you can answer from the order facts; answer it, then ask again whether to confirm.",
  "- wrong_person: they say they did not place this order or this is not their number.",
  "- call_later: they are busy or ask to be called later.",
  "- unclear: anything else, including silence or noise. Ask once more, briefly.",
  "Only use the order facts given. Never invent prices, times, discounts or policies. Never ask for OTPs, card or bank details.",
  "Set end_call to true for confirm, cancel, wrong_person, change_request and call_later.",
].join("\n");

export const AGENT_REPLY_SCHEMA = {
  type: "object",
  properties: {
    intent: {type: "string", enum: ["confirm", "cancel", "change_request", "question", "unclear", "wrong_person", "call_later"]},
    reply: {type: "string"},
    language: {type: "string", enum: ["te-IN", "en-IN"]},
    end_call: {type: "boolean"},
  },
  required: ["intent", "reply", "language", "end_call"],
  additionalProperties: false,
} as const;

export function orderFactsText(facts: VoiceOrderFacts): string {
  const items = facts.items.map((i) => `${Math.max(1, Math.round(i.quantity))} x ${i.name}`).join("; ");
  return `Order facts: restaurant ${facts.restaurant}; items ${items}; total ₹${facts.total.toFixed(2)} to pay in cash on delivery; delivery area ${facts.area || "on file"}.`;
}
