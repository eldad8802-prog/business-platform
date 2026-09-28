/**
 * CI proof for the Production SQL evidence mechanism (`prod-readonly-evidence.yml`):
 *
 *     STATIC SELECT-ONLY GUARD  +  POSTGRES READ-ONLY ENFORCEMENT
 *
 * Synthetic PG17 only. Never pointed at Production. Run:
 *   TEST_DATABASE_URL=postgresql://… npx tsx scripts/ci/prod-evidence-readonly-proof.ts
 *
 * The execution configuration is READ FROM THE WORKFLOW FILE — the guard
 * patterns, PGOPTIONS and the psql flags — so this proves the configuration
 * Production actually uses, not a copy of it that could drift.
 *
 *   1. The guards accept every allow-listed evidence file, and refuse files that
 *      try to switch the read-only boundary off.
 *   2. The FULL secretary evidence SQL runs to completion under the workflow's
 *      read-only configuration (ON_ERROR_STOP) to its last statement, and its
 *      Q9 proves the retry-safety indexes by index identity. (The tenant-
 *      isolation probe is no longer in this owner-side file: it runs AS the
 *      runtime login — see scripts/ci/runtime-rls-evidence-proof.ts.)
 *   3. Negative: real writes attempted under the same configuration are refused
 *      by Postgres ("read-only transaction"), and a fingerprint of every
 *      involved table is identical before and after.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

/* ── the configuration, read from the workflow ─────────────────────────── */

const WF = readFileSync(path.join(process.cwd(), ".github", "workflows", "prod-readonly-evidence.yml"), "utf8");
function single(name: string): string {
  const m = new RegExp(`${name}='([^']+)'`).exec(WF);
  if (!m) throw new Error(`${name} not found in prod-readonly-evidence.yml`);
  return m[1];
}
const FORBIDDEN = single("FORBIDDEN");
const BOUNDARY = single("BOUNDARY");
const ALLOWED_ON = single("ALLOWED_ON");
const PGOPTIONS = (/PGOPTIONS:\s*"([^"]+)"/.exec(WF) ?? [])[1];
const PSQL_FLAGS = ["--no-psqlrc", "--set=ON_ERROR_STOP=1"].filter((f) => WF.includes(f));
const EVIDENCE_FILES = [...new Set(WF.match(/ops\/evidence\/[a-z0-9-]+\.sql/g) ?? [])];

/** The workflow's guard, as the workflow's own shell code (exit 0 = accepted). */
function guard(file: string): { accepted: boolean; output: string } {
  const script = `
    set -euo pipefail
    SQL_FILE="$1"
    MATCHES="$(grep -inE "$FORBIDDEN" "$SQL_FILE" || true)"
    if [ -n "$MATCHES" ]; then echo "$MATCHES"; exit 1; fi
    TOUCHES="$(grep -inE "$BOUNDARY" "$SQL_FILE" | grep -viE "^[0-9]+:$ALLOWED_ON" || true)"
    if [ -n "$TOUCHES" ]; then echo "$TOUCHES"; exit 1; fi
  `;
  const r = spawnSync("bash", ["-c", script, "guard", file], {
    encoding: "utf8",
    env: { ...process.env, FORBIDDEN, BOUNDARY, ALLOWED_ON },
  });
  return { accepted: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** psql exactly as the workflow runs it. */
function psql(args: string[]) {
  return spawnSync("psql", [DB, ...PSQL_FLAGS, ...args], {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS },
  });
}

/** Statements of a migration file, $tag$ bodies and '…' strings respected. */
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
  console.log("\nconfiguration read from prod-readonly-evidence.yml");
  eq("PGOPTIONS forces read-only", PGOPTIONS, "-c default_transaction_read_only=on");
  eq("psql flags", PSQL_FLAGS, ["--no-psqlrc", "--set=ON_ERROR_STOP=1"]);
  check("the workflow confirms read-only with SHOW before running the file", WF.includes("SHOW default_transaction_read_only"));
  check("the original SELECT-only guard is retained", FORBIDDEN.includes("insert|update|delete") && WF.includes("Forbidden write keyword found in SQL"));

  console.log("\n1 · static guards");
  const rejectedLegit = EVIDENCE_FILES.filter((f) => !guard(f).accepted);
  eq(`all ${EVIDENCE_FILES.length} allow-listed evidence files are accepted`, rejectedLegit, []);
  check("the secretary evidence file is allow-listed", EVIDENCE_FILES.includes("ops/evidence/secretary-ledger-cutover-evidence.sql"));
  const dir = mkdtempSync(path.join(tmpdir(), "evidence-guard-"));
  const hostile: Record<string, string> = {
    "switch read-only off": "SELECT 1;\nSET default_transaction_read_only = off;\n",
    "on, then off": "SET default_transaction_read_only = on;\nSET default_transaction_read_only = off;\n",
    "set_config to off": "SELECT set_config('default_transaction_read_only','off',false);\n",
    "BEGIN READ WRITE": "BEGIN READ WRITE;\n",
    "session characteristics": "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;\n",
    "RESET ALL": "RESET ALL;\n",
    "a write keyword": "UPDATE \"Business\" SET \"name\" = \"name\";\n",
  };
  for (const [label, sql] of Object.entries(hostile)) {
    const f = path.join(dir, `${label.replace(/\W+/g, "-")}.sql`);
    writeFileSync(f, sql);
    check(`refused: ${label}`, !guard(f).accepted);
  }

  console.log("\n2 · fixtures: business 38 (QA) and another business, RLS migrations, app_runtime");
  const { prisma } = await import("@/lib/prisma");
  const run = randomBytes(3).toString("hex");
  const other = await prisma.business.create({ data: { name: `evidence-other-${run}` } });
  const qa = await prisma.business.create({ data: { id: 38, name: `evidence-qa-${run}` } });
  const mk = async (businessId: number, title: string) => {
    const c = await prisma.commitment.create({
      data: { businessId, title, payeeNameSnapshot: "x", scheduleKind: "RECURRING", recurrence: "MONTHLY" },
    });
    const i = await prisma.installment.create({
      data: { businessId, commitmentId: c.id, sequence: 1, scheduledAmount: "100", dueAt: new Date("2026-09-01T00:00:00Z") },
    });
    const p = await prisma.payment.create({
      data: { businessId, payeeNameSnapshot: "x", amount: "100", paidAt: new Date("2026-09-01T09:00:00Z"), method: "CASH", idempotencyKey: `secretary:${i.id}:2026-09-01:100` },
    });
    await prisma.paymentAllocation.create({ data: { businessId, paymentId: p.id, installmentId: i.id, allocatedAmount: "100" } });
    await prisma.installmentWorkflow.create({ data: { businessId, installmentId: i.id, followUpAt: new Date("2026-09-05T00:00:00Z") } });
    await prisma.businessObligation.create({ data: { businessId, obligeeName: "x", amount: "1", dueAt: new Date("2026-09-01T00:00:00Z") } });
  };
  await mk(qa.id, "QA-P2 שכירות");
  await mk(other.id, "other business rent");

  for (const s of splitSql(migration("20260917090100_payables_phase_1a_tenant_rls"))) await prisma.$executeRawUnsafe(s);
  for (const s of splitSql(migration("20260824210000_d2_p7_wave1_tenant_rls")).filter((x) => /"BusinessObligation(Orientation)?"/.test(x))) {
    await prisma.$executeRawUnsafe(s);
  }
  for (const s of splitSql(migration("20260927090000_payables_installment_workflow"))) {
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE "InstallmentWorkflow" ADD CONSTRAINT)/.test(s)) continue;
    await prisma.$executeRawUnsafe(s);
  }
  await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_runtime`);
  for (const t of ["Business", "Commitment", "Installment", "InstallmentWorkflow", "Payment", "PaymentAllocation", "BusinessObligation"]) {
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "${t}" TO app_runtime`);
  }

  const fingerprint = async () =>
    (
      await prisma.$queryRawUnsafe<Array<{ f: string }>>(`
        SELECT md5(concat_ws('#',
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Business" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Commitment" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Installment" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."installmentId") FROM "InstallmentWorkflow" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "Payment" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "PaymentAllocation" t),
          (SELECT string_agg(t::text, ',' ORDER BY t."id") FROM "BusinessObligation" t))) AS f`)
    )[0].f;
  const before = await fingerprint();

  console.log("\n2 · the full secretary evidence SQL under the workflow's read-only configuration");
  const show = spawnSync("psql", [DB, "--no-psqlrc", "-At", "-c", "SHOW default_transaction_read_only"], {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS },
  });
  eq("the pre-run SHOW reports read-only", (show.stdout ?? "").trim(), "on");
  const ev = psql(["--file=ops/evidence/secretary-ledger-cutover-evidence.sql"]);
  check("psql exits 0 with ON_ERROR_STOP — every query in the file ran", ev.status === 0, (ev.stderr ?? "").slice(-800));
  const out = ev.stdout ?? "";
  check("the file ran to its last statement", out.includes("Q10 is NOT in this file"));
  check("no SET ROLE remains in the owner evidence file (Q10 runs AS the runtime login)", !/set\s+role/i.test(readFileSync("ops/evidence/secretary-ledger-cutover-evidence.sql", "utf8")));
  const idx = out.split(/\r?\n/).filter((l) => /_key\s*\|/.test(l)).map((l) => l.split("|").map((c) => c.trim()));
  const byName = Object.fromEntries(idx.map((c) => [c[0], c]));
  eq("Q9 Installment_commitmentId_sequence_key: unique, on Installment, {commitmentId,sequence}", byName["Installment_commitmentId_sequence_key"]?.slice(1, 4), ["t", "Installment", "{commitmentId,sequence}"]);
  eq("Q9 Payment_businessId_idempotencyKey_key: unique, on Payment, {businessId,idempotencyKey}", byName["Payment_businessId_idempotencyKey_key"]?.slice(1, 4), ["t", "Payment", "{businessId,idempotencyKey}"]);
  check("Q9 PaymentAllocation_active_payment_installment_key: unique and partial on active rows", byName["PaymentAllocation_active_payment_installment_key"]?.[1] === "t" && /reversedAt.*IS NULL/.test(byName["PaymentAllocation_active_payment_installment_key"]?.[4] ?? ""));

  console.log("\n3 · negative: writes under the same configuration are refused by Postgres");
  const attempts: Record<string, string> = {
    UPDATE: `UPDATE "Business" SET "name" = "name" WHERE "id" = 38`,
    INSERT: `INSERT INTO "BusinessObligation" ("businessId","obligeeName","amount","dueAt","updatedAt") VALUES (38,'x',1,now(),now())`,
    DELETE: `DELETE FROM "PaymentAllocation" WHERE "businessId" = 38`,
  };
  for (const [kind, sql] of Object.entries(attempts)) {
    const r = psql(["-c", sql]);
    check(`${kind} refused by Postgres ("read-only transaction")`, r.status !== 0 && /read-only transaction/.test(r.stderr ?? ""), (r.stderr ?? "").trim().split("\n")[0]);
  }
  eq("database unchanged after the negative test (fingerprint of all 7 tables)", await fingerprint(), before);

  await prisma.$disconnect();
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
