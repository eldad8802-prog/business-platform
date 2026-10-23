/**
 * Secretary obligation totals never add currencies together (audit B4).
 * Run: npx tsx "app/(shell)/secretary/obligation-totals.test.ts"
 *
 * Pure. The two pre-change totals (page.tsx `sumObligationAmounts` + first-focus currency, and
 * secretary-ui.tsx `sumMoney` with `items[0].currency`) are kept verbatim below, with the two
 * screens' own formatters. For every all-ILS list — and every list in a single currency — the new
 * text is byte-identical to the old one in Hebrew and English; for mixed lists, each currency is
 * summed on its own and listed.
 */
import assert from "node:assert/strict";

import { formatObligationTotals, obligationTotalsByCurrency, type AmountInCurrency } from "./obligation-totals";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

// ── The two screens' formatters, verbatim (they are module-private there) ───────────────────
function formatHomeAmount(amount: string, currency: string, tag: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat(tag, { style: "currency", currency: currency || "ILS", maximumFractionDigits: 0 }).format(n);
  } catch {
    return n.toLocaleString(tag, { maximumFractionDigits: 0 }) + " " + currency;
  }
}
function formatMoneyValue(amount: string, currency: string, tag: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat(tag, { style: "currency", currency: currency || "ILS", maximumFractionDigits: 0 }).format(n);
  } catch {
    return n.toLocaleString(tag) + " ₪";
  }
}

// ── The pre-change totals, verbatim from main 06f425ea ───────────────────────────────────────
function legacyPageAllAmount(focus: AmountInCurrency | null, openItems: AmountInCurrency[], tag: string): string {
  const currency = focus?.currency ?? openItems[0]?.currency ?? "ILS";
  const sum = openItems.reduce((s, item) => {
    const amount = Number(item.amount);
    return Number.isFinite(amount) ? s + amount : s;
  }, 0);
  return formatHomeAmount(String(sum), currency, tag);
}
function legacySumMoney(items: AmountInCurrency[], tag: string): string {
  const currency = items[0]?.currency ?? "ILS";
  const amountNumber = (item: AmountInCurrency) => {
    const value = Number(item.amount);
    return Number.isFinite(value) ? value : 0;
  };
  const total = items.reduce((s, item) => s + amountNumber(item), 0);
  return formatMoneyValue(String(total), currency, tag);
}

const newPage = (items: AmountInCurrency[], tag: string) =>
  formatObligationTotals(obligationTotalsByCurrency(items), (a, c) => formatHomeAmount(a, c, tag));
const newUi = (items: AmountInCurrency[], tag: string) =>
  formatObligationTotals(obligationTotalsByCurrency(items), (a, c) => formatMoneyValue(a, c, tag));

function list(seed: number, currency: string): AmountInCurrency[] {
  return Array.from({ length: seed % 9 }, (_, i) => ({
    amount: i === 3 && seed % 4 === 0 ? "not-a-number" : ((seed * 7919 + i * 104729) % 9999999 / 100).toFixed(2),
    currency,
  }));
}

// 1. Compatibility: single-currency lists render exactly as before, both screens, both languages.
for (const tag of ["he-IL", "en-US"]) {
  for (const currency of ["ILS", "USD"]) {
    for (let seed = 0; seed < 60; seed++) {
      const items = list(seed, currency);
      eq(`page (${tag}, ${currency}, seed ${seed}) unchanged`, newPage(items, tag), legacyPageAllAmount(items[0] ?? null, items, tag));
      eq(`secretary-ui (${tag}, ${currency}, seed ${seed}) unchanged`, newUi(items, tag), legacySumMoney(items, tag));
    }
  }
  eq(`empty list (${tag}) unchanged`, newUi([], tag), legacySumMoney([], tag));
}
// Float order is preserved: the classic 0.1 + 0.2 still sums the same way it did.
eq("float order preserved", obligationTotalsByCurrency([{ amount: "0.1", currency: "ILS" }, { amount: "0.2", currency: "ILS" }]).total, 0.1 + 0.2);

// 2. Mixed: never added, headline ILS, each currency listed.
const mixed: AmountInCurrency[] = [
  { amount: "1000", currency: "USD" },
  { amount: "1200", currency: "ILS" },
  { amount: "300", currency: "USD" },
  { amount: "50", currency: "EUR" },
];
const totals = obligationTotalsByCurrency(mixed);
eq("mixed: headline is ILS even when the first row is USD", totals.currency, "ILS");
eq("mixed: headline total is ILS only", totals.total, 1200);
eq("mixed: lines, ILS first then by code", totals.totalsByCurrency, [
  { currency: "ILS", total: 1200 },
  { currency: "EUR", total: 50 },
  { currency: "USD", total: 1300 },
]);
eq("mixed: flagged", totals.isMixedCurrency, true);
const text = newUi(mixed, "en-US");
eq("mixed: text lists each currency, nothing added", text, "₪1,200 + €50 + $1,300");
assert.ok(!text.includes("2,550"), "the cross-currency sum 2,550 never appears");
checks += 1;
eq("mixed (he): each currency in the Hebrew formatter", newPage(mixed, "he-IL"), [
  formatHomeAmount("1200", "ILS", "he-IL"),
  formatHomeAmount("50", "EUR", "he-IL"),
  formatHomeAmount("1300", "USD", "he-IL"),
].join(" + "));
eq("only USD: shown in USD in full", newUi([{ amount: "70", currency: "USD" }], "en-US"), "$70");

console.log(`obligation-totals: PASS (${checks} checks)`);
