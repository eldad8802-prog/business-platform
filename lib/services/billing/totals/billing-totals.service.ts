import { Prisma } from "@prisma/client";
import {
  BillingHeaderTotals,
  BillingLineComputed,
  BillingLineParsed,
} from "../domain/billing.types";

const SCALE_MONEY = 2;
// decimal.js rounding mode: 4 = ROUND_HALF_UP. Matches standard fiscal rounding.
const ROUND_HALF_UP = 4;
const ONE_HUNDRED = new Prisma.Decimal(100);

export function computeLineTotals(
  parsed: BillingLineParsed
): BillingLineComputed {
  const lineSubtotal = parsed.quantity
    .times(parsed.unitPrice)
    .toDecimalPlaces(SCALE_MONEY, ROUND_HALF_UP);

  const vatAmount = lineSubtotal
    .times(parsed.vatRatePercent)
    .dividedBy(ONE_HUNDRED)
    .toDecimalPlaces(SCALE_MONEY, ROUND_HALF_UP);

  const lineTotal = lineSubtotal
    .plus(vatAmount)
    .toDecimalPlaces(SCALE_MONEY, ROUND_HALF_UP);

  return {
    ...parsed,
    lineSubtotal,
    vatAmount,
    lineTotal,
  };
}

export function computeHeaderTotals(
  lines: BillingLineComputed[]
): BillingHeaderTotals {
  let subtotalAmount = new Prisma.Decimal(0);
  let vatAmount = new Prisma.Decimal(0);

  for (const line of lines) {
    subtotalAmount = subtotalAmount.plus(line.lineSubtotal);
    vatAmount = vatAmount.plus(line.vatAmount);
  }

  const totalAmount = subtotalAmount.plus(vatAmount);

  return {
    subtotalAmount: subtotalAmount.toDecimalPlaces(SCALE_MONEY, ROUND_HALF_UP),
    vatAmount: vatAmount.toDecimalPlaces(SCALE_MONEY, ROUND_HALF_UP),
    totalAmount: totalAmount.toDecimalPlaces(SCALE_MONEY, ROUND_HALF_UP),
  };
}

export function recomputeAll(lines: BillingLineParsed[]): {
  lines: BillingLineComputed[];
  totals: BillingHeaderTotals;
} {
  const computed = lines.map(computeLineTotals);
  return {
    lines: computed,
    totals: computeHeaderTotals(computed),
  };
}
