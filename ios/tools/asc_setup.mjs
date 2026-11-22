// Fills the App Store listing for the Restaurant, delivery partner and Price Planner iOS apps:
// text, categories, age rating, free price, India only, review notes, screenshots and build.
// Re-runnable. Usage: node ios/tools/asc_setup.mjs <restaurant|delivery|planner> [build number] [--screenshots]
// App Privacy answers and the demo password are not set here (web form / set_review_login.sh).
import { asc } from "./asc.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const COMPANY = "Scraveit is operated by Scraveit Private Limited, Nellore, Andhra Pradesh.";
const APPS = {
  restaurant: {
    bundleId: "in.scraveit.restaurant",
    shots: "restaurant",
    subtitle: "Orders, menu and payouts",
    promotionalText: "Accept Scraveit orders the moment they ring, keep your kitchen on time and see every rupee you earn.",
    keywords: "restaurant,orders,kitchen,menu,food delivery,merchant,partner,store,payouts,Nellore",
    description: `Scraveit Restaurant is the app for restaurants that sell on Scraveit.

• New orders ring loudly so you never miss one; accept with one tap
• A kitchen timer keeps every order on time, and delivery partners are assigned for you
• Edit your menu, prices and dish photos, and mark dishes out of stock
• Set your opening hours and your store opens and closes by itself
• Create offers and see how they perform
• Add staff with their own sign-in and choose what each person can use
• See your earnings, payouts and bills clearly
• Print bills with AirPrint
• Use the app in English or Telugu

To sell on Scraveit, create your account in the app and register your restaurant. ${COMPANY}`,
    categories: ["BUSINESS", "FOOD_AND_DRINK"],
    contentRights: "USES_THIRD_PARTY_CONTENT",
    age: { messagingAndChat: true, sharedLocation: false, userGeneratedContent: false },
    notes: `Scraveit Restaurant is the order app for restaurants that sell on Scraveit, a food delivery service in Nellore, Andhra Pradesh, India (the app is available in India only).

Sign in with the demo account below (email and password). It owns the demo store "Scraveit Review Restaurant", so you can see orders, the menu, offers, staff, earnings and settings. Sign in with Apple or Google creates a new account that has no store until a restaurant is registered.

To see a new order ring: in our customer app "Scraveit: Food, Grocery, Dairy" (also in review), sign in with its demo account and order from "Scraveit Review Restaurant" with Cash on delivery. The order rings in this app and can be accepted.

Location is used only to pin the store on the map when a restaurant registers. The camera is used for dish, store and document photos. Bills print with AirPrint.
Account deletion: More tab > Delete account.
Chat: the restaurant can chat with the delivery partner about an order.`,
  },
  delivery: {
    bundleId: "in.scraveit.delivery",
    shots: "delivery",
    subtitle: "Deliver orders and earn",
    promotionalText: "Go online when you want, get delivery offers near you, and see what each trip pays before you accept.",
    keywords: "delivery,delivery partner,earn,driver,food delivery,jobs,bike,gig,payouts,Nellore",
    description: `Scraveit Partner is the app for delivery partners who deliver food, grocery and dairy orders for Scraveit.

• Go online when it suits you and get delivery offers near you
• See the pay for each trip before you accept
• Clear steps from pickup to drop, with navigation to the store and the customer
• Chat with the store or customer without sharing your phone number
• Track your earnings, bonuses and payouts
• Invite friends with your referral code

To start, sign up in the app with your documents. A quick face check confirms it is you each time you go online. While you are online the app uses your location, including in the background, to find offers near you and to show customers where their order is. It stops when you go offline.

${COMPANY}`,
    categories: ["BUSINESS", "FOOD_AND_DRINK"],
    contentRights: "USES_THIRD_PARTY_CONTENT",
    age: { messagingAndChat: true, sharedLocation: true, userGeneratedContent: false },
    notes: `Scraveit Partner is the app for delivery partners of Scraveit, a food delivery service in Nellore, Andhra Pradesh, India (the app is available in India only).

Sign in with the demo account below. It is an approved test delivery partner: you can go online, and see shifts, earnings, bonuses, referral, payouts, documents and profile.

Going online: for real delivery partners the app runs a quick face check with the camera each time they go online, comparing it with the photo taken at sign-up. The demo account skips this face check, so you can tap Go online directly. The app then asks for location.

Background location: used only while the partner is Online, to find delivery offers near them and to show customers where their order is. It stops when they go Offline. This is the core of a delivery partner app.

Sign-up for new partners scans the QR code on an Aadhaar card (Indian national ID) and takes document photos; this is only for new partners in India.

Account deletion: Profile > Delete account.
Chat: partners can chat with the store and the customer about an order.`,
  },
  planner: {
    bundleId: "in.scraveit.planner",
    shots: "planner",
    subtitle: "Find the right menu price",
    promotionalText: "Know what you take home from every dish before you set its price.",
    keywords: "menu price,restaurant,commission,GST,price calculator,food cost,pricing,offer,margin,dish",
    description: `Price Planner helps restaurant owners set their menu prices on Scraveit.

• Say what you want to get per dish and it finds the menu price
• Or enter a menu price and see what you get after commission and GST
• Works with prices that include GST or add it on top
• Try an offer and see what it costs you before you run it
• Save your dishes and share your price list

No account and no sign-in. Your dishes stay on your phone. ${COMPANY}`,
    categories: ["BUSINESS", "FOOD_AND_DRINK"],
    contentRights: "DOES_NOT_USE_THIRD_PARTY_CONTENT",
    age: { messagingAndChat: false, sharedLocation: false, userGeneratedContent: false },
    notes: `Price Planner is a pricing tool for restaurants that sell on Scraveit, a food delivery service in Nellore, Andhra Pradesh, India (the app is available in India only). No sign-in is needed.

Try it: enter a commission rate (for example 25%), type what you want to get per dish, and tap Find my price. Switch to "Check my price" to see what a menu price leaves you after commission and GST, add an offer, then save the dish and use Share to send the price list.`,
  },
  admin: {
    bundleId: "in.scraveit.admin",
    shots: "admin",
    subtitle: "Scraveit team control room",
    promotionalText: "For the Scraveit team: orders, stores, delivery partners, support and money in one place.",
    keywords: "scraveit,admin,operations,orders,stores,dispatch,delivery,team,business,Nellore",
    description: `Scraveit Admin is the internal operations app for the Scraveit team, who run Scraveit's food, grocery, dairy and health care delivery service in Nellore.

• See every order and its next step
• Review store applications and delivery partner checks
• See which delivery partners are online
• Answer support chats
• Track sales, earnings and payouts in plain words
• Customer insights: areas, best sellers and busy hours

This app is only for Scraveit team members. Accounts are given by Scraveit; there is no public sign-up. ${COMPANY}`,
    categories: ["BUSINESS", "PRODUCTIVITY"],
    contentRights: "USES_THIRD_PARTY_CONTENT",
    age: { messagingAndChat: true, sharedLocation: true, userGeneratedContent: false },
    notes: `Scraveit Admin is the internal operations app for the Scraveit team (Scraveit Private Limited, Nellore, Andhra Pradesh, India). It is for our own staff only, and we have requested Unlisted App Distribution for it.

Sign in with the demo account below (email and password). This review account has its own "App Review" role: the app opens on SAMPLE data only (made-up stores, orders and people, marked by a yellow banner at the top of every screen). Our servers give this account no real customer, store or delivery partner data, and data export is turned off for it.

Things to try: Home shows today's orders and sales. Orders > Details opens an order and its timeline. Customer insights and Money are on Home. Stores and Partners list sample stores and a sample delivery partner application.

There is no sign-up in the app; team accounts are made by the owner. There are no purchases. Notifications alert the team about new support chats and store applications.`,
  },
};

const key = process.argv[2], buildNumber = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "";
const withShots = process.argv.includes("--screenshots");
const cfg = APPS[key];
if (!cfg) { console.error("Usage: node asc_setup.mjs <restaurant|delivery|planner|admin> [build number] [--screenshots]"); process.exit(1); }
let failed = 0;
const step = async (name, fn) => { try { const r = await fn(); console.log("✓", name, typeof r === "string" ? r : ""); } catch (e) { failed++; console.log("✗", name, e.message.slice(0, 700)); } };

const app = (await asc("GET", `/v1/apps?filter[bundleId]=${cfg.bundleId}&fields[apps]=name,bundleId`)).data[0];
if (!app) { console.error("No App Store Connect app for", cfg.bundleId); process.exit(2); }
const APP = app.id;
const version = (await asc("GET", `/v1/apps/${APP}/appStoreVersions?filter[platform]=IOS`)).data
  .find(v => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"].includes(v.attributes.appStoreState));
if (!version) { console.error("No editable version for", app.attributes.name); process.exit(2); }
const VERSION = version.id;
const vloc = (await asc("GET", `/v1/appStoreVersions/${VERSION}/appStoreVersionLocalizations`)).data.find(l => l.attributes.locale === "en-GB");
const info = (await asc("GET", `/v1/apps/${APP}/appInfos`)).data.find(i => i.attributes.state !== "READY_FOR_DISTRIBUTION" && i.attributes.appStoreState !== "READY_FOR_SALE");
const iloc = (await asc("GET", `/v1/appInfos/${info.id}/appInfoLocalizations`)).data.find(l => l.attributes.locale === "en-GB");
console.log(`${app.attributes.name} (${APP}) version ${version.attributes.versionString} ${version.attributes.appStoreState}`);

await step("version text", () => asc("PATCH", `/v1/appStoreVersionLocalizations/${vloc.id}`, { data: { type: "appStoreVersionLocalizations", id: vloc.id, attributes: {
  description: cfg.description, keywords: cfg.keywords, promotionalText: cfg.promotionalText,
  supportUrl: "https://scraveit.in/", marketingUrl: "https://scraveit.in/" } } }));
await step("subtitle + privacy URL", () => asc("PATCH", `/v1/appInfoLocalizations/${iloc.id}`, { data: { type: "appInfoLocalizations", id: iloc.id, attributes: {
  subtitle: cfg.subtitle, privacyPolicyUrl: "https://scraveit.in/privacy" } } }));
await step("categories", () => asc("PATCH", `/v1/appInfos/${info.id}`, { data: { type: "appInfos", id: info.id, relationships: {
  primaryCategory: { data: { type: "appCategories", id: cfg.categories[0] } }, secondaryCategory: { data: { type: "appCategories", id: cfg.categories[1] } } } } }));
await step("copyright", () => asc("PATCH", `/v1/appStoreVersions/${VERSION}`, { data: { type: "appStoreVersions", id: VERSION, attributes: { copyright: "2026 Scraveit Private Limited" } } }));
await step("content rights", () => asc("PATCH", `/v1/apps/${APP}`, { data: { type: "apps", id: APP, attributes: { contentRightsDeclaration: cfg.contentRights } } }));

await step("age rating", async () => {
  const decl = (await asc("GET", `/v1/appInfos/${info.id}/ageRatingDeclaration`)).data;
  await asc("PATCH", `/v1/ageRatingDeclarations/${decl.id}`, { data: { type: "ageRatingDeclarations", id: decl.id, attributes: {
    advertising: false, alcoholTobaccoOrDrugUseOrReferences: "NONE", contests: "NONE", datingAndRelationships: false,
    gambling: false, gamblingSimulated: "NONE", gunsOrOtherWeapons: "NONE", healthOrWellnessTopics: false, lootBox: false,
    medicalOrTreatmentInformation: "NONE", messagingAndChat: cfg.age.messagingAndChat, parentalControls: false,
    profanityOrCrudeHumor: "NONE", ageAssurance: false, sexualContentGraphicAndNudity: "NONE", sexualContentOrNudity: "NONE",
    sharedLocation: cfg.age.sharedLocation, socialMedia: false, socialMediaAgeRestricted: false, horrorOrFearThemes: "NONE",
    matureOrSuggestiveThemes: "NONE", unrestrictedWebAccess: false, userGeneratedContent: cfg.age.userGeneratedContent,
    violenceCartoonOrFantasy: "NONE", violenceRealisticProlongedGraphicOrSadistic: "NONE", violenceRealistic: "NONE" } } });
});

await step("free price", async () => {
  const existing = await asc("GET", `/v1/appPriceSchedules/${APP}/manualPrices`).catch(() => ({ data: [] }));
  if (existing.data.length) return "(already set)";
  let next = `/v1/apps/${APP}/appPricePoints?filter[territory]=IND&limit=200`, free = null;
  while (next && !free) { const page = await asc("GET", next); free = page.data.find(p => Number(p.attributes.customerPrice) === 0); next = page.links?.next; }
  if (!free) throw new Error("free price point not found");
  await asc("POST", "/v1/appPriceSchedules", { data: { type: "appPriceSchedules", relationships: {
    app: { data: { type: "apps", id: APP } }, baseTerritory: { data: { type: "territories", id: "IND" } },
    manualPrices: { data: [{ type: "appPrices", id: "${free}" }] } } },
    included: [{ type: "appPrices", id: "${free}", attributes: { startDate: null },
      relationships: { appPricePoint: { data: { type: "appPricePoints", id: free.id } } } }] });
});

await step("India only", async () => {
  const has = await asc("GET", `/v1/apps/${APP}/appAvailabilityV2`).then(() => true).catch(e => { if (e.status === 404) return false; throw e; });
  if (has) return "(already set)";
  // Apple wants every territory listed: India on, all others off.
  let next = "/v1/territories?limit=200", all = [];
  while (next) { const page = await asc("GET", next); all = all.concat(page.data.map(t => t.id)); next = page.links?.next; }
  if (!all.includes("IND")) throw new Error("India not in the territory list");
  await asc("POST", "/v2/appAvailabilities", { data: { type: "appAvailabilities", attributes: { availableInNewTerritories: false },
    relationships: { app: { data: { type: "apps", id: APP } }, territoryAvailabilities: { data: all.map(t => ({ type: "territoryAvailabilities", id: `\${${t}}` })) } } },
    included: all.map(t => ({ type: "territoryAvailabilities", id: `\${${t}}`, attributes: { available: t === "IND", releaseDate: null, preOrderEnabled: false },
      relationships: { territory: { data: { type: "territories", id: t } } } })) });
  return `India on, ${all.length - 1} others off`;
});

await step("review contact + notes", async () => {
  // Same contact person as the Customer app's review details.
  const contact = (await asc("GET", "/v1/appStoreVersions/5abf2427-4864-4f81-810c-441b1e6cc4ea/appStoreReviewDetail?fields[appStoreReviewDetails]=contactFirstName,contactLastName,contactPhone,contactEmail")).data.attributes;
  const attributes = { contactFirstName: contact.contactFirstName, contactLastName: contact.contactLastName, contactPhone: contact.contactPhone,
    contactEmail: contact.contactEmail, notes: cfg.notes, demoAccountRequired: key !== "planner" };
  const current = await asc("GET", `/v1/appStoreVersions/${VERSION}/appStoreReviewDetail`).catch(e => { if (e.status === 404) return { data: null }; throw e; });
  if (current.data) await asc("PATCH", `/v1/appStoreReviewDetails/${current.data.id}`, { data: { type: "appStoreReviewDetails", id: current.data.id, attributes } });
  else await asc("POST", "/v1/appStoreReviewDetails", { data: { type: "appStoreReviewDetails", attributes,
    relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: VERSION } } } } });
});

if (buildNumber) await step(`attach build ${buildNumber}`, async () => {
  const build = (await asc("GET", `/v1/builds?filter[app]=${APP}&filter[version]=${buildNumber}&fields[builds]=version,processingState`)).data[0];
  if (!build) throw new Error("build not found yet");
  if (build.attributes.processingState !== "VALID") throw new Error(`build is ${build.attributes.processingState}`);
  await asc("PATCH", `/v1/appStoreVersions/${VERSION}/relationships/build`, { data: { type: "builds", id: build.id } });
});

if (withShots) await step("screenshots (6.7\" iPhone)", async () => {
  const dir = new URL(`../appstore/${cfg.shots}/`, import.meta.url).pathname;
  const files = readdirSync(dir).filter(f => f.endsWith(".png")).sort();
  const TYPE = "APP_IPHONE_67";
  const sets = await asc("GET", `/v1/appStoreVersionLocalizations/${vloc.id}/appScreenshotSets`);
  let set = sets.data.find(s => s.attributes.screenshotDisplayType === TYPE);
  if (set) { const old = await asc("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`); for (const s of old.data) await asc("DELETE", `/v1/appScreenshots/${s.id}`); }
  else set = (await asc("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: TYPE },
    relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: vloc.id } } } } })).data;
  for (const f of files) {
    const buf = readFileSync(dir + f);
    const shot = (await asc("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: f, fileSize: buf.length },
      relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).data;
    for (const op of shot.attributes.uploadOperations) {
      const headers = Object.fromEntries((op.requestHeaders || []).map(h => [h.name, h.value]));
      const r = await fetch(op.url, { method: op.method, headers, body: buf.subarray(op.offset, op.offset + op.length) });
      if (!r.ok) throw new Error(`upload part ${f} → ${r.status}`);
    }
    await asc("PATCH", `/v1/appScreenshots/${shot.id}`, { data: { type: "appScreenshots", id: shot.id,
      attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(buf).digest("hex") } } });
  }
  await new Promise(r => setTimeout(r, 10000));
  const now = await asc("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`);
  return now.data.map(s => `${s.attributes.fileName}:${s.attributes.assetDeliveryState?.state}`).join(" ");
});
console.log(failed ? `${failed} step(s) failed` : "All steps done");
process.exit(failed ? 1 : 0);
