import {describe, expect, it} from "vitest";
import {riderSurgeFee} from "../src/domain/riderSurge";

const on = {riderSurgeEnabled: true};

describe("rider surge fee", () => {
  it("is off unless switched on", () => {
    expect(riderSurgeFee({}, {onlineRiders: 10, busyRiders: 10})).toBe(0);
  });

  it("rises as more of the city's online riders are already on orders", () => {
    expect(riderSurgeFee(on, {onlineRiders: 10, busyRiders: 6})).toBe(0);
    expect(riderSurgeFee(on, {onlineRiders: 10, busyRiders: 7})).toBe(10);
    expect(riderSurgeFee(on, {onlineRiders: 20, busyRiders: 17})).toBe(20);
    expect(riderSurgeFee(on, {onlineRiders: 10, busyRiders: 10})).toBe(30);
  });

  it("does not price on too few riders", () => {
    expect(riderSurgeFee(on, {onlineRiders: 2, busyRiders: 2})).toBe(0);
  });
});
