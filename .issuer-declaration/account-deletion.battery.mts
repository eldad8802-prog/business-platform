/**
 * Issuer declaration (#1081) in ACCOUNT DELETION — the real flow (deleteOwnBusinessAccount + prismaAccountDeletionStore)
 * AS the runtime role, on the Production-topology lab with migration 20261126100000 applied by `prisma migrate deploy`
 * (.issuer-declaration/lab.sh). The purge code is TODAY's: it does not call issuer_declaration_erase() yet — exactly the
 * window between applying the migration and deploying the #1081 code.
 *
 *   W  the window (today's purge on the migrated database):
 *      B1 a declaration a fiscal document was issued under · B2 a declaration nothing was issued under · B3 no declaration
 *      — every deletion completes; RESTRICT foreign keys do not block (users are anonymised in place, never deleted);
 *      B1's declaration, frozen issuer snapshot and document number stay; the profile's identity columns are cleared.
 *   C  the #1081 code's call, simulated after the purge: issuer_declaration_erase() as the runtime in the tenant
 *      transaction — B2 anonymised (exact fields), B1 kept, a live business refused.
 *   N  negative proof: with the profile lock as it was BEFORE this fix (owner-only bypass), today's purge of a business
 *      with a used declaration FAILS — the fix is what lets the deletion complete.
 *
 * env: OWNER_URL (lab_owner — seeding, reads, the N fault), DATABASE_URL = DIRECT_URL (app_runtime_prod), AUTH_DATABASE_URL,
 *      STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT, TASK_REQUEST_HMAC_KEY(_ID), AUTH_TOKEN_SECRET. Synthetic only.
 */
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { PrismaClient } from "@prisma/client";
import { deleteOwnBusinessAccount } from "../lib/services/account/account-deletion.service";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const t = Date.now();
const PERSONAL = ["legalName", "tradeName", "idNumber", "vatRegistrationNumber", "address", "phone", "email", "declarantName", "declarantCapacity"];
const KEPT = ["id", "businessId", "version", "kind", "track", "legalForm", "vatStatus", "idType", "effectiveFrom", "authorizedUserId",
  "authorityBasis", "declaredByUserId", "statementVersion", "statementSha256", "reauthMethod", "reauthAt", "createdAt"];

async function business(tag: string, opts: { declare: boolean; issue: boolean }) {
  const one = async (sql: string, ...a: unknown[]) => Number(((await q(sql, ...a)))[0].id);
  const b = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `decl-${tag}-${t}`);
  const u = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `decl-${tag}-${t}@lab.invalid`, b);
  await x(`INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingBusinessKind", "billingTaxId", "billingVatNumber", "updatedAt")
           VALUES ($1, 'ישראל ישראלי', 'AUTHORIZED_DEALER', '000000018', '000000018', now())`, b);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, b);
  let decl: number | null = null;
  if (opts.declare) {
    decl = await one(`INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","tradeName",
        "idType","idNumber","vatRegistrationNumber","address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId",
        "declarantName","declarantCapacity","statementVersion","statementSha256","reauthMethod","reauthAt")
      VALUES ($1,1,'INITIAL','AUTHORIZED_DEALER_INDIVIDUAL','INDIVIDUAL','AUTHORIZED','ישראל ישראלי','המוסך של ישראל','ISRAELI_ID','000000018','000000018',
        'רחוב 1','0500000000','lab@example.test', now() - interval '1 day', $2,'SOLE_USER_VERIFIED',$2,'ישראל ישראלי','בעל העסק','issuer-declaration-he-v1',
        repeat('a',64),'EMAIL_LINK', now()) RETURNING id`, b, u);
  }
  let doc: number | null = null;
  if (opts.issue) {
    doc = await one(`INSERT INTO "BillingDocument" ("businessId","documentType","status","customerId","customerNameSnapshot","currency","subtotalAmount",
        "vatAmount","totalAmount","documentNumber","documentNumberFormatted","issuedAt","issuedSnapshot","createdAt","updatedAt")
      VALUES ($1,'TAX_INVOICE','ISSUED',$2,'לקוח','ILS',100,18,118,1,'1', now(),
        jsonb_build_object('issuer', jsonb_build_object('legalName','ישראל ישראלי','taxId','000000018','kind','AUTHORIZED_DEALER')), now(), now()) RETURNING id`, b, cust);
  }
  return { b, u, decl, doc };
}
const declRow = async (id: number) => (await q(`SELECT to_jsonb(d) j FROM "BusinessIssuerDeclaration" d WHERE id = $1`, id))[0]?.j as Record<string, unknown>;
const docRow = async (id: number) => (await q(`SELECT "documentNumber" n, "documentNumberFormatted" f, status::text s, md5("issuedSnapshot"::text) h FROM "BillingDocument" WHERE id = $1`, id))[0];
const profile = async (b: number) => (await q(`SELECT "billingLegalName" l, "billingTaxId" t, "billingVatNumber" v FROM "BusinessProfile" WHERE "businessId" = $1`, b))[0];
async function del(z: { b: number; u: number }): Promise<string> {
  try { const r = await deleteOwnBusinessAccount(prismaAccountDeletionStore, { businessId: z.b, actorUserId: z.u }); return r.status; }
  // A Prisma error raised by a trigger keeps the Postgres code and message in nested fields, not in `.message`.
  catch (e) { return `ERR:${inspect(e, { depth: 6 }).replace(/\s+/g, " ").slice(0, 600)}`; }
}
async function eraseAsRuntime(b: number): Promise<string> {
  try {
    const r = await runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      return (await tx.$queryRawUnsafe(`SELECT public.issuer_declaration_erase() AS n`)) as Rows;
    });
    return String(r[0].n);
  } catch (e) { return `ERR:${(e as Error).message.slice(0, 200)}`; }
}
const same = (a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]) => keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

async function main() {
  console.log("W — the window: today's purge on the migrated database");
  const B1 = await business("b1", { declare: true, issue: true });
  const B2 = await business("b2", { declare: true, issue: false });
  const B3 = await business("b3", { declare: false, issue: false });
  const d1Before = await declRow(B1.decl!), d2Before = await declRow(B2.decl!), doc1Before = await docRow(B1.doc!);

  const r1 = await del(B1), r2 = await del(B2), r3 = await del(B3);
  ok("W1 deletion of a business with a USED declaration completes", r1 === "deleted", r1);
  ok("W2 deletion of a business with an UNUSED declaration completes", r2 === "deleted", r2);
  ok("W3 deletion of a business with NO declaration completes", r3 === "deleted", r3);
  const usersKept = await q(`SELECT count(*)::int n FROM "User" WHERE id = ANY($1::int[]) AND email LIKE 'deleted-biz-%@deleted.invalid'`, [B1.u, B2.u]);
  ok("W4 RESTRICT foreign keys did not block: the declaring users are anonymised in place, still referenced", Number(usersKept[0].n) === 2);
  const d1After = await declRow(B1.decl!);
  ok("W5 B1: the declaration a document was issued under is kept unchanged (every column)", JSON.stringify(d1After) === JSON.stringify(d1Before));
  ok("W6 B1: the document number, status and frozen issuer snapshot are unchanged", JSON.stringify(await docRow(B1.doc!)) === JSON.stringify(doc1Before),
    JSON.stringify(await docRow(B1.doc!)));
  const p1 = await profile(B1.b);
  ok("W7 B1: the profile's identity columns are cleared by the existing purge (the lock admits a business being deleted)",
    p1.l === null && p1.t === null && p1.v === null, JSON.stringify(p1));
  // W8 follows the purge in THIS tree: #1091 alone (main's purge) leaves the declaration unchanged — the recorded window;
  // with the #1117 code the purge itself calls issuer_declaration_erase() and the unused declaration is anonymised.
  const purgeCallsErase = readFileSync("lib/services/account/account-deletion.prisma-store.ts", "utf8").includes("SELECT public.issuer_declaration_erase() AS n");
  const d2AfterPurge = await declRow(B2.decl!);
  if (purgeCallsErase) {
    ok("W8 B2: the purge itself anonymised the unused declaration (the #1117 code calls issuer_declaration_erase())",
      d2AfterPurge.anonymisedAt !== null && d2AfterPurge.legalName === "—" && d2AfterPurge.idNumber === "000000000" && same(d2AfterPurge, d2Before, KEPT));
  } else {
    ok("W8 B2 in the window: today's purge does not call the erase yet — the declaration is still unchanged (the recorded #1081 code-PR debt)",
      JSON.stringify(d2AfterPurge) === JSON.stringify(d2Before));
  }
  ok("W9 B3: no declaration rows exist or were created", Number((await q(`SELECT count(*)::int n FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1`, B3.b))[0].n) === 0);
  ok("W10 a second deletion → already_deleted", (await del(B1)) === "already_deleted");

  console.log("C — the #1081 code's erase call, after the purge");
  const e2 = await eraseAsRuntime(B2.b);
  const d2After = await declRow(B2.decl!);
  ok(purgeCallsErase ? "C1 B2: already anonymised by the purge — a further erase changes nothing (0 rows)" : "C1 B2: issuer_declaration_erase() anonymises the unused declaration (1 row)",
    e2 === (purgeCallsErase ? "0" : "1") && (!purgeCallsErase || JSON.stringify(d2After) === JSON.stringify(d2AfterPurge)), e2);
  ok("C2 B2: the personal fields are anonymised (legal/trade name, id, VAT no., address, phone, email, declarant name/capacity)",
    d2After.legalName === "—" && d2After.tradeName === null && d2After.idNumber === "000000000" && d2After.vatRegistrationNumber === "000000000"
    && d2After.address === "—" && d2After.phone === "—" && d2After.email === "erased@invalid" && d2After.declarantName === "—"
    && d2After.declarantCapacity === "—" && d2After.anonymisedAt !== null, JSON.stringify(Object.fromEntries(PERSONAL.map((k) => [k, d2After[k]]))));
  ok("C3 B2: everything else is kept (track, form, VAT status, id type, version, dates, authority, users, statement hash)",
    same(d2After, d2Before, KEPT), JSON.stringify(KEPT.filter((k) => JSON.stringify(d2After[k]) !== JSON.stringify(d2Before[k]))));
  const e1 = await eraseAsRuntime(B1.b);
  ok("C4 B1: the erase keeps a declaration a document was issued under (0 rows, unchanged)", e1 === "0" && JSON.stringify(await declRow(B1.decl!)) === JSON.stringify(d1Before), e1);
  const LIVE = await business("live", { declare: true, issue: false });
  const eL = await eraseAsRuntime(LIVE.b);
  ok("C5 the erase is refused for a live business (not being deleted)", eL.includes("ISSUER_ERASE_NOT_DELETING"), eL);
  ok("C6 a second erase of B2 changes nothing (0 rows)", (await eraseAsRuntime(B2.b)) === "0");

  console.log("N — negative proof: the profile lock as it was before this fix");
  const mig = readFileSync("prisma/migrations/20261126100000_issuer_declaration/migration.sql", "utf8");
  const start = mig.indexOf("CREATE OR REPLACE FUNCTION public.issuer_profile_identity_lock()");
  const end = mig.indexOf("REVOKE ALL ON FUNCTION public.issuer_profile_identity_lock() FROM PUBLIC;");
  const fixed = mig.slice(start, end);
  const before = fixed.replace(/\n\s+OR public\.issuer_business_is_being_deleted\(NEW\."businessId"\) THEN/, " THEN");
  ok("N0 the pre-fix variant differs from the migration only by the deletion clause", before !== fixed && start > 0 && end > start);
  const B5 = await business("b5", { declare: true, issue: true });
  await x(before);
  const r5 = await del(B5);
  await x(fixed);
  ok("N1 with the pre-fix lock, today's purge of a business with a used declaration FAILS on the lock (DZD35)",
    r5.startsWith("ERR:") && (r5.includes("ISSUER_PROFILE_IDENTITY_LOCKED") || r5.includes("DZD35")), r5);
  const r5b = await del(B5);
  ok("N2 with the fixed lock restored, the same deletion completes", r5b === "deleted", r5b);

  console.log(`${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length) process.exit(1);
}
main().catch(async (e) => { console.error(e); await owner.$disconnect(); await runtime.$disconnect(); process.exit(1); });
