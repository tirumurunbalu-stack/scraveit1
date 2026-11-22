import {firestoreDb} from "../admin";
import type {FirestoreLike} from "../firestoreTypes";

/**
 * Cash on delivery off for one customer (founder 22 Nov 2026): their cash order was
 * cancelled on the customer's side after the restaurant accepted it (by the customer with
 * the 100% fee, or after pickup), so the cash was never collected. Server-only; the admin
 * can delete the document to undo it.
 */
export const CUSTOMER_COD_BLOCKS_COLLECTION = "customerCodBlocks";

export const CUSTOMER_COD_BLOCKED_MESSAGE =
  "Cash on delivery is off for your account because a cash order was cancelled after the restaurant accepted it. Please pay online.";

export async function customerCodBlocked(uid: string, database: FirestoreLike = firestoreDb): Promise<boolean> {
  if (!uid) return false;
  const snapshot = await database.collection(CUSTOMER_COD_BLOCKS_COLLECTION).doc(uid).get();
  return snapshot.exists && (snapshot.data() as {blocked?: unknown}).blocked === true;
}

export async function blockCustomerCod(
  input: {uid: string; orderId: string; reason: string; at: number},
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  if (!input.uid) return;
  await database.collection(CUSTOMER_COD_BLOCKS_COLLECTION).doc(input.uid).set({
    blocked: true,
    customerId: input.uid,
    orderId: input.orderId,
    reason: input.reason.slice(0, 120),
    at: input.at,
  }, {merge: true});
}
