import {logger} from "firebase-functions";
import {firestoreDb} from "../admin";
import type {LedgerJournal} from "../domain/ledger";
import type {FirestoreLike} from "../firestoreTypes";
import {
  LEDGER_JOURNALS_COLLECTION,
  LEDGER_PARTY_INDEX_STATE_DOC,
  LEDGER_PARTY_JOURNALS_COLLECTION,
  ledgerJournalParties,
  ledgerPartyEntryId,
} from "./ledger";

const PAGE_SIZE = 300;

/**
 * Files journals written before the per-party index existed. Runs on a
 * schedule, a bounded amount per run, resuming from where it stopped; once it
 * reaches the end it marks the index complete and readers switch to it. New
 * journals are indexed as they are written, so nothing is missed meanwhile.
 * Re-indexing a journal overwrites the same documents, so overlap is harmless.
 */
export async function backfillLedgerPartyIndex(
  database: FirestoreLike = firestoreDb,
  maxJournals = 3000,
  now: () => number = Date.now,
): Promise<{indexed: number; complete: boolean}> {
  const stateRef = database.collection("private").doc(LEDGER_PARTY_INDEX_STATE_DOC);
  const stateSnapshot = await stateRef.get();
  const state = (stateSnapshot.exists ? stateSnapshot.data() : {}) as {complete?: unknown; cursorOccurredAt?: unknown; indexedTotal?: unknown};
  if (state.complete === true) return {indexed: 0, complete: true};
  let cursor = Number(state.cursorOccurredAt ?? 0) || 0;
  let indexed = 0;
  let complete = false;
  const orderRestaurant = new Map<string, string>();
  while (indexed < maxJournals) {
    const page = await database.collection(LEDGER_JOURNALS_COLLECTION)
      .orderBy("occurredAt", "asc").startAt(cursor).limit(PAGE_SIZE).get();
    let batch = database.batch();
    let writes = 0;
    let last = cursor;
    for (const doc of page.docs) {
      const journal = doc.data() as LedgerJournal;
      if (!journal || !Array.isArray(journal.entries)) continue;
      const parties = ledgerJournalParties(journal);
      if (journal.orderId && !parties.some((party) => party.startsWith("restaurant:"))) {
        if (!orderRestaurant.has(journal.orderId)) {
          const order = await database.collection("orders").doc(journal.orderId).get();
          orderRestaurant.set(journal.orderId, order.exists ? String((order.data() as {restaurantId?: unknown}).restaurantId ?? "") : "");
        }
        const restaurantId = orderRestaurant.get(journal.orderId);
        if (restaurantId) parties.push(`restaurant:${restaurantId}`);
      }
      for (const party of parties) {
        batch.set(database.collection(LEDGER_PARTY_JOURNALS_COLLECTION).doc(ledgerPartyEntryId(party, doc.id)),
          {party, journalId: doc.id, occurredAt: journal.occurredAt, journal});
        writes += 1;
        if (writes % 400 === 0) { await batch.commit(); batch = database.batch(); }
      }
      last = Math.max(last, Number(journal.occurredAt) || 0);
    }
    if (writes % 400 !== 0) await batch.commit();
    indexed += page.docs.length;
    if (page.docs.length < PAGE_SIZE) { complete = true; break; }
    // startAt re-reads journals sharing the last timestamp (harmless); a page
    // made entirely of one timestamp must still move forward.
    cursor = last === cursor ? cursor + 1 : last;
  }
  await stateRef.set({
    complete, cursorOccurredAt: cursor, updatedAt: now(),
    indexedTotal: (Number(state.indexedTotal) || 0) + indexed,
  }, {merge: true});
  logger.info("LEDGER_PARTY_INDEX_BACKFILL", {indexed, complete, cursor});
  return {indexed, complete};
}
