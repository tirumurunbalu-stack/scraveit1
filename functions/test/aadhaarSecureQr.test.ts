import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {aadhaarHolderKey, ageOn, assessPan, parseSecureQr, uidaiSigner} from "../src/domain/aadhaarSecureQr";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/aadhaar", name), "utf8").trim();

describe("Aadhaar Secure QR", () => {
  it("reads UIDAI's sample card (old format)", () => {
    const qr = parseSecureQr(fixture("uidai-sample-v1.txt"));
    expect(qr.version).toBe("V1");
    expect(qr.name).toBe("Penumarthi Venkat");
    expect(qr.dob).toBe("1987-05-07");
    expect(qr.gender).toBe("M");
    expect(qr.last4).toBe("8908");
    expect(qr.address.district).toBe("East Godavari");
    expect(qr.address.state).toBe("Andhra Pradesh");
    expect(qr.address.pincode).toBe("533016");
    expect(qr.photo.subarray(0, 4).toString("hex")).toBe("ff4fff51");
    expect(qr.mobileHashPresent).toBe(true);
  });

  it("does not treat a test-key QR as genuine", () => {
    expect(uidaiSigner(parseSecureQr(fixture("uidai-sample-v1.txt")))).toBeNull();
  });

  it("verifies a V2 QR against the key that signed it, and rejects any change", () => {
    const qr = parseSecureQr(fixture("test-signed-v2.txt"));
    expect(qr.version).toBe("V2");
    expect(qr.name).toBe("Sumit Kumar");
    const certs = [{id: "test", pem: fixture("test-certificate.pem")}];
    expect(uidaiSigner(qr, certs)).toBe("test");
    const tampered = {...qr, signedBytes: Buffer.from(qr.signedBytes)};
    tampered.signedBytes[40] ^= 1;
    expect(uidaiSigner(tampered, certs)).toBeNull();
    expect(uidaiSigner(qr)).toBeNull();
  });

  it("refuses anything that isn't a secure QR", () => {
    expect(() => parseSecureQr("hello")).toThrow();
    expect(() => parseSecureQr("1".repeat(500))).toThrow();
  });

  it("works out age, a holder key and PAN checks", () => {
    expect(ageOn("2008-10-05", Date.UTC(2026, 9, 4))).toBe(17);
    expect(ageOn("2008-10-04", Date.UTC(2026, 9, 4, 12))).toBe(18);
    const key = aadhaarHolderKey({last4: "8908", dob: "1987-05-07", name: "Penumarthi  venkat", gender: "M"});
    expect(key).toBe(aadhaarHolderKey({last4: "8908", dob: "1987-05-07", name: "PENUMARTHI VENKAT", gender: "M"}));
    expect(assessPan("ABCPP1234F", "Penumarthi Venkat")).toEqual({formatOk: true, individual: true, nameInitialMatch: true});
    expect(assessPan("ABCPX1234F", "Penumarthi Venkat").nameInitialMatch).toBe(false);
    expect(assessPan("ABCCP1234F").individual).toBe(false);
    expect(assessPan("ABC1234").formatOk).toBe(false);
  });
});
