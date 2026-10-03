import type {DeliverySupplierSettlement} from "./deliverySupplierSettlement";
import ExcelJS from "exceljs";
import type {OrderEconomicsSnapshot} from "./economics";
import type {OrderTax} from "./orderTax";

/**
 * The tax pack: one workbook a chartered accountant can file from, built only
 * from the immutable ledger, each order's economics snapshot and its tax
 * breakdown. Every amount is in rupees; every sheet's totals foot, and the
 * Summary sheet carries the cross-checks (they must all read 0.00).
 */

export interface TaxPackOrder {
  orderId: string;
  createdAt: number;
  deliveredAt: number | null;
  status: string;
  paymentMethod: string;
  restaurantId: string;
  storeName: string;
  storeKind: string;
  snapshot: OrderEconomicsSnapshot | null;
  orderTax: OrderTax | null;
}

export interface TaxPackWithholding {
  orderId: string;
  restaurantId: string;
  financialYear: string;
  gstTcsPaise: number;
  gstTcs: {cgstPaise: number; sgstPaise: number; igstPaise: number; basePaise: number};
  incomeTaxTdsPaise: number;
  incomeTaxTdsBasePaise: number;
  incomeTaxTdsCatchUpBasePaise: number;
  invoices: {series: string; invoiceNo: string; kind: string}[];
  recordedAt: number;
  reversedAt?: number;
  /** Local delivery GST settled once the rider was known (0 when a registered rider charges it). */
  taxHeads?: {local_delivery_gst_9_5: number};
  deliverySettlement?: DeliverySupplierSettlement;
  riderEcommerceTds?: {riderId: string; tdsPaise: number; rateBps: number; basePaise: number};
}

export interface TaxPackPartner {
  restaurantId: string;
  name: string;
  storeKind: string;
  gstin: string;
  pan: string;
  registrationType: string;
  entityType: string;
  ecoEnrolmentNo: string;
}

export interface TaxPackJournal {
  journalId: string;
  eventType: string;
  occurredAt: number;
  orderId?: string;
  metadata?: Record<string, unknown>;
  entries: readonly {accountId: string; side: "debit" | "credit"; amountPaise: number}[];
}

export interface BankStatementLine {
  date: string;
  amountPaise: number;
  reference: string;
  narration: string;
}

export interface TaxPackInput {
  from: number;
  to: number;
  generatedAt: number;
  orders: readonly TaxPackOrder[];
  withholdings: readonly TaxPackWithholding[];
  partners: readonly TaxPackPartner[];
  riders: Readonly<Record<string, string>>;
  journals: readonly TaxPackJournal[];
  /** Rider contractor TDS worked out on each earnings credit in the period. */
  riderTdsCredits?: readonly TaxPackRiderTdsCredit[];
  bankStatement?: readonly BankStatementLine[];
}

export interface TaxPackRiderTdsCredit {
  riderId: string;
  component?: string;
  legalEntityType?: string;
  panVerified?: boolean;
  entityPanMismatch?: boolean;
  tipTdsTreatment?: string;
  financialYear: string;
  occurredAt: number;
  creditPaise: number;
  classification: string;
  section: string;
  pan: string;
  rateBps: number;
  tdsPaise: number;
}

type Cell = string | number;
export interface PackSheet {
  name: string;
  columns: {header: string; key: string; width?: number; money?: boolean}[];
  rows: Record<string, Cell>[];
}

const rupees = (paise: number) => Math.round(Number(paise) || 0) / 100;
const ist = (at: number | null | undefined) => at ? new Date(at + 5.5 * 3_600_000).toISOString().replace("T", " ").slice(0, 16) : "";
const istDate = (at: number) => ist(at).slice(0, 10);
const month = (at: number) => ist(at).slice(0, 7);
function weekOf(at: number): string {
  const day = new Date(at + 5.5 * 3_600_000);
  const monday = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - ((day.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}

function sumBy<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((sum, item) => sum + (Number(value(item)) || 0), 0);
}

function serviceGst(tax: OrderTax | null, component: string): number {
  return tax ? sumBy(tax.services.filter((line) => line.component === component), (line) => line.gstPaise) : 0;
}

/** What SCRAVEIT itself earns on an order (before its running costs). */
export function scraveitIncome(snapshot: OrderEconomicsSnapshot) {
  const customer = snapshot.customer;
  const restaurant = snapshot.restaurant;
  const rider = snapshot.rider;
  const riderFeeShare = rider.feeSharePaise ?? 0;
  const surge = customer.riderSurgeFeePaise ?? 0;
  return {
    commissionPaise: restaurant.commissionPaise,
    platformFeePaise: customer.platformFeePaise,
    smallOrderFeePaise: customer.smallOrderFeePaise,
    deliveryMarginPaise: customer.deliveryFeePaise - rider.deliveryPayPaise,
    lateNightMarginPaise: customer.lateNightFeePaise + customer.riderIncentiveFeePaise - rider.incentivePayPaise,
    rainAndSurgeSharePaise: customer.rainFeePaise + surge - riderFeeShare,
    kitchenFeeSharePaise: customer.surgeFeePaise - (restaurant.rushFeeSharePaise ?? 0),
    discountsFundedPaise: customer.platformDiscountPaise + (customer.walletRedeemPaise ?? 0),
  };
}

export function buildTaxPack(input: TaxPackInput): PackSheet[] {
  const partners = new Map(input.partners.map((partner) => [partner.restaurantId, partner]));
  const withholdings = new Map(input.withholdings.map((entry) => [entry.orderId, entry]));
  const delivered = input.orders.filter((order) => order.status === "Delivered" && order.snapshot);

  const sales: PackSheet = {name: "Sales register", columns: [
    {header: "Delivered (IST)", key: "date", width: 18}, {header: "Order", key: "orderId", width: 24},
    {header: "Invoices", key: "invoices", width: 40}, {header: "Store", key: "store", width: 26}, {header: "Type", key: "kind", width: 11},
    {header: "Payment", key: "payment", width: 10}, {header: "Items", key: "items", money: true},
    {header: "Store's offer", key: "sellerOffer", money: true}, {header: "Scraveit coupon", key: "platformOffer", money: true},
    {header: "Delivery fee", key: "delivery", money: true}, {header: "Platform fee", key: "platform", money: true},
    {header: "Small-order fee", key: "small", money: true}, {header: "Late-night / early fee", key: "lateNight", money: true},
    {header: "Rain fee", key: "rain", money: true}, {header: "Busy-kitchen fee", key: "kitchen", money: true},
    {header: "Rider surge fee", key: "riderSurge", money: true}, {header: "GST charged", key: "gst", money: true},
    {header: "Tip", key: "tip", money: true}, {header: "Wallet used", key: "wallet", money: true}, {header: "Customer paid", key: "paid", money: true},
  ], rows: []};
  const income: PackSheet = {name: "Scraveit income & GST", columns: [
    {header: "Delivered (IST)", key: "date", width: 18}, {header: "Order", key: "orderId", width: 24}, {header: "Type", key: "kind", width: 11},
    {header: "Commission", key: "commission", money: true}, {header: "Platform fee", key: "platform", money: true},
    {header: "Small-order fee", key: "small", money: true}, {header: "Delivery margin", key: "deliveryMargin", money: true},
    {header: "Late-night margin", key: "lateNight", money: true}, {header: "Rain & surge share", key: "rainSurge", money: true},
    {header: "Kitchen-fee share", key: "kitchen", money: true}, {header: "Coupons & wallet paid", key: "discounts", money: true},
    {header: "Net income", key: "net", money: true}, {header: "GST 9(5) restaurant", key: "gstRestaurant", money: true},
    {header: "GST 9(5) delivery", key: "gstDelivery", money: true}, {header: "GST own services", key: "gstServices", money: true},
    {header: "GST on commission", key: "gstCommission", money: true},
  ], rows: []};
  const balanceChecks: number[] = [];

  for (const order of delivered.sort((a, b) => (a.deliveredAt ?? 0) - (b.deliveredAt ?? 0))) {
    const s = order.snapshot!;
    const c = s.customer;
    const tax = order.orderTax;
    const invoiceNos = (withholdings.get(order.orderId)?.invoices ?? []).map((invoice) => invoice.invoiceNo).join(", ");
    sales.rows.push({
      date: ist(order.deliveredAt), orderId: order.orderId, invoices: invoiceNos, store: order.storeName, kind: order.storeKind,
      payment: order.paymentMethod.toUpperCase(), items: rupees(c.itemSubtotalPaise), sellerOffer: rupees(c.restaurantDiscountPaise),
      platformOffer: rupees(c.platformDiscountPaise), delivery: rupees(c.deliveryFeePaise), platform: rupees(c.platformFeePaise),
      small: rupees(c.smallOrderFeePaise), lateNight: rupees(c.lateNightFeePaise + c.riderIncentiveFeePaise),
      rain: rupees(c.rainFeePaise), kitchen: rupees(c.surgeFeePaise), riderSurge: rupees(c.riderSurgeFeePaise ?? 0),
      gst: rupees(c.taxPaise), tip: rupees(c.tipPaise), wallet: rupees(c.walletRedeemPaise ?? 0), paid: rupees(c.payablePaise),
    });
    const earn = scraveitIncome(s);
    const net = earn.commissionPaise + earn.platformFeePaise + earn.smallOrderFeePaise + earn.deliveryMarginPaise +
      earn.lateNightMarginPaise + earn.rainAndSurgeSharePaise + earn.kitchenFeeSharePaise - earn.discountsFundedPaise;
    income.rows.push({
      date: ist(order.deliveredAt), orderId: order.orderId, kind: order.storeKind,
      commission: rupees(earn.commissionPaise), platform: rupees(earn.platformFeePaise), small: rupees(earn.smallOrderFeePaise),
      deliveryMargin: rupees(earn.deliveryMarginPaise), lateNight: rupees(earn.lateNightMarginPaise),
      rainSurge: rupees(earn.rainAndSurgeSharePaise), kitchen: rupees(earn.kitchenFeeSharePaise),
      discounts: rupees(-earn.discountsFundedPaise), net: rupees(net),
      gstRestaurant: rupees(serviceGst(tax, "restaurant_service")), gstDelivery: rupees(withholdings.get(order.orderId)?.taxHeads?.local_delivery_gst_9_5 ?? serviceGst(tax, "delivery_fee")),
      gstServices: rupees(tax ? sumBy(tax.services.filter((line) => line.supplier === "scraveit" && line.chargedTo === "customer" &&
        line.component !== "delivery_fee"),
        (line) => line.gstPaise) : 0),
      gstCommission: rupees(serviceGst(tax, "commission")),
    });
    // Every rupee the customer (and Scraveit's coupons/wallet) paid lands with
    // the restaurant, the rider, the tax authority or Scraveit.
    const sources = c.payablePaise + c.platformDiscountPaise + (c.walletRedeemPaise ?? 0);
    const destinations = s.restaurant.receivablePaise + (s.restaurant.commissionTaxPaise ?? 0) + s.rider.totalPaise + c.taxPaise +
      (net + earn.discountsFundedPaise);
    balanceChecks.push(sources - destinations);
  }

  // Seller-wise goods GST and Section 52 TCS by month (feeds GSTR-8).
  const sellerMonths = new Map<string, Record<string, Cell>>();
  for (const order of delivered) {
    const tax = order.orderTax;
    if (!tax || tax.storeKind === "restaurant") continue;
    const w = withholdings.get(order.orderId);
    const partner = partners.get(order.restaurantId);
    const key = `${month(order.deliveredAt ?? order.createdAt)}|${order.restaurantId}`;
    const row = sellerMonths.get(key) ?? {month: month(order.deliveredAt ?? order.createdAt), store: order.storeName,
      gstin: partner?.gstin ?? "", registration: partner?.registrationType ?? "", enrolment: partner?.ecoEnrolmentNo ?? "",
      taxable: 0, exempt: 0, cgst: 0, sgst: 0, igst: 0, tcsBase: 0, tcsCgst: 0, tcsSgst: 0, tcsIgst: 0, returns: 0, orders: 0};
    const reversed = Boolean(w?.reversedAt);
    const add = (field: string, paise: number) => { row[field] = Math.round(((row[field] as number) + rupees(paise)) * 100) / 100; };
    if (reversed) add("returns", tax.goodsGst.taxableValuePaise);
    else {
      add("taxable", tax.goodsGst.taxableValuePaise); add("exempt", tax.goodsGst.exemptValuePaise);
      add("cgst", tax.goodsGst.cgstPaise); add("sgst", tax.goodsGst.sgstPaise); add("igst", tax.goodsGst.igstPaise);
      if (w) { add("tcsBase", w.gstTcs.basePaise); add("tcsCgst", w.gstTcs.cgstPaise); add("tcsSgst", w.gstTcs.sgstPaise); add("tcsIgst", w.gstTcs.igstPaise); }
    }
    row.orders = (row.orders as number) + 1;
    sellerMonths.set(key, row);
  }
  const sellerGst: PackSheet = {name: "Seller GST & TCS", columns: [
    {header: "Month", key: "month", width: 10}, {header: "Store", key: "store", width: 26}, {header: "GSTIN", key: "gstin", width: 18},
    {header: "Registration", key: "registration", width: 16}, {header: "Enrolment no. (34/2023)", key: "enrolment", width: 18},
    {header: "Orders", key: "orders", width: 8}, {header: "Taxable value", key: "taxable", money: true}, {header: "Nil / exempt value", key: "exempt", money: true},
    {header: "CGST", key: "cgst", money: true}, {header: "SGST", key: "sgst", money: true}, {header: "IGST", key: "igst", money: true},
    {header: "Returns (taxable)", key: "returns", money: true}, {header: "TCS base (net)", key: "tcsBase", money: true},
    {header: "TCS CGST", key: "tcsCgst", money: true}, {header: "TCS SGST", key: "tcsSgst", money: true}, {header: "TCS IGST", key: "tcsIgst", money: true},
  ], rows: [...sellerMonths.values()]};

  // Income-tax e-commerce TDS by seller and financial year.
  const tdsBySeller = new Map<string, Record<string, Cell>>();
  for (const w of input.withholdings) {
    if (w.recordedAt < input.from || w.recordedAt >= input.to) continue;
    const partner = partners.get(w.restaurantId);
    const key = `${w.financialYear}|${w.restaurantId}`;
    const row = tdsBySeller.get(key) ?? {fy: w.financialYear, store: partner?.name ?? w.restaurantId, pan: partner?.pan ?? "",
      entity: partner?.entityType ?? "", gross: 0, tds: 0, catchUp: 0, reversedTds: 0};
    const add = (field: string, paise: number) => { row[field] = Math.round(((row[field] as number) + rupees(paise)) * 100) / 100; };
    add("gross", w.reversedAt ? 0 : w.incomeTaxTdsBasePaise);
    add(w.reversedAt ? "reversedTds" : "tds", w.incomeTaxTdsPaise);
    add("catchUp", w.incomeTaxTdsCatchUpBasePaise);
    tdsBySeller.set(key, row);
  }
  const tds: PackSheet = {name: "TDS register", columns: [
    {header: "Financial year", key: "fy", width: 12}, {header: "Store", key: "store", width: 26}, {header: "PAN", key: "pan", width: 12},
    {header: "Business type", key: "entity", width: 14}, {header: "Gross sales (TDS base)", key: "gross", money: true},
    {header: "Earlier sales caught up", key: "catchUp", money: true}, {header: "TDS withheld", key: "tds", money: true},
    {header: "TDS returned on refunds", key: "reversedTds", money: true},
  ], rows: [...tdsBySeller.values()]};

  // Money movements from the ledger.
  const inPeriod = input.journals.filter((journal) => journal.occurredAt >= input.from && journal.occurredAt < input.to);
  const partnerWeeks = new Map<string, Record<string, Cell>>();
  const payoutRows: {date: string; payee: string; amountPaise: number; reference: string; method: string}[] = [];
  const riderRows: Record<string, Cell>[] = [];
  const codRows: Record<string, Cell>[] = [];
  const refundRows: Record<string, Cell>[] = [];
  for (const journal of inPeriod) {
    for (const entry of journal.entries) {
      const match = /^liability:restaurant-payable:(.+)$/.exec(entry.accountId);
      if (!match) continue;
      const restaurantId = match[1]!;
      const key = `${weekOf(journal.occurredAt)}|${restaurantId}`;
      const row = partnerWeeks.get(key) ?? {week: weekOf(journal.occurredAt), store: partners.get(restaurantId)?.name ?? restaurantId,
        earned: 0, withheld: 0, paid: 0, other: 0, references: ""};
      const amount = rupees(entry.side === "credit" ? entry.amountPaise : -entry.amountPaise);
      const field = journal.eventType === "restaurant_payable" && entry.side === "debit" ? "paid" :
        journal.eventType === "tax_withholding" || journal.eventType === "tax_withholding_reversal" ? "withheld" :
        entry.side === "credit" ? "earned" : "other";
      row[field] = Math.round(((row[field] as number) + amount) * 100) / 100;
      if (field === "paid") {
        const reference = String(journal.metadata?.referenceId ?? "");
        row.references = [row.references, reference].filter(Boolean).join(", ");
        payoutRows.push({date: istDate(journal.occurredAt), payee: `Store: ${partners.get(restaurantId)?.name ?? restaurantId}`,
          amountPaise: entry.amountPaise, reference, method: String(journal.metadata?.settlementMethod ?? "")});
      }
      partnerWeeks.set(key, row);
    }
    if (journal.eventType === "rider_payout") {
      const riderId = String(journal.metadata?.riderId ?? "");
      const amount = sumBy(journal.entries.filter((entry) => entry.side === "debit"), (entry) => entry.amountPaise);
      const reference = String(journal.metadata?.referenceId ?? "");
      riderRows.push({date: istDate(journal.occurredAt), rider: input.riders[riderId] ?? riderId, amount: rupees(amount), reference,
        method: String(journal.metadata?.payoutMethod ?? "")});
      payoutRows.push({date: istDate(journal.occurredAt), payee: `Rider: ${input.riders[riderId] ?? riderId}`, amountPaise: amount, reference,
        method: String(journal.metadata?.payoutMethod ?? "")});
    }
    if (journal.eventType === "cod_delivery" || journal.eventType === "cod_remittance") {
      const riderId = String(journal.metadata?.riderId ?? "");
      const amount = sumBy(journal.entries.filter((entry) => entry.side === "debit"), (entry) => entry.amountPaise);
      codRows.push({date: ist(journal.occurredAt), rider: input.riders[riderId] ?? riderId, order: journal.orderId ?? "",
        kind: journal.eventType === "cod_delivery" ? "Cash collected" : "Cash deposited", amount: rupees(amount),
        reference: String(journal.metadata?.referenceId ?? "")});
    }
    if (journal.eventType === "refund") {
      const amount = sumBy(journal.entries.filter((entry) => entry.side === "debit"), (entry) => entry.amountPaise);
      refundRows.push({date: ist(journal.occurredAt), order: journal.orderId ?? "", amount: rupees(amount),
        reference: String(journal.metadata?.providerTransactionId ?? "")});
    }
  }
  const partnerSheet: PackSheet = {name: "Partner settlements", columns: [
    {header: "Week from", key: "week", width: 12}, {header: "Store", key: "store", width: 26}, {header: "Earned", key: "earned", money: true},
    {header: "GST TCS + TDS withheld", key: "withheld", money: true}, {header: "Other adjustments", key: "other", money: true},
    {header: "Paid out", key: "paid", money: true}, {header: "Bank references (UTR)", key: "references", width: 30},
  ], rows: [...partnerWeeks.values()].sort((a, b) => String(a.week).localeCompare(String(b.week)))};
  const riderSheet: PackSheet = {name: "Rider payouts", columns: [
    {header: "Date", key: "date", width: 12}, {header: "Rider", key: "rider", width: 24}, {header: "Amount", key: "amount", money: true},
    {header: "Method", key: "method", width: 10}, {header: "Bank reference (UTR)", key: "reference", width: 24},
  ], rows: riderRows};
  const codSheet: PackSheet = {name: "Cash on delivery", columns: [
    {header: "When (IST)", key: "date", width: 18}, {header: "Rider", key: "rider", width: 24}, {header: "Order", key: "order", width: 24},
    {header: "What", key: "kind", width: 16}, {header: "Amount", key: "amount", money: true}, {header: "Reference", key: "reference", width: 20},
  ], rows: codRows};
  const refundSheet: PackSheet = {name: "Refunds", columns: [
    {header: "When (IST)", key: "date", width: 18}, {header: "Order", key: "order", width: 24}, {header: "Amount", key: "amount", money: true},
    {header: "Gateway reference", key: "reference", width: 26},
  ], rows: refundRows};
  const invoices: PackSheet = {name: "Invoices", columns: [
    {header: "Invoice no.", key: "invoiceNo", width: 26}, {header: "Kind", key: "kind", width: 26}, {header: "Issued by", key: "issuer", width: 28},
    {header: "Order", key: "orderId", width: 24}, {header: "Date (IST)", key: "date", width: 18}, {header: "Cancelled by refund", key: "reversed", width: 12},
  ], rows: input.withholdings.filter((w) => w.recordedAt >= input.from && w.recordedAt < input.to).flatMap((w) => w.invoices.map((invoice) => ({
    invoiceNo: invoice.invoiceNo,
    kind: {seller_goods: "Seller's goods invoice", restaurant_service_9_5: "Restaurant service u/s 9(5)",
      scraveit_customer_services: "Scraveit fees to customer", scraveit_commission: "Scraveit commission to store"}[invoice.kind] ?? invoice.kind,
    issuer: invoice.kind === "seller_goods" ? `${partners.get(w.restaurantId)?.name ?? w.restaurantId} (on its behalf)` : "SCRAVEIT PRIVATE LIMITED",
    orderId: w.orderId, date: ist(w.recordedAt), reversed: w.reversedAt ? "Yes" : "",
  })))};

  // Bank match: every payout against the uploaded bank statement.
  const bank = (input.bankStatement ?? []).map((line, index) => ({...line, index, used: false}));
  const matchRows: Record<string, Cell>[] = payoutRows.map((payout) => {
    const ref = String(payout.reference).trim().toLowerCase();
    let hit = ref ? bank.find((line) => !line.used && line.reference.trim().toLowerCase() === ref) : undefined;
    if (!hit) hit = bank.find((line) => !line.used && line.amountPaise === payout.amountPaise &&
      Math.abs(Date.parse(line.date) - Date.parse(String(payout.date))) <= 3 * 86_400_000);
    if (hit) hit.used = true;
    const status = !input.bankStatement ? "No bank statement uploaded" : !hit ? "Missing in bank statement" :
      hit.amountPaise !== payout.amountPaise ? "Amount differs" : "Matched";
    return {date: payout.date, payee: payout.payee, amount: rupees(Number(payout.amountPaise)), reference: payout.reference,
      bankDate: hit?.date ?? "", bankAmount: hit ? rupees(hit.amountPaise) : "", status};
  });
  for (const line of bank.filter((entry) => !entry.used)) {
    matchRows.push({date: "", payee: line.narration, amount: "", reference: line.reference, bankDate: line.date,
      bankAmount: rupees(line.amountPaise), status: "In bank statement, not in Scraveit records"});
  }
  const bankSheet: PackSheet = {name: "Bank match", columns: [
    {header: "Payout date", key: "date", width: 12}, {header: "Paid to", key: "payee", width: 30}, {header: "Amount", key: "amount", money: true},
    {header: "Reference (UTR)", key: "reference", width: 24}, {header: "Bank date", key: "bankDate", width: 12},
    {header: "Bank amount", key: "bankAmount", money: true}, {header: "Status", key: "status", width: 34},
  ], rows: matchRows};

  const total = (sheet: PackSheet, key: string) => Math.round(sumBy(sheet.rows, (row) => Number(row[key]) || 0) * 100) / 100;
  const tdsTotal = total(tds, "tds") - total(tds, "reversedTds");
  // Rider contractor TDS, by rider (base excludes customer tips).
  const riderTdsByRider = new Map<string, Record<string, Cell>>();
  for (const credit of input.riderTdsCredits ?? []) {
    const key = `${credit.riderId}|${credit.financialYear}`;
    const row = riderTdsByRider.get(key) ?? {rider: input.riders[credit.riderId] ?? credit.riderId, pan: credit.pan || "Not furnished",
      entity: credit.legalEntityType ?? "", panVerified: credit.panVerified ? "Yes" : "No", flags: "",
      classification: credit.classification, section: credit.section, year: credit.financialYear, rate: "", credited: 0, tips: 0,
      tipTreatment: credit.tipTdsTreatment ?? "", tds: 0};
    const field = credit.component === "customer_tip" ? "tips" : "credited";
    row[field] = Math.round(((row[field] as number) + credit.creditPaise / 100) * 100) / 100;
    if (credit.entityPanMismatch) row.flags = "Entity type and PAN disagree: higher rate applied";
    if (credit.tipTdsTreatment) row.tipTreatment = credit.tipTdsTreatment;
    row.tds = Math.round(((row.tds as number) + credit.tdsPaise / 100) * 100) / 100;
    if (credit.rateBps > 0) row.rate = `${credit.rateBps / 100}%`;
    if (credit.pan) row.pan = credit.pan;
    riderTdsByRider.set(key, row);
  }
  const riderTdsSheet: PackSheet = {name: "Rider contractor TDS", columns: [
    {header: "Rider", key: "rider", width: 24}, {header: "PAN", key: "pan", width: 14}, {header: "PAN verified", key: "panVerified", width: 10},
    {header: "Legal entity", key: "entity", width: 12}, {header: "Classification", key: "classification", width: 14},
    {header: "Section", key: "section", width: 36}, {header: "FY", key: "year", width: 8}, {header: "Rate", key: "rate", width: 8},
    {header: "Earnings credited", key: "credited", money: true}, {header: "Customer tips credited", key: "tips", money: true},
    {header: "Tips TDS treatment", key: "tipTreatment", width: 16}, {header: "TDS deducted", key: "tds", money: true},
    {header: "Flags", key: "flags", width: 40},
  ], rows: [...riderTdsByRider.values()].sort((a, b) => String(a.rider).localeCompare(String(b.rider)))};
  // Every delivery's settlement with its supplier: gross consideration, GST, TCS, TDS, SCRAVEIT's explicit fee, net.
  const settled = input.withholdings.filter((entry) => entry.deliverySettlement && !entry.reversedAt);
  const deliverySettlementSheet: PackSheet = {name: "Delivery settlements", columns: [
    {header: "Order", key: "order", width: 22}, {header: "Supplier", key: "supplier", width: 10}, {header: "Supplier name", key: "name", width: 22},
    {header: "Gross consideration", key: "gross", money: true}, {header: "of which delivery fee", key: "fee", money: true},
    {header: "Surge", key: "surge", money: true}, {header: "Rain", key: "rain", money: true}, {header: "Late night", key: "late", money: true},
    {header: "GST collected for supplier", key: "gstSupplier", money: true}, {header: "GST 9(5) paid by Scraveit", key: "gst95", money: true},
    {header: "GST TCS u/s 52", key: "tcs", money: true}, {header: "Rider e-commerce TDS", key: "ecomTds", money: true},
    {header: "Rider contractor TDS", key: "contractorTds", money: true}, {header: "Store TDS", key: "storeTds", money: true},
    {header: "Scraveit platform fee", key: "platformFee", money: true}, {header: "GST on platform fee", key: "platformFeeGst", money: true},
    {header: "Fee SAC", key: "sac", width: 8}, {header: "Operational pay", key: "pay", money: true},
    {header: "Bonuses / adjustments", key: "adj", money: true}, {header: "Net settlement", key: "net", money: true},
  ], rows: settled.map((entry) => {
    const d = entry.deliverySettlement!;
    return {order: entry.orderId, supplier: d.delivery_service_supplier,
      name: d.delivery_service_supplier === "RESTAURANT" ? partners.get(d.supplier_id)?.name ?? d.supplier_id : input.riders[d.supplier_id] ?? d.supplier_id,
      gross: rupees(d.delivery_gross_consideration), fee: rupees(d.delivery_fee), surge: rupees(d.delivery_surge),
      rain: rupees(d.rain_delivery_amount), late: rupees(d.late_night_delivery_amount),
      gstSupplier: rupees(d.delivery_gst_collected_for_supplier), gst95: rupees(d.delivery_gst_9_5_paid_by_scraveit),
      tcs: rupees(d.delivery_supplier_gst_tcs), ecomTds: rupees(d.rider_ecommerce_tds), contractorTds: rupees(d.rider_contractor_tds),
      storeTds: rupees(d.store_delivery_tds), platformFee: rupees(d.scraveit_rider_platform_fee),
      platformFeeGst: rupees(d.scraveit_rider_platform_fee_gst), sac: d.scraveit_rider_platform_fee_sac || "pending",
      pay: rupees(d.operational_pay), adj: rupees(d.bonuses_adjustments), net: rupees(d.delivery_supplier_net_settlement)};
  })};
  const productGst = sumBy(delivered, (order) => order.orderTax?.goodsGst.totalPaise ?? 0) / 100;

  const summary: PackSheet = {name: "Summary", columns: [
    {header: "Item", key: "item", width: 48}, {header: "Amount (₹)", key: "value", money: true}, {header: "Note", key: "note", width: 60},
  ], rows: [
    {item: "Period", value: "", note: `${istDate(input.from)} to ${istDate(input.to - 1)} (IST)`},
    {item: "Delivered orders", value: delivered.length, note: ""},
    {item: "Customers paid", value: total(sales, "paid"), note: "Sales register"},
    {item: "Scraveit net income (before running costs)", value: total(income, "net"), note: "Scraveit income & GST"},
    {item: "GST payable by Scraveit: restaurant service u/s 9(5)", value: total(income, "gstRestaurant"), note: "restaurant_gst_9_5 · GSTR-1 / GSTR-3B"},
    {item: "GST payable by Scraveit: delivery u/s 9(5)", value: total(income, "gstDelivery"), note: "local_delivery_gst_9_5 · GSTR-1 / GSTR-3B"},
    {item: "GST payable by Scraveit: own services to customers", value: total(income, "gstServices"), note: "scraveit_service_gst · GSTR-1 / GSTR-3B"},
    {item: "GST payable by Scraveit: commission to stores", value: total(income, "gstCommission"), note: "scraveit_service_gst · B2B invoices"},
    {item: "Product GST inside shelf prices (owed by the sellers)", value: Math.round(productGst * 100) / 100, note: "product_gst · seller's own returns, not Scraveit's"},
    {item: "GST TCS collected u/s 52", value: Math.round((total(sellerGst, "tcsCgst") + total(sellerGst, "tcsSgst") + total(sellerGst, "tcsIgst")) * 100) / 100, note: "gst_tcs_section_52 · GSTR-8"},
    {item: "Income-tax e-commerce TDS withheld (net of refunds)", value: Math.round(tdsTotal * 100) / 100, note: "seller_income_tax_tds · TDS return; certificates to sellers"},
    {item: "Rider e-commerce TDS (rider supplies delivery)", value: total(deliverySettlementSheet, "ecomTds"),
      note: "rider_ecommerce_tds · e-commerce TDS return; never with contractor TDS"},
    {item: "Rider contractor TDS (Scraveit supplies delivery)", value: total(riderTdsSheet, "tds"),
      note: "rider_contractor_tds · contractor TDS return; never with e-commerce TDS"},
    {item: "Scraveit platform fee to delivery suppliers", value: total(deliverySettlementSheet, "platformFee"),
      note: "scraveit_rider_platform_fee · Scraveit income"},
    {item: "GST on that platform fee", value: total(deliverySettlementSheet, "platformFeeGst"),
      note: "scraveit_rider_platform_fee_gst · SAC/rate to be confirmed"},
    {item: "Delivery GST collected for registered suppliers (not Scraveit's)", value: total(deliverySettlementSheet, "gstSupplier"),
      note: "delivery_gst_collected_for_supplier · passed on in settlement"},
    {item: "Paid to stores", value: total(partnerSheet, "paid") * -1, note: "Partner settlements"},
    {item: "Paid to riders", value: total(riderSheet, "amount"), note: "Rider payouts"},
    {item: "Refunds", value: total(refundSheet, "amount"), note: "Refunds"},
    {item: "CHECK: money in vs money out, every order (must be 0.00)", value: rupees(sumBy(balanceChecks, (value) => Math.abs(value))), note: "Customer paid + Scraveit coupons = store + rider + GST + Scraveit"},
    {item: "CHECK: payouts not found in bank statement", value: matchRows.filter((row) => row.status !== "Matched" && row.status !== "No bank statement uploaded").length,
      note: input.bankStatement ? "Bank match sheet" : "Upload a bank statement to check"},
  ]};
  return [summary, sales, income, sellerGst, tds, riderTdsSheet, deliverySettlementSheet, partnerSheet, riderSheet, codSheet, refundSheet, invoices, bankSheet];
}

function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export async function taxPackWorkbook(sheets: readonly PackSheet[], meta: {generatedAt: number; title: string}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SCRAVEIT Admin";
  workbook.created = new Date(meta.generatedAt);
  workbook.title = meta.title;
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31), {views: [{state: "frozen", ySplit: 1}]});
    ws.columns = sheet.columns.map((column) => ({header: column.header, key: column.key, width: column.width ?? 14}));
    ws.getRow(1).font = {bold: true};
    for (const row of sheet.rows) {
      const added = ws.addRow(Object.fromEntries(sheet.columns.map((column) => {
        const value = row[column.key];
        return [column.key, typeof value === "string" ? safeText(value) : value ?? ""];
      })));
      sheet.columns.forEach((column, index) => { if (column.money) added.getCell(index + 1).numFmt = "#,##0.00"; });
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Reads a bank statement CSV: date, amount, reference/UTR, narration (headers matched loosely). */
export function parseBankStatementCsv(csv: string): BankStatementLine[] {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const cells = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim());
  const header = cells(lines[0]!).map((cell) => cell.toLowerCase());
  const find = (...names: string[]) => header.findIndex((cell) => names.some((name) => cell.includes(name)));
  const date = find("date"), amount = find("debit", "withdrawal", "amount"), reference = find("utr", "ref", "cheque"), narration = find("narration", "description", "particulars");
  return lines.slice(1).map((line) => {
    const row = cells(line);
    const raw = String(row[amount] ?? "").replace(/[₹,\s]/g, "");
    return {date: String(row[date] ?? ""), amountPaise: Math.round(Math.abs(Number(raw) || 0) * 100),
      reference: String(row[reference] ?? ""), narration: String(row[narration] ?? "")};
  }).filter((line) => line.amountPaise > 0);
}
