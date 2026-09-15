/**
 * /api/billing/invoice-profile — the route's whole database contract, proved on
 * a real PostgreSQL under the real privilege and RLS contract Production ships.
 *
 *   OWNER_URL=postgresql://…throwaway lab… \
 *     npx tsx lib/services/billing/billing-invoice-profile.rls-contract.test.ts
 *
 * WHAT WENT WRONG, AND WHAT THIS PINS
 *
 * GET used to call `businessProfile.upsert()` — a GET that WROTE — and PATCH
 * wrote on the bare Prisma client with no tenant context. Both were invisible
 * while Production connected as an owner role, and both turned into a 500 for
 * every business once the runtime became NOBYPASSRLS. `BusinessProfile` is
 * FORCE-RLS'd, so a context-less statement matches nothing on read and is
 * refused on write.
 *
 * So there are two separate invariants here, and they pull in opposite
 * directions:
 *
 *   GET   must never write, even though the runtime is now allowed to.
 *   PATCH must write, and only ever inside its own tenant.
 *
 * WHY THIS FIXTURE CAN BE TRUSTED
 *
 * The easy way to get a battery like this wrong is to make it more permissive
 * than Production — a BYPASSRLS role, an invented `FOR ALL` policy, a blanket
 * grant — and this programme has already shipped a falsely-green fixture of
 * exactly that kind. So nothing here is retyped from memory:
 *
 *   * the policy is REPLAYED OUT OF the shipped RLS migration file;
 *   * the grants are READ OUT OF the two shipped artifacts that actually carry
 *     them — the wave-1 grants script and the Phase-A grants migration — and the
 *     combined set is asserted, so widening either one fails here loudly;
 *   * the role is NOBYPASSRLS, asserted rather than assumed;
 *   * and the effective privileges are read back out of the catalog.
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
const WAVE1_GRANTS = join(ROOT, "scripts/security/d2-p7-wave1-grants.sql");
const PHASE_A_GRANTS = join(
  ROOT,
  "prisma/migrations/20260915120000_businessprofile_runtime_grants/migration.sql"
);
const ROUTE_FILE = join(ROOT, "app/api/billing/invoice-profile/route.ts");

const ROLE = `app_runtime_invprofile_${randomBytes(4).toString("hex")}`;
const PW = "invprofile_ci_synthetic_pw";
const RUNTIME_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//${ROLE}:${PW}@`);

const A = 880101; // the acting tenant
const B = 880202; // the neighbour that must stay untouchable

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

type Outcome = { okd: true } | { okd: false; sqlstate: string | null; text: string };

/**
 * A model-level Prisma call WRAPS the driver error: `meta.code` is often absent
 * and the PostgreSQL text sits inside the long `message`. Matching a truncated
 * message made real refusals unclassifiable while this was being written.
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

async function main(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

  // ── 0. the shipped artifacts still say what this battery assumes ─────────
  const wave1Grants = readFileSync(WAVE1_GRANTS, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^GRANT\b/i.test(l) && /"BusinessProfile"/.test(l));
  const phaseAGrants = readFileSync(PHASE_A_GRANTS, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^GRANT\b/i.test(l));

  ok("wave-1 still grants SELECT on BusinessProfile", wave1Grants.length === 1 &&
     /GRANT\s+SELECT\s+ON\s+"BusinessProfile"/i.test(wave1Grants[0]), wave1Grants.join(" | "));
  ok("Phase A adds exactly two grants", phaseAGrants.length === 2, phaseAGrants.join(" | "));

  const allGrants = [...wave1Grants, ...phaseAGrants];
  ok(
    "the combined shipped contract grants no DELETE, TRUNCATE, REFERENCES or TRIGGER",
    !allGrants.some((l) => /\b(DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL PRIVILEGES)\b/i.test(l)),
    allGrants.join(" | ")
  );

  const rlsSql = readFileSync(RLS_MIGRATION, "utf8");
  ok(
    "the shipped migration still FORCEs RLS on BusinessProfile",
    /ALTER TABLE "BusinessProfile"\s+FORCE ROW LEVEL SECURITY/i.test(rlsSql)
  );

  // ── 1. fixture: the real shape, the SHIPPED policy, the SHIPPED grants ───
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
  for (const stmt of statements(rlsSql)) await owner.$executeRawUnsafe(stmt);

  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
  await owner.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' NOBYPASSRLS`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  for (const g of allGrants) {
    await owner.$executeRawUnsafe(g.replace(/:ROLE|app_runtime/g, ROLE).replace(/;\s*$/, ""));
  }

  const bypass = await owner.$queryRawUnsafe<{ rolbypassrls: boolean }[]>(
    `SELECT rolbypassrls FROM pg_roles WHERE rolname = '${ROLE}'`
  );
  ok("fixture: the role is NOBYPASSRLS (this battery cannot be falsely green)",
     bypass[0]?.rolbypassrls === false);
  const held = await owner.$queryRawUnsafe<{ privilege_type: string }[]>(
    `SELECT DISTINCT privilege_type FROM information_schema.table_privileges
      WHERE grantee = '${ROLE}' AND table_name = 'BusinessProfile' ORDER BY 1`
  );
  ok(
    "fixture: effective privileges are exactly INSERT, SELECT, UPDATE — Production's contract",
    held.map((h) => h.privilege_type).join(",") === "INSERT,SELECT,UPDATE",
    held.map((h) => h.privilege_type).join(",") || "(none)"
  );

  // The neighbour that must never be touched.
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingLegalName","billingTaxId")
     VALUES (${B},'Tenant B Ltd','222222222')`
  );
  const resetA = () =>
    owner.$executeRawUnsafe(`DELETE FROM "BusinessProfile" WHERE "businessId" = ${A}`);

  // ── 2. context-less access is still broken, on purpose ───────────────────
  // This is the shape both handlers used to have. It must stay refused even now
  // that the runtime holds INSERT and UPDATE — the privilege was never what made
  // a context-less write safe; the policy is.
  console.log("\n== context-less access (what both handlers used to do) ==");
  process.env.DATABASE_URL = RUNTIME_URL;
  const bare = new PrismaClient({ datasources: { db: { url: RUNTIME_URL } } });

  await resetA();
  let bareWrite: Outcome;
  try {
    await bare.businessProfile.upsert({
      where: { businessId: A },
      create: { businessId: A },
      update: {},
      select: { billingLegalName: true },
    });
    bareWrite = { okd: true };
  } catch (e) {
    bareWrite = classify(e);
  }
  ok(
    "a context-less write is refused by the policy's WITH CHECK, not by privilege",
    rlsViolation(bareWrite),
    bareWrite.okd ? "SUCCEEDED — the policy is not protecting this table" : bareWrite.text.slice(0, 120)
  );
  const bareRead = await bare.businessProfile.findUnique({
    where: { businessId: B },
    select: { billingLegalName: true },
  });
  ok("a context-less read silently sees nothing (the quiet half of the defect)", bareRead === null);
  await bare.$disconnect();

  // ── 3. the shipped code paths, as the restricted role ────────────────────
  const { loadBillingInvoiceProfile, BILLING_INVOICE_PROFILE_SELECT } = await import(
    "@/lib/services/billing/billing-invoice-profile.service"
  );
  const { billingTenantTx } = await import("@/lib/services/billing/billing-tenant-tx");
  const { DEFAULT_BILLING_PDF_TEMPLATE_STYLE } = await import(
    "@/lib/billing/billing-pdf-template-style"
  );

  /** Exactly the statement PATCH issues for a write. */
  const patchWrite = async (tenant: number, target: number, data: Record<string, string>) => {
    try {
      const r = await billingTenantTx(tenant, (tx) =>
        tx.businessProfile.upsert({
          where: { businessId: target },
          create: { businessId: target, ...data },
          update: data,
          select: BILLING_INVOICE_PROFILE_SELECT,
        })
      );
      return { okd: true as const, row: r };
    } catch (e) {
      return classify(e);
    }
  };
  /** Exactly the statement PATCH's empty-payload branch issues. */
  const patchEmptyRead = (tenant: number, target: number) =>
    billingTenantTx(tenant, (tx) =>
      tx.businessProfile.findUnique({
        where: { businessId: target },
        select: BILLING_INVOICE_PROFILE_SELECT,
      })
    );

  console.log("\n== GET: reads its own tenant, and never writes ==");
  await resetA();
  const emptyGet = await loadBillingInvoiceProfile(A);
  ok("GET with no row: a profile object is returned, never null",
     emptyGet.profile !== null && typeof emptyGet.profile === "object");
  ok("GET with no row: identityComplete is false", emptyGet.identityComplete === false);
  ok("GET with no row: template falls back to the default",
     emptyGet.profile.billingPdfTemplateStyle === DEFAULT_BILLING_PDF_TEMPLATE_STYLE);
  const rowsAfterGet = await owner.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "BusinessProfile" WHERE "businessId" = ${A}`
  );
  ok("GET created no row, even though the runtime may now INSERT",
     Number(rowsAfterGet[0].n) === 0, `n=${rowsAfterGet[0].n}`);

  console.log("\n== PATCH: INSERT, then UPDATE, inside the tenant ==");
  const ins = await patchWrite(A, A, { billingLegalName: "Tenant A Ltd", billingTaxId: "111111111" });
  ok("PATCH INSERT path succeeds (first time a business saves its identity)", ins.okd,
     ins.okd ? "" : (ins as any).text?.slice(0, 160));
  ok("PATCH INSERT returns the saved values",
     ins.okd && (ins as any).row.billingLegalName === "Tenant A Ltd");

  const upd = await patchWrite(A, A, { billingLegalName: "Tenant A Ltd (renamed)" });
  ok("PATCH UPDATE path succeeds (every save after the first)", upd.okd,
     upd.okd ? "" : (upd as any).text?.slice(0, 160));
  ok("PATCH UPDATE returns the new value",
     upd.okd && (upd as any).row.billingLegalName === "Tenant A Ltd (renamed)");
  ok("PATCH UPDATE preserved the untouched field",
     upd.okd && (upd as any).row.billingTaxId === "111111111");
  const n = await owner.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "BusinessProfile" WHERE "businessId" = ${A}`
  );
  ok("PATCH UPDATE did not create a second row", Number(n[0].n) === 1, `n=${n[0].n}`);

  console.log("\n== PATCH: the empty-payload read branch ==");
  const seen = await patchEmptyRead(A, A);
  ok("empty-payload read sees the tenant's OWN row (it used to silently see null)",
     seen?.billingLegalName === "Tenant A Ltd (renamed)", JSON.stringify(seen));

  console.log("\n== isolation, with the write privileges in hand ==");
  const crossWrite = await patchWrite(A, B, { billingLegalName: "A-tried-to-write-B" });
  ok("tenant A cannot write tenant B's profile", !crossWrite.okd,
     crossWrite.okd ? "CROSS-TENANT WRITE SUCCEEDED — UNACCEPTABLE" : (crossWrite as any).text.slice(0, 120));
  const bRow = await owner.$queryRawUnsafe<{ billingLegalName: string }[]>(
    `SELECT "billingLegalName" FROM "BusinessProfile" WHERE "businessId" = ${B}`
  );
  ok("...and tenant B's row is byte-for-byte untouched",
     bRow[0]?.billingLegalName === "Tenant B Ltd", JSON.stringify(bRow));
  const crossRead = await patchEmptyRead(A, B);
  ok("tenant A cannot read tenant B's profile", crossRead === null, JSON.stringify(crossRead));
  const bGet = await loadBillingInvoiceProfile(B);
  ok("...while tenant B still reads its own", bGet.profile.billingTaxId === "222222222");

  console.log("\n== DELETE is not in the contract ==");
  const rt = new PrismaClient({ datasources: { db: { url: RUNTIME_URL } } });
  let del: Outcome;
  try {
    await rt.$executeRawUnsafe(`DELETE FROM "BusinessProfile" WHERE "businessId" = ${A}`);
    del = { okd: true };
  } catch (e) {
    del = classify(e);
  }
  ok("DELETE is still refused", permissionDenied(del),
     del.okd ? "DELETE SUCCEEDED — the grant is too wide" : (del as any).sqlstate);
  await rt.$disconnect();

  // ── 4. source guards — the route must actually use these paths ───────────
  console.log("\n== the route's source ==");
  const routeSrc = readFileSync(ROUTE_FILE, "utf8");
  const getBlock = routeSrc.slice(
    routeSrc.indexOf("export async function GET"),
    routeSrc.indexOf("export async function PATCH")
  );
  const patchBlock = routeSrc.slice(routeSrc.indexOf("export async function PATCH"));
  ok("both handler blocks were located", getBlock.length > 0 && patchBlock.length > 0);

  for (const verb of ["upsert", "create", "update", "delete", "createMany", "updateMany", "deleteMany"]) {
    ok(`GET performs no .${verb}(`, !new RegExp(`\\.${verb}\\s*\\(`).test(getBlock));
  }
  ok("PATCH touches BusinessProfile only through the tenant transaction",
     !/\bprisma\.businessProfile\b/.test(patchBlock),
     "found a bare prisma.businessProfile call in PATCH");
  ok("PATCH routes BOTH of its database calls through billingTenantTx",
     (patchBlock.match(/billingTenantTx\s*\(/g) ?? []).length === 2,
     `found ${(patchBlock.match(/billingTenantTx\s*\(/g) ?? []).length}`);
  ok("the route never takes a tenant from the request body",
     !/businessId\s*:\s*body\b|body\[\s*["']businessId/.test(routeSrc));

  // ── teardown ─────────────────────────────────────────────────────────────
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "BusinessProfile" CASCADE`);
  // The schema-level USAGE grant is a dependency of its own: without DROP OWNED
  // first, DROP ROLE fails with 2BP01 and leaves the lab dirty for the next run.
  await owner.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
  await owner.$disconnect();

  console.log(`\n[battery] PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(1);
});
