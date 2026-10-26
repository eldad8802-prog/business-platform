/**
 * S1-A — Rivhit → revenue truth, the application code on the lab database as the RUNTIME role (app_runtime_prod:
 * NOSUPERUSER NOBYPASSRLS), through the same functions the route and the sweeper call. Rivhit itself is a FAKE
 * (setRivhitFetchForTests) shaped like the documented demo account; zero network.
 *
 *   A. connect: the token is checked, the company bound, the type roles only PROPOSED; nothing is read before confirm
 *   B. confirm: the cursor starts at each type's last number — history is not read without a backfill
 *   C. new documents → RevenueSale + one RevenueReceipt per tender, ACCOUNTING_APP (never POS), through intake (R10)
 *   D. replays: the same run again writes nothing; what intake holds is never fetched again
 *   E. a later cancellation → a VOID naming the sale (same money); a receipt's cancellation → its tenders REJECTED
 *   F. standalone receipts land without a sale; an invoice-receipt's mirror receipt is never read
 *   G. backfill: day by day from the owner's day, each day checked against Rivhit's own summary
 *   H. an unreadable document is recorded (never silently dropped) and does not stall the cursor
 *   I. tenant isolation: one Rivhit company cannot be live on two businesses; each business sees only its rows
 *   J. the flag: OFF for a business ⇒ no Rivhit call at all
 *   K. a token Rivhit rejects ⇒ the connection shows ERROR (owner must act), nothing written
 *   L. a revoked connection: its pending receipts are settled IGNORED, never revenue
 *   M. no personal data in intake payloads; the token never leaves the encrypted bundle
 *
 * env: OWNER_URL (fixtures, BYPASSRLS), RUNTIME_URL (the app). Synthetic only. ZERO network.
 */
const RUNTIME_URL = process.env.RUNTIME_URL?.trim();
const OWNER_URL = process.env.OWNER_URL?.trim();
if (!RUNTIME_URL || !OWNER_URL || !/^postgres(ql)?:\/\//i.test(RUNTIME_URL) || /neon\.tech|vercel/i.test(RUNTIME_URL + OWNER_URL)) {
  console.error("ABORT (DB safety guard): OWNER_URL and RUNTIME_URL must name the ephemeral lab database.");
  process.exit(1);
}
process.env.DATABASE_URL = RUNTIME_URL;
process.env.ACQUISITION_CREDENTIAL_ENCRYPTION_KEY = process.env.ACQUISITION_CREDENTIAL_ENCRYPTION_KEY || "a1".repeat(32);

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e)); }
}

// ── the fake Rivhit (one company per token) ─────────────────────────────────────────────────────────

type FakeDoc = { number: number; day: string; time: string; total: number; vat: number; cancelled: boolean; payments: Array<{ line: number; amount: number; name: string; id?: number }>; currency?: number; broken?: boolean };
type FakeCompany = { companyId: number; reject?: boolean; docs: Record<number, FakeDoc[]>; receipts: Record<number, FakeDoc[]> };
const companies = new Map<string, FakeCompany>();
const calls: string[] = [];
const PERSON = "SYNTHETIC PERSON NAME";
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const iso = (s: string) => { const [d, m, y] = s.split("/"); return `${y}-${m}-${d}`; };

function rivhitFake(op: string, body: Record<string, unknown>): { status: number; json: unknown } {
  calls.push(op);
  const c = companies.get(String(body.api_token));
  if (!c || c.reject) return { status: 401, json: { error_code: 401, client_message: "שגיאת הרשאות", debug_message: "-9999 : UNAUTHORIZED", data: null } };
  const okj = (data: unknown) => ({ status: 200, json: { error_code: 0, client_message: "", debug_message: "", data } });
  const none = { status: 200, json: { error_code: 204, client_message: "לא נמצאו נתונים", debug_message: "-2 : NO_DATA_FOUND", data: null } };
  const inRange = (kind: "document" | "receipt", t: number, d: FakeDoc) => {
    const ft = body[`from_${kind}_type`] as number | undefined, tt = body[`to_${kind}_type`] as number | undefined;
    if (ft !== undefined && (t < ft || t > (tt ?? ft))) return false;
    const fn = body[`from_${kind}_number`] as number | undefined, tn = body[`to_${kind}_number`] as number | undefined;
    if (fn !== undefined && (d.number < fn || d.number > (tn ?? fn))) return false;
    if (body.from_date !== undefined) {
      const day = d.day, from = iso(String(body.from_date)), to = iso(String(body.to_date));
      if (day < from || day > to) return false;
    }
    return true;
  };
  switch (op) {
    case "Company.Details": return okj({ company_id: c.companyId, name: "DEMO" });
    case "Document.TypeList": return okj({ document_type_list: [
      { document_type: 1, document_name: "חשבונית מס", is_accounting: true, is_invoice_receipt: false },
      { document_type: 2, document_name: "חשבונית מס קבלה", is_accounting: true, is_invoice_receipt: true },
      { document_type: 3, document_name: "חשבונית מס זיכוי", is_accounting: true },
      { document_type: 7, document_name: "הזמנה", is_accounting: false },
    ] });
    case "Receipt.TypeList": return okj({ receipt_type_list: [
      { receipt_type: 1, receipt_name: "קבלה", is_invoice_receipt: false },
      { receipt_type: 2, receipt_name: "קבלה מחשבונית מס", is_invoice_receipt: true },
    ] });
    case "Payment.TypeList": return okj({ payment_type_list: [
      { payment_type: 1, payment_name: "שיק", type_code: 2 }, { payment_type: 2, payment_name: "מזומן", type_code: 1 },
      { payment_type: 3, payment_name: "נ.מס במקור", type_code: 0 }, { payment_type: 5, payment_name: "ויזה", type_code: 3 },
    ] });
    case "Document.List": case "Receipt.List": {
      const kind = op === "Document.List" ? "document" : "receipt";
      const all = kind === "document" ? c.docs : c.receipts;
      const rows = Object.entries(all).flatMap(([t, ds]) => ds.filter((d) => inRange(kind, Number(t), d)).map((d) => ({
        [`${kind}_type`]: Number(t), [`${kind}_number`]: d.number, [`${kind}_date`]: ddmmyyyy(d.day), amount: d.total, total_vat: d.vat, is_cancelled: d.cancelled, customer_name: PERSON,
      })));
      return okj({ [`${kind}_list`]: rows });
    }
    case "Document.Details": case "Receipt.Details": case "Document.Last": case "Receipt.Last": {
      const kind = op.startsWith("Document") ? "document" : "receipt";
      const t = Number(body[`${kind}_type`]);
      const list = (kind === "document" ? c.docs : c.receipts)[t] ?? [];
      const d = op.endsWith(".Last") ? list[list.length - 1] : list.find((x) => x.number === Number(body[`${kind}_number`]));
      if (!d) return none;
      if (d.broken) return okj({ [`${kind}_number`]: `${t}/${d.number}`, customer_name: PERSON });
      return okj({
        [`${kind}_number`]: `${String(t).padStart(2, "0")}/${String(d.number).padStart(6, "0")}`, [`${kind}_date`]: ddmmyyyy(d.day), documnet_time: d.time, receipt_time: d.time,
        document_total: d.total, total_vat: d.vat, discount_amount: 0, price_include_vat: true, is_cancelled: d.cancelled, currency_id: d.currency ?? 1, vat_percent: "18.00%",
        customer_name: PERSON, customer_phone: "0500000000", items: [{ line: 1, quantity: 1, total_line: d.total, catalog_number: "SKU-1", description: "SYNTHETIC ITEM" }],
        payments: d.payments.map((p) => ({ line_number: p.line, amount: p.amount, payment_type: p.name, payment_type_id: p.id ?? 0 })),
      });
    }
    case "Company.SummaryReport": {
      const day = `${body.year}-${String(body.month).padStart(2, "0")}-${String(body.day).padStart(2, "0")}`;
      const Documents = Object.entries(c.docs).map(([t, ds]) => {
        const mine = ds.filter((d) => d.day === day);
        return { DocType: Number(t), DocCount: mine.length, TotalWithVat: Math.round(mine.reduce((s, d) => s + d.total, 0) * 100) / 100 };
      }).filter((x) => x.DocCount > 0);
      return okj({ Documents, PayCodes: [], Receipts: [] });
    }
  }
  return { status: 400, json: { error: "Request Error" } };
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const client = await import("@/lib/revenue-sources/rivhit/client");
  const connect = await import("@/lib/revenue-sources/rivhit/connect");
  const sync = await import("@/lib/revenue-sources/rivhit/sync");
  const { rivhitScope } = await import("@/lib/revenue-sources/rivhit/adapter");
  const { revokeConnection } = await import("@/lib/intake/acquisition/connection.service");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { drainIntake } = await import("@/lib/intake/core/processor");
  const { intakeRegistry } = await import("@/lib/intake/sources");
  client.setRivhitFetchForTests(async (url, init) => rivhitFake(url.slice(url.lastIndexOf("/") + 1), JSON.parse(init.body)));

  const one = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as { id: number }[])[0].id);
  const n = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as { n: number }[])[0].n);
  const business = (name: string) => one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
  const user = (biz: number, tag: string) => one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${Date.now()}@s1a.lab`, biz);
  const enable = (biz: number) => owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'pos_rivhit', 'ENABLED', now()) ON CONFLICT DO NOTHING`, biz);
  const as = <T>(biz: number, fn: () => Promise<T>) => runWithTenantContext({ businessId: biz }, fn);
  const sales = (biz: number) => n(`SELECT count(*)::int AS n FROM "RevenueSale" WHERE "businessId" = $1`, biz);
  const receipts = (biz: number) => n(`SELECT count(*)::int AS n FROM "RevenueReceipt" WHERE "businessId" = $1`, biz);

  const TA = "aaaaaaaa-0000-4000-8000-000000000001";
  const TB = "bbbbbbbb-0000-4000-8000-000000000002";
  const today = "2026-10-26";
  const NOW = new Date("2026-10-26T15:00:00.000Z");
  companies.set(TA, {
    companyId: 501,
    docs: {
      1: [{ number: 1, day: "2026-10-23", time: "09:00:00", total: 100, vat: 15.25, cancelled: false, payments: [] }],
      2: [
        { number: 1, day: "2026-10-23", time: "10:00:00", total: 59, vat: 9, cancelled: false, payments: [{ line: 1, amount: 59, name: "מזומן" }] },
        { number: 2, day: "2026-10-24", time: "11:00:00", total: 118, vat: 18, cancelled: true, payments: [{ line: 1, amount: 118, name: "ויזה" }] },
        { number: 3, day: "2026-10-25", time: "12:00:00", total: 236, vat: 36, cancelled: false, payments: [{ line: 1, amount: 200, name: "ויזה" }, { line: 2, amount: 36, name: "מזומן" }] },
      ],
      3: [],
      7: [{ number: 1, day: "2026-10-25", time: "08:00:00", total: 999, vat: 0, cancelled: false, payments: [] }],
    },
    receipts: { 1: [{ number: 1, day: "2026-10-24", time: "13:00:00", total: 100, vat: 0, cancelled: false, payments: [{ line: 1, amount: 100, name: "שיק", id: 1 }] }], 2: [] },
  });
  companies.set(TB, { companyId: 777, docs: { 1: [], 2: [], 3: [] }, receipts: { 1: [], 2: [] } });

  const bizA = await business("s1a-A");
  const bizB = await business("s1a-B");
  const userA = await user(bizA, "a");
  const userB = await user(bizB, "b");
  await enable(bizA);
  await enable(bizB);
  const A = companies.get(TA)!;

  console.log("A. connect");
  ok("a malformed token is refused before any call", (await errorCode(() => as(bizA, () => connect.connectRivhit({ businessId: bizA, userId: userA, apiToken: "nope" })))) === "token_invalid" && calls.length === 0);
  const c1 = await as(bizA, () => connect.connectRivhit({ businessId: bizA, userId: userA, apiToken: TA, label: "ריווחית" }));
  const conn = c1.connection;
  ok("the company is bound (externalResourceId = Rivhit company id)", conn.externalResourceId === "501" && conn.sourceKey === "pos.rivhit");
  ok("roles are proposed: 1,2 SALE · 3 REFUND · 7 IGNORE · receipt 1 RECEIPT · 2 MIRROR", (() => {
    const r = Object.fromEntries(c1.types.map((t) => [`${t.kind}:${t.type}`, t.role]));
    return r["document:1"] === "SALE" && r["document:2"] === "SALE" && r["document:3"] === "REFUND" && r["document:7"] === "IGNORE" && r["receipt:1"] === "RECEIPT" && r["receipt:2"] === "MIRROR";
  })());
  calls.length = 0;
  const pre = { connections: 0, receipts: 0, unreadable: 0, failures: 0, calls: 0 };
  await as(bizA, () => sync.syncRivhitConnection(bizA, conn, pre, { now: NOW }));
  ok("before the owner confirms, nothing is read (0 Rivhit calls, 0 rows)", calls.length === 0 && (await sales(bizA)) === 0);

  console.log("B. confirm");
  const types = { docs: { "1": "SALE", "2": "SALE", "3": "REFUND", "7": "IGNORE" }, receipts: { "1": "RECEIPT", "2": "MIRROR" }, registerTypes: [] };
  await as(bizA, () => connect.confirmRivhitTypes(bizA, conn.id, types));
  let st = await as(bizA, () => connect.rivhitStatus(bizA, conn.id));
  ok("the cursor starts at each confirmed type's last number (history not read)", st.cursor.docs["1"] === 1 && st.cursor.docs["2"] === 3 && st.cursor.docs["3"] === 0 && st.cursor.receipts["1"] === 1 && st.cursor.docs["7"] === undefined);
  ok("the status never carries the token", !JSON.stringify(st).includes(TA) && st.registerProven === false);
  const r0 = await as(bizA, () => sync.syncRivhit(bizA, { now: NOW }));
  ok("a run with nothing new writes nothing", (await sales(bizA)) === 0 && r0.receipts === 0 && r0.failures === 0, JSON.stringify(r0));

  console.log("C. new documents through intake");
  A.docs[2].push({ number: 4, day: today, time: "14:10:00", total: 177, vat: 27, cancelled: false, payments: [{ line: 1, amount: 77, name: "מזומן" }, { line: 2, amount: 100, name: "ויזה" }, { line: 3, amount: 0.004, name: "מזומן" }] });
  A.docs[3].push({ number: 1, day: today, time: "14:20:00", total: -59, vat: -9, cancelled: false, payments: [{ line: 1, amount: -59, name: "מזומן" }] });
  A.docs[7].push({ number: 2, day: today, time: "14:30:00", total: 500, vat: 0, cancelled: false, payments: [] });
  await as(bizA, () => sync.syncRivhit(bizA, { now: NOW }));
  const scope = rivhitScope(conn.id);
  const saleRows = (await owner.$queryRawUnsafe(`SELECT "externalId", "kind", "sourceKind", "grossMinor"::text AS g, "vatMinor"::text AS v, "businessDay"::text AS d, "capture" FROM "RevenueSale" WHERE "businessId" = $1 ORDER BY "externalId"`, bizA)) as Array<Record<string, string>>;
  ok("a sale and a refund were written (the order type was not)", saleRows.length === 2 && saleRows.some((s) => s.externalId === "doc:2:4" && s.kind === "SALE" && s.g === "17700" && s.v === "2700") && saleRows.some((s) => s.externalId === "doc:3:1" && s.kind === "REFUND" && s.g === "5900"), JSON.stringify(saleRows));
  ok("written as ACCOUNTING_APP, API_PULL, on the document's own day — never POS", saleRows.every((s) => s.sourceKind === "ACCOUNTING_APP" && s.capture === "API_PULL" && s.d === today));
  const rcRows = (await owner.$queryRawUnsafe(`SELECT r."externalId", r."method", r."direction", r."receivedMinor"::text AS m, r."saleId", s."externalId" AS sale FROM "RevenueReceipt" r LEFT JOIN "RevenueSale" s ON s."id" = r."saleId" WHERE r."businessId" = $1 ORDER BY r."externalId"`, bizA)) as Array<Record<string, string | null>>;
  ok("one receipt per tender, naming its sale; the zero line dropped", rcRows.length === 3 && rcRows.filter((r) => r.sale === "doc:2:4").length === 2 && rcRows.some((r) => r.method === "CASH" && r.m === "7700") && rcRows.some((r) => r.method === "CARD" && r.m === "10000"), JSON.stringify(rcRows));
  ok("the refund's cash is money paid back (OUT)", rcRows.some((r) => r.sale === "doc:3:1" && r.direction === "OUT" && r.m === "5900"));
  ok("every row is inside this connection's scope", (await n(`SELECT count(*)::int AS n FROM "RevenueSale" WHERE "businessId" = $1 AND "sourceScope" <> $2`, bizA, scope)) === 0);
  const ev = (await owner.$queryRawUnsafe(`SELECT e."status", n."routeTarget", n."routingRule" FROM "IntakeEvent" e LEFT JOIN "IntakeNormalizedEvent" n ON n."intakeEventId" = e."id" WHERE e."businessId" = $1 AND e."sourceKey" = 'pos.rivhit'`, bizA)) as Array<Record<string, string>>;
  ok("through intake: every receipt PROCESSED, routed to revenue by R10", ev.length === 2 && ev.every((e) => e.status === "PROCESSED" && e.routeTarget === "revenue" && e.routingRule === "R10_REVENUE"), JSON.stringify(ev));
  ok("the cursor moved past the new numbers", (await as(bizA, () => connect.rivhitStatus(bizA, conn.id))).cursor.docs["2"] === 4);

  console.log("D. replays");
  calls.length = 0;
  await as(bizA, () => sync.syncRivhit(bizA, { now: NOW }));
  ok("the same run again: no new row, no Details call", (await sales(bizA)) === 2 && (await receipts(bizA)) === 3 && !calls.includes("Document.Details"));
  const st2 = await as(bizA, () => connect.rivhitStatus(bizA, conn.id));
  ok("re-reading an old range is a duplicate at intake (identity = the document)", (await n(`SELECT count(*)::int AS n FROM "IntakeEvent" WHERE "businessId" = $1 AND "sourceKey" = 'pos.rivhit'`, bizA)) === 2 && st2.cursor.docs["2"] === 4);

  console.log("E. cancellations after reading");
  A.docs[2][3].cancelled = true; // doc 2/4, already written
  calls.length = 0;
  await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 2 * 3600_000) }));
  const v = (await owner.$queryRawUnsafe(`SELECT v."kind", v."grossMinor"::text AS g, o."externalId" AS orig FROM "RevenueSale" v JOIN "RevenueSale" o ON o."id" = v."originalSaleId" WHERE v."businessId" = $1 AND v."kind" = 'VOID'`, bizA)) as Array<Record<string, string>>;
  ok("a VOID names the cancelled sale, with the same money", v.length === 1 && v[0].orig === "doc:2:4" && v[0].g === "17700", JSON.stringify(v));
  ok("the original sale is untouched (append-only)", (await n(`SELECT count(*)::int AS n FROM "RevenueSale" WHERE "businessId" = $1 AND "externalId" = 'doc:2:4' AND "kind" = 'SALE'`, bizA)) === 1);
  await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 4 * 3600_000) }));
  ok("the next rescan does not void it again", (await n(`SELECT count(*)::int AS n FROM "RevenueSale" WHERE "businessId" = $1 AND "kind" = 'VOID'`, bizA)) === 1);

  console.log("F. standalone receipts");
  A.receipts[1].push({ number: 2, day: today, time: "15:00:00", total: 300, vat: 0, cancelled: false, payments: [{ line: 1, amount: 295, name: "שיק", id: 1 }, { line: 2, amount: 5, name: "נ.מס במקור", id: 3 }] });
  A.receipts[2].push({ number: 4, day: today, time: "14:10:00", total: 177, vat: 0, cancelled: false, payments: [{ line: 1, amount: 177, name: "מזומן" }] });
  calls.length = 0;
  await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 5 * 3600_000) }));
  const sr = (await owner.$queryRawUnsafe(`SELECT "externalId", "method", "saleId", "receivedMinor"::text AS m FROM "RevenueReceipt" WHERE "businessId" = $1 AND "externalId" LIKE 'rcpt:%'`, bizA)) as Array<Record<string, string | null>>;
  ok("a standalone receipt lands without a sale; tax withheld is not money taken", sr.length === 1 && sr[0].externalId === "rcpt:1:2:pay:1" && sr[0].saleId === null && sr[0].m === "29500" && sr[0].method === "CHEQUE", JSON.stringify(sr));
  ok("the invoice-receipt's mirror receipt (type 2) is never read", !calls.some((c) => c === "Receipt.Details") || (await n(`SELECT count(*)::int AS n FROM "RevenueReceipt" WHERE "businessId" = $1 AND "externalId" LIKE 'rcpt:2:%'`, bizA)) === 0);
  A.receipts[1][1].cancelled = true;
  await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 7 * 3600_000) }));
  const rej = (await owner.$queryRawUnsafe(`SELECT d."decision", d."actor", d."reasonCode" FROM "RevenueDecision" d JOIN "RevenueReceipt" r ON r."id" = d."receiptId" WHERE d."businessId" = $1 AND r."externalId" = 'rcpt:1:2:pay:1'`, bizA)) as Array<Record<string, string>>;
  ok("a receipt Rivhit cancelled: its tender REJECTED by SYSTEM, reason SOURCE_CANCELLED (row kept)", rej.length === 1 && rej[0].decision === "REJECTED" && rej[0].actor === "SYSTEM" && rej[0].reasonCode === "SOURCE_CANCELLED", JSON.stringify(rej));

  console.log("G. backfill, checked day by day");
  ok("a backfill further back than allowed is refused", (await errorCode(() => as(bizA, () => connect.requestRivhitBackfill(bizA, conn.id, "2024-01-01", NOW)))) !== "");
  await as(bizA, () => connect.requestRivhitBackfill(bizA, conn.id, "2026-10-23", NOW));
  for (let i = 0; i < 4; i++) await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + (8 + i) * 3600_000) }));
  st = await as(bizA, () => connect.rivhitStatus(bizA, conn.id));
  const histIds = ((await owner.$queryRawUnsafe(`SELECT "externalId" FROM "RevenueSale" WHERE "businessId" = $1 AND "kind" <> 'VOID' ORDER BY 1`, bizA)) as Array<{ externalId: string }>).map((r) => r.externalId);
  ok("history 23–25.10 read: the invoice, the invoice-receipts, the earlier receipt", ["doc:1:1", "doc:2:1", "doc:2:2", "doc:2:3"].every((x) => histIds.includes(x)) && (await n(`SELECT count(*)::int AS n FROM "RevenueReceipt" WHERE "businessId" = $1 AND "externalId" = 'rcpt:1:1:pay:1'`, bizA)) === 1, JSON.stringify(histIds));
  ok("a document already cancelled when first read: its sale and its void (nets to nothing)", (await n(`SELECT count(*)::int AS n FROM "RevenueSale" v JOIN "RevenueSale" o ON o."id" = v."originalSaleId" WHERE v."businessId" = $1 AND o."externalId" = 'doc:2:2'`, bizA)) === 1);
  ok("the backfill finished and every finished day matches Rivhit's own summary", st.backfill === null && st.checks.length >= 3 && st.checks.every((c) => c.ok), JSON.stringify(st.checks));
  ok("backfill wrote nothing twice", (await n(`SELECT count(*)::int AS n FROM (SELECT "externalId" FROM "RevenueSale" WHERE "businessId" = $1 GROUP BY 1 HAVING count(*) > 1) x`, bizA)) === 0);

  console.log("H. an unreadable document");
  A.docs[2].push({ number: 5, day: today, time: "16:00:00", total: 10, vat: 1.53, cancelled: false, payments: [], broken: true });
  A.docs[2].push({ number: 6, day: today, time: "16:05:00", total: 20, vat: 3.05, cancelled: false, payments: [{ line: 1, amount: 20, name: "מזומן" }] });
  await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 13 * 3600_000) }));
  st = await as(bizA, () => connect.rivhitStatus(bizA, conn.id));
  ok("it is recorded for the owner, the next one is read, the cursor is not stalled", st.unreadable.some((u) => u.startsWith("doc:2:5:")) && (await n(`SELECT count(*)::int AS n FROM "RevenueSale" WHERE "businessId" = $1 AND "externalId" = 'doc:2:6'`, bizA)) === 1 && st.cursor.docs["2"] === 6, JSON.stringify(st.unreadable));

  console.log("I. tenant isolation");
  ok("the same Rivhit company cannot be live on a second business", (await errorCode(() => as(bizB, () => connect.connectRivhit({ businessId: bizB, userId: userB, apiToken: TA })))) === "company_in_use");
  const cB = await as(bizB, () => connect.connectRivhit({ businessId: bizB, userId: userB, apiToken: TB }));
  await as(bizB, () => connect.confirmRivhitTypes(bizB, cB.connection.id, types));
  companies.get(TB)!.docs[2].push({ number: 1, day: today, time: "10:00:00", total: 11.8, vat: 1.8, cancelled: false, payments: [{ line: 1, amount: 11.8, name: "מזומן" }] });
  await as(bizB, () => sync.syncRivhit(bizB, { now: NOW }));
  ok("business B wrote only its own document", (await sales(bizB)) === 1);
  const seenByB = await as(bizB, () => import("@/lib/tenant/transaction").then(({ withTenantTransaction }) => withTenantTransaction((tx) => tx.revenueSale.count())));
  ok("as the runtime, B sees exactly its own sale (RLS)", seenByB === 1);
  ok("B cannot read A's connection status", (await errorCode(() => as(bizB, () => connect.rivhitStatus(bizB, conn.id)))) !== "");

  console.log("J. the flag");
  await owner.$executeRawUnsafe(`DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'pos_rivhit'`, bizB);
  companies.get(TB)!.docs[2].push({ number: 2, day: today, time: "11:00:00", total: 11.8, vat: 1.8, cancelled: false, payments: [{ line: 1, amount: 11.8, name: "מזומן" }] });
  calls.length = 0;
  const rOff = await as(bizB, () => sync.syncRivhit(bizB, { now: NOW }));
  ok("OFF for B ⇒ not one Rivhit call, nothing written", calls.length === 0 && rOff.calls === 0 && (await sales(bizB)) === 1);

  console.log("K. a token Rivhit rejects");
  A.reject = true;
  const rRej = await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 14 * 3600_000) }));
  const row = (await owner.$queryRawUnsafe(`SELECT "status", "lastErrorCode" FROM "AcquisitionConnection" WHERE "id" = $1`, conn.id)) as Array<{ status: string; lastErrorCode: string | null }>;
  ok("the connection shows ERROR RIVHIT_TOKEN_REJECTED (the owner must act)", row[0].status === "ERROR" && row[0].lastErrorCode === "RIVHIT_TOKEN_REJECTED" && rRej.failures === 1);
  calls.length = 0;
  await as(bizA, () => sync.syncRivhit(bizA, { now: new Date(NOW.getTime() + 15 * 3600_000) }));
  ok("a connection in ERROR is not polled", calls.length === 0);
  A.reject = false;
  await owner.$executeRawUnsafe(`UPDATE "AcquisitionConnection" SET "status" = 'ACTIVE', "lastErrorCode" = NULL WHERE "id" = $1`, conn.id);

  console.log("L. a revoked connection");
  const { documentReceipt } = await import("@/lib/revenue-sources/rivhit/adapter");
  const { acceptIntake } = await import("@/lib/intake/core/processor");
  const pending = documentReceipt(conn.publicId, {
    externalId: "doc:2:99", kind: "SALE", origin: "OFFICE_OR_UNKNOWN", occurredAt: NOW, businessDay: today, registerKey: null, currency: "ILS",
    grossMinor: BigInt(100), discountMinor: BigInt(0), vatMinor: BigInt(15), pricesIncludeVat: true, lines: [], tenders: [], skippedTenders: 0, cancelled: false,
  });
  await acceptIntake({ registry: intakeRegistry, sourceKey: "pos.rivhit", accountRef: conn.publicId, receipts: [pending] });
  await as(bizA, () => revokeConnection(conn.id));
  await as(bizA, () => drainIntake(intakeRegistry, bizA, { now: NOW }));
  const late = (await owner.$queryRawUnsafe(`SELECT "status", "lastErrorCode" FROM "IntakeEvent" WHERE "businessId" = $1 AND "externalEventId" = $2`, bizA, pending.externalEventId)) as Array<{ status: string; lastErrorCode: string | null }>;
  ok("its pending receipt is settled IGNORED, never revenue", late[0]?.status === "IGNORED" && (await n(`SELECT count(*)::int AS n FROM "RevenueSale" WHERE "businessId" = $1 AND "externalId" = 'doc:2:99'`, bizA)) === 0, JSON.stringify(late));
  const wiped = (await owner.$queryRawUnsafe(`SELECT "credentialCiphertext" FROM "AcquisitionConnection" WHERE "id" = $1`, conn.id)) as Array<{ credentialCiphertext: string | null }>;
  ok("revoking wipes the encrypted token", wiped[0].credentialCiphertext === null);

  console.log("M. personal data and the token");
  const payloads = JSON.stringify(await owner.$queryRawUnsafe(`SELECT "payload", "metadata" FROM "IntakeEvent" WHERE "sourceKey" = 'pos.rivhit'`));
  ok("no customer name, phone or item text in any intake payload", !payloads.includes(PERSON) && !payloads.includes("0500000000") && !payloads.includes("SYNTHETIC ITEM"));
  const bundles = JSON.stringify(await owner.$queryRawUnsafe(`SELECT "credentialCiphertext", "label", "lastErrorCode" FROM "AcquisitionConnection" WHERE "sourceKey" = 'pos.rivhit'`));
  ok("the token is stored only encrypted (no plaintext in the row)", !bundles.includes(TA) && !bundles.includes(TB));
  const decisions = await n(`SELECT count(*)::int AS n FROM "RevenueLink"`);
  ok("no link was proposed or decided automatically (matching is a separate milestone)", decisions === 0);

  console.log(`\n${pass}/${pass + failures.length} passed`);
  await owner.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
