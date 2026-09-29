import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({
  firestoreDb: {collection: () => { throw new Error("UNEXPECTED_DEFAULT_FIRESTORE"); }},
}));

import {backfillLedgerPartyIndex} from "../src/services/ledgerPartyIndex";
import {ledgerPartyIndexReady, readPartyLedgerJournals} from "../src/services/ledger";
import type {FirestoreLike} from "../src/firestoreTypes";
import {InMemoryFirestore} from "./helpers/inMemoryFirestore";

const journal = (id: string, occurredAt: number, accounts: string[], extra: Record<string, unknown> = {}) => ({
  journalId: id, occurredAt,
  entries: accounts.map((accountId) => ({accountId, direction: "credit", amountPaise: 100})),
  ...extra,
});

describe("ledger party index backfill", () => {
  it("files older journals under each rider and restaurant, then tells readers the index is ready", async () => {
    const database = new InMemoryFirestore();
    const db = database as unknown as FirestoreLike;
    database.seed("orders/o1", {restaurantId: "rest-1"});
    database.seed("ledgerJournals/j1", journal("j1", 1_000, ["liability:rider-earnings:r1", "liability:restaurant-payable:rest-1"]));
    database.seed("ledgerJournals/j2", journal("j2", 2_000, ["liability:rider-tips:r2"]));
    // A refund names only its order; its restaurant comes from the order.
    database.seed("ledgerJournals/j3", journal("j3", 3_000, ["asset:refund-settlement-recovery:o1"], {orderId: "o1"}));

    expect(await ledgerPartyIndexReady(db as never)).toBe(false);
    expect(await backfillLedgerPartyIndex(db)).toEqual({indexed: 3, complete: true});
    expect(await ledgerPartyIndexReady(db as never)).toBe(true);

    expect(Object.keys(await readPartyLedgerJournals("restaurant:rest-1", 10, db as never))).toEqual(["j3", "j1"]);
    expect(Object.keys(await readPartyLedgerJournals("rider:r1", 10, db as never))).toEqual(["j1"]);
    expect(Object.keys(await readPartyLedgerJournals("rider:r2", 10, db as never))).toEqual(["j2"]);

    // Once complete, later runs do nothing.
    expect(await backfillLedgerPartyIndex(db)).toEqual({indexed: 0, complete: true});
  });
});
