// Fills the App Store listing for Scraveit Customer (text, categories, age rating, build). Re-runnable.
import { asc } from "./asc.mjs";
const APP = "6837140618", VERSION = "5abf2427-4864-4f81-810c-441b1e6cc4ea", VLOC = "54e19e19-bdcd-4b42-a5a8-f47f6e6074a4";
const INFO = "30c7f021-9453-4395-a031-2c287aa92c3d", ILOC = "7d840c28-3a92-4678-83aa-32f25d6ff64c";
const BUILD = process.argv[2]; // build id to attach
const description = `Scraveit delivers from partner restaurants, grocery stores and dairies in your town.

• Browse restaurants, groceries and dairy in one app
• See every price before you pay, with no surprise charges
• Pay by cash on delivery or online
• Track your delivery partner live on the map from the moment you order
• Chat with the store or delivery partner without sharing your phone number
• Save addresses, favourites and offers; earn wallet cashback
• Order together with friends in a Squad, or let the Craving Wheel decide

Every partner store shows its FSSAI licence. Scraveit is operated by Scraveit Private Limited, Nellore, Andhra Pradesh.`;
const step = async (name, fn) => { try { await fn(); console.log("✓", name); } catch (e) { console.log("✗", name, e.message.slice(0, 600)); } };
await step("version text", () => asc("PATCH", `/v1/appStoreVersionLocalizations/${VLOC}`, { data: { type: "appStoreVersionLocalizations", id: VLOC, attributes: {
  description, keywords: "food delivery,grocery,dairy,milk,biryani,restaurant,meals,order food,Nellore,cash on delivery",
  promotionalText: "Order from restaurants, grocery stores and dairies near you, with live tracking.",
  supportUrl: "https://scraveit.in/", marketingUrl: "https://scraveit.in/" } } }));
await step("subtitle + privacy URL", () => asc("PATCH", `/v1/appInfoLocalizations/${ILOC}`, { data: { type: "appInfoLocalizations", id: ILOC, attributes: {
  subtitle: "Food delivery in your town", privacyPolicyUrl: "https://scraveit.in/privacy" } } }));
await step("categories", () => asc("PATCH", `/v1/appInfos/${INFO}`, { data: { type: "appInfos", id: INFO, relationships: {
  primaryCategory: { data: { type: "appCategories", id: "FOOD_AND_DRINK" } }, secondaryCategory: { data: { type: "appCategories", id: "SHOPPING" } } } } }));
await step("copyright", () => asc("PATCH", `/v1/appStoreVersions/${VERSION}`, { data: { type: "appStoreVersions", id: VERSION, attributes: { copyright: "2026 Scraveit Private Limited" } } }));
await step("content rights", () => asc("PATCH", `/v1/apps/${APP}`, { data: { type: "apps", id: APP, attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" } } }));
if (BUILD) await step("attach build", () => asc("PATCH", `/v1/appStoreVersions/${VERSION}/relationships/build`, { data: { type: "builds", id: BUILD } }));
