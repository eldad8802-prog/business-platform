/**
 * 4a T4 — interim documents: pure rules + the route handler with injected dependencies (no database).
 * The database side (time-zone bounds, RLS, read-only, concurrency with issuance) is proven by
 * .billing-4a/t4-interim-documents.battery.mts.
 *
 * Run: npx tsx lib/services/billing/kind-transition/interim-documents.test.ts
 */
import { Prisma } from "@prisma/client";

import {
  classifyCredit,
  INTERIM_DOCUMENT_TYPES,
  israelDate,
  parseCursor,
  validateInterimFromDate,
} from "@/lib/services/billing/kind-transition/interim-documents";
import { handleInterimDocumentsGet, type InterimDocumentsDeps } from "@/lib/services/billing/kind-transition/interim-documents-handler";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  - ${name}`);
  else { failed += 1; console.error(`FAIL  - ${name}`); }
}
const D = (v: string) => new Prisma.Decimal(v);

async function main() {
  // ── types (D9)
  ok("I1 the four fiscal types, no QUOTE", JSON.stringify([...INTERIM_DOCUMENT_TYPES]) === JSON.stringify(["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE"]));

  // ── from date: the transition's own rule
  const now = new Date("2026-11-24T21:30:00Z"); // 23:30 on 11-24 in Israel... and 2026-11-24T21:30Z is 23:30 IST
  ok("I2 today (Israel) is accepted", validateInterimFromDate("2026-11-24", now).ok === true);
  ok("I2 an Israeli 'today' that is still yesterday in UTC is accepted", validateInterimFromDate("2026-11-25", new Date("2026-11-24T22:30:00Z")).ok === true);
  ok("I2 tomorrow → IN_FUTURE", (validateInterimFromDate("2026-11-25", now) as { code?: string }).code === "IN_FUTURE");
  ok("I2 empty → REQUIRED", (validateInterimFromDate("", now) as { code?: string }).code === "REQUIRED");
  ok("I2 not a date / not real / before 2000 → INVALID",
    ["2026-13-01", "2026-02-30", "24/11/2026", "1999-12-31", "2026-11-24T00:00"].every((v) => (validateInterimFromDate(v, now) as { code?: string }).code === "INVALID"));
  ok("I3 israelDate: 21:59:59Z on 11-23 in winter is 23:59:59 on 11-23; 22:00Z is 11-24",
    israelDate(new Date("2026-11-23T21:59:59Z")) === "2026-11-23" && israelDate(new Date("2026-11-23T22:00:00Z")) === "2026-11-24");
  ok("I3 israelDate: summer offset (+3): 20:59:59Z on 07-15 is 07-15; 21:00Z is 07-16",
    israelDate(new Date("2026-07-15T20:59:59Z")) === "2026-07-15" && israelDate(new Date("2026-07-15T21:00:00Z")) === "2026-07-16");

  // ── credit state: the credit flow's own rule; full vs partial vs only linked
  ok("I4 no credit note → NONE", classifyCredit("TAX_INVOICE", D("100"), D("0"), 0) === "NONE");
  ok("I4 tax invoice credited for its total → FULL", classifyCredit("TAX_INVOICE", D("118.00"), D("118.00"), 1) === "FULL");
  ok("I4 tax invoice credited in two notes summing to the total → FULL", classifyCredit("TAX_INVOICE", D("118.00"), D("118.00"), 2) === "FULL");
  ok("I4 tax invoice credited for part → PARTIAL (never FULL)", classifyCredit("TAX_INVOICE", D("118.00"), D("50.00"), 1) === "PARTIAL");
  ok("I4 a credit note naming a non-invoice → LINKED only", classifyCredit("RECEIPT", D("100"), D("100"), 1) === "LINKED"
    && classifyCredit("TAX_INVOICE_RECEIPT", D("100"), D("100"), 1) === "LINKED");
  ok("I4 a zero-sum credit note on an invoice → LINKED (no full/partial claim)", classifyCredit("TAX_INVOICE", D("100"), D("0"), 1) === "LINKED");

  // ── cursor
  ok("I5 cursor round-trip", JSON.stringify(parseCursor("2026-11-24T10:00:00.123Z_42")) === JSON.stringify({ at: "2026-11-24T10:00:00.123Z", id: 42 }));
  ok("I5 bad cursors → null", [null, "", "x", "2026-11-24_1", "2026-11-24T10:00:00Z_", "2026-11-24T10:00:00Z_1;DROP"].every((c) => parseCursor(c) === null));

  // ── handler
  const calls: unknown[] = [];
  const deps = (over: Partial<InterimDocumentsDeps> = {}): InterimDocumentsDeps => ({
    enabled: () => true,
    context: async () => ({ user: { id: 7, businessId: 70 } }),
    read: async (businessId, args) => {
      calls.push({ businessId, ...args });
      return { ok: true, result: { range: { fromDate: args.requestedFromDate ?? "2026-01-01", to: now.toISOString(), timezone: "Asia/Jerusalem", toExclusive: true, source: "REQUEST" }, count: 3, credit: { full: 0, partial: 1, linked: 0 } } } as never;
    },
    now: () => now,
    ...over,
  });
  const req = (q: string, auth = true) => new Request(`http://x/api/billing/kind-transition/interim-documents${q}`, { headers: auth ? { authorization: "Bearer t" } : {} });

  let r = await handleInterimDocumentsGet(req("?from=2026-11-01"), deps({ enabled: () => false }));
  ok("H1 flag OFF → 404, before auth and before any read", r.status === 404 && calls.length === 0);
  r = await handleInterimDocumentsGet(req("?from=2026-11-01"), deps({ enabled: () => false, context: async () => { throw new Error("must not be called"); } }));
  ok("H1 flag OFF → the session is not even read", r.status === 404);
  r = await handleInterimDocumentsGet(req("?from=2026-11-01", false), deps({ context: async () => null }));
  ok("H2 no session → 401", r.status === 401 && calls.length === 0);
  r = await handleInterimDocumentsGet(req("?from=2026-11-31"), deps());
  ok("H3 an invalid date → 400 INVALID_FROM_DATE, no read", r.status === 400 && (await r.json()).code === "INVALID" && calls.length === 0);
  r = await handleInterimDocumentsGet(req("?from=2026-11-25"), deps());
  ok("H3 a future date → 400 IN_FUTURE", r.status === 400 && (await r.json()).code === "IN_FUTURE");
  r = await handleInterimDocumentsGet(req("?from=2026-11-01&list=1&cursor=junk"), deps());
  ok("H3 a malformed cursor → 400 INVALID_CURSOR", r.status === 400 && (await r.json()).error === "INVALID_CURSOR");
  r = await handleInterimDocumentsGet(req("?from=2026-11-01&list=1"), deps());
  const body = await r.json();
  ok("H4 valid → 200, the session's business only, list flag passed", r.status === 200 && body.count === 3
    && JSON.stringify(calls[calls.length - 1]) === JSON.stringify({ businessId: 70, requestedFromDate: "2026-11-01", now: now.toISOString(), list: true, cursor: null }));
  ok("H4 no-store", r.headers.get("cache-control") === "no-store");
  r = await handleInterimDocumentsGet(req("?from=2026-11-01&businessId=999"), deps());
  ok("H5 a businessId in the query is ignored (the session's business is read)", r.status === 200 && (calls[calls.length - 1] as { businessId: number }).businessId === 70);
  r = await handleInterimDocumentsGet(req(""), deps({ read: async () => ({ ok: false, code: "FROM_DATE_REQUIRED" }) as never }));
  ok("H6 no date and no transition → 400 FROM_DATE_REQUIRED", r.status === 400 && (await r.json()).error === "FROM_DATE_REQUIRED");
  r = await handleInterimDocumentsGet(req("?from=2026-11-01"), deps({ read: async () => { throw new Error("db down secret=xyz"); } }));
  const err = await r.json();
  ok("H7 a failure → 500 with a fixed code and no detail", r.status === 500 && err.error === "INTERIM_DOCUMENTS_FAILED" && !JSON.stringify(err).includes("secret"));

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
