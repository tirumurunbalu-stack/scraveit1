import type {DecodedIdToken} from "firebase-admin/auth";
import {randomUUID} from "node:crypto";
import {logger} from "firebase-functions";
import {firestoreDb, storage} from "../admin";
import {DomainError} from "../errors";
import {requireChatter} from "./social";

/**
 * Public food reels: short videos (up to 60 seconds) anyone signed in can watch, nearest city first.
 *
 *  - The app uploads the clip to `reelVideos/{uid}/{reelId}` and a first-frame picture to
 *    `reelThumbs/{uid}/{reelId}`, then calls createReel. Only this service writes `reels/{id}`:
 *    it checks the poster (chat set up, not under 18: DPDP Act s.9), the files and a daily limit,
 *    and fills in the poster's public name.
 *  - Every new reel starts "review": only the poster (and admins) see it until an admin approves
 *    it; then it is "live" for everyone. IT Rules 2021 duties: anyone can report a reel, three
 *    reports from different people hide it until an admin looks again, and removed reels lose
 *    their files.
 *  - The clip plays from a Storage download link stored on the reel. The reel document (and so
 *    the link) is readable only once it is live, by its poster, or by admins (firestore.rules).
 *  - Likes are written by the app itself (firestore.rules keep likeCount honest); location is the
 *    city name only, never a position.
 */

type Rec = Record<string, unknown>;

export const REEL_MAX_MS = 60_500;
const REEL_MAX_BYTES = 25 * 1024 * 1024;
const THUMB_MAX_BYTES = 400 * 1024;
const DAILY_LIMIT = 10;
const HIDE_AFTER_REPORTS = 3;
export const REEL_REPORT_REASONS = ["nudity", "violence", "hate", "harassment", "spam", "copyright", "child-safety", "other"] as const;

const reels = () => firestoreDb.collection("reels");
const reelLog = () => firestoreDb.collection("reelModeration");
export const reelVideoPath = (uid: string, reelId: string) => `reelVideos/${uid}/${reelId}`;
export const reelThumbPath = (uid: string, reelId: string) => `reelThumbs/${uid}/${reelId}`;

function isAdmin(token: DecodedIdToken): boolean {
  return ["owner", "ops_admin"].includes(String(token.savrivoRole ?? ""));
}

/** A city name a person typed or picked: letters, spaces, dots and hyphens, at most 40 characters. */
export function cleanCity(value: unknown): string {
  const city = String(value ?? "").replace(/[^\p{L}\s.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return /\p{L}/u.test(city) ? city : "";
}

/** Gives a Storage file a download link (a long random token) and returns it. */
async function downloadUrl(path: string, maxBytes: number, type: RegExp): Promise<string> {
  const bucket = storage.bucket();
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new DomainError("failed-precondition", "The video didn't finish uploading. Try again.");
  const [meta] = await file.getMetadata();
  if (Number(meta.size ?? 0) > maxBytes || !type.test(String(meta.contentType ?? ""))) {
    throw new DomainError("invalid-argument", "That video file can't be used.");
  }
  const token = randomUUID();
  await file.setMetadata({metadata: {firebaseStorageDownloadTokens: token}});
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

async function deleteReelFiles(uid: string, reelId: string): Promise<void> {
  await Promise.all([reelVideoPath(uid, reelId), reelThumbPath(uid, reelId)]
    .map((path) => storage.bucket().file(path).delete({ignoreNotFound: true}).catch((error) => logger.warn("REEL_FILE_DELETE_FAILED", {path, error: String(error)}))));
}

export async function createReel(uid: string, input: {reelId: string; caption: string; w: number; h: number; dur: number; city: string; ownWork: boolean}, now = Date.now()) {
  const profile = await requireChatter(uid, now);
  if (profile.minor === true) throw new DomainError("permission-denied", "Public reels aren't available under 18.");
  if (input.ownWork !== true) throw new DomainError("failed-precondition", "Confirm the video and sound are yours to share.");
  const ref = reels().doc(input.reelId);
  if ((await ref.get()).exists) throw new DomainError("already-exists", "This reel was already posted.");
  const recent = await reels().where("from", "==", uid).orderBy("createdAt", "desc").limit(DAILY_LIMIT).get();
  if (recent.docs.filter((d) => Number(d.data().createdAt ?? 0) > now - 24 * 60 * 60 * 1000).length >= DAILY_LIMIT) throw new DomainError("resource-exhausted", `You can post up to ${DAILY_LIMIT} reels a day.`);
  const [videoUrl, thumbUrl] = await Promise.all([
    downloadUrl(reelVideoPath(uid, input.reelId), REEL_MAX_BYTES, /^video\/(mp4|webm)$/),
    downloadUrl(reelThumbPath(uid, input.reelId), THUMB_MAX_BYTES, /^image\/jpeg$/),
  ]);
  const reel = {
    from: uid,
    by: {name: (String(profile.name ?? "").split(" ")[0] ?? "").slice(0, 40), username: String(profile.username ?? "").slice(0, 30)},
    caption: String(input.caption ?? "").trim().slice(0, 200),
    w: input.w, h: input.h, dur: input.dur,
    city: cleanCity(input.city),
    status: "review",
    likeCount: 0,
    reportCount: 0,
    videoUrl, thumbUrl,
    ownWorkConfirmedAt: now,
    createdAt: now,
  };
  await ref.set(reel);
  logger.info("REEL_CREATED", {uid, reelId: input.reelId});
  return {reelId: input.reelId, status: "review"};
}

export async function reportReel(uid: string, input: {reelId: string; reason: string; note: string}, now = Date.now()) {
  const ref = reels().doc(input.reelId);
  const reportRef = ref.collection("reports").doc(uid);
  return firestoreDb.runTransaction(async (tx) => {
    const [snap, already] = await Promise.all([tx.get(ref), tx.get(reportRef)]);
    const reel = snap.exists ? snap.data() as Rec : null;
    if (!reel || reel.status !== "live") throw new DomainError("not-found", "This reel isn't available.");
    if (reel.from === uid) throw new DomainError("failed-precondition", "You can delete your own reel instead.");
    if (already.exists) return {reported: true};
    const count = Number(reel.reportCount ?? 0) + 1;
    tx.set(reportRef, {from: uid, reason: input.reason, note: String(input.note ?? "").slice(0, 500), at: now});
    // A child-safety report hides the reel straight away; others after three different people.
    const hide = input.reason === "child-safety" || count >= HIDE_AFTER_REPORTS;
    tx.update(ref, {reportCount: count, ...(hide ? {status: "hidden", hiddenAt: now} : {})});
    return {reported: true};
  });
}

export async function reviewReel(adminUid: string, token: DecodedIdToken, input: {reelId: string; decision: "approve" | "remove"; note: string}, now = Date.now()) {
  if (!isAdmin(token)) throw new DomainError("permission-denied", "Only Scraveit admins can review reels.");
  const ref = reels().doc(input.reelId);
  const snap = await ref.get();
  const reel = snap.exists ? snap.data() as Rec : null;
  if (!reel) throw new DomainError("not-found", "Reel not found.");
  if (input.decision === "approve") {
    await ref.update({status: "live", liveAt: now, reviewedBy: adminUid});
  } else {
    await ref.update({status: "removed", removedAt: now, reviewedBy: adminUid, videoUrl: "", thumbUrl: ""});
    await deleteReelFiles(String(reel.from), input.reelId);
  }
  await reelLog().add({reelId: input.reelId, from: reel.from, decision: input.decision, note: String(input.note ?? "").slice(0, 500), adminUid, at: now});
  return {status: input.decision === "approve" ? "live" : "removed"};
}

/** The poster deleted their reel: its files go too. */
export async function onReelDeleted(reelId: string, reel: Rec): Promise<void> {
  await deleteReelFiles(String(reel.from ?? ""), reelId);
}
