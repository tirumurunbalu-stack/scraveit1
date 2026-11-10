import Anthropic from "@anthropic-ai/sdk";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {
  DAILY_DESCRIPTION_LIMIT, DESCRIPTION_SYSTEM_PROMPT, cleanDescription, descriptionPrompt,
} from "../domain/dishDescription";
import {isActiveMembershipForRestaurant, type RestaurantMembership} from "../domain/restaurantAccess";
import {DomainError} from "../errors";
import {FieldValue, type FirestoreLike} from "../firestoreTypes";
import {legacyStaffRef, restaurantMemberRef, restaurantRef} from "../firestorePaths";
import {ANTHROPIC_API_KEY} from "./voiceAgent";

export const DISH_DESCRIPTION_SECRETS = [ANTHROPIC_API_KEY];

export interface DishDescriptionInput {
  restaurantId: string;
  name: string;
  category: string;
  price: number;
  diet: string;
  current: string;
  instructions: string;
  imageUrl: string;
  imageData: string;
}

/** Anyone who may edit this outlet's menu may ask for a draft. */
async function requireMenuEditor(uid: string, token: DecodedIdToken, restaurantId: string, database: FirestoreLike): Promise<void> {
  if (token.savrivoRole === "owner" || token.savrivoRole === "ops_admin") return;
  const [normalized, legacy] = await Promise.all([
    restaurantMemberRef(database, restaurantId, uid).get(),
    legacyStaffRef(database, uid).get(),
  ]);
  const allowed = (member: RestaurantMembership | null, source: "path-scoped" | "legacy-global") =>
    isActiveMembershipForRestaurant(member, restaurantId, source) &&
    (["restaurant_owner", "restaurant_manager"].includes(member?.role ?? "") || member?.permissions?.menu === true);
  if (allowed((normalized.exists ? normalized.data() : null) as RestaurantMembership | null, "path-scoped") ||
    allowed((legacy.exists ? legacy.data() : null) as RestaurantMembership | null, "legacy-global")) return;
  throw new DomainError("permission-denied", "Only staff who can edit the menu can write descriptions.");
}

/** Counts today's drafts for the outlet and stops at the daily limit. */
async function takeDailyDraft(restaurantId: string, database: FirestoreLike): Promise<void> {
  const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10).replace(/-/g, "");
  const ref = database.collection("aiUsage").doc(`dishDescription_${restaurantId}_${day}`);
  await database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = Number(snap.exists ? (snap.data() as {count?: number}).count : 0) || 0;
    if (used >= DAILY_DESCRIPTION_LIMIT) {
      throw new DomainError("resource-exhausted", "Today's AI descriptions for this outlet are used up. Try again tomorrow.");
    }
    tx.set(ref, {restaurantId, day, count: FieldValue.increment(1), updatedAt: Date.now()}, {merge: true});
  });
}

function photoBlock(input: DishDescriptionInput): Anthropic.Beta.BetaImageBlockParam | null {
  const data = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(input.imageData);
  if (data?.[1]) return {type: "image", source: {type: "base64", media_type: "image/jpeg", data: data[1]}};
  if (input.imageUrl.startsWith("https://firebasestorage.googleapis.com/")) {
    return {type: "image", source: {type: "url", url: input.imageUrl}};
  }
  return null;
}

export async function suggestDishDescription(
  uid: string,
  token: DecodedIdToken,
  input: DishDescriptionInput,
  database: FirestoreLike = firestoreDb,
): Promise<{description: string}> {
  await requireMenuEditor(uid, token, input.restaurantId, database);
  const outlet = await restaurantRef(database, input.restaurantId).get();
  if (!outlet.exists) throw new DomainError("not-found", "Outlet not found.");
  await takeDailyDraft(input.restaurantId, database);

  const photo = photoBlock(input);
  const text = descriptionPrompt({
    name: input.name, category: input.category, price: input.price, diet: input.diet,
    restaurant: String((outlet.data() as {name?: string}).name ?? ""), current: input.current, instructions: input.instructions,
  }) + (photo ? "\nThe photo above is the restaurant's own photo of this dish." : "");

  const client = new Anthropic({apiKey: ANTHROPIC_API_KEY.value(), maxRetries: 1, timeout: 20_000});
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {effort: "low"},
      system: DESCRIPTION_SYSTEM_PROMPT,
      messages: [{role: "user", content: photo ? [photo, {type: "text", text}] : [{type: "text", text}]}],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      throw new DomainError("resource-exhausted", "The AI writer is busy. Try again in a minute.");
    }
    if (error instanceof Anthropic.APIError) {
      logger.error("Dish description request failed", {status: error.status, message: error.message.slice(0, 200)});
      throw new DomainError("unavailable", "The AI writer isn't available right now. Try again later.");
    }
    throw error;
  }
  if (response.stop_reason === "refusal") {
    throw new DomainError("failed-precondition", "The AI couldn't write this one. Try different words.");
  }
  const description = cleanDescription(response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" "));
  if (!description) throw new DomainError("unavailable", "The AI didn't return a description. Try again.");
  return {description};
}
