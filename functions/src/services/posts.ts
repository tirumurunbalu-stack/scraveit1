import type {DocumentReference} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {firestoreDb, storage} from "../admin";
import {notifyUserChat} from "./notifications";
import {requireChatter} from "./social";

/**
 * Friends' feed: food photos and 24-hour stories, seen only by the poster's
 * accepted friends (never public, never strangers).
 *
 *  - The app writes the photo to `postMedia/{id}` and the post to `posts/{id}`.
 *  - This service copies a small card of each new post into the feed of the
 *    poster and each of their friends (`feeds/{uid}/feedItems/{id}`). A friend may read
 *    a post's photo only while that card is in their feed (see firestore.rules).
 *  - Stories leave friends' trays 24 hours after posting. They then stay in the
 *    poster's archive for 30 days (friends lose access), unless the poster keeps
 *    them in a highlight, which friends can still open. Ended stories are cleared
 *    on a schedule.
 *  - A story can go to Close Friends only (`to: "close"`), and never reaches the
 *    people the poster hides their story from (`storyPrefs/{uid}`).
 *  - The poster can edit a caption or audience later; cards follow.
 *  - Interactive stickers (poll, question, slider, mention, dish) ride on the
 *    post; answers go to `posts/{id}/responses/{uid}` and are tallied here.
 *  - Video stories keep the clip in Storage at `storyVideos/{uid}/{postId}`;
 *    the photo slot holds its first frame.
 *  - Unfriending or blocking takes each person's posts out of the other's feed.
 *  - Comments (`posts/{id}/comments/{id}`) are seen by everyone the post is
 *    shown to. The app writes only who and what; the name shown is filled in
 *    here from the commenter's chat profile, and the poster gets a push.
 */

type Rec = Record<string, unknown>;

export const STORY_MS = 24 * 60 * 60 * 1000;
export const ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** Far in the future: a highlighted story is never cleared. */
export const KEEP = 8_000_000_000_000_000;
const posts = () => firestoreDb.collection("posts");
const media = () => firestoreDb.collection("postMedia");
const feedItems = (uid: string) => firestoreDb.collection("feeds").doc(uid).collection("feedItems");
const friendships = () => firestoreDb.collection("friendships");
const comments = (postId: string) => posts().doc(postId).collection("comments");
const responses = (postId: string) => posts().doc(postId).collection("responses");
const prefs = (uid: string) => firestoreDb.collection("storyPrefs").doc(uid);
export const videoPath = (uid: string, postId: string) => `storyVideos/${uid}/${postId}`;

function millis(value: unknown, fallback: number): number {
  const v = value as {toMillis?: () => number} | number | undefined;
  if (v && typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  return Number(v) || fallback;
}

/** The card a friend's feed holds for a post (no photo; that is fetched separately). */
export function feedCard(postId: string, post: Rec, fromName: string, now: number): Rec {
  const createdAt = millis(post.createdAt, now);
  const kind = post.kind === "story" ? "story" : "post";
  const card: Rec = {
    postId, from: String(post.from ?? ""), fromName: fromName.slice(0, 60), kind,
    caption: String(post.caption ?? "").slice(0, 200),
    w: Number(post.w) || 1, h: Number(post.h) || 1,
    createdAt, expiresAt: kind === "story" ? createdAt + STORY_MS : 0,
  };
  if (kind === "story" && post.to === "close") card.close = true;
  if (kind === "story" && post.video === true) {
    card.video = true;
    card.dur = Math.max(1000, Math.min(16000, Math.round(Number(post.dur) || 15000)));
  }
  return card;
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

/**
 * The interactive stickers a story may carry, cleaned to what the viewer
 * understands: where it sits (x, y in 0..1 of the photo, size, turn) and what
 * it says. A mention must name one of the poster's friends.
 */
export function cleanStickers(raw: unknown, friends: Set<string>): Rec[] {
  if (!Array.isArray(raw)) return [];
  const out: Rec[] = [];
  for (const s of raw.slice(0, 20)) {
    if (out.length >= 6) break;
    if (!s || typeof s !== "object") continue;
    const r = s as Rec, t = String(r.t ?? "");
    const at = {x: num(r.x, 0, 1, .5), y: num(r.y, 0, 1, .5), s: num(r.s, .3, 4, 1), r: num(r.r, -Math.PI, Math.PI, 0)};
    if (t === "poll") {
      const o = Array.isArray(r.o) ? r.o.slice(0, 4).map((v) => clip(v, 30)).filter(Boolean) : [];
      if (o.length >= 2) out.push({t, q: clip(r.q, 80), o, ...at});
    } else if (t === "ask") {
      out.push({t, q: clip(r.q, 80) || "Ask me anything", ...at});
    } else if (t === "slider") {
      out.push({t, q: clip(r.q, 80), e: clip(r.e, 8) || "😍", ...at});
    } else if (t === "mention") {
      const uid = clip(r.uid, 128);
      if (friends.has(uid)) out.push({t, uid, name: clip(r.name, 40), ...at});
    } else if (t === "dish") {
      const rid = clip(r.rid, 128);
      if (rid) out.push({t, rid, name: clip(r.name, 50), item: clip(r.item, 60), ...at});
    }
  }
  return out;
}

async function friendsOf(uid: string): Promise<string[]> {
  const pairs = await friendships().where("members", "array-contains", uid).where("status", "==", "accepted").get();
  return pairs.docs.map((d) => ((d.data().members ?? []) as string[]).find((m) => m !== uid) ?? "").filter(Boolean);
}

/**
 * Who sees a post: the poster and their friends. A story skips the people the
 * poster hides it from, and a Close Friends story goes only to that list.
 */
export function audienceOf(from: string, post: Rec, friends: string[], pref: Rec | undefined): string[] {
  let list = friends;
  if (post.kind === "story") {
    const hide = new Set(Array.isArray(pref?.hide) ? (pref?.hide as unknown[]).map(String) : []);
    list = list.filter((u) => !hide.has(u));
    if (post.to === "close") {
      const close = new Set(Array.isArray(pref?.close) ? (pref?.close as unknown[]).map(String) : []);
      list = list.filter((u) => close.has(u));
    }
  }
  return [from, ...list.filter((u) => u !== from)];
}

async function writeCards(postId: string, card: Rec, uids: string[]): Promise<void> {
  for (let i = 0; i < uids.length; i += 400) {
    const batch = firestoreDb.batch();
    uids.slice(i, i + 400).forEach((uid) => batch.set(feedItems(uid).doc(postId), card));
    await batch.commit();
  }
}

/** The feeds that hold a post's card now, keyed by whose feed it is. */
async function cardsOf(postId: string): Promise<Map<string, DocumentReference>> {
  const found = await firestoreDb.collectionGroup("feedItems").where("postId", "==", postId).get();
  return new Map(found.docs.map((d) => [d.ref.parent.parent?.id ?? "", d.ref]));
}

async function deleteAll(docs: Array<{ref: DocumentReference}>): Promise<void> {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = firestoreDb.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

/** A new post: check the poster may share, then put its card in their feed and every friend's. */
export async function onPostCreated(postId: string, post: Rec, now = Date.now()): Promise<void> {
  const from = String(post.from ?? "");
  let profile: Rec;
  try {
    profile = await requireChatter(from, now);
  } catch {
    // Not allowed to share (chat off, suspended, waiting for a parent): the post is withdrawn.
    await Promise.all([posts().doc(postId).delete(), media().doc(postId).delete()]).catch(() => undefined);
    return;
  }
  const card = feedCard(postId, post, String(profile.name ?? ""), now);
  const [friends, pref] = await Promise.all([friendsOf(from), post.kind === "story" ? prefs(from).get() : null]);
  const audience = audienceOf(from, post, friends, pref?.data());
  await writeCards(postId, card, audience);
  const stickers = cleanStickers(post.stickers, new Set(friends));
  await posts().doc(postId).set({expiresAt: card.expiresAt, audience: audience.length, stickers}, {merge: true});
  // Friends mentioned in a story (and able to see it) hear about it.
  const name = String(profile.name ?? "").slice(0, 60) || "A friend", seeing = new Set(audience);
  const mentioned = [...new Set(stickers.filter((s) => s.t === "mention").map((s) => String(s.uid)))].filter((u) => seeing.has(u) && u !== from);
  await Promise.all(mentioned.map((uid) => notifyUserChat({uid, key: `story-mention:${postId}`,
    title: `${name} mentioned you in their story`, body: "Tap to see it.", data: {route: "feed"}})
    .catch((error) => logger.warn("MENTION_PUSH_FAILED", {error: String(error)}))));
}

/**
 * The poster changed a post: a new caption, a new audience, or a story kept in
 * (or taken out of) a highlight. Cards follow, so the right friends see it.
 */
export async function onPostUpdated(postId: string, before: Rec, after: Rec, now = Date.now()): Promise<void> {
  const changed = (k: string) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null);
  const kept = after.hl === true, keptChanged = (before.hl === true) !== kept;
  if (!changed("caption") && !changed("to") && !keptChanged) return;
  const from = String(after.from ?? "");
  if (!from) return;
  const profile = await requireChatter(from, now).catch(() => null);
  if (!profile) return;
  // A story past its day reaches friends again only while it's kept in a highlight.
  const live = after.kind !== "story" || after.archived !== true || kept;
  const [friends, pref, have] = await Promise.all([friendsOf(from), after.kind === "story" ? prefs(from).get() : null, cardsOf(postId)]);
  const audience = live ? audienceOf(from, after, friends, pref?.data()) : [from];
  const card = feedCard(postId, after, String(profile.name ?? ""), now);
  await writeCards(postId, card, audience);
  const keep = new Set(audience);
  await deleteAll([...have.entries()].filter(([uid]) => !keep.has(uid)).map(([, ref]) => ({ref})));
  if (keptChanged && after.kind === "story") {
    const created = millis(after.createdAt, now);
    const expiresAt = kept ? KEEP : after.archived === true ? created + ARCHIVE_MS : created + STORY_MS;
    await posts().doc(postId).set({expiresAt, audience: audience.length}, {merge: true});
  } else {
    await posts().doc(postId).set({audience: audience.length}, {merge: true});
  }
}

/** A post deleted (by its poster, or because its story ended): its cards and photo go too. */
export async function onPostDeleted(postId: string, post?: Rec): Promise<void> {
  const [cards, said, answers] = await Promise.all([
    firestoreDb.collectionGroup("feedItems").where("postId", "==", postId).get(),
    comments(postId).get(),
    responses(postId).get(),
  ]);
  await deleteAll([...cards.docs, ...said.docs, ...answers.docs]);
  if (post?.video === true && post.from) {
    await storage.bucket().file(videoPath(String(post.from), postId)).delete({ignoreNotFound: true})
      .catch((error) => logger.warn("STORY_VIDEO_DELETE_FAILED", {error: String(error)}));
  }
  const photo = await media().doc(postId).get();
  // A photo kept after a report (removed) stays for the investigation; otherwise it goes.
  if (photo.exists && photo.data()?.removed !== true) await photo.ref.delete();
}

/**
 * Stories past their time. Runs on a schedule. After a day a story leaves
 * friends' feeds and waits 30 days in the poster's archive; a highlighted one
 * stays; an archived one past 30 days is deleted.
 */
export async function deleteEndedStories(now = Date.now()): Promise<number> {
  const ended = await posts().where("kind", "==", "story").where("expiresAt", "<", now).limit(200).get();
  const gone: Array<{ref: DocumentReference}> = [];
  for (const d of ended.docs) {
    const p = d.data(), from = String(p.from ?? "");
    if (!(Number(p.expiresAt) > 0)) continue;
    if (p.hl === true) {
      await d.ref.set({expiresAt: KEEP}, {merge: true});
    } else if (p.archived !== true) {
      const have = await cardsOf(d.id);
      await deleteAll([...have.entries()].filter(([uid]) => uid !== from).map(([, ref]) => ({ref})));
      await d.ref.set({archived: true, expiresAt: millis(p.createdAt, now) + ARCHIVE_MS}, {merge: true});
    } else {
      gone.push(d);
    }
  }
  await deleteAll(gone);
  return ended.size;
}

/**
 * Answers to a story's stickers, totted up on the story so friends see the
 * poll split and the slider average: tally[i] = {n, votes} or {n, avg}.
 */
export function tallyOf(stickers: unknown, answers: Rec[]): Rec {
  const list = Array.isArray(stickers) ? stickers as Rec[] : [];
  const tally: Rec = {};
  list.forEach((s, i) => {
    const key = String(i);
    if (s.t === "poll") {
      const votes = (Array.isArray(s.o) ? s.o : []).map(() => 0);
      for (const a of answers) {
        const v = Number((a.poll as Rec | undefined)?.[key]);
        if (Number.isInteger(v) && v >= 0 && v < votes.length) votes[v] = (votes[v] ?? 0) + 1;
      }
      tally[key] = {n: votes.reduce((x, y) => x + y, 0), votes};
    } else if (s.t === "slider") {
      const vals = answers.map((a) => Number((a.slider as Rec | undefined)?.[key])).filter((v) => Number.isFinite(v) && v >= 0 && v <= 100);
      tally[key] = {n: vals.length, avg: vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : 0};
    } else if (s.t === "ask") {
      tally[key] = {n: answers.filter((a) => clip((a.ask as Rec | undefined)?.[key], 200)).length};
    }
  });
  return tally;
}

/** Someone answered a story's sticker: refresh the totals on the story. */
export async function onStoryResponse(postId: string): Promise<void> {
  const [post, all] = await Promise.all([posts().doc(postId).get(), responses(postId).get()]);
  if (!post.exists) return;
  await post.ref.set({tally: tallyOf(post.data()?.stickers, all.docs.map((d) => d.data()))}, {merge: true});
}

/** No longer friends (unfriended, blocked, or request removed): each person's posts leave the other's feed. */
export async function unlinkFeeds(a: string, b: string): Promise<void> {
  if (!a || !b) return;
  const [ab, ba] = await Promise.all([
    feedItems(a).where("from", "==", b).get(),
    feedItems(b).where("from", "==", a).get(),
  ]);
  await deleteAll([...ab.docs, ...ba.docs]);
}

export async function onFriendshipChanged(before: Rec | undefined, after: Rec | undefined): Promise<void> {
  const was = before?.status === "accepted", is = after?.status === "accepted";
  if (!was || is) return;
  const [a = "", b = ""] = (before?.members ?? []) as string[];
  await unlinkFeeds(a, b).catch((error) => logger.warn("FEED_UNLINK_FAILED", {error: String(error)}));
}

/** A report acted on: the reported person's posts and comments are taken down; photos are kept hidden for the investigation. */
export async function takeDownPosts(uid: string, now = Date.now()): Promise<void> {
  const [theirs, said] = await Promise.all([
    posts().where("from", "==", uid).get(),
    firestoreDb.collectionGroup("comments").where("from", "==", uid).get(),
  ]);
  await deleteAll(said.docs);
  for (const post of theirs.docs) {
    await media().doc(post.id).set({removed: true, removedAt: now}, {merge: true}).catch(() => undefined);
    await post.ref.delete();
  }
}

/** The push a poster gets for a comment. */
export function commentNotice(name: string, kind: unknown, text: unknown): {title: string; body: string} {
  return {
    title: `${name || "A friend"} commented on your ${kind === "story" ? "story" : "post"}`,
    body: String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

/** A new comment: drop it if the commenter may not share, else put their name on it and tell the poster. */
export async function onCommentCreated(postId: string, commentId: string, comment: Rec, now = Date.now()): Promise<void> {
  const ref = comments(postId).doc(commentId);
  const from = String(comment.from ?? "");
  let profile: Rec;
  try {
    profile = await requireChatter(from, now);
  } catch {
    await ref.delete().catch(() => undefined);
    return;
  }
  const post = await posts().doc(postId).get();
  if (!post.exists) {
    await ref.delete().catch(() => undefined);
    return;
  }
  const name = String(profile.name ?? "").slice(0, 60);
  await ref.set({fromName: name}, {merge: true});
  const owner = String(post.data()?.from ?? "");
  if (!owner || owner === from) return;
  const notice = commentNotice(name, post.data()?.kind, comment.text);
  await notifyUserChat({uid: owner, key: `post-comment:${postId}:${commentId}`, ...notice, data: {route: "feed"}})
    .catch((error) => logger.warn("COMMENT_PUSH_FAILED", {error: String(error)}));
}
