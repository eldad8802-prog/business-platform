/**
 * BusinessProfile runtime grants — proof, on a real PostgreSQL.
 *
 *   OWNER_URL=postgresql://…throwaway lab… \
 *     npx tsx prisma/migrations/20260915120000_businessprofile_runtime_grants/contract.test.ts
 *
 * WHAT THIS HAS TO PROVE, AND WHY IT IS SHAPED THIS WAY
 *
 * The claim is narrow: two privileges, and the write still cannot cross a
 * tenant boundary. The easy way to get this wrong is a fixture that is more
 * permissive than Production — a BYPASSRLS role, a `FOR ALL` policy invented
 * for the test, or a blanket grant — and this programme has already shipped a
 * falsely-green battery of exactly that kind. So:
 *
 *   * the role is NOBYPASSRLS, and that is asserted, not assumed;
 *   * the policy is REPLAYED OUT OF the shipped RLS migration file rather than
 *     retyped here, so the fixture cannot drift from what ships;
 *   * the grants are READ OUT OF this migration's own SQL, so the test proves
 *     the file next to it rather than a paraphrase of it;
 *   * and the SELECT-only baseline is exercised too, so a run where the grants
 *     silently did nothing would fail instead of passing.
 *
 * Both row states matter: a business saving its identity for the first time
 * takes the INSERT branch, and every save after that takes UPDATE. A contract
 * that only allowed the first would look fine on the day it shipped.
 *
 * Synthetic, self-contained, zero secrets, zero Neon, zero Production.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const THIS_MIGRATION = join(HERE, "migration.sql");
const RLS_MIGRATION = join(
  ROOT,
  "prisma/migrations/20260825120000_d2_p7_wave1_businessprofile_rls/migration.sql"
);

const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL || !/^postgres(ql)?:\/\//i.test(OWNER_URL)) {
  console.error(
    "ABORT: OWNER_URL is required — an owner connection to a THROWAWAY lab database.\n" +
      "This battery creates roles, a table and policies. Never point it at Production."
  );
  process.exit(2);
}

const SUFFIX = randomBytes(4).toString("hex");
const ROLE_BEFORE = `bp_before_${SUFFIX}`; // today: SELECT only
const ROLE_AFTER = `bp_after_${SUFFIX}`; // after this migration
const ROLE_NOSEQ = `bp_noseq_${SUFFIX}`; // table grants but no sequence grant
const PW = "bp_ci_synthetic_pw";
const urlFor = (role: string) => OWNER_URL.replace(/\/\/[^@]*@/, `//${role}:${PW}@`);

const A = 970101; // the acting tenant
const B = 970202; // the neighbour that must stay untouchable

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Strip `--` comments; semicolons inside a dollar-quoted body are not separators. */
function statements(sql: string): string[] {
  const src = sql.replace(/--.*$/gm, "");
  const out: string[] = [];
  let buf = "";
  let tag: string | null = null;
  for (let i = 0; i < src.length; i++) {
    if (tag) {
      buf += src[i];
      if (src.startsWith(tag, i)) {
        buf += src.slice(i + 1, i + tag.length);
        i += tag.length - 1;
        tag = null;
      }
      continue;
    }
    const open = src.slice(i).match(/^\$(\w*)\$/);
    if (open) {
      tag = open[0];
      buf += tag;
      i += tag.length - 1;
      continue;
    }
    if (src[i] === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += src[i];
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

type Outcome =
  | { okd: true }
  | { okd: false; sqlstate: string | null; text: string };

/**
 * A model-level Prisma call WRAPS the driver error: `meta.code` is often absent
 * and the PostgreSQL text sits inside the long `message`. Matching on a
 * truncated message made real refusals unclassifiable during development, so
 * the whole string is kept for matching.
 */
function classify(e: unknown): Outcome {
  const err = e as { meta?: { code?: string; message?: string }; message?: string };
  const text = `${err?.meta?.message ?? ""} ${err?.message ?? ""}`.replace(/\s+/g, " ");
  const sqlstate = err?.meta?.code ?? /\b(42501|23505|23503)\b/.exec(text)?.[1] ?? null;
  return { okd: false, sqlstate, text };
}
const permissionDenied = (o: Outcome) =>
  !o.okd && o.sqlstate === "42501" && /permission denied/i.test(o.text);
const rlsViolation = (o: Outcome) =>
  !o.okd && o.sqlstate === "42501" && /row-level security/i.test(o.text);

/** The statement shape PATCH issues, structurally verbatim. */
const PROFILE_SELECT = {
  billingLegalName: true, billingBusinessKind: true, billingTaxId: true,
  billingVatNumber: true, billingPhone: true, billingEmail: true,
  billingAddress: true, billingPaymentNote: true, billingFooterNote: true,
  billingLogoDataUrl: true, billingSignatureDataUrl: true,
  billingPdfTemplateStyle: true,
} as const;

async function upsertAs(client: any, businessId: number, note: string): Promise<Outcome> {
  try {
    await client.businessProfile.upsert({
      where: { businessId },
      create: { businessId, billingFooterNote: note },
      update: { billingFooterNote: note },
      select: PROFILE_SELECT,
    });
    return { okd: true };
  } catch (e) {
    return classify(e);
  }
}

async function main(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  // ── 0. the files still say what this battery assumes ─────────────────────
  const thisSql = readFileSync(THIS_MIGRATION, "utf8");
  const grantLines = thisSql
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^GRANT\b/i.test(l));

  ok("this migration issues exactly two GRANTs", grantLines.length === 2, grantLines.join(" | "));
  ok(
    "the table grant is SELECT, INSERT, UPDATE — and nothing more",
    grantLines.some(
      (l) =>
        /GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+"BusinessProfile"\s+TO\s+app_runtime/i.test(l)
    ),
    grantLines[0]
  );
  ok(
    "the sequence grant is USAGE, SELECT on BusinessProfile_id_seq",
    grantLines.some((l) =>
      /GRANT\s+USAGE,\s*SELECT\s+ON\s+SEQUENCE\s+"BusinessProfile_id_seq"\s+TO\s+app_runtime/i.test(l)
    ),
    grantLines[1]
  );
  for (const forbidden of ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "ALL PRIVILEGES"]) {
    ok(
      `this migration grants no ${forbidden}`,
      !grantLines.some((l) => new RegExp(`\\b${forbidden}\\b`, "i").test(l))
    );
  }
  ok(
    "this migration never touches the policy or FORCE RLS",
    !/CREATE POLICY|DROP POLICY|ALTER POLICY|ROW LEVEL SECURITY/i.test(thisSql.replace(/--.*$/gm, ""))
  );
  ok(
    "this migration alters no table or column",
    !/ALTER TABLE|CREATE TABLE|DROP TABLE|ADD COLUMN|DROP COLUMN/i.test(
      thisSql.replace(/--.*$/gm, "")
    )
  );
  // Comments are stripped first: the file's own prose says "no BYPASSRLS", and a
  // check that read the prose would fail on a migration that is in fact correct.
  const thisExecutable = thisSql.replace(/--.*$/gm, "");
  ok(
    "this migration grants no BYPASSRLS or ownership",
    !/BYPASSRLS|OWNER\s+TO/i.test(thisExecutable)
  );

  const rlsSql = readFileSync(RLS_MIGRATION, "utf8");
  ok(
    "the shipped RLS migration still FORCEs row level security",
    /ALTER TABLE "BusinessProfile"\s+FORCE ROW LEVEL SECURITY/i.test(rlsSql)
  );

  // ── 1. fixture ───────────────────────────────────────────────────────────
  // The columns Prisma actually touches for this model. `createdAt`/`updatedAt`
  // must exist: without them Prisma fails its OWN create validation before the
  // database is consulted, which makes every case look like a refusal.
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessProfile" CASCADE`);
  await owner.$executeRawUnsafe(`
    CREATE TABLE "BusinessProfile" (
      "id"                        serial PRIMARY KEY,
      "businessId"                integer UNIQUE NOT NULL,
      "billingLegalName"          text,
      "billingBusinessKind"       text,
      "billingTaxId"              text,
      "billingVatNumber"          text,
      "billingPhone"              text,
      "billingEmail"              text,
      "billingAddress"            text,
      "billingPaymentNote"        text,
      "billingFooterNote"         text,
      "billingLogoDataUrl"        text,
      "billingSignatureDataUrl"   text,
      "billingPdfTemplateStyle"   text NOT NULL DEFAULT 'CLASSIC',
      "createdAt"                 timestamp(3) NOT NULL DEFAULT now(),
      "updatedAt"                 timestamp(3) NOT NULL DEFAULT now()
    )`);

  // The shipped policy, replayed rather than retyped.
  for (const stmt of statements(rlsSql)) await owner.$executeRawUnsafe(stmt);

  const roles: [string, string[]][] = [
    // Today's contract.
    [ROLE_BEFORE, [`GRANT SELECT ON "BusinessProfile" TO ${ROLE_BEFORE}`]],
    // This migration's grants, taken from its own SQL.
    [ROLE_AFTER, grantLines.map((l) => l.replace(/app_runtime/g, ROLE_AFTER).replace(/;\s*$/, ""))],
    // The table half only — to prove the sequence grant is load-bearing.
    [ROLE_NOSEQ, [`GRANT SELECT, INSERT, UPDATE ON "BusinessProfile" TO ${ROLE_NOSEQ}`]],
  ];
  for (const [role, grants] of roles) {
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${PW}' NOBYPASSRLS`);
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const g of grants) await owner.$executeRawUnsafe(g);
  }

  const forced = await owner.$queryRawUnsafe<
    { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
  >(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'BusinessProfile'`);
  ok(
    "fixture: RLS is ENABLED and FORCED on the table",
    forced[0].relrowsecurity && forced[0].relforcerowsecurity
  );
  const bypass = await owner.$queryRawUnsafe<{ rolbypassrls: boolean }[]>(
    `SELECT rolbypassrls FROM pg_roles WHERE rolname IN ('${ROLE_BEFORE}','${ROLE_AFTER}','${ROLE_NOSEQ}')`
  );
  ok(
    "fixture: every test role is NOBYPASSRLS (this battery cannot be falsely green)",
    bypass.length === 3 && bypass.every((r) => !r.rolbypassrls)
  );
  const held = await owner.$queryRawUnsafe<{ privilege_type: string }[]>(
    `SELECT DISTINCT privilege_type FROM information_schema.table_privileges
      WHERE grantee = '${ROLE_AFTER}' AND table_name = 'BusinessProfile' ORDER BY 1`
  );
  ok(
    "fixture: the post-migration role holds exactly INSERT, SELECT, UPDATE",
    held.map((h) => h.privilege_type).join(",") === "INSERT,SELECT,UPDATE",
    held.map((h) => h.privilege_type).join(",")
  );

  const reset = async () =>
    owner.$executeRawUnsafe(`DELETE FROM "BusinessProfile" WHERE "businessId" = ${A}`);
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingFooterNote") VALUES (${B},'B-untouched')`
  );

  const clients: Record<string, any> = {};
  const clientFor = (role: string) =>
    (clients[role] ??= new PrismaClient({ datasources: { db: { url: urlFor(role) } } }));

  /**
   * The body of lib/tenant/transaction.ts `withTenantTransaction`, replicated so
   * it can be pointed at any lab role. The app's helper goes through the
   * `lib/prisma` singleton, which binds to one URL on first import and would
   * therefore have tested a single role three times.
   */
  const withTenant = (role: string, businessId: number, fn: (tx: any) => Promise<Outcome>) =>
    clientFor(role).$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(tx);
    });

  // ── 2. the negatives: each half alone must fail ──────────────────────────
  console.log("\n== the privilege alone, and the context alone, are each NOT enough ==");

  await reset();
  const noCtx = await upsertAs(clientFor(ROLE_AFTER), A, "x");
  ok(
    "granted but context-less INSERT is refused by RLS WITH CHECK",
    rlsViolation(noCtx),
    noCtx.okd ? "SUCCEEDED — the policy is not protecting this table" : noCtx.text.slice(0, 120)
  );

  await reset();
  const selOnlyInsert = await withTenant(ROLE_BEFORE, A, (tx) => upsertAs(tx, A, "x"));
  ok(
    "SELECT-only with correct context: INSERT still permission denied",
    permissionDenied(selOnlyInsert),
    selOnlyInsert.okd ? "SUCCEEDED — the migration would be unnecessary" : selOnlyInsert.text.slice(0, 120)
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingFooterNote") VALUES (${A},'A-original')`
  );
  const selOnlyUpdate = await withTenant(ROLE_BEFORE, A, (tx) => upsertAs(tx, A, "x"));
  ok(
    "SELECT-only with correct context: UPDATE still permission denied",
    permissionDenied(selOnlyUpdate),
    selOnlyUpdate.okd ? "SUCCEEDED" : selOnlyUpdate.text.slice(0, 120)
  );

  // ── 3. the sequence grant is load-bearing ────────────────────────────────
  console.log("\n== the sequence grant is not optional ==");
  await reset();
  const noSeq = await withTenant(ROLE_NOSEQ, A, (tx) => upsertAs(tx, A, "x"));
  ok(
    "table grants WITHOUT the sequence grant: INSERT is refused",
    permissionDenied(noSeq),
    noSeq.okd ? "SUCCEEDED — the sequence grant would be unnecessary" : noSeq.text.slice(0, 120)
  );
  ok(
    "...and the refusal names the sequence, not the table",
    !noSeq.okd && /sequence/i.test(noSeq.text),
    noSeq.okd ? "" : noSeq.text.slice(0, 120)
  );

  // ── 4. the positives: both halves together ───────────────────────────────
  console.log("\n== with this migration's grants AND tenant context ==");
  await reset();
  const ins = await withTenant(ROLE_AFTER, A, (tx) => upsertAs(tx, A, "first-save"));
  ok("INSERT path succeeds (a business saving its identity for the first time)", ins.okd,
     ins.okd ? "" : (ins as any).text.slice(0, 160));
  const afterIns = await owner.$queryRawUnsafe<{ billingFooterNote: string }[]>(
    `SELECT "billingFooterNote" FROM "BusinessProfile" WHERE "businessId" = ${A}`
  );
  ok("...and the row really committed", afterIns[0]?.billingFooterNote === "first-save",
     JSON.stringify(afterIns));

  const upd = await withTenant(ROLE_AFTER, A, (tx) => upsertAs(tx, A, "second-save"));
  ok("UPDATE path succeeds (every save after the first)", upd.okd,
     upd.okd ? "" : (upd as any).text.slice(0, 160));
  const afterUpd = await owner.$queryRawUnsafe<{ billingFooterNote: string }[]>(
    `SELECT "billingFooterNote" FROM "BusinessProfile" WHERE "businessId" = ${A}`
  );
  ok("...and the update really committed", afterUpd[0]?.billingFooterNote === "second-save",
     JSON.stringify(afterUpd));
  const count = await owner.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "BusinessProfile" WHERE "businessId" = ${A}`
  );
  ok("...without creating a second row", Number(count[0].n) === 1, `n=${count[0].n}`);

  // ── 5. tenant isolation still holds UNDER the new privileges ─────────────
  console.log("\n== isolation, with the write privileges in hand ==");
  const cross = await withTenant(ROLE_AFTER, A, (tx) => upsertAs(tx, B, "A-tried-to-write-B"));
  ok(
    "a tenant holding INSERT+UPDATE still cannot write another tenant's profile",
    !cross.okd,
    cross.okd ? "CROSS-TENANT WRITE SUCCEEDED — UNACCEPTABLE" : (cross as any).text.slice(0, 120)
  );
  const bRow = await owner.$queryRawUnsafe<{ billingFooterNote: string }[]>(
    `SELECT "billingFooterNote" FROM "BusinessProfile" WHERE "businessId" = ${B}`
  );
  ok("...and the neighbour's row is byte-for-byte untouched",
     bRow[0]?.billingFooterNote === "B-untouched", JSON.stringify(bRow));
  const crossRead = await withTenant(ROLE_AFTER, A, async (tx) => {
    const r = await tx.businessProfile.findUnique({
      where: { businessId: B },
      select: PROFILE_SELECT,
    });
    return { okd: true, value: r } as any;
  });
  ok("...and the neighbour's profile is invisible to a read",
     (crossRead as any).value === null, JSON.stringify((crossRead as any).value));

  // ── 6. DELETE was not granted ────────────────────────────────────────────
  console.log("\n== DELETE is not part of the contract ==");
  let del: Outcome;
  try {
    await clientFor(ROLE_AFTER).$executeRawUnsafe(
      `DELETE FROM "BusinessProfile" WHERE "businessId" = ${A}`
    );
    del = { okd: true };
  } catch (e) {
    del = classify(e);
  }
  ok("DELETE is refused under this migration's grants", permissionDenied(del),
     del.okd ? "DELETE SUCCEEDED — the grant is too wide" : (del as any).sqlstate);

  // ── teardown ─────────────────────────────────────────────────────────────
  for (const c of Object.values(clients)) await c.$disconnect();
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessProfile" CASCADE`);
  for (const [role] of roles) {
    // The schema-level USAGE grant is itself a dependency: without DROP OWNED
    // first, DROP ROLE fails with 2BP01 and leaves the lab dirty.
    await owner.$executeRawUnsafe(`DROP OWNED BY ${role}`);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
  }
  await owner.$disconnect();

  console.log(`\n[battery] PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(1);
});
