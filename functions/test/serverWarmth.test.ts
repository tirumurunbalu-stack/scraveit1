import {describe, expect, it} from "vitest";
import {inServiceHours, serverMode} from "../src/services/serverWarmth";

describe("server warmth switch", () => {
  it("reads the switch position from the two timers and the minimum", () => {
    expect(serverMode({timerOn: true, coldTimerOn: true, warmNow: true})).toBe("schedule");
    expect(serverMode({timerOn: true, coldTimerOn: true, warmNow: false})).toBe("schedule");
    expect(serverMode({timerOn: false, coldTimerOn: false, warmNow: true})).toBe("always");
    expect(serverMode({timerOn: false, coldTimerOn: true, warmNow: false})).toBe("cold");
    expect(serverMode({timerOn: false, coldTimerOn: true, warmNow: true})).toBe("mixed");
  });
  it("service hours are 7 AM up to midnight IST", () => {
    const ist = (h: number, m = 0) => Date.UTC(2026, 10, 14, h, m) - 5.5 * 3600_000;
    expect(inServiceHours(ist(6, 59))).toBe(false);
    expect(inServiceHours(ist(7))).toBe(true);
    expect(inServiceHours(ist(23, 59))).toBe(true);
    expect(inServiceHours(ist(0, 30))).toBe(false);
  });
});
