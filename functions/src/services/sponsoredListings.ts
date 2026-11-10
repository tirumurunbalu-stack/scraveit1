import {createHash} from "node:crypto";
import type {DecodedIdToken} from "firebase-admin/auth";
import {z} from "zod";
import {firestoreDb} from "../admin";
import {availabilityCityKey} from "../domain/dispatch";
import {createLedgerJournal} from "../domain/ledger";
import {isActiveMembershipForRestaurant, type RestaurantMembership} from "../domain/restaurantAccess";
import {financialYearLabel} from "../domain/taxLaw";
import {DomainError} from "../errors";
import type {DocumentSnapshotLike, FirestoreLike, TransactionLike} from "../firestoreTypes";
import {legacyStaffRef, restaurantMemberRef} from "../firestorePaths";
import {appendLedgerJournalInTransaction} from "./ledger";
import {RESTAURANT_PAYOUT_PROFILES_COLLECTION} from "./restaurantPayoutProfiles";
import {authorizeRestaurantFinanceRead} from "./restaurantSettlements";
import {INVOICE_SERIES_COLLECTION, INVOICES_COLLECTION, TAX_LAW_DOC, normalizeTaxSettings, sellerTaxProfile} from "./taxEngine";

/**
 * Top placement ("Ad"): a store pays a fixed price per day to be listed first
 * in its city's default restaurant order in the customer app, with an Ad label.
 *
 * - Price, slots per city and the longest booking are set by SCRAVEIT in
 *   settings/sponsoredListings (admin app). A city may have its own price.
 * - Only a few stores per city per day (slotsPerCity), so the top stays useful
 *   to customers; days are counted in India time.
 * - The charge is recovered from the store's payouts: one ledger adjustment
 *   debits its restaurant payable, written in the same transaction as the
 *   booking. GST (18%, SAC 998365) is added only while GST is live, with a tax
 *   invoice; a cancellation before the start reverses it with a credit note.
 * - The customer app reads only sponsoredListings (store, city, start, end).
 */

export const SPONSORED_SETTINGS_DOC = "sponsoredListings";
export const SPONSORED_BOOKINGS_COLLECTION = "sponsoredBookings";
export const SPONSORED_LISTINGS_COLLECTION = "sponsoredListings";
export const SPONSORED_SLOT_DAYS_COLLECTION = "sponsoredSlotDays";
/** Sale of internet advertising space (except on commission). */
export const ADVERTISING_SAC = "998365";
export const ADVERTISING_GST_RATE_BPS = 1_800;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const BOOKINGS_SHOWN = 50;

export interface SponsoredListingConfig {
  enabled: boolean;
  dailyPricePaise: number;
  /** Per-city price, keyed like the catalogue's city key ("nellore"). */
  cityDailyPricePaise: Record<string, number>;
  slotsPerCity: number;
  maxDays: number;
  /** How far ahead a start day may be. */
  bookAheadDays: number;
}

const DEFAULT_CONFIG: SponsoredListingConfig = {
  enabled: true, dailyPricePaise: 19_900, cityDailyPricePaise: {}, slotsPerCity: 3, maxDays: 30, bookAheadDays: 60,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

export function sponsoredConfigOf(value: unknown): SponsoredListingConfig {
  const input = record(value);
  const cityPrices: Record<string, number> = {};
  for (const [city, price] of Object.entries(record(input.cityDailyPricePaise))) {
    const paise = int(price, 0, 100, 100_000_00);
    if (paise) cityPrices[availabilityCityKey(city)] = paise;
  }
  return {
    enabled: input.enabled !== false,
    dailyPricePaise: int(input.dailyPricePaise, DEFAULT_CONFIG.dailyPricePaise, 100, 100_000_00),
    cityDailyPricePaise: cityPrices,
    slotsPerCity: int(input.slotsPerCity, DEFAULT_CONFIG.slotsPerCity, 1, 20),
    maxDays: int(input.maxDays, DEFAULT_CONFIG.maxDays, 1, 90),
    bookAheadDays: int(input.bookAheadDays, DEFAULT_CONFIG.bookAheadDays, 1, 180),
  };
}

/** Calendar day in India (YYYY-MM-DD). India has no daylight saving, so a day is always 24 hours. */
export function istDayKey(at: number): string {
  return new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export function istDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+05:30`);
}
function addDays(day: string, n: number): string {
  return istDayKey(istDayStart(day) + n * DAY_MS);
}

/** Price for `days` days, and GST on it when GST is live. The partner dashboard shows the same sum. */
export function sponsoredQuote(dailyPricePaise: number, days: number, gstActive: boolean, intraState: boolean) {
  const pricePaise = dailyPricePaise * days;
  const gstPaise = gstActive ? Math.round(pricePaise * ADVERTISING_GST_RATE_BPS / 10_000) : 0;
  const cgstPaise = intraState ? Math.floor(gstPaise / 2) : 0;
  return {pricePaise, gstPaise, cgstPaise, sgstPaise: intraState ? gstPaise - cgstPaise : 0, igstPaise: intraState ? 0 : gstPaise,
    totalPaise: pricePaise + gstPaise};
}

const restaurantIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);

export const sponsoredListingsSchema = z.object({restaurantId: restaurantIdSchema}).strict();

export const bookSponsoredListingSchema = z.object({
  restaurantId: restaurantIdSchema,
  startDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(90),
  /** The total the owner saw and agreed to; a price change in between is refused. */
  expectedTotalPaise: z.number().int().nonnegative(),
  /** Same id on a retry: the booking is made (and charged) once. */
  requestId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const cancelSponsoredListingSchema = z.object({
  restaurantId: restaurantIdSchema,
  bookingId: z.string().regex(/^sl_[a-f0-9]{24}$/),
}).strict();

export type BookSponsoredListingInput = z.infer<typeof bookSponsoredListingSchema>;
export type CancelSponsoredListingInput = z.infer<typeof cancelSponsoredListingSchema>;

export interface SponsoredBookingView {
  bookingId: string;
  startDay: string;
  endDay: string;
  days: number;
  startAt: number;
  endAt: number;
  status: "upcoming" | "live" | "ended" | "cancelled";
  dailyPricePaise: number;
  pricePaise: number;
  gstPaise: number;
  totalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  invoiceNo: string;
  creditNoteNo: string;
  /** The store's GSTIN and State as invoiced. */
  recipientGstin: string;
  recipientStateCode: string;
  createdAt: number;
  cancelledAt: number | null;
}

export async function ownsOutlet(uid: string, token: DecodedIdToken, restaurantId: string, database: FirestoreLike): Promise<boolean> {
  if (token.savrivoRole === "owner" || token.savrivoRole === "ops_admin") return true;
  const [member, legacy] = await Promise.all([
    restaurantMemberRef(database, restaurantId, uid).get(),
    legacyStaffRef(database, uid).get(),
  ]);
  const owner = (snapshot: DocumentSnapshotLike, source: "path-scoped" | "legacy-global") => {
    const data = (snapshot.exists ? snapshot.data() : null) as RestaurantMembership | null;
    return isActiveMembershipForRestaurant(data, restaurantId, source) && data?.role === "restaurant_owner";
  };
  return owner(member, "path-scoped") || owner(legacy, "legacy-global");
}

function bookingView(id: string, data: Record<string, unknown>, now: number): SponsoredBookingView {
  const startAt = Number(data.startAt) || 0, endAt = Number(data.endAt) || 0;
  return {
    bookingId: id,
    startDay: String(data.startDay ?? ""),
    endDay: String(data.endDay ?? ""),
    days: Number(data.days) || 0,
    startAt, endAt,
    status: data.status === "cancelled" ? "cancelled" : now < startAt ? "upcoming" : now < endAt ? "live" : "ended",
    dailyPricePaise: Number(data.dailyPricePaise) || 0,
    pricePaise: Number(data.pricePaise) || 0,
    gstPaise: Number(record(data.gst).totalPaise) || 0,
    totalPaise: Number(data.totalPaise) || 0,
    cgstPaise: Number(record(data.gst).cgstPaise) || 0,
    sgstPaise: Number(record(data.gst).sgstPaise) || 0,
    igstPaise: Number(record(data.gst).igstPaise) || 0,
    invoiceNo: String(record(data.invoice).invoiceNo ?? ""),
    creditNoteNo: String(record(data.creditNote).invoiceNo ?? ""),
    recipientGstin: String(data.recipientGstin ?? ""),
    recipientStateCode: String(data.recipientStateCode ?? ""),
    createdAt: Number(data.createdAt) || 0,
    cancelledAt: Number(data.cancelledAt) || null,
  };
}

const slotRef = (database: FirestoreLike, cityKey: string, day: string) =>
  database.collection(SPONSORED_SLOT_DAYS_COLLECTION).doc(`${cityKey}_${day}`);

function taken(snapshot: DocumentSnapshotLike): Record<string, string> {
  return record(record(snapshot.exists ? snapshot.data() : {}).restaurants) as Record<string, string>;
}

/** The Ads page: price, free slots per day, and the store's own bookings. Owners, managers and staff with offers or finance access. */
export async function getSponsoredListings(uid: string, token: DecodedIdToken, input: {restaurantId: string},
  database: FirestoreLike = firestoreDb, now = Date.now()) {
  const restaurantId = input.restaurantId;
  await authorizeRestaurantFinanceRead(uid, token, restaurantId, database as never, ["finance", "offers"]);
  const [restaurant, settings, taxLaw, canBook, bookings] = await Promise.all([
    database.collection("restaurants").doc(restaurantId).get(),
    database.collection("settings").doc(SPONSORED_SETTINGS_DOC).get(),
    database.collection("private").doc(TAX_LAW_DOC).get(),
    ownsOutlet(uid, token, restaurantId, database),
    database.collection(SPONSORED_BOOKINGS_COLLECTION).where("restaurantId", "==", restaurantId)
      .orderBy("createdAt", "desc").limit(BOOKINGS_SHOWN).get(),
  ]);
  const config = sponsoredConfigOf(settings.exists ? settings.data() : {});
  const lawDoc = record(taxLaw.exists ? taxLaw.data() : {});
  const tax = normalizeTaxSettings(lawDoc);
  const store = record(restaurant.exists ? restaurant.data() : {});
  const city = String(store.city ?? "").trim();
  const cityKey = city ? availabilityCityKey(city) : "";
  const today = istDayKey(now);
  const days = Array.from({length: config.bookAheadDays}, (_, i) => addDays(today, i));
  const slots = cityKey ? await Promise.all(days.map((day) => slotRef(database, cityKey, day).get())) : [];
  return {
    enabled: config.enabled,
    city, cityKey,
    dailyPricePaise: config.cityDailyPricePaise[cityKey] ?? config.dailyPricePaise,
    gstActive: tax.gstActive,
    gstRateBps: tax.gstActive ? ADVERTISING_GST_RATE_BPS : 0,
    sac: ADVERTISING_SAC,
    /** Printed on the advertising tax invoice. */
    issuer: {
      legalName: String(lawDoc.scraveitLegalName ?? "").trim().slice(0, 160) || "SCRAVEIT PRIVATE LIMITED",
      address: String(lawDoc.scraveitAddress ?? "").trim().slice(0, 300),
      gstin: tax.scraveitGstin,
      stateCode: tax.scraveitGstin.slice(0, 2) || tax.defaultStateCode,
    },
    slotsPerCity: config.slotsPerCity,
    maxDays: config.maxDays,
    bookAheadDays: config.bookAheadDays,
    today,
    canBook,
    notBookable: !restaurant.exists || store.archived === true ? "This outlet isn't live on Scraveit." :
      !cityKey ? "Your outlet has no city yet. Ask Scraveit to add it." : !config.enabled ? "Top placement is paused by Scraveit." : "",
    availability: slots.map((snapshot, i) => {
      const booked = taken(snapshot);
      return {day: days[i]!, left: Math.max(0, config.slotsPerCity - Object.keys(booked).length), mine: Boolean(booked[restaurantId])};
    }),
    bookings: bookings.docs.map((doc) => bookingView(doc.id, record(doc.data()), now)),
  };
}

function fail(code: "failed-precondition" | "invalid-argument" | "permission-denied" | "not-found", message: string): never {
  throw new DomainError(code, message);
}

function invoiceNumber(transaction: TransactionLike, database: FirestoreLike, series: string, prefix: string,
  snapshot: DocumentSnapshotLike, at: number): {series: string; invoiceNo: string; number: number} {
  const next = (Number(record(snapshot.exists ? snapshot.data() : {}).last ?? 0) || 0) + 1;
  transaction.set(database.collection(INVOICE_SERIES_COLLECTION).doc(series), {series, prefix, last: next, updatedAt: at}, {merge: true});
  return {series, invoiceNo: `${prefix}${String(next).padStart(6, "0")}`, number: next};
}

const fyDigits = (fy: string) => fy.replace(/[^0-9]/g, "").slice(0, 4);

/** Books top placement for whole days and charges it to the store's payouts. Owners only. */
export async function bookSponsoredListing(uid: string, token: DecodedIdToken, input: BookSponsoredListingInput,
  database: FirestoreLike = firestoreDb, now = Date.now()): Promise<SponsoredBookingView> {
  const {restaurantId, startDay, days} = input;
  if (!await ownsOutlet(uid, token, restaurantId, database)) {
    fail("permission-denied", "Only the outlet owner can book top placement.");
  }
  const bookingId = `sl_${createHash("sha256").update(`${restaurantId}:${input.requestId}`).digest("hex").slice(0, 24)}`;
  const bookingRef = database.collection(SPONSORED_BOOKINGS_COLLECTION).doc(bookingId);
  const today = istDayKey(now);
  if (istDayKey(istDayStart(startDay)) !== startDay) fail("invalid-argument", "Pick a valid start date.");

  return database.runTransaction(async (transaction) => {
    const existing = await transaction.get(bookingRef);
    if (existing.exists) return bookingView(bookingId, record(existing.data()), now);
    const [restaurant, settings, taxLaw, profile] = await Promise.all([
      transaction.get(database.collection("restaurants").doc(restaurantId)),
      transaction.get(database.collection("settings").doc(SPONSORED_SETTINGS_DOC)),
      transaction.get(database.collection("private").doc(TAX_LAW_DOC)),
      transaction.get(database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId)),
    ]);
    const config = sponsoredConfigOf(settings.exists ? settings.data() : {});
    const store = record(restaurant.exists ? restaurant.data() : {});
    const city = String(store.city ?? "").trim();
    if (!restaurant.exists || store.archived === true) fail("failed-precondition", "This outlet isn't live on Scraveit.");
    if (!city) fail("failed-precondition", "Your outlet has no city yet. Ask Scraveit to add it.");
    if (!config.enabled) fail("failed-precondition", "Top placement is paused by Scraveit.");
    if (startDay < today || startDay > addDays(today, config.bookAheadDays - 1)) {
      fail("invalid-argument", `Pick a start date from today up to ${config.bookAheadDays} days ahead.`);
    }
    if (days > config.maxDays) fail("invalid-argument", `Book up to ${config.maxDays} days at a time.`);

    const cityKey = availabilityCityKey(city);
    const dayKeys = Array.from({length: days}, (_, i) => addDays(startDay, i));
    const slotSnaps = await Promise.all(dayKeys.map((day) => transaction.get(slotRef(database, cityKey, day))));
    slotSnaps.forEach((snapshot, i) => {
      const booked = taken(snapshot);
      if (booked[restaurantId]) fail("failed-precondition", `You already have top placement on ${dayKeys[i]}.`);
      if (Object.keys(booked).length >= config.slotsPerCity) fail("failed-precondition", `All top places in ${city} are taken on ${dayKeys[i]}.`);
    });

    const tax = normalizeTaxSettings(taxLaw.exists ? taxLaw.data() : {});
    const seller = sellerTaxProfile(profile.exists ? profile.data() : {}, tax.defaultStateCode);
    const supplierState = tax.scraveitGstin.slice(0, 2) || tax.defaultStateCode;
    const dailyPricePaise = config.cityDailyPricePaise[cityKey] ?? config.dailyPricePaise;
    const quote = sponsoredQuote(dailyPricePaise, days, tax.gstActive, seller.stateCode === supplierState);
    if (quote.totalPaise !== input.expectedTotalPaise) {
      fail("failed-precondition", "The price has changed. Check the new total and book again.");
    }
    const fy = financialYearLabel(now);
    const series = `scraveit_ads_${fy}`;
    const seriesSnap = tax.gstActive ? await transaction.get(database.collection(INVOICE_SERIES_COLLECTION).doc(series)) : null;

    // Reads are done; writes follow.
    const startAt = istDayStart(startDay), endAt = istDayStart(dayKeys[dayKeys.length - 1]!) + DAY_MS;
    const invoice = seriesSnap ? invoiceNumber(transaction, database, series, `AD${fyDigits(fy)}/`, seriesSnap, now) : null;
    const gst = {rateBps: tax.gstActive ? ADVERTISING_GST_RATE_BPS : 0, sac: ADVERTISING_SAC, cgstPaise: quote.cgstPaise,
      sgstPaise: quote.sgstPaise, igstPaise: quote.igstPaise, totalPaise: quote.gstPaise};
    if (invoice) {
      transaction.set(database.collection(INVOICES_COLLECTION).doc(`${series}_${invoice.number}`), {
        invoiceNo: invoice.invoiceNo, series, kind: "scraveit_advertising", bookingId, restaurantId, financialYear: fy, issuedAt: now,
        taxableValuePaise: quote.pricePaise, gst, totalPaise: quote.totalPaise, recipientGstin: seller.gstin,
        recipientStateCode: seller.stateCode, supplierStateCode: supplierState,
        description: `Top placement in ${city}, ${startDay} to ${dayKeys[dayKeys.length - 1]} (${days} day${days === 1 ? "" : "s"})`,
      });
    }
    const journalId = appendLedgerJournalInTransaction(transaction, database, createLedgerJournal({
      eventType: "adjustment",
      eventId: `sponsored-listing:${bookingId}`,
      occurredAt: now,
      actorId: uid,
      metadata: {restaurantId, adjustmentKind: "sponsored_listing", bookingId, startDay, days},
      postings: [
        {accountId: `liability:restaurant-payable:${restaurantId}`, side: "debit", amountPaise: quote.totalPaise,
          memo: "Top placement ad, recovered from payout"},
        {accountId: "revenue:advertising", side: "credit", amountPaise: quote.pricePaise, memo: "Top placement ad"},
        ...(quote.gstPaise > 0 ? [{accountId: "liability:tax-payable", side: "credit" as const, amountPaise: quote.gstPaise,
          memo: "GST on advertising"}] : []),
      ],
    }));
    const booking = {
      bookingId, restaurantId, restaurantName: String(store.name ?? ""), city, cityKey, startDay,
      endDay: dayKeys[dayKeys.length - 1], days, startAt, endAt, dailyPricePaise, pricePaise: quote.pricePaise, gst,
      totalPaise: quote.totalPaise, ...(invoice ? {invoice: {series, invoiceNo: invoice.invoiceNo}} : {}),
      recipientGstin: seller.gstin, recipientStateCode: seller.stateCode, supplierStateCode: supplierState,
      status: "booked", journalId, requestId: input.requestId, createdAt: now, createdBy: uid, createdByEmail: String(token.email ?? ""),
    };
    transaction.set(bookingRef, booking);
    transaction.set(database.collection(SPONSORED_LISTINGS_COLLECTION).doc(bookingId), {restaurantId, cityKey, startAt, endAt});
    slotSnaps.forEach((snapshot, i) => {
      transaction.set(slotRef(database, cityKey, dayKeys[i]!), {cityKey, day: dayKeys[i], restaurants: {...taken(snapshot), [restaurantId]: bookingId}});
    });
    return bookingView(bookingId, booking, now);
  });
}

/** Cancels a booking that hasn't started: full refund to the payout, slots freed, credit note if invoiced. Owners only. */
export async function cancelSponsoredListing(uid: string, token: DecodedIdToken, input: CancelSponsoredListingInput,
  database: FirestoreLike = firestoreDb, now = Date.now()): Promise<SponsoredBookingView> {
  const {restaurantId, bookingId} = input;
  if (!await ownsOutlet(uid, token, restaurantId, database)) {
    fail("permission-denied", "Only the outlet owner can cancel top placement.");
  }
  const bookingRef = database.collection(SPONSORED_BOOKINGS_COLLECTION).doc(bookingId);
  return database.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(bookingRef);
    const booking = record(snapshot.exists ? snapshot.data() : {});
    if (!snapshot.exists || booking.restaurantId !== restaurantId) fail("not-found", "Booking not found.");
    if (booking.status === "cancelled") return bookingView(bookingId, booking, now);
    if (now >= Number(booking.startAt)) fail("failed-precondition", "This booking has already started, so it can't be cancelled.");
    const cityKey = String(booking.cityKey), dayKeys = Array.from({length: Number(booking.days)}, (_, i) => addDays(String(booking.startDay), i));
    const slotSnaps = await Promise.all(dayKeys.map((day) => transaction.get(slotRef(database, cityKey, day))));
    const invoice = record(booking.invoice), gst = record(booking.gst);
    const fy = financialYearLabel(now), series = `scraveit_ads_cn_${fy}`;
    const seriesSnap = invoice.invoiceNo ? await transaction.get(database.collection(INVOICE_SERIES_COLLECTION).doc(series)) : null;

    const creditNote = seriesSnap ? invoiceNumber(transaction, database, series, `ADCN${fyDigits(fy)}/`, seriesSnap, now) : null;
    if (creditNote) {
      transaction.set(database.collection(INVOICES_COLLECTION).doc(`${series}_${creditNote.number}`), {
        invoiceNo: creditNote.invoiceNo, series, kind: "scraveit_advertising_credit_note", againstInvoiceNo: invoice.invoiceNo,
        bookingId, restaurantId, financialYear: fy, issuedAt: now, taxableValuePaise: booking.pricePaise, gst, totalPaise: booking.totalPaise,
        description: "Top placement cancelled before it started",
      });
    }
    const gstPaise = Number(gst.totalPaise) || 0;
    const reversalJournalId = appendLedgerJournalInTransaction(transaction, database, createLedgerJournal({
      eventType: "adjustment",
      eventId: `sponsored-listing-cancel:${bookingId}`,
      occurredAt: now,
      actorId: uid,
      metadata: {restaurantId, adjustmentKind: "sponsored_listing_refund", bookingId},
      postings: [
        {accountId: "revenue:advertising", side: "debit", amountPaise: Number(booking.pricePaise), memo: "Top placement cancelled"},
        ...(gstPaise > 0 ? [{accountId: "liability:tax-payable", side: "debit" as const, amountPaise: gstPaise, memo: "GST on cancelled advertising"}] : []),
        {accountId: `liability:restaurant-payable:${restaurantId}`, side: "credit", amountPaise: Number(booking.totalPaise),
          memo: "Top placement refunded to payout"},
      ],
    }));
    const update = {status: "cancelled", cancelledAt: now, cancelledBy: uid, reversalJournalId,
      ...(creditNote ? {creditNote: {series, invoiceNo: creditNote.invoiceNo}} : {})};
    transaction.update(bookingRef, update);
    transaction.delete(database.collection(SPONSORED_LISTINGS_COLLECTION).doc(bookingId));
    slotSnaps.forEach((slot, i) => {
      const rest = {...taken(slot)};
      if (rest[restaurantId] === bookingId) delete rest[restaurantId];
      transaction.set(slotRef(database, cityKey, dayKeys[i]!), {cityKey, day: dayKeys[i], restaurants: rest});
    });
    return bookingView(bookingId, {...booking, ...update}, now);
  });
}
