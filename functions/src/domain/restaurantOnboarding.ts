import {createHash} from "node:crypto";

/**
 * Restaurant sign-up: document checks and the partner agreement.
 *
 * Checks are offline and free (format, checksum, PAN-inside-GSTIN); a
 * registry lookup can be added later without changing the stored shape.
 */

/** Shown as the "standard rate" until Scraveit and the restaurant agree one. */
export const STANDARD_COMMISSION_BPS = 3_000;
export const AGREEMENT_VERSION = "partner-v1-2026-10";
export const GST_ON_COMMISSION_PERCENT = 18;

/** FSSAI numbers are 14 digits: 1xxxx = licence (state or central), 2xxxx = registration. */
export function assessFssai(value: unknown): {ok: boolean; kind: "licence" | "registration" | ""} {
  const digits = String(value ?? "").replace(/\s/g, "");
  if (!/^[12]\d{13}$/.test(digits)) return {ok: false, kind: ""};
  return {ok: true, kind: digits.startsWith("1") ? "licence" : "registration"};
}

export function validPan(value: unknown): boolean {
  return /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(String(value ?? "").toUpperCase().trim());
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GSTIN: 2-digit state, the PAN, entity number, Z, and a base-36 check character. */
export function assessGstin(value: unknown, pan?: string): {ok: boolean; panMatches: boolean | null; stateCode: string} {
  const gstin = String(value ?? "").toUpperCase().trim();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return {ok: false, panMatches: null, stateCode: ""};
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(gstin[i] ?? "0") * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  const ok = check === gstin[14];
  return {ok, panMatches: pan ? gstin.slice(2, 12) === String(pan).toUpperCase().trim() : null, stateCode: gstin.slice(0, 2)};
}

export function validIfsc(value: unknown): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(value ?? "").toUpperCase().trim());
}

export function validUpi(value: unknown): boolean {
  return /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(String(value ?? "").trim());
}

/**
 * How a grocery store or dairy is covered for GST when it sells goods
 * through Scraveit: registered (GSTIN), an unregistered seller with a GST
 * enrolment number (Notification 34/2023-Central Tax: one state, no
 * inter-state supply, PAN-based enrolment on the GST portal), or a seller of
 * only GST-free goods such as fresh milk, fruits and vegetables, who need not
 * register at all (CGST Act, s.23(1)(a)). Restaurants need none of this:
 * Scraveit pays GST on restaurant food under s.9(5).
 */
export type GoodsGstMode = "registered" | "enrolment" | "exempt_only";

/** GST enrolment numbers for unregistered e-commerce sellers are issued by the GST portal; we check the shape only. */
export function validGstEnrolment(value: unknown): boolean {
  return /^[A-Z0-9]{10,20}$/.test(String(value ?? "").toUpperCase().replace(/\s/g, ""));
}

export function normalizePersonName(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
}

export interface AgreementParty {
  name: string;
  address: string;
  email: string;
  phone: string;
}

export interface AgreementInput {
  platform: AgreementParty;
  restaurantName: string;
  legalName: string;
  ownerName: string;
  address: string;
  fssaiNumber: string;
  pan: string;
  gstin: string;
  commissionBps: number;
  termMonths: number;
  /** "restaurant" (default), "grocery" or "dairy". */
  storeType?: string;
  /** Grocery and dairy only. */
  gstMode?: GoodsGstMode;
  gstEnrolment?: string;
  /** Day the agreement is offered, YYYY-MM-DD (IST). */
  date: string;
}

export interface AgreementSection {
  heading: string;
  body: string;
}

function percent(bps: number): string {
  return (Math.round(bps) / 100).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * The partner agreement in plain English. Every number in it comes from the
 * application and the terms Scraveit set, so the restaurant signs exactly
 * what the apps will charge.
 */
export function renderAgreement(input: AgreementInput): AgreementSection[] {
  const rate = percent(input.commissionBps);
  const goods = input.storeType === "grocery" || input.storeType === "dairy";
  const seller = goods ? (input.storeType === "dairy" ? "Dairy" : "Store") : "Restaurant";
  const items = goods ? "products" : "food";
  const business = input.legalName && input.legalName !== input.restaurantName ?
    `${input.legalName}, trading as ${input.restaurantName}` : input.restaurantName;
  const gstLine = input.gstin ? ` and its GSTIN is ${input.gstin}` :
    goods && input.gstMode === "enrolment" ? ` and it sells without GST registration under GST enrolment number ${input.gstEnrolment ?? ""}` :
      goods && input.gstMode === "exempt_only" ? " and it sells only goods that are exempt from GST, so it is not required to register" :
        " and it is not registered for GST";
  const pricesAndGst = goods ?
    {heading: "3. Prices and GST",
      body: `The ${seller} sets its own prices. For packaged products the price on Scraveit is never above the MRP, and it ` +
        `includes all taxes, as the Legal Metrology (Packaged Commodities) Rules, 2011 require. The ${seller} is responsible for ` +
        `the GST on its own sales and for the correct description, HSN and tax rate of each product. Where the law requires it, ` +
        "Scraveit collects tax at source under section 52 of the CGST Act, 2017, and it appears in the seller's GST records. " +
        (input.gstMode === "enrolment" ? `Under Notification 34/2023-Central Tax the ${seller} sells only within Andhra Pradesh and ` +
          "makes no inter-state supply while it is unregistered, and tells Scraveit at once if it registers for GST or its turnover " +
          "crosses the registration limit." :
          input.gstMode === "exempt_only" ? `The ${seller} lists only GST-exempt goods (such as fresh milk, fruits and vegetables) ` +
            "while it is not registered, and tells Scraveit before listing any taxable product." : "")} :
    {heading: "3. Prices and GST on food",
      body: "The Restaurant sets its own menu prices. Menu prices on Scraveit are before GST. For food ordered through the apps, " +
        "Scraveit collects GST from the customer at checkout and pays it to the government as the electronic commerce operator " +
        "under section 9(5) of the CGST Act, 2017. This GST is never taken from the Restaurant's money."};
  return [
    {heading: "1. Who this agreement is between",
      body: `This agreement is between ${input.platform.name}, ${input.platform.address} ("Scraveit"), and ${business}, ` +
        `${input.address}, represented by ${input.ownerName} (the "${seller}"). The ${seller} sells ${items} to customers through the ` +
        `Scraveit apps. Scraveit runs the apps, takes payments and arranges delivery partners.`},
    {heading: "2. Commission",
      body: `For every delivered order the ${seller} pays Scraveit a commission of ${rate}% of the item total after the ` +
        `${seller}'s own offers. GST at ${GST_ON_COMMISSION_PERCENT}% is charged on the commission. This rate is fixed for ` +
        `${input.termMonths} months from the date of signing. After that it continues until either side proposes a change in ` +
        `writing with 30 days' notice, and a new rate applies only once both sides agree.`},
    pricesAndGst,
    {heading: "4. Payouts",
      body: `Scraveit pays the ${seller} every week into the bank account or UPI ID it gave Scraveit, with a statement listing ` +
        `every order. The payout is the item total, less the ${seller}'s own offers, the commission, GST on the commission and ` +
        `any tax the law requires Scraveit to deduct or collect, adjusted for refunds the ${seller} caused. Scraveit sends a GST tax ` +
        "invoice for the commission every month."},
    {heading: "5. Offers",
      body: `Offers the ${seller} creates are paid by the ${seller}, and it sees what it gets on each item before publishing. ` +
        `Offers Scraveit creates are paid by Scraveit, unless the ${seller} agrees in writing to share one.`},
    {heading: "6. Food safety",
      body: `The ${seller} holds a valid FSSAI ${input.fssaiNumber.startsWith("1") ? "licence" : "registration"} number ` +
        `${input.fssaiNumber}, keeps it valid, and follows the Food Safety and Standards Act, 2006 and the rules and regulations ` +
        `made under it${goods ? ", including labelling, best-before dates and storage temperatures" : ""}. The ${seller} is ` +
        `responsible for the safety, quality, hygiene and description of the ${items} it sells, and the liability for them rests ` +
        `with the ${seller}. Scraveit shows the FSSAI number to customers.`},
    {heading: "7. Orders, cancellations and refunds",
      body: `The ${seller} accepts or declines each order promptly and ${goods ? "packs" : "prepares"} it in the time shown. If the ` +
        `${seller} cancels, or an item is unavailable, the customer is refunded and nothing is paid for that order. Refunds for ` +
        `wrong, missing, expired or unsafe items caused by the ${seller} are deducted from the payout after review. Problems ` +
        `caused by the delivery partner or by Scraveit are not deducted from the ${seller}.`},
    {heading: "8. Tax details",
      body: `The ${seller}'s PAN is ${input.pan}${gstLine}. ` +
        `Scraveit deducts and deposits tax at source on the ${seller}'s sales where the Income-tax law requires it, and the ` +
        `deduction appears in the ${seller}'s tax credit statement.`},
    {heading: "9. Customer data",
      body: `The ${seller} uses customers' names, phone numbers and addresses only to ${goods ? "pack and hand over" : "prepare and hand over"} ` +
        "their orders, and does not keep or share them for any other purpose (Digital Personal Data Protection Act, 2023)."},
    {heading: "10. Ending the agreement",
      body: `Either side may end this agreement with 30 days' written notice, including through the app. Scraveit may pause the ` +
        `${seller}'s listing at once if its FSSAI licence lapses, if there is a serious food safety risk, or in case of fraud, ` +
        "and will say why. Money already earned is paid out in full."},
    {heading: "11. Disputes",
      body: "Both sides will first try to settle any dispute by talking. If that fails, the courts at Nellore, Andhra Pradesh " +
        "have jurisdiction. This agreement is governed by the laws of India."},
    {heading: "12. Signing",
      body: `This agreement is signed electronically and is valid under sections 3A and 10A of the Information Technology Act, ` +
        `2000. Version ${AGREEMENT_VERSION}, offered on ${input.date}. Scraveit: ${input.platform.email}, ${input.platform.phone}.`},
  ];
}

export function agreementText(sections: AgreementSection[]): string {
  return sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n");
}

export function agreementHash(sections: AgreementSection[]): string {
  return createHash("sha256").update(`${AGREEMENT_VERSION}\n${agreementText(sections)}`).digest("hex");
}

export function istDate(at: number): string {
  return new Date(at + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
