import {X509Certificate, createHash, verify as verifySignature} from "node:crypto";
import {gunzipSync, inflateSync} from "node:zlib";
import {UIDAI_SIGNING_CERTIFICATES} from "./uidaiCertificates";

/**
 * Aadhaar Secure QR (the QR printed on every Aadhaar letter, PVC card,
 * e-Aadhaar and masked Aadhaar since 2018-19), read entirely offline.
 *
 * Format: the QR holds one big decimal number. As bytes it is a gzip stream;
 * inside, text fields are separated by byte 255, then the holder's photo
 * (JPEG 2000), then optional SHA-256 hashes of email/mobile, then a 256-byte
 * RSA-2048 signature (SHA256withRSA) over everything before it, made with
 * UIDAI's key. A valid signature proves UIDAI issued exactly this data. The
 * QR never holds the full Aadhaar number: only its last 4 digits.
 *
 * Old cards: [indicator, referenceId, name, dob, gender, careOf, district,
 *   landmark, house, location, pincode, postOffice, state, street,
 *   subDistrict, vtc, photo…]
 * V2 and later: ["V2"…, indicator, …same…, (later versions may add fields
 *   such as mobile last-4 before the photo)].
 */

export interface SecureQrIdentity {
  version: string;
  last4: string;
  issuedAt: number;
  name: string;
  /** ISO date, YYYY-MM-DD. */
  dob: string;
  gender: "M" | "F" | "T";
  address: {careOf: string; district: string; landmark: string; house: string; location: string;
    pincode: string; postOffice: string; state: string; street: string; subDistrict: string; vtc: string};
  emailHashPresent: boolean;
  mobileHashPresent: boolean;
  /** The holder's photo, JPEG 2000 codestream as stored in the QR. */
  photo: Buffer;
  signedBytes: Buffer;
  signature: Buffer;
}

export class SecureQrError extends Error {
  constructor(readonly code: "NOT_SECURE_QR" | "MALFORMED" | "BAD_SIGNATURE", message: string) { super(message); }
}

const LATIN1 = "latin1";

function bytesFromDecimal(digits: string): Buffer {
  const clean = digits.trim();
  if (!/^\d{200,12000}$/.test(clean)) throw new SecureQrError("NOT_SECURE_QR", "This isn’t an Aadhaar secure QR code.");
  let hex = BigInt(clean).toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function decompress(bytes: Buffer): Buffer {
  try { return gunzipSync(bytes); } catch { /* try the other wrapper */ }
  try { return inflateSync(bytes); } catch { /* fall through */ }
  throw new SecureQrError("NOT_SECURE_QR", "This isn’t an Aadhaar secure QR code.");
}

/** JPEG 2000: a raw codestream (FF 4F FF 51) or a JP2 file (signature box). */
function findPhotoStart(data: Buffer, from: number): number {
  const raw = data.indexOf(Buffer.from([0xff, 0x4f, 0xff, 0x51]), from);
  const box = data.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]), from);
  if (raw < 0) return box;
  if (box < 0) return raw;
  return Math.min(raw, box);
}

function parseDob(value: string): string {
  const dmy = value.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const ymd = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  // Some cards carry only the year of birth.
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  throw new SecureQrError("MALFORMED", "The date of birth in this QR couldn’t be read.");
}

function parseIssuedAt(reference: string): number {
  // referenceId = last 4 digits of Aadhaar + yyyyMMddHHmmssSSS
  const t = reference.slice(4).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{0,3})/);
  if (!t) return 0;
  const n = (i: number) => Number(t[i] ?? 0);
  return Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6), Number((t[7] || "0").padEnd(3, "0"))) - 5.5 * 60 * 60 * 1000;
}

export function parseSecureQr(qrDigits: string): SecureQrIdentity {
  const data = decompress(bytesFromDecimal(qrDigits));
  if (data.length < 256 + 64) throw new SecureQrError("MALFORMED", "This QR is incomplete. Scan it again.");
  const signature = data.subarray(data.length - 256);
  const signedBytes = data.subarray(0, data.length - 256);

  const firstDelimiter = data.indexOf(255);
  const first = data.subarray(0, firstDelimiter).toString(LATIN1);
  const versioned = /^V\d+$/i.test(first);
  const version = versioned ? first.toUpperCase() : "V1";
  // Text fields run up to the photo; split them on byte 255.
  const photoStart = findPhotoStart(data, firstDelimiter + 1);
  if (photoStart < 0) throw new SecureQrError("MALFORMED", "This QR has no photo. Use the QR on your Aadhaar card.");
  const text = data.subarray(0, photoStart).toString(LATIN1).split("ÿ");
  const offset = versioned ? 1 : 0;
  const field = (i: number) => (text[offset + i] ?? "").trim();
  const indicator = Number(field(0));
  const reference = field(1);
  if (!/^\d{4}/.test(reference)) throw new SecureQrError("MALFORMED", "This QR couldn’t be read. Scan it again.");
  const hashes = (indicator === 3 ? 2 : indicator === 1 || indicator === 2 ? 1 : 0) * 32;
  const genderRaw = field(4).toUpperCase();
  return {
    version,
    last4: reference.slice(0, 4),
    issuedAt: parseIssuedAt(reference),
    name: field(2),
    dob: parseDob(field(3)),
    gender: genderRaw.startsWith("M") ? "M" : genderRaw.startsWith("F") ? "F" : "T",
    address: {careOf: field(5), district: field(6), landmark: field(7), house: field(8), location: field(9),
      pincode: field(10), postOffice: field(11), state: field(12), street: field(13), subDistrict: field(14), vtc: field(15)},
    emailHashPresent: indicator === 1 || indicator === 3,
    mobileHashPresent: indicator === 2 || indicator === 3,
    photo: Buffer.from(data.subarray(photoStart, data.length - 256 - hashes)),
    signedBytes: Buffer.from(signedBytes),
    signature: Buffer.from(signature),
  };
}

/** Which UIDAI key signed this QR, or null if none did (tampered or not UIDAI). */
export function uidaiSigner(qr: SecureQrIdentity, certificates: ReadonlyArray<{id: string; pem: string}> = UIDAI_SIGNING_CERTIFICATES): string | null {
  for (const certificate of certificates) {
    try {
      const key = new X509Certificate(certificate.pem).publicKey;
      if (verifySignature("sha256", qr.signedBytes, key, qr.signature)) return certificate.id;
    } catch { /* a malformed certificate entry never verifies */ }
  }
  return null;
}

export function ageOn(dobIso: string, at: number): number {
  const [y = 0, m = 1, d = 1] = dobIso.split("-").map(Number);
  const now = new Date(at + 5.5 * 60 * 60 * 1000);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}

export function normalizeName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
}

/** A stable, non-reversible key for "the same Aadhaar holder" (never the Aadhaar number). */
export function aadhaarHolderKey(qr: Pick<SecureQrIdentity, "last4" | "dob" | "name" | "gender">): string {
  return createHash("sha256").update(`aadhaar-holder:v1|${qr.last4}|${qr.dob}|${normalizeName(qr.name)}|${qr.gender}`).digest("hex");
}

export interface PanAssessment {
  formatOk: boolean;
  individual: boolean;
  nameInitialMatch: boolean | null;
}

/**
 * Offline PAN checks (free): the 10-character pattern, the 4th character "P"
 * for an individual, and the 5th character, which is the first letter of the
 * holder's surname, against the initials of the Aadhaar name. This catches
 * typos and someone else's PAN; a paid PAN-registry check is added when TDS
 * goes live.
 */
export function assessPan(pan: string, aadhaarName?: string): PanAssessment {
  const value = String(pan || "").toUpperCase().trim();
  const formatOk = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value);
  const individual = formatOk && value[3] === "P";
  let nameInitialMatch: boolean | null = null;
  if (formatOk && aadhaarName) {
    const initials = normalizeName(aadhaarName).split(" ").filter(Boolean).map((part) => part[0]);
    nameInitialMatch = initials.includes(value[4]);
  }
  return {formatOk, individual, nameInitialMatch};
}

export function panKey(pan: string): string {
  return createHash("sha256").update(`pan:v1|${String(pan).toUpperCase().trim()}`).digest("hex");
}
