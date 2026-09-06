import {createHash} from "node:crypto";

export const PUBLIC_MEDIA_MAX_BYTES = 2_500_000;
export const KYC_MEDIA_MAX_BYTES = 1_500_000;
export const PUBLIC_MEDIA_DAILY_LIMIT = {count: 100, bytes: 100_000_000} as const;
export const KYC_MEDIA_DAILY_LIMIT = {count: 12, bytes: 12_000_000} as const;

export type SupportedImageType = "image/jpeg" | "image/png" | "image/webp";
export type UploadQuota = {count: number; bytes: number; updatedAt: number};

export interface InspectedImage {
  buffer: Buffer;
  contentType: SupportedImageType;
  width: number;
  height: number;
  sha256: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function decodeCanonicalBase64(encoded: string, maxBytes: number): Buffer {
  if (encoded.length === 0 || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return fail("INVALID_IMAGE_BASE64");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.toString("base64") !== encoded) {
    return fail("IMAGE_SIZE_INVALID");
  }
  return buffer;
}

function jpegDimensions(buffer: Buffer): {width: number; height: number} {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 ||
      buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
    return fail("IMAGE_SIGNATURE_MISMATCH");
  }
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return fail("MALFORMED_JPEG");
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return fail("MALFORMED_JPEG");
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return fail("MALFORMED_JPEG");
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return fail("MALFORMED_JPEG");
      return {height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5)};
    }
    offset += segmentLength;
  }
  return fail("JPEG_DIMENSIONS_MISSING");
}

function pngDimensions(buffer: Buffer): {width: number; height: number} {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    return fail("IMAGE_SIGNATURE_MISMATCH");
  }
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return Number(buffer[offset]) | (Number(buffer[offset + 1]) << 8) | (Number(buffer[offset + 2]) << 16);
}

function webpDimensions(buffer: Buffer): {width: number; height: number} {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return fail("IMAGE_SIGNATURE_MISMATCH");
  }
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return {width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1};
  }
  if (kind === "VP8 ") {
    if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return fail("MALFORMED_WEBP");
    }
    return {width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff};
  }
  if (kind === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 0x2f) return fail("MALFORMED_WEBP");
    const b1 = Number(buffer[21]);
    const b2 = Number(buffer[22]);
    const b3 = Number(buffer[23]);
    const b4 = Number(buffer[24]);
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  return fail("UNSUPPORTED_WEBP_ENCODING");
}

export function inspectRasterImage(
  encoded: string,
  contentType: SupportedImageType,
  purpose: "public" | "kyc",
  suppliedSha256?: string,
): InspectedImage {
  const buffer = decodeCanonicalBase64(encoded, purpose === "kyc" ? KYC_MEDIA_MAX_BYTES : PUBLIC_MEDIA_MAX_BYTES);
  const dimensions = contentType === "image/jpeg" ? jpegDimensions(buffer) :
    contentType === "image/png" ? pngDimensions(buffer) : webpDimensions(buffer);
  const minWidth = purpose === "kyc" ? 600 : 240;
  const minHeight = purpose === "kyc" ? 400 : 240;
  if (dimensions.width < minWidth || dimensions.height < minHeight || dimensions.width > 5000 || dimensions.height > 5000 ||
      dimensions.width * dimensions.height > 16_000_000) return fail("IMAGE_DIMENSIONS_INVALID");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (suppliedSha256 && suppliedSha256.toLowerCase() !== sha256) return fail("IMAGE_HASH_MISMATCH");
  return {buffer, contentType, ...dimensions, sha256};
}

export function reserveUploadQuota(
  current: UploadQuota | null,
  bytes: number,
  limit: {count: number; bytes: number},
  now: number,
): UploadQuota {
  if (!Number.isInteger(bytes) || bytes <= 0) return fail("INVALID_UPLOAD_SIZE");
  const count = Number(current?.count ?? 0) + 1;
  const totalBytes = Number(current?.bytes ?? 0) + bytes;
  if (count > limit.count || totalBytes > limit.bytes) return fail("UPLOAD_QUOTA_EXCEEDED");
  return {count, bytes: totalBytes, updatedAt: now};
}

export function utcDayKey(now: number): string {
  if (!Number.isFinite(now)) return fail("INVALID_TIMESTAMP");
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

export function publicObjectUrl(bucket: string, objectPath: string, generation: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}?alt=media&generation=${encodeURIComponent(generation)}`;
}
