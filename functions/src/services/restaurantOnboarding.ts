import type {DecodedIdToken} from "firebase-admin/auth";
import {logger} from "firebase-functions";
import {PDFDocument, StandardFonts, rgb} from "pdf-lib";
import {firestoreDb, storage} from "../admin";
import {DomainError} from "../errors";
import type {FirestoreLike} from "../firestoreTypes";
import {menuItemRef, restaurantMemberRef, restaurantRef} from "../firestorePaths";
import {requirePlatformConfigAdminClaim} from "./authz";
import {RESTAURANT_PAYOUT_PROFILES_COLLECTION} from "./restaurantPayoutProfiles";
import {
  AGREEMENT_VERSION,
  STANDARD_COMMISSION_BPS,
  agreementHash,
  assessFssai,
  assessGstin,
  istDate,
  normalizePersonName,
  renderAgreement,
  validIfsc,
  validPan,
  validGstEnrolment,
  validUpi,
  type GoodsGstMode,
  type AgreementParty,
  type AgreementSection,
} from "../domain/restaurantOnboarding";

/**
 * Restaurant sign-up 2.0, server side. The restaurant fills its application
 * (restaurantApplications/{uid}) directly; everything that decides money or
 * legal terms happens here: the agreed commission, the agreement it signs,
 * and the approval that turns an application into a live restaurant.
 */

const APPLICATIONS = "restaurantApplications";
const AGREEMENT_RECORDS = "restaurantAgreements";
const DOC_PREFIX = "private/restaurant-onboarding/";
const ESIGN_PROVIDER = process.env.RESTAURANT_ESIGN_PROVIDER ?? "";

type Rec = Record<string, unknown>;
function rec(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
}
function str(value: unknown, max = 300): string {
  return String(value ?? "").trim().slice(0, max);
}

async function loadApplication(database: FirestoreLike, appId: string): Promise<Rec> {
  const snapshot = await database.collection(APPLICATIONS).doc(appId).get();
  if (!snapshot.exists) throw new DomainError("not-found", "Application not found.");
  return rec(snapshot.data());
}

function isAdmin(token: DecodedIdToken): boolean {
  return token.savrivoRole === "owner" || token.savrivoRole === "ops_admin";
}

function requireApplicant(uid: string, token: DecodedIdToken, app: Rec): void {
  if (isAdmin(token)) return;
  if (str(app.uid) !== uid) throw new DomainError("permission-denied", "This application belongs to another account.");
}

export async function loadAgreementParty(database: FirestoreLike = firestoreDb): Promise<AgreementParty | null> {
  const snapshot = await database.collection("settings").doc("legal").get();
  const legal = rec(snapshot.exists ? snapshot.data() : null);
  const party = {name: str(legal.platformName, 160), address: str(legal.platformAddress, 400),
    email: str(legal.platformEmail, 160), phone: str(legal.platformPhone, 40)};
  return party.name && party.address && party.email ? party : null;
}

/** What the application says, in the shape the agreement needs. */
function agreementSections(app: Rec, party: AgreementParty): {sections: AgreementSection[]; hash: string} {
  const terms = rec(app.terms);
  const location = rec(app.location);
  const sections = renderAgreement({
    platform: party,
    restaurantName: str(app.restaurantName, 120),
    legalName: str(app.legalName, 160),
    ownerName: str(app.ownerName, 120),
    address: [str(location.address, 300) || str(app.address, 300), str(location.city ?? app.city, 80)].filter(Boolean).join(", "),
    fssaiNumber: str(rec(app.fssai).number, 14),
    pan: str(rec(app.pan).number, 10).toUpperCase(),
    gstin: str(app.gstin, 15).toUpperCase(),
    storeType: str(app.storeType) || "restaurant",
    gstMode: goodsGstMode(app),
    gstEnrolment: str(app.gstEnrolment, 20).toUpperCase(),
    commissionBps: Number(terms.commissionBps ?? STANDARD_COMMISSION_BPS),
    termMonths: Number(terms.termMonths ?? 12),
    date: istDate(Number(terms.setAt ?? app.submittedAt ?? Date.now())),
  });
  return {sections, hash: agreementHash(sections)};
}

function sellsGoods(app: Rec): boolean {
  return ["grocery", "dairy"].includes(str(app.storeType));
}

export function goodsGstMode(app: Rec): GoodsGstMode | undefined {
  if (!sellsGoods(app)) return undefined;
  if (app.gstin) return "registered";
  return app.gstMode === "exempt_only" ? "exempt_only" : "enrolment";
}

/** Every check the application must pass before it can be signed and approved. */
export function applicationIssues(app: Rec): string[] {
  const issues: string[] = [];
  if (!str(app.restaurantName)) issues.push("Restaurant name");
  if (!str(app.ownerName)) issues.push("Owner name");
  if (!/^\+?\d[\d\s-]{8,15}$/.test(str(app.phone))) issues.push("Phone number");
  const location = rec(app.location);
  if (!Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng)) || !str(location.address ?? app.address)) issues.push("Location pin and address");
  const fssai = rec(app.fssai);
  if (!assessFssai(fssai.number).ok) issues.push("FSSAI number");
  if (!str(fssai.photoPath)) issues.push("FSSAI certificate photo");
  if (fssai.expiresOn && String(fssai.expiresOn) < istDate(Date.now())) issues.push("FSSAI licence has expired");
  const pan = rec(app.pan);
  if (!validPan(pan.number)) issues.push("PAN");
  if (app.gstin && !assessGstin(app.gstin, str(pan.number)).ok) issues.push("GSTIN");
  // A grocery store or dairy without a GSTIN can sell online only with a GST
  // enrolment number, or if it sells nothing but GST-exempt goods.
  if (sellsGoods(app) && !app.gstin && goodsGstMode(app) === "enrolment" && !validGstEnrolment(app.gstEnrolment)) {
    issues.push("GST enrolment number (or a GSTIN)");
  }
  const bank = rec(app.bank);
  if (bank.method === "upi" ? !validUpi(bank.upiId) : !(validIfsc(bank.ifsc) && /^\d{9,18}$/.test(str(bank.accountNumber)) && str(bank.holderName))) issues.push("Bank account or UPI");
  const menu = rec(app.menu);
  const dishes = Array.isArray(menu.dishes) ? menu.dishes : [];
  const cards = Array.isArray(menu.cardPhotoPaths) ? menu.cardPhotoPaths : [];
  if (dishes.length < 5 && !cards.length) issues.push("Menu (5 dishes or a menu card photo)");
  return issues;
}

export interface AgreementView {
  version: string;
  status: "waiting_for_rate" | "ready" | "signed";
  standardBps: number;
  commissionBps: number;
  termMonths: number;
  rateAgreed: boolean;
  sections: AgreementSection[];
  hash: string;
  signedAt: number;
  signedBy: string;
  method: string;
  esignAvailable: boolean;
  partiesReady: boolean;
}

export async function getRestaurantAgreement(
  uid: string,
  token: DecodedIdToken,
  appId: string,
  database: FirestoreLike = firestoreDb,
): Promise<AgreementView> {
  const app = await loadApplication(database, appId);
  requireApplicant(uid, token, app);
  const party = await loadAgreementParty(database);
  const terms = rec(app.terms);
  const signed = rec(app.agreement);
  const rateAgreed = Number.isFinite(Number(terms.commissionBps));
  const view = party ? agreementSections(app, party) : {sections: [], hash: ""};
  return {
    version: AGREEMENT_VERSION,
    status: signed.status === "signed" ? "signed" : rateAgreed ? "ready" : "waiting_for_rate",
    standardBps: STANDARD_COMMISSION_BPS,
    commissionBps: rateAgreed ? Number(terms.commissionBps) : STANDARD_COMMISSION_BPS,
    termMonths: Number(terms.termMonths ?? 12),
    rateAgreed,
    sections: view.sections,
    hash: view.hash,
    signedAt: Number(signed.signedAt ?? 0),
    signedBy: str(signed.typedName),
    method: str(signed.method),
    esignAvailable: Boolean(ESIGN_PROVIDER),
    partiesReady: Boolean(party),
  };
}

/** Plain WinAnsi text for the standard PDF fonts (no rupee sign, no Indic script). */
function pdfSafe(text: string): string {
  return text.replace(/₹/g, "Rs.").replace(/[^\x20-\x7E -ÿ‘’“”–—•…]/g, "?");
}

export async function buildAgreementPdf(
  title: string,
  sections: AgreementSection[],
  certificate: Array<[string, string]>,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  let page = pdf.addPage([595.28, 841.89]);
  let y = page.getHeight() - margin;
  const width = page.getWidth() - margin * 2;
  const ink = rgb(0.055, 0.106, 0.239);
  const newPageIfNeeded = (needed: number) => {
    if (y - needed < margin) {
      page = pdf.addPage([595.28, 841.89]);
      y = page.getHeight() - margin;
    }
  };
  const paragraph = (text: string, size: number, face = font, gap = 4) => {
    const words = pdfSafe(text).split(/\s+/);
    let line = "";
    const flush = () => {
      newPageIfNeeded(size + gap);
      page.drawText(line, {x: margin, y: y - size, size, font: face, color: ink});
      y -= size + gap;
      line = "";
    };
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (face.widthOfTextAtSize(next, size) > width && line) {
        flush();
        line = word;
      } else line = next;
    }
    if (line) flush();
  };
  paragraph(title, 18, bold, 10);
  for (const section of sections) {
    y -= 6;
    paragraph(section.heading, 11.5, bold, 4);
    paragraph(section.body, 10, font, 3.5);
  }
  y -= 14;
  newPageIfNeeded(40 + certificate.length * 16);
  paragraph("Electronic signature record", 12, bold, 6);
  for (const [label, value] of certificate) paragraph(`${label}: ${value}`, 9.5, font, 3);
  return pdf.save();
}

export async function signRestaurantAgreement(
  uid: string,
  token: DecodedIdToken,
  input: {appId: string; hash: string; typedName: string; consent: boolean; method: "in_app" | "aadhaar_esign"},
  meta: {ip: string; userAgent: string},
  database: FirestoreLike = firestoreDb,
  bucket = () => storage.bucket(),
): Promise<{signed: true; signedAt: number}> {
  const app = await loadApplication(database, input.appId);
  if (str(app.uid) !== uid) throw new DomainError("permission-denied", "Only the owner who applied can sign.");
  if (input.method === "aadhaar_esign" && !ESIGN_PROVIDER) {
    throw new DomainError("failed-precondition", "Aadhaar eSign is not switched on yet. You can accept the agreement in the app for now.");
  }
  if (rec(app.agreement).status === "signed") throw new DomainError("already-exists", "This agreement is already signed.");
  const terms = rec(app.terms);
  if (!Number.isFinite(Number(terms.commissionBps))) {
    throw new DomainError("failed-precondition", "Scraveit hasn't confirmed your commission rate yet.");
  }
  if (!input.consent) throw new DomainError("invalid-argument", "Tick the box to confirm you agree.");
  const issues = applicationIssues(app);
  if (issues.length) throw new DomainError("failed-precondition", `Finish these first: ${issues.join(", ")}.`);
  const party = await loadAgreementParty(database);
  if (!party) throw new DomainError("failed-precondition", "Scraveit's business details aren't set up yet. Please try again later.");
  const {sections, hash} = agreementSections(app, party);
  if (hash !== input.hash) throw new DomainError("aborted", "The agreement changed while you were reading it. Please read it again.");
  if (normalizePersonName(input.typedName) !== normalizePersonName(app.ownerName)) {
    throw new DomainError("invalid-argument", `Type your full name exactly as on the application: ${str(app.ownerName)}.`);
  }
  const now = Date.now();
  const certificate: Array<[string, string]> = [
    ["Signed by", `${str(app.ownerName)} (typed name: ${str(input.typedName, 120)})`],
    ["Account", `${str(app.email)} (signed in with ${token.firebase?.sign_in_provider ?? "email"})`],
    ["Signed at", `${new Date(now + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 19)} IST`],
    ["Method", input.method === "aadhaar_esign" ? "Aadhaar eSign" : "Accepted in the Scraveit Restaurant app"],
    ["IP address", meta.ip || "unknown"],
    ["Device", meta.userAgent.slice(0, 120) || "unknown"],
    ["Agreement version", AGREEMENT_VERSION],
    ["Document fingerprint (SHA-256)", hash],
  ];
  const pdf = await buildAgreementPdf(`Scraveit Restaurant Partner Agreement: ${str(app.restaurantName)}`, sections, certificate);
  const pdfPath = `private/restaurant-agreements/${input.appId}/${AGREEMENT_VERSION}-${hash.slice(0, 12)}.pdf`;
  await bucket().file(pdfPath).save(Buffer.from(pdf), {contentType: "application/pdf", resumable: false});
  const agreement = {
    status: "signed", version: AGREEMENT_VERSION, hash, method: input.method, typedName: str(input.typedName, 120),
    commissionBps: Number(terms.commissionBps), termMonths: Number(terms.termMonths ?? 12),
    signedAt: now, ip: meta.ip.slice(0, 64), userAgent: meta.userAgent.slice(0, 200), pdfPath,
  };
  await database.collection(APPLICATIONS).doc(input.appId).set({agreement, updatedAt: now}, {merge: true});
  await database.collection(AGREEMENT_RECORDS).doc(`${input.appId}_${hash.slice(0, 16)}`).set({
    appId: input.appId, uid, restaurantName: str(app.restaurantName), ...agreement,
  });
  logger.info("RESTAURANT_AGREEMENT_SIGNED", {appId: input.appId, method: input.method, commissionBps: agreement.commissionBps});
  return {signed: true, signedAt: now};
}

export async function setRestaurantAgreementTerms(
  uid: string,
  token: DecodedIdToken,
  input: {appId: string; commissionBps: number; termMonths: number; note: string},
  database: FirestoreLike = firestoreDb,
): Promise<{commissionBps: number; termMonths: number}> {
  const role = requirePlatformConfigAdminClaim(token);
  const app = await loadApplication(database, input.appId);
  if (app.status === "approved") throw new DomainError("failed-precondition", "Change the rate of a live restaurant from its restaurant page.");
  const now = Date.now();
  const previous = rec(app.terms);
  const changed = Number(previous.commissionBps) !== input.commissionBps || Number(previous.termMonths) !== input.termMonths;
  const update: Rec = {
    terms: {commissionBps: input.commissionBps, termMonths: input.termMonths, note: str(input.note, 300), setAt: now, setBy: uid},
    updatedAt: now,
  };
  // New numbers mean a new agreement: an old signature never covers them.
  if (changed && rec(app.agreement).status === "signed") update.agreement = {status: "superseded", previous: app.agreement};
  await database.collection(APPLICATIONS).doc(input.appId).set(update, {merge: true});
  await database.collection("audit").doc(`app_terms_${input.appId}_${now}`).set({
    action: "restaurant_application.terms", target: input.appId, actorId: uid, actorRole: role,
    before: previous, after: update.terms, at: now,
  });
  return {commissionBps: input.commissionBps, termMonths: input.termMonths};
}

export async function requestRestaurantApplicationChanges(
  uid: string,
  token: DecodedIdToken,
  input: {appId: string; message: string},
  database: FirestoreLike = firestoreDb,
): Promise<void> {
  requirePlatformConfigAdminClaim(token);
  const now = Date.now();
  await database.collection(APPLICATIONS).doc(input.appId).set({
    status: "changes_requested", reviewMessage: str(input.message, 500), reviewedAt: now, reviewedBy: uid, updatedAt: now,
  }, {merge: true});
}

/** Short-lived links to the documents, for the admin review screen only. */
export async function getRestaurantApplicationReview(
  uid: string,
  token: DecodedIdToken,
  appId: string,
  database: FirestoreLike = firestoreDb,
  bucket = () => storage.bucket(),
): Promise<{links: Record<string, string>; issues: string[]; checks: Rec}> {
  requirePlatformConfigAdminClaim(token);
  const app = await loadApplication(database, appId);
  const paths: Record<string, string> = {};
  const fssai = rec(app.fssai), pan = rec(app.pan), bank = rec(app.bank), menu = rec(app.menu);
  if (str(fssai.photoPath)) paths.fssai = str(fssai.photoPath);
  if (str(pan.photoPath)) paths.pan = str(pan.photoPath);
  if (str(bank.proofPath)) paths.bank = str(bank.proofPath);
  (Array.isArray(menu.cardPhotoPaths) ? menu.cardPhotoPaths : []).slice(0, 6).forEach((p, i) => { paths[`menu${i + 1}`] = str(p); });
  if (str(rec(app.agreement).pdfPath)) paths.agreement = str(rec(app.agreement).pdfPath);
  const expires = Date.now() + 5 * 60_000;
  const links: Record<string, string> = {};
  for (const [key, path] of Object.entries(paths)) {
    const allowed = path.startsWith(`${DOC_PREFIX}${str(app.uid)}/`) || path.startsWith(`private/restaurant-agreements/${appId}/`);
    if (!allowed) continue;
    try {
      const [url] = await bucket().file(path).getSignedUrl({version: "v4", action: "read", expires});
      links[key] = url;
    } catch (error) {
      logger.warn("RESTAURANT_APPLICATION_LINK_FAILED", {appId, key, error: error instanceof Error ? error.message : "unknown"});
    }
  }
  const gst = app.gstin ? assessGstin(app.gstin, str(pan.number)) : null;
  await database.collection("audit").doc(`app_view_${appId}_${Date.now()}`).set({
    action: "restaurant_application.documents_viewed", target: appId, actorId: uid, at: Date.now(),
  });
  return {
    links,
    issues: applicationIssues(app),
    checks: {
      fssai: assessFssai(fssai.number),
      pan: validPan(pan.number),
      panNameMatches: normalizePersonName(pan.name) ? normalizePersonName(pan.name) === normalizePersonName(app.ownerName) ||
        normalizePersonName(pan.name) === normalizePersonName(app.legalName) : null,
      gstin: gst,
      gstMode: goodsGstMode(app) ?? "restaurant",
      gstEnrolment: str(app.gstEnrolment, 20),
      bank: bank.method === "upi" ? {method: "upi", ok: validUpi(bank.upiId)} : {method: "bank", ok: validIfsc(bank.ifsc)},
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "restaurant";
}

const OWNER_PERMISSIONS = {analytics: true, availability: true, dispatch: true, handover: true, menu: true, orders: true,
  profile: true, tracking: true, offers: true, bank: true};

/**
 * Turns a signed, checked application into a live (but closed) restaurant:
 * listing, owner membership, private payout profile, menu, and the agreed
 * commission on the listing so checkout charges exactly what was signed.
 */
export async function approveRestaurantApplication(
  uid: string,
  token: DecodedIdToken,
  appId: string,
  database: FirestoreLike = firestoreDb,
): Promise<{restaurantId: string}> {
  const role = requirePlatformConfigAdminClaim(token);
  const app = await loadApplication(database, appId);
  if (app.status === "approved" && str(app.restaurantId)) return {restaurantId: str(app.restaurantId)};
  const issues = applicationIssues(app);
  if (issues.length) throw new DomainError("failed-precondition", `Still missing: ${issues.join(", ")}.`);
  const agreement = rec(app.agreement);
  if (agreement.status !== "signed") throw new DomainError("failed-precondition", "The partner agreement isn't signed yet.");
  const ownerUid = str(app.uid);
  const now = Date.now();
  const restaurantId = `${slug(str(app.restaurantName))}-${ownerUid.slice(0, 6).toLowerCase()}`;
  const location = rec(app.location), fssai = rec(app.fssai), pan = rec(app.pan), bank = rec(app.bank), hours = rec(app.hours);
  const storeType = ["grocery", "dairy"].includes(str(app.storeType)) ? str(app.storeType) : "restaurant";
  const listing: Rec = {
    id: restaurantId, name: str(app.restaurantName, 120), phone: str(app.phone, 20), storeType,
    outletType: str(app.outletType, 40), address: str(location.address ?? app.address, 300), area: str(location.area, 80),
    city: str(location.city ?? app.city, 80), pincode: str(location.pincode, 6),
    lat: Number(location.lat), lng: Number(location.lng),
    cuisines: (Array.isArray(app.cuisines) ? app.cuisines : [str(app.cuisines)]).map((c) => str(c, 40)).filter(Boolean).slice(0, 8),
    opensAt: str(hours.open, 5), opensUntil: str(hours.close, 5), openDays: Array.isArray(hours.days) ? hours.days.slice(0, 7) : [],
    fssaiNumber: str(fssai.number, 14), fssaiKind: assessFssai(fssai.number).kind, fssaiExpiresOn: str(fssai.expiresOn, 10),
    commissionBps: Number(agreement.commissionBps), commissionTermMonths: Number(agreement.termMonths ?? 12),
    agreementVersion: str(agreement.version), agreementSignedAt: Number(agreement.signedAt),
    open: false, archived: false, rating: 0, ratingCount: 0, etaMin: 25, etaMax: 35, deliveryFee: 0, platformFee: 12,
    createdAt: now, updatedAt: now,
  };
  const payout: Rec = {
    legalBusinessName: str(app.legalName, 160) || str(app.restaurantName, 120),
    beneficiaryName: str(bank.holderName, 120) || str(app.ownerName, 120),
    contactPhone: str(app.phone, 20), contactEmail: str(app.email, 160),
    preferredMethod: bank.method === "upi" ? "upi" : "neft",
    upiId: str(bank.upiId, 256), bankAccountHolderName: str(bank.holderName, 120),
    bankAccountNumber: str(bank.accountNumber, 18), bankIfsc: str(bank.ifsc, 11).toUpperCase(),
    bankName: str(bank.bankName, 80), branchName: str(bank.branchName, 80), accountType: str(bank.accountType, 20) || "current",
    panNumber: str(pan.number, 10).toUpperCase(), gstin: str(app.gstin, 15).toUpperCase(), notes: "From sign-up", updatedAt: now,
  };
  const dishes = (Array.isArray(rec(app.menu).dishes) ? rec(app.menu).dishes as unknown[] : []).slice(0, 60);
  const batch = database.batch();
  batch.set(restaurantRef(database, restaurantId), listing);
  batch.set(database.collection(RESTAURANT_PAYOUT_PROFILES_COLLECTION).doc(restaurantId), payout);
  batch.set(restaurantMemberRef(database, restaurantId, ownerUid), {
    active: true, email: str(app.email), name: str(app.ownerName), permissions: OWNER_PERMISSIONS, restaurantId,
    restaurantName: str(app.restaurantName), role: "restaurant_owner", createdAt: now, createdBy: uid,
  });
  batch.set(database.collection("userRestaurants").doc(ownerUid), {[restaurantId]: true}, {merge: true});
  dishes.forEach((raw, index) => {
    const dish = rec(raw);
    const id = `item_${now.toString(36)}${index}`;
    batch.set(menuItemRef(database, restaurantId, id), {
      id, name: str(dish.name, 80), description: "", category: str(dish.category, 40) || "Menu", price: Math.max(0, Math.round(Number(dish.price) || 0)),
      diet: ["veg", "nonveg", "egg"].includes(str(dish.diet)) ? str(dish.diet) : "veg", preparationTime: 20,
      available: true, popular: index < 3, archived: false, updatedAt: now, updatedBy: "sign-up",
      // Packaged goods: the owner completes the label details (brand, FSSAI, HSN) in the app before it shows.
      ...(storeType === "restaurant" ? {} : {compliance: {netQuantity: str(dish.packSize, 40), mrp: Math.max(0, Math.round(Number(dish.price) || 0))}}),
    });
  });
  batch.set(database.collection(APPLICATIONS).doc(appId), {
    status: "approved", restaurantId, approvedAt: now, reviewedAt: now, reviewedBy: uid, updatedAt: now,
  }, {merge: true});
  batch.set(database.collection("audit").doc(`app_approve_${appId}_${now}`), {
    action: "restaurant_application.approve", target: appId, restaurantId, actorId: uid, actorRole: role,
    commissionBps: listing.commissionBps, at: now,
  });
  await batch.commit();
  logger.info("RESTAURANT_APPLICATION_APPROVED", {appId, restaurantId, commissionBps: listing.commissionBps});
  return {restaurantId};
}
