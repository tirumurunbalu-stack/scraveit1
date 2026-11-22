#!/usr/bin/env node
// Creates (or switches off) an ordinary Scraveit offer for one store, through the same
// code the Admin website's Offers page uses (checks, money simulation, audit record).
// Customers get it automatically at checkout; the Deals page shows each dish struck
// through with the price after the offer.
//
//   node scripts/store-offer.mjs --store=spicy-box-hffg4m --percent=6 --code=SPICYBOX            (dry run: simulation only)
//   node scripts/store-offer.mjs --store=spicy-box-hffg4m --percent=6 --code=SPICYBOX --apply
//   node scripts/store-offer.mjs --off=<promotionId> --apply                                      (switch an offer off)
// Paid by Scraveit (fundingSource "platform") unless --funding=restaurant|shared.
import {createRequire} from "node:module";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? true : v];
}));
const apply = args.apply === true;

initializeApp({credential: applicationDefault(), projectId: "savrivo-app"});
const db = getFirestore();
const {upsertPromotionSchema} = require("../lib/schemas.js");
const admin = require("../lib/services/economicsAdmin.js");
// The script acts as a platform owner; the audit record names it.
const token = {uid: "ops-script", savrivoRole: "owner"};

try {
  if (args.off) {
    const ref = db.collection("promotions").doc(String(args.off));
    const current = (await ref.get()).data();
    if (!current) throw new Error("No such offer");
    console.log(`Offer ${args.off}: ${current.code} ${current.percent}% active=${current.active}`);
    if (apply) {
      await ref.update({active: false, updatedAt: Date.now(), updatedBy: "ops-script"});
      console.log("Switched off.");
    } else console.log("Dry run: add --apply to switch it off.");
  } else {
    const store = String(args.store || "");
    const restaurant = (await db.doc(`restaurants/${store}`).get()).data();
    if (!restaurant) throw new Error(`No store ${store}`);
    const input = upsertPromotionSchema.parse({
      code: String(args.code || "").toUpperCase(),
      title: `${restaurant.name} offer`,
      kind: "percent",
      percent: Number(args.percent),
      fundingSource: String(args.funding || "platform"),
      restaurantIds: [store],
      active: true,
      approvalStatus: "approved",
      simulation: {averageOrderValuePaise: 30_000, commissionBps: Number(restaurant.commissionBps ?? 1_200)},
    });
    const sim = await admin.simulateOfferForAdmin(token, {...input.simulation, cityKey: "", offer: input}, db);
    console.log(`${restaurant.name}: ${input.percent}% off, paid by ${input.fundingSource}, code ${input.code}, commission ${restaurant.commissionBps} bps`);
    console.log(`Simulation: ${sim.verdict} — ${sim.message}`);
    if (apply) {
      const {promotion} = await admin.upsertPromotionForAdmin("ops-script", token, input, db);
      console.log(`Saved offer ${promotion.id}: active=${promotion.active} approval=${promotion.approvalStatus}`);
    } else console.log("Dry run: nothing written. Add --apply to save.");
  }
} finally {
  await deleteApp((await import("firebase-admin/app")).getApp());
}
