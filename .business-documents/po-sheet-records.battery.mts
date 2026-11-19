/**
 * Purchase-order sheet — migration 20261121090000 AS the runtime role (PG17, real migrations via `prisma migrate
 * deploy`, Production role topology: .business-documents/lab.sh <db> --with-po).
 *
 * Database-level proofs only (rendering, idempotent saving and downloads are the service battery's). Every check runs
 * as app_runtime_prod (member of NOLOGIN app_runtime, NOSUPERUSER, NOBYPASSRLS); the owner only seeds and reads the
 * catalog.
 *
 * env: DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner).
 * Run: npx tsx .business-documents/po-sheet-records.battery.mts
 */
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });
const R1 = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function refused(name: string, fn: () => Promise<unknown>, expect: RegExp) {
  try {
    await fn();
    ok(name, false, "it succeeded");
  } catch (e) {
    const m = String((e as Error).message);
    ok(name, expect.test(m), expect.test(m) ? (m.match(expect)?.[0] ?? "") : m.split("\n").slice(-2).join(" "));
  }
}
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
function inCtx<T>(c: PrismaClient, b: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return c.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${b}', true)`);
    return fn(tx);
  }, { timeout: 30000, maxWait: 15000 });
}
const one = async <T,>(tx: Tx | PrismaClient, sql: string, ...a: unknown[]) => ((await tx.$queryRawUnsafe(sql, ...a)) as T[])[0];
const n = async (sql: string, ...a: unknown[]) => Number((await one<{ n: bigint | number }>(own, sql, ...a)).n);

async function committedFile(b: number, purpose = "PURCHASE_ORDER_SHEET"): Promise<number> {
  return inCtx(R1, b, async (tx) => {
    const f = await one<{ id: number }>(tx, `INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, $2::"BusinessDocumentFilePurpose", $3) RETURNING id`, b, purpose, `biz/${b}/business-docs/${randomUUID()}.pdf`);
    await tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'COMMITTED', "sha256" = $1, "bytes" = 10, "committedAt" = now() WHERE id = $2`, sha("pdf"), f.id);
    return f.id;
  });
}
async function sheet(b: number, draft: number, file: number, over: { number?: string; locale?: string } = {}) {
  return inCtx(R1, b, (tx) => one<{ id: number }>(tx,
    `INSERT INTO "PurchaseOrderSheet" ("businessId", "supplierPurchaseDraftId", "fileId", "sha256", "contentHash", "displayedNumberSnapshot",
       "externalNumberSnapshot", "supplierNameSnapshot", "documentSnapshot", "locale", "headerTitleSnapshot", "displayDateSnapshot")
     VALUES ($1, $2, $3, $4, $5, $6, 'A-100', 'ספק', '{"lines":[]}'::jsonb, $7, 'מלאי · Dubiz', '3.11.2026') RETURNING id`,
    b, draft, file, sha("pdf"), sha("content"), over.number ?? `#${draft}`, over.locale ?? "he"));
}

async function main() {
  const stamp = Date.now();
  const mk = async (name: string) => (await own.business.create({ data: { name: `po-${name}-${stamp}` } })).id;
  const A = await mk("A"), B = await mk("B");
  const draft = async (b: number) => (await own.supplierPurchaseDraft.create({ data: { businessId: b, supplierName: "ספק", externalOrderId: "A-100" } })).id;
  const dA = await draft(A), dA2 = await draft(A), dB = await draft(B);

  console.log("--- controls ---");
  const rtRole = await one<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>(R1, `SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  ok("the battery runs as a NOSUPERUSER NOBYPASSRLS runtime login", !rtRole.rolsuper && !rtRole.rolbypassrls, rtRole.u);
  ok("both enum values exist", (await n(`SELECT count(*) AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE e.enumlabel = 'PURCHASE_ORDER_SHEET' AND t.typname IN ('BusinessDocumentFilePurpose','BusinessDocumentOperation')`)) === 2);
  ok("no tenant context → 0 sheets", Number((await one<{ n: number }>(R1, `SELECT count(*) AS n FROM "PurchaseOrderSheet"`)).n) === 0);

  console.log("--- privileges (catalog) ---");
  const p = await one<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>(own, `SELECT has_table_privilege('app_runtime', '"PurchaseOrderSheet"', 'SELECT') AS s, has_table_privilege('app_runtime', '"PurchaseOrderSheet"', 'INSERT') AS i, has_table_privilege('app_runtime', '"PurchaseOrderSheet"', 'UPDATE') AS u, has_table_privilege('app_runtime', '"PurchaseOrderSheet"', 'DELETE') AS d, has_table_privilege('app_runtime', '"PurchaseOrderSheet"', 'TRUNCATE') AS t`);
  ok("app_runtime: SELECT + INSERT only (no UPDATE, DELETE, TRUNCATE)", p.s && p.i && !p.u && !p.d && !p.t);
  ok("no UPDATE on any column for the runtime", (await n(`SELECT count(*) AS n FROM information_schema.column_privileges WHERE grantee = 'app_runtime' AND table_name = 'PurchaseOrderSheet' AND privilege_type = 'UPDATE'`)) === 0);
  ok("no PUBLIC grant", (await n(`SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = 'PurchaseOrderSheet'`)) === 0);
  ok("FORCE RLS, no DELETE / UPDATE / ALL policy", (await n(`SELECT count(*) AS n FROM pg_class WHERE relname = 'PurchaseOrderSheet' AND relforcerowsecurity`)) === 1 && (await n(`SELECT count(*) AS n FROM pg_policies WHERE tablename = 'PurchaseOrderSheet' AND cmd IN ('DELETE','UPDATE','ALL')`)) === 0);
  ok("no foreign key to any inventory table (inventory unchanged)", (await n(`SELECT count(*) AS n FROM pg_constraint WHERE conrelid = '"PurchaseOrderSheet"'::regclass AND contype = 'f' AND confrelid IN ('"SupplierPurchaseDraft"'::regclass, '"PurchaseOrder"'::regclass)`)) === 0);
  ok("the inventory tables gained no constraint, trigger or policy from this migration", (await n(`SELECT count(*) AS n FROM pg_trigger WHERE tgrelid IN ('"SupplierPurchaseDraft"'::regclass, '"PurchaseOrder"'::regclass) AND tgname ILIKE '%sheet%'`)) === 0);
  const fn = await one<{ prosecdef: boolean; cfg: string; acl: string; src: string }>(own, `SELECT p.prosecdef, array_to_string(p.proconfig, ',') AS cfg, coalesce(p.proacl::text, '') AS acl, p.prosrc AS src FROM pg_proc p WHERE p.proname = 'business_documents_erase'`);
  ok("business_documents_erase: still SECURITY DEFINER, pinned search_path, runtime execute, no PUBLIC", fn.prosecdef && /search_path=pg_catalog, public, pg_temp$/.test(fn.cfg) && /app_runtime=X/.test(fn.acl) && !/(^|[{,])=X/.test(fn.acl));
  ok("business_documents_erase now deletes the sheets (and keeps every earlier table)", ["PurchaseOrderSheet", "QuoteShareEvent", "QuoteShareCopy", "BusinessLetter", "BusinessDocumentRequest"].every((t) => fn.src.includes(`DELETE FROM public."${t}"`)));

  console.log("--- the draft link (same business, own number) ---");
  const s1 = await sheet(A, dA, await committedFile(A));
  ok("a sheet of A's own supplier order, numbered with its id", !!s1.id);
  await refused("a sheet of B's supplier order from A's context → not found", async () => sheet(A, dB, await committedFile(A)), /PO_DRAFT_NOT_FOUND/);
  await refused("a supplier order that does not exist → not found", async () => sheet(A, 2147483000, await committedFile(A), { number: "#2147483000" }), /PO_DRAFT_NOT_FOUND/);
  await refused("a number other than the order's own → refused", async () => sheet(A, dA, await committedFile(A), { number: `#${dA2}` }), /PO_NUMBER_MISMATCH/);
  await refused("a malformed number → CHECK", async () => sheet(A, dA, await committedFile(A), { number: "PO-1" }), /number_shape|PO_NUMBER_MISMATCH/);
  await refused("a file of another purpose (a letter's) → refused", async () => sheet(A, dA, await committedFile(A, "LETTER")), /PO_FILE_PURPOSE/);
  await refused("a locale other than he / en → CHECK", async () => sheet(A, dA, await committedFile(A), { locale: "fr" }), /PurchaseOrderSheet_locale/);
  // Labelled B from A's context: B's file and order are invisible under A's context, so a BEFORE guard refuses it
  // first; the RLS WITH CHECK would refuse it after them. Either way no cross-business row can be written.
  await refused("a row labelled business B from A's context → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`INSERT INTO "PurchaseOrderSheet" ("businessId","supplierPurchaseDraftId","fileId","sha256","contentHash","displayedNumberSnapshot","documentSnapshot","locale","headerTitleSnapshot","displayDateSnapshot") VALUES ($1,$2,1,$3,$3,$4,'{}'::jsonb,'he','x','1.1.2026')`, B, dB, sha("x"), `#${dB}`)), /row-level security|PO_DRAFT_NOT_FOUND|FILE_NOT_AVAILABLE/);
  ok("B sees none of A's sheets", Number((await inCtx(R1, B, (tx) => one<{ n: number }>(tx, `SELECT count(*) AS n FROM "PurchaseOrderSheet"`))).n) === 0);
  const s2 = await sheet(A, dA, await committedFile(A));
  ok("several saved copies of the same order are allowed (each its own file)", !!s2.id && s2.id !== s1.id);
  const usedFile = (await own.$queryRawUnsafe(`SELECT "fileId" FROM "PurchaseOrderSheet" WHERE id = $1`, s1.id) as { fileId: number }[])[0].fileId;
  await refused("one file cannot back two sheets → unique", () => sheet(A, dA, usedFile), /PurchaseOrderSheet_businessId_fileId_key|unique/i);

  console.log("--- a saved copy's file stays (only the erasure may mark it) ---");
  await refused("the runtime cannot mark a saved copy's COMMITTED file DELETING", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE id = $1`, usedFile)), /STILL_REFERENCED/);
  ok("…and the file is still COMMITTED", (await n(`SELECT count(*) AS n FROM "BusinessDocumentFile" WHERE id = $1 AND state = 'COMMITTED'`, usedFile)) === 1);
  const loose = await committedFile(A);
  ok("an unreferenced purchase-order-sheet file can still be marked DELETING (the guard is not broader)", (await inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE id = $1`, loose))) === 1);
  const guard = await one<{ src: string; cfg: string; acl: string }>(own, `SELECT p.prosrc AS src, array_to_string(p.proconfig, ',') AS cfg, coalesce(p.proacl::text, '') AS acl FROM pg_proc p WHERE p.proname = 'business_documents_file_guard'`);
  ok("business_documents_file_guard: counts sheets, keeps quote copies and letters, pinned search_path, no PUBLIC", ["PurchaseOrderSheet", "QuoteShareCopy", "BusinessLetter"].every((t) => guard.src.includes(`FROM public."${t}"`)) && /search_path=pg_catalog, public, pg_temp$/.test(guard.cfg) && !/(^|[{,])=X/.test(guard.acl));

  console.log("--- the stored file must be ready ---");
  const pending = await inCtx(R1, A, (tx) => one<{ id: number }>(tx, `INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'PURCHASE_ORDER_SHEET', $2) RETURNING id`, A, `biz/${A}/business-docs/${randomUUID()}.pdf`));
  await refused("a PENDING file → not available", () => sheet(A, dA, pending.id), /FILE_NOT_AVAILABLE/);

  console.log("--- append-only ---");
  await refused("UPDATE by the runtime → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "PurchaseOrderSheet" SET "displayDateSnapshot" = '1.1.2020' WHERE id = $1`, s1.id)), /permission denied|APPEND_ONLY/);
  await refused("DELETE by the runtime → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`DELETE FROM "PurchaseOrderSheet" WHERE id = $1`, s1.id)), /permission denied|APPEND_ONLY/);
  await refused("TRUNCATE by the runtime → refused", () => R1.$executeRawUnsafe(`TRUNCATE "PurchaseOrderSheet"`), /permission denied|APPEND_ONLY/);
  await refused("even the owner cannot UPDATE a saved copy", () => own.$executeRawUnsafe(`UPDATE "PurchaseOrderSheet" SET "displayDateSnapshot" = '1.1.2020' WHERE id = $1`, s1.id), /APPEND_ONLY/);
  await own.$executeRawUnsafe(`UPDATE "SupplierPurchaseDraft" SET "supplierName" = 'ספק אחר', "externalOrderId" = 'Z-9' WHERE id = $1`, dA);
  const frozen = await one<{ s: string; e: string }>(own, `SELECT "supplierNameSnapshot" AS s, "externalNumberSnapshot" AS e FROM "PurchaseOrderSheet" WHERE id = $1`, s1.id);
  ok("editing the supplier order later does not change a saved copy", frozen.s === "ספק" && frozen.e === "A-100");

  console.log("--- not while erasing; erased with the account ---");
  const fileB = await committedFile(B); // a valid, COMMITTED file and B's own order: only the deletion can refuse
  await own.business.update({ where: { id: B }, data: { deletionRequestedAt: new Date() } });
  await refused("no new sheet for a business being deleted (valid file and order)", () => sheet(B, dB, fileB), /BUSINESS_BEING_ERASED/);
  await own.business.update({ where: { id: A }, data: { deletionRequestedAt: new Date() } });
  const marked = await inCtx(R1, A, (tx) => one<{ n: number }>(tx, `SELECT public.business_documents_erase() AS n`));
  ok("erase: the sheets are deleted, their files moved to DELETING", (await n(`SELECT count(*) AS n FROM "PurchaseOrderSheet" WHERE "businessId" = $1`, A)) === 0 && (await n(`SELECT count(*) AS n FROM "BusinessDocumentFile" WHERE "businessId" = $1 AND state IN ('PENDING','COMMITTED')`, A)) === 0, `files marked: ${marked.n}`);
  ok("erase leaves B untouched", (await n(`SELECT count(*) AS n FROM "SupplierPurchaseDraft" WHERE "businessId" = $1`, B)) === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await own.$disconnect();
    await R1.$disconnect();
  });
