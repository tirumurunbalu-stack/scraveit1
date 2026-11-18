import {describe, expect, it} from "vitest";
import {nearestStoreKm, returnTripFee, returnTripPolicy} from "../src/domain/returnTrip";

const naidupetaStore = {lat: 13.917611, lng: 79.895976};
const waffleSpot = {lat: 13.91747864, lng: 79.89603288};
const menakuru = {lat: 13.9169403, lng: 79.8415058};
const inTown = {lat: 13.9100, lng: 79.8990};

describe("return-trip pay", () => {
  const policy = returnTripPolicy({returnTripPerKm: 10, returnTripFreeKm: 2});

  it("is off unless a per-km rate is set", () => {
    expect(returnTripPolicy({}).perKm).toBe(0);
    expect(returnTripFee(menakuru, [naidupetaStore], returnTripPolicy({}))).toEqual({km: 0, fee: 0});
  });

  it("pays nothing for an in-town drop", () => {
    expect(returnTripFee(inTown, [naidupetaStore, waffleSpot], policy).fee).toBe(0);
  });

  it("pays the ride back from Menakuru to the nearest Naidupeta store", () => {
    const result = returnTripFee(menakuru, [naidupetaStore, waffleSpot], policy);
    expect(nearestStoreKm(menakuru, [naidupetaStore])).toBeCloseTo(5.9, 1);
    expect(result.km).toBeCloseTo(3.9, 1);
    expect(result.fee).toBe(39);
  });

  it("measures the ride back in road km and keeps the paise (founder's ₹5/km beyond 2 km table)", () => {
    const five = returnTripPolicy({returnTripPerKm: 5, returnTripFreeKm: 2});
    const straight = nearestStoreKm(menakuru, [naidupetaStore]) as number;
    // Menakuru: 8.1 road km → 6.1 km back beyond 2 km → ₹30.50
    expect(returnTripFee(menakuru, [naidupetaStore], five, 8.1 / straight)).toEqual({km: 6.1, fee: 30.5});
    // a nearer store counts with the same road factor
    const near = {lat: 13.9172, lng: 79.8600};
    const viaNear = returnTripFee(menakuru, [naidupetaStore, near], five, 8.1 / straight);
    expect(viaNear.fee).toBeLessThan(30.5);
    expect(returnTripFee(menakuru, [naidupetaStore], five, 0.5).fee).toBe(returnTripFee(menakuru, [naidupetaStore], five, 1).fee);
  });

  it("disappears when a store opens near the drop", () => {
    const menakuruStore = {lat: 13.9172, lng: 79.8420};
    expect(returnTripFee(menakuru, [naidupetaStore, menakuruStore], policy).fee).toBe(0);
  });

  it("ignores stores without a location and caps the rate", () => {
    expect(returnTripFee(menakuru, [{lat: 0, lng: 0}, {lat: NaN, lng: 1}], policy)).toEqual({km: 0, fee: 0});
    expect(returnTripPolicy({returnTripPerKm: 500}).perKm).toBe(50);
  });
});
