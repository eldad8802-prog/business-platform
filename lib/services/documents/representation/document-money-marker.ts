/**
 * Money class-marker (Amount slice only). IN-MEMORY, additive.
 *
 * A class-marker is a CLOSED SHAPE/SYMBOL signal that a numeric token is a
 * monetary amount — NOT a label/keyword and NOT a literal:
 *   - currency symbol: ₪ $ € £ (inside the token, or an adjacent symbol token)
 *   - decimal cents shape: NN.NN
 *   - thousands grouping: N,NNN
 *
 * It never reads words ("סהכ"/"total"/...), vendor/product names, and never
 * scores labels. It is evidence that ASSISTS structural choice; it is never the
 * sole picker when several marked candidates compete.
 */

import type { DocumentToken } from "./document-representation";
import { parseMoneyShape } from "./document-amount-relations";

export type MoneyClassMarker = {
  currencySymbol: boolean;
  cents: boolean;
  thousands: boolean;
  /** "within_token" when the marker is in the value itself; "adjacent_symbol"
   *  when conferred by a neighbouring pure-currency-symbol token (geometry). */
  source: "within_token" | "adjacent_symbol";
};

function hasCurrencySymbol(value: string): boolean {
  return /[₪$€£]/.test(value);
}
function hasPeriodCents(value: string): boolean {
  const compact = value.replace(/[₪$€£,\s]/g, "");
  return /\d\.\d{2}(?!\d)/.test(compact);
}
/** comma as decimal: a comma followed by 1–2 digits at the end (8,60), NOT a thousands group. */
function hasCommaDecimal(value: string): boolean {
  return /\d,\d{1,2}(?!\d)/.test(value);
}
function hasCents(value: string): boolean {
  return hasPeriodCents(value) || hasCommaDecimal(value);
}
function hasThousands(value: string): boolean {
  return /\d,\d{3}(?!\d)/.test(value);
}
function isPureCurrencySymbol(value: string): boolean {
  const t = value.trim();
  return t.length > 0 && t.length <= 2 && /^[₪$€£]+$/.test(t);
}

/** Marker derivable from the token's own characters, or null. */
export function detectWithinTokenMarker(value: string): MoneyClassMarker | null {
  const sym = hasCurrencySymbol(value);
  const cents = hasCents(value);
  const thou = hasThousands(value);
  if (!sym && !cents && !thou) return null;
  return { currencySymbol: sym, cents, thousands: thou, source: "within_token" };
}

/** True when the marker indicates a monetary amount at all. */
export function isMoneyAmountMarker(m: MoneyClassMarker | undefined): boolean {
  return Boolean(m && (m.currencySymbol || m.cents || m.thousands));
}

/** Strong marker = an explicit currency symbol (rarer; better disambiguator). */
export function hasStrongMarker(m: MoneyClassMarker | undefined): boolean {
  return Boolean(m && m.currencySymbol);
}

/**
 * Compute markers for all tokens: within-token shapes plus currency symbols
 * conferred from an adjacent pure-symbol token on the same line (geometry only).
 */
export function computeMoneyMarkers(
  tokens: DocumentToken[]
): Map<DocumentToken, MoneyClassMarker> {
  const markers = new Map<DocumentToken, MoneyClassMarker>();

  for (const t of tokens) {
    const within = detectWithinTokenMarker(t.value);
    if (within) markers.set(t, within);
  }

  const symbolTokens = tokens.filter(
    (t) => isPureCurrencySymbol(t.value) && t.geometry.bbox !== null
  );
  const numericTokens = tokens.filter(
    (t) => parseMoneyShape(t.value) !== null && t.geometry.bbox !== null
  );

  for (const s of symbolTokens) {
    const sb = s.geometry.bbox!;
    const scy = sb.y + sb.height / 2;
    let best: DocumentToken | null = null;
    let bestGap = Infinity;

    for (const n of numericTokens) {
      const nb = n.geometry.bbox!;
      const ncy = nb.y + nb.height / 2;
      // same line (relative to token heights)
      if (Math.abs(scy - ncy) > Math.max(sb.height, nb.height) * 0.6) continue;
      // horizontal edge gap (0 if overlapping)
      const gap = Math.max(sb.x - (nb.x + nb.width), nb.x - (sb.x + sb.width), 0);
      if (gap < bestGap) {
        bestGap = gap;
        best = n;
      }
    }

    // adjacency tolerance relative to the symbol's own size
    const tol = Math.max(sb.width, sb.height) * 2;
    if (best && bestGap <= tol) {
      const existing = markers.get(best);
      markers.set(best, {
        currencySymbol: true,
        cents: existing?.cents ?? false,
        thousands: existing?.thousands ?? false,
        source: existing ? existing.source : "adjacent_symbol",
      });
    }
  }

  return markers;
}
