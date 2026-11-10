#!/usr/bin/env node
// Cancels one stuck test order that is past pickup (the order rules only allow
// cancelling before pickup). Builds the same fields as a server cancel, so the
// order trigger cleans up the rider job, dispatch and tracking.
//
//   GOOGLE_CLOUD_PROJECT=savrivo-app node scripts/cancel-stuck-test-order.cjs <orderId>            dry run
//   GOOGLE_CLOUD_PROJECT=savrivo-app node scripts/cancel-stuck-test-order.cjs <orderId> --apply    write it
const {firestoreDb} = require("../lib/admin");
const {deriveLifecycle, deriveLifecycleFromCanonicalState, buildLifecycleMutation} = require("../lib/domain/lifecycle");
const {stripPrivateOrderFields} = require("../lib/domain/orderSecurity");
const {reconcileRestaurantOrderProjection} = require("../lib/services/orderProjection");
const {reconcileRestaurantWorkload} = require("../lib/services/workload");

const [orderId, flag] = process.argv.slice(2);
const ACTIVE = new Set(["Handed to rider", "Out for delivery", "Near you", "Arrived"]);

(async () => {
  if (!orderId || (flag && flag !== "--apply")) throw new Error("Usage: cancel-stuck-test-order.cjs <orderId> [--apply]");
  const ref = firestoreDb.collection("orders").doc(orderId);
  const now = Date.now();
  const id = `e_${now}_admin-stuck-test`;
  const reason = "Stuck test order closed by Scraveit admin.";
  const order = await firestoreDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Order not found.");
    const source = snap.data();
    if (!ACTIVE.has(source.status)) throw new Error(`Order is ${source.status}; nothing to do.`);
    const candidate = {
      ...source,
      status: "Cancelled",
      updatedAt: now,
      statusHistory: {...(source.statusHistory || {}), [id]: {status: "Cancelled", at: now, actorId: "admin-stuck-test", actorRole: "system", reason}},
      cancelReason: reason,
      statusBeforeTerminal: source.status,
      cancelledByRole: "system",
      cancellationKind: "system_cancelled",
    };
    const lifecycle = buildLifecycleMutation(deriveLifecycle(source), deriveLifecycleFromCanonicalState(candidate), now);
    const next = stripPrivateOrderFields({...candidate, ...lifecycle.patch});
    console.log(`${orderId}: ${source.status} -> Cancelled (${source.paymentMethod}, ₹${source.total})`);
    if (flag === "--apply") tx.set(ref, next);
    return next;
  });
  if (flag !== "--apply") { console.log("Dry run. Add --apply to write it."); return; }
  await reconcileRestaurantOrderProjection(order);
  await reconcileRestaurantWorkload(order);
  await firestoreDb.collection("audit").doc(id).set({id, action: "order.transition", target: orderId,
    detail: `${order.statusBeforeTerminal} -> Cancelled · stuck test order`, actorId: "admin-script", actorRole: "system", at: now});
  console.log("Done.");
})().then(() => process.exit(0), (e) => { console.error(String(e && e.message || e)); process.exit(1); });
