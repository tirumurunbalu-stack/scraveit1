import {logger} from "firebase-functions";
import {db, firestoreDb} from "../admin";
import {ROOT} from "../config";

/**
 * Squad orders: friends put their picks into squads/{code}/picks/{uid}, and the
 * host checks out the combined cart as one normal order. This links that order
 * back to the squad so every member can follow it - order details and live
 * tracking - on their own phone. Members only ever read; the order still
 * belongs to the host, and the delivery route stays one shared route per order.
 */
export const MAX_SQUAD_MEMBERS = 12;

export async function attachSquadToOrder(hostUid: string, code: string, orderId: string, restaurantId: string): Promise<string[]> {
  const squadRef = firestoreDb.collection("squads").doc(code);
  const members = await firestoreDb.runTransaction(async (transaction) => {
    const squad = await transaction.get(squadRef);
    const data = squad.exists ? squad.data() as Record<string, unknown> : null;
    if (!data || data.hostUid !== hostUid || data.restaurantId !== restaurantId) return null;
    if (data.status !== "open" && data.status !== "locked" && !(data.status === "ordered" && data.orderId === orderId)) return null;
    const picks = await transaction.get(squadRef.collection("picks").limit(MAX_SQUAD_MEMBERS));
    const list = picks.docs.map((doc) => {
      const pick = doc.data() as Record<string, unknown>;
      return {uid: doc.id, name: String(pick.name || "Friend").slice(0, 60), subtotal: Math.max(0, Math.round(Number(pick.subtotal) || 0))};
    });
    if (!list.some((member) => member.uid === hostUid)) list.unshift({uid: hostUid, name: String(data.hostName || "Host").slice(0, 60), subtotal: 0});
    transaction.update(firestoreDb.collection("orders").doc(orderId), {squadCode: code, squadMemberUids: list.map((member) => member.uid), squadMembers: list});
    transaction.update(squadRef, {status: "ordered", orderId});
    return list;
  });
  if (!members) {
    logger.warn("SQUAD_ATTACH_SKIPPED", {hostUid, code, orderId});
    return [];
  }
  // Live tracking lives in RTDB, whose rules cannot read Firestore: list who may watch it.
  const viewers: Record<string, true> = {};
  members.forEach((member) => { viewers[member.uid] = true; });
  await db.ref(`${ROOT}/trackingViewers/${orderId}`).set(viewers);
  return members.map((member) => member.uid);
}
