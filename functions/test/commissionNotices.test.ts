import {beforeEach, describe, expect, it, vi} from "vitest";

const pushes: Array<Record<string, unknown>> = [];
vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {bucket: () => ({})}}));
vi.mock("../src/services/notifications", () => ({
  notifyStoreApplicant: vi.fn(async (input: Record<string, unknown>) => { pushes.push(input); }),
}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";
const notices = await import("../src/services/commissionNotices");
const {clearEconomicsControlCache} = await import("../src/services/economics");
const {liveCommission} = await import("../src/services/economicsAdmin");

const admin = {uid: "admin1", savrivoRole: "owner", email: "ops@example.com"} as unknown as DecodedIdToken;
const owner = {uid: "owner1", email: "owner@example.com", firebase: {sign_in_provider: "google.com"}} as unknown as DecodedIdToken;
const stranger = {uid: "x1"} as unknown as DecodedIdToken;
const meta = {ip: "203.0.113.5", userAgent: "Scraveit Restaurant 3.14.25"};
const NOW = Date.parse("2026-11-22T12:00:00+05:30");
const DAY = 86_400_000;

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {files, bucket: () => ({file: (path: string) => ({save: async (data: Buffer) => { files.set(path, data); }})})} as const;
}

function setup(signedAt = 0) {
  const db = new InMemoryFirestore();
  db.seed("settings/legal", {platformName: "Scraveit", platformAddress: "Nellore", platformEmail: "p@example.com", platformPhone: "+91 90000 00000"});
  for (const [id, name] of [["spicy", "Spicy Box"], ["sea", "Sea Box"]] as const) {
    db.seed(`restaurants/${id}`, {name, commissionBps: 1200, ...(signedAt ? {agreementSignedAt: signedAt, commissionTermMonths: 12} : {})});
    db.seed(`restaurantMembers/${id}_owner1`, {active: true, role: "restaurant_owner", restaurantId: id});
  }
  return db;
}

describe("commission change notice", () => {
  beforeEach(() => { pushes.length = 0; clearEconomicsControlCache(); });

  it("a higher rate needs 30 days, then one Accept books it for every outlet from its date", async () => {
    const db = setup(NOW - 400 * DAY);  // fixed period over
    const base = {restaurantIds: ["spicy", "sea"], commissionBps: 1500};
    await expect(notices.adminCommissionNotice("admin1", admin, {action: "send", ...base, effectiveDate: "2026-12-10"}, db, NOW))
      .rejects.toThrow(/30 days/);
    await expect(notices.adminCommissionNotice("owner1", owner, {action: "send", ...base, effectiveDate: "2026-12-30"}, db, NOW))
      .rejects.toThrow(/owner or operations-admin/);
    const preview = await notices.adminCommissionNotice("admin1", admin, {action: "preview", ...base, effectiveDate: "2026-12-30"}, db, NOW) as {consequence: string; sections: Array<{body: string}>};
    expect(preview.consequence).toBe("ends");
    expect(preview.sections[1]!.body).toContain("we are unable to continue");
    expect(db.read("restaurants/spicy")?.commissionNotice).toBeUndefined();

    const sent = await notices.adminCommissionNotice("admin1", admin, {action: "send", ...base, effectiveDate: "2026-12-30", note: "New delivery costs"}, db, NOW) as {noticeId: string};
    expect(db.read("restaurants/sea")).toMatchObject({commissionNotice: {id: sent.noticeId, status: "pending"}});
    expect(pushes).toHaveLength(1);
    await expect(notices.adminCommissionNotice("admin1", admin, {action: "send", ...base, effectiveDate: "2027-01-30"}, db, NOW))
      .rejects.toThrow(/already has a commission notice/);

    await expect(notices.restaurantCommissionNotice("x1", stranger, {action: "get", restaurantId: "spicy"}, meta, db, fakeBucket().bucket, NOW))
      .rejects.toThrow(/Only the owner/);
    const {notice} = await notices.restaurantCommissionNotice("owner1", owner, {action: "get", restaurantId: "spicy"}, meta, db, fakeBucket().bucket, NOW);
    expect(notice).toMatchObject({status: "pending", toBps: 1500, effectiveDate: "2026-12-30", lower: false});
    expect(notice!.sections[0]!.body).toContain("Spicy Box (now 12%), Sea Box (now 12%) to 15%");
    await expect(notices.restaurantCommissionNotice("owner1", owner, {action: "accept", restaurantId: "spicy", noticeId: notice!.noticeId, hash: "0".repeat(64), consent: true}, meta, db, fakeBucket().bucket, NOW))
      .rejects.toThrow(/changed/);
    const {files, bucket} = fakeBucket();
    const done = await notices.restaurantCommissionNotice("owner1", owner, {action: "accept", restaurantId: "spicy", noticeId: notice!.noticeId, hash: notice!.hash, consent: true}, meta, db, bucket, NOW);
    expect(done).toMatchObject({accepted: 2, notice: {status: "accepted"}});
    expect(files.size).toBe(1);
    expect(db.read("restaurants/sea")).toMatchObject({commissionNotice: {status: "accepted"}});
    // Old rate until the date, new rate from it.
    const at = Date.parse("2026-12-30T00:00:00+05:30");
    expect((await liveCommission("sea", db, at - 1)).commissionBps).toBe(1200);
    clearEconomicsControlCache();
    expect(await liveCommission("sea", db, at)).toEqual({commissionBps: 1500, source: "plan"});
    await expect(notices.restaurantCommissionNotice("owner1", owner, {action: "accept", restaurantId: "sea", noticeId: notice!.noticeId, hash: notice!.hash, consent: true}, meta, db, bucket, NOW))
      .rejects.toThrow(/Already accepted/);
  });

  it("inside the fixed period, not accepting keeps the old rate; after the date it shows as lapsed", async () => {
    const db = setup(NOW - 30 * DAY);
    const sent = await notices.adminCommissionNotice("admin1", admin, {action: "send", restaurantIds: ["spicy"], commissionBps: 1800, effectiveDate: "2027-01-15"}, db, NOW) as {consequence: string; sections: Array<{body: string}>};
    expect(sent.consequence).toBe("keeps");
    expect(sent.sections[1]!.body).toContain("your current rate stays");
    const later = Date.parse("2027-01-16T00:00:00+05:30");
    const {notice} = await notices.restaurantCommissionNotice("owner1", owner, {action: "get", restaurantId: "spicy"}, meta, db, fakeBucket().bucket, later);
    expect(notice!.status).toBe("lapsed");
    await expect(notices.restaurantCommissionNotice("owner1", owner, {action: "accept", restaurantId: "spicy", noticeId: notice!.noticeId, hash: notice!.hash, consent: true}, meta, db, fakeBucket().bucket, later))
      .rejects.toThrow(/passed/);
    clearEconomicsControlCache();
    expect((await liveCommission("spicy", db, later)).commissionBps).toBe(1200);
  });

  it("a lower rate applies on its date with no Accept; a waiting notice can be withdrawn", async () => {
    const db = setup();
    const lower = await notices.adminCommissionNotice("admin1", admin, {action: "send", restaurantIds: ["spicy"], commissionBps: 1000, effectiveDate: "2026-11-25"}, db, NOW) as {status: string; sections: Array<{body: string}>};
    expect(lower.status).toBe("applied");
    expect(lower.sections[1]!.body).toMatch(/^Nothing/);
    clearEconomicsControlCache();
    expect((await liveCommission("spicy", db, Date.parse("2026-11-25T00:00:00+05:30"))).commissionBps).toBe(1000);

    const up = await notices.adminCommissionNotice("admin1", admin, {action: "send", restaurantIds: ["sea"], commissionBps: 1400, effectiveDate: "2027-01-01"}, db, NOW) as {noticeId: string};
    await notices.adminCommissionNotice("admin1", admin, {action: "withdraw", noticeId: up.noticeId}, db, NOW);
    expect(db.read("restaurants/sea")).toMatchObject({commissionNotice: {status: "withdrawn"}});
    db.seed("userRestaurants/owner1", {spicy: true, sea: true, gone: false});
    const status = await notices.adminCommissionNotice("admin1", admin, {action: "status", restaurantId: "sea"}, db, NOW) as {notices: Array<{status: string}>; outlets: Array<{restaurantId: string}>};
    expect(status.notices.map((n) => n.status)).toEqual(["withdrawn"]);
    expect(status.outlets.map((o) => o.restaurantId).sort()).toEqual(["sea", "spicy"]);
    db.seed("restaurants/cheap", {name: "Cheap Eats", commissionBps: 1000});
    await expect(notices.adminCommissionNotice("admin1", admin, {action: "send", restaurantIds: ["sea", "cheap"], commissionBps: 1100, effectiveDate: "2027-01-01"}, db, NOW))
      .rejects.toThrow(/higher for some stores and lower for others/);
  });

  it("refuses markup stores and a rate that doesn't change", async () => {
    const db = setup();
    db.seed("restaurants/mk", {name: "Markup Mart", pricingModel: "markup"});
    await expect(notices.adminCommissionNotice("admin1", admin, {action: "preview", restaurantIds: ["mk"], commissionBps: 1500, effectiveDate: "2027-01-01"}, db, NOW))
      .rejects.toThrow(/markup pricing/);
    await expect(notices.adminCommissionNotice("admin1", admin, {action: "preview", restaurantIds: ["spicy"], commissionBps: 1200, effectiveDate: "2027-01-01"}, db, NOW))
      .rejects.toThrow(/already the commission/);
  });
});
