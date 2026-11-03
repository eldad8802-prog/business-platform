/**
 * Revenue truth — the report shape that keeps the layers APART (owner decision D-13, docs/revenue-report-uploads.md).
 * Pure: a RevenueView in, one section per layer out.
 *
 * Sales (what was sold), settlements (what the acquirer credited, with its fees) and bank deposits (what reached the
 * bank) are the SAME money at three stages. Shown side by side they explain each other; added together they would
 * count one sale up to three times. So this shape has NO combined figure: no field adds one layer to another, and
 * `layersAreNotSummed` says so to whatever renders it. Per currency (never mixed).
 *
 * NOT CONNECTED: no page, route or job renders it yet. Proven on synthetic views (read-model.test.ts).
 */
import type { CurrencyCode } from "@/lib/money/currency";
import type { RevenueView } from "./read-model";

export type LayersReport = {
  currency: CurrencyCode;
  layersAreNotSummed: true;
  /** Layer 1: sales, from one authoritative source per register day (read-model.ts). */
  sales: { netMinor: bigint; vatMinor: bigint; fromClosedDaysMinor: bigint; fromOpenDaysMinor: bigint; fromDubizDocumentsMinor: bigint };
  /** Layer 3: acquirer / provider credits. The fee is shown, never booked as an expense here (D-7). */
  settlements: { grossMinor: bigint; feesMinor: bigint; otherDeductionsMinor: bigint; netMinor: bigint; awaitingDepositMinor: bigint };
  /** Layer 4: bank credits; `matched` = closed by confirmed links only. */
  deposits: { creditsMinor: bigint; matchedMinor: bigint; unmatchedMinor: bigint };
  /** Shown, not added: card takings not yet settled, cash not yet deposited. */
  inTransit: { cardAwaitingSettlementMinor: bigint; cashAwaitingDepositMinor: bigint };
};

export const LAYER_LABELS_HE = {
  sales: "מכירות",
  settlements: "זיכויים מחברות האשראי",
  deposits: "הפקדות בבנק",
  note: "אלה אותו כסף בשלבים שונים — לא מחברים אותם.",
} as const;

export function layersReportOf(view: RevenueView): LayersReport[] {
  return [...view.byCurrency.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((v) => ({
      currency: v.currency,
      layersAreNotSummed: true as const,
      sales: {
        netMinor: v.sales.netMinor,
        vatMinor: v.sales.vatMinor,
        fromClosedDaysMinor: v.sales.closedNetMinor,
        fromOpenDaysMinor: v.sales.provisionalNetMinor + v.sales.unclosedNetMinor,
        fromDubizDocumentsMinor: v.sales.documentNetMinor,
      },
      settlements: {
        grossMinor: v.settlements.grossMinor,
        feesMinor: v.settlements.feesMinor,
        otherDeductionsMinor: v.settlements.otherDeductionsMinor,
        netMinor: v.settlements.netMinor,
        awaitingDepositMinor: v.inTransit.settlementAwaitingDepositMinor,
      },
      deposits: { creditsMinor: v.deposits.creditsMinor, matchedMinor: v.deposits.matchedMinor, unmatchedMinor: v.deposits.unmatchedMinor },
      inTransit: { cardAwaitingSettlementMinor: v.inTransit.cardAwaitingSettlementMinor, cashAwaitingDepositMinor: v.inTransit.cashAwaitingDepositMinor },
    }));
}
