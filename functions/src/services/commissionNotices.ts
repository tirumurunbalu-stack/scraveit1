import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb, storage} from "../admin";
import {DomainError} from "../errors";
import type {FirestoreLike, TransactionLike} from "../firestoreTypes";
import {restaurantMemberRef, restaurantRef} from "../firestorePaths";
import {requirePlatformConfigAdminClaim} from "./authz";
import {liveCommission} from "./economicsAdmin";
import {clearEconomicsControlCache, economicsControlRef, ECONOMICS_HISTORY_COLLECTION} from "./economics";
import {applyEconomicsControlUpdate, normalizeEconomicsControl, type EconomicsControl} from "../domain/economicsControl";
import {
  COMMISSION_NOTICE_DAYS,
  agreementText,
  istDate,
  renderCommissionNotice,
  type AgreementSection,
} from "../domain/restaurantOnboarding";
import {buildAgreementPdf, loadAgreementParty} from "./restaurantOnboarding";
import {notifyStoreApplicant} from "./notifications";

/**
 * Commission changes after an agreement is signed. Scraveit sends a notice
 * (at least 30 days ahead for a higher rate); the owner reads it and taps
 * Accept, which books the new rate as a dated commercial plan, so it starts on
 * its date by itself. A lower rate needs no acceptance. Not accepting a higher
 * rate keeps the old one: during the fixed period the agreement simply
 * continues; after it, the partnership ends on that date (Admin pauses the
 * store, nothing here delists anything).
 */

export const COMMISSION_NOTICES = "commissionNotices";
const DAY = 86_400_000;
const MAX_OUTLETS = 40;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const str = (value: unknown, max = 300) => String(value ?? "").trim().slice(0, max);

export type NoticeStatus = "pending" | "accepted" | "applied" | "withdrawn" | "lapsed";

export interface NoticeOutlet {restaurantId: string; name: string; fromBps: number}

export interface CommissionNoticeView {
  noticeId: string;
  status: NoticeStatus;
  outlets: Array<NoticeOutlet & {accepted: boolean}>;
  toBps: number;
  effectiveAt: number;
  effectiveDate: string;
  sentAt: number;
  consequence: "ends" | "keeps";
  lower: boolean;
  sections: AgreementSection[];
  hash: string;
  note: string;
}

/** Midnight IST at the start of a YYYY-MM-DD day. */
function istMidnight(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  return Date.parse(`${date}T00:00:00+05:30`);
}

function addMonths(at: number, months: number): number {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

function noticeHash(sections: AgreementSection[]): string {
  return createHash("sha256").update(`commission-notice\n${agreementText(sections)}`).digest("hex");
}

function statusOf(notice: Rec, now: number): NoticeStatus {
  const status = str(notice.status) as NoticeStatus;
  if (status === "pending" && now >= Number(notice.effectiveAt ?? 0)) return "lapsed";
  return ["pending", "accepted", "applied", "withdrawn"].includes(status) ? status : "pending";
}

function viewOf(id: string, notice: Rec, now: number): CommissionNoticeView {
  const accepted = rec(notice.accepted);
  return {
    noticeId: id,
    status: statusOf(notice, now),
    outlets: (Array.isArray(notice.outlets) ? notice.outlets : []).map((o) => ({
      restaurantId: str(rec(o).restaurantId), name: str(rec(o).name), fromBps: Number(rec(o).fromBps ?? 0),
      accepted: Boolean(accepted[str(rec(o).restaurantId)]),
    })),
    toBps: Number(notice.toBps ?? 0),
    effectiveAt: Number(notice.effectiveAt ?? 0),
    effectiveDate: str(notice.effectiveDate, 10),
    sentAt: Number(notice.sentAt ?? 0),
    consequence: notice.consequence === "keeps" ? "keeps" : "ends",
    lower: notice.lower === true,
    sections: (Array.isArray(notice.sections) ? notice.sections : []) as AgreementSection[],
    hash: str(notice.hash, 64),
    note: str(notice.note, 500),
  };
}

/** Books the new rate for these outlets from its date, in the same audited way Admin's plan editor does. */
async function bookPlans(
  database: FirestoreLike, noticeId: string, restaurantIds: string[], toBps: number, effectiveAt: number,
  actor: {uid: string; email: string; role: string}, reason: string, now: number, extra?: (transaction: TransactionLike) => void,
): Promise<void> {
  const ref = economicsControlRef(database);
  await database.runTransaction(async (transaction: TransactionLike) => {
    const snapshot = await transaction.get(ref);
    let control: EconomicsControl = normalizeEconomicsControl(snapshot.exists ? snapshot.data() : null);
    const startRevision = control.revision;
    for (const restaurantId of restaurantIds) {
      const before = control.commercialPlans[restaurantId] ?? [];
      const plan = {planId: `notice_${noticeId}`.slice(0, 60), label: "Commission change notice", commissionBps: toBps, effectiveFrom: effectiveAt, effectiveTo: 0};
      const applied = applyEconomicsControlUpdate(control, {section: "commercialPlans", restaurantId,
        value: [...before.filter((p) => p.planId !== plan.planId), plan]});
      control = {...applied.next, revision: control.revision + 1, updatedAt: now, updatedBy: actor.uid};
      transaction.set(database.collection(ECONOMICS_HISTORY_COLLECTION).doc(`rev_${String(control.revision).padStart(8, "0")}`), {
        revision: control.revision, target: applied.target, before: applied.before ?? null, after: applied.after ?? null,
        reason, by: actor.uid, byEmail: actor.email.slice(0, 160), role: actor.role, at: now,
      });
    }
    if (control.revision !== startRevision) transaction.set(ref, control);
    transaction.set(database.collection("audit").doc(`economics_${control.revision}_${now}`), {
      action: "economics.update", target: `commercialPlans:notice_${noticeId}`, actorId: actor.uid, actorRole: actor.role, reason, at: now,
    });
    extra?.(transaction);
  });
  clearEconomicsControlCache();
}

async function ownerUids(database: FirestoreLike, restaurantId: string): Promise<string[]> {
  const snap = await database.collection("restaurantMembers").where("restaurantId", "==", restaurantId).get();
  return snap.docs.filter((doc) => {
    const m = rec(doc.data());
    return m.active !== false && str(m.role) === "restaurant_owner";
  }).map((doc) => doc.id.slice(restaurantId.length + 1)).filter(Boolean);
}

interface Draft {
  outlets: NoticeOutlet[];
  toBps: number;
  effectiveAt: number;
  effectiveDate: string;
  consequence: "ends" | "keeps";
  lower: boolean;
  sections: AgreementSection[];
  hash: string;
  note: string;
}

async function draftNotice(
  database: FirestoreLike,
  input: {restaurantIds: string[]; commissionBps: number; effectiveDate: string; note?: string},
  now: number,
): Promise<Draft> {
  const ids = [...new Set(input.restaurantIds.map((id) => str(id, 120)).filter(Boolean))];
  if (!ids.length || ids.length > MAX_OUTLETS) throw new DomainError("invalid-argument", `Pick 1 to ${MAX_OUTLETS} stores.`);
  const toBps = Math.round(Number(input.commissionBps));
  if (!Number.isFinite(toBps) || toBps < 0 || toBps > 5_000) throw new DomainError("invalid-argument", "Commission must be between 0% and 50%.");
  const effectiveAt = istMidnight(input.effectiveDate);
  if (!Number.isFinite(effectiveAt)) throw new DomainError("invalid-argument", "Pick the date the new rate starts.");
  const party = await loadAgreementParty(database);
  const rows = await Promise.all(ids.map(async (id) => {
    const [snap, commission] = await Promise.all([restaurantRef(database, id).get(), liveCommission(id, database, now)]);
    if (!snap.exists) throw new DomainError("not-found", "Store not found.");
    const r = rec(snap.data());
    const name = str(r.name, 120) || id;
    if (r.pricingModel === "markup") throw new DomainError("failed-precondition", `${name} uses markup pricing, so it pays no commission.`);
    const pointer = rec(r.commissionNotice);
    if (str(pointer.status) === "pending" && Number(pointer.effectiveAt ?? 0) > now) {
      throw new DomainError("already-exists", `${name} already has a commission notice waiting. Withdraw it first.`);
    }
    const signedAt = Number(r.agreementSignedAt ?? 0);
    const termEnd = signedAt > 0 ? addMonths(signedAt, Number(r.commissionTermMonths ?? 12)) : 0;
    return {restaurantId: id, name, fromBps: commission.commissionBps, keeps: effectiveAt < termEnd, termEnd};
  }));
  if (rows.every((r) => r.fromBps === toBps)) throw new DomainError("invalid-argument", `That is already the commission (${toBps / 100}%).`);
  const higher = rows.filter((r) => toBps > r.fromBps).length;
  if (higher && higher !== rows.length) throw new DomainError("invalid-argument", "This rate is higher for some stores and lower for others. Send them separately.");
  const lower = higher === 0;
  if (lower ? effectiveAt < istMidnight(istDate(now)) : effectiveAt - now < COMMISSION_NOTICE_DAYS * DAY) {
    throw new DomainError("invalid-argument", lower ? "The date can't be in the past." :
      `A higher rate needs at least ${COMMISSION_NOTICE_DAYS} days' notice: pick ${istDate(now + (COMMISSION_NOTICE_DAYS + 1) * DAY)} or later.`);
  }
  const keeps = rows.filter((r) => r.keeps).length;
  if (!lower && keeps && keeps !== rows.length) {
    throw new DomainError("invalid-argument", "Some of these stores are still in their fixed period and some aren't. Send them separately.");
  }
  const consequence = !lower && keeps ? "keeps" : "ends";
  const outlets = rows.map(({restaurantId, name, fromBps}) => ({restaurantId, name, fromBps}));
  const note = str(input.note, 500);
  const sections = renderCommissionNotice({
    platformName: party?.name || "Scraveit", sellerName: outlets[0]!.name, outlets, toBps,
    effectiveDate: istDate(effectiveAt), consequence, note, sentDate: istDate(now),
  });
  return {outlets, toBps, effectiveAt, effectiveDate: istDate(effectiveAt), consequence, lower, sections, hash: noticeHash(sections), note};
}

export async function adminCommissionNotice(
  uid: string,
  token: DecodedIdToken,
  input: {action: "preview" | "send" | "status" | "withdraw"; restaurantIds?: string[]; restaurantId?: string;
    commissionBps?: number; effectiveDate?: string; note?: string; noticeId?: string},
  database: FirestoreLike = firestoreDb,
  now = Date.now(),
): Promise<unknown> {
  const role = requirePlatformConfigAdminClaim(token);
  const email = str(token.email, 160);
  if (input.action === "status") {
    const restaurantId = str(input.restaurantId, 120);
    if (!restaurantId) throw new DomainError("invalid-argument", "Pick a store.");
    const snap = await database.collection(COMMISSION_NOTICES).where("restaurantIds", "array-contains", restaurantId).get();
    const notices = snap.docs.map((doc) => viewOf(doc.id, rec(doc.data()), now)).sort((a, b) => b.sentAt - a.sentAt).slice(0, 10);
    // The same owner's other outlets, so one notice can go to all of them.
    const ids = new Set<string>([restaurantId]);
    for (const ownerUid of await ownerUids(database, restaurantId)) {
      const linked = await database.collection("userRestaurants").doc(ownerUid).get();
      for (const [id, on] of Object.entries(rec(linked.exists ? linked.data() : null))) if (on === true) ids.add(id);
    }
    const outlets = (await Promise.all([...ids].slice(0, MAX_OUTLETS).map(async (id) => {
      const [member, snapR] = await Promise.all([
        database.collection("restaurantMembers").where("restaurantId", "==", id).get(),
        restaurantRef(database, id).get(),
      ]);
      const r = rec(snapR.exists ? snapR.data() : null);
      const owned = id === restaurantId || member.docs.some((doc) => rec(doc.data()).role === "restaurant_owner" && rec(doc.data()).active !== false);
      return snapR.exists && owned && r.archived !== true ? {restaurantId: id, name: str(r.name, 120) || id, pricingModel: str(r.pricingModel, 20) || "commission"} : null;
    }))).filter(Boolean);
    return {notices, outlets};
  }
  if (input.action === "withdraw") {
    const noticeId = str(input.noticeId, 80);
    const ref = database.collection(COMMISSION_NOTICES).doc(noticeId);
    const snap = await ref.get();
    if (!snap.exists) throw new DomainError("not-found", "Notice not found.");
    const notice = rec(snap.data());
    if (statusOf(notice, now) !== "pending") throw new DomainError("failed-precondition", "Only a notice that is still waiting can be withdrawn.");
    if (Object.keys(rec(notice.accepted)).length) throw new DomainError("failed-precondition", "Some outlets already accepted it, so it can't be withdrawn.");
    const batch = database.batch();
    batch.set(ref, {status: "withdrawn", withdrawnAt: now, withdrawnBy: uid}, {merge: true});
    for (const id of (notice.restaurantIds as string[] | undefined) ?? []) {
      batch.set(restaurantRef(database, id), {commissionNotice: {id: noticeId, status: "withdrawn", effectiveAt: Number(notice.effectiveAt ?? 0)}}, {merge: true});
    }
    batch.set(database.collection("audit").doc(`commission_notice_withdraw_${noticeId}_${now}`), {
      action: "commission_notice.withdraw", target: noticeId, actorId: uid, actorRole: role, at: now,
    });
    await batch.commit();
    return {withdrawn: true};
  }
  const draft = await draftNotice(database, {restaurantIds: input.restaurantIds ?? [], commissionBps: Number(input.commissionBps),
    effectiveDate: str(input.effectiveDate, 10), note: input.note}, now);
  const summary = {outlets: draft.outlets, toBps: draft.toBps, effectiveDate: draft.effectiveDate, consequence: draft.consequence,
    lower: draft.lower, sections: draft.sections};
  if (input.action === "preview") return summary;
  const ref = database.collection(COMMISSION_NOTICES).doc();
  const noticeId = ref.id;
  const restaurantIds = draft.outlets.map((o) => o.restaurantId);
  const record: Rec = {
    restaurantIds, outlets: draft.outlets, toBps: draft.toBps, effectiveAt: draft.effectiveAt, effectiveDate: draft.effectiveDate,
    consequence: draft.consequence, lower: draft.lower, sections: draft.sections, hash: draft.hash, note: draft.note,
    status: draft.lower ? "applied" : "pending", accepted: {}, sentAt: now, sentBy: uid, sentByEmail: email,
  };
  const pointer = {id: noticeId, status: record.status, effectiveAt: draft.effectiveAt};
  const writeNotice = (transaction: TransactionLike) => {
    transaction.set(ref, record);
    for (const id of restaurantIds) transaction.set(restaurantRef(database, id), {commissionNotice: pointer}, {merge: true});
    transaction.set(database.collection("audit").doc(`commission_notice_${noticeId}`), {
      action: "commission_notice.send", target: noticeId, restaurantIds, toBps: draft.toBps, effectiveAt: draft.effectiveAt,
      actorId: uid, actorRole: role, at: now,
    });
  };
  if (draft.lower) {
    // A lower rate is booked straight away; the owner is only told.
    await bookPlans(database, noticeId, restaurantIds, draft.toBps, draft.effectiveAt, {uid, email, role},
      `Lower commission notice ${noticeId}`, now, writeNotice);
  } else {
    await database.runTransaction(async (transaction: TransactionLike) => writeNotice(transaction));
  }
  const pct = `${Number((draft.toBps / 100).toFixed(2))}%`;
  const owners = [...new Set((await Promise.all(restaurantIds.map((id) => ownerUids(database, id).catch(() => [])))).flat())];
  await Promise.all(owners.map((ownerUid) => notifyStoreApplicant({uid: ownerUid, key: `commission-notice-${noticeId}-${ownerUid}`,
    title: draft.lower ? "Your commission is going down" : "Commission change: please read and accept",
    body: draft.lower ? `New rate ${pct} from ${draft.effectiveDate}.` : `New rate ${pct} from ${draft.effectiveDate}. Open the app to read and accept it.`,
  }).catch((error) => logger.warn("COMMISSION_NOTICE_PUSH_FAILED", {noticeId, error: String(error).slice(0, 200)}))));
  logger.info("COMMISSION_NOTICE_SENT", {noticeId, outlets: restaurantIds.length, toBps: draft.toBps, lower: draft.lower});
  return {...summary, noticeId, status: record.status};
}

async function requireOwner(database: FirestoreLike, restaurantId: string, uid: string): Promise<void> {
  const snap = await restaurantMemberRef(database, restaurantId, uid).get();
  const m = rec(snap.exists ? snap.data() : null);
  if (m.active === false || str(m.role) !== "restaurant_owner") throw new DomainError("permission-denied", "Only the owner can see and accept a commission change.");
}

export async function restaurantCommissionNotice(
  uid: string,
  token: DecodedIdToken,
  input: {action: "get" | "accept"; restaurantId: string; noticeId?: string; hash?: string; consent?: boolean},
  meta: {ip: string; userAgent: string},
  database: FirestoreLike = firestoreDb,
  bucket = () => storage.bucket(),
  now = Date.now(),
): Promise<{notice: CommissionNoticeView | null; accepted?: number}> {
  const restaurantId = str(input.restaurantId, 120);
  await requireOwner(database, restaurantId, uid);
  let noticeId = str(input.noticeId, 80);
  if (!noticeId) {
    const r = await restaurantRef(database, restaurantId).get();
    noticeId = str(rec(rec(r.exists ? r.data() : null).commissionNotice).id, 80);
  }
  if (!noticeId) return {notice: null};
  const ref = database.collection(COMMISSION_NOTICES).doc(noticeId);
  const snap = await ref.get();
  if (!snap.exists) return {notice: null};
  const notice = rec(snap.data());
  const ids = (notice.restaurantIds as string[] | undefined) ?? [];
  if (!ids.includes(restaurantId)) throw new DomainError("permission-denied", "This notice is for another store.");
  if (input.action === "get") return {notice: viewOf(noticeId, notice, now)};

  if (!input.consent) throw new DomainError("invalid-argument", "Tick the box to confirm you accept the new rate.");
  const status = statusOf(notice, now);
  if (status === "lapsed") throw new DomainError("failed-precondition", "The date in this notice has passed. Please contact Scraveit.");
  if (status !== "pending") throw new DomainError("failed-precondition", status === "accepted" ? "Already accepted." : "This notice is no longer open.");
  if (str(input.hash, 64) !== str(notice.hash, 64)) throw new DomainError("aborted", "The notice changed while you were reading it. Please read it again.");
  // One tap accepts for every outlet in the notice that this owner runs.
  const mine: string[] = [];
  for (const id of ids) {
    const m = rec((await restaurantMemberRef(database, id, uid).get()).data());
    if (m.active !== false && str(m.role) === "restaurant_owner" && !rec(notice.accepted)[id]) mine.push(id);
  }
  if (!mine.length) throw new DomainError("failed-precondition", "Already accepted.");
  const email = str(token.email, 160);
  const view = viewOf(noticeId, notice, now);
  const certificate: Array<[string, string]> = [
    ["Accepted by", `${email || uid} (signed in with ${token.firebase?.sign_in_provider ?? "email"})`],
    ["Accepted at", `${new Date(now + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 19)} IST`],
    ["Outlets", view.outlets.filter((o) => mine.includes(o.restaurantId)).map((o) => o.name).join(", ")],
    ["Declaration", "Ticked: they own these outlets, or are authorised in writing to accept for them"],
    ["IP address", meta.ip || "unknown"],
    ["Device", meta.userAgent.slice(0, 120) || "unknown"],
    ["Document fingerprint (SHA-256)", view.hash],
  ];
  const pdf = await buildAgreementPdf("Scraveit commission change notice", view.sections, certificate);
  const pdfPath = `private/restaurant-agreements/live-${restaurantId}/commission-notice-${noticeId}-${now}.pdf`;
  await bucket().file(pdfPath).save(Buffer.from(pdf), {contentType: "application/pdf", resumable: false});
  const acceptance = {at: now, uid, email, ip: meta.ip.slice(0, 64), userAgent: meta.userAgent.slice(0, 200), hash: view.hash, pdfPath};
  const accepted = {...rec(notice.accepted)};
  for (const id of mine) accepted[id] = acceptance;
  const all = ids.every((id) => accepted[id]);
  await bookPlans(database, noticeId, mine, view.toBps, view.effectiveAt, {uid, email, role: "restaurant_owner"},
    `Commission notice ${noticeId} accepted by the owner`, now, (transaction) => {
      transaction.set(ref, {accepted, ...(all ? {status: "accepted", acceptedAt: now} : {})}, {merge: true});
      for (const id of mine) {
        transaction.set(restaurantRef(database, id), {commissionNotice: {id: noticeId, status: "accepted", effectiveAt: view.effectiveAt}}, {merge: true});
      }
      transaction.set(database.collection("audit").doc(`commission_notice_accept_${noticeId}_${now}`), {
        action: "commission_notice.accept", target: noticeId, restaurantIds: mine, toBps: view.toBps, actorId: uid, at: now,
      });
    });
  logger.info("COMMISSION_NOTICE_ACCEPTED", {noticeId, outlets: mine.length});
  const after = rec((await ref.get()).data());
  return {notice: viewOf(noticeId, after, now), accepted: mine.length};
}
