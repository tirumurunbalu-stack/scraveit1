import type {DecodedIdToken} from "firebase-admin/auth";
import {z} from "zod";
import {firestoreDb} from "../admin";
import {ecomTdsRuleAt, financialYearLabel} from "../domain/taxLaw";
import type {FirestoreLike} from "../firestoreTypes";
import {itemId as weeklyRunItemId} from "./financeAutomation";
import {RESTAURANT_PAYOUT_PROFILES_COLLECTION} from "./restaurantPayoutProfiles";
import {authorizeRestaurantFinanceRead} from "./restaurantSettlements";
import {
  TAX_LAW_DOC,
  TAX_PARTNER_YEARS_COLLECTION,
  TAX_WITHHOLDINGS_COLLECTION,
  normalizeTaxSettings,
  sellerTaxProfile,
} from "./taxEngine";

/**
 * A restaurant's own tax record for the partner dashboard's Finance pages:
 * for each delivered order, the invoice numbers SCRAVEIT issued and the GST
 * TCS and income-tax TDS it withheld; the year's running TDS total; and the
 * recent weekly payout runs (paid, held or blocked, with the reason).
 * Read-only, owners and managers only: the same bar as the settlement summary.
 */

export const RESTAURANT_TAX_STATEMENT_MAX_DAYS = 93;
export const RESTAURANT_TAX_STATEMENT_MAX_ROWS = 5_000;
const PAYOUT_RUNS_SHOWN = 12;
const DAY_MS = 86_400_000;

export const restaurantTaxStatementSchema = z.object({
  restaurantId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  from: z.number().int().positive(),
  to: z.number().int().positive(),
}).strict().refine((value) => value.to > value.from && value.to - value.from <= RESTAURANT_TAX_STATEMENT_MAX_DAYS * DAY_MS,
  "Pick a period of up to three months.");

export type RestaurantTaxStatementInput = z.infer<typeof restaurantTaxStatementSchema>;

export interface RestaurantTaxStatementRow {
  orderId: string;
  recordedAt: number;
  financialYear: string;
  invoices: {invoiceNo: string; kind: string}[];
  gstTcsPaise: number;
  gstTcs: {cgstPaise: number; sgstPaise: number; igstPaise: number; basePaise: number};
  incomeTaxTdsPaise: number;
  incomeTaxTdsBasePaise: number;
  /** Refunded after delivery: TDS already deducted stays; TCS is adjusted in this GST period. */
  reversedAt: number;
  tcsAdjustedPaise: number;
  tcsAdjustedPeriod: string;
}

export interface RestaurantPayoutRun {
  runDayKey: string;
  status: string;
  reason: string;
  amountPaise: number;
  method: string;
  referenceId: string;
  completedAt: number;
}

export interface RestaurantTaxStatement {
  schemaVersion: 1;
  restaurantId: string;
  from: number;
  to: number;
  /** GST is actually charged and invoices are numbered. */
  gstActive: boolean;
  /** Income-tax TDS is actually deducted. */
  tdsActive: boolean;
  /** SCRAVEIT as the supplier on its commission invoices and as the e-commerce operator. */
  issuer: {legalName: string; address: string; gstin: string; pan: string; tan: string; stateCode: string; commissionSac: string};
  /** The restaurant as SCRAVEIT holds it for tax: PAN is masked. */
  seller: {legalName: string; gstin: string; panMasked: string; panFurnished: boolean; registrationType: string;
    entityType: string; stateCode: string};
  rows: RestaurantTaxStatementRow[];
  truncated: boolean;
  year: {financialYear: string; grossPaise: number; tdsDeductedPaise: number; section: string; rateBps: number;
    noPanRateBps: number; individualExemptUptoPaise: number};
  payoutRuns: RestaurantPayoutRun[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function paise(value: unknown): number {
  const amount = Math.round(Number(value ?? 0));
  return Number.isSafeInteger(amount) ? amount : 0;
}

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function maskPan(pan: string): string {
  return pan.length === 10 ? `${pan.slice(0, 5)}XXXX${pan.slice(9)}` : "";
}

function statementRow(id: string, value: unknown): RestaurantTaxStatementRow {
  const entry = record(value);
  const tcs = record(entry.gstTcs);
  const adjustment = record(entry.gstTcsReturnAdjustment);
  return {
    orderId: text(entry.orderId, 128) || id,
    recordedAt: paise(entry.recordedAt),
    financialYear: text(entry.financialYear, 8),
    invoices: (Array.isArray(entry.invoices) ? entry.invoices : []).slice(0, 8).map((invoice) => ({
      invoiceNo: text(record(invoice).invoiceNo, 40),
      kind: text(record(invoice).kind, 40),
    })).filter((invoice) => invoice.invoiceNo),
    gstTcsPaise: paise(entry.gstTcsPaise),
    gstTcs: {cgstPaise: paise(tcs.cgstPaise), sgstPaise: paise(tcs.sgstPaise), igstPaise: paise(tcs.igstPaise), basePaise: paise(tcs.basePaise)},
    incomeTaxTdsPaise: paise(entry.incomeTaxTdsPaise),
    incomeTaxTdsBasePaise: paise(entry.incomeTaxTdsBasePaise),
    reversedAt: paise(entry.reversedAt),
    tcsAdjustedPaise: paise(adjustment.sellerAdjustedTcsPaise),
    tcsAdjustedPeriod: text(adjustment.period, 7),
  };
}

async function recentPayoutRuns(restaurantId: string, database: FirestoreLike): Promise<RestaurantPayoutRun[]> {
  const automation = database.collection("private").doc("financeAutomation");
  const runs = await automation.collection("weeklyRuns").orderBy("attemptedAt", "desc").limit(PAYOUT_RUNS_SHOWN * 2).get();
  const periodKeys = runs.docs.filter((doc) => record(doc.data()).preview !== true).slice(0, PAYOUT_RUNS_SHOWN).map((doc) => doc.id);
  const itemKey = weeklyRunItemId("restaurant", restaurantId);
  const items = await Promise.all(periodKeys.map((periodKey) =>
    automation.collection("weeklyRuns").doc(periodKey).collection("items").doc(itemKey).get().catch(() => null)));
  return items.flatMap((snapshot, index) => {
    if (!snapshot || !snapshot.exists) return [];
    const item = record(snapshot.data());
    if (item.status === "previewed") return [];
    return [{
      runDayKey: periodKeys[index]!,
      status: text(item.status, 40),
      reason: text(item.reason, 300),
      amountPaise: paise(item.amountPaise),
      method: text(item.method, 20),
      referenceId: text(item.referenceId, 120),
      completedAt: paise(item.completedAt),
    }];
  });
}

export async function getRestaurantTaxStatement(
  uid: string,
  token: DecodedIdToken,
  input: RestaurantTaxStatementInput,
  database: FirestoreLike = firestoreDb as unknown as FirestoreLike,
): Promise<RestaurantTaxStatement> {
  const {restaurantId, from, to} = input;
  await authorizeRestaurantFinanceRead(uid, token, restaurantId, database);
  const financialYear = financialYearLabel(to - 1);
  const [lawSnapshot, profileSnapshot, yearSnapshot, page, payoutRuns] = await Promise.all([
    database.collection("private").doc(TAX_LAW_DOC).get().catch(() => null),
    database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId).get().catch(() => null),
    database.collection(TAX_PARTNER_YEARS_COLLECTION).doc(`${restaurantId}_${financialYear}`).get().catch(() => null),
    database.collection(TAX_WITHHOLDINGS_COLLECTION)
      .where("restaurantId", "==", restaurantId)
      .where("recordedAt", ">=", from)
      .where("recordedAt", "<", to)
      .orderBy("recordedAt", "asc")
      .limit(RESTAURANT_TAX_STATEMENT_MAX_ROWS + 1)
      .get(),
    recentPayoutRuns(restaurantId, database).catch(() => []),
  ]);
  const lawDoc = record(lawSnapshot && lawSnapshot.exists ? lawSnapshot.data() : {});
  const settings = normalizeTaxSettings(lawDoc);
  const profileDoc = record(profileSnapshot && profileSnapshot.exists ? profileSnapshot.data() : {});
  const seller = sellerTaxProfile(profileDoc, settings.defaultStateCode);
  const year = record(yearSnapshot && yearSnapshot.exists ? yearSnapshot.data() : {});
  const rule = ecomTdsRuleAt(settings.law, to - 1);
  const sac = text(lawDoc.scraveitCommissionSac, 8);
  return {
    schemaVersion: 1,
    restaurantId,
    from,
    to,
    gstActive: settings.gstActive,
    tdsActive: settings.tdsActive,
    issuer: {
      legalName: text(lawDoc.scraveitLegalName, 160) || "SCRAVEIT PRIVATE LIMITED",
      address: text(lawDoc.scraveitAddress, 300),
      gstin: settings.scraveitGstin,
      pan: settings.scraveitPan,
      tan: settings.scraveitTan,
      stateCode: settings.scraveitGstin.slice(0, 2) || settings.defaultStateCode,
      // Printed on commission invoices only once SCRAVEIT has confirmed it.
      commissionSac: /^[0-9]{4,8}$/.test(sac) ? sac : "",
    },
    seller: {
      legalName: text(profileDoc.legalBusinessName ?? record(profileDoc.payoutProfile).legalBusinessName, 160),
      gstin: seller.gstin,
      panMasked: maskPan(seller.pan),
      panFurnished: seller.panFurnished,
      registrationType: seller.registrationType,
      entityType: seller.entityType,
      stateCode: seller.stateCode,
    },
    rows: page.docs.slice(0, RESTAURANT_TAX_STATEMENT_MAX_ROWS).map((doc) => statementRow(doc.id, doc.data())),
    truncated: page.docs.length > RESTAURANT_TAX_STATEMENT_MAX_ROWS,
    year: {
      financialYear,
      grossPaise: paise(year.grossPaise),
      tdsDeductedPaise: paise(year.tdsDeductedPaise),
      section: rule?.section ?? "",
      rateBps: rule?.rateBps ?? 0,
      noPanRateBps: rule?.noPanRateBps ?? 0,
      individualExemptUptoPaise: rule?.individualExemptUptoPaise ?? 0,
    },
    payoutRuns,
  };
}
