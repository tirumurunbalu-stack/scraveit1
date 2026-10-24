import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {bucket: () => ({})}}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
const onboarding = await import("../src/services/restaurantOnboarding");

const owner = {uid: "owner1", email: "owner@example.com", firebase: {sign_in_provider: "google.com"}} as unknown as DecodedIdToken;
const staff = {uid: "staff1"} as unknown as DecodedIdToken;
const admin = {uid: "admin1", savrivoRole: "owner"} as unknown as DecodedIdToken;
const meta = {ip: "203.0.113.5", userAgent: "Scraveit Restaurant 3.13.4"};
const NOW = Date.UTC(2026, 9, 23, 6, 0);

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {files, bucket: () => ({file: (path: string) => ({save: async (data: Buffer) => { files.set(path, data); }})})} as const;
}

/** A store that went live before in-app signing: no agreement, and Scraveit lacks the owner's name and PAN. */
async function liveStore(extra: Record<string, unknown> = {}) {
  const db = new InMemoryFirestore();
  db.seed("restaurants/waffle", {name: "The Waffle Spot", address: "12 Gandhi Road", city: "Naidupeta", storeType: "restaurant", fssaiNumber: "11224999000123", ...extra});
  db.seed("restaurantMembers/waffle_owner1", {active: true, role: "restaurant_owner", restaurantId: "waffle"});
  db.seed("restaurantMembers/waffle_staff1", {active: true, role: "restaurant_staff", restaurantId: "waffle"});
  db.seed("restaurantPayoutProfiles/waffle", {legalBusinessName: "Ravi Foods", beneficiaryName: "Ravi Kumar"});
  db.seed("settings/legal", {platformName: "Scraveit", platformAddress: "Nellore, Andhra Pradesh", platformEmail: "partners@scraveit.example", platformPhone: "+91 90000 00000"});
  return db;
}

describe("a live store's partner agreement", () => {
  it("asks only for what Scraveit doesn't have, and shows the store's live rate", async () => {
    const db = await liveStore();
    const view = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: {}}, db, NOW);
    expect(view.status).toBe("ready");
    expect(view.issues).toEqual(["Owner's full name", "PAN"]);
    expect(view.known).toEqual({ownerName: false, pan: false, fssaiNumber: true, gstin: false});
    expect(view.sections[0]?.body).toContain("Ravi Foods, trading as The Waffle Spot");
    const filled = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: {ownerName: "Ravi Kumar", pan: "ABCPK1234D"}}, db, NOW);
    expect(filled.issues).toEqual([]);
    expect(filled.sections.find((s) => s.heading.startsWith("8."))?.body).toContain("ABCPK1234D");
  });

  it("treats the \"<store> Owner\" name Admin creates as missing, so the owner types their real name", async () => {
    const db = await liveStore();
    db.seed("restaurantMembers/waffle_owner1", {active: true, role: "restaurant_owner", restaurantId: "waffle", name: "The Waffle Spot Owner"});
    const view = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: {}}, db, NOW);
    expect(view.known.ownerName).toBe(false);
    expect(view.issues).toContain("Owner's full name");
  });

  it("only the owner can see or sign it; an admin can look", async () => {
    const db = await liveStore();
    await expect(onboarding.getLiveRestaurantAgreement("staff1", staff, {restaurantId: "waffle", details: {}}, db, NOW)).rejects.toThrow(/owner/);
    await expect(onboarding.getLiveRestaurantAgreement("admin1", admin, {restaurantId: "waffle", details: {}}, db, NOW)).resolves.toMatchObject({status: "ready"});
    await expect(onboarding.signLiveRestaurantAgreement("admin1", admin, {restaurantId: "waffle", details: {}, hash: "0".repeat(64), typedName: "Ravi Kumar", consent: true, method: "in_app"}, meta, db, fakeBucket().bucket, NOW))
      .rejects.toThrow(/Only the owner/);
  });

  it("signs, keeps the PDF and record, pins the rate and saves the details it added", async () => {
    const db = await liveStore();
    const details = {ownerName: "Ravi Kumar", pan: "abcpk1234d"};
    const view = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details}, db, NOW);
    const {files, bucket} = fakeBucket();
    await expect(onboarding.signLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details, hash: view.hash, typedName: "Ravi", consent: true, method: "in_app"}, meta, db, bucket, NOW))
      .rejects.toThrow(/full name/);
    await expect(onboarding.signLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details, hash: view.hash, typedName: "ravi  kumar", consent: true, method: "in_app"}, meta, db, bucket, NOW))
      .resolves.toEqual({signed: true, signedAt: NOW});
    expect([...files.keys()][0]).toMatch(/^private\/restaurant-agreements\/live-waffle\/partner-v1-2026-10-[0-9a-f]{12}\.pdf$/);
    expect(db.read("restaurants/waffle")).toMatchObject({agreementSignedAt: NOW, agreementHash: view.hash, commissionBps: view.commissionBps, commissionTermMonths: 12});
    expect(db.read("restaurantPayoutProfiles/waffle")).toMatchObject({panNumber: "ABCPK1234D", legalBusinessName: "Ravi Foods"});
    expect(db.read("restaurantMembers/waffle_owner1")).toMatchObject({name: "Ravi Kumar", role: "restaurant_owner"});
    expect(db.read("restaurantAgreements/live_waffle")).toMatchObject({status: "signed", restaurantId: "waffle", hash: view.hash, ip: meta.ip, typedName: "ravi  kumar"});
    // Afterwards it shows as signed, with the words that were signed, and can't be signed twice.
    const after = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: {}}, db, NOW + 1000);
    expect(after).toMatchObject({status: "signed", signedAt: NOW, hash: view.hash, issues: []});
    expect(after.sections).toEqual(view.sections);
    await expect(onboarding.signLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details, hash: view.hash, typedName: "Ravi Kumar", consent: true, method: "in_app"}, meta, db, bucket, NOW))
      .rejects.toThrow(/already signed/);
  });

  it("never lets typed details replace what Scraveit already holds", async () => {
    const db = await liveStore();
    db.seed("restaurantMembers/waffle_owner1", {active: true, role: "restaurant_owner", restaurantId: "waffle", name: "Ravi Kumar"});
    db.seed("restaurantPayoutProfiles/waffle", {legalBusinessName: "Ravi Foods", panNumber: "ABCPK1234D"});
    const view = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: {ownerName: "Someone Else", pan: "ZZZPZ9999Z", fssaiNumber: "21224999000999"}}, db, NOW);
    expect(view.issues).toEqual([]);
    expect(view.sections[0]?.body).toContain("represented by Ravi Kumar");
    expect(view.sections.find((s) => s.heading.startsWith("6."))?.body).toContain("11224999000123");
  });

  it("refuses to sign while details are missing or wrong", async () => {
    const db = await liveStore({fssaiNumber: ""});
    const details = {ownerName: "Ravi Kumar", pan: "ABCPK1234D", fssaiNumber: "31224999000123"};
    const view = await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details}, db, NOW);
    expect(view.issues).toEqual(["FSSAI number"]);
    await expect(onboarding.signLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details, hash: view.hash, typedName: "Ravi Kumar", consent: true, method: "in_app"}, meta, db, fakeBucket().bucket, NOW))
      .rejects.toThrow(/FSSAI number/);
  });

  it("a grocery store without a GSTIN gives its GST enrolment number", async () => {
    const db = await liveStore({storeType: "grocery"});
    const base = {ownerName: "Ravi Kumar", pan: "ABCPK1234D"};
    expect((await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: base}, db, NOW)).issues).toEqual(["GST enrolment number (or a GSTIN)"]);
    expect((await onboarding.getLiveRestaurantAgreement("owner1", owner, {restaurantId: "waffle", details: {...base, gstMode: "exempt_only"}}, db, NOW)).issues).toEqual([]);
  });
});
