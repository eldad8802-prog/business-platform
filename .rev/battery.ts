/**
 * Revenue truth foundation — what migration 20261028090000_revenue_truth_foundation does, measured with the real
 * role topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane).
 *
 *   1. Catalog: FORCE RLS on every revenue table; exactly a SELECT and an INSERT policy, both on the tenant GUC;
 *      the exact ACL of every table and sequence (app_runtime SELECT / INSERT, USAGE / SELECT — the owner's
 *      DEFAULT PRIVILEGES taken back); PUBLIC holds nothing; no column grant; every guard trigger enabled.
 *   2. Isolation, four sides, per table, as the runtime: no context → nothing visible and every write refused;
 *      own rows visible; the other business's rows invisible; a write naming the other business refused;
 *      UPDATE and DELETE denied everywhere.
 *   3. Cross-business references are refused by the database: composite keys between the new tables and to
 *      Document; the link guard for ExternalTransaction and BillingDocument.
 *   4. Append-only for every role: the OWNER's UPDATE / DELETE / TRUNCATE refused by the trigger; a business
 *      deletion cascades.
 *   5. Idempotent ingestion: the same (scope, external id) is one row; ON CONFLICT DO NOTHING adds nothing.
 *   6. The arithmetic and the shapes are the database's: sale / Z / settlement totals, currency, tokens, link
 *      shapes, installments, Z revision chains.
 *   7. The link guard: only incoming bank lines, only issued tax invoices, only card tenders to an acquirer,
 *      only cash as cash, never more than the object holds, never across currencies; one proposal per pair.
 *   8. Existing systems are untouched by revenue writes: FinancialEvent, FinancialRecord, BillingDocument,
 *      PaymentTransaction and ExternalTransaction are byte-identical before and after.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only: the migration PR ships no
 * schema.prisma change (migration-first), so the generated client knows nothing of the new objects.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;

async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security/i;
const CHECK = /check constraint|23514/i;
const FK = /foreign key|23503/i;
const UNIQUE = /unique constraint|23505/i;
const APPEND_ONLY = /REVENUE_APPEND_ONLY/;
const LINK = /REVENUE_LINK_/;

const TABLES = ["RevenueSale", "RevenueReceipt", "RevenueDailyClose", "RevenueDailyCloseTender", "RevenueDailyCloseVat",
  "RevenueSettlement", "RevenueLink", "RevenueDecision"];

let keySeq = 0;
const key = (p = "k") => `${p}${Date.now().toString(36)}${(++keySeq).toString().padStart(4, "0")}`;

// Inserts as the runtime under the given business (the real write path); returns the new id or the error text.
async function add(biz: number, sql: string, ...args: unknown[]): Promise<number | string> {
  const r = await q(runtime, biz, sql, ...args);
  return typeof r === "string" ? r : Number(rows(r)[0].id);
}
const SALE = (scope: string, ext: string, kind = "SALE", total = 11800, vat = 1800, original: number | null = null) =>
  [`INSERT INTO "RevenueSale" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "kind", "originalSaleId",
      "occurredAt", "businessDay", "registerKey", "currency", "grossMinor", "discountMinor", "totalMinor", "vatMinor")
    VALUES ($1, 'POS', 'API_PUSH', '${scope}', '${ext}', '${kind}', ${original ?? "NULL"}, TIMESTAMP '2026-10-20 10:00', DATE '2026-10-20', 'r1', 'ILS',
      ${total}, 0, ${total}, ${vat}) RETURNING "id"`] as const;

async function main() {
  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-B', now()) RETURNING "id"`);
  const doc = (b: number) => mk(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status") VALUES ($1, 'lab://z', 'lab', 'application/pdf', 'NEW') RETURNING "id"`, b);
  const bank = (b: number, dir: string, amount: string, currency = "ILS") =>
    mk(`INSERT INTO "ExternalTransaction" ("businessId", "source", "externalId", "direction", "amount", "currency", "bookedAt", "updatedAt")
        VALUES ($1, 'OWNER_UPLOAD', $2, $3::"ExternalTransactionDirection", $4::numeric, $5, TIMESTAMP '2026-10-22 00:00', now()) RETURNING "id"`, b, key("bank"), dir, amount, currency);
  const invoice = (b: number, status: string, type = "TAX_INVOICE") =>
    mk(`INSERT INTO "BillingDocument" ("businessId", "documentType", "status", "documentNumber", "currency", "subtotalAmount", "vatAmount", "totalAmount", "issuedAt", "updatedAt")
        VALUES ($1, $2::"BillingDocumentType", $3::"BillingDocumentStatus", $4, 'ILS', 100, 18, 118, CASE WHEN $3 = 'ISSUED' THEN now() END, now()) RETURNING "id"`,
      b, type, status, Math.floor(Math.random() * 1e9));
  const docA = await doc(bizA); const docB = await doc(bizB);
  const creditA = await bank(bizA, "CREDIT", "500.00"); const debitA = await bank(bizA, "DEBIT", "500.00");
  const creditB = await bank(bizB, "CREDIT", "500.00"); const creditUsdA = await bank(bizA, "CREDIT", "500.00", "USD");
  const invA = await invoice(bizA, "ISSUED"); const draftA = await invoice(bizA, "DRAFT"); const invB = await invoice(bizB, "ISSUED");

  // The existing systems, as text, before any revenue write.
  const existing = async () => J(await owner.$queryRawUnsafe(
    `SELECT (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialEvent" t) AS fe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialRecord" t) AS fr,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BillingDocument" t) AS bd,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentTransaction" t) AS pt,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "ExternalTransaction" t) AS et`));
  const before = await existing();

  // ── 1. Catalog ─────────────────────────────────────────────────────────────────────────────────
  console.log("1. catalog");
  const acl = async (rel: string) => String(rows(await owner.$queryRawUnsafe(
    `SELECT coalesce((SELECT string_agg(pg_get_userbyid(x.grantee) || '=' || x.privilege_type, ',' ORDER BY pg_get_userbyid(x.grantee) || '=' || x.privilege_type)
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.oid = $1::regclass AND x.grantee <> c.relowner), '') AS a`, rel))[0].a);
  for (const t of TABLES) {
    const got = await acl(`"${t}"`);
    ok(`ACL "${t}" is exactly {app_runtime SELECT, INSERT}`, got === "app_runtime=INSERT,app_runtime=SELECT", got);
    const seq = await acl(`"${t}_id_seq"`);
    ok(`ACL "${t}_id_seq" is exactly {app_runtime USAGE, SELECT}`, seq === "app_runtime=SELECT,app_runtime=USAGE", seq);
    const r = rows(await owner.$queryRawUnsafe(
      `SELECT c.relrowsecurity AS e, c.relforcerowsecurity AS f,
              (SELECT string_agg(p.polcmd::text, '' ORDER BY p.polcmd) FROM pg_policy p WHERE p.polrelid = c.oid) AS cmds,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polroles <> ARRAY[0]::oid[]) AS role_scoped,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid
                 AND coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) NOT LIKE '%app.current_business_id%') AS off_guc,
              (SELECT count(*) FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal AND tg.tgenabled = 'O') AS triggers
         FROM pg_class c WHERE c.oid = $1::regclass`, `"${t}"`))[0];
    const wantTriggers = t === "RevenueLink" ? 3 : 2;
    ok(`${t}: RLS enabled + forced; policies exactly SELECT + INSERT on the tenant GUC; ${wantTriggers} guard triggers enabled`,
      r.e === true && r.f === true && r.cmds === "ar" && Number(r.role_scoped) === 0 && Number(r.off_guc) === 0 && Number(r.triggers) === wantTriggers,
      J(r));
  }
  const colGrants = num(await owner.$queryRawUnsafe(
    `SELECT count(*) AS n FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE c.relname = ANY($1::text[])`, TABLES));
  ok("no column-level grant on any revenue table", colGrants === 0, String(colGrants));
  const fnAcl = String(rows(await owner.$queryRawUnsafe(
    `SELECT coalesce(string_agg(p.proname || ':' || coalesce(pg_get_userbyid(x.grantee), 'PUBLIC'), ','), '') AS g
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      WHERE p.proname LIKE 'revenue\\_%' AND x.grantee <> p.proowner`))[0].g);
  ok("the guard functions are EXECUTE-able by nobody but their owner (PUBLIC revoked)", fnAcl === "", fnAcl);
  const definers = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'revenue\\_%' AND prosecdef`));
  ok("no SECURITY DEFINER function (the guards read as the inserting role, under its RLS)", definers === 0);
  const runtimeBypass = rows(await owner.$queryRawUnsafe(`SELECT rolbypassrls AS b, rolsuper AS s FROM pg_roles WHERE rolname = 'app_runtime_prod'`))[0];
  ok("the battery's runtime is NOSUPERUSER NOBYPASSRLS", runtimeBypass.b === false && runtimeBypass.s === false);

  // ── 2. Isolation, four sides, per table ─────────────────────────────────────────────────────────
  console.log("2. isolation");
  // One complete chain per business, written by the runtime under its own business.
  const chain = async (biz: number, docId: number, creditId: number, invId: number) => {
    const scope = "pos.lab";
    const sale = await add(biz, ...SALE(scope, key("s")));
    const receipt = await add(biz, `INSERT INTO "RevenueReceipt" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "saleId", "direction", "method",
        "receivedAt", "businessDay", "currency", "receivedMinor", "acquirer", "installmentCount")
      VALUES ($1, 'POS', 'API_PUSH', '${scope}', '${key("r")}', $2, 'IN', 'CARD', TIMESTAMP '2026-10-20 10:00', DATE '2026-10-20', 'ILS', 11800, 'isracard', 3) RETURNING "id"`, biz, sale);
    const close = await add(biz, `INSERT INTO "RevenueDailyClose" ("businessId", "sourceKind", "capture", "sourceScope", "documentId", "salesScope", "registerKey", "externalId",
        "zNumber", "businessDay", "currency", "grossMinor", "totalMinor", "vatMinor", "validation")
      VALUES ($1, 'POS', 'FILE_STRUCTURED', 'upload.z', $2, '${scope}', 'r1', '${key("z")}', 1041, DATE '2026-10-20', 'ILS', 11800, 11800, 1800, 'PASSED') RETURNING "id"`, biz, docId);
    const tender = await add(biz, `INSERT INTO "RevenueDailyCloseTender" ("businessId", "dailyCloseId", "method", "label", "amountMinor", "count")
      VALUES ($1, $2, 'CASH', '', 5000, 2) RETURNING "id"`, biz, close);
    const cardTender = await add(biz, `INSERT INTO "RevenueDailyCloseTender" ("businessId", "dailyCloseId", "method", "label", "amountMinor")
      VALUES ($1, $2, 'CARD', 'visa', 6800) RETURNING "id"`, biz, close);
    const vat = await add(biz, `INSERT INTO "RevenueDailyCloseVat" ("businessId", "dailyCloseId", "category", "rateBasisPoints", "taxableMinor", "vatMinor")
      VALUES ($1, $2, 'STANDARD', 1800, 10000, 1800) RETURNING "id"`, biz, close);
    const settlement = await add(biz, `INSERT INTO "RevenueSettlement" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "acquirer", "valueDate",
        "currency", "grossMinor", "feeMinor", "netMinor", "installmentNumber", "installmentCount", "validation")
      VALUES ($1, 'ACQUIRER', 'FILE_STRUCTURED', 'upload.isracard', '${key("st")}', 'isracard', DATE '2026-10-22', 'ILS', 3934, 34, 3900, 1, 3, 'PASSED') RETURNING "id"`, biz);
    const linkSettled = await add(biz, `INSERT INTO "RevenueLink" ("businessId", "linkKind", "receiptId", "settlementId", "linkedMinor", "currency", "basis", "proposedBy")
      VALUES ($1, 'TENDER_SETTLED_BY', $2, $3, 3934, 'ILS', 'RULE_EXACT', 'SYSTEM') RETURNING "id"`, biz, receipt, settlement);
    const linkDeposit = await add(biz, `INSERT INTO "RevenueLink" ("businessId", "linkKind", "settlementId", "externalTransactionId", "linkedMinor", "currency", "basis", "proposedBy")
      VALUES ($1, 'SETTLEMENT_DEPOSITED_AS', $2, $3, 3900, 'ILS', 'RULE_TOLERANCE', 'SYSTEM') RETURNING "id"`, biz, settlement, creditId);
    const linkCash = await add(biz, `INSERT INTO "RevenueLink" ("businessId", "linkKind", "dailyCloseTenderId", "externalTransactionId", "linkedMinor", "currency", "basis", "proposedBy")
      VALUES ($1, 'CASH_DEPOSITED_AS', $2, $3, 5000, 'ILS', 'OWNER_MANUAL', 'OWNER_USER') RETURNING "id"`, biz, tender, creditId);
    const linkDoc = await add(biz, `INSERT INTO "RevenueLink" ("businessId", "linkKind", "saleId", "billingDocumentId", "currency", "basis", "proposedBy")
      VALUES ($1, 'SALE_SAME_AS_DOCUMENT', $2, $3, 'ILS', 'SOURCE_REFERENCE', 'SYSTEM') RETURNING "id"`, biz, sale, invId);
    const decision = await add(biz, `INSERT INTO "RevenueDecision" ("businessId", "linkId", "decision", "actor", "idempotencyKey")
      VALUES ($1, $2, 'CONFIRMED', 'OWNER_USER', '${key("dec")}') RETURNING "id"`, biz, linkSettled);
    return { sale, receipt, close, tender, cardTender, vat, settlement, linkSettled, linkDeposit, linkCash, linkDoc, decision };
  };
  const A = await chain(bizA, docA, creditA, invA);
  const B = await chain(bizB, docB, creditB, invB);
  ok("the runtime writes a complete chain (sale → receipt → Z + tenders + VAT → settlement → links → decision) under its own business",
    Object.values(A).every((v) => typeof v === "number") && Object.values(B).every((v) => typeof v === "number"), J({ A, B }));

  const ownRow: Record<string, number> = {
    RevenueSale: A.sale as number, RevenueReceipt: A.receipt as number, RevenueDailyClose: A.close as number,
    RevenueDailyCloseTender: A.tender as number, RevenueDailyCloseVat: A.vat as number, RevenueSettlement: A.settlement as number,
    RevenueLink: A.linkSettled as number, RevenueDecision: A.decision as number,
  };
  const otherRow: Record<string, number> = {
    RevenueSale: B.sale as number, RevenueReceipt: B.receipt as number, RevenueDailyClose: B.close as number,
    RevenueDailyCloseTender: B.tender as number, RevenueDailyCloseVat: B.vat as number, RevenueSettlement: B.settlement as number,
    RevenueLink: B.linkSettled as number, RevenueDecision: B.decision as number,
  };
  for (const t of TABLES) {
    const none = await q(runtime, null, `SELECT count(*) AS n FROM "${t}"`);
    ok(`${t}: no tenant context → nothing visible`, num(none) === 0, J(none));
    const own = await q(runtime, bizA, `SELECT count(*) AS n FROM "${t}" WHERE "id" = $1`, ownRow[t]);
    ok(`${t}: own row visible`, num(own) === 1, J(own));
    const other = await q(runtime, bizA, `SELECT count(*) AS n FROM "${t}" WHERE "id" = $1`, otherRow[t]);
    ok(`${t}: the other business's row invisible`, num(other) === 0, J(other));
    const all = await q(runtime, bizA, `SELECT count(*) AS n FROM "${t}" WHERE "businessId" <> $1`, bizA);
    ok(`${t}: nothing of any other business visible`, num(all) === 0, J(all));
    const upd = await x(runtime, bizA, `UPDATE "${t}" SET "businessId" = "businessId" WHERE "id" = $1`, ownRow[t]);
    ok(`${t}: UPDATE denied to the runtime`, refused(upd, DENIED), String(upd));
    const del = await x(runtime, bizA, `DELETE FROM "${t}" WHERE "id" = $1`, ownRow[t]);
    ok(`${t}: DELETE denied to the runtime`, refused(del, DENIED), String(del));
  }
  const noCtx = await x(runtime, null, SALE("pos.lab", key("s"))[0], bizA);
  ok("no tenant context → INSERT refused", refused(noCtx, RLS), String(noCtx));
  const crossIns = await x(runtime, bizA, SALE("pos.lab", key("s"))[0], bizB);
  ok("an INSERT naming the other business is refused by RLS", refused(crossIns, RLS), String(crossIns));
  const trunc = await x(runtime, bizA, `TRUNCATE "RevenueSale" CASCADE`);
  ok("TRUNCATE denied to the runtime", refused(trunc, DENIED), String(trunc));

  // ── 3. Cross-business references ────────────────────────────────────────────────────────────────
  console.log("3. cross-business references");
  const xr = async (label: string, sql: string, re: RegExp, ...args: unknown[]) => {
    const r = await x(runtime, bizA, sql, ...args);
    ok(label, refused(r, re), String(r));
  };
  await xr("receipt → a sale of another business: refused (composite key)",
    `INSERT INTO "RevenueReceipt" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "saleId", "direction", "method", "receivedAt", "businessDay", "currency", "receivedMinor")
     VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("r")}', $2, 'IN', 'CASH', now(), DATE '2026-10-20', 'ILS', 100)`, FK, bizA, B.sale);
  await xr("refund → an original sale of another business: refused (composite key)", SALE("pos.lab", key("s"), "REFUND", 100, 0, B.sale as number)[0], FK, bizA);
  await xr("Z → a document of another business: refused (composite key)",
    `INSERT INTO "RevenueDailyClose" ("businessId", "sourceKind", "capture", "sourceScope", "documentId", "registerKey", "externalId", "businessDay", "currency", "grossMinor", "totalMinor", "vatMinor", "validation")
     VALUES ($1, 'POS', 'FILE_EXTRACTED', 'upload.z', $2, 'r1', '${key("z")}', DATE '2026-10-20', 'ILS', 0, 0, 0, 'PASSED')`, FK, bizA, docB);
  await xr("Z tender → a Z of another business: refused (composite key)",
    `INSERT INTO "RevenueDailyCloseTender" ("businessId", "dailyCloseId", "method", "amountMinor") VALUES ($1, $2, 'CASH', 1)`, FK, bizA, B.close);
  await xr("link → a bank line of another business: refused (link guard)",
    `INSERT INTO "RevenueLink" ("businessId", "linkKind", "settlementId", "externalTransactionId", "linkedMinor", "currency", "basis", "proposedBy")
     VALUES ($1, 'SETTLEMENT_DEPOSITED_AS', $2, $3, 1, 'ILS', 'RULE_EXACT', 'SYSTEM')`, LINK, bizA, A.settlement, creditB);
  await xr("link → a tax invoice of another business: refused (link guard)",
    `INSERT INTO "RevenueLink" ("businessId", "linkKind", "saleId", "billingDocumentId", "currency", "basis", "proposedBy")
     VALUES ($1, 'SALE_SAME_AS_DOCUMENT', $2, $3, 'ILS', 'OWNER_MANUAL', 'OWNER_USER')`, LINK, bizA, A.sale, invB);
  await xr("link → a settlement of another business: refused",
    `INSERT INTO "RevenueLink" ("businessId", "linkKind", "receiptId", "settlementId", "linkedMinor", "currency", "basis", "proposedBy")
     VALUES ($1, 'TENDER_SETTLED_BY', $2, $3, 1, 'ILS', 'RULE_EXACT', 'SYSTEM')`, /REVENUE_LINK_|foreign key/i, bizA, A.receipt, B.settlement);
  await xr("decision → a link of another business: refused (composite key)",
    `INSERT INTO "RevenueDecision" ("businessId", "linkId", "decision", "actor", "idempotencyKey") VALUES ($1, $2, 'REJECTED', 'OWNER_USER', '${key("dec")}')`, FK, bizA, B.linkSettled);

  // ── 4. Append-only for every role ───────────────────────────────────────────────────────────────
  console.log("4. append-only");
  for (const t of TABLES) {
    const u = await x(owner, null, `UPDATE "${t}" SET "businessId" = "businessId" WHERE "id" = $1`, ownRow[t]);
    ok(`${t}: the OWNER's UPDATE is refused by the trigger`, refused(u, APPEND_ONLY), String(u));
    const d = await x(owner, null, `DELETE FROM "${t}" WHERE "id" = $1`, ownRow[t]);
    ok(`${t}: the OWNER's DELETE is refused by the trigger`, refused(d, APPEND_ONLY), String(d));
    const tr = await x(owner, null, `TRUNCATE "${t}" CASCADE`);
    ok(`${t}: the OWNER's TRUNCATE is refused by the trigger`, refused(tr, APPEND_ONLY), String(tr));
  }
  const bizC = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-C', now()) RETURNING "id"`);
  const creditC = await bank(bizC, "CREDIT", "500.00");
  const invC = await invoice(bizC, "ISSUED");
  const docC = await doc(bizC);
  const C = await chain(bizC, docC, creditC, invC);
  ok("a third business gets a full chain", Object.values(C).every((v) => typeof v === "number"), J(C));
  // A bank line the business owns cascades its links away (and only its links).
  const etGone = await x(owner, null, `DELETE FROM "ExternalTransaction" WHERE "id" = $1`, creditC);
  const linksLeft = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "RevenueLink" WHERE "businessId" = $1 AND "externalTransactionId" IS NOT NULL`, bizC));
  const otherLinks = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "RevenueLink" WHERE "businessId" = $1`, bizC));
  ok("deleting a bank line cascades exactly the links that name it", etGone === 1 && linksLeft === 0 && otherLinks === 2, J({ etGone, linksLeft, otherLinks }));
  // The business's own revenue rows leave with it (it has a BillingDocument, whose key RESTRICTs a business
  // delete, so the lab removes the business's revenue through a business without fiscal documents instead).
  const bizD = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('rev-D', now()) RETURNING "id"`);
  const saleD = await add(bizD, ...SALE("pos.lab", key("s")));
  await add(bizD, `INSERT INTO "RevenueReceipt" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "saleId", "direction", "method", "receivedAt", "businessDay", "currency", "receivedMinor")
     VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("r")}', $2, 'IN', 'CASH', now(), DATE '2026-10-20', 'ILS', 100) RETURNING "id"`, bizD, saleD);
  const delBiz = await x(owner, null, `DELETE FROM "Business" WHERE "id" = $1`, bizD);
  const leftD = num(await owner.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "RevenueSale" WHERE "businessId" = $1) + (SELECT count(*) FROM "RevenueReceipt" WHERE "businessId" = $1) AS n`, bizD));
  ok("a business deletion cascades its revenue rows (the only way a row leaves)", delBiz === 1 && leftD === 0, J({ delBiz, leftD }));

  // ── 5. Idempotent ingestion ─────────────────────────────────────────────────────────────────────
  console.log("5. idempotent ingestion");
  const ext = key("dup");
  const first = await add(bizA, ...SALE("pos.lab", ext));
  const again = await add(bizA, ...SALE("pos.lab", ext));
  ok("the same (scope, external id) a second time is refused by the unique key", typeof first === "number" && refused(again, UNIQUE), String(again));
  const skip = await x(runtime, bizA, SALE("pos.lab", ext)[0].replace(`RETURNING "id"`, `ON CONFLICT DO NOTHING`), bizA);
  ok("ON CONFLICT DO NOTHING adds nothing", skip === 0, String(skip));
  const sameExtOtherScope = await add(bizA, ...SALE("pos.other", ext));
  ok("the same external id from another source scope is another row", typeof sameExtOtherScope === "number", String(sameExtOtherScope));
  const sameExtOtherBiz = await add(bizB, ...SALE("pos.lab", ext));
  ok("the same external id in another business is that business's own row", typeof sameExtOtherBiz === "number", String(sameExtOtherBiz));
  const dupDecision = key("dec");
  const d1 = await add(bizA, `INSERT INTO "RevenueDecision" ("businessId", "linkId", "decision", "actor", "idempotencyKey") VALUES ($1, $2, 'CONFIRMED', 'SYSTEM', '${dupDecision}') RETURNING "id"`, bizA, A.linkDeposit);
  const d2 = await add(bizA, `INSERT INTO "RevenueDecision" ("businessId", "linkId", "decision", "actor", "idempotencyKey") VALUES ($1, $2, 'CONFIRMED', 'SYSTEM', '${dupDecision}') RETURNING "id"`, bizA, A.linkDeposit);
  ok("a decision retried with its idempotency key is one row", typeof d1 === "number" && refused(d2, UNIQUE), String(d2));

  // ── 6. Arithmetic and shapes ────────────────────────────────────────────────────────────────────
  console.log("6. arithmetic and shapes");
  const bad = async (label: string, sql: string, re = CHECK, ...args: unknown[]) => {
    const r = await x(runtime, bizA, sql, bizA, ...args);
    ok(label, refused(r, re), String(r));
  };
  const saleCols = `"businessId", "sourceKind", "capture", "sourceScope", "externalId", "kind", "occurredAt", "businessDay", "currency", "grossMinor", "discountMinor", "totalMinor", "vatMinor"`;
  await bad("sale: total ≠ gross − discount refused", `INSERT INTO "RevenueSale" (${saleCols}) VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("s")}', 'SALE', now(), DATE '2026-10-20', 'ILS', 1000, 100, 1000, 0)`);
  await bad("sale: VAT above the total refused", `INSERT INTO "RevenueSale" (${saleCols}) VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("s")}', 'SALE', now(), DATE '2026-10-20', 'ILS', 1000, 0, 1000, 1001)`);
  await bad("sale: a negative amount refused", `INSERT INTO "RevenueSale" (${saleCols}) VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("s")}', 'SALE', now(), DATE '2026-10-20', 'ILS', -1, 0, -1, 0)`);
  await bad("sale: an unsupported currency refused", `INSERT INTO "RevenueSale" (${saleCols}) VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("s")}', 'SALE', now(), DATE '2026-10-20', 'GBP', 1, 0, 1, 0)`);
  await bad("sale: free text in an id refused", `INSERT INTO "RevenueSale" (${saleCols}) VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', 'Dana Cohen 054-1234567', 'SALE', now(), DATE '2026-10-20', 'ILS', 1, 0, 1, 0)`);
  await bad("sale: a SALE naming an original refused",
    `INSERT INTO "RevenueSale" (${saleCols}, "originalSaleId") VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("s")}', 'SALE', now(), DATE '2026-10-20', 'ILS', 1, 0, 1, 0, $2)`, CHECK, A.sale);
  const refund = await add(bizA, ...SALE("pos.lab", key("rf"), "REFUND", 2000, 305, A.sale as number));
  ok("a refund naming its original sale is a new row (the original is untouched)", typeof refund === "number", String(refund));
  const zCols = `"businessId", "sourceKind", "capture", "sourceScope", "registerKey", "externalId", "businessDay", "currency", "grossMinor", "discountMinor", "refundMinor", "voidMinor", "totalMinor", "vatMinor", "validation"`;
  await bad("Z: total ≠ gross − discount − refunds − voids refused", `INSERT INTO "RevenueDailyClose" (${zCols}) VALUES ($1, 'POS', 'FILE_STRUCTURED', 'upload.z', 'r1', '${key("z")}', DATE '2026-10-20', 'ILS', 1000, 10, 20, 30, 1000, 0, 'PASSED')`);
  await bad("Z: a validation code with free text refused",
    `INSERT INTO "RevenueDailyClose" (${zCols}, "validationCodes") VALUES ($1, 'POS', 'FILE_STRUCTURED', 'upload.z', 'r1', '${key("z")}', DATE '2026-10-20', 'ILS', 0, 0, 0, 0, 0, 0, 'WARNINGS', ARRAY['TENDER_MISMATCH', 'see note'])`);
  await bad("Z: revision 2 without the revision it supersedes refused",
    `INSERT INTO "RevenueDailyClose" (${zCols}, "revision") VALUES ($1, 'POS', 'FILE_STRUCTURED', 'upload.z', 'r1', '${key("z")}', DATE '2026-10-20', 'ILS', 0, 0, 0, 0, 0, 0, 'PASSED', 2)`);
  const zExt = key("z");
  const z1 = await add(bizA, `INSERT INTO "RevenueDailyClose" (${zCols}) VALUES ($1, 'POS', 'FILE_EXTRACTED', 'upload.z', 'r1', '${zExt}', DATE '2026-10-21', 'ILS', 1000, 0, 0, 0, 1000, 153, 'WARNINGS') RETURNING "id"`, bizA);
  const z2 = await add(bizA, `INSERT INTO "RevenueDailyClose" (${zCols}, "revision", "supersedesId") VALUES ($1, 'POS', 'FILE_EXTRACTED', 'upload.z', 'r1', '${zExt}', DATE '2026-10-21', 'ILS', 1100, 0, 0, 0, 1100, 168, 'PASSED', 2, $2) RETURNING "id"`, bizA, z1);
  const z2b = await add(bizA, `INSERT INTO "RevenueDailyClose" (${zCols}, "revision", "supersedesId") VALUES ($1, 'POS', 'FILE_EXTRACTED', 'upload.z', 'r1', '${zExt}', DATE '2026-10-21', 'ILS', 1200, 0, 0, 0, 1200, 183, 'PASSED', 3, $2) RETURNING "id"`, bizA, z1);
  ok("a corrected Z is revision 2 superseding revision 1 (revision 1 kept); a second correction of the SAME revision is refused (a chain, never a fork)",
    typeof z1 === "number" && typeof z2 === "number" && refused(z2b, UNIQUE), J({ z1, z2, z2b }));
  await bad("Z VAT line: a zero-rated line with VAT refused",
    `INSERT INTO "RevenueDailyCloseVat" ("businessId", "dailyCloseId", "category", "rateBasisPoints", "taxableMinor", "vatMinor") VALUES ($1, $2, 'ZERO_RATED', 0, 100, 5)`, CHECK, A.close);
  const stCols = `"businessId", "sourceKind", "capture", "sourceScope", "externalId", "acquirer", "valueDate", "currency", "grossMinor", "feeMinor", "otherDeductionsMinor", "netMinor", "validation"`;
  await bad("settlement: net ≠ gross − fee − other deductions refused", `INSERT INTO "RevenueSettlement" (${stCols}) VALUES ($1, 'ACQUIRER', 'FILE_STRUCTURED', 'upload.max', '${key("st")}', 'max', DATE '2026-10-22', 'ILS', 1000, 20, 0, 1000, 'PASSED')`);
  await bad("settlement: from a register (not an acquirer / provider) refused", `INSERT INTO "RevenueSettlement" (${stCols}) VALUES ($1, 'POS', 'FILE_STRUCTURED', 'upload.max', '${key("st")}', 'max', DATE '2026-10-22', 'ILS', 1000, 20, 0, 980, 'PASSED')`);
  await bad("settlement: installment 4 of 3 refused",
    `INSERT INTO "RevenueSettlement" (${stCols}, "installmentNumber", "installmentCount") VALUES ($1, 'ACQUIRER', 'FILE_STRUCTURED', 'upload.max', '${key("st")}', 'max', DATE '2026-10-22', 'ILS', 1000, 20, 0, 980, 'PASSED', 4, 3)`);
  await bad("receipt: installments on a cash receipt refused",
    `INSERT INTO "RevenueReceipt" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "direction", "method", "receivedAt", "businessDay", "currency", "receivedMinor", "installmentCount")
     VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("r")}', 'IN', 'CASH', now(), DATE '2026-10-20', 'ILS', 100, 3)`);
  await bad("link: a deposit link without an amount refused",
    `INSERT INTO "RevenueLink" ("businessId", "linkKind", "settlementId", "externalTransactionId", "currency", "basis", "proposedBy") VALUES ($1, 'SETTLEMENT_DEPOSITED_AS', $2, $3, 'ILS', 'RULE_EXACT', 'SYSTEM')`,
    /REVENUE_LINK_|check constraint/i, A.settlement, creditA);
  await bad("link: a sale-document link that also names a bank line refused",
    `INSERT INTO "RevenueLink" ("businessId", "linkKind", "saleId", "billingDocumentId", "externalTransactionId", "currency", "basis", "proposedBy") VALUES ($1, 'SALE_SAME_AS_DOCUMENT', $2, $3, $4, 'ILS', 'RULE_EXACT', 'SYSTEM')`,
    /REVENUE_LINK_|check constraint/i, A.sale, invA, creditA);
  await bad("decision: naming both a link and a Z refused",
    `INSERT INTO "RevenueDecision" ("businessId", "linkId", "dailyCloseId", "decision", "actor", "idempotencyKey") VALUES ($1, $2, $3, 'CONFIRMED', 'SYSTEM', '${key("dec")}')`, CHECK, A.linkSettled, A.close);
  const zDecision = await add(bizA, `INSERT INTO "RevenueDecision" ("businessId", "dailyCloseId", "decision", "actor", "reasonCode", "idempotencyKey") VALUES ($1, $2, 'CONFIRMED', 'OWNER_USER', 'READ_FROM_PHOTO_OK', '${key("dec")}') RETURNING "id"`, bizA, z2);
  ok("the owner's confirmation of a Z read from a photo is a decision row", typeof zDecision === "number", String(zDecision));

  // ── 7. The link guard ───────────────────────────────────────────────────────────────────────────
  console.log("7. link guard");
  const linkSql = (kind: string, cols: string, vals: string) =>
    `INSERT INTO "RevenueLink" ("businessId", "linkKind", ${cols}, "currency", "basis", "proposedBy") VALUES ($1, '${kind}', ${vals}, 'ILS', 'RULE_EXACT', 'SYSTEM')`;
  await bad("deposit link → an OUTGOING (DEBIT) bank line refused", linkSql("SETTLEMENT_DEPOSITED_AS", `"settlementId", "externalTransactionId", "linkedMinor"`, `$2, $3, 100`), LINK, A.settlement, debitA);
  await bad("deposit link → more than the bank line holds refused", linkSql("SETTLEMENT_DEPOSITED_AS", `"settlementId", "externalTransactionId", "linkedMinor"`, `$2, $3, 50001`), LINK, A.settlement, creditA);
  await bad("deposit link → a bank line in another currency refused", linkSql("SETTLEMENT_DEPOSITED_AS", `"settlementId", "externalTransactionId", "linkedMinor"`, `$2, $3, 100`), LINK, A.settlement, creditUsdA);
  await bad("deposit link → more than the settlement's NET refused", linkSql("SETTLEMENT_DEPOSITED_AS", `"settlementId", "externalTransactionId", "linkedMinor"`, `$2, $3, 3901`), LINK, A.settlement, creditA);
  await bad("tender link → more than the settlement's GROSS refused", linkSql("TENDER_SETTLED_BY", `"dailyCloseTenderId", "settlementId", "linkedMinor"`, `$2, $3, 3935`), LINK, A.cardTender, A.settlement);
  await bad("tender link → a CASH tender to an acquirer refused", linkSql("TENDER_SETTLED_BY", `"dailyCloseTenderId", "settlementId", "linkedMinor"`, `$2, $3, 100`), LINK, A.tender, A.settlement);
  await bad("cash deposit → a CARD tender refused", linkSql("CASH_DEPOSITED_AS", `"dailyCloseTenderId", "externalTransactionId", "linkedMinor"`, `$2, $3, 100`), LINK, A.cardTender, creditA);
  await bad("cash deposit → more than the cash tender refused", linkSql("CASH_DEPOSITED_AS", `"dailyCloseTenderId", "externalTransactionId", "linkedMinor"`, `$2, $3, 5001`), LINK, A.tender, creditA);
  await bad("sale = document → a DRAFT document refused", linkSql("SALE_SAME_AS_DOCUMENT", `"saleId", "billingDocumentId"`, `$2, $3`), LINK, A.sale, draftA);
  await bad("sale = document → a REFUND (not a sale) refused", linkSql("SALE_SAME_AS_DOCUMENT", `"saleId", "billingDocumentId"`, `$2, $3`), LINK, refund, invA);
  const outReceipt = await add(bizA, `INSERT INTO "RevenueReceipt" ("businessId", "sourceKind", "capture", "sourceScope", "externalId", "direction", "method", "receivedAt", "businessDay", "currency", "receivedMinor")
     VALUES ($1, 'POS', 'API_PUSH', 'pos.lab', '${key("r")}', 'OUT', 'CARD', now(), DATE '2026-10-20', 'ILS', 2000) RETURNING "id"`, bizA);
  await bad("tender link → money paid OUT refused", linkSql("TENDER_SETTLED_BY", `"receiptId", "settlementId", "linkedMinor"`, `$2, $3, 100`), LINK, outReceipt, A.settlement);
  await bad("the same sale = document pair proposed twice refused (a rejected pair stays rejected)", linkSql("SALE_SAME_AS_DOCUMENT", `"saleId", "billingDocumentId"`, `$2, $3`), UNIQUE, A.sale, invA);
  await bad("the same settlement → bank line pair proposed twice refused", linkSql("SETTLEMENT_DEPOSITED_AS", `"settlementId", "externalTransactionId", "linkedMinor"`, `$2, $3, 10`), UNIQUE, A.settlement, creditA);
  // A partial settlement: two installments of one card receipt are two settlements, each linked for its part.
  const st2 = await add(bizA, `INSERT INTO "RevenueSettlement" (${stCols}, "installmentNumber", "installmentCount") VALUES ($1, 'ACQUIRER', 'FILE_STRUCTURED', 'upload.isracard', '${key("st")}', 'isracard', DATE '2026-11-22', 'ILS', 3933, 33, 0, 3900, 'PASSED', 2, 3) RETURNING "id"`, bizA);
  const part2 = await add(bizA, linkSql("TENDER_SETTLED_BY", `"receiptId", "settlementId", "linkedMinor"`, `$2, $3, 3933`) + ` RETURNING "id"`, bizA, A.receipt, st2);
  ok("installment 2 of the same receipt links to its own settlement for its own part", typeof part2 === "number", String(part2));

  // ── 8. Existing systems untouched ───────────────────────────────────────────────────────────────
  console.log("8. existing systems");
  // The fixtures above were inserted BEFORE the snapshot, except the third business's bank line and invoice
  // (and the bank line the cascade test removed): compare only rows that existed at the snapshot.
  const after = J(await owner.$queryRawUnsafe(
    `SELECT (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialEvent" t) AS fe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialRecord" t) AS fr,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BillingDocument" t WHERE t."businessId" <> $1) AS bd,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentTransaction" t) AS pt,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "ExternalTransaction" t WHERE t."businessId" <> $1) AS et`, bizC));
  ok("FinancialEvent, FinancialRecord, BillingDocument, PaymentTransaction, ExternalTransaction: byte-identical after every revenue write",
    after === before, `${before} → ${after}`);
  const feRows = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "FinancialEvent"`));
  ok("no FinancialEvent row was written by anything revenue truth did", feRows === 0, String(feRows));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
