/**
 * Run: npx tsx components/collection/new/collection-currency.test.tsx
 *
 * /collection/new currency choice — the logic, and the ILS-only identity proof:
 *
 *   - with only ILS offerable the currency is derived EXACTLY as before
 *     (`invoice?.currency ?? thread?.totals.currency ?? "ILS"`) for every input,
 *     and the choice renders no markup at all — so the screen is unchanged;
 *   - an invoice-backed request never shows the choice and keeps the invoice's
 *     currency;
 *   - a standalone request with several offerable currencies shows the choice,
 *     ILS preselected, and what is picked becomes the request's currency.
 *
 * Rendered with react-dom/server; no DOM, no network.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollectionCurrencyChoice } from "./collection-currency-choice";
import { offerableFrom, requestCurrency, showCurrencyChoice } from "./collection-currency";
import type { CurrencyCode } from "@/lib/money/currency";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

/** The expression the screen used before this change, verbatim. */
const legacy = (invoiceCurrency: string | undefined, threadCurrency: string | null | undefined) =>
  invoiceCurrency ?? threadCurrency ?? "ILS";

const render = (props: Parameters<typeof CollectionCurrencyChoice>[0]) =>
  renderToStaticMarkup(createElement(CollectionCurrencyChoice, props));

// ── offerableFrom: a defensive read of readiness.offerableCurrencies ──────
ok("missing field → ILS alone", JSON.stringify(offerableFrom(undefined)) === '["ILS"]');
ok("empty list → ILS alone", JSON.stringify(offerableFrom([])) === '["ILS"]');
ok("unknown codes dropped", JSON.stringify(offerableFrom(["GBP", "USD"])) === '["USD"]');
ok("duplicates dropped, order kept", JSON.stringify(offerableFrom(["ILS", "USD", "ILS", "EUR"])) === '["ILS","USD","EUR"]');

// ── ILS-only identity ─────────────────────────────────────────────────────
{
  const ilsOnly: CurrencyCode[] = ["ILS"];
  let identical = true;
  for (const invoiceCurrency of [undefined, "ILS", "USD"]) {
    for (const threadCurrency of [undefined, null, "ILS", "USD"]) {
      for (const standalone of [true, false]) {
        for (const chosen of [null, "USD", "EUR"] as (CurrencyCode | null)[]) {
          const shown = showCurrencyChoice({ standalone, offerable: ilsOnly });
          if (shown) identical = false;
          const got = requestCurrency({ invoiceCurrency, threadCurrency, chosen, choiceShown: shown, offerable: ilsOnly });
          if (got !== legacy(invoiceCurrency, threadCurrency)) identical = false;
        }
      }
    }
  }
  ok("ILS only: never shown, and the currency equals the old expression for every input", identical);
  ok("ILS only: the choice renders no markup (screen unchanged)", render({ shown: false, offerable: ilsOnly, value: "ILS", onChange: () => {} }) === "");
  ok(
    "hidden with several offerable (invoice-backed): still no markup",
    render({ shown: showCurrencyChoice({ standalone: false, offerable: ["ILS", "USD", "EUR"] }), offerable: ["ILS", "USD", "EUR"], value: "ILS", onChange: () => {} }) === ""
  );
}

// ── Invoice-backed: never a choice, always the invoice's currency ─────────
{
  const all: CurrencyCode[] = ["ILS", "USD", "EUR"];
  const shown = showCurrencyChoice({ standalone: false, offerable: all });
  ok("invoice-backed: no choice even when the provider offers three", shown === false);
  ok("invoice-backed: currency = the invoice's, whatever was picked before", requestCurrency({ invoiceCurrency: "ILS", threadCurrency: "ILS", chosen: "USD", choiceShown: shown, offerable: all }) === "ILS");
}

// ── Standalone with several offerable currencies ──────────────────────────
{
  const sumit: CurrencyCode[] = ["ILS", "USD"];
  const shown = showCurrencyChoice({ standalone: true, offerable: sumit });
  ok("standalone + ILS/USD: choice shown", shown === true);
  ok("…ILS preselected before anything is picked", requestCurrency({ invoiceCurrency: undefined, threadCurrency: "ILS", chosen: null, choiceShown: shown, offerable: sumit }) === "ILS");
  ok("…USD once picked", requestCurrency({ invoiceCurrency: undefined, threadCurrency: "ILS", chosen: "USD", choiceShown: shown, offerable: sumit }) === "USD");
  ok("…a pick the provider no longer offers falls back to ILS", requestCurrency({ invoiceCurrency: undefined, threadCurrency: "ILS", chosen: "EUR", choiceShown: shown, offerable: sumit }) === "ILS");

  const html = render({ shown: true, offerable: ["ILS", "USD", "EUR"], value: "ILS", onChange: () => {} });
  ok("renders one radio per offerable currency", (html.match(/type="radio"/g) ?? []).length === 3, html);
  ok("ILS is the checked one", /checked="" value="ILS"/.test(html), html);
  ok("labels carry symbol + Hebrew name", html.includes("₪ שקל ישראלי") && html.includes("$ דולר אמריקאי") && html.includes("€ אירו"), html);
  ok("legend from the dictionary", html.includes("באיזה מטבע?"), html);
  const two = render({ shown: true, offerable: sumit, value: "USD", onChange: () => {} });
  ok("SUMIT-shaped: only ILS and USD, USD checked", !two.includes("EUR") && /checked="" value="USD"/.test(two), two);
}

console.log(`\ncollection-currency: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
