/**
 * MA-T1 — MoneyAmount τ foundation (IN-MEMORY ONLY).
 *
 * Produces typed MoneyAmount candidates from DocumentRepresentation.tokens, so
 * that downstream layers can operate on QUANTITIES (commensurable magnitudes in
 * a unit of account) rather than on raw numerals. A numeral is promoted to a
 * MoneyAmount ONLY with positive money evidence (currency symbol / cents shape /
 * thousands shape / adjacent currency symbol). Bare numbers, phones, ids,
 * barcodes and years get NO money evidence → they are NOT MoneyAmounts.
 *
 * This is a WHITELIST by evidence, never a blocklist. It reads only symbols,
 * digit shapes and geometry — never words/labels. Additive: this layer changes
 * nothing in T3/T4/T5/T6, Production, or DB. It only adds a derived entity.
 */

import type {
  DocumentRepresentation,
  DocumentToken,
  Provenance,
  Strength,
} from "./document-representation";
import { parseMoneyShape } from "./document-amount-relations";
import { detectWithinTokenMarker } from "./document-money-marker";

export type Currency = "ILS" | "USD" | "EUR" | "GBP" | "unknown";

export type MoneyAmountEvidence =
  | "currency_symbol"
  | "adjacent_symbol"
  | "cents"
  | "thousands";

export type MoneyAmountResolutionState = "resolved" | "ambiguous" | "unresolved";

export type MoneyAmount = {
  magnitude: number;
  unit: Currency;
  /** Amounts sharing this key are commensurable (addable). Currently = unit. */
  commensurabilityKey: string;
  sourceTokens: DocumentToken[];
  moneyEvidence: MoneyAmountEvidence[];
  /** A non-positive magnitude is not a publishable amount (e.g. 0 / 0.00). */
  publishable: boolean;
  provenance: Provenance;
  resolutionState: MoneyAmountResolutionState;
  strength: Strength;
};

const SYMBOL_TO_CURRENCY: ReadonlyArray<[string, Currency]> = [
  ["₪", "ILS"],
  ["$", "USD"],
  ["€", "EUR"],
  ["£", "GBP"],
];

function symbolCurrency(value: string): Currency {
  for (const [sym, cur] of SYMBOL_TO_CURRENCY) if (value.includes(sym)) return cur;
  return "unknown";
}

function isPureCurrencySymbol(value: string): boolean {
  const t = value.trim();
  return t.length > 0 && t.length <= 2 && /^[₪$€£]+$/.test(t);
}

function geomKey(t: DocumentToken): string {
  const b = t.geometry.bbox;
  return b ? `p${t.page}:${b.x},${b.y}` : `p${t.page}:nobox`;
}

/** Nearest pure-currency-symbol token on the same line (geometry only), or null. */
function findAdjacentSymbol(
  numeric: DocumentToken,
  tokens: DocumentToken[]
): DocumentToken | null {
  const nb = numeric.geometry.bbox;
  if (!nb) return null;
  const ncy = nb.y + nb.height / 2;

  let best: DocumentToken | null = null;
  let bestGap = Infinity;

  for (const s of tokens) {
    if (!isPureCurrencySymbol(s.value) || !s.geometry.bbox) continue;
    const sb = s.geometry.bbox;
    const scy = sb.y + sb.height / 2;
    if (Math.abs(scy - ncy) > Math.max(sb.height, nb.height) * 0.6) continue;
    const gap = Math.max(sb.x - (nb.x + nb.width), nb.x - (sb.x + sb.width), 0);
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }

  if (best) {
    const sb = best.geometry.bbox!;
    const tol = Math.max(sb.width, sb.height) * 2;
    if (bestGap <= tol) return best;
  }
  return null;
}

function supportFor(e: MoneyAmountEvidence): Provenance {
  return {
    source: e === "adjacent_symbol" ? "geometry" : "shape",
    unit: e,
    derivedFrom: [],
  };
}

export function deriveMoneyAmounts(
  representation: DocumentRepresentation
): MoneyAmount[] {
  const tokens = representation.tokens;
  const amounts: MoneyAmount[] = [];

  for (const token of tokens) {
    const magnitude = parseMoneyShape(token.value);
    if (magnitude === null) continue; // not a numeral at all

    const within = detectWithinTokenMarker(token.value);
    const evidence: MoneyAmountEvidence[] = [];
    let unit: Currency = "unknown";
    let sourceTokens: DocumentToken[] = [token];

    if (within?.currencySymbol) {
      evidence.push("currency_symbol");
      unit = symbolCurrency(token.value);
    } else {
      const symbol = findAdjacentSymbol(token, tokens);
      if (symbol) {
        evidence.push("adjacent_symbol");
        unit = symbolCurrency(symbol.value);
        sourceTokens = [symbol, token];
      }
    }

    if (within?.cents) evidence.push("cents");
    if (within?.thousands) evidence.push("thousands");

    // No money evidence → this numeral is NOT a money amount (phones/ids/years).
    if (evidence.length === 0) continue;

    amounts.push({
      magnitude,
      unit,
      commensurabilityKey: unit,
      sourceTokens,
      moneyEvidence: evidence,
      publishable: Number.isFinite(magnitude) && magnitude > 0,
      provenance: {
        source: "money_amount",
        unit: "derived",
        derivedFrom: sourceTokens.map(geomKey),
      },
      resolutionState: "resolved",
      strength: { basis: "structural", supports: evidence.map(supportFor) },
    });
  }

  return amounts;
}
