import {describe, expect, it} from "vitest";
import {DEFAULT_PAYOUT_FEE_TABLE, normalizePayoutFeeTable, payoutAfterFee, payoutTransferFeePaise} from "../src/domain/payoutFees";

describe("payout transfer fees", () => {
  it("charges each method by amount band, GST included", () => {
    expect(payoutTransferFeePaise("neft", 800_00)).toBe(354);
    expect(payoutTransferFeePaise("neft", 1_000_00)).toBe(354);
    expect(payoutTransferFeePaise("neft", 2_000_00)).toBe(590);
    expect(payoutTransferFeePaise("upi", 2_000_00)).toBe(944);
    expect(payoutTransferFeePaise("imps", 30_000_00)).toBe(1_770);
    expect(payoutTransferFeePaise("neft", 30_000_00)).toBe(944);
  });

  it("takes the fee from the payout", () => {
    expect(payoutAfterFee("neft", 2_000_00)).toEqual({feePaise: 590, transferPaise: 1_99_410});
    expect(payoutAfterFee("upi", 3_00)).toEqual({feePaise: 300, transferPaise: 0});
  });

  it("can be switched to Scraveit paying the fee", () => {
    const table = normalizePayoutFeeTable({...DEFAULT_PAYOUT_FEE_TABLE, deductFromPayout: false});
    expect(payoutAfterFee("neft", 2_000_00, table)).toEqual({feePaise: 0, transferPaise: 2_000_00});
  });

  it("reads an edited table and falls back to defaults when empty", () => {
    const table = normalizePayoutFeeTable({gstBps: 0, bands: [{upToPaise: 0, neftPaise: 100, impsPaise: 200, upiPaise: 0}]});
    expect(payoutTransferFeePaise("neft", 99_999_00, table)).toBe(100);
    expect(payoutTransferFeePaise("upi", 5_00, table)).toBe(0);
    expect(normalizePayoutFeeTable(null).bands).toHaveLength(3);
  });
});
