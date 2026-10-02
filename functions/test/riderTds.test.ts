import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {createLedgerJournal} from "../src/domain/ledger";
import {riderContractorTdsOnCredit} from "../src/domain/riderTds";
import {BASELINE_TAX_LAW} from "../src/domain/taxLaw";
import type {FirestoreLike} from "../src/firestoreTypes";
import {sweepRiderContractorTds} from "../src/services/riderTds";
import {normalizeTaxSettings} from "../src/services/taxEngine";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const rule = BASELINE_TAX_LAW.contractorTds[1]!;
const empty = {creditedPaise: 0, largeCreditsPaise: 0, deductedPaise: 0};
const RIDER_PAN = "ABCPR1234K"; // 4th letter P: individual
const FIRM_PAN = "ABCFR1234K";

describe("rider contractor TDS rules (s.393(1) Table Sl. 6(i))", () => {
  it("uses 1% for an individual, 2% for others and the no-PAN rate without PAN", () => {
    expect(riderContractorTdsOnCredit(rule, RIDER_PAN, empty, 35_000_00).rateBps).toBe(100);
    expect(riderContractorTdsOnCredit(rule, FIRM_PAN, empty, 35_000_00).rateBps).toBe(200);
    expect(riderContractorTdsOnCredit(rule, "", empty, 35_000_00).rateBps).toBe(2_000);
  });

  it("deducts nothing while each credit is ≤ ₹30,000 and the year ≤ ₹1,00,000", () => {
    expect(riderContractorTdsOnCredit(rule, RIDER_PAN, {...empty, creditedPaise: 99_000_00}, 1_000_00).tdsPaise).toBe(0);
  });

  it("taxes a single credit above ₹30,000 on its own", () => {
    expect(riderContractorTdsOnCredit(rule, RIDER_PAN, empty, 30_001_00).tdsPaise).toBe(30_001);
  });

  it("catches up the whole year once credits pass ₹1,00,000, then only the new amount", () => {
    const crossing = riderContractorTdsOnCredit(rule, RIDER_PAN, {...empty, creditedPaise: 99_500_00}, 1_000_00);
    expect(crossing.tdsPaise).toBe(1_00_500); // 1% of ₹1,00,500
    const next = riderContractorTdsOnCredit(rule, RIDER_PAN, crossing.year, 500_00);
    expect(next.tdsPaise).toBe(500);
    expect(next.year.deductedPaise).toBe(1_01_000);
  });
});

function earning(id: string, riderId: string, paise: number, at: number) {
  return createLedgerJournal({eventType: "rider_earning", eventId: id, occurredAt: at, metadata: {riderId}, postings: [
    {accountId: "expense:rider-pay", side: "debit", amountPaise: paise},
    {accountId: `liability:rider-earnings:${riderId}`, side: "credit", amountPaise: paise},
  ]});
}

describe("rider TDS sweep over the ledger", () => {
  const at = Date.parse("2026-10-10T12:00:00+05:30");
  const live = {gstLive: true, scraveitGstin: "37ABCDE1234F1Z5"};

  it("stays off until GST_LIVE is on and SCRAVEIT's GSTIN is saved", async () => {
    expect(normalizeTaxSettings({gstLive: true}).live).toBe(false);
    expect(normalizeTaxSettings({gstLive: false, scraveitGstin: "37ABCDE1234F1Z5"}).live).toBe(false);
    expect(normalizeTaxSettings(live).live).toBe(true);
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", {gstLive: true});
    expect((await sweepRiderContractorTds(db as unknown as FirestoreLike, at)).live).toBe(false);
  });

  it("deducts 1% once the year passes ₹1 lakh, once per credit, and skips tips and employees", async () => {
    const db = new InMemoryFirestore();
    db.seed("private/taxLaw", live);
    db.seed("riders/r1", {fullName: "Ravi", panNumber: RIDER_PAN});
    db.seed("riders/r2", {fullName: "Staff rider", panNumber: RIDER_PAN, taxClassification: "EMPLOYEE"});
    const journals = [earning("e1", "r1", 60_000_00, at), earning("e2", "r1", 45_000_00, at + 1), earning("e3", "r2", 1_20_000_00, at + 2),
      createLedgerJournal({eventType: "rider_tip", eventId: "t1", occurredAt: at + 3, metadata: {riderId: "r1"}, postings: [
        {accountId: "asset:gateway", side: "debit", amountPaise: 5_000_00},
        {accountId: "liability:rider-tips:r1", side: "credit", amountPaise: 5_000_00}]})];
    for (const journal of journals) db.seed(`ledgerJournals/${journal.journalId}`, JSON.parse(JSON.stringify(journal)));
    const database = db as unknown as FirestoreLike;

    const first = await sweepRiderContractorTds(database, at + 10);
    const again = await sweepRiderContractorTds(database, at + 20);
    // 1% of ₹1,05,000 when the second credit crosses ₹1 lakh; tips untouched.
    expect(first.tdsPaise).toBe(1_05_000);
    expect(again.tdsPaise).toBe(0);
    expect(db.read("taxRiderYears/r1_26-27")).toMatchObject({creditedPaise: 1_05_000_00, deductedPaise: 1_05_000});
    expect(db.read("taxRiderYears/r2_26-27")).toMatchObject({classification: "EMPLOYEE", deductedPaise: 0});
    type Stored = {eventType: string; entries: {accountId: string; side: string; amountPaise: number}[]};
    const tdsJournals = db.paths().filter((path) => /^ledgerJournals\/[^/]+$/.test(path))
      .map((path) => db.read(path) as Stored).filter((journal) => journal.eventType === "rider_contractor_tds");
    // ₹60,000 is over the ₹30,000 single-credit limit: ₹600 at once; the
    // ₹45,000 credit crosses ₹1 lakh: required ₹1,050 − ₹600 = ₹450.
    const amounts = tdsJournals.map((journal) => journal.entries.find((entry) =>
      entry.accountId === "liability:rider-contractor-tds-payable" && entry.side === "credit")!.amountPaise).sort((a, b) => a - b);
    expect(amounts).toEqual([45_000, 60_000]);
  });
});
