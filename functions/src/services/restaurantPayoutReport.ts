import type {DecodedIdToken} from "firebase-admin/auth";
import {z} from "zod";
import {firestoreDb} from "../admin";
import {financePayoutAutomationSummary} from "../domain/financePolicy";
import type {LedgerJournal} from "../domain/ledger";
import type {FirestoreLike} from "../firestoreTypes";
import {LEDGER_PARTY_JOURNALS_COLLECTION} from "./ledger";
import {loadFinancePolicy} from "./platformConfig";
import {RESTAURANT_PAYOUT_PROFILES_COLLECTION} from "./restaurantPayoutProfiles";
import {authorizeRestaurantFinanceRead} from "./restaurantSettlements";
import {TAX_LAW_DOC, normalizeTaxSettings, sellerTaxProfile} from "./taxEngine";

/**
 * A restaurant's payout report for one period (a week or a month), straight
 * from SCRAVEIT's ledger, so it always adds up to the money that reached the
 * bank:
 *
 *   opening balance (carried from before the period)
 *   + order earnings − TDS/TCS withheld + withholding returned
 *   − customer refunds recovered − ads + ads refunded
 *   + TDS on commission refunded ± other adjustments
 *   − payouts sent (with UTR)
 *   = closing balance (paid on the next payout day)
 *
 * Every line also says which payout paid it: "paid" with the date and UTR,
 * "pending" until the next payout, or "part paid" when a payout covered only
 * some of the balance. A payout pays lines oldest first.
 *
 * The opening balance is worked out from the last payout before the period:
 * a weekly payout sends the whole balance due, so what came after it is what
 * was carried. With no payout in the last six weeks it is summed from the
 * restaurant's first ledger entry when that is within reach, else left out.
 */

const DAY_MS = 86_400_000;
export const RESTAURANT_PAYOUT_REPORT_MAX_DAYS = 35;
const LOOKBACK_MS = 42 * DAY_MS;
const FOLLOW_MS = 21 * DAY_MS;
const MAX_JOURNALS = 25_000;
/** A weekly payout that leaves this little unpaid still counts as paying everything before it. */
const ROUNDING_PAISE = 100;

export const restaurantPayoutReportSchema = z.object({
  restaurantId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/),
  from: z.number().int().positive(),
  to: z.number().int().positive(),
}).strict().refine((value) => value.to > value.from && value.to - value.from <= RESTAURANT_PAYOUT_REPORT_MAX_DAYS * DAY_MS,
  "Pick a period of up to five weeks.");

export type RestaurantPayoutReportInput = z.infer<typeof restaurantPayoutReportSchema>;

export type PayoutLineKind =
  | "order" | "tax_withheld" | "tax_returned" | "refund_recovery" | "ads" | "ads_refund"
  | "tds_commission_refund" | "delivery" | "other";

export interface PayoutSettlementRef {
  status: "paid" | "pending" | "part_paid";
  at: number | null;
  utr: string;
  method: string;
}

export interface PayoutLine {
  journalId: string;
  at: number;
  kind: PayoutLineKind;
  orderId: string;
  /** Positive adds to what SCRAVEIT owes the restaurant, negative takes away. */
  movementPaise: number;
  tdsPaise: number;
  tcsPaise: number;
  paymentMethod: string;
  reason: string;
  reference: string;
  settlement: PayoutSettlementRef;
}

export interface PayoutOrderRow {
  orderId: string;
  at: number;
  paymentMethod: string;
  earningPaise: number;
  tdsPaise: number;
  tcsPaise: number;
  taxReturnedPaise: number;
  refundRecoveredPaise: number;
  deliveryPaise: number;
  otherPaise: number;
  netPaise: number;
  settlement: PayoutSettlementRef;
}

export interface PayoutSent {
  journalId: string;
  at: number;
  amountPaise: number;
  utr: string;
  method: string;
  runDayKey: string;
  /** Lines of this period it paid, and their total. */
  coversLines: number;
  coversPaise: number;
}

type Line = Omit<PayoutLine, "settlement"> & {settledBy: PayoutSent[]; settledPaise: number};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown, max = 300) => String(value ?? "").trim().slice(0, max);
const maskPan = (pan: string) => pan.length === 10 ? `${pan.slice(0, 5)}XXXX${pan.slice(9)}` : "";

function entryTotal(journal: LedgerJournal, accountId: string, side: "debit" | "credit"): number {
  return (journal.entries ?? []).filter((entry) => entry.accountId === accountId && entry.side === side)
    .reduce((sum, entry) => sum + Number(entry.amountPaise || 0), 0);
}

function isPayout(journal: LedgerJournal, debit: number): boolean {
  return journal.eventType === "restaurant_payable" && debit > 0;
}

function lineOf(journal: LedgerJournal, account: string): Line | null {
  const credit = entryTotal(journal, account, "credit"), debit = entryTotal(journal, account, "debit");
  const movementPaise = credit - debit;
  if (!movementPaise) return null;
  const meta = record(journal.metadata), kind = String(meta.adjustmentKind ?? "");
  let lineKind: PayoutLineKind = "other", tdsPaise = 0, tcsPaise = 0;
  if ((journal.eventType === "cod_delivery" || journal.eventType === "payment") && credit > 0) lineKind = "order";
  else if (journal.eventType === "tax_withholding" || journal.eventType === "tax_withholding_reversal") {
    // The seller's TDS has its own account; the rest of what came off (or back) is GST TCS.
    const tdsAccount = "liability:income-tax-tds-payable";
    tdsPaise = journal.eventType === "tax_withholding" ? entryTotal(journal, tdsAccount, "credit") : entryTotal(journal, tdsAccount, "debit");
    tcsPaise = Math.max(0, Math.abs(movementPaise) - tdsPaise);
    lineKind = journal.eventType === "tax_withholding" ? "tax_withheld" : "tax_returned";
  } else if (kind === "restaurant_refund_recovery") lineKind = "refund_recovery";
  else if (kind === "sponsored_listing") lineKind = "ads";
  else if (kind === "sponsored_listing_refund") lineKind = "ads_refund";
  else if (kind === "tds_on_commission_refund") lineKind = "tds_commission_refund";
  else if (journal.eventType === "delivery_settlement" || journal.eventType === "delivery_gst_settlement") lineKind = "delivery";
  const memo = (journal.entries ?? []).find((entry) => entry.accountId === account)?.memo ?? "";
  return {
    journalId: journal.journalId, at: journal.occurredAt, kind: lineKind, orderId: journal.orderId ?? "", movementPaise,
    tdsPaise, tcsPaise,
    paymentMethod: journal.eventType === "cod_delivery" ? "cod" : meta.paymentMethod === "online" ? "online" : "",
    reason: text(meta.reason) || (lineKind === "other" ? text(memo) : ""),
    reference: text(meta.bookingId ?? meta.claimId ?? meta.invoiceNo ?? "", 120),
    settledBy: [], settledPaise: 0,
  };
}

function settlementOf(line: Line): PayoutSettlementRef {
  const last = line.settledBy[line.settledBy.length - 1];
  if (!last) return {status: "pending", at: null, utr: "", method: ""};
  const whole = Math.abs(line.settledPaise) >= Math.abs(line.movementPaise);
  return {status: whole ? "paid" : "part_paid", at: last.at, utr: last.utr, method: last.method};
}

export async function getRestaurantPayoutReport(uid: string, token: DecodedIdToken, input: RestaurantPayoutReportInput,
  database: FirestoreLike = firestoreDb, now = Date.now()) {
  const {restaurantId, from, to} = input;
  await authorizeRestaurantFinanceRead(uid, token, restaurantId, database as never);
  const party = `restaurant:${restaurantId}`, account = `liability:restaurant-payable:${restaurantId}`;
  const windowStart = from - LOOKBACK_MS, windowEnd = Math.min(now, to + FOLLOW_MS) + 1;
  const journalsQuery = database.collection(LEDGER_PARTY_JOURNALS_COLLECTION).where("party", "==", party);
  const [page, older, restaurant, profile, taxLaw, policy] = await Promise.all([
    journalsQuery.where("occurredAt", ">=", windowStart).where("occurredAt", "<", windowEnd)
      .orderBy("occurredAt", "desc").limit(MAX_JOURNALS + 1).get(),
    journalsQuery.where("occurredAt", "<", windowStart).orderBy("occurredAt", "desc").limit(1).get(),
    database.collection("restaurants").doc(restaurantId).get(),
    database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId).get(),
    database.collection("private").doc(TAX_LAW_DOC).get(),
    loadFinancePolicy(now, database).catch(() => null),
  ]);
  const truncated = page.docs.length > MAX_JOURNALS;
  const journals = page.docs.slice(0, MAX_JOURNALS).map((doc) => record(doc.data()).journal as LedgerJournal)
    .filter((journal) => journal && Array.isArray(journal.entries) && Number.isFinite(journal.occurredAt))
    .sort((a, b) => a.occurredAt - b.occurredAt || a.journalId.localeCompare(b.journalId));

  // Opening balance: everything after the last payout before the period.
  const lastPayoutBefore = [...journals].reverse().find((journal) =>
    journal.occurredAt < from && isPayout(journal, entryTotal(journal, account, "debit")));
  const basis: "after_payout" | "from_start" | "unknown" = lastPayoutBefore ? "after_payout" :
    !truncated && older.docs.length === 0 ? "from_start" : "unknown";
  const startAt = lastPayoutBefore ? lastPayoutBefore.occurredAt : -Infinity;

  const lines: Line[] = [], payouts: PayoutSent[] = [];
  let queue: Line[] = [];
  for (const journal of journals) {
    if (journal.occurredAt < startAt || journal === lastPayoutBefore) continue;
    const debit = entryTotal(journal, account, "debit");
    if (isPayout(journal, debit)) {
      const meta = record(journal.metadata);
      const runDayKey = /^settlement:weekly:restaurant:(\d{4}-\d{2}-\d{2}):/.exec(journal.eventId)?.[1] ?? "";
      const payout: PayoutSent = {journalId: journal.journalId, at: journal.occurredAt, amountPaise: debit,
        utr: text(meta.referenceId, 60), method: text(meta.settlementMethod, 30), runDayKey, coversLines: 0, coversPaise: 0};
      payouts.push(payout);
      const due = queue.reduce((sum, line) => sum + line.movementPaise - line.settledPaise, 0);
      // A payout of the whole balance pays every open line; a smaller one pays the oldest first.
      let left = debit >= due - ROUNDING_PAISE ? Infinity : debit, stopped = false;
      const still: Line[] = [];
      for (const line of queue) {
        const open = line.movementPaise - line.settledPaise;
        if (!stopped && (left === Infinity || open <= left)) {
          if (left !== Infinity) left -= open;
          line.settledPaise += open; line.settledBy.push(payout);
        } else {
          // Strictly oldest first: once a line is only part paid, later lines wait for the next payout.
          if (!stopped && left > 0) { line.settledPaise += left; line.settledBy.push(payout); }
          stopped = true; still.push(line);
        }
      }
      queue = still;
      continue;
    }
    const line = lineOf(journal, account);
    if (!line) continue;
    lines.push(line); queue.push(line);
  }

  const inPeriod = (at: number) => at >= from && at < to;
  const periodLines = lines.filter((line) => inPeriod(line.at));
  const openingPaise = basis === "unknown" ? null :
    lines.filter((line) => line.at < from).reduce((sum, line) => sum + line.movementPaise, 0) -
    payouts.filter((payout) => payout.at < from).reduce((sum, payout) => sum + payout.amountPaise, 0);
  for (const line of periodLines) {
    for (const payout of new Set(line.settledBy)) { payout.coversLines += 1; payout.coversPaise += line.movementPaise; }
  }

  const orders = new Map<string, PayoutOrderRow & {lines: Line[]}>();
  for (const line of periodLines) {
    if (!line.orderId) continue;
    const row = orders.get(line.orderId) ?? {orderId: line.orderId, at: line.at, paymentMethod: "", earningPaise: 0, tdsPaise: 0, tcsPaise: 0,
      taxReturnedPaise: 0, refundRecoveredPaise: 0, deliveryPaise: 0, otherPaise: 0, netPaise: 0, settlement: {status: "pending", at: null, utr: "", method: ""}, lines: []};
    row.lines.push(line);
    row.netPaise += line.movementPaise;
    if (line.kind === "order") { row.earningPaise += line.movementPaise; row.paymentMethod = line.paymentMethod; row.at = line.at; }
    else if (line.kind === "tax_withheld") { row.tdsPaise += line.tdsPaise; row.tcsPaise += line.tcsPaise; }
    else if (line.kind === "tax_returned") row.taxReturnedPaise += line.movementPaise;
    else if (line.kind === "refund_recovery") row.refundRecoveredPaise -= line.movementPaise;
    else if (line.kind === "delivery") row.deliveryPaise += line.movementPaise;
    else row.otherPaise += line.movementPaise;
    orders.set(line.orderId, row);
  }
  const orderRows: PayoutOrderRow[] = [...orders.values()].map(({lines: own, ...row}) => {
    const states = own.map(settlementOf), paid = states.filter((s) => s.status === "paid");
    const latest = states.filter((s) => s.at).sort((a, b) => Number(b.at) - Number(a.at))[0];
    return {...row, settlement: paid.length === states.length ? latest! :
      latest ? {...latest, status: "part_paid" as const} : {status: "pending" as const, at: null, utr: "", method: ""}};
  }).sort((a, b) => a.at - b.at);

  const totals: Record<PayoutLineKind, {count: number; paise: number}> = {order: {count: 0, paise: 0}, tax_withheld: {count: 0, paise: 0},
    tax_returned: {count: 0, paise: 0}, refund_recovery: {count: 0, paise: 0}, ads: {count: 0, paise: 0}, ads_refund: {count: 0, paise: 0},
    tds_commission_refund: {count: 0, paise: 0}, delivery: {count: 0, paise: 0}, other: {count: 0, paise: 0}};
  let tdsPaise = 0, tcsPaise = 0;
  for (const line of periodLines) {
    totals[line.kind].count += 1; totals[line.kind].paise += line.movementPaise;
    if (line.kind === "tax_withheld") { tdsPaise += line.tdsPaise; tcsPaise += line.tcsPaise; }
  }
  const periodNetPaise = periodLines.reduce((sum, line) => sum + line.movementPaise, 0);
  const paidInPeriod = payouts.filter((payout) => inPeriod(payout.at));
  const paidOutPaise = paidInPeriod.reduce((sum, payout) => sum + payout.amountPaise, 0);
  const settledPaise = periodLines.reduce((sum, line) => sum + line.settledPaise, 0);

  const store = record(restaurant.exists ? restaurant.data() : {}), payoutProfile = record(profile.exists ? profile.data() : {});
  const lawDoc = record(taxLaw.exists ? taxLaw.data() : {}), tax = normalizeTaxSettings(lawDoc);
  const seller = sellerTaxProfile(payoutProfile, tax.defaultStateCode), taxProfile = record(payoutProfile.taxProfile);
  const acct = text(payoutProfile.bankAccountNumber, 40).replace(/\s/g, "");
  const automation = policy ? financePayoutAutomationSummary(policy, now) : null;

  return {
    schemaVersion: 1 as const,
    restaurantId, from, to, generatedAt: now, truncated,
    restaurant: {
      name: text(store.name, 160),
      legalName: text(payoutProfile.legalBusinessName, 160),
      address: [store.address, store.area, store.city].map((part) => text(part, 160)).filter(Boolean).join(", "),
      gstin: seller.gstin, panMasked: maskPan(seller.pan), panFurnished: seller.panFurnished,
      tan: text(taxProfile.tan, 10).toUpperCase(), entityType: seller.entityType, registrationType: seller.registrationType,
      stateCode: seller.stateCode, fssai: text(store.fssaiNumber, 20),
      payoutTo: acct ? `${text(payoutProfile.bankName, 60) || "Bank"} ••••${acct.slice(-4)}` : text(payoutProfile.upiId, 80) ? `UPI ${text(payoutProfile.upiId, 80)}` : "",
      ifsc: text(payoutProfile.bankIfsc, 11),
    },
    scraveit: {
      legalName: text(lawDoc.scraveitLegalName, 160) || "SCRAVEIT PRIVATE LIMITED",
      address: text(lawDoc.scraveitAddress, 300),
      gstin: tax.scraveitGstin,
      tcsGstin: text(lawDoc.scraveitTcsGstin, 15).toUpperCase(),
      pan: tax.scraveitPan, tan: tax.scraveitTan,
      stateCode: tax.scraveitGstin.slice(0, 2) || tax.defaultStateCode,
    },
    schedule: automation ? {label: automation.scheduleLabel, nextRunDayKey: automation.nextRunDayKey,
      minimumPaise: automation.minimumRestaurantSettlementPaise} : null,
    opening: {basis, balancePaise: openingPaise},
    totals, tdsPaise, tcsPaise, periodNetPaise, paidOutPaise,
    closingPaise: openingPaise === null ? null : openingPaise + periodNetPaise - paidOutPaise,
    /** Of the period's own lines: already paid, and still to be paid. */
    settledPaise, pendingPaise: periodNetPaise - settledPaise,
    orders: orderRows,
    adjustments: periodLines.filter((line) => !line.orderId || !["order", "tax_withheld", "tax_returned"].includes(line.kind))
      .map((line): PayoutLine => ({...Object.fromEntries(Object.entries(line).filter(([key]) => key !== "settledBy" && key !== "settledPaise")) as Omit<PayoutLine, "settlement">,
        settlement: settlementOf(line)})),
    payouts: payouts.filter((payout) => inPeriod(payout.at) || payout.coversLines > 0),
  };
}
