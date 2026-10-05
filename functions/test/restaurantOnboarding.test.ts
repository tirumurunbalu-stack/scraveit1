import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {bucket: () => ({})}}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
import {
  STANDARD_COMMISSION_BPS,
  assessFssai,
  assessGstin,
  renderAgreement,
  validIfsc,
  validPan,
} from "../src/domain/restaurantOnboarding";
const onboarding = await import("../src/services/restaurantOnboarding");

const owner = {uid: "owner1", firebase: {sign_in_provider: "google.com"}} as unknown as DecodedIdToken;
const admin = {uid: "admin1", savrivoRole: "owner"} as unknown as DecodedIdToken;

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {files, bucket: () => ({file: (path: string) => ({
    save: async (data: Buffer) => { files.set(path, data); },
    getSignedUrl: async () => [`https://signed.example/${path}`],
  })})} as const;
}

function application(extra: Record<string, unknown> = {}) {
  return {
    uid: "owner1", email: "owner@example.com", storeType: "restaurant", status: "submitted",
    restaurantName: "The Waffle Spot", ownerName: "Ravi Kumar", phone: "+91 98765 43210",
    location: {lat: 14.03, lng: 79.9, address: "12 Gandhi Road", area: "Naidupeta", city: "Naidupeta", pincode: "524126"},
    cuisines: ["Desserts"],
    fssai: {number: "11224999000123", photoPath: "private/restaurant-onboarding/owner1/fssai-1.jpg", expiresOn: "2030-01-01"},
    pan: {number: "ABCPK1234D", name: "Ravi Kumar", photoPath: "private/restaurant-onboarding/owner1/pan-1.jpg"},
    bank: {method: "bank", holderName: "Ravi Kumar", accountNumber: "123456789012", ifsc: "SBIN0001234"},
    menu: {dishes: [1, 2, 3, 4, 5].map((n) => ({name: `Waffle ${n}`, price: 100 + n, diet: "veg", category: "Waffles"}))},
    submittedAt: Date.UTC(2026, 9, 5),
    ...extra,
  };
}

async function seeded(extra: Record<string, unknown> = {}) {
  const db = new InMemoryFirestore();
  await db.collection("restaurantApplications").doc("owner1").set(application(extra));
  await db.collection("settings").doc("legal").set({platformName: "Scraveit", platformAddress: "Naidupeta, Andhra Pradesh",
    platformEmail: "partners@scraveit.example", platformPhone: "+91 90000 00000"});
  return db;
}

describe("document checks", () => {
  it("reads FSSAI licence vs registration from the first digit", () => {
    expect(assessFssai("11224999000123")).toEqual({ok: true, kind: "licence"});
    expect(assessFssai("21224999000123")).toEqual({ok: true, kind: "registration"});
    expect(assessFssai("31224999000123").ok).toBe(false);
    expect(assessFssai("1122499900012").ok).toBe(false);
  });
  it("checks PAN, IFSC and the GSTIN check character", () => {
    expect(validPan("ABCPK1234D")).toBe(true);
    expect(validPan("ABCXK1234D")).toBe(false);
    expect(validIfsc("SBIN0001234")).toBe(true);
    expect(validIfsc("SBIN1001234")).toBe(false);
    // 27AAPFU0939F1ZV is the widely published sample GSTIN.
    expect(assessGstin("27AAPFU0939F1ZV", "AAPFU0939F")).toMatchObject({ok: true, panMatches: true, stateCode: "27"});
    expect(assessGstin("27AAPFU0939F1ZW").ok).toBe(false);
  });
});

describe("partner agreement", () => {
  it("states the agreed rate and the restaurant's FSSAI number", () => {
    const text = renderAgreement({platform: {name: "Scraveit", address: "Naidupeta", email: "a@b.c", phone: "1"},
      restaurantName: "The Waffle Spot", legalName: "", ownerName: "Ravi Kumar", address: "Naidupeta", fssaiNumber: "11224999000123",
      pan: "ABCPK1234D", gstin: "", commissionBps: 1_800, termMonths: 12, date: "2026-10-05"}).map((s) => s.body).join(" ");
    expect(text).toContain("commission of 18% of the item total after the Restaurant's own offers");
    expect(text).toContain("fixed for 12 months");
    expect(text).toContain("11224999000123");
    expect(text).toContain("not registered for GST");
  });

  it("shows the 30% standard rate until Scraveit sets the agreed one", async () => {
    const db = await seeded();
    const view = await onboarding.getRestaurantAgreement("owner1", owner, "owner1", db);
    expect(view).toMatchObject({status: "waiting_for_rate", commissionBps: STANDARD_COMMISSION_BPS, rateAgreed: false});
    await expect(onboarding.getRestaurantAgreement("someone-else", {uid: "x"} as unknown as DecodedIdToken, "owner1", db)).rejects.toThrow();
  });

  it("signs with the typed name, stores a PDF, and refuses a stale document", async () => {
    const db = await seeded();
    await onboarding.setRestaurantAgreementTerms("admin1", admin, {appId: "owner1", commissionBps: 1_800, termMonths: 12, note: "Founding partner"}, db);
    const view = await onboarding.getRestaurantAgreement("owner1", owner, "owner1", db);
    expect(view).toMatchObject({status: "ready", commissionBps: 1_800});
    const {files, bucket} = fakeBucket();
    const meta = {ip: "1.2.3.4", userAgent: "test"};
    await expect(onboarding.signRestaurantAgreement("owner1", owner, {appId: "owner1", hash: "0".repeat(64), typedName: "Ravi Kumar", consent: true, method: "in_app"}, meta, db, bucket)).rejects.toThrow(/changed/);
    await expect(onboarding.signRestaurantAgreement("owner1", owner, {appId: "owner1", hash: view.hash, typedName: "Ravi", consent: true, method: "in_app"}, meta, db, bucket)).rejects.toThrow(/full name/);
    await expect(onboarding.signRestaurantAgreement("owner1", owner, {appId: "owner1", hash: view.hash, typedName: "ravi  kumar", consent: true, method: "aadhaar_esign"}, meta, db, bucket)).rejects.toThrow(/not switched on/);
    await onboarding.signRestaurantAgreement("owner1", owner, {appId: "owner1", hash: view.hash, typedName: "ravi  kumar", consent: true, method: "in_app"}, meta, db, bucket);
    const [path, pdf] = [...files.entries()][0]!;
    expect(path).toMatch(/^private\/restaurant-agreements\/owner1\/partner-v1-/);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const app = (await db.collection("restaurantApplications").doc("owner1").get()).data() as Record<string, any>;
    expect(app.agreement).toMatchObject({status: "signed", commissionBps: 1_800, method: "in_app"});
  });

  it("a new rate makes the old signature void", async () => {
    const db = await seeded({terms: {commissionBps: 1_800, termMonths: 12, setAt: 1}, agreement: {status: "signed", commissionBps: 1_800}});
    await onboarding.setRestaurantAgreementTerms("admin1", admin, {appId: "owner1", commissionBps: 1_500, termMonths: 12, note: ""}, db);
    const app = (await db.collection("restaurantApplications").doc("owner1").get()).data() as Record<string, any>;
    expect(app.agreement.status).toBe("superseded");
  });
});

describe("approval", () => {
  it("needs a signed agreement, then creates the listing at the signed rate", async () => {
    const db = await seeded({terms: {commissionBps: 1_800, termMonths: 12, setAt: 1}});
    await expect(onboarding.approveRestaurantApplication("admin1", admin, "owner1", db)).rejects.toThrow(/agreement/);
    await db.collection("restaurantApplications").doc("owner1").set({agreement: {status: "signed", commissionBps: 1_800, termMonths: 12, version: "v", signedAt: 5}}, {merge: true});
    const {restaurantId} = await onboarding.approveRestaurantApplication("admin1", admin, "owner1", db);
    expect(restaurantId).toBe("the-waffle-spot-owner1");
    const listing = (await db.collection("restaurants").doc(restaurantId).get()).data() as Record<string, any>;
    expect(listing).toMatchObject({commissionBps: 1_800, fssaiNumber: "11224999000123", open: false, lat: 14.03});
    expect(listing.bankAccountNumber).toBeUndefined();
    const payout = (await db.collection("restaurantPayoutProfiles").doc(restaurantId).get()).data() as Record<string, any>;
    expect(payout).toMatchObject({bankIfsc: "SBIN0001234", panNumber: "ABCPK1234D"});
    const items = await db.collection("menus").doc(restaurantId).collection("items").get();
    expect(items.docs.length).toBe(5);
  });

  it("blocks approval while documents are missing", async () => {
    const db = await seeded({fssai: {number: "123"}, agreement: {status: "signed"}});
    await expect(onboarding.approveRestaurantApplication("admin1", admin, "owner1", db)).rejects.toThrow(/FSSAI number/);
  });
});

describe("grocery and dairy", () => {
  async function store(extra: Record<string, unknown>) {
    const db = await seeded({storeType: "grocery", restaurantName: "Sri Lakshmi Stores", ...extra});
    return db;
  }
  it("needs a GSTIN, a GST enrolment number, or an exempt-only declaration", async () => {
    const db = await store({terms: {commissionBps: 1_500, termMonths: 12, setAt: 1}, agreement: {status: "signed", commissionBps: 1_500}});
    await expect(onboarding.approveRestaurantApplication("admin1", admin, "owner1", db)).rejects.toThrow(/GST enrolment number/);
    expect(onboarding.applicationIssues({...application(), storeType: "dairy", gstMode: "exempt_only"})).toEqual([]);
    expect(onboarding.applicationIssues({...application(), storeType: "grocery", gstEnrolment: "EID12345678AP"})).toEqual([]);
    expect(onboarding.applicationIssues({...application(), storeType: "restaurant"})).toEqual([]);
  });
  it("writes the goods GST terms into the agreement", () => {
    const base = {platform: {name: "Scraveit", address: "Naidupeta", email: "a@b.c", phone: "1"}, restaurantName: "Sri Lakshmi Stores",
      legalName: "", ownerName: "Ravi Kumar", address: "Naidupeta", fssaiNumber: "21224999000123", pan: "ABCPK1234D", gstin: "",
      commissionBps: 1_500, termMonths: 12, date: "2026-10-05"};
    const grocery = renderAgreement({...base, storeType: "grocery", gstMode: "enrolment", gstEnrolment: "EID12345678AP"}).map((x) => x.body).join(" ");
    expect(grocery).toContain('(the "Store")');
    expect(grocery).toContain("never above the MRP");
    expect(grocery).toContain("Notification 34/2023-Central Tax");
    expect(grocery).toContain("EID12345678AP");
    expect(grocery).not.toContain("section 9(5)");
    const dairy = renderAgreement({...base, storeType: "dairy", gstMode: "exempt_only"}).map((x) => x.body).join(" ");
    expect(dairy).toContain('(the "Dairy")');
    expect(dairy).toContain("only goods that are exempt from GST");
    const restaurant = renderAgreement(base).map((x) => x.body).join(" ");
    expect(restaurant).toContain("section 9(5)");
  });
});
