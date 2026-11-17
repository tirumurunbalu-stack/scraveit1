import type {FinancePayoutMethod} from "./financePolicy";

/**
 * Founder 17 Nov 2026: weekly payouts go through Cashfree Payouts and the bank
 * transfer fee of the method the delivery partner / restaurant chose is taken
 * from that payout. The apps read the same table from settings/payoutFees and
 * show the fee under each option before they choose.
 *
 * Fees are Cashfree's charges before GST, in paise, per amount band; GST is added on top.
 */
export interface PayoutFeeBand {
  /** Upper limit of the band (inclusive), in paise; the last band has no limit (0). */
  upToPaise: number;
  neftPaise: number;
  impsPaise: number;
  upiPaise: number;
}

export interface PayoutFeeTable {
  /** true: the fee is taken from the payout; false: Scraveit pays it. */
  deductFromPayout: boolean;
  gstBps: number;
  bands: PayoutFeeBand[];
}

/** Cashfree's published pay-as-you-go Payouts rates (Nov 2026); change settings/payoutFees if the account is priced differently. */
export const DEFAULT_PAYOUT_FEE_TABLE: Readonly<PayoutFeeTable> = Object.freeze({
  deductFromPayout: true,
  gstBps: 1_800,
  bands: [
    {upToPaise: 1_000_00, neftPaise: 300, impsPaise: 600, upiPaise: 600},
    {upToPaise: 25_000_00, neftPaise: 500, impsPaise: 800, upiPaise: 800},
    {upToPaise: 0, neftPaise: 800, impsPaise: 1_500, upiPaise: 1_500},
  ],
});

function whole(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(max, Math.round(number)) : fallback;
}

export function normalizePayoutFeeTable(source: unknown): PayoutFeeTable {
  const raw = source && typeof source === "object" ? source as Record<string, unknown> : {};
  const fallback = DEFAULT_PAYOUT_FEE_TABLE;
  const bands = Array.isArray(raw.bands) ? raw.bands
    .map((band): PayoutFeeBand | null => {
      if (!band || typeof band !== "object") return null;
      const b = band as Record<string, unknown>;
      return {
        upToPaise: whole(b.upToPaise, 0, 1_000_000_000_00),
        neftPaise: whole(b.neftPaise, 0, 100_000),
        impsPaise: whole(b.impsPaise, 0, 100_000),
        upiPaise: whole(b.upiPaise, 0, 100_000),
      };
    })
    .filter((band): band is PayoutFeeBand => band !== null)
    .slice(0, 10) : [];
  // Open-ended band last; bands in ascending order of their limit.
  bands.sort((a, b) => (a.upToPaise || Number.MAX_SAFE_INTEGER) - (b.upToPaise || Number.MAX_SAFE_INTEGER));
  return {
    deductFromPayout: raw.deductFromPayout === undefined ? fallback.deductFromPayout : raw.deductFromPayout === true,
    gstBps: whole(raw.gstBps, fallback.gstBps, 5_000),
    bands: bands.length ? bands : fallback.bands.map((band) => ({...band})),
  };
}

/** The fee (GST included) Cashfree charges to send this amount by this method. */
export function payoutTransferFeePaise(method: FinancePayoutMethod, amountPaise: number, table: PayoutFeeTable = DEFAULT_PAYOUT_FEE_TABLE): number {
  const amount = Math.max(0, Math.round(Number(amountPaise) || 0));
  const band = table.bands.find((b) => b.upToPaise === 0 || amount <= b.upToPaise) ?? table.bands[table.bands.length - 1];
  if (!band) return 0;
  const base = method === "neft" ? band.neftPaise : method === "imps" ? band.impsPaise : band.upiPaise;
  return Math.round(base * (10_000 + table.gstBps) / 10_000);
}

/** What leaves for the partner's bank and what is kept for the fee. */
export function payoutAfterFee(method: FinancePayoutMethod, owedPaise: number, table: PayoutFeeTable = DEFAULT_PAYOUT_FEE_TABLE):
  {feePaise: number; transferPaise: number} {
  const owed = Math.max(0, Math.round(Number(owedPaise) || 0));
  const feePaise = table.deductFromPayout ? Math.min(owed, payoutTransferFeePaise(method, owed, table)) : 0;
  return {feePaise, transferPaise: owed - feePaise};
}
