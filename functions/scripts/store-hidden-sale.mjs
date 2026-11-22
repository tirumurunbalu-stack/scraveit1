#!/usr/bin/env node
// Sells every dish of one store below its full price, paid by Scraveit:
// customers see the full price struck through and the lower price (no percentage);
// the restaurant is still paid its agreed share of the FULL price.
//
//   node scripts/store-hidden-sale.mjs --store=spicy-box-hffg4m --off=12 --commission=18          (dry run)
//   node scripts/store-hidden-sale.mjs --store=spicy-box-hffg4m --off=12 --commission=18 --apply
//   node scripts/store-hidden-sale.mjs --store=spicy-box-hffg4m --undo --apply                   (full prices back)
//
// Each dish keeps its full price in listPrice; price becomes the lower price.
// The store's commission is set so the restaurant still gets (100 - commission)% of
// the full price: on the lower price that is 1 - (100 - commission) / (100 - off).
// Running it again uses listPrice as the full price, so it never lowers twice.
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {FieldValue, getFirestore} from "firebase-admin/firestore";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? true : v];
}));
const store = String(args.store || "");
const apply = args.apply === true;
const undo = args.undo === true;
const off = Number(args.off);
const commission = Number(args.commission);
if (!store) throw new Error("--store=<restaurant id> is needed");
if (!undo && !(off > 0 && off < 50 && commission > off && commission < 50)) {
  throw new Error("--off and --commission are percents, with off < commission < 50");
}

const app = initializeApp({credential: applicationDefault(), projectId: "savrivo-app"});
const db = getFirestore(app);
try {
  const ref = db.doc(`restaurants/${store}`);
  const restaurant = (await ref.get()).data();
  if (!restaurant) throw new Error(`No store ${store}`);
  if (restaurant.pricingModel === "markup") throw new Error("Markup stores are not supported by this script");
  const control = (await db.doc("economicsControl/current").get()).data() || {};
  const plans = (control.commercialPlans || {})[store] || [];
  if (plans.length) console.log(`WARNING: ${plans.length} dated commercial plan(s) exist for this store; an active one overrides commissionBps.`);

  const items = await db.collection(`menus/${store}/items`).get();
  const rows = [];
  for (const doc of items.docs) {
    const item = doc.data();
    const current = Number(item.price);
    const full = item.listPrice != null ? Number(item.listPrice) : current;
    if (!(full > 0)) continue;
    const next = undo ? full : Math.round(full * (100 - off) / 100);
    rows.push({id: doc.id, name: item.name, full, current, next, archived: item.archived === true});
  }
  const commissionBps = undo ? Math.round(Number(restaurant.hiddenSale?.fullPriceCommissionBps ?? restaurant.commissionBps)) :
    Math.round((1 - (100 - commission) / (100 - off)) * 10_000);

  console.log(`${restaurant.name} (${store}) — ${rows.length} dishes`);
  console.log(`commissionBps ${restaurant.commissionBps} -> ${commissionBps}${undo ? " (back to the full-price rate)" : ""}`);
  for (const r of rows.slice(0, 8)) {
    const paid = r.next * (1 - commissionBps / 10_000);
    console.log(`  ${r.name.padEnd(30)} full ₹${r.full}  now ₹${r.current} -> ₹${r.next}   restaurant gets ₹${paid.toFixed(2)} (${(paid / r.full * 100).toFixed(1)}% of full)`);
  }
  if (rows.length > 8) console.log(`  … and ${rows.length - 8} more`);
  const worst = rows.map((r) => r.next * (1 - commissionBps / 10_000) / r.full * 100);
  if (worst.length) console.log(`restaurant share of full price: ${Math.min(...worst).toFixed(2)}% to ${Math.max(...worst).toFixed(2)}%`);

  if (!apply) {
    console.log("Dry run: nothing written. Add --apply to save.");
  } else {
    for (let i = 0; i < rows.length; i += 400) {
      const batch = db.batch();
      for (const r of rows.slice(i, i + 400)) {
        batch.update(db.doc(`menus/${store}/items/${r.id}`), undo ?
          {price: r.full, listPrice: FieldValue.delete(), updatedAt: Date.now(), updatedBy: "scraveit-hidden-sale"} :
          {price: r.next, listPrice: r.full, updatedAt: Date.now(), updatedBy: "scraveit-hidden-sale"});
      }
      await batch.commit();
    }
    await ref.update(undo ?
      {commissionBps, hiddenSale: FieldValue.delete()} :
      {commissionBps, hiddenSale: {offPercent: off, fullPriceCommissionBps: Math.round(commission * 100), paidBy: "scraveit", setAt: Date.now()}});
    console.log(`Saved: ${rows.length} dishes and the store's commission.`);
  }
} finally {
  await deleteApp(app);
}
