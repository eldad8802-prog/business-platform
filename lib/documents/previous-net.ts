/**
 * Pure derivation of the previous month's net cash-flow from the two
 * FinancialRecord aggregate sums (income + expense). Extracted from the
 * `summaryOnly` handler in app/api/documents/inbox/route.ts so the logic can be
 * unit-tested without Prisma — behavior-equivalent to the previous inline code.
 *
 * Prisma's `_sum.amount` is `null` ONLY when zero rows matched. So when BOTH the
 * income and expense sums are null, there is genuinely no prior-month data:
 * return `null` (never 0) so the client hides the delta rather than implying a
 * real "no change" signal. Otherwise net = income - expense (missing side → 0).
 */
export function derivePreviousNet(
  prevIncomeSum: number | null,
  prevExpenseSum: number | null
): number | null {
  if (prevIncomeSum == null && prevExpenseSum == null) return null;
  return (prevIncomeSum ?? 0) - (prevExpenseSum ?? 0);
}
