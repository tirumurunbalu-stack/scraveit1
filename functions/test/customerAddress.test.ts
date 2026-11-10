import {describe, expect, it, vi} from "vitest";

vi.mock("../src/admin", async () => {
  const {InMemoryFirestore} = await import("./helpers/inMemoryFirestore");
  return {firestoreDb: new InMemoryFirestore()};
});

import {firestoreDb} from "../src/admin";
import {addressPhotoUrl, loadCustomerAddress} from "../src/services/catalog";

const uid = "cust123";
const photo = `https://firebasestorage.googleapis.com/v0/b/savrivo-app-mumbai/o/addressPhotos%2F${uid}%2Fplace_abc123.jpg?alt=media&token=0f8b4c2e-1a2b-4c3d-9e8f-0123456789ab`;

describe("delivery address on the order", () => {
  it("carries the door, landmark, street and the customer's own place photo", async () => {
    await firestoreDb.collection("users").doc(uid).set({phone: "9876543210", addresses: [{
      id: "addr_1", label: "Home", house: "Flat 204, 2nd floor", landmark: "Opposite Ganesh temple",
      street: "Rama Street, Naidupeta, Andhra Pradesh 524126", area: "Naidupeta", city: "Naidupeta",
      address: "Flat 204, 2nd floor, Rama Street, Naidupeta · Landmark: Opposite Ganesh temple",
      lat: 14.0, lng: 79.9, source: "manual", photoUrl: photo,
    }]});
    const {address} = await loadCustomerAddress(uid, "addr_1");
    expect(address).toMatchObject({house: "Flat 204, 2nd floor", landmark: "Opposite Ganesh temple", street: "Rama Street, Naidupeta, Andhra Pradesh 524126", photoUrl: photo, phone: "9876543210"});
  });

  it("leaves the new fields off addresses saved before them", async () => {
    await firestoreDb.collection("users").doc("old").set({phone: "9876543210", addresses: [{id: "a", label: "Home", area: "Naidupeta", address: "12-3, Rama Street", lat: 14, lng: 79.9}]});
    const {address} = await loadCustomerAddress("old", "a");
    expect(address).not.toHaveProperty("house");
    expect(address).not.toHaveProperty("photoUrl");
  });
});

describe("place photo link", () => {
  it("accepts only the customer's own upload in this project's buckets", () => {
    expect(addressPhotoUrl(uid, photo)).toBe(photo);
    expect(addressPhotoUrl("someoneElse", photo)).toBe("");
    expect(addressPhotoUrl(uid, photo.replace("savrivo-app-mumbai", "evil-bucket"))).toBe("");
    expect(addressPhotoUrl(uid, photo.replace("addressPhotos", "reelThumbs"))).toBe("");
    expect(addressPhotoUrl(uid, "https://example.com/gate.jpg")).toBe("");
    expect(addressPhotoUrl(uid, photo + "&x=<script>")).toBe("");
    expect(addressPhotoUrl(uid, undefined)).toBe("");
  });
});
