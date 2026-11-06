/**
 * Business documents records — migration 20261114090000 AS the runtime role (PG17, real migration via
 * `prisma migrate deploy`, Production role topology: .business-documents/lab.sh <db> --with-bd).
 *
 * Database-level proofs only (the storage fence, idempotent claims and the read-only quote copy are proven by the
 * service battery). Every check runs as app_runtime_prod (member of NOLOGIN app_runtime, NOSUPERUSER, NOBYPASSRLS).
 *
 * env: DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner — seeding and catalog reads only).
 * Run: npx tsx .business-documents/records.battery.mts
 */
import { createHash, randomUUID } from "node:crypto";
import { BillingDocumentType, PrismaClient } from "@prisma/client";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });
const rt = () => new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const R1 = rt(), R2 = rt();

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

// ── helpers that mirror what the service does, at the SQL level ─────────────────────────────────────
async function committedFile(b: number, purpose = "QUOTE_SHARE_COPY"): Promise<number> {
  return inCtx(R1, b, async (tx) => {
    const f = await one<{ id: number }>(tx, `INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, $2::"BusinessDocumentFilePurpose", $3) RETURNING id`, b, purpose, `biz/${b}/business-docs/${randomUUID()}.pdf`);
    await tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'COMMITTED', "sha256" = $1, "bytes" = 10, "committedAt" = now() WHERE id = $2`, sha("pdf"), f.id);
    return f.id;
  });
}
async function copyOf(c: PrismaClient, b: number, quote: number, file: number) {
  return inCtx(c, b, (tx) => one<{ id: number }>(tx, `INSERT INTO "QuoteShareCopy" ("businessId", "quoteDocumentId", "fileId", "sha256", "quoteContentHash", "quoteNumberSnapshot", "totalSnapshot", "currencySnapshot", "contentCheckedAt") VALUES ($1, $2, $3, $4, $5, 'Q-1', 100, 'ILS', now()) RETURNING id`, b, quote, file, sha("pdf"), sha("content")));
}
async function event(c: PrismaClient, b: number, quote: number, kind: string, extra: { copyId?: number; correctsEventId?: number; note?: string; channel?: string } = {}) {
  return inCtx(c, b, (tx) => one<{ id: number }>(tx,
    `INSERT INTO "QuoteShareEvent" ("businessId", "quoteDocumentId", "kind", "copyId", "correctsEventId", "note", "channel", "quoteContentHash")
     VALUES ($1, $2, $3::"QuoteShareEventKind", $4, $5, $6, $7::"QuoteShareChannel", $8) RETURNING id`,
    b, quote, kind, extra.copyId ?? null, extra.correctsEventId ?? null, extra.note ?? null, extra.channel ?? null, sha("content")));
}
async function letter(c: PrismaClient, b: number, file: number, kind: string, link: { customerId?: number | null; supplierId?: number | null } = {}) {
  return inCtx(c, b, (tx) => one<{ id: number }>(tx,
    `INSERT INTO "BusinessLetter" ("businessId", "recipientKind", "customerId", "supplierId", "recipientName", "issuerSnapshot", "subject", "body", "letterDate", "fileId", "sha256")
     VALUES ($1, $2::"BusinessLetterRecipientKind", $3, $4, 'נמען', '{"displayName":"עסק"}'::jsonb, 'נושא', 'גוף', CURRENT_DATE, $5, $6) RETURNING id`,
    b, kind, link.customerId ?? null, link.supplierId ?? null, file, sha("pdf")));
}

async function main() {
  const stamp = Date.now();
  const mk = async (name: string) => (await own.business.create({ data: { name: `bd-${name}-${stamp}` } })).id;
  const A = await mk("A"), B = await mk("B"), C = await mk("C");
  const quote = async (b: number, type: BillingDocumentType = BillingDocumentType.QUOTE) => (await own.billingDocument.create({ data: { businessId: b, documentType: type } })).id;
  const qA = await quote(A), qA2 = await quote(A), qB = await quote(B), invA = await quote(A, BillingDocumentType.TAX_INVOICE), qSvc = await quote(A), qC = await quote(C);
  await own.$executeRawUnsafe(`INSERT INTO "ServiceQuote" ("businessId", "caseId", "version", "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256") VALUES ($1, 1, 1, $2, 100, 'h', $3, 'h')`, A, qSvc, `biz/${A}/service/q.pdf`)
    .catch(async () => { /* the live table may carry service-desk CHECKs; fall back to the minimum the guard reads */ await own.$executeRawUnsafe(`ALTER TABLE "ServiceQuote" DISABLE TRIGGER USER`); await own.$executeRawUnsafe(`INSERT INTO "ServiceQuote" ("businessId", "caseId", "version", "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256") VALUES ($1, 1, 1, $2, 100, 'h', $3, 'h')`, A, qSvc, `biz/${A}/service/q.pdf`); await own.$executeRawUnsafe(`ALTER TABLE "ServiceQuote" ENABLE TRIGGER USER`); });

  console.log("--- controls ---");
  const role = await one<{ rolsuper: boolean; rolbypassrls: boolean }>(own, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  const rtRole = await one<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>(R1, `SELECT current_user AS u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  ok("the battery runs as a NOSUPERUSER NOBYPASSRLS runtime login", !rtRole.rolsuper && !rtRole.rolbypassrls, rtRole.u);
  ok("the owner is the non-superuser migration role", !role.rolsuper);
  ok("no tenant context → 0 rows of any new table", Number((await one<{ n: number }>(R1, `SELECT (SELECT count(*) FROM "BusinessDocumentFile") + (SELECT count(*) FROM "BusinessLetter") AS n`)).n) === 0);

  console.log("--- privileges (catalog) ---");
  const tables = ["BusinessDocumentFile", "BusinessDocumentRequest", "QuoteShareCopy", "QuoteShareEvent", "BusinessLetter", "BusinessDocumentErasure"];
  for (const t of tables) {
    const p = await one<{ d: boolean; t: boolean; u: boolean; i: boolean }>(own, `SELECT has_table_privilege('app_runtime', $1, 'DELETE') AS d, has_table_privilege('app_runtime', $1, 'TRUNCATE') AS t, has_table_privilege('app_runtime', $1, 'UPDATE') AS u, has_table_privilege('app_runtime', $1, 'INSERT') AS i`, `"${t}"`);
    ok(`${t}: app_runtime has no DELETE, no TRUNCATE, no table-wide UPDATE`, !p.d && !p.t && !p.u);
  }
  ok("QuoteShareCopy / QuoteShareEvent: no UPDATE on any column", (await n(`SELECT count(*) AS n FROM information_schema.column_privileges WHERE grantee = 'app_runtime' AND table_name IN ('QuoteShareCopy','QuoteShareEvent') AND privilege_type = 'UPDATE'`)) === 0);
  ok("BusinessLetter: UPDATE only on deletedAt, deletedByUserId", JSON.stringify(((await own.$queryRawUnsafe(`SELECT column_name FROM information_schema.column_privileges WHERE grantee = 'app_runtime' AND table_name = 'BusinessLetter' AND privilege_type = 'UPDATE' ORDER BY 1`)) as { column_name: string }[]).map((r) => r.column_name)) === JSON.stringify(["deletedAt", "deletedByUserId"]));
  ok("BusinessDocumentErasure: SELECT only", (await n(`SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = 'app_runtime' AND table_name = 'BusinessDocumentErasure' AND privilege_type <> 'SELECT'`)) === 0);
  ok("no PUBLIC grant on any new table", (await n(`SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = ANY($1)`, tables)) === 0);
  ok("FORCE RLS on all six, no DELETE policy, no FOR ALL policy", (await n(`SELECT count(*) AS n FROM pg_class WHERE relname = ANY($1) AND relforcerowsecurity`, tables)) === 6 && (await n(`SELECT count(*) AS n FROM pg_policies WHERE tablename = ANY($1) AND cmd IN ('DELETE','ALL')`, tables)) === 0);
  const fns = (await own.$queryRawUnsafe(`SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS cfg, coalesce(p.proacl::text, '') AS acl FROM pg_proc p WHERE p.proname IN ('business_documents_erase','business_documents_erasure_complete','business_documents_purge_letter') ORDER BY 1`)) as { proname: string; prosecdef: boolean; cfg: string; acl: string }[];
  ok("the three functions: SECURITY DEFINER, search_path pinned with pg_temp last, no PUBLIC execute, runtime execute", fns.length === 3 && fns.every((f) => f.prosecdef && /search_path=pg_catalog, public, pg_temp$/.test(f.cfg) && !/(^|[{,])=X/.test(f.acl) && /app_runtime=X/.test(f.acl)), fns.map((f) => f.proname + ":" + f.acl).join(" "));
  const flag = await one<{ d: boolean; g: boolean }>(own, `SELECT d."defaultEnabled" AS d, p."globalEnabled" AS g FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" = 'business_documents'`);
  ok("flag business_documents: defaultEnabled false, globalEnabled false, no business override", flag && !flag.d && !flag.g && (await n(`SELECT count(*) AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'business_documents'`).catch(() => 0)) === 0);

  console.log("--- the quote link ---");
  const fA = await committedFile(A);
  const cA = await copyOf(R1, A, qA, fA);
  ok("a copy of A's own quote is recorded", !!cA.id);
  await refused("a copy of B's quote from A's context → not found (RLS hides it)", async () => copyOf(R1, A, qB, await committedFile(A)), /QUOTE_NOT_FOUND/);
  await refused("a copy of a TAX_INVOICE → not a quote", async () => copyOf(R1, A, invA, await committedFile(A)), /QUOTE_NOT_FOUND/);
  await refused("a copy of a Service Desk quote (any ServiceQuote version) → refused", async () => copyOf(R1, A, qSvc, await committedFile(A)), /SERVICE_DESK_QUOTE/);
  await refused("an event on a Service Desk quote → refused", () => event(R1, A, qSvc, "NOTE", { note: "x" }), /SERVICE_DESK_QUOTE/);
  await refused("a row labelled business B from A's context → RLS", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'LETTER', $2)`, B, `biz/${B}/business-docs/x.pdf`)), /row-level security/);
  await refused("an object key outside the business's prefix → CHECK", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'LETTER', $2)`, A, `biz/${B}/business-docs/x.pdf`)), /key_in_business_prefix/);
  ok("B sees none of A's records", Number((await inCtx(R1, B, (tx) => one<{ n: number }>(tx, `SELECT (SELECT count(*) FROM "QuoteShareCopy") + (SELECT count(*) FROM "BusinessDocumentFile") AS n`))).n) === 0);

  console.log("--- events ---");
  const sent = await event(R1, A, qA, "MARKED_SENT", { copyId: cA.id, channel: "WHATSAPP" });
  ok("MARKED_SENT on its own quote's copy, with a channel", !!sent.id);
  await event(R1, A, qA, "DOWNLOADED", { copyId: cA.id });
  await event(R1, A, qA, "SHARE_SHEET_OPENED", { copyId: cA.id });
  ok("DOWNLOADED and SHARE_SHEET_OPENED are separate kinds on the same copy", (await n(`SELECT count(DISTINCT kind) AS n FROM "QuoteShareEvent" WHERE "copyId" = $1`, cA.id)) === 3);
  await refused("MARKED_SENT without a copy → CHECK", () => event(R1, A, qA, "MARKED_SENT"), /copy_iff_file_event/);
  await refused("DOWNLOADED without a copy → CHECK", () => event(R1, A, qA, "DOWNLOADED"), /copy_iff_file_event/);
  await refused("a NOTE that points at a copy → CHECK", () => event(R1, A, qA, "NOTE", { copyId: cA.id, note: "x" }), /copy_iff_file_event/);
  await refused("MARKED_SENT on another quote's copy → composite FK", () => event(R1, A, qA2, "MARKED_SENT", { copyId: cA.id }), /QuoteShareEvent_copy_fkey|foreign key/);
  await refused("a channel on a response → CHECK", () => event(R1, A, qA, "RESPONSE_ACCEPTED", { channel: "EMAIL" }), /channel_only_when_sent/);
  await refused("a NOTE without text → CHECK", () => event(R1, A, qA, "NOTE"), /note_required/);
  const acc = await event(R1, A, qA, "RESPONSE_ACCEPTED");
  const fix = await event(R1, A, qA, "CORRECTION", { correctsEventId: acc.id });
  ok("a mistaken response is corrected by a CORRECTION event", !!fix.id);
  await refused("a second correction of the same event → unique", () => event(R1, A, qA, "CORRECTION", { correctsEventId: acc.id }), /23505|correctsEventId_key|Unique constraint/);
  const note = await event(R1, A, qA, "NOTE", { note: "הלקוח ביקש לחשוב" });
  await refused("a correction of a NOTE → refused", () => event(R1, A, qA, "CORRECTION", { correctsEventId: note.id }), /CORRECTION_TARGET_REFUSED/);
  await refused("a correction of a correction → refused", () => event(R1, A, qA, "CORRECTION", { correctsEventId: fix.id }), /CORRECTION_TARGET_REFUSED/);
  await refused("a correction across quotes → composite FK", () => event(R1, A, qA2, "CORRECTION", { correctsEventId: sent.id }), /corrects_fkey|foreign key|CORRECTION_TARGET_REFUSED/);

  console.log("--- append-only, and every bypass ---");
  await refused("UPDATE an event → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "QuoteShareEvent" SET "note" = 'x' WHERE id = $1`, note.id)), /permission denied/);
  await refused("DELETE an event → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`DELETE FROM "QuoteShareEvent" WHERE id = $1`, note.id)), /permission denied/);
  await refused("DELETE a copy → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`DELETE FROM "QuoteShareCopy" WHERE id = $1`, cA.id)), /permission denied/);
  await refused("TRUNCATE → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`TRUNCATE "QuoteShareEvent"`)), /permission denied/);
  await refused("set_config of any erasure-looking marker, then DELETE → still permission denied", () => inCtx(R1, A, async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('dubiz.bd_erasure', 'on', true), set_config('dubiz.business_documents_erasure', 'on', true)`); return tx.$executeRawUnsafe(`DELETE FROM "QuoteShareEvent" WHERE id = $1`, note.id); }), /permission denied/);
  await refused("SET ROLE lab_owner (the table owner) → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`SET ROLE lab_owner`)), /permission denied/);
  await refused("ALTER TABLE … DISABLE TRIGGER → not the owner", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`ALTER TABLE "QuoteShareEvent" DISABLE TRIGGER "QuoteShareEvent_append_only"`)), /must be owner|permission denied/);
  await refused("DROP POLICY → not the owner", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`DROP POLICY quote_share_event_tenant_select ON "QuoteShareEvent"`)), /must be owner|permission denied/);
  await refused("DELETE a file row → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`DELETE FROM "BusinessDocumentFile" WHERE id = $1`, fA)), /permission denied/);
  await refused("rewrite a file's object key → permission denied (column grant)", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "objectKey" = 'x' WHERE id = $1`, fA)), /permission denied/);
  await refused("file COMMITTED → PENDING → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'PENDING' WHERE id = $1`, fA)), /TRANSITION_REFUSED/);
  await refused("change the digest of a COMMITTED file → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "sha256" = $1 WHERE id = $2`, sha("other"), fA)), /FILE_FROZEN/);
  await refused("a referenced COMMITTED file cannot be marked DELETING", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE id = $1`, fA)), /STILL_REFERENCED/);
  await refused("a file cannot be created already COMMITTED", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey", "state", "sha256", "bytes", "committedAt") VALUES ($1, 'LETTER', $2, 'COMMITTED', $3, 1, now())`, A, `biz/${A}/business-docs/${randomUUID()}`, sha("x"))), /MUST_START_PENDING/);

  console.log("--- recording vs deleting a file, both orders ---");
  {
    const f = await committedFile(A);
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const t1 = inCtx(R1, A, async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO "QuoteShareCopy" ("businessId", "quoteDocumentId", "fileId", "sha256", "quoteContentHash", "quoteNumberSnapshot", "totalSnapshot", "currencySnapshot", "contentCheckedAt") VALUES ($1, $2, $3, $4, $4, 'Q', 1, 'ILS', now())`, A, qA, f, sha("pdf")); await gate; return "recorded"; });
    await sleep(300);
    const t2 = inCtx(R2, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE id = $1`, f)).then(() => "deleted", (e) => (String(e.message).match(/STILL_REFERENCED/)?.[0] ?? String(e.message)));
    await sleep(500); release();
    const [r1, r2] = await Promise.all([t1, t2]);
    ok("record first: it commits; the deletion waits for it and is refused", r1 === "recorded" && r2 === "STILL_REFERENCED", `${r1} / ${r2}`);
  }
  {
    const f = await committedFile(A);
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const t2 = inCtx(R2, A, async (tx) => { await tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE id = $1`, f); await gate; return "deleted"; });
    await sleep(300);
    const t1 = copyOf(R1, A, qA, f).then(() => "recorded", (e) => (String(e.message).match(/FILE_NOT_AVAILABLE/)?.[0] ?? String(e.message)));
    await sleep(500); release();
    const [r2, r1] = await Promise.all([t2, t1]);
    ok("delete first: it commits; the record waits for it and is refused", r2 === "deleted" && r1 === "FILE_NOT_AVAILABLE", `${r2} / ${r1}`);
  }
  {
    // an event on an existing copy vs the erasure marking its file: the erasure waits, then removes the event
    const f = await committedFile(C); const cc = await copyOf(R1, C, qC, f);
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const t1 = inCtx(R1, C, async (tx) => { await tx.$executeRawUnsafe(`INSERT INTO "QuoteShareEvent" ("businessId", "quoteDocumentId", "kind", "copyId", "quoteContentHash") VALUES ($1, $2, 'MARKED_SENT', $3, $4)`, C, qC, cc.id, sha("c")); await gate; return "recorded"; });
    await sleep(300);
    await own.business.update({ where: { id: C }, data: { deletionRequestedAt: new Date() } });
    const t2 = inCtx(R2, C, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_erase()`)).then(() => "erased", (e) => String(e.message));
    await sleep(500); release();
    const [r1, r2] = await Promise.all([t1, t2]);
    ok("an in-flight event vs the erasure: the erasure waits, then nothing of the business survives", r1 === "recorded" && r2 === "erased" && (await n(`SELECT count(*) AS n FROM "QuoteShareEvent" WHERE "businessId" = $1`, C)) === 0, `${r1} / ${r2}`);
  }
  {
    let bad = 0, deadlocks = 0;
    for (let i = 0; i < 200; i++) {
      const f = await committedFile(A);
      const rec = copyOf(R1, A, qA, f).then(() => true, (e) => { if (/deadlock/.test(e.message)) deadlocks++; return false; });
      const del = inCtx(R2, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE id = $1`, f)).then(() => true, (e) => { if (/deadlock/.test(e.message)) deadlocks++; return false; });
      const [x, y] = await Promise.all(i % 2 ? [rec, del] : [rec, del]);
      if (x === y) bad++;
    }
    const orphan = await n(`SELECT count(*) AS n FROM "QuoteShareCopy" c JOIN "BusinessDocumentFile" f ON f.id = c."fileId" WHERE f.state <> 'COMMITTED' AND c."businessId" = $1`, A);
    ok("200 concurrent record/delete pairs: exactly one side wins each time, 0 deadlocks, 0 copies on a non-COMMITTED file", bad === 0 && deadlocks === 0 && orphan === 0, `bad=${bad} deadlocks=${deadlocks} orphan=${orphan}`);
  }

  console.log("--- letters ---");
  const cust = (await own.customer.create({ data: { businessId: A, name: "לקוח למכתב" } })).id;
  const custB = (await own.customer.create({ data: { businessId: B, name: "לקוח של B" } })).id;
  const supp = (await own.supplier.create({ data: { businessId: A, name: "ספק למכתב" } as never })).id;
  const L1 = await letter(R1, A, await committedFile(A, "LETTER"), "CUSTOMER", { customerId: cust });
  ok("a CUSTOMER letter with its customer is saved", !!L1.id);
  ok("a SUPPLIER letter with its supplier is saved", !!(await letter(R1, A, await committedFile(A, "LETTER"), "SUPPLIER", { supplierId: supp })).id);
  ok("a FREE letter without links is saved", !!(await letter(R1, A, await committedFile(A, "LETTER"), "FREE")).id);
  await refused("a CUSTOMER letter without a customer → refused at creation", async () => letter(R1, A, await committedFile(A, "LETTER"), "CUSTOMER"), /RECIPIENT_LINK_REQUIRED/);
  await refused("a FREE letter with a customer → refused", async () => letter(R1, A, await committedFile(A, "LETTER"), "FREE", { customerId: cust }), /customer_only_for_customer|RECIPIENT_LINK_REQUIRED/);
  await refused("a SUPPLIER kind with a customer id → CHECK", async () => letter(R1, A, await committedFile(A, "LETTER"), "SUPPLIER", { customerId: cust, supplierId: supp }), /customer_only_for_customer|RECIPIENT_LINK_REQUIRED/);
  await refused("another business's customer → composite FK", async () => letter(R1, A, await committedFile(A, "LETTER"), "CUSTOMER", { customerId: custB }), /BusinessLetter_customer_fkey|foreign key/);
  await refused("a letter on a non-COMMITTED file → refused", async () => {
    const f = await inCtx(R1, A, (tx) => one<{ id: number }>(tx, `INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'LETTER', $2) RETURNING id`, A, `biz/${A}/business-docs/${randomUUID()}`));
    return letter(R1, A, f.id, "FREE");
  }, /FILE_NOT_AVAILABLE/);
  await refused("editing a saved letter's body → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLetter" SET "body" = 'x' WHERE id = $1`, L1.id)), /permission denied/);
  await own.customer.delete({ where: { id: cust } });
  const after = await inCtx(R1, A, (tx) => one<{ customerId: number | null; recipientName: string; recipientKind: string }>(tx, `SELECT "customerId", "recipientName", "recipientKind" FROM "BusinessLetter" WHERE id = $1`, L1.id));
  ok("deleting the customer nulls only the link; the CUSTOMER kind and the recipient snapshot stay (no CHECK conflict)", after.customerId === null && after.recipientName === "נמען" && after.recipientKind === "CUSTOMER");
  const hide = await inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLetter" SET "deletedAt" = now() WHERE id = $1`, L1.id));
  ok("the owner hides a letter", hide === 1);
  await refused("hiding it again (changing deletedAt) → refused", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessLetter" SET "deletedAt" = now() + interval '1 day' WHERE id = $1`, L1.id)), /IMMUTABLE/);
  await refused("DELETE a letter → permission denied", () => inCtx(R1, A, (tx) => tx.$executeRawUnsafe(`DELETE FROM "BusinessLetter" WHERE id = $1`, L1.id)), /permission denied/);
  await refused("purge without an explicit age → refused", () => inCtx(R1, A, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_purge_letter($1::int, NULL::int)`, L1.id)), /PURGE_AGE_REQUIRED/);
  await refused("purge of a letter hidden for less than the given age → not eligible", () => inCtx(R1, A, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_purge_letter($1::int, 30)`, L1.id)), /NOT_ELIGIBLE/);
  await own.$executeRawUnsafe(`ALTER TABLE "BusinessLetter" DISABLE TRIGGER "BusinessLetter_guard"`);
  await own.$executeRawUnsafe(`UPDATE "BusinessLetter" SET "deletedAt" = now() - interval '40 days' WHERE id = $1`, L1.id);
  await own.$executeRawUnsafe(`ALTER TABLE "BusinessLetter" ENABLE TRIGGER "BusinessLetter_guard"`);
  await refused("purge of A's letter from B's context → not eligible", () => inCtx(R1, B, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_purge_letter($1::int, 30)`, L1.id)), /NOT_ELIGIBLE/);
  const purged = await inCtx(R1, A, (tx) => one<{ f: number }>(tx, `SELECT public.business_documents_purge_letter($1::int, 30) AS f`, L1.id));
  const pf = await one<{ state: string }>(own, `SELECT state FROM "BusinessDocumentFile" WHERE id = $1`, purged.f);
  ok("purge (explicit age, nothing scheduled): the letter is gone, its file is DELETING for the fence", (await n(`SELECT count(*) AS n FROM "BusinessLetter" WHERE id = $1`, L1.id)) === 0 && pf.state === "DELETING");

  console.log("--- account erasure (defined, not connected to account deletion) ---");
  await refused("erasure without tenant context → refused", () => R1.$queryRawUnsafe(`SELECT public.business_documents_erase()`), /ERASURE_NO_CONTEXT/);
  await refused("erasure of an active business → refused", () => inCtx(R1, A, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_erase()`)), /ERASURE_NOT_DELETING/);
  const fB = await committedFile(B); await copyOf(R1, B, qB, fB);
  const pendB = await inCtx(R1, B, (tx) => one<{ id: number }>(tx, `INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'LETTER', $2) RETURNING id`, B, `biz/${B}/business-docs/${randomUUID()}`));
  await own.business.update({ where: { id: B }, data: { deletionRequestedAt: new Date() } });
  await refused("erasure from A's context while only B is deleting → refused, B untouched", () => inCtx(R1, A, (tx) => tx.$queryRawUnsafe(`SELECT public.business_documents_erase()`)), /ERASURE_NOT_DELETING/);
  const aBefore = await n(`SELECT count(*) AS n FROM "QuoteShareEvent" WHERE "businessId" = $1`, A);
  const marked = await inCtx(R1, B, (tx) => one<{ n: number }>(tx, `SELECT public.business_documents_erase() AS n`));
  ok("erasure of B: its files DELETING, its records gone, A untouched", Number(marked.n) === 2 && (await n(`SELECT count(*) AS n FROM "QuoteShareCopy" WHERE "businessId" = $1`, B)) === 0 && (await n(`SELECT count(*) AS n FROM "QuoteShareEvent" WHERE "businessId" = $1`, A)) === aBefore);
  await refused("a new file for B during erasure → refused", () => inCtx(R1, B, (tx) => tx.$executeRawUnsafe(`INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'LETTER', $2)`, B, `biz/${B}/business-docs/${randomUUID()}`)), /BEING_ERASED/);
  await refused("a new request key for B during erasure → refused", () => inCtx(R1, B, (tx) => tx.$executeRawUnsafe(`INSERT INTO "BusinessDocumentRequest" ("businessId", "operation", "idempotencyKey") VALUES ($1, 'LETTER_SAVE', $2::uuid)`, B, randomUUID())), /BEING_ERASED/);
  await refused("committing B's in-flight file during erasure → refused", () => inCtx(R1, B, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'COMMITTED', "sha256" = $1, "bytes" = 1, "committedAt" = now() WHERE id = $2`, sha("x"), pendB.id)), /BEING_ERASED|TRANSITION_REFUSED/);
  ok("completion refused while any file is not FENCED", (await inCtx(R1, B, (tx) => one<{ d: boolean }>(tx, `SELECT public.business_documents_erasure_complete() AS d`))).d === false);
  await inCtx(R1, B, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessDocumentFile" SET "state" = 'FENCED', "fencedAt" = now() WHERE "businessId" = $1 AND "state" = 'DELETING'`, B));
  const done = await inCtx(R1, B, (tx) => one<{ d: boolean }>(tx, `SELECT public.business_documents_erasure_complete() AS d`));
  ok("completion only when every file is FENCED: rows gone, job DONE", done.d === true && (await n(`SELECT count(*) AS n FROM "BusinessDocumentFile" WHERE "businessId" = $1`, B)) === 0 && (await one<{ state: string }>(own, `SELECT state FROM "BusinessDocumentErasure" WHERE "businessId" = $1`, B)).state === "DONE");

  console.log("--- a Business row deleted by the platform cascades through every guard ---");
  const D = await mk("D"); const qD = await quote(D); const fD = await committedFile(D); const cD = await copyOf(R1, D, qD, fD); await event(R1, D, qD, "MARKED_SENT", { copyId: cD.id });
  await own.$executeRawUnsafe(`DELETE FROM "BillingDocument" WHERE "businessId" = $1`, D);
  const cascadeError = await own.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = $1`, D).then(() => "", (e) => String(e.message).split("\n").slice(-1)[0]);
  const leftD = await n(`SELECT (SELECT count(*) FROM "Business" WHERE id = $1) + (SELECT count(*) FROM "QuoteShareEvent" WHERE "businessId" = $1) + (SELECT count(*) FROM "QuoteShareCopy" WHERE "businessId" = $1) + (SELECT count(*) FROM "BusinessDocumentFile" WHERE "businessId" = $1) AS n`, D);
  ok("a Business delete cascades through the append-only and file guards (nothing left)", cascadeError === "" && leftD === 0, cascadeError || `left=${leftD}`);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await Promise.all([own, R1, R2].map((c) => c.$disconnect()));
  if (failures.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await Promise.all([own, R1, R2].map((c) => c.$disconnect()));
  process.exit(1);
});
