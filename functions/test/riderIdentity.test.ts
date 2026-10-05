import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {}, db: {}, auth: {}}));
vi.mock("../src/services/faceVerification", () => ({faceSimilarity: vi.fn()}));

const {aadhaarPhotoToJpeg, summarizeIdentity} = await import("../src/services/riderIdentity");
const {parseSecureQr} = await import("../src/domain/aadhaarSecureQr");

const qr = parseSecureQr(readFileSync(join(__dirname, "fixtures/aadhaar/uidai-sample-v1.txt"), "utf8"));
const aadhaar = {last4: qr.last4, name: qr.name, dob: qr.dob, gender: qr.gender, address: qr.address, keyId: "k", issuedAt: 1, verifiedAt: 2};

describe("rider identity", () => {
  it("turns the QR photo into a 240px JPEG", async () => {
    const jpeg = await aadhaarPhotoToJpeg(qr.photo);
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpeg.length).toBeGreaterThan(3000);
  });

  it("is verified only when every check passes", () => {
    const rider = {panNumber: "ABCPP1234F", faceReferenceObjectPath: "private/rider-face/u/reference"};
    const identity = {aadhaar, faceSimilarity: 93, faceComparedFor: rider.faceReferenceObjectPath, panDuplicateOf: ""};
    const summary = summarizeIdentity(rider, identity, 10);
    expect(summary.status).toBe("verified");
    expect(summary.reasons).toEqual([]);
    expect(summary.aadhaar?.last4).toBe("8908");
    expect(summary.face).toEqual({status: "match", similarity: 93});
  });

  it("explains every reason for a review", () => {
    const rider = {panNumber: "ABCCX1234F", faceReferenceObjectPath: "ref"};
    const summary = summarizeIdentity(rider, {aadhaar, faceSimilarity: 55, faceComparedFor: "ref", panDuplicateOf: "other", aadhaarDuplicateOf: "x"}, 10);
    expect(summary.status).toBe("review");
    expect(summary.reasons.join(" | ")).toMatch(/already used by another rider account/);
    expect(summary.reasons.join(" | ")).toMatch(/doesn’t match the Aadhaar photo \(55%\)/);
    expect(summary.reasons.join(" | ")).toMatch(/individual’s PAN/);
    expect(summary.reasons.join(" | ")).toMatch(/5th letter/);
  });

  it("is pending until Aadhaar is verified", () => {
    expect(summarizeIdentity({panNumber: "ABCPP1234F"}, null, 1).status).toBe("pending");
    expect(summarizeIdentity({identityFallback: "manual"}, null, 1).reasons[0]).toMatch(/manual review/);
  });
});
