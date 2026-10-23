/**
 * Pure tests for .i18n/readiness-lib.ts — the helpers the English-activation readiness CI relies on.
 * No DB, no network, no browser. Run: npx tsx .i18n/readiness-lib.test.ts
 */
import assert from "node:assert/strict";
import {
  diffRouteTables, enumeratePages, fillRoute, isHebrewOnlyPublic, localeReaders, normalizeVisible, parseBuildRouteTable,
  routeAudience, toRoute,
} from "./readiness-lib";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok ${name}`);
}

test("route groups are stripped, dynamic params collected", () => {
  const r = toRoute(["(shell)", "customers", "[id]"], "app/(shell)/customers/[id]/page.tsx");
  assert.deepEqual(r, { file: "app/(shell)/customers/[id]/page.tsx", pattern: "/customers/[id]", params: ["id"], group: "(shell)" });
  assert.equal(toRoute(["(shell)"], "app/(shell)/page.tsx").pattern, "/");
  assert.deepEqual(toRoute(["docs", "[...slug]"], "x").params, ["slug"]);
});

test("enumeratePages finds every page.tsx in app/ (not api/, not _private)", () => {
  const pages = enumeratePages("app");
  assert.ok(pages.length >= 140, `only ${pages.length} pages`);
  const patterns = pages.map((p) => p.pattern);
  assert.ok(patterns.includes("/app") && patterns.includes("/login") && patterns.includes("/customers/[id]") && patterns.includes("/home"));
  assert.ok(!patterns.some((p) => p.startsWith("/api/") || p.includes("/_")));
  assert.equal(new Set(pages.map((p) => p.file)).size, pages.length);
});

test("audience: public marketing + auth screens, platform admin, everything else is the app", () => {
  assert.equal(routeAudience({ pattern: "/home", group: "(corporate)" }), "public");
  assert.equal(routeAudience({ pattern: "/login", group: null }), "public");
  assert.equal(routeAudience({ pattern: "/reset-password", group: null }), "public");
  assert.equal(routeAudience({ pattern: "/admin", group: "(platform-admin)" }), "platform-admin");
  assert.equal(routeAudience({ pattern: "/dev/debug-ocr", group: null }), "platform-admin");
  assert.equal(routeAudience({ pattern: "/billing/[id]", group: null }), "app");
  assert.equal(isHebrewOnlyPublic({ group: "(corporate)" }), true);
  assert.equal(isHebrewOnlyPublic({ group: "(shell)" }), false);
});

test("fillRoute: specific fill beats the wildcard, a missing value → null", () => {
  const fills = { "*": { id: "9" }, "/billing/[id]": { id: "42" } };
  assert.equal(fillRoute("/billing/[id]", fills), "/billing/42");
  assert.equal(fillRoute("/customers/[id]", fills), "/customers/9");
  assert.equal(fillRoute("/tools/[category]", fills), null);
  assert.equal(fillRoute("/app", fills), "/app");
});

test("normalizeVisible: raw only collapses whitespace; volatile only touches clock/date/relative age", () => {
  assert.equal(normalizeVisible("  a \n\n b\t c ", "raw"), "a b c");
  assert.equal(normalizeVisible("עודכן 14:05 · 22.10.2026", "volatile"), "עודכן HH:MM · DATE");
  assert.equal(normalizeVisible("לפני 3 דקות", "volatile"), "לפני N");
  assert.equal(normalizeVisible("לפני דקה", "volatile"), "לפני N");
  // amounts, counts and ids are never normalised
  assert.notEqual(normalizeVisible("₪1,000.00 · 3 חשבוניות", "volatile"), normalizeVisible("₪1,300.00 · 3 חשבוניות", "volatile"));
  assert.notEqual(normalizeVisible("#800012", "volatile"), normalizeVisible("#800013", "volatile"));
});

test("parseBuildRouteTable reads the Next route table (ANSI, tree glyphs, api filtered)", () => {
  const log = [
    "\u001b[1mRoute (app)\u001b[22m",
    "┌ ○ /",
    "├ ○ /_not-found",
    "├ ƒ /api/home",
    "├ ƒ /billing/[id]",
    "├ ● /tools/[category]",
    "│ └ /tools/money",
    "└ ○ /login",
    "",
    "○  (Static)   prerendered as static content",
    "ƒ  (Dynamic)  server-rendered on demand",
  ].join("\n");
  const pages = parseBuildRouteTable(log);
  assert.deepEqual([...pages], [["/", "static"], ["/_not-found", "static"], ["/billing/[id]", "dynamic"], ["/tools/[category]", "ssg"], ["/login", "static"]]);
  assert.equal(parseBuildRouteTable(log, true).get("/api/home"), "dynamic");
  const on = parseBuildRouteTable(log.replace("○ /login", "ƒ /login"));
  assert.deepEqual(diffRouteTables(pages, on), [{ route: "/login", off: "static", on: "dynamic" }]);
});

test("localeReaders: customer-facing modules reach no locale reader; an app route does", () => {
  assert.deepEqual(localeReaders(process.cwd(), "lib/services/billing/collection/collection-message.ts"), []);
  assert.deepEqual(localeReaders(process.cwd(), "lib/services/billing/pdf/billing-pdf-html-template.ts"), []);
  const hits = localeReaders(process.cwd(), "app/api/home/route.ts");
  assert.ok(hits.length > 0, "app/api/home/route.ts should reach getServerI18n");
});

console.log(`readiness-lib: ${n} tests passed`);
