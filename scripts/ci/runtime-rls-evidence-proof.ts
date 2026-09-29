/**
 * CI proof for the two-connection Production RLS evidence path
 * (`scripts/ops/runtime-rls-evidence.ts`, workflow
 * `prod-readonly-evidence-runtime-rls.yml`). Synthetic PG17 ONLY.
 *
 *   TEST_DATABASE_URL=postgresql://… npx tsx scripts/ci/runtime-rls-evidence-proof.ts
 *
 * Identities built here, mirroring Production's shape:
 *   owner              the TEST_DATABASE_URL login (evidence owner)
 *   app_runtime        NOLOGIN group role holding the table grants
 *   app_runtime_ci     LOGIN, INHERIT, member of app_runtime, NOBYPASSRLS
 *                      — the stand-in for app_runtime_prod
 *   app_runtime_byp_ci LOGIN, member of app_runtime, BYPASSRLS  (must be refused)
 *   stranger_ci        LOGIN, NOBYPASSRLS, NOT a member         (must be refused)
 *
 * The script under test is run as a child process with exactly the CLI and
 * environment the workflow uses; only the credentials and expected user differ.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const DB = process.env.TEST_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\//.test(DB)) {
  console.error("TEST_DATABASE_URL must point at a disposable Postgres. Refusing to run.");
  process.exit(2);
}
process.env.DATABASE_URL = DB;

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SCRIPT = "scripts/ops/runtime-rls-evidence.ts";
const PW = randomBytes(12).toString("hex");
function urlAs(user: string, mutate?: (u: URL) => void): string {
  const u = new URL(DB);
  u.username = user;
  u.password = PW;
  mutate?.(u);
  return u.toString();
}
function runEvidence(env: Record<string, string | undefined>, expectedUser: string, extraArgs: string[] = []) {
  const r = spawnSync("npx", ["tsx", SCRIPT, "--expected-runtime-user", expectedUser, ...extraArgs], {
    shell: process.platform === "win32",
    encoding: "utf8",
    env: { ...process.env, OWNER_DATABASE_URL: DB, ...env },
    timeout: 120_000,
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const json = /\{\s*"runtimeProbe"[\s\S]*\}\s*$/.exec(r.stdout ?? "");
  const owner = /\{"ownerFacts":.*\}/.exec(r.stdout ?? "");
  return {
    status: r.status,
    out,
    probe: json ? JSON.parse(json[0]) : null,
    owner: owner ? JSON.parse(owner[0]).ownerFacts : null,
  };
}

function splitSql(sql: string): string[] {
  const text = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const out: string[] = [];
  let cur = "";
  let tag: string | null = null;
  for (let i = 0; i < text.length; ) {
    if (tag) {
      if (text.startsWith(tag, i)) {
        cur += tag;
        i += tag.length;
        tag = null;
      } else cur += text[i++];
      continue;
    }
    if (text[i] === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^\$[A-Za-z0-9_]*\$/.exec(text.slice(i));
    if (m) {
      tag = m[0];
      cur += tag;
      i += tag.length;
      continue;
    }
    if (text[i] === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += text[i++];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const migration = (name: string) => readFileSync(path.join(process.cwd(), "prisma", "migrations", name, "migration.sql"), "utf8");

async function main(): Promise<void> {
  const owner = new PrismaClient({ datasourceUrl: DB });
  const mod = await import("../ops/runtime-rls-evidence");

  console.log("\nfixtures: another business and business 38 (QA), RLS migrations, identities");
  const run = randomBytes(3).toString("hex");
  const other = await owner.business.create({ data: { name: `rls-other-${run}` } });
  const qa = await owner.business.create({ data: { id: 38, name: `rls-qa-${run}` } });
  const mk = async (businessId: number, title: string) => {
    const c = await owner.commitment.create({ data: { businessId, title, payeeNameSnapshot: "x", scheduleKind: "RECURRING", recurrence: "MONTHLY" } });
    const i = await owner.installment.create({ data: { businessId, commitmentId: c.id, sequence: 1, scheduledAmount: "100", dueAt: new Date("2026-09-01T00:00:00Z") } });
    const p = await owner.payment.create({ data: { businessId, payeeNameSnapshot: "x", amount: "100", paidAt: new Date("2026-09-01T09:00:00Z"), method: "CASH" } });
    await owner.paymentAllocation.create({ data: { businessId, paymentId: p.id, installmentId: i.id, allocatedAmount: "100" } });
    await owner.installmentWorkflow.create({ data: { businessId, installmentId: i.id, followUpAt: new Date("2026-09-05T00:00:00Z") } });
  };
  await mk(qa.id, "QA-P2 שכירות");
  await mk(other.id, "other business rent");

  for (const s of splitSql(migration("20260917090100_payables_phase_1a_tenant_rls"))) await owner.$executeRawUnsafe(s);
  for (const s of splitSql(migration("20260927090000_payables_installment_workflow"))) {
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE "InstallmentWorkflow" ADD CONSTRAINT)/.test(s)) continue;
    await owner.$executeRawUnsafe(s);
  }
  const TABLES = ["Commitment", "Installment", "InstallmentWorkflow", "Payment", "PaymentAllocation"];
  await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_runtime`);
  // Write grants too, so a refused write in the negative test is refused by READ ONLY, not by a missing privilege.
  for (const t of TABLES) await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO app_runtime`);
  const role = async (name: string, attrs: string, member: boolean) => {
    await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name}; END IF; END $$`);
    await owner.$executeRawUnsafe(`ALTER ROLE ${name} ${attrs} PASSWORD '${PW}'`);
    if (member) await owner.$executeRawUnsafe(`GRANT app_runtime TO ${name}`);
  };
  await role("app_runtime_ci", "LOGIN NOSUPERUSER NOBYPASSRLS INHERIT", true);
  await role("app_runtime_byp_ci", "LOGIN NOSUPERUSER BYPASSRLS INHERIT", true);
  await role("stranger_ci", "LOGIN NOSUPERUSER NOBYPASSRLS INHERIT", false);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO stranger_ci`);
  for (const t of TABLES) await owner.$executeRawUnsafe(`GRANT SELECT ON "${t}" TO stranger_ci`);

  console.log("\n1 · the probe AS the runtime login (the workflow's CLI)");
  const ok = runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_ci") }, "app_runtime_ci");
  check("exit 0 (PASS)", ok.status === 0, ok.out.slice(-1200));
  const p = ok.probe?.runtimeProbe;
  eq("connected user is the runtime login itself (no SET ROLE)", p?.identity.user, "app_runtime_ci");
  eq("runtime: not superuser, BYPASSRLS false, member of app_runtime", [p?.identity.superuser, p?.identity.bypassRls, p?.identity.memberOfAppRuntime], [false, false, true]);
  eq("own-tenant POSITIVE counter-check: QA-P2 row visible to 38", p?.in38.qaP2Visible, 1);
  eq("38 → other business: 0 commitments / installments / payments / workflow", [p?.in38.otherCommitments, p?.in38.otherInstallments, p?.in38.otherPayments, p?.in38.otherWorkflow], [0, 0, 0, 0]);
  eq("other business → 38: 0 commitments / installments / workflow / payments / allocations", [p?.inOther.commitments38, p?.inOther.installments38, p?.inOther.workflow38, p?.inOther.payments38, p?.inOther.allocations38], [0, 0, 0, 0, 0]);
  eq("no tenant context: 0 commitments / payments", [p?.noContext.commitments, p?.noContext.payments], [0, 0]);
  eq("the probed other business came from the OWNER side (an id only)", ok.owner?.probeOtherBusinessId, other.id);
  eq("Installment sequence uniqueness by index identity: unique, on Installment, (commitmentId, sequence)", [ok.owner?.installmentSequenceUnique.exists, ok.owner?.installmentSequenceUnique.unique, ok.owner?.installmentSequenceUnique.table, ok.owner?.installmentSequenceUnique.columns], [true, true, "Installment", ["commitmentId", "sequence"]]);
  check("no credential printed", !ok.out.includes(PW));

  console.log("\n2 · fail closed");
  const refused = (label: string, r: ReturnType<typeof runEvidence>) =>
    check(`${label} → REFUSED (exit 3)`, r.status === 3 && /REFUSED/.test(r.out), r.out.trim().split("\n").slice(-1)[0]);
  refused("runtime URL missing", runEvidence({ RUNTIME_DATABASE_URL: "" }, "app_runtime_ci"));
  refused("connected as the wrong user (expects app_runtime_prod)", runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_ci") }, "app_runtime_prod"));
  refused("runtime login with BYPASSRLS", runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_byp_ci") }, "app_runtime_byp_ci"));
  refused("runtime login that is not a member of app_runtime", runEvidence({ RUNTIME_DATABASE_URL: urlAs("stranger_ci") }, "stranger_ci"));
  refused("pooled URL (Neon -pooler host)", runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_ci", (u) => (u.hostname = "ep-x-pooler.example")) }, "app_runtime_ci"));
  refused("pooled URL (pgbouncer=true)", runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_ci", (u) => u.searchParams.set("pgbouncer", "true")) }, "app_runtime_ci"));
  refused("host outside the allow-list", runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_ci") }, "app_runtime_ci", ["--allow-host", "ep-some-other-endpoint"]));
  const notRo = new PrismaClient({ datasourceUrl: mod.assertSafeUrl("RUNTIME_DATABASE_URL", urlAs("app_runtime_ci"), null) });
  let roRefused = false;
  try {
    await mod.verifyReadOnly(notRo, "runtime");
  } catch (e) {
    roRefused = e instanceof mod.RefusedError;
  }
  await notRo.$disconnect();
  check("a session that is not read-only → REFUSED before any probe", roRefused);

  // Cross-tenant leak → FAIL: synthetically remove RLS from one table (CI DB only).
  await owner.$executeRawUnsafe(`ALTER TABLE "Payment" NO FORCE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(`ALTER TABLE "Payment" DISABLE ROW LEVEL SECURITY`);
  const leak = runEvidence({ RUNTIME_DATABASE_URL: urlAs("app_runtime_ci") }, "app_runtime_ci");
  check("cross-tenant rows visible → FAIL (exit 1), never a pass", leak.status === 1 && leak.probe?.verdict === "FAIL" && leak.probe.failures.some((f: string) => /payments/.test(f)), JSON.stringify(leak.probe?.failures ?? leak.out.slice(-300)));
  await owner.$executeRawUnsafe(`ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(`ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY`);
  const facts = { ...ok.owner, installmentSequenceUnique: { ...ok.owner.installmentSequenceUnique, unique: false } };
  check("a non-unique Installment index → FAIL", !mod.verdict(facts, ok.probe.runtimeProbe).pass);
  const empty = { ...ok.owner, own38QaP2Commitments: 0, own38Commitments: 0 };
  check("empty QA tenant → the positive check says NOT YET AVAILABLE (no invented pass)", /NOT YET AVAILABLE/.test(mod.verdict(empty, ok.probe.runtimeProbe).positiveCheck));

  console.log("\n3 · negative: writes through the runtime evidence configuration are refused by Postgres");
  const fingerprint = async () =>
    (
      await owner.$queryRawUnsafe<Array<{ f: string }>>(`
        SELECT md5(concat_ws('#',
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Commitment" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Installment" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."installmentId") FROM "InstallmentWorkflow" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Payment" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "PaymentAllocation" t))) AS f`)
    )[0].f;
  const before = await fingerprint();
  const rt = new PrismaClient({ datasourceUrl: mod.assertSafeUrl("RUNTIME_DATABASE_URL", urlAs("app_runtime_ci"), null) });
  await mod.enforceReadOnly(rt, "runtime");
  await rt.$queryRawUnsafe(`SELECT set_config('app.current_business_id', '38', false)`);
  const attempts: Record<string, string> = {
    UPDATE: `UPDATE "Commitment" SET "title" = "title" WHERE "businessId" = 38`,
    INSERT: `INSERT INTO "InstallmentWorkflow" ("installmentId","businessId","updatedAt") SELECT "id", 38, now() FROM "Installment" WHERE false`,
    DELETE: `DELETE FROM "PaymentAllocation" WHERE "businessId" = 38`,
  };
  for (const [kind, sql] of Object.entries(attempts)) {
    let refusedRo = false;
    try {
      await rt.$executeRawUnsafe(sql);
    } catch (e) {
      refusedRo = /read-only transaction/.test(String((e as Error).message));
    }
    check(`${kind} as the runtime login under the evidence configuration → refused ("read-only transaction")`, refusedRo);
  }
  await rt.$disconnect();
  eq("database unchanged (fingerprint of the 5 tables)", await fingerprint(), before);

  await owner.$disconnect();
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
