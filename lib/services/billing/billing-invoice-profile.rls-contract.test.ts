/**
 * BusinessProfile read contract — proof on a real PostgreSQL, under the real
 * privilege and RLS contract that Production ships.
 *
 *   OWNER_URL=postgresql://…throwaway lab… \
 *     npx tsx lib/services/billing/billing-invoice-profile.rls-contract.test.ts
 *
 * WHY THIS BATTERY EXISTS
 *
 * `GET /api/billing/invoice-profile` used to call `businessProfile.upsert()` —
 * a GET that WRITES. That was invisible for as long as Production connected as
 * an owner role, and it turned into a 500 for EVERY business the moment the
 * runtime became `app_runtime_prod` (NOBYPASSRLS). Two independent reasons, and
 * either one is sufficient:
 *
 *   1. the route sets no `app.current_business_id`, so under FORCE RLS the
 *      SELECT half matches zero rows for every tenant and the upsert always
 *      takes the INSERT branch; and
 *   2. the runtime holds `GRANT SELECT` on "BusinessProfile" and nothing more,
 *      so that INSERT is refused with 42501 before RLS is even consulted.
 *
 * A battery that ran as an owner, or that invented its own policy, would have
 * reported `pass` for both. This programme has been burned by exactly that
 * twice, so the fixture below is built FROM THE SHIPPED ARTIFACTS — the policy
 * is replayed out of the migration file and the grant is read out of the grants
 * script — and it asserts the artifacts still say what this test assumes. If
 * someone widens the grant, this battery says so instead of going quiet.
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

const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL || !/^postgres(ql)?:\/\//i.test(OWNER_URL)) {
  console.error(
    "ABORT: OWNER_URL is required — an owner connection to a THROWAWAY lab database.\n" +
      "This battery creates a role, a table and policies. Never point it at Production."
  );
  process.exit(2);
}

const RLS_MIGRATION = join(
  ROOT,
  "prisma/migrations/20260825120000_d2_p7_wave1_businessprofile_rls/migration.sql"
);
const GRANTS_ARTIFACT = join(ROOT, "scripts/security/d2-p7-wave1-grants.sql");
const ROUTE_FILE = join(ROOT, "app/api/billing/invoice-profile/route.ts");

const ROLE = `app_runtime_invprofile_${randomBytes(4).toString("hex")}`;
const PW = "invprofile_ci_synthetic_pw";
const RUNTIME_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//${ROLE}:${PW}@`);

const TENANT_A = 8101;
const TENANT_B = 8102;

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

/**
 * Prisma reports a raw-query failure as P2010 with the PostgreSQL SQLSTATE in
 * `meta.code`, not in the message. Reading only the message has already made
 * genuine refusals look like silent successes elsewhere in this programme.
 */
function sqlstateOf(error: unknown): string | null {
  const e = error as { meta?: { code?: string }; code?: string; message?: string };
  if (e?.meta?.code) return e.meta.code;
  const m = /\b(\d{5})\b/.exec(e?.message ?? "");
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  // ---------------------------------------------------------------------
  // 0. The artifacts must still say what this battery assumes.
  // ---------------------------------------------------------------------
  const grantsSql = readFileSync(GRANTS_ARTIFACT, "utf8");
  const profileGrants = grantsSql
    .split(/\r?\n/)
    .filter((l) => /GRANT\s+.*ON\s+"BusinessProfile"/i.test(l) && !l.trim().startsWith("--"));

  ok(
    "the grants artifact carries exactly one BusinessProfile grant",
    profileGrants.length === 1,
    `found ${profileGrants.length}`
  );
  ok(
    "that grant is SELECT and nothing else (no INSERT/UPDATE/DELETE)",
    profileGrants.length === 1 &&
      /GRANT\s+SELECT\s+ON\s+"BusinessProfile"/i.test(profileGrants[0]) &&
      !/INSERT|UPDATE|DELETE|ALL/i.test(profileGrants[0]),
    profileGrants[0] ?? "(none)"
  );

  const rlsSql = readFileSync(RLS_MIGRATION, "utf8");
  ok(
    "the shipped migration still FORCEs RLS on BusinessProfile",
    /ALTER TABLE "BusinessProfile"\s+FORCE ROW LEVEL SECURITY/i.test(rlsSql)
  );

  // ---------------------------------------------------------------------
  // 1. Build the fixture: the real table shape, the SHIPPED policy, a
  //    NOBYPASSRLS role holding the SHIPPED grant and nothing more.
  // ---------------------------------------------------------------------
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
      "billingPdfTemplateStyle"   text NOT NULL DEFAULT 'CLASSIC'
    )
  `);

  // Replayed from the migration file, not retyped.
  for (const stmt of statements(rlsSql)) {
    await owner.$executeRawUnsafe(stmt);
  }

  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' NOBYPASSRLS`
  );
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  // The grant line, taken verbatim from the shipped artifact.
  await owner.$executeRawUnsafe(profileGrants[0].replace(/:ROLE/g, ROLE).replace(/;\s*$/, ""));
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON SEQUENCE "BusinessProfile_id_seq" TO ${ROLE}`
  );

  // Tenant A is CONFIGURED. Tenant B is the neighbour that must stay invisible.
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingLegalName","billingBusinessKind","billingTaxId","billingAddress","billingPhone","billingEmail","billingPdfTemplateStyle")
     VALUES (${TENANT_A},'Tenant A Ltd','LTD_COMPANY','111111111','Rothschild 1','0500000001','a@example.test','MODERN')`
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingLegalName","billingTaxId")
     VALUES (${TENANT_B},'Tenant B Ltd','222222222')`
  );

  const runtimeIsRestricted = await owner.$queryRawUnsafe<
    { rolbypassrls: boolean }[]
  >(`SELECT rolbypassrls FROM pg_roles WHERE rolname = '${ROLE}'`);
  ok(
    "the test role is NOBYPASSRLS (the battery cannot be falsely green)",
    runtimeIsRestricted[0]?.rolbypassrls === false
  );

  const privs = await owner.$queryRawUnsafe<{ privilege_type: string }[]>(
    `SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = '${ROLE}' AND table_name = 'BusinessProfile'`
  );
  const held = privs.map((p) => p.privilege_type).sort();
  ok(
    "the test role holds SELECT and nothing else on BusinessProfile",
    held.length === 1 && held[0] === "SELECT",
    `holds: ${held.join(",") || "(none)"}`
  );

  await owner.$disconnect();

  // ---------------------------------------------------------------------
  // 2. The shape main used to ship: a GET that writes. Must be REFUSED.
  //    This half stays in the battery permanently: it is what stops the
  //    write from being reintroduced under a passing suite.
  // ---------------------------------------------------------------------
  process.env.DATABASE_URL = RUNTIME_URL;
  const runtime = new PrismaClient({ datasources: { db: { url: RUNTIME_URL } } });

  let upsertSqlstate: string | null = null;
  try {
    await runtime.$executeRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId") VALUES (${TENANT_A})`
    );
  } catch (e) {
    upsertSqlstate = sqlstateOf(e);
  }
  ok(
    "the old upsert shape is refused by the database (42501)",
    upsertSqlstate === "42501",
    `sqlstate=${upsertSqlstate ?? "none — THE WRITE SUCCEEDED"}`
  );

  let updateSqlstate: string | null = null;
  try {
    await runtime.$executeRawUnsafe(
      `UPDATE "BusinessProfile" SET "billingLegalName" = 'x' WHERE "businessId" = ${TENANT_A}`
    );
  } catch (e) {
    updateSqlstate = sqlstateOf(e);
  }
  ok(
    "a bare UPDATE is refused too (the PATCH path is knowingly out of scope)",
    updateSqlstate === "42501",
    `sqlstate=${updateSqlstate ?? "none"}`
  );

  // A context-less read is the silent half of the same defect.
  const contextless = await runtime.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "BusinessProfile" WHERE "businessId" = ${TENANT_A}`
  );
  ok(
    "a context-less SELECT sees zero rows — silently (this is why the upsert always INSERTed)",
    Number(contextless[0].n) === 0
  );
  await runtime.$disconnect();

  // ---------------------------------------------------------------------
  // 3. The shipped read path, exercised as the restricted role.
  // ---------------------------------------------------------------------
  const { loadBillingInvoiceProfile } = await import(
    "@/lib/services/billing/billing-invoice-profile.service"
  );
  const { DEFAULT_BILLING_PDF_TEMPLATE_STYLE } = await import(
    "@/lib/billing/billing-pdf-template-style"
  );

  // 3a. Configured tenant → its own values.
  const a = await loadBillingInvoiceProfile(TENANT_A);
  ok("configured tenant: returns its own legal name", a.profile.billingLegalName === "Tenant A Ltd");
  ok("configured tenant: returns its own tax id", a.profile.billingTaxId === "111111111");
  ok("configured tenant: template style is preserved", a.profile.billingPdfTemplateStyle === "MODERN");
  ok("configured tenant: identityComplete is true", a.identityComplete === true);

  // 3b. Tenant with no row at all → a well-formed empty profile, HTTP-200 shaped.
  const EMPTY_TENANT = 8103;
  const e = await loadBillingInvoiceProfile(EMPTY_TENANT);
  ok("no profile: a profile object is still returned (never null)", e.profile !== null && typeof e.profile === "object");
  ok("no profile: identityComplete is false", e.identityComplete === false);
  ok(
    "no profile: template style falls back to the default",
    e.profile.billingPdfTemplateStyle === DEFAULT_BILLING_PDF_TEMPLATE_STYLE
  );
  ok("no profile: legal name is null, not undefined", e.profile.billingLegalName === null);
  ok("no profile: tax id is null, not undefined", e.profile.billingTaxId === null);

  // 3c. Cross-tenant isolation: A's read must never surface B.
  ok(
    "cross-tenant: tenant A never sees tenant B's legal name",
    a.profile.billingLegalName !== "Tenant B Ltd" && a.profile.billingTaxId !== "222222222"
  );
  const b = await loadBillingInvoiceProfile(TENANT_B);
  ok("cross-tenant: tenant B reads its own row", b.profile.billingTaxId === "222222222");
  ok(
    "cross-tenant: the two tenants get different rows",
    a.profile.billingTaxId !== b.profile.billingTaxId
  );

  // 3d. The read wrote nothing. Proven by row count, not by reading the code.
  const after = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const rows = await after.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "BusinessProfile"`
  );
  ok(
    "the read path created no row for the profile-less tenant",
    Number(rows[0].n) === 2,
    `rows=${rows[0].n} (expected the 2 seeded)`
  );
  const untouched = await after.$queryRawUnsafe<{ billingLegalName: string }[]>(
    `SELECT "billingLegalName" FROM "BusinessProfile" WHERE "businessId" = ${TENANT_A}`
  );
  ok(
    "the read path mutated nothing on the existing row",
    untouched[0]?.billingLegalName === "Tenant A Ltd"
  );

  // ---------------------------------------------------------------------
  // 4. Source guard — the GET handler must contain no write verb.
  // ---------------------------------------------------------------------
  const routeSrc = readFileSync(ROUTE_FILE, "utf8");
  const getBlock = routeSrc.slice(
    routeSrc.indexOf("export async function GET"),
    routeSrc.indexOf("export async function PATCH")
  );
  ok("the GET block was located in the route source", getBlock.length > 0);
  for (const verb of ["upsert", "create", "update", "delete", "createMany", "updateMany", "deleteMany"]) {
    ok(
      `GET performs no .${verb}(`,
      !new RegExp(`\\.${verb}\\s*\\(`).test(getBlock),
      `found .${verb}( inside the GET handler`
    );
  }

  // Teardown. The schema-level USAGE grant is a dependency of its own, so the
  // role cannot be dropped until what it owns and holds is released first —
  // otherwise DROP ROLE fails with 2BP01 and leaves the lab dirty for the next run.
  await after.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessProfile" CASCADE`);
  await after.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`);
  await after.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
  await after.$disconnect();

  console.log(`\n[battery] PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(1);
});
