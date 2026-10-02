import {randomUUID} from "crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {firestoreDb, storage} from "../admin";
import type {OrderEconomicsSnapshot} from "../domain/economics";
import type {OrderTax} from "../domain/orderTax";
import {
  buildTaxPack,
  parseBankStatementCsv,
  taxPackWorkbook,
  type TaxPackInput,
  type TaxPackJournal,
  type TaxPackRiderTdsCredit,
  type TaxPackWithholding,
} from "../domain/taxPack";
import {DomainError} from "../errors";
import type {FirestoreLike} from "../firestoreTypes";
import {requireOwnerClaim} from "./authz";
import {LEDGER_JOURNALS_COLLECTION} from "./ledger";
import {RESTAURANT_PAYOUT_PROFILES_COLLECTION} from "./restaurantPayoutProfiles";
import {RIDER_TDS_CREDITS_COLLECTION} from "./riderTds";
import {sellerTaxProfile, storeKindOf, TAX_WITHHOLDINGS_COLLECTION} from "./taxEngine";

const MAX_DAYS = 400;
const MAX_ROWS = 50_000;
// Same folder (and scheduled clean-up) as the admin data export.
const EXPORT_STORAGE_PREFIX = "admin-exports/";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Everything the tax pack needs for [from, to), read only from server records. */
export async function loadTaxPackInput(from: number, to: number, bankStatementCsv: string | undefined,
  database: FirestoreLike = firestoreDb, now = Date.now()): Promise<TaxPackInput> {
  const [ordersSnap, withholdingSnap, journalSnap, restaurantSnap, profileSnap, riderSnap, riderTdsSnap] = await Promise.all([
    database.collection("orders").where("deliveredAt", ">=", from).where("deliveredAt", "<", to).limit(MAX_ROWS).get(),
    database.collection(TAX_WITHHOLDINGS_COLLECTION).where("recordedAt", ">=", from).where("recordedAt", "<", to).limit(MAX_ROWS).get(),
    database.collection(LEDGER_JOURNALS_COLLECTION).where("occurredAt", ">=", from).where("occurredAt", "<", to).limit(MAX_ROWS).get(),
    database.collection("restaurants").get(),
    database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).get(),
    database.collection("riders").get(),
    database.collection(RIDER_TDS_CREDITS_COLLECTION).where("occurredAt", ">=", from).where("occurredAt", "<", to).limit(MAX_ROWS).get(),
  ]);
  if (ordersSnap.docs.length >= MAX_ROWS || journalSnap.docs.length >= MAX_ROWS) {
    throw new DomainError("failed-precondition", "That period is too large for one file. Download one month at a time.");
  }
  const restaurants = new Map(restaurantSnap.docs.map((doc) => [doc.id, record(doc.data())]));
  const profiles = new Map(profileSnap.docs.map((doc) => [doc.id, doc.data()]));
  const economics = new Map<string, Record<string, unknown>>();
  const orderIds = ordersSnap.docs.map((doc) => doc.id);
  for (let i = 0; i < orderIds.length; i += 200) {
    const chunk = await Promise.all(orderIds.slice(i, i + 200).map((id) => database.collection("orderEconomics").doc(id).get()));
    chunk.forEach((doc, index) => { if (doc.exists) economics.set(orderIds[i + index]!, record(doc.data())); });
  }
  return {
    from, to, generatedAt: now,
    orders: ordersSnap.docs.map((doc) => {
      const order = record(doc.data());
      const restaurantId = String(order.restaurantId ?? "");
      const restaurant = restaurants.get(restaurantId) ?? {};
      const econ = economics.get(doc.id) ?? {};
      return {
        orderId: doc.id, createdAt: Number(order.createdAt ?? 0), deliveredAt: Number(order.deliveredAt ?? 0) || null,
        status: String(order.status ?? ""), paymentMethod: String(order.paymentMethod ?? ""), restaurantId,
        storeName: String(restaurant.name ?? order.restaurant ?? restaurantId), storeKind: storeKindOf(restaurant),
        snapshot: (econ.snapshot ?? null) as OrderEconomicsSnapshot | null, orderTax: (econ.orderTax ?? null) as OrderTax | null,
      };
    }),
    withholdings: withholdingSnap.docs.map((doc) => doc.data() as TaxPackWithholding),
    partners: [...restaurants.entries()].map(([restaurantId, restaurant]) => {
      const tax = sellerTaxProfile(profiles.get(restaurantId) ?? {}, "37");
      return {restaurantId, name: String(restaurant.name ?? restaurantId), storeKind: storeKindOf(restaurant), gstin: tax.gstin,
        pan: tax.pan, registrationType: tax.registrationType, entityType: tax.entityType, ecoEnrolmentNo: tax.ecoEnrolmentNo};
    }),
    riders: Object.fromEntries(riderSnap.docs.map((doc) => {
      const rider = record(doc.data());
      return [doc.id, String(rider.fullName ?? rider.name ?? doc.id)];
    })),
    journals: journalSnap.docs.map((doc) => doc.data() as TaxPackJournal),
    riderTdsCredits: riderTdsSnap.docs.map((doc) => doc.data() as TaxPackRiderTdsCredit),
    ...(bankStatementCsv ? {bankStatement: parseBankStatementCsv(bankStatementCsv)} : {}),
  };
}

export interface TaxPackResult {
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
  generatedAt: number;
  summary: {item: string; value: string | number}[];
}

export async function exportTaxPack(uid: string, token: DecodedIdToken, input: {from: number; to: number; bankStatementCsv?: string},
  now = Date.now()): Promise<TaxPackResult> {
  requireOwnerClaim(token);
  if (!(input.to > input.from) || input.to - input.from > MAX_DAYS * 86_400_000) {
    throw new DomainError("invalid-argument", "Choose a period of up to one financial year.");
  }
  const data = await loadTaxPackInput(input.from, input.to, input.bankStatementCsv, firestoreDb, now);
  const sheets = buildTaxPack(data);
  const label = `${new Date(input.from + 19_800_000).toISOString().slice(0, 10)}_to_${new Date(input.to - 1 + 19_800_000).toISOString().slice(0, 10)}`;
  const fileName = `scraveit-tax-pack_${label}.xlsx`;
  const buffer = await taxPackWorkbook(sheets, {generatedAt: now, title: `SCRAVEIT tax pack ${label}`});
  const bucket = storage.bucket();
  const objectPath = `${EXPORT_STORAGE_PREFIX}${uid}/${now}-${fileName}`;
  const downloadToken = randomUUID();
  await bucket.file(objectPath).save(buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    metadata: {cacheControl: "private, max-age=0, no-store", contentDisposition: `attachment; filename="${fileName}"`,
      metadata: {firebaseStorageDownloadTokens: downloadToken}},
  });
  firestoreDb.collection("audit").doc(`tax-pack-${uid}-${now}`).set({action: "tax_pack.generate", actorId: uid,
    actorEmail: String(token.email ?? "").slice(0, 254), from: input.from, to: input.to, at: now}).catch((error) => {
    logger.warn("tax pack audit write failed", {uid, error});
  });
  return {
    downloadUrl: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`,
    fileName, sizeBytes: buffer.length, generatedAt: now,
    summary: sheets[0]!.rows.map((row) => ({item: String(row.item), value: row.value as string | number})),
  };
}
