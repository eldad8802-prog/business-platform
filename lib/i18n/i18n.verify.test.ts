/**
 * Verify — i18n foundation (lib/i18n).
 * Run: npx tsx lib/i18n/i18n.verify.test.ts
 *
 * Pins: dictionary parity (every Hebrew key exists in every language, no extras), interpolation
 * placeholders match across languages, locale → direction, safe fallback, and that Hebrew money
 * output is byte-identical to the legacy formatter (backward compatibility).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { intlTag, LOCALES, localeDirection, resolveLocale } from "@/lib/i18n/config";
import { formatAmount, formatDate, formatMoney } from "@/lib/i18n/format";
import { getMessages } from "@/lib/i18n/messages";
import { en } from "@/lib/i18n/messages/en";
import { he } from "@/lib/i18n/messages/he";
import { interpolate, translate } from "@/lib/i18n/translate";
import { moneyFromDecimal } from "@/lib/money/money";
import { formatMoney as legacyFormatMoney } from "@/lib/ui/money";

let checks = 0;
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks++;
}

function leaves(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// ---------------------------------------------------------------- dictionary parity
const source = leaves(he);
for (const locale of LOCALES) {
  const dict = leaves(getMessages(locale));
  eq(`${locale}: same key set as Hebrew`, [...dict.keys()].sort(), [...source.keys()].sort());
  for (const [key, text] of dict) {
    ok(`${locale}:${key} non-empty`, text.trim().length > 0);
    eq(`${locale}:${key} placeholders match`, placeholders(text), placeholders(source.get(key) ?? ""));
  }
}
ok("English carries no Hebrew letters", [...leaves(getMessages("en")).values()].every((s) => !/[֐-׿]/.test(s)));

// ---------------------------------------------------------------- locale resolution
eq("he is rtl", localeDirection("he"), "rtl");
eq("en is ltr", localeDirection("en"), "ltr");
eq("bad cookie → default he", resolveLocale("fr"), "he");
eq("missing cookie → default he", resolveLocale(undefined), "he");
eq("language and region are separate", intlTag("en", "IL"), "en-IL");

// ---------------------------------------------------------------- translate
eq("en lookup", translate(getMessages("en"), "nav.home"), "Home");
eq("he lookup", translate(getMessages("he"), "nav.home"), "בית");
eq("interpolation", translate(getMessages("en"), "nav.a11y.pendingCount", { count: 3 }), "3 pending");
eq("unknown key → the key, never undefined", translate(getMessages("en"), "nope.missing"), "nope.missing");
eq("missing var left visible", interpolate("{a} {b}", { a: 1 }), "1 {b}");

// ---------------------------------------------------------------- formatting: Hebrew parity with legacy
for (const [amount, currency] of [
  [1500, "ILS"],
  [1500.5, "ILS"],
  ["1234.56", "ILS"],
  [0, "ILS"],
  [-250, "ILS"],
  [99.99, "USD"],
  [10, "EUR"],
  [null, "ILS"],
  ["abc", "ILS"],
] as const) {
  eq(`he parity ${String(amount)} ${currency}`, formatAmount(amount, currency, { locale: "he" }), legacyFormatMoney(amount as never, currency));
}

// English uses Intl currency patterns; the symbol follows the CURRENCY, never the language.
eq("en ILS", formatAmount(1500, "ILS", { locale: "en" }), "₪1,500");
eq("en USD", formatAmount("1234.5", "USD", { locale: "en" }), "$1,234.5");
eq("en EUR fixed fraction", formatAmount(10, "EUR", { locale: "en" }, { fixedFraction: true }), "€10.00");
eq("approximate marker", formatAmount(10, "USD", { locale: "en" }, { approximate: true }), "≈$10");
eq("Money value", formatMoney(moneyFromDecimal("372.50", "ILS"), { locale: "en" }), "₪372.5");

// Dates render in the business time zone regardless of the server's TZ.
eq("en-IL date (day first)", formatDate("2026-10-20T22:30:00Z", { locale: "en" }), "21/10/2026");
eq("he-IL date", formatDate("2026-10-20T22:30:00Z", { locale: "he" }), "21.10.2026");
eq("invalid date", formatDate("nope", { locale: "en" }), "—");

// The root layout no longer serializes the Hebrew dictionary into every page: I18nProvider falls back to
// the bundled `he`, which must be the very object the server would have passed (same strings, same output).
ok("getMessages('he') is the bundled he (no per-page dictionary needed)", getMessages("he") === he);
// English is no longer a layout prop either: components/i18n/EnglishI18nProvider (its own client chunk)
// imports `en` directly — the very object the server registry returns, so SSR and hydration agree.
ok("getMessages('en') is the en module the English chunk imports", getMessages("en") === en);
{
  const src = (p: string) =>
    readFileSync(path.join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const layout = src("app/layout.tsx");
  const provider = src("components/i18n/I18nProvider.tsx");
  // No dictionary is ever a prop of the root provider again (it would be serialized into every HTML).
  ok("root layout passes no messages to I18nProvider", !/messages\s*=/.test(layout) && !/getMessages/.test(layout));
  // The provider module (in every page's client bundle) never statically imports a non-Hebrew dictionary.
  ok(
    "I18nProvider does not statically import the English dictionary",
    !/from\s+["'][^"']*messages\/(en|index)["']/.test(provider) && !/from\s+["']@\/lib\/i18n\/messages["']/.test(provider)
  );
  ok("English is loaded through next/dynamic", /dynamic\(\s*\(\)\s*=>\s*import\(["']\.\/EnglishI18nProvider["']\)\s*\)/.test(provider));
  // The Hebrew dictionary's module graph (bundled for EVERY user) holds no English: each area keeps its
  // English half in a sibling `*.en.ts`, reached only from en.ts. A shared module would put English
  // into the Hebrew bundle as soon as the English chunk uses it (unused-export removal then keeps it).
  const seen = new Set<string>();
  const stack = [path.join(process.cwd(), "lib/i18n/messages/he.ts")];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    ok(`Hebrew dictionary graph has no English module (${path.basename(file)})`, !file.endsWith(".en.ts") && !/:\s*Widen</.test(code));
    for (const m of code.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+["'](\.[^"']+)["']/gm)) stack.push(path.resolve(path.dirname(file), m[1]) + ".ts");
  }
  ok("Hebrew dictionary graph walked (he.ts + every area)", seen.size >= 19);
}

console.log(`i18n.verify: ${checks} checks passed`);
