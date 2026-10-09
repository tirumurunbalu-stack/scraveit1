import {logger} from "firebase-functions";
import {auth, firestoreDb} from "../admin";
import {ageOn} from "../domain/customerSegments";
import {DomainError} from "../errors";
import {notifyUserChat} from "./notifications";

/**
 * Age and parental consent for the whole Scraveit account.
 *
 *  - Date of birth is asked at sign-up (or the first time an older account
 *    opens the app) and can be edited any time, so a mistake is easy to fix.
 *    Every change is logged, and if an account a parent approved (or was asked
 *    to approve) changes to 18+, that parent is told. Nothing is blocked.
 *  - Scraveit accounts are for 13 and over. From 13 to 17 a parent with their
 *    own Scraveit account (aged 18+) approves before the child can order or
 *    chat: DPDP Act 2023 s.9(1); DPDP Rules 2025 rule 10 (in force 14 May 2027).
 *  - The child can still browse while waiting. No offers or tracking are aimed
 *    at under-18s (s.9(3)); customer segments already leave them out.
 */

type Rec = Record<string, unknown>;
export const MIN_ACCOUNT_AGE = 13;
const ADULT = 18;

const ages = () => firestoreDb.collection("accountAges");
const parentRequests = () => firestoreDb.collection("parentRequests");
const chatProfiles = () => firestoreDb.collection("chatProfiles");

export async function loadAccountAge(uid: string): Promise<Rec | null> {
  const snap = await ages().doc(uid).get();
  return snap.exists ? snap.data() as Rec : null;
}

/** May this account order? Older accounts without a saved date of birth are let through. */
export function orderingAllowed(record: Rec | null): {ok: boolean; message: string} {
  if (!record || record.minor !== true) return {ok: true, message: ""};
  if (record.parentStatus === "approved") return {ok: true, message: ""};
  return {ok: false, message: record.parentStatus === "pending" ? "Your parent hasn't approved your account yet." : "A parent needs to approve your account before you can order."};
}

export async function assertMayOrder(uid: string): Promise<void> {
  const result = orderingAllowed(await loadAccountAge(uid));
  if (!result.ok) throw new DomainError("failed-precondition", result.message);
}

/** Copies the account's age and approval onto the chat profile, if there is one. */
async function syncChat(uid: string, fields: Rec): Promise<void> {
  const chat = await chatProfiles().doc(uid).get();
  if (chat.exists) await chatProfiles().doc(uid).set({...fields, updatedAt: Date.now()}, {merge: true});
}

async function displayName(uid: string): Promise<string> {
  const user = await firestoreDb.collection("users").doc(uid).get().catch(() => null);
  const name = user?.exists ? String((user.data() as Rec).name ?? "") : "";
  if (name) return name.slice(0, 60);
  const record = await auth.getUser(uid).catch(() => null);
  return String(record?.displayName ?? "").slice(0, 60);
}

export async function accountSetBirthDate(uid: string, input: {birthDate: string}, now = Date.now()) {
  const age = ageOn(input.birthDate, now);
  if (age === null) throw new DomainError("invalid-argument", "Enter a real date of birth.");
  if (age < MIN_ACCOUNT_AGE) throw new DomainError("failed-precondition", "Scraveit accounts are for people aged 13 and over. A parent can order for you from their account.");
  const ref = ages().doc(uid);
  const minor = age < ADULT;
  const before = await firestoreDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const previous = snap.exists ? snap.data() as Rec : null;
    if (previous?.birthDate === input.birthDate) return previous;
    const history = Array.isArray(previous?.history) ? (previous?.history as Rec[]).slice(-19) : [];
    if (previous?.birthDate) history.push({from: previous.birthDate, to: input.birthDate, at: now});
    // Still a minor: keep the parent's decision. Turning 18+: no approval needed. Becoming a minor: ask a parent.
    const parentStatus = minor ? (previous?.minor === true ? String(previous.parentStatus ?? "none") : "none") : "not-needed";
    tx.set(ref, {uid, birthDate: input.birthDate, minor, parentStatus, history, setAt: Number(previous?.setAt ?? now), updatedAt: now}, {merge: true});
    return previous;
  });
  const after = await loadAccountAge(uid);
  await syncChat(uid, {birthDate: input.birthDate, minor, parentStatus: String(after?.parentStatus ?? (minor ? "none" : "not-needed"))});
  // A linked child now showing 18+: tell the parent, so they know (nothing is blocked).
  if (before?.minor === true && !minor && before.parentUid && ["approved", "pending"].includes(String(before.parentStatus))) {
    const name = await displayName(uid);
    await notifyUserChat({uid: String(before.parentUid), key: `age-change:${uid}:${now}`, title: "Date of birth changed",
      body: `${name || "Your child"} changed their date of birth to show 18 or over.`, data: {route: "home"}}).catch(() => undefined);
  }
  return {minor, age, parentStatus: String(after?.parentStatus ?? "")};
}

export async function accountParentRequest(uid: string, input: {email: string}, now = Date.now()) {
  const me = await loadAccountAge(uid);
  if (!me) throw new DomainError("failed-precondition", "Add your date of birth first.");
  if (me.minor !== true) throw new DomainError("failed-precondition", "Parent approval is only for under-18s.");
  if (me.parentStatus === "approved") return {status: "approved"};
  const parentRecord = await auth.getUserByEmail(input.email.trim().toLowerCase()).catch(() => null);
  if (!parentRecord || parentRecord.uid === uid) throw new DomainError("not-found", "No Scraveit account uses that email. Ask your parent to create one first.");
  const parent = await loadAccountAge(parentRecord.uid);
  const parentAge = parent ? ageOn(parent.birthDate, now) : null;
  if (parentAge === null || parentAge < ADULT) {
    throw new DomainError("failed-precondition", "That account needs a date of birth showing 18 or over. Ask your parent to open Scraveit once and add it.");
  }
  const childName = await displayName(uid);
  const parentName = await displayName(parentRecord.uid);
  await parentRequests().doc(uid).set({childUid: uid, childName, childAge: ageOn(me.birthDate, now), parentUid: parentRecord.uid, status: "pending", scope: "account", createdAt: now});
  await ages().doc(uid).set({parentStatus: "pending", parentUid: parentRecord.uid, parentName, parentRequestedAt: now, updatedAt: now}, {merge: true});
  await syncChat(uid, {parentStatus: "pending", parentUid: parentRecord.uid, parentName});
  await notifyUserChat({uid: parentRecord.uid, key: `parent-request:${uid}:${now}`, title: "Approve your child's Scraveit account",
    body: `${childName || "Your child"} asked you to approve their account.`, data: {route: "home"}}).catch((error) => logger.warn("PARENT_REQUEST_PUSH_FAILED", {error: String(error)}));
  return {status: "pending", parentName};
}

export async function accountParentRespond(uid: string, input: {childUid: string; approve: boolean}, now = Date.now()) {
  const ref = parentRequests().doc(input.childUid);
  const snap = await ref.get();
  const request = snap.exists ? snap.data() as Rec : null;
  if (!request || request.parentUid !== uid) throw new DomainError("not-found", "That request isn't for you.");
  const parent = await loadAccountAge(uid);
  const parentAge = parent ? ageOn(parent.birthDate, now) : null;
  if (parentAge === null || parentAge < ADULT) throw new DomainError("failed-precondition", "Only an adult can approve.");
  const status = input.approve ? "approved" : "declined";
  await ref.set({status, respondedAt: now}, {merge: true});
  await ages().doc(input.childUid).set({parentStatus: status, parentRespondedAt: now, updatedAt: now}, {merge: true});
  await syncChat(input.childUid, {parentStatus: status, parentUid: uid});
  await notifyUserChat({uid: input.childUid, key: `parent-response:${input.childUid}:${now}`,
    title: input.approve ? "Your account is approved" : "Your account wasn't approved",
    body: input.approve ? "Your parent approved Scraveit. You can order and chat now." : "Your parent didn't approve your account.", data: {route: "home"}}).catch(() => undefined);
  return {status};
}

export async function accountParentRevoke(uid: string, input: {childUid: string}, now = Date.now()) {
  const child = await loadAccountAge(input.childUid);
  if (!child || child.parentUid !== uid) throw new DomainError("not-found", "That isn't your child's account.");
  await ages().doc(input.childUid).set({parentStatus: "revoked", updatedAt: now}, {merge: true});
  await parentRequests().doc(input.childUid).set({status: "revoked", respondedAt: now}, {merge: true});
  await syncChat(input.childUid, {parentStatus: "revoked"});
  return {status: "revoked"};
}
