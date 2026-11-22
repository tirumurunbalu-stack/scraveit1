import {createHash} from "node:crypto";

/**
 * Restaurant sign-up: document checks and the partner agreement.
 *
 * Checks are offline and free (format, checksum, PAN-inside-GSTIN); a
 * registry lookup can be added later without changing the stored shape.
 */

/** Shown as the "standard rate" until Scraveit and the restaurant agree one. */
export const STANDARD_COMMISSION_BPS = 3_000;
export const AGREEMENT_VERSION = "partner-v4-2026-11";
export const GST_ON_COMMISSION_PERCENT = 18;

/** FSSAI numbers are 14 digits: 1xxxx = licence (state or central), 2xxxx = registration. */
export function assessFssai(value: unknown): {ok: boolean; kind: "licence" | "registration" | ""} {
  const digits = String(value ?? "").replace(/\s/g, "");
  if (!/^[12]\d{13}$/.test(digits)) return {ok: false, kind: ""};
  return {ok: true, kind: digits.startsWith("1") ? "licence" : "registration"};
}

/** Store kinds that sell packed goods rather than cooked food. "pharmacy" is the customer's Health care tab. */
export const GOODS_STORE_TYPES = ["grocery", "dairy", "pharmacy"] as const;
export type StoreType = "restaurant" | typeof GOODS_STORE_TYPES[number];

export function storeTypeOf(value: unknown): StoreType {
  const type = String(value ?? "");
  return (GOODS_STORE_TYPES as readonly string[]).includes(type) ? type as StoreType : "restaurant";
}

/**
 * Retail drug licence (Forms 20 and 21, Drugs Rules, 1945). States number
 * them differently ("AP/NLR/2021/20B-1234", "20B-21B/NLR/0412"), so only the
 * shape is checked; the reviewer reads the certificate photo.
 */
export function validDrugLicence(value: unknown): boolean {
  const text = String(value ?? "").toUpperCase().trim();
  return /^[A-Z0-9][A-Z0-9 /().,-]{3,59}$/.test(text) && /\d/.test(text);
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
  /** "restaurant" (default), "grocery", "dairy" or "pharmacy". */
  storeType?: string;
  /** Pharmacy only: retail drug licence number. */
  drugLicenceNumber?: string;
  /** Goods stores only. */
  gstMode?: GoodsGstMode;
  gstEnrolment?: string;
  /** Day the agreement is offered, YYYY-MM-DD (IST). */
  date: string;
  /** One owner, several outlets: every outlet this agreement covers (Schedule 1). One outlet = no schedule. */
  outlets?: AgreementOutlet[];
}

export interface AgreementOutlet {
  name: string;
  address: string;
  fssaiNumber: string;
  drugLicenceNumber?: string;
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
  const type = storeTypeOf(input.storeType);
  const goods = type !== "restaurant", pharmacy = type === "pharmacy";
  const seller = type === "dairy" ? "Dairy" : pharmacy ? "Pharmacy" : goods ? "Store" : "Restaurant";
  const items = goods ? "products" : "food";
  const outlets = (input.outlets ?? []).length > 1 ? input.outlets ?? [] : [];
  const group = outlets.length > 1;
  const business = input.legalName && input.legalName !== input.restaurantName ?
    `${input.legalName}, trading as ${input.restaurantName}` : input.restaurantName;
  const fssaiKind = (n: string) => n.startsWith("1") ? "licence" : "registration";
  const who = group ?
    `${input.legalName || input.ownerName}, which runs the ${outlets.length} outlets listed in Schedule 1 at the end of this agreement, ` +
      `represented by ${input.ownerName} (the "${seller}"; everything in this agreement applies to each outlet)` :
    `${business}, ${input.address}, represented by ${input.ownerName} (the "${seller}")`;
  const gstLine = !goods ? "" : input.gstin ? ` and its GSTIN is ${input.gstin}` :
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
          input.gstMode === "exempt_only" ? `The ${seller} lists only GST-exempt goods (such as ${pharmacy ? "sanitary pads" : "fresh milk, fruits and vegetables"}) ` +
            "while it is not registered, and tells Scraveit before listing any taxable product." : "")} :
    {heading: "3. Prices and GST on food",
      body: "The Restaurant sets its own menu prices and chooses in the app whether they include GST. For food ordered through " +
        "the apps, Scraveit pays the GST to the government as the electronic commerce operator under section 9(5) of the CGST " +
        "Act, 2017, whether or not the Restaurant is registered for GST. If the menu prices include GST, customers pay the menu " +
        "price and the GST is taken out of the item total, so the commission and the payout are worked out on the value before " +
        "GST. If the menu prices do not include GST, the GST is added to the customer's bill at checkout and is not taken from " +
        "the Restaurant's money."};
  return [
    {heading: "1. Who this agreement is between",
      body: `This agreement is between ${input.platform.name}, ${input.platform.address} ("Scraveit"), and ${who}. ` +
        `The ${seller} sells ${items} to customers through the ` +
        `Scraveit apps. Scraveit runs the apps, takes payments and arranges delivery partners.`},
    {heading: "2. Commission",
      body: `For every delivered order the ${seller} pays Scraveit a commission of ${rate}% of the item total after the ` +
        `${seller}'s own offers. GST at ${GST_ON_COMMISSION_PERCENT}% is charged on the commission. This rate is fixed for ` +
        `${input.termMonths} months from the date of signing, unless both sides agree to change it. After that, either side may ` +
        "propose a new rate in writing, including through the app, with at least 30 days' notice, and the new rate applies from " +
        `the date in the notice once the other side accepts it. If the ${seller} has not accepted a new rate Scraveit proposes ` +
        "before that date, this agreement ends on that date and money already earned is paid out in full. A lower rate offered by " +
        `Scraveit applies from its date without needing acceptance.` +
        (group ? ` The same rate applies to every outlet in Schedule 1. An outlet added later, or one with a different rate, ` +
          "signs its own agreement." : "")},
    pricesAndGst,
    {heading: "4. Payouts",
      body: `Scraveit pays the ${seller} every week into the bank account or UPI ID it gave Scraveit, with a statement listing ` +
        `every order${group ? ", separately for each outlet" : ""}. The payout is the item total, less the ${seller}'s own offers, the commission, GST on the commission and ` +
        `any tax the law requires Scraveit to deduct or collect, adjusted for refunds the ${seller} caused. Scraveit sends a GST tax ` +
        "invoice for the commission every month."},
    {heading: "5. Offers",
      body: `Offers the ${seller} creates are paid by the ${seller}, and it sees what it gets on each item before publishing. ` +
        `Offers Scraveit creates are paid by Scraveit, unless the ${seller} agrees in writing to share one.`},
    pharmacy ? {heading: "6. Drug licence and product safety",
      body: (group ? "Each outlet of the Pharmacy holds a valid retail drug licence, with the number listed in Schedule 1, under " +
        "the Drugs and Cosmetics Act, 1940, and keeps it valid." :
        `The Pharmacy holds a valid retail drug licence, number ${input.drugLicenceNumber ?? ""}, under the Drugs and ` +
        "Cosmetics Act, 1940, and keeps it valid.") + " Through Scraveit it lists only products that can be sold without a " +
        "prescription: never a drug in Schedule H, H1 or X of the Drugs Rules, 1945, or any other product that needs a " +
        "prescription. It sells products within their expiry date and stores them as their labels say" +
        (group ? ", and holds the FSSAI licence or registration listed in Schedule 1 for food products such as baby food and " +
          "nutrition drinks" :
          input.fssaiNumber ? `, and it holds FSSAI ${fssaiKind(input.fssaiNumber)} number ` +
          `${input.fssaiNumber} for food products such as baby food and nutrition drinks` : "") +
        ". The Pharmacy is responsible for the quality, safety and description of the products it sells, and the liability " +
        "for them rests with the Pharmacy. Scraveit shows the drug licence number to customers."} :
    {heading: "6. Food safety",
      body: (group ? `Each outlet of the ${seller} holds a valid FSSAI licence or registration, with the number listed in ` +
        "Schedule 1, keeps it valid, and follows" :
        `The ${seller} holds a valid FSSAI ${fssaiKind(input.fssaiNumber)} number ${input.fssaiNumber}, keeps it valid, and follows`) +
        `  the Food Safety and Standards Act, 2006 and the rules and regulations ` +
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
        `${seller}'s listing at once if its ${pharmacy ? "drug licence lapses, if it lists a product that needs a prescription, " +
          "if there is a serious safety risk" : "FSSAI licence lapses, if there is a serious food safety risk"}, or in case of fraud, ` +
        `and will say why.${group ? " The agreement can be ended or paused for one outlet without affecting the others." : ""} ` +
        "Money already earned is paid out in full."},
    {heading: "11. Disputes",
      body: "Both sides will first try to settle any dispute by talking. If that fails, the courts at Nellore, Andhra Pradesh " +
        "have jurisdiction. This agreement is governed by the laws of India."},
    {heading: "12. Signing",
      body: `This agreement is signed electronically and is valid under sections 3A and 10A of the Information Technology Act, ` +
        `2000. The person who signs confirms that they are ${input.ownerName}, who represents the ${seller} in clause 1, or that ` +
        `the ${seller} has authorised them in writing to sign for it. ` +
        `Version ${AGREEMENT_VERSION}, offered on ${input.date}. Scraveit: ${input.platform.email}, ${input.platform.phone}.`},
    ...(group ? [{heading: "Schedule 1: Outlets covered by this agreement",
      body: outlets.map((o, i) => `${i + 1}. ${o.name}, ${o.address}` + (pharmacy ?
        `, drug licence ${o.drugLicenceNumber ?? ""}${o.fssaiNumber ? `, FSSAI ${fssaiKind(o.fssaiNumber)} ${o.fssaiNumber}` : ""}` :
        `, FSSAI ${fssaiKind(o.fssaiNumber)} ${o.fssaiNumber}`) + ".").join("\n")}] : []),
  ];
}

/** A commission change Scraveit proposes to a store (or to several outlets of one owner). */
export interface CommissionNoticeInput {
  platformName: string;
  sellerName: string;
  outlets: Array<{name: string; fromBps: number}>;
  toBps: number;
  /** IST date the new rate starts, YYYY-MM-DD. */
  effectiveDate: string;
  /** "ends": not accepting ends the agreement on that date. "keeps": still in the fixed period, the old rate stays. */
  consequence: "ends" | "keeps";
  note?: string;
  sentDate: string;
}

export const COMMISSION_NOTICE_DAYS = 30;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-12-30" -> "30 December 2026". */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : date;
}

export function renderCommissionNotice(input: CommissionNoticeInput): AgreementSection[] {
  const to = percent(input.toBps);
  const when = longDate(input.effectiveDate);
  const many = input.outlets.length > 1;
  const lower = input.outlets.every((o) => input.toBps < o.fromBps);
  const list = input.outlets.map((o) => `${o.name} (now ${percent(o.fromBps)}%)`).join(", ");
  const sections: AgreementSection[] = [
    {heading: "Change to your commission",
      body: `${input.platformName} is changing the commission for ${many ? "your outlets" : "your store"} ${list} to ${to}% of ` +
        `the item total, from ${when}. GST at ${GST_ON_COMMISSION_PERCENT}% is charged on the commission as before. ` +
        "Everything else in your partner agreement stays the same."},
    lower ?
      {heading: "What you need to do",
        body: `Nothing. The lower rate applies from ${when} on its own. Orders before that date use the current rate.`} :
      {heading: "What you need to do",
        body: `Please read this and tap Accept before ${when}. Orders before that date use the current rate. ` +
          (input.consequence === "ends" ?
            `If you have not accepted before ${when}, we are unable to continue: your partnership with Scraveit, and your ` +
              "partner agreement if you have signed one, ends on that date, and all money already earned is paid out in full. " +
              "This notice is also Scraveit's written notice of ending under your partner agreement, which takes effect only if " +
              "you have not accepted." :
            "Your current rate is still within its fixed period, so if you do not accept, your current rate stays until that " +
              "period ends.")},
  ];
  if (input.note) sections.push({heading: "Note from Scraveit", body: input.note});
  sections.push({heading: "Notice details",
    body: `Sent through the Scraveit store app on ${longDate(input.sentDate)}. Thank you for understanding.`});
  return sections;
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
