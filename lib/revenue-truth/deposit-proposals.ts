/**
 * Revenue truth — settlement ↔ bank deposit PROPOSALS (owner decision D-6, docs/revenue-report-uploads.md). Pure.
 *
 *   - The system PROPOSES; the owner confirms. A proposal is a set of `SETTLEMENT_DEPOSITED_AS` link inputs
 *     (basis RULE_EXACT, proposedBy SYSTEM) for lib/revenue-truth/store `proposeLink`; it closes nothing until the
 *     owner's CONFIRMED decision on each link (the read model counts confirmed links only).
 *   - EXACT sums only: one settlement whose net equals the deposit, or all of one acquirer's batches of that day, or all
 *     batches of that day, adding up to the deposit to the agora. Several batches into one deposit = several links on
 *     that deposit, each carrying its settlement's whole net (`linkedMinor`).
 *   - No tolerance, no write-off: there is no "within ₪1" here. A deposit without an exact match is listed with every
 *     candidate and its difference, for the owner to look at — nothing is auto-reconciled.
 *   - Ambiguity is never resolved by a guess: two settlements (or two deposits) that would match the same way → no
 *     proposal, all of them listed.
 *   - Same day only: a settlement's value date is the day the acquirer credits it; a deposit is matched to settlements
 *     whose value date is the deposit's booking day. Nothing here shifts a day.
 *
 * Proven on synthetic inputs (read-model.test.ts) — the rules, not any real acquirer's or bank's export.
 * NOT CONNECTED: no route, page or job calls this.
 */
import type { CurrencyCode } from "@/lib/money/currency";
import type { LinkInput } from "./store";

const ZERO = BigInt(0);

export type SettlementForMatch = { id: number; acquirer: string; valueDate: string; currency: CurrencyCode; netMinor: bigint };
export type DepositForMatch = { id: number; bookingDay: string; currency: CurrencyCode; amountMinor: bigint };

export type DepositProposal = {
  depositId: number;
  settlementIds: number[];
  /** How it was found: one settlement, one acquirer's batches of the day, or all batches of the day. */
  rule: "SINGLE" | "ACQUIRER_DAY" | "DAY";
  /** Always 0: only exact sums are proposed. */
  differenceMinor: bigint;
  links: LinkInput[];
};

export type CandidateGroup = { settlementIds: number[]; sumMinor: bigint; /** sum − deposit */ differenceMinor: bigint };
export type UnmatchedDeposit = { depositId: number; reason: "NO_EXACT_MATCH" | "AMBIGUOUS"; candidates: CandidateGroup[] };

export type DepositProposals = {
  proposals: DepositProposal[];
  unmatchedDeposits: UnmatchedDeposit[];
  /** Settlements no proposal used (still awaiting a deposit). */
  unmatchedSettlementIds: number[];
};

const sum = (rows: readonly { netMinor: bigint }[]) => rows.reduce((s, r) => s + r.netMinor, ZERO);
const ids = (rows: readonly { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

/**
 * `settlements` and `deposits` are the OPEN ones: not rejected, not already (confirmed or proposed) linked — the caller
 * leaves those out. Settlements with a net ≤ 0 are never proposed.
 */
export function proposeSettlementDeposits(settlements: readonly SettlementForMatch[], deposits: readonly DepositForMatch[]): DepositProposals {
  const used = new Set<number>();
  const proposals: DepositProposal[] = [];
  const unmatchedDeposits: UnmatchedDeposit[] = [];
  const open = settlements.filter((s) => s.netMinor > ZERO);
  const sorted = [...deposits].sort((a, b) => a.id - b.id);

  const proposal = (d: DepositForMatch, rule: DepositProposal["rule"], rows: SettlementForMatch[]): DepositProposal => ({
    depositId: d.id,
    settlementIds: ids(rows),
    rule,
    differenceMinor: ZERO,
    links: rows.map((s) => ({
      linkKind: "SETTLEMENT_DEPOSITED_AS",
      settlementId: s.id,
      externalTransactionId: d.id,
      amountMinor: s.netMinor,
      currency: d.currency,
      basis: "RULE_EXACT",
      proposedBy: "SYSTEM",
    })),
  });

  for (const d of sorted) {
    const sameDay = open.filter((s) => !used.has(s.id) && s.currency === d.currency && s.valueDate === d.bookingDay);
    // Another deposit of the same day, currency and amount: which one is which cannot be known — none is proposed.
    const twin = sorted.some((o) => o.id !== d.id && o.currency === d.currency && o.bookingDay === d.bookingDay && o.amountMinor === d.amountMinor);

    const singles = sameDay.filter((s) => s.netMinor === d.amountMinor);
    const groups: { rule: "ACQUIRER_DAY" | "DAY"; rows: SettlementForMatch[] }[] = [];
    for (const acquirer of [...new Set(sameDay.map((s) => s.acquirer))].sort()) {
      const rows = sameDay.filter((s) => s.acquirer === acquirer);
      if (rows.length > 1) groups.push({ rule: "ACQUIRER_DAY", rows });
    }
    if (sameDay.length > 1 && new Set(sameDay.map((s) => s.acquirer)).size > 1) groups.push({ rule: "DAY", rows: sameDay });
    const exactGroups = groups.filter((g) => sum(g.rows) === d.amountMinor);

    const candidates: CandidateGroup[] = [
      ...sameDay.map((s) => ({ settlementIds: [s.id], sumMinor: s.netMinor, differenceMinor: s.netMinor - d.amountMinor })),
      ...groups.map((g) => ({ settlementIds: ids(g.rows), sumMinor: sum(g.rows), differenceMinor: sum(g.rows) - d.amountMinor })),
    ];

    if (!twin && singles.length === 1 && exactGroups.length === 0) {
      proposals.push(proposal(d, "SINGLE", singles));
      used.add(singles[0].id);
    } else if (!twin && singles.length === 0 && exactGroups.length === 1) {
      proposals.push(proposal(d, exactGroups[0].rule, exactGroups[0].rows));
      for (const s of exactGroups[0].rows) used.add(s.id);
    } else {
      const ambiguous = twin ? singles.length + exactGroups.length > 0 : singles.length + exactGroups.length > 1;
      unmatchedDeposits.push({ depositId: d.id, reason: ambiguous ? "AMBIGUOUS" : "NO_EXACT_MATCH", candidates });
    }
  }
  return { proposals, unmatchedDeposits, unmatchedSettlementIds: ids(open.filter((s) => !used.has(s.id))) };
}
