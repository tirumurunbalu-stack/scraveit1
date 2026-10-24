import type {DocumentReference} from "firebase-admin/firestore";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
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
 *  - Stories end 24 hours after posting; ended stories are deleted on a schedule.
 *  - Unfriending or blocking takes each person's posts out of the other's feed.
 *  - Comments (`posts/{id}/comments/{id}`) are seen by everyone the post is
 *    shown to. The app writes only who and what; the name shown is filled in
 *    here from the commenter's chat profile, and the poster gets a push.
 */

type Rec = Record<string, unknown>;

export const STORY_MS = 24 * 60 * 60 * 1000;
const posts = () => firestoreDb.collection("posts");
const media = () => firestoreDb.collection("postMedia");
const feedItems = (uid: string) => firestoreDb.collection("feeds").doc(uid).collection("feedItems");
const friendships = () => firestoreDb.collection("friendships");
const comments = (postId: string) => posts().doc(postId).collection("comments");

function millis(value: unknown, fallback: number): number {
  const v = value as {toMillis?: () => number} | number | undefined;
  if (v && typeof v === "object" && typeof v.toMillis === "function") return v.toMillis();
  return Number(v) || fallback;
}

/** The card a friend's feed holds for a post (no photo; that is fetched separately). */
export function feedCard(postId: string, post: Rec, fromName: string, now: number): Rec {
  const createdAt = millis(post.createdAt, now);
  const kind = post.kind === "story" ? "story" : "post";
  return {
    postId, from: String(post.from ?? ""), fromName: fromName.slice(0, 60), kind,
    caption: String(post.caption ?? "").slice(0, 200),
    w: Number(post.w) || 1, h: Number(post.h) || 1,
    createdAt, expiresAt: kind === "story" ? createdAt + STORY_MS : 0,
  };
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
  const pairs = await friendships().where("members", "array-contains", from).where("status", "==", "accepted").get();
  const audience = [from, ...pairs.docs.map((d) => ((d.data().members ?? []) as string[]).find((m) => m !== from) ?? "").filter(Boolean)];
  for (let i = 0; i < audience.length; i += 400) {
    const batch = firestoreDb.batch();
    audience.slice(i, i + 400).forEach((uid) => batch.set(feedItems(uid).doc(postId), card));
    await batch.commit();
  }
  await posts().doc(postId).set({expiresAt: card.expiresAt, audience: audience.length}, {merge: true});
}

/** A post deleted (by its poster, or because its story ended): its cards and photo go too. */
export async function onPostDeleted(postId: string): Promise<void> {
  const [cards, said] = await Promise.all([
    firestoreDb.collectionGroup("feedItems").where("postId", "==", postId).get(),
    comments(postId).get(),
  ]);
  await deleteAll([...cards.docs, ...said.docs]);
  const photo = await media().doc(postId).get();
  // A photo kept after a report (removed) stays for the investigation; otherwise it goes.
  if (photo.exists && photo.data()?.removed !== true) await photo.ref.delete();
}

/** Stories past 24 hours. Runs on a schedule. */
export async function deleteEndedStories(now = Date.now()): Promise<number> {
  const ended = await posts().where("kind", "==", "story").where("expiresAt", "<", now).limit(400).get();
  await deleteAll(ended.docs.filter((d) => Number(d.data().expiresAt) > 0));
  return ended.size;
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
