import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", () => ({firestoreDb: {}, storage: {}, db: {}, auth: {}}));
vi.mock("../src/services/faceVerification", () => ({faceSimilarity: vi.fn()}));

const {aadhaarPhotoToJpeg, summarizeIdentity} = await import("../src/services/riderIdentity");
const {parseSecureQr} = await import("../src/domain/aadhaarSecureQr");

const qr = parseSecureQr(readFileSync(join(__dirname, "fixtures/aadhaar/uidai-sample-v1.txt"), "utf8"));
const licence = {vehicleType: "Motorcycle", dlNumber: "AP03 2021 0012345", dlValidTill: "2040-01-01"};
const aadhaar = {last4: qr.last4, name: qr.name, dob: qr.dob, gender: qr.gender, address: qr.address, keyId: "k", issuedAt: 1, verifiedAt: 2};

describe("rider identity", () => {
  it("turns the QR photo into a 240px JPEG", async () => {
    const jpeg = await aadhaarPhotoToJpeg(qr.photo);
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpeg.length).toBeGreaterThan(3000);
  });

  it("is verified only when every check passes", () => {
    const rider = {panNumber: "ABCPP1234F", faceReferenceObjectPath: "private/rider-face/u/reference", ...licence};
    const identity = {aadhaar, faceSimilarity: 93, faceComparedFor: rider.faceReferenceObjectPath, panDuplicateOf: ""};
    const summary = summarizeIdentity(rider, {...identity, panRegistry: {pan: String(rider.panNumber).toUpperCase(), result: "active_match", checkedAt: 5}}, 10);
    expect(summary.status).toBe("verified");
    expect(summary.reasons).toEqual([]);
    expect(summary.pan?.registry).toEqual({result: "active_match", checkedAt: 5});
    expect(summary.aadhaar?.last4).toBe("8908");
    expect(summary.face).toEqual({status: "match", similarity: 93});
  });
  it("waits for the Income Tax portal check, and a changed PAN needs a new one", () => {
    const rider = {panNumber: "ABCPP1234F", faceReferenceObjectPath: "private/rider-face/u/reference", ...licence};
    const identity = {aadhaar, faceSimilarity: 93, faceComparedFor: rider.faceReferenceObjectPath, panDuplicateOf: ""};
    const unchecked = summarizeIdentity(rider, identity, 10);
    expect(unchecked.status).toBe("review");
    expect(unchecked.reasons).toEqual(["PAN not checked on the Income Tax portal yet"]);
    const stale = summarizeIdentity(rider, {...identity, panRegistry: {pan: "ZZZPZ9999Z", result: "active_match", checkedAt: 5}}, 10);
    expect(stale.reasons).toEqual(["PAN not checked on the Income Tax portal yet"]);
    const mismatch = summarizeIdentity(rider, {...identity, panRegistry: {pan: String(rider.panNumber).toUpperCase(), result: "mismatch", checkedAt: 5}}, 10);
    expect(mismatch.reasons[0]).toMatch(/doesn’t match on the Income Tax portal/);
  });

  it("needs a valid driving licence for a motor vehicle, and none for a bicycle", () => {
    const base = {panNumber: "ABCPP1234F", faceReferenceObjectPath: "ref"};
    const identity = {aadhaar, faceSimilarity: 93, faceComparedFor: "ref", panDuplicateOf: "", panRegistry: {pan: "ABCPP1234F", result: "active_match", checkedAt: 5}};
    const now = Date.UTC(2026, 9, 12, 6);
    const ok = summarizeIdentity({...base, ...licence}, identity, now);
    expect(ok.licence).toEqual({required: true, number: "AP0320210012345", formatOk: true, validTill: "2040-01-01", expired: false});
    expect(ok.status).toBe("verified");
    expect(summarizeIdentity({...base, vehicleType: "Scooter"}, identity, now).reasons).toEqual(["Driving licence not given"]);
    expect(summarizeIdentity({...base, ...licence, dlNumber: "12345"}, identity, now).reasons).toEqual(["Driving licence number looks wrong"]);
    expect(summarizeIdentity({...base, ...licence, dlValidTill: ""}, identity, now).reasons).toEqual(["Driving licence valid-till date not given"]);
    expect(summarizeIdentity({...base, ...licence, dlValidTill: "2026-10-11"}, identity, now).reasons).toEqual(["Driving licence expired on 11/10/2026"]);
    expect(summarizeIdentity({...base, ...licence, dlValidTill: "2026-10-12"}, identity, now).licence.expired).toBe(false);
    const bike = summarizeIdentity({...base, vehicleType: "Bicycle"}, identity, now);
    expect(bike.licence.required).toBe(false);
    expect(bike.status).toBe("verified");
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
