import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import type {DecodedIdToken} from "firebase-admin/auth";
import {createLedgerJournal} from "../src/domain/ledger";
import {
  classificationAt,
  classificationChangeProblem,
  EMPTY_RIDER_TDS_YEAR,
  panEntityType,
  riderContractorTdsOnCredit,
  type RiderTdsIdentity,
} from "../src/domain/riderTds";
import {BASELINE_TAX_LAW} from "../src/domain/taxLaw";
import type {FirestoreLike} from "../src/firestoreTypes";
import {setRiderTaxClassification, sweepRiderContractorTds} from "../src/services/riderTds";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const rule = BASELINE_TAX_LAW.contractorTds[1]!;
const empty = {...EMPTY_RIDER_TDS_YEAR};
const person: RiderTdsIdentity = {legalEntityType: "INDIVIDUAL", pan: "ABCPR1234K", panEntityType: "INDIVIDUAL", panVerified: true};
const earning = (amountPaise: number) => ({component: "rider_earning" as const, amountPaise});
const tip = (amountPaise: number) => ({component: "customer_tip" as const, amountPaise});
const TDS_ON = {tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: true};

describe("rider contractor TDS rules (s.393(1) Table Sl. 6(i))", () => {
  it("uses 1% for an individual/HUF, 2% for other entities, 20% without PAN", () => {
    expect(riderContractorTdsOnCredit(rule, person, empty, earning(35_000_00), "PENDING_REVIEW").rateBps).toBe(100);
    expect(riderContractorTdsOnCredit(rule, {...person, legalEntityType: "HUF", pan: "ABCHR1234K", panEntityType: "HUF"},
      empty, earning(35_000_00), "PENDING_REVIEW").rateBps).toBe(100);
    expect(riderContractorTdsOnCredit(rule, {...person, legalEntityType: "FIRM", pan: "ABCFR1234K", panEntityType: "FIRM"},
      empty, earning(35_000_00), "PENDING_REVIEW").rateBps).toBe(200);
    expect(riderContractorTdsOnCredit(rule, {...person, pan: "", panEntityType: ""}, empty, earning(35_000_00), "PENDING_REVIEW"))
      .toMatchObject({rateBps: 2_000, rateReason: "no_pan"});
  });

  it("takes the entity from legalEntityType and uses the PAN letter only as a check", () => {
    expect(panEntityType("ABCPR1234K")).toBe("INDIVIDUAL");
    // Declared LLP with an "F" PAN is consistent: 2%.
    expect(riderContractorTdsOnCredit(rule, {...person, legalEntityType: "LLP", pan: "ABCFR1234K", panEntityType: "FIRM"},
      empty, earning(35_000_00), "PENDING_REVIEW")).toMatchObject({rateBps: 200, rateReason: "other_entity"});
    // Declared individual but a company PAN: flagged, the higher rate until resolved.
    expect(riderContractorTdsOnCredit(rule, {...person, pan: "ABCCR1234K", panEntityType: "COMPANY"},
      empty, earning(35_000_00), "PENDING_REVIEW")).toMatchObject({rateBps: 200, rateReason: "entity_pan_mismatch"});
  });

  it("is strictly 'exceeds': exactly ₹30,000 and exactly ₹1,00,000 owe nothing", () => {
    expect(riderContractorTdsOnCredit(rule, person, empty, earning(30_000_00), "PENDING_REVIEW").tdsPaise).toBe(0);
    expect(riderContractorTdsOnCredit(rule, person, empty, earning(30_000_01), "PENDING_REVIEW").tdsPaise).toBe(30_000);
    expect(riderContractorTdsOnCredit(rule, person, {...empty, earningsPaise: 99_000_00}, earning(1_000_00), "PENDING_REVIEW").tdsPaise).toBe(0);
    expect(riderContractorTdsOnCredit(rule, person, {...empty, earningsPaise: 99_000_00}, earning(1_000_01), "PENDING_REVIEW").tdsPaise)
      .toBe(Math.round(1_00_000_01 / 100));
  });

  it("catches up the whole year once credits pass ₹1,00,000, then deducts only the shortfall", () => {
    const crossing = riderContractorTdsOnCredit(rule, person, {...empty, earningsPaise: 99_500_00}, earning(1_000_00), "PENDING_REVIEW");
    expect(crossing.tdsPaise).toBe(1_00_500);
    const next = riderContractorTdsOnCredit(rule, person, crossing.year, earning(500_00), "PENDING_REVIEW");
    expect(next.tdsPaise).toBe(500);
    expect(next.requiredYtdPaise - crossing.year.deductedPaise).toBe(next.tdsPaise);
  });

  it("keeps customer tips apart: counted but untaxed while PENDING_REVIEW or EXCLUDED, caught up when INCLUDED", () => {
    const pending = riderContractorTdsOnCredit(rule, person, {...empty, earningsPaise: 95_000_00}, tip(10_000_00), "PENDING_REVIEW");
    expect(pending).toMatchObject({tdsPaise: 0, year: {tipsPaise: 10_000_00, earningsPaise: 95_000_00}});
    expect(riderContractorTdsOnCredit(rule, person, {...empty, earningsPaise: 95_000_00}, tip(10_000_00), "EXCLUDED").tdsPaise).toBe(0);
    // Later the agreement says tips are included: the next credit catches up on ₹1,06,000.
    const included = riderContractorTdsOnCredit(rule, person, pending.year, earning(1_000_00), "INCLUDED");
    expect(included.tdsPaise).toBe(1_06_000);
  });
});

describe("contractor / employee: restricted, dated, never back in time", () => {
  const now = Date.parse("2026-10-02T12:00:00+05:30");
  const entry = (taxClassification: "CONTRACTOR" | "EMPLOYEE", from: string) =>
    ({taxClassification, classificationEffectiveFrom: from, classificationReason: "X", changedBy: "owner", changedAt: now});

  it("defaults every rider to CONTRACTOR / INDEPENDENT_DELIVERY_PARTNER", () => {
    expect(classificationAt([], now)).toMatchObject({taxClassification: "CONTRACTOR", classificationReason: "INDEPENDENT_DELIVERY_PARTNER"});
    const history = [entry("EMPLOYEE", "2026-11-01")];
    expect(classificationAt(history, now).taxClassification).toBe("CONTRACTOR");
    expect(classificationAt(history, Date.parse("2026-11-02T00:00:00+05:30")).taxClassification).toBe("EMPLOYEE");
  });

  it("refuses back-dated or out-of-order changes", () => {
    expect(classificationChangeProblem([], {effectiveFrom: "2026-10-01", now})).toMatch(/back in time/);
    expect(classificationChangeProblem([], {effectiveFrom: "2026-10-02", now})).toBe("");
    expect(classificationChangeProblem([entry("EMPLOYEE", "2026-11-01")], {effectiveFrom: "2026-10-20", now})).toMatch(/later date/);
  });

  it("needs the owner, a reason fit for EMPLOYEE and a note, and writes an immutable audit record", async () => {
    const db = new InMemoryFirestore();
    db.seed("riders/r1", {fullName: "Ravi"});
    const database = db as unknown as FirestoreLike;
    const owner = {uid: "owner-1", savrivoRole: "owner", email: "o@x.in"} as unknown as DecodedIdToken;
    const ops = {uid: "ops-1", savrivoRole: "ops_admin"} as unknown as DecodedIdToken;
    const change = {riderId: "r1", taxClassification: "EMPLOYEE" as const, effectiveFrom: "2026-10-05",
      reason: "ONBOARDED_AS_EMPLOYEE" as const, note: "Joined payroll, offer letter 2026-10-01"};
    await expect(setRiderTaxClassification("ops-1", ops, change, database, now)).rejects.toThrow(/owner/);
    await expect(setRiderTaxClassification("owner-1", owner, {...change, reason: "INDEPENDENT_DELIVERY_PARTNER"}, database, now))
      .rejects.toThrow(/payroll/);
    const result = await setRiderTaxClassification("owner-1", owner, change, database, now);
    expect(result.entries).toEqual([expect.objectContaining({taxClassification: "EMPLOYEE", classificationEffectiveFrom: "2026-10-05",
      classificationReason: "ONBOARDED_AS_EMPLOYEE", changedBy: "owner-1", changedAt: now})]);
    expect(db.read(`taxComplianceAudit/${result.auditId}`)).toMatchObject({action: "rider_tax_classification.change",
      actorId: "owner-1", before: {taxClassification: "CONTRACTOR"}, after: {taxClassification: "EMPLOYEE"}});
  });
});

function credit(id: string, account: string, paise: number, at: number, eventType: "rider_earning" | "rider_tip" = "rider_earning") {
  return createLedgerJournal({eventType, eventId: id, occurredAt: at, postings: [
    {accountId: "expense:rider-pay", side: "debit", amountPaise: paise},
    {accountId: account, side: "credit", amountPaise: paise},
  ]});
}

describe("rider TDS sweep: TDS_LIVE, independent of GST_LIVE", () => {
  const at = Date.parse("2026-10-10T12:00:00+05:30");

  it("stays off without TDS_LIVE, a valid TAN and TAN_VERIFIED, whatever GST_LIVE says", async () => {
    for (const settings of [
      {gstLive: true, scraveitGstin: "37ABCDE1234F1Z5"},
      {tdsLive: true, scraveitTan: "VPNS36496F", tanVerified: false},
      {tdsLive: true, scraveitTan: "BAD", tanVerified: true},
      {tdsLive: false, scraveitTan: "VPNS36496F", tanVerified: true},
    ]) {
      const db = new InMemoryFirestore();
      db.seed("private/taxLaw", settings);
      expect((await sweepRiderContractorTds(db as unknown as FirestoreLike, at)).active).toBe(false);
    }
  });

  it("never runs contractor TDS while the rider supplies delivery (RIDER, the default)", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", TDS_ON);
    db.seed("riders/r1", {panNumber: "ABCPR1234K"});
    const journal = credit("e1", "liability:rider-earnings:r1", 1_50_000_00, at);
    db.seed(`ledgerJournals/${journal.journalId}`, JSON.parse(JSON.stringify(journal)));
    expect(await sweepRiderContractorTds(db as unknown as FirestoreLike, at + 10)).toMatchObject({active: false, tdsPaise: 0});
    expect(db.paths().some((path) => path.startsWith("riderTdsCredits/"))).toBe(false);
  });

  it("SCRAVEIT supplier + rider subcontractor, TDS_LIVE alone (GST_LIVE off): once per credit, tips apart, employees to payroll", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", {...TDS_ON, gstLive: false, deliveryServiceSupplier: "SCRAVEIT"});
    db.seed("riders/r1", {fullName: "Ravi", panNumber: "ABCPR1234K", legalEntityType: "INDIVIDUAL"});
    db.seed("riders/r2", {fullName: "Staff rider", panNumber: "ABCPS1234K"});
    db.seed("riderTaxClassifications/r2", {entries: [{taxClassification: "EMPLOYEE", classificationEffectiveFrom: "2026-10-01",
      classificationReason: "ONBOARDED_AS_EMPLOYEE", changedBy: "owner", changedAt: at}]});
    const journals = [
      credit("e1", "liability:rider-earnings:r1", 60_000_00, at),
      credit("e2", "liability:rider-earnings:r1", 45_000_00, at + 1),
      credit("e3", "liability:rider-earnings:r2", 1_20_000_00, at + 2),
      credit("t1", "liability:rider-tips:r1", 5_000_00, at + 3, "rider_tip"),
    ];
    for (const journal of journals) db.seed(`ledgerJournals/${journal.journalId}`, JSON.parse(JSON.stringify(journal)));
    const database = db as unknown as FirestoreLike;

    const first = await sweepRiderContractorTds(database, at + 10);
    const again = await sweepRiderContractorTds(database, at + 20);
    // ₹60,000 > ₹30,000: ₹600 at once; ₹45,000 crosses ₹1 lakh: ₹1,050 − ₹600 = ₹450. Tip pending review: nothing.
    expect(first.tdsPaise).toBe(1_05_000);
    expect(again.tdsPaise).toBe(0);
    expect(db.read("taxRiderYears/r1_26-27")).toMatchObject({earningsPaise: 1_05_000_00, tipsPaise: 5_000_00, deductedPaise: 1_05_000});
    expect(db.read("taxRiderYears/r2_26-27")).toMatchObject({classification: "EMPLOYEE", deductedPaise: 0});
    type Stored = {eventType: string; entries: {accountId: string; side: string; amountPaise: number}[]};
    const amounts = db.paths().filter((path) => /^ledgerJournals\/[^/]+$/.test(path)).map((path) => db.read(path) as Stored)
      .filter((journal) => journal.eventType === "rider_contractor_tds")
      .map((journal) => journal.entries.find((entry) => entry.accountId === "liability:rider-contractor-tds-payable")!.amountPaise)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([45_000, 60_000]);
    const tipMarker = db.paths().find((path) => path.startsWith("riderTdsCredits/") && path.endsWith("__customer_tip"));
    expect(db.read(tipMarker!)).toMatchObject({component: "customer_tip", tipTdsTreatment: "PENDING_REVIEW", tdsPaise: 0});
  });
});
