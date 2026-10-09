import type {DecodedIdToken} from "firebase-admin/auth";
import {FieldValue} from "firebase-admin/firestore";
import {randomInt} from "node:crypto";
import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import {ageOn} from "../domain/customerSegments";
import {DomainError} from "../errors";
import {alarmAdmins, requestAlarmId} from "./adminAlerts";
import {accountSetBirthDate, loadAccountAge} from "./accountAge";
import {notifyUserChat} from "./notifications";

/**
 * Friends & chat (step 1): friend codes, friend requests, one-to-one chat,
 * report and block, and parent approval for 13-17 year olds.
 *
 *  - Nobody can be found by name or phone. A friend request needs your code,
 *    and nothing is delivered until you accept.
 *  - Chat is for 13 and over. Under 18, a parent who is a Scraveit user aged
 *    18+ must approve first (DPDP Act 2023 s.9; DPDP Rules 2025 rule 10 from
 *    14 May 2027). Self-declared ages until verified age tokens are available.
 *  - Messages are written by the app straight to Firestore under rules that
 *    allow it only between accepted friends; this file handles everything
 *    else, and a trigger hides phone numbers and sends the push.
 *  - Reported or removed messages are kept hidden for 180 days (IT Rules
 *    2021, rule 3(1)(g)); everything else stays until the user deletes it.
 */

type Rec = Record<string, unknown>;
const MIN_AGE = 13;
const ADULT = 18;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REPORT_REASONS = ["harassment", "sexual", "spam", "self-harm", "other"] as const;
export type ReportReason = typeof REPORT_REASONS[number];
const REMOVED_KEEP_MS = 180 * 24 * 60 * 60 * 1000;

const profiles = () => firestoreDb.collection("chatProfiles");
const codes = () => firestoreDb.collection("friendCodes");
const usernames = () => firestoreDb.collection("usernames");
const friendships = () => firestoreDb.collection("friendships");
const reports = () => firestoreDb.collection("chatReports");
const messagesOf = (pairId: string) => firestoreDb.collection("chats").doc(pairId).collection("messages");

export function pairIdFor(a: string, b: string): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function newFriendCode(): string {
  let code = "";
  for (let i = 0; i < 7; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function normalizeCode(raw: string): string {
  const clean = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length === 7 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : "";
}

const RESERVED = new Set(["admin", "scraveit", "support", "help", "official", "team", "staff", "rider", "restaurant", "savrivo", "moderator", "root", "system"]);
const USERNAME_CHANGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Usernames: 3-20 characters, lower-case letters, digits, "." and "_", starting with a letter. */
export function normalizeUsername(raw: string): string {
  return String(raw ?? "").trim().replace(/^@+/, "").toLowerCase();
}

export function usernameProblem(username: string): string {
  if (username.length < 3 || username.length > 20) return "Usernames are 3 to 20 characters.";
  if (!/^[a-z][a-z0-9._]*$/.test(username)) return "Use small letters, numbers, . and _, starting with a letter.";
  if (/[._]{2}/.test(username) || /[._]$/.test(username)) return "Don't end with . or _, or put two together.";
  if ([...RESERVED].some((word) => username.includes(word))) return "That username isn't available.";
  return "";
}

/** A few free usernames close to the one someone wanted. */
async function suggestUsernames(base: string): Promise<string[]> {
  const stem = base.replace(/[^a-z0-9]/g, "").slice(0, 14) || "foodie";
  const tries = [stem + randomInt(10, 99), stem + "." + randomInt(100, 999), stem + "_" + randomInt(10, 99), stem + randomInt(1000, 9999)];
  const free: string[] = [];
  for (const name of tries) {
    if (usernameProblem(name)) continue;
    if (!(await usernames().doc(name).get()).exists) free.push(name);
  }
  return free.slice(0, 3);
}

/** Takes a username for a person, releasing their old one. */
async function claimUsername(uid: string, username: string, previous: string, now: number): Promise<void> {
  const problem = usernameProblem(username);
  if (problem) throw new DomainError("invalid-argument", problem);
  const ref = usernames().doc(username);
  const taken = await firestoreDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && (snap.data() as Rec).uid !== uid) return true;
    tx.set(ref, {uid, at: now});
    if (previous && previous !== username) tx.delete(usernames().doc(previous));
    return false;
  });
  if (taken) {
    const ideas = await suggestUsernames(username);
    throw new DomainError("already-exists", `@${username} is taken.${ideas.length ? " Try " + ideas.map((x) => "@" + x).join(", ") + "." : ""}`);
  }
}

/** Hides phone numbers typed into chat, the same way order chat does. */
export function maskPhones(text: string): string {
  return text.replace(/(?:\+?91[\s-]*)?\d(?:[\s-]*\d){9}/g, "[phone number hidden]");
}

/** Can this person chat right now? */
export function chatAllowed(profile: Rec | null, now: number): {ok: boolean; reason: string} {
  if (!profile) return {ok: false, reason: "setup"};
  if (profile.status === "banned") return {ok: false, reason: "banned"};
  if (profile.status === "suspended" && Number(profile.suspendedUntil ?? 0) > now) return {ok: false, reason: "suspended"};
  if (profile.minor === true && profile.parentStatus !== "approved") return {ok: false, reason: "parent"};
  return {ok: true, reason: ""};
}

async function loadProfile(uid: string): Promise<Rec | null> {
  const snap = await profiles().doc(uid).get();
  return snap.exists ? snap.data() as Rec : null;
}

async function requireChatter(uid: string, now: number): Promise<Rec> {
  const profile = await loadProfile(uid);
  const allowed = chatAllowed(profile, now);
  if (!allowed.ok) {
    const message = allowed.reason === "setup" ? "Set up chat first." : allowed.reason === "parent" ? "A parent needs to approve chat first." :
      allowed.reason === "suspended" ? "Chat is paused on your account for a few days." : "Chat is turned off on your account.";
    throw new DomainError("failed-precondition", message);
  }
  return profile as Rec;
}

async function claimCode(uid: string, now: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newFriendCode();
    const ref = codes().doc(code);
    const created = await firestoreDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, {uid, at: now});
      return true;
    });
    if (created) return code;
  }
  throw new DomainError("unavailable", "Couldn't make a friend code. Try again.");
}

// ------------------------------------------------------------------ profile

/** Turns chat on. Age and parent approval come from the account (accountAge.ts). */
export async function chatSetup(uid: string, input: {name: string; birthDate?: string; username: string}, now = Date.now()) {
  let account = await loadAccountAge(uid);
  if (!account) {
    if (!input.birthDate) throw new DomainError("failed-precondition", "Add your date of birth first.");
    await accountSetBirthDate(uid, {birthDate: input.birthDate}, now);
    account = await loadAccountAge(uid);
  }
  const age = ageOn(account?.birthDate, now);
  if (age === null || age < MIN_AGE) throw new DomainError("failed-precondition", "Chat is for people aged 13 and over.");
  const existing = await loadProfile(uid);
  const minor = age < ADULT;
  const username = normalizeUsername(input.username);
  const currentUsername = String(existing?.username ?? "");
  if (username !== currentUsername) await claimUsername(uid, username, currentUsername, now);
  const code = String(existing?.code ?? "") || await claimCode(uid, now);
  const profile = {
    uid, name: input.name.trim().slice(0, 40), username, code, birthDate: String(account?.birthDate ?? ""), minor,
    ...(username !== currentUsername ? {usernameChangedAt: now} : {}),
    parentStatus: minor ? String(account?.parentStatus ?? "none") : "not-needed",
    ...(account?.parentUid ? {parentUid: account.parentUid, parentName: String(account.parentName ?? "")} : {}),
    // Under-18s can't be found by username, only by the code they choose to share.
    requests: minor ? (existing?.requests === "nobody" ? "nobody" : "code") : String(existing?.requests ?? "everyone"),
    status: String(existing?.status ?? "active"),
    createdAt: Number(existing?.createdAt ?? now), updatedAt: now,
  };
  await profiles().doc(uid).set(profile, {merge: true});
  return {code, username, minor, parentStatus: profile.parentStatus};
}

export async function chatNewCode(uid: string, now = Date.now()) {
  const profile = await requireChatter(uid, now);
  const code = await claimCode(uid, now);
  if (profile.code) await codes().doc(String(profile.code)).delete().catch(() => undefined);
  await profiles().doc(uid).set({code, updatedAt: now}, {merge: true});
  return {code};
}

export async function chatSetPrivacy(uid: string, input: {requests: "everyone" | "code" | "nobody"}, now = Date.now()) {
  const me = await requireChatter(uid, now);
  if (me.minor === true && input.requests === "everyone") throw new DomainError("failed-precondition", "Under 18, people can add you only with your code.");
  await profiles().doc(uid).set({requests: input.requests, updatedAt: now}, {merge: true});
  return {requests: input.requests};
}

export async function chatSetUsername(uid: string, input: {username: string}, now = Date.now()) {
  const me = await requireChatter(uid, now);
  const username = normalizeUsername(input.username);
  const current = String(me.username ?? "");
  if (username === current) return {username};
  if (current && now - Number(me.usernameChangedAt ?? 0) < USERNAME_CHANGE_MS) {
    throw new DomainError("failed-precondition", "You can change your username once every 14 days.");
  }
  await claimUsername(uid, username, current, now);
  await profiles().doc(uid).set({username, usernameChangedAt: now, updatedAt: now}, {merge: true});
  // Friends see the new username straight away.
  const pairs = await friendships().where("members", "array-contains", uid).get();
  await Promise.all(pairs.docs.map((d) => d.ref.update({[`usernames.${uid}`]: username}).catch(() => undefined)));
  return {username};
}

// ------------------------------------------------------------------ friends

/** Is this a friend code (ANA-4K7P) rather than a username? */
export function looksLikeCode(handle: string): boolean {
  return /^[A-Za-z0-9]{3}-?[A-Za-z0-9]{4}$/.test(handle.trim()) && /\d/.test(handle) && !handle.trim().startsWith("@");
}

export async function chatAddFriend(uid: string, input: {handle: string}, now = Date.now()) {
  const me = await requireChatter(uid, now);
  const handle = String(input.handle ?? "").trim();
  let byCode = false;
  let otherUid = "";
  if (looksLikeCode(handle)) {
    const code = normalizeCode(handle);
    const owner = code ? await codes().doc(code).get() : null;
    otherUid = owner?.exists ? String((owner.data() as Rec).uid ?? "") : "";
    byCode = !!otherUid;
  }
  if (!otherUid) {
    // Not a code anyone has: try it as a username (some usernames look like codes).
    const username = normalizeUsername(handle);
    const owner = username && !usernameProblem(username) ? await usernames().doc(username).get() : null;
    otherUid = owner?.exists ? String((owner.data() as Rec).uid ?? "") : "";
    if (!otherUid) throw new DomainError("not-found", "No one has that code or username. Check it with your friend.");
  }
  if (otherUid === uid) throw new DomainError("invalid-argument", "That's you.");
  const other = await loadProfile(otherUid);
  // "everyone": code or username; "code": code only (always so for under-18s); "nobody": no new requests.
  const allows = other?.requests === "nobody" ? false : byCode ? true : other?.requests !== "code" && other?.minor !== true;
  if (!other || !chatAllowed(other, now).ok || !allows) {
    throw new DomainError("failed-precondition", byCode ? "That person isn't taking friend requests right now." : "That person can only be added with their friend code.");
  }
  const pairId = pairIdFor(uid, otherUid);
  const ref = friendships().doc(pairId);
  return firestoreDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() as Rec : null;
    if (current?.status === "blocked") throw new DomainError("failed-precondition", "That person isn't taking friend requests right now.");
    if (current?.status === "accepted") return {pairId, status: "accepted"};
    if (current?.status === "pending" && current.requestedBy === otherUid) {
      // They had already asked you: adding them back accepts it.
      tx.set(ref, {status: "accepted", acceptedAt: now, updatedAt: now}, {merge: true});
      return {pairId, status: "accepted", name: other.name, username: other.username};
    }
    tx.set(ref, {
      pairId, members: [uid, otherUid].sort(), status: "pending", requestedBy: uid, via: byCode ? "code" : "username",
      names: {[uid]: String(me.name ?? ""), [otherUid]: String(other.name ?? "")},
      usernames: {[uid]: String(me.username ?? ""), [otherUid]: String(other.username ?? "")},
      minors: {[uid]: me.minor === true, [otherUid]: other.minor === true},
      createdAt: now, updatedAt: now,
    });
    return {pairId, status: "pending", name: other.name, username: other.username};
  });
}

export async function chatRespond(uid: string, input: {pairId: string; action: "accept" | "ignore" | "block" | "unblock" | "unfriend"}, now = Date.now()) {
  const ref = friendships().doc(input.pairId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() as Rec : null;
  if (!current || !(current.members as string[]).includes(uid)) throw new DomainError("not-found", "That chat isn't available.");
  const pending = current.status === "pending";
  switch (input.action) {
  case "accept":
    await requireChatter(uid, now);
    if (!pending || current.requestedBy === uid) throw new DomainError("failed-precondition", "There's no request to accept.");
    await ref.set({status: "accepted", acceptedAt: now, updatedAt: now}, {merge: true});
    break;
  case "ignore":
    if (!pending || current.requestedBy === uid) throw new DomainError("failed-precondition", "There's no request to ignore.");
    await ref.delete();
    break;
  case "block":
    await ref.set({status: "blocked", blockedBy: uid, blockedAt: now, updatedAt: now}, {merge: true});
    break;
  case "unblock":
    if (current.status !== "blocked" || current.blockedBy !== uid) throw new DomainError("failed-precondition", "You haven't blocked this person.");
    await ref.delete();
    break;
  case "unfriend":
    if (current.status !== "accepted") throw new DomainError("failed-precondition", "You aren't friends.");
    await ref.delete();
    break;
  }
  return {pairId: input.pairId, action: input.action};
}

export async function chatMarkRead(uid: string, input: {pairId: string}, now = Date.now()) {
  const ref = friendships().doc(input.pairId);
  const snap = await ref.get();
  if (!snap.exists || !((snap.data() as Rec).members as string[]).includes(uid)) throw new DomainError("not-found", "That chat isn't available.");
  await ref.update({[`readAt.${uid}`]: now, [`unread.${uid}`]: 0});
  return {pairId: input.pairId};
}

// ------------------------------------------------------------------ parents

export async function chatParentRequest(uid: string, input: {code: string}, now = Date.now()) {
  const me = await loadProfile(uid);
  if (!me) throw new DomainError("failed-precondition", "Set up chat first.");
  if (me.minor !== true) throw new DomainError("failed-precondition", "Parent approval is only for under-18s.");
  const code = normalizeCode(input.code);
  const owner = code ? await codes().doc(code).get() : null;
  const parentUid = owner?.exists ? String((owner.data() as Rec).uid ?? "") : "";
  if (!parentUid || parentUid === uid) throw new DomainError("not-found", "No parent account has that code.");
  const parent = await loadProfile(parentUid);
  const parentAge = parent ? ageOn(parent.birthDate, now) : null;
  if (!parent || parentAge === null || parentAge < ADULT) {
    throw new DomainError("failed-precondition", "Your parent needs their own Scraveit account with chat set up, aged 18 or over.");
  }
  await profiles().doc(uid).set({parentUid, parentName: String(parent.name ?? ""), parentStatus: "pending", parentRequestedAt: now, updatedAt: now}, {merge: true});
  await firestoreDb.collection("parentRequests").doc(uid).set({
    childUid: uid, childName: String(me.name ?? ""), childAge: ageOn(me.birthDate, now), parentUid, status: "pending", createdAt: now,
  });
  await notifyUserChat({uid: parentUid, key: `parent-request:${uid}:${now}`, title: "Approve chat for your child",
    body: `${String(me.name ?? "Your child")} asked you to approve Scraveit chat.`, data: {route: "friends"}}).catch(() => undefined);
  return {status: "pending", parentName: parent.name};
}

export async function chatParentRespond(uid: string, input: {childUid: string; approve: boolean}, now = Date.now()) {
  const ref = firestoreDb.collection("parentRequests").doc(input.childUid);
  const snap = await ref.get();
  const request = snap.exists ? snap.data() as Rec : null;
  if (!request || request.parentUid !== uid) throw new DomainError("not-found", "That request isn't for you.");
  const parent = await loadProfile(uid);
  const parentAge = parent ? ageOn(parent.birthDate, now) : null;
  if (parentAge === null || parentAge < ADULT) throw new DomainError("failed-precondition", "Only an adult can approve.");
  const status = input.approve ? "approved" : "declined";
  await ref.set({status, respondedAt: now}, {merge: true});
  await profiles().doc(input.childUid).set({parentStatus: status, parentRespondedAt: now, updatedAt: now}, {merge: true});
  if (input.approve) {
    // Parent and child become friends, so the parent can always reach them.
    const pairId = pairIdFor(uid, input.childUid);
    await friendships().doc(pairId).set({
      pairId, members: [uid, input.childUid].sort(), status: "accepted", requestedBy: input.childUid, via: "parent",
      names: {[uid]: String(parent?.name ?? ""), [input.childUid]: String(request.childName ?? "")},
      minors: {[uid]: false, [input.childUid]: true}, createdAt: now, acceptedAt: now, updatedAt: now,
    }, {merge: true});
  }
  await notifyUserChat({uid: input.childUid, key: `parent-response:${input.childUid}:${now}`,
    title: input.approve ? "Chat approved" : "Chat not approved",
    body: input.approve ? "Your parent approved chat. Add friends with your code." : "Your parent didn't approve chat.", data: {route: "friends"}}).catch(() => undefined);
  return {status};
}

/** A parent turning chat off for their child, at any time. */
export async function chatParentRevoke(uid: string, input: {childUid: string}, now = Date.now()) {
  const child = await loadProfile(input.childUid);
  if (!child || child.parentUid !== uid) throw new DomainError("not-found", "That isn't your child's account.");
  await profiles().doc(input.childUid).set({parentStatus: "revoked", updatedAt: now}, {merge: true});
  await firestoreDb.collection("parentRequests").doc(input.childUid).set({status: "revoked", respondedAt: now}, {merge: true});
  return {status: "revoked"};
}

// ------------------------------------------------------------------ reports

export async function chatReport(uid: string, input: {pairId: string; reason: ReportReason; note: string; block: boolean}, now = Date.now()) {
  const fsnap = await friendships().doc(input.pairId).get();
  const pair = fsnap.exists ? fsnap.data() as Rec : null;
  if (!pair || !(pair.members as string[]).includes(uid)) throw new DomainError("not-found", "That chat isn't available.");
  const reported = (pair.members as string[]).find((m) => m !== uid) ?? "";
  const recent = await messagesOf(input.pairId).orderBy("at", "desc").limit(20).get();
  const messages = recent.docs.reverse().map((d) => {
    const m = d.data() as Rec;
    const at = m.at && typeof (m.at as {toMillis?: () => number}).toMillis === "function" ? (m.at as {toMillis: () => number}).toMillis() : Number(m.at ?? 0);
    return {id: d.id, from: String(m.from ?? ""), text: String(m.text ?? "").slice(0, 1000), card: m.card ?? null, at};
  });
  const names = (pair.names ?? {}) as Record<string, string>;
  const minors = (pair.minors ?? {}) as Record<string, boolean>;
  const ref = reports().doc();
  // Sexual content involving a minor goes to the top, and is kept as evidence.
  const priority = input.reason === "sexual" && (minors[uid] || minors[reported]) ? "urgent" : input.reason === "sexual" || input.reason === "self-harm" ? "high" : "normal";
  await ref.set({
    id: ref.id, pairId: input.pairId, reporterUid: uid, reporterName: names[uid] ?? "", reportedUid: reported, reportedName: names[reported] ?? "",
    reportedUsername: String(((pair.usernames ?? {}) as Record<string, string>)[reported] ?? ""),
    reason: input.reason, note: input.note.slice(0, 500), messages, priority, involvesMinor: !!(minors[uid] || minors[reported]),
    status: "open", createdAt: now, respondBy: now + 24 * 60 * 60 * 1000, resolveBy: now + 15 * 24 * 60 * 60 * 1000,
  });
  if (input.block) await friendships().doc(input.pairId).set({status: "blocked", blockedBy: uid, blockedAt: now, updatedAt: now}, {merge: true});
  await alarmAdmins({key: `chat-report:${ref.id}`, alarmId: requestAlarmId("report", ref.id), route: `chatreport:${ref.id}`, issuedAt: now,
    title: priority === "urgent" ? "Urgent chat report (minor involved)" : "New chat report",
    body: `${names[uid] || "A customer"} reported ${names[reported] || "someone"}: ${input.reason}.`});
  return {reportId: ref.id};
}

export type ReportAction = "dismiss" | "warn" | "remove" | "suspend" | "ban";

export async function resolveChatReport(adminUid: string, token: DecodedIdToken, input: {reportId: string; action: ReportAction; note: string}, now = Date.now()) {
  if (!["owner", "ops_admin"].includes(String(token.savrivoRole ?? ""))) throw new DomainError("permission-denied", "Only Scraveit admins can act on reports.");
  const ref = reports().doc(input.reportId);
  const snap = await ref.get();
  const report = snap.exists ? snap.data() as Rec : null;
  if (!report) throw new DomainError("not-found", "Report not found.");
  const reported = String(report.reportedUid ?? "");
  if (input.action === "remove" || input.action === "suspend" || input.action === "ban") {
    // Hide the reported person's messages in that chat; kept 180 days for any investigation.
    const theirs = await messagesOf(String(report.pairId)).where("from", "==", reported).get();
    const batch = firestoreDb.batch();
    theirs.docs.forEach((d) => batch.update(d.ref, {removed: true, removedAt: now, deleteAfter: now + REMOVED_KEEP_MS}));
    if (!theirs.empty) await batch.commit();
  }
  if (input.action === "remove" || input.action === "suspend" || input.action === "ban") {
    await firestoreDb.collection("chatAvatars").doc(reported).delete().catch(() => undefined);
  }
  if (input.action === "suspend") await profiles().doc(reported).set({status: "suspended", suspendedUntil: now + 7 * 24 * 60 * 60 * 1000, updatedAt: now}, {merge: true});
  if (input.action === "ban") await profiles().doc(reported).set({status: "banned", bannedAt: now, updatedAt: now}, {merge: true});
  if (input.action === "warn" || input.action === "suspend" || input.action === "ban") {
    const text = input.action === "warn" ? "A message you sent broke Scraveit's chat rules. Please keep chats respectful." :
      input.action === "suspend" ? "Chat is paused on your account for 7 days because a message broke Scraveit's chat rules." :
        "Chat is turned off on your account because messages broke Scraveit's chat rules. Ordering still works.";
    await notifyUserChat({uid: reported, key: `report-action:${input.reportId}`, title: "About your chats", body: text, data: {route: "chats"}}).catch(() => undefined);
  }
  await notifyUserChat({uid: String(report.reporterUid), key: `report-done:${input.reportId}`, title: "We reviewed your report",
    body: input.action === "dismiss" ? "We didn't find a rule broken this time. You can still block anyone." : "Thanks for reporting. We've acted on it.", data: {route: "chats"}}).catch(() => undefined);
  await ref.set({status: "resolved", action: input.action, adminNote: input.note.slice(0, 500), resolvedBy: adminUid, resolvedAt: now}, {merge: true});
  return {reportId: input.reportId, action: input.action};
}

// ------------------------------------------------------------------ trigger

/** A new message: hide phone numbers, update the chat list, and push to the friend. */
export async function onChatMessage(pairId: string, messageId: string, message: Rec, now = Date.now()): Promise<void> {
  const from = String(message.from ?? "");
  const text = String(message.text ?? "");
  const masked = maskPhones(text);
  if (masked !== text) await messagesOf(pairId).doc(messageId).update({text: masked, phoneHidden: true});
  const pairSnap = await friendships().doc(pairId).get();
  const pair = pairSnap.exists ? pairSnap.data() as Rec : null;
  if (!pair || pair.status !== "accepted") return;
  const to = (pair.members as string[]).find((m) => m !== from);
  if (!to) return;
  const preview = message.card ? `🍽 ${String((message.card as Rec).name ?? "A dish")}` : masked.slice(0, 120);
  await friendships().doc(pairId).update({lastText: preview, lastFrom: from, lastAt: now, [`unread.${to}`]: FieldValue.increment(1), updatedAt: now});
  const names = (pair.names ?? {}) as Record<string, string>;
  await notifyUserChat({uid: to, key: `chat:${pairId}:${messageId}`, title: names[from] || "New message", body: preview, data: {route: `dm:${pairId}`}})
    .catch((error) => logger.warn("CHAT_PUSH_FAILED", {pairId, error: String(error)}));
}

/** Someone reacted to a message: the inbox shows "Reacted 😂 to your message" and the author gets a push. */
export async function onChatReaction(pairId: string, before: Rec, after: Rec, now = Date.now()): Promise<void> {
  const was = (before.reactions ?? {}) as Record<string, string>;
  const is = (after.reactions ?? {}) as Record<string, string>;
  const author = String(after.from ?? "");
  const reactor = Object.keys(is).find((uid) => is[uid] && is[uid] !== was[uid] && uid !== author);
  if (!reactor) return;
  const emoji = String(is[reactor]).slice(0, 8);
  const pairSnap = await friendships().doc(pairId).get();
  const pair = pairSnap.exists ? pairSnap.data() as Rec : null;
  if (!pair || pair.status !== "accepted") return;
  const names = (pair.names ?? {}) as Record<string, string>;
  const text = `Reacted ${emoji} to your message`;
  await friendships().doc(pairId).update({lastText: text, lastFrom: reactor, lastAt: now, [`unread.${author}`]: FieldValue.increment(1), updatedAt: now});
  await notifyUserChat({uid: author, key: `react:${pairId}:${reactor}:${now}`, title: names[reactor] || "Your friend", body: text, data: {route: `dm:${pairId}`}})
    .catch((error) => logger.warn("CHAT_REACTION_PUSH_FAILED", {pairId, error: String(error)}));
}
