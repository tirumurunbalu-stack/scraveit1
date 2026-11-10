#!/usr/bin/env node
// Creates the Food Box Restaurants brands (Magunta Layout, Nellore) as closed
// listings with their full menus, all owned by one existing sign-in. Agreed terms:
// menu prices as printed, GST added on top for the customer, 12% commission.
// Same shapes as the Admin app and sign-up approval: listing, owner membership,
// userRestaurants lookup and menus/{id}/items in menu order. Bank, PAN and FSSAI
// are not written; add them in Admin. A brand whose listing already exists is skipped.
//
//   node scripts/import-food-box.mjs                                              dry run, all brands
//   node scripts/import-food-box.mjs --only="Spicy Box" --at=14.4334,79.9787 --apply
//
// Options: --only=<brand> (brands can sit at different kitchens, so each gets its own pin),
// --email=<owner sign-in> (default the founder's holding account),
// --phone=<counter number> (default the phone on that account's sign-up),
// --commission=<percent> (default 12).

import {readFileSync} from "node:fs";
import {applicationDefault, deleteApp, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getFirestore} from "firebase-admin/firestore";

const PROJECT = "savrivo-app";
const MENUS = new URL("../../onboarding/food-box/menus.json", import.meta.url);
const OWNER_PERMISSIONS = {analytics: true, availability: true, dispatch: true, handover: true, menu: true, orders: true,
  profile: true, tracking: true, offers: true, bank: true};
const KITCHEN = {address: "23-4-87-1, Shop 1, Magunta Layout", area: "Magunta Layout", city: "Nellore", pincode: "524003"};
const DIETS = ["veg", "nonveg", "egg"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`Unknown argument: ${a}`); process.exit(1); }
  return [m[1], m[2] ?? true];
}));
const unknown = Object.keys(args).filter((k) => !["email", "phone", "commission", "at", "only", "apply"].includes(k));
if (unknown.length) { console.error(`Unknown option: --${unknown.join(", --")}`); process.exit(1); }
const apply = args.apply === true;
const email = String(args.email || "tirumurunbalu@gmail.com").trim().toLowerCase();
const [lat, lng] = String(args.at || "").split(",").map(Number);
const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat - 14.44) < 0.3 && Math.abs(lng - 79.98) < 0.3;
if (args.at && !hasPin) { console.error("--at must be lat,lng near Nellore, e.g. --at=14.4421,79.9864"); process.exit(1); }
if (apply && !hasPin) { console.error("Add the kitchen's map pin first: --at=<lat>,<lng>"); process.exit(1); }
const commissionPct = args.commission === undefined ? 12 : Number(args.commission);
if (!(commissionPct >= 0 && commissionPct <= 50)) { console.error("--commission is a percent from 0 to 50"); process.exit(1); }

const slug = (text) => String(text || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "restaurant";
const masked = (phone) => phone ? phone.replace(/\d(?=\d{4})/g, "•") : "(none)";

// Every item is checked before anything is written.
const allMenus = JSON.parse(readFileSync(MENUS, "utf8"));
const only = args.only === undefined ? null : String(args.only).trim().toLowerCase();
const menus = Object.fromEntries(Object.entries(allMenus).filter(([brand]) => !only || brand.toLowerCase() === only));
if (!Object.keys(menus).length) { console.error(`No brand called "${args.only}". Brands: ${Object.keys(allMenus).join(", ")}`); process.exit(1); }
if (apply && !only) { console.error("Write one brand at a time with its own pin: --only=<brand>"); process.exit(1); }
const problems = [];
for (const [brand, data] of Object.entries(menus)) {
  const seen = new Set();
  data.items.forEach((item, i) => {
    const where = `${brand} #${i + 1} ${item.name || ""}`;
    if (!String(item.name || "").trim() || !String(item.category || "").trim()) problems.push(`${where}: missing name or category`);
    if (!Number.isInteger(item.price) || item.price <= 0) problems.push(`${where}: bad price ${item.price}`);
    if (!DIETS.includes(item.diet)) problems.push(`${where}: diet must be veg, nonveg or egg`);
    if (data.pureVeg && item.diet !== "veg") problems.push(`${where}: not veg in a pure veg store`);
    const key = `${item.category}|${item.name}`.toLowerCase();
    if (seen.has(key)) problems.push(`${where}: listed twice in ${item.category}`);
    seen.add(key);
  });
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }

const app = initializeApp({credential: applicationDefault(), projectId: PROJECT});
try {
  const db = getFirestore(app);
  const user = await getAuth(app).getUserByEmail(email);
  const signUp = (await db.doc(`restaurantApplications/${user.uid}`).get()).data() ?? {};
  const phone = String(args.phone || signUp.phone || "").trim();
  if (phone.replace(/\D/g, "").length < 10) { console.error("No 10-digit phone found. Pass --phone=<counter number>."); process.exit(1); }
  console.log(`Owner sign-in: ${user.email} (${user.uid.slice(0, 6)}…)  Phone on listings: ${masked(phone)}`);
  console.log(`Kitchen: ${KITCHEN.address}, ${KITCHEN.city} ${KITCHEN.pincode}  Pin: ${hasPin ? `${lat},${lng}` : "not given (needed for --apply)"}`);
  console.log(`Commission: ${commissionPct}%  Prices: as printed, GST added on top\n`);

  let created = 0, skipped = 0, itemCount = 0;
  for (const [brand, data] of Object.entries(menus)) {
    const id = `${slug(brand)}-${user.uid.slice(0, 6).toLowerCase()}`;
    const categories = [...new Set(data.items.map((x) => x.category))];
    const exists = (await db.doc(`restaurants/${id}`).get()).exists;
    const summary = categories.map((c) => `${c} ${data.items.filter((x) => x.category === c).length}`).join(", ");
    console.log(`${exists ? "SKIP (already exists)" : "NEW"}  ${brand}  →  ${id}`);
    console.log(`  ${data.items.length} items in ${categories.length} categories: ${summary}`);
    if (exists) { skipped++; continue; }
    if (!apply) { created++; itemCount += data.items.length; continue; }

    const now = Date.now();
    const listing = {
      id, name: brand, phone, storeType: "restaurant", outletType: "Cloud kitchen",
      ...KITCHEN, lat, lng,
      cuisines: data.cuisines.slice(0, 8), category: data.cuisines[0] || "Restaurant",
      description: `${data.cuisines.join(" · ")} by Food Box Restaurants`,
      pureVeg: data.pureVeg === true,
      opensAt: "11:00", opensUntil: "23:00", openDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      commissionBps: Math.round(commissionPct * 100), pricingModel: "commission", pricesIncludeGst: false,
      open: false, archived: false, rating: 0, ratingCount: 0, etaMin: 25, etaMax: 35, deliveryFee: 0, platformFee: 12,
      createdAt: now, updatedAt: now, updatedBy: "food-box-import",
    };
    const batch = db.batch();
    batch.set(db.doc(`restaurants/${id}`), listing);
    batch.set(db.doc(`restaurantMembers/${id}_${user.uid}`), {
      active: true, email: user.email, name: `${brand} Owner`, permissions: OWNER_PERMISSIONS, restaurantId: id,
      restaurantName: brand, role: "restaurant_owner", createdAt: now, createdBy: "food-box-import",
    });
    batch.set(db.doc(`userRestaurants/${user.uid}`), {[id]: true}, {merge: true});
    const rankInCategory = {};
    data.items.forEach((item, i) => {
      const itemId = `item_${String(i + 1).padStart(3, "0")}_${slug(item.name).slice(0, 36)}`;
      rankInCategory[item.category] = (rankInCategory[item.category] ?? -1) + 1;
      batch.set(db.doc(`menus/${id}/items/${itemId}`), {
        id: itemId, name: item.name.trim(), category: item.category.trim(), description: String(item.description || "").trim(),
        price: item.price, diet: item.diet, preparationTime: 20,
        categoryRank: categories.indexOf(item.category), itemRank: rankInCategory[item.category],
        available: true, popular: false, archived: false, updatedAt: now, updatedBy: "food-box-import",
      });
    });
    batch.set(db.doc(`audit/food_box_import_${id}_${now}`), {
      action: "restaurant.create", target: id, actorId: "food-box-import", detail: `${brand} · ${data.items.length} items · owner:${user.email}`, at: now,
    });
    await batch.commit();
    created++; itemCount += data.items.length;
  }
  if (apply && created) await db.doc("admin/catalogMeta").set({initialized: true, updatedAt: Date.now()}, {merge: true});
  console.log(`\n${apply ? "Created" : "Would create"} ${created} restaurants with ${itemCount} items; ${skipped} skipped.`);
  if (!apply) console.log("Dry run. Add --at=<lat>,<lng> --apply to write it.");
  else console.log("All are closed. Check each menu on the partner website, then switch them open.");
} finally {
  await deleteApp(app);
}
