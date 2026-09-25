/**
 * Daily Business Cost — database proofs. Run against a disposable Postgres:
 *   TEST_DATABASE_URL=postgresql://… npx tsx lib/services/business-cost/business-cost.db.test.ts
 *
 * What only a database can prove:
 *   1. Real rows written through the real payables service produce the exact
 *      figures the pure rules promise (Sep 15: rent 300, insurance 20, …).
 *   2. A legacy secretary obligation that was never backfilled is counted once;
 *      one that WAS backfilled is read from the ledger only — never twice.
 *   3. Paying the rent late moves cash out, never allocation.
 *   4. TENANT ISOLATION, twice over:
 *        a. at the service: business A's answer contains nothing of B's;
 *        b. under REAL RLS: the service is re-run in a child process connected
 *           as a NOSUPERUSER NOBYPASSRLS role, with the repo's own RLS
 *           migrations applied — a superuser test connection bypasses RLS, so
 *           without this the policies are never actually exercised.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const IS_RLS_CHILD = process.env.BUSINESS_COST_RLS_CHILD === "1";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
if (!IS_RLS_CHILD) {
  if (!/^postgres(ql)?:\/\//.test(TEST_DB)) {
    console.error("TEST_DATABASE_URL must point at a disposable Postgres. Refusing to run.");
    process.exit(2);
  }
  process.env.DATABASE_URL = TEST_DB;
}
process.env.AUTH_TOKEN_SECRET ??= "business-cost-db-test-secret-0123456789abcdef";

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

const DATE = "2026-09-15";
const ENGINE_TABLES = [
  "Commitment",
  "Installment",
  "Payee",
  "Payment",
  "PaymentAllocation",
  "BusinessObligation",
  "BusinessObligationOrientation",
] as const;

/* ───────────────────────── child: run under real RLS ─────────────────────── */

async function rlsChild(): Promise<void> {
  const a = Number(process.env.BC_BUSINESS_A);
  const b = Number(process.env.BC_BUSINESS_B);
  const { prisma } = await import("@/lib/prisma");
  const { deriveBusinessCost, serializeBusinessCostDay } = await import("./business-cost.service");

  // Raw, UNFILTERED reads under A's context: RLS alone must hide B.
  const leaked: Record<string, number> = {};
  const own: Record<string, number> = {};
  for (const table of ENGINE_TABLES) {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(a)}, true)`;
      return tx.$queryRawUnsafe<Array<{ businessId: number }>>(`SELECT "businessId" FROM "${table}"`);
    });
    leaked[table] = rows.filter((r) => r.businessId === b).length;
    own[table] = rows.filter((r) => r.businessId === a).length;
  }
  const noContext = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "Commitment"`);
  const role = await prisma.$queryRawUnsafe<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
  );

  const dayA = serializeBusinessCostDay(await deriveBusinessCost({ businessId: a, date: DATE }));
  const dayB = serializeBusinessCostDay(await deriveBusinessCost({ businessId: b, date: DATE }));
  process.stdout.write(
    "\n@@RESULT@@" +
      JSON.stringify({ leaked, own, noContextRows: Number(noContext[0].n), role: role[0], dayA, dayB }) +
      "@@END@@\n",
  );
  await prisma.$disconnect();
}

/* ───────────────────────────────── parent ────────────────────────────────── */

/** Executable statements of a migration file, comments stripped. */
function migrationStatements(file: string, onlyTables?: string[]): string[] {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", file, "migration.sql"), "utf8");
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !onlyTables || onlyTables.some((t) => s.includes(`"${t}"`)));
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const payables = await import("@/lib/services/payables/payables.service");
  const { deriveBusinessCost } = await import("./business-cost.service");

  const runId = randomBytes(4).toString("hex");
  async function makeBusiness(label: string) {
    return prisma.business.create({
      data: {
        name: `BusinessCost ${label} ${runId}`,
        users: {
          create: { email: `bc-${label}-${runId}@example.test`, password: "x", name: `bc ${label}` },
        },
      },
    });
  }

  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A.id }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B.id }, fn);

  try {
    /* ── business A: the owner's real month ─────────────────────────────── */
    const landlord = await asA(() => payables.createPayee({ businessId: A.id, displayName: "בעל הבית", kind: "LANDLORD" }));
    const bank = await asA(() => payables.createPayee({ businessId: A.id, displayName: "הבנק", kind: "LENDER" }));

    const rent = await asA(() =>
      payables.createCommitment({
        businessId: A.id, title: "שכירות", payeeId: landlord.id, scheduleKind: "RECURRING",
        recurrence: "MONTHLY", recurringAmount: "9000", firstDueAt: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    const insurance = await asA(() =>
      payables.createCommitment({
        businessId: A.id, title: "ביטוח עסק", payeeNameSnapshot: "חברת ביטוח", scheduleKind: "RECURRING",
        recurrence: "YEARLY", recurringAmount: "7300", firstDueAt: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const loan = await asA(() =>
      payables.createCommitment({
        businessId: A.id, title: "הלוואה", payeeId: bank.id, scheduleKind: "RECURRING",
        recurrence: "MONTHLY", recurringAmount: "2400", firstDueAt: new Date("2026-09-10T00:00:00Z"),
      }),
    );
    const repair = await asA(() =>
      payables.createCommitment({
        businessId: A.id, title: "תיקון מזגן", payeeNameSnapshot: "טכנאי", scheduleKind: "ONE_OFF",
        totalAmount: "3000", firstDueAt: new Date("2026-09-20T00:00:00Z"),
      }),
    );

    // The rent is paid LATE, on the 15th, at 10:00 Israel time.
    await asA(() =>
      payables.recordManualPayment({
        businessId: A.id, commitmentId: rent.id, amount: "9000",
        paidAt: new Date("2026-09-15T07:00:00Z"), method: "BANK_TRANSFER",
      }),
    );

    // Secretary rows. One written AFTER the backfill (only in BusinessObligation),
    // stored at Israeli local midnight exactly as legacy rows are; one that the
    // backfill did reach (a Commitment carries its id).
    const { tenantTx } = await import("@/lib/tenant/tenant-tx");
    const accountant = await tenantTx(A.id, (tx) =>
      tx.businessObligation.create({
        data: {
          businessId: A.id, obligeeName: "רואה חשבון", amount: "600", dueAt: new Date("2026-08-31T21:00:00Z"),
          recurrence: "MONTHLY", recurrenceSeriesId: `acc-${runId}`, state: "OPEN",
        },
      }),
    );
    const internetObligation = await tenantTx(A.id, (tx) =>
      tx.businessObligation.create({
        data: {
          businessId: A.id, obligeeName: "אינטרנט", amount: "200", dueAt: new Date("2026-09-05T00:00:00Z"),
          recurrence: "MONTHLY", recurrenceSeriesId: `net-${runId}`, state: "OPEN",
        },
      }),
    );
    const internetCommitment = await tenantTx(A.id, async (tx) => {
      // What migration 20260917090200 wrote for such a row.
      const c = await tx.commitment.create({
        data: {
          businessId: A.id, title: "אינטרנט", payeeNameSnapshot: "אינטרנט", currency: "ILS",
          totalAmount: "200", scheduleKind: "RECURRING", recurrence: "MONTHLY",
          recurrenceSeriesId: `net-${runId}`, status: "ACTIVE", legacyObligationId: internetObligation.id,
        },
      });
      await tx.installment.create({
        data: { businessId: A.id, commitmentId: c.id, sequence: 1, scheduledAmount: "200", currency: "ILS", dueAt: internetObligation.dueAt },
      });
      return c;
    });
    await tenantTx(A.id, (tx) =>
      tx.businessObligationOrientation.create({ data: { businessId: A.id, oriented: true, orientedAt: new Date() } }),
    );

    /* ── business B: much larger numbers, same day ──────────────────────── */
    const bRent = await asB(() =>
      payables.createCommitment({
        businessId: B.id, title: "שכירות B", payeeNameSnapshot: "משכיר B", scheduleKind: "RECURRING",
        recurrence: "MONTHLY", recurringAmount: "100000", firstDueAt: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    await asB(() =>
      payables.recordManualPayment({
        businessId: B.id, commitmentId: bRent.id, amount: "55555",
        paidAt: new Date("2026-09-15T08:00:00Z"), method: "BANK_TRANSFER",
      }),
    );
    const bObligation = await tenantTx(B.id, (tx) =>
      tx.businessObligation.create({
        data: { businessId: B.id, obligeeName: "ספק B", amount: "77777", dueAt: new Date("2026-09-01T00:00:00Z"), recurrence: "MONTHLY", state: "OPEN" },
      }),
    );

    const bIds = new Set([bRent.id, bObligation.id]);

    /* ── 1–3: figures from real rows ─────────────────────────────────────── */
    console.log("\nfigures for business A on 2026-09-15");
    const day = await deriveBusinessCost({ businessId: A.id, date: DATE });
    const byTitle = Object.fromEntries(day.allocatedCost.lines.map((l) => [l.title, l]));
    eq("rent: ₪300.00 of 9,000 (September, 30 days)", byTitle["שכירות"]?.allocatedMinor, 30000);
    eq("insurance: ₪20.00 of 7,300 (2026, 365 days)", byTitle["ביטוח עסק"]?.allocatedMinor, 2000);
    eq("accountant (secretary-only row): ₪20.00, local-midnight due date read as Sep 1", [byTitle["רואה חשבון"]?.allocatedMinor, byTitle["רואה חשבון"]?.period.from, byTitle["רואה חשבון"]?.source], [2000, "2026-09-01", "LEGACY_OBLIGATION"]);
    eq("internet (backfilled): read from the ledger only", [byTitle["אינטרנט"]?.source, byTitle["אינטרנט"]?.commitmentId], ["COMMITMENT", internetCommitment.id]);
    eq("internet counted exactly once", day.allocatedCost.lines.filter((l) => l.title === "אינטרנט").length, 1);
    eq("allocated total = 300 + 20 + 20 + 6.67", day.allocatedCost.totalMinor, 34667);
    eq("baseline total = 295.69 + 19.99 + 19.71 + 6.57", day.baselineDailyCost.totalMinor, 34196);
    eq("loan is debt service (₪80.00), not operating cost", [day.debtService.allocatedMinor, day.debtService.lines[0]?.commitmentId], [8000, loan.id]);
    eq("one-off repair is uncertain, never added", day.uncertain.items.map((u) => [u.commitmentId, u.reason, u.amountMinor]), [[repair.id, "ONE_OFF_COVERAGE_UNKNOWN", 300000]]);
    eq("cash out = the late rent payment, ₪9,000", day.cashOut.totalMinor, 900000);
    eq("cash-out row traces to the rent commitment", day.cashOut.payments[0]?.allocations[0]?.commitmentId, rent.id);
    eq("owner affirmation read from orientation", day.completeness.ownerAffirmedBackboneCaptured, true);
    check("insurance commitment is present", byTitle["ביטוח עסק"]?.commitmentId === insurance.id);
    check("accountant line points at its obligation row", byTitle["רואה חשבון"]?.commitmentId === accountant.id);

    const sep1 = await deriveBusinessCost({ businessId: A.id, date: "2026-09-01" });
    eq("Sep 1: rent still ₪300 — the due date is not the cost date", sep1.allocatedCost.lines.find((l) => l.title === "שכירות")?.allocatedMinor, 30000);
    eq("Sep 1: no cash out — the rent was paid on the 15th", sep1.cashOut.totalMinor, 0);

    /* ── 4a: service-level isolation ─────────────────────────────────────── */
    console.log("\ntenant isolation — service");
    const aIdsInA = [
      ...day.allocatedCost.lines.map((l) => l.commitmentId),
      ...day.debtService.lines.map((l) => l.commitmentId),
      ...day.uncertain.items.map((u) => u.commitmentId),
      ...day.excluded.map((e) => e.commitmentId),
    ];
    check("A's answer references none of B's commitments or obligations", aIdsInA.every((id) => !bIds.has(id)));
    check("A's cash out contains none of B's payments", day.cashOut.payments.every((p) => p.amountMinor !== 5555500));
    const dayB = await deriveBusinessCost({ businessId: B.id, date: DATE });
    eq("B sees only its own rent + obligation", dayB.allocatedCost.lines.map((l) => l.title).sort(), ["ספק B", "שכירות B"]);
    eq("B's cash out is B's payment only", dayB.cashOut.totalMinor, 5555500);

    /* ── 4b: real RLS, as a role that cannot bypass it ───────────────────── */
    console.log("\ntenant isolation — real RLS (NOSUPERUSER NOBYPASSRLS)");
    for (const s of migrationStatements("20260917090100_payables_phase_1a_tenant_rls")) await prisma.$executeRawUnsafe(s);
    for (const s of migrationStatements("20260824210000_d2_p7_wave1_tenant_rls", ["BusinessObligation", "BusinessObligationOrientation"])) {
      await prisma.$executeRawUnsafe(s);
    }
    const roleName = "business_cost_runtime";
    const rolePassword = randomBytes(18).toString("hex");
    await prisma.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
        CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
      END IF; END $$`);
    await prisma.$executeRawUnsafe(`ALTER ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${rolePassword}'`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    for (const t of ENGINE_TABLES) await prisma.$executeRawUnsafe(`GRANT SELECT ON "${t}" TO ${roleName}`);

    const url = new URL(TEST_DB);
    url.username = roleName;
    url.password = rolePassword;
    const child = spawnSync("npx", ["tsx", process.argv[1]], {
      shell: process.platform === "win32",
      encoding: "utf8",
      env: {
        ...process.env,
        BUSINESS_COST_RLS_CHILD: "1",
        DATABASE_URL: url.toString(),
        BC_BUSINESS_A: String(A.id),
        BC_BUSINESS_B: String(B.id),
      },
      timeout: 120_000,
    });
    const match = /@@RESULT@@(.*)@@END@@/s.exec(child.stdout ?? "");
    check("child ran under the runtime role", child.status === 0 && !!match, child.status === 0 ? "" : (child.stderr ?? "").slice(-800));
    if (match) {
      const r = JSON.parse(match[1]);
      eq("runtime role cannot bypass RLS", [r.role.rolsuper, r.role.rolbypassrls], [false, false]);
      eq("no context → zero commitments visible (fails closed)", r.noContextRows, 0);
      eq("under A's context, zero rows of B in every engine table", r.leaked, Object.fromEntries(ENGINE_TABLES.map((t) => [t, 0])));
      check("…and A's own rows ARE visible (the policy is not just denying everything)", r.own.Commitment > 0 && r.own.BusinessObligation > 0 && r.own.Payment > 0);
      eq("engine under RLS: A's allocated total identical", r.dayA.allocatedCost.total, "346.67");
      eq("engine under RLS: A's cash out identical", r.dayA.cashOut.total, "9000.00");
      eq("engine under RLS: B's cash out is B's", r.dayB.cashOut.total, "55555.00");
    }
  } finally {
    await prisma.business.delete({ where: { id: A.id } }).catch((e) => console.error("cleanup A", e));
    await prisma.business.delete({ where: { id: B.id } }).catch((e) => console.error("cleanup B", e));
    await prisma.$disconnect();
  }

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

if (IS_RLS_CHILD) {
  rlsChild().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
