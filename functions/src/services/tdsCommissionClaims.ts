import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {z} from "zod";
import {firestoreDb} from "../admin";
import {createLedgerJournal} from "../domain/ledger";
import {DomainError} from "../errors";
import type {FirestoreLike} from "../firestoreTypes";
import {appendLedgerJournalInTransaction} from "./ledger";
import {authorizeRestaurantFinanceRead} from "./restaurantSettlements";

/**
 * TDS a restaurant deducted on SCRAVEIT's commission.
 *
 * Companies, firms and audited businesses must deduct income-tax TDS on
 * commission they pay (section 194H of the 1961 Act; section 393 of the
 * Income-tax Act, 2025), usually 2% of the commission before GST. SCRAVEIT
 * keeps its whole commission out of the payout, so the restaurant pays that
 * TDS to the government from its own money. It then sends SCRAVEIT the
 * details here; once SCRAVEIT finance sees the credit under its PAN in its
 * annual tax statement (Form 168, earlier 26AS), the amount is added back to
 * the restaurant's next payout. SCRAVEIT is no worse off: it claims that TDS
 * against its own income tax.
 */

export const TDS_COMMISSION_CLAIMS_COLLECTION = "tdsCommissionClaims";
/** TDS on commission above this share of the commission is refused as a typo. */
const MAX_RATE_BPS = 1_000;

const restaurantIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const submitTdsCommissionClaimSchema = z.object({
  restaurantId: restaurantIdSchema,
  financialYear: z.string().regex(/^\d{2}-\d{2}$/),
  quarter: z.number().int().min(1).max(4),
  /** Commission (before GST) the TDS was deducted on. */
  commissionPaise: z.number().int().positive().max(100_000_000_00),
  tdsPaise: z.number().int().positive(),
  deductorTan: z.string().trim().toUpperCase().regex(/^[A-Z]{4}[0-9]{5}[A-Z]$/, "Enter your 10-character TAN."),
  /** Form 131 (earlier Form 16A) certificate number. */
  certificateNo: z.string().trim().min(4).max(20).regex(/^[A-Za-z0-9/-]+$/),
  challanBsrCode: z.string().trim().regex(/^\d{7}$/, "BSR code has 7 digits."),
  challanSerialNo: z.string().trim().regex(/^\d{1,5}$/, "Challan serial number has up to 5 digits."),
  challanDate: dayKey,
}).strict().refine((value) => value.tdsPaise * 10_000 <= value.commissionPaise * MAX_RATE_BPS,
  "TDS can't be more than 10% of the commission. Check the amounts.");

export const reviewTdsCommissionClaimSchema = z.object({
  claimId: z.string().regex(/^tdc_[a-f0-9]{24}$/),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(300).default(""),
}).strict().refine((value) => value.decision === "approve" || value.note.length >= 5, "Say why the claim is rejected.");

export const tdsCommissionClaimsSchema = z.object({restaurantId: restaurantIdSchema}).strict();
export const tdsCommissionClaimsForReviewSchema = z.object({status: z.enum(["submitted", "approved", "rejected"]).default("submitted")}).strict();

export type SubmitTdsCommissionClaimInput = z.infer<typeof submitTdsCommissionClaimSchema>;
export type ReviewTdsCommissionClaimInput = z.infer<typeof reviewTdsCommissionClaimSchema>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const privileged = (token: DecodedIdToken) => token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";

function view(id: string, data: Record<string, unknown>) {
  return {
    claimId: id,
    restaurantId: String(data.restaurantId ?? ""),
    restaurantName: String(data.restaurantName ?? ""),
    financialYear: String(data.financialYear ?? ""),
    quarter: Number(data.quarter) || 0,
    commissionPaise: Number(data.commissionPaise) || 0,
    tdsPaise: Number(data.tdsPaise) || 0,
    deductorTan: String(data.deductorTan ?? ""),
    certificateNo: String(data.certificateNo ?? ""),
    challanBsrCode: String(data.challanBsrCode ?? ""),
    challanSerialNo: String(data.challanSerialNo ?? ""),
    challanDate: String(data.challanDate ?? ""),
    status: String(data.status ?? "submitted") as "submitted" | "approved" | "rejected",
    note: String(data.note ?? ""),
    submittedAt: Number(data.submittedAt) || 0,
    submittedByEmail: String(data.submittedByEmail ?? ""),
    reviewedAt: Number(data.reviewedAt) || null,
  };
}

/** Owners and managers send one claim per TDS certificate. Sending the same certificate again changes nothing. */
export async function submitTdsCommissionClaim(uid: string, token: DecodedIdToken, input: SubmitTdsCommissionClaimInput,
  database: FirestoreLike = firestoreDb, now = Date.now()) {
  await authorizeRestaurantFinanceRead(uid, token, input.restaurantId, database as never);
  const claimId = `tdc_${createHash("sha256").update(`${input.restaurantId}:${input.financialYear}:${input.certificateNo.toUpperCase()}`).digest("hex").slice(0, 24)}`;
  const ref = database.collection(TDS_COMMISSION_CLAIMS_COLLECTION).doc(claimId);
  return database.runTransaction(async (transaction) => {
    const [existing, restaurant] = await Promise.all([
      transaction.get(ref), transaction.get(database.collection("restaurants").doc(input.restaurantId))]);
    if (existing.exists) return view(claimId, record(existing.data()));
    const claim = {...input, certificateNo: input.certificateNo.toUpperCase(), restaurantName: String(record(restaurant.data()).name ?? ""),
      status: "submitted", submittedAt: now, submittedBy: uid, submittedByEmail: String(token.email ?? "")};
    transaction.set(ref, claim);
    return view(claimId, claim);
  });
}

export async function getTdsCommissionClaims(uid: string, token: DecodedIdToken, input: {restaurantId: string},
  database: FirestoreLike = firestoreDb) {
  await authorizeRestaurantFinanceRead(uid, token, input.restaurantId, database as never);
  const snapshot = await database.collection(TDS_COMMISSION_CLAIMS_COLLECTION).where("restaurantId", "==", input.restaurantId)
    .orderBy("submittedAt", "desc").limit(100).get();
  return {claims: snapshot.docs.map((doc) => view(doc.id, record(doc.data())))};
}

/** SCRAVEIT finance: the claims waiting for a check (or past ones). */
export async function listTdsCommissionClaimsForReview(_uid: string, token: DecodedIdToken, input: {status: string},
  database: FirestoreLike = firestoreDb) {
  if (!privileged(token)) throw new DomainError("permission-denied", "Only Scraveit finance can review TDS claims.");
  const snapshot = await database.collection(TDS_COMMISSION_CLAIMS_COLLECTION).where("status", "==", input.status)
    .orderBy("submittedAt", "desc").limit(200).get();
  return {claims: snapshot.docs.map((doc) => view(doc.id, record(doc.data())))};
}

/** Approving adds the TDS back to the restaurant's payout, once; rejecting records why. */
export async function reviewTdsCommissionClaim(uid: string, token: DecodedIdToken, input: ReviewTdsCommissionClaimInput,
  database: FirestoreLike = firestoreDb, now = Date.now()) {
  if (!privileged(token)) throw new DomainError("permission-denied", "Only Scraveit finance can review TDS claims.");
  const ref = database.collection(TDS_COMMISSION_CLAIMS_COLLECTION).doc(input.claimId);
  return database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new DomainError("not-found", "Claim not found.");
    const claim = record(snapshot.data());
    if (claim.status !== "submitted") throw new DomainError("failed-precondition", `This claim is already ${String(claim.status)}.`);
    const update: Record<string, unknown> = {status: input.decision === "approve" ? "approved" : "rejected", note: input.note,
      reviewedAt: now, reviewedBy: uid, reviewedByEmail: String(token.email ?? "")};
    if (input.decision === "approve") {
      const restaurantId = String(claim.restaurantId);
      update.journalId = appendLedgerJournalInTransaction(transaction, database, createLedgerJournal({
        eventType: "adjustment",
        eventId: `tds-commission-refund:${input.claimId}`,
        occurredAt: now,
        actorId: uid,
        metadata: {restaurantId, adjustmentKind: "tds_on_commission_refund", claimId: input.claimId,
          financialYear: String(claim.financialYear), quarter: Number(claim.quarter),
          reason: `TDS on commission, FY ${String(claim.financialYear)} Q${Number(claim.quarter)}, certificate ${String(claim.certificateNo)}`},
        postings: [
          {accountId: "asset:income-tax-tds-receivable", side: "debit", amountPaise: Number(claim.tdsPaise),
            memo: "TDS deducted by restaurant on commission, credit in Form 168"},
          {accountId: `liability:restaurant-payable:${restaurantId}`, side: "credit", amountPaise: Number(claim.tdsPaise),
            memo: "TDS on commission refunded to restaurant"},
        ],
      }));
    }
    transaction.update(ref, update);
    return view(input.claimId, {...claim, ...update});
  });
}
