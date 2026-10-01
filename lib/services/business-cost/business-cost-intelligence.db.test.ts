/**
 * Business Cost Intelligence — database proofs. Run against a disposable Postgres:
 *   TEST_DATABASE_URL=postgresql://… node_modules/.bin/tsx lib/services/business-cost/business-cost-intelligence.db.test.ts
 *
 * Fixtures go through the code paths production uses: the secretary in LEDGER
 * mode (recognize / snooze / complete, with the deps the routes build), the
 * payables ledger (recordManualPayment, changeRecurringAmountFrom), the real
 * GET /api/business-cost/summary handler with a signed session token, and the
 * repo's own RLS migrations executed under a NOSUPERUSER NOBYPASSRLS role.
 *
 * Proves, through the database:
 *   1. snooze changes no cost figure (workflow only)
 *   2. handled without payment changes no cash figure
 *   3. a payment is cash out on its Israel paid date and moves no allocated cost
 *   4. a recorded amount change preserves history and surfaces as a fact + signal
 *   5. upcoming obligations come from the financial schedule
 *   6. business A's summary is unaffected by business B, through the API too,
 *      and the API answers for the session's business whatever id is sent
 *   7. under real RLS, the same summary; no context sees nothing
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const IS_RLS_CHILD = process.env.BCI_RLS_CHILD === "1";
const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
if (!IS_RLS_CHILD) {
  if (!/^postgres(ql)?:\/\//.test(TEST_DB)) {
    console.error("TEST_DATABASE_URL must point at a disposable Postgres. Refusing to run.");
    process.exit(2);
  }
  process.env.DATABASE_URL = TEST_DB;
}
process.env.AUTH_TOKEN_SECRET ??= "business-cost-intel-db-test-secret-0123456789";
process.env.SECRETARY_LEDGER_STORE = "true";

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

const AS_OF = "2026-09-30";
const TABLES = ["BusinessObligation", "BusinessObligationOrientation", "Commitment", "Installment", "Payee", "Payment", "PaymentAllocation"] as const;

async function rlsChild(): Promise<void> {
  const a = Number(process.env.BCI_A);
  const b = Number(process.env.BCI_B);
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const svc = await import("./business-cost-intelligence.service");
  const noContext: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${t}"`);
    noContext[t] = Number(r[0].n);
  }
  const role = await prisma.$queryRawUnsafe<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
  );
  const sumA = await runWithTenantContext({ businessId: a }, () => svc.deriveBusinessCostSummary({ businessId: a, date: AS_OF }));
  const sumB = await runWithTenantContext({ businessId: b }, () => svc.deriveBusinessCostSummary({ businessId: b, date: AS_OF }));
  process.stdout.write(
    "\n@@RESULT@@" +
      JSON.stringify({ noContext, role: role[0], a: svc.serializeMoney({ ...sumA.summary, range: null, insights: sumA.insights }), bCash: sumB.summary.periods.last30Days.cashOutMinor }) +
      "@@END@@\n",
  );
  await prisma.$disconnect();
}

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
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const payables = await import("@/lib/services/payables/payables.service");
  const secretary = await import("@/lib/services/obligations/obligation.service");
  const { obligationServiceDeps } = await import("@/lib/services/obligations/obligations.deps");
  const svc = await import("./business-cost-intelligence.service");
  const { signAuthToken } = await import("@/lib/auth");
  const { GET } = await import("@/app/api/business-cost/summary/route");
  const { NextRequest } = await import("next/server");

  const runId = randomBytes(4).toString("hex");
  const makeBusiness = (label: string) =>
    prisma.business.create({
      data: { name: `BCI ${label} ${runId}`, users: { create: { email: `bci-${label}-${runId}@example.test`, password: "x", name: `bci ${label}` } } },
      include: { users: { select: { id: true } } },
    });
  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const viaSecretary = <T>(businessId: number, fn: (deps: ReturnType<typeof obligationServiceDeps>) => Promise<T>) =>
    tenantTx(businessId, (tx) => fn(obligationServiceDeps({ tx })));
  const summaryOf = async (businessId: number, date = AS_OF) =>
    runWithTenantContext({ businessId }, () => svc.deriveBusinessCostSummary({ businessId, date }));
  const commitmentOf = async (installmentId: number) => (await prisma.installment.findUniqueOrThrow({ where: { id: installmentId } })).commitmentId;
  const D = (iso: string) => new Date(iso);

  try {
    /* ── A: the secretary in ledger mode ────────────────────────────────── */
    const rent = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "שכירות", amount: "3000", dueAt: D("2026-09-01T06:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    const ins = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "ביטוח", amount: "50", dueAt: D("2026-09-29T06:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    const rentCommitment = await commitmentOf(rent.id);
    const insCommitment = await commitmentOf(ins.id);
    const start = await summaryOf(A.id);

    console.log("\n1 · snooze is workflow only");
    await viaSecretary(A.id, (d) => secretary.snoozeObligation(A.id, rent.id, D("2026-12-01T06:00:00Z"), d));
    const afterSnooze = await summaryOf(A.id);
    eq("every cost figure identical after a snooze", JSON.stringify(afterSnooze.summary), JSON.stringify(start.summary));

    console.log("\n2 · handled without payment");
    await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, rent.id, d));
    const afterHandled = await summaryOf(A.id);
    eq("cash out unchanged (still 0 this month)", afterHandled.summary.periods.thisMonth.cashOutMinor, 0);
    eq("allocated cost of the month unchanged", afterHandled.summary.periods.thisMonth.allocatedMinor, start.summary.periods.thisMonth.allocatedMinor);
    check("the next rent occurrence is now RECORDED in the schedule", afterHandled.summary.upcoming.next7Days.items.some((x) => x.title === "שכירות" && x.dueDate === "2026-10-01" && x.basis === "RECORDED"));

    console.log("\n3 · a real payment");
    await runWithTenantContext({ businessId: A.id }, () =>
      payables.recordManualPayment({ businessId: A.id, commitmentId: insCommitment, installmentIds: [ins.id], amount: "50.00", paidAt: D("2026-09-29T09:00:00Z"), method: "BANK_TRANSFER", idempotencyKey: `secretary:${ins.id}:2026-09-29:50.00` }),
    );
    const afterPay = await summaryOf(A.id);
    eq("yesterday's (Sep 29) cash out is the ₪50 payment", afterPay.summary.periods.yesterday.cashOutMinor, 5000);
    eq("today's (Sep 30) cash out is 0", afterPay.summary.periods.today.cashOutMinor, 0);
    eq("the payment moved no allocated cost", afterPay.summary.periods.thisMonth.allocatedMinor, afterHandled.summary.periods.thisMonth.allocatedMinor);
    eq("baseline: ₪3,000 + ₪50 per month", afterPay.summary.baseline.monthlyMinor, 305000);
    check("the paid occurrence is no longer upcoming; the next one is", !afterPay.summary.upcoming.next30Days.items.some((x) => x.installmentId === ins.id) && afterPay.summary.upcoming.next30Days.items.some((x) => x.title === "ביטוח" && x.dueDate === "2026-10-29"));

    console.log("\n4 · a recorded amount change");
    await runWithTenantContext({ businessId: A.id }, () =>
      payables.changeRecurringAmountFrom({ businessId: A.id, commitmentId: rentCommitment, effectiveFrom: D("2026-10-01T00:00:00Z"), amount: "3300" }),
    );
    const oct15 = await summaryOf(A.id, "2026-10-15");
    // September = the Sep 1 rent occurrence (₪3,000 over Sep 1–30) + the first 2 of the
    // insurance occurrence's 30 days (₪50: 166 + 167 agorot, cumulative floor).
    const sep = await runWithTenantContext({ businessId: A.id }, () => svc.deriveBusinessCostRange({ businessId: A.id, from: "2026-09-01", to: "2026-09-30" }));
    eq("history preserved: September is still ₪3,000 rent + ₪3.33 insurance", sep.allocatedMinor, 300333);
    check("the change is a recorded fact with its evidence", oct15.summary.changes.some((c) => c.kind === "RECURRING_AMOUNT_CHANGED" && c.fromMinor === 300000 && c.toMinor === 330000 && c.effectiveDate === "2026-10-01"));
    eq("baseline now ₪3,300 + ₪50", oct15.summary.baseline.monthlyMinor, 335000);
    eq("the change signal is DETECTED", oct15.summary.signals.recurringChange.state, "DETECTED");
    eq("baseline-change is INSUFFICIENT_HISTORY (the business is 6 weeks old) — no invented insight", [oct15.summary.signals.baselineChange.state, oct15.insights.filter((i) => i.kind === "BASELINE_RECURRING_COST_CHANGED").length], ["INSUFFICIENT_HISTORY", 0]);


    /* ── B, and the API ─────────────────────────────────────────────────── */
    console.log("\n6 · isolation through the service and the API");
    const aBeforeB = await summaryOf(A.id);
    const bRent = await runWithTenantContext({ businessId: B.id }, () =>
      payables.createCommitment({ businessId: B.id, title: "B rent", payeeNameSnapshot: "B", scheduleKind: "RECURRING", recurrence: "MONTHLY", recurringAmount: "9000", firstDueAt: D("2026-09-01T06:00:00Z") }),
    );
    const bInst = await prisma.installment.findFirstOrThrow({ where: { commitmentId: bRent.id } });
    await runWithTenantContext({ businessId: B.id }, () =>
      payables.recordManualPayment({ businessId: B.id, commitmentId: bRent.id, installmentIds: [bInst.id], amount: "9000", paidAt: D("2026-09-29T09:00:00Z"), method: "CASH" }),
    );
    const aAfterB = await summaryOf(A.id);
    eq("A's whole summary is unchanged by B's commitment and payment", JSON.stringify(aAfterB.summary), JSON.stringify(aBeforeB.summary));
    eq("A's cash on Sep 29 is still only its ₪50", aAfterB.summary.periods.yesterday.cashOutMinor, 5000);
    check("no B commitment appears anywhere in A's summary", !JSON.stringify(aAfterB.summary).includes("B rent"));
    eq("B sees its own ₪9,000 only", (await summaryOf(B.id)).summary.periods.yesterday.cashOutMinor, 900000);

    const call = async (token: string | null, query: string, headers: Record<string, string> = {}) => {
      const res = await GET(new NextRequest(`http://localhost/api/business-cost/summary?${query}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }));
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };
    const tokenA = signAuthToken(A.users[0].id);
    const plainA = await call(tokenA, `date=${AS_OF}`);
    eq("A's session → A's figures (decimal strings)", [plainA.status, plainA.body?.periods.yesterday.cashOut, plainA.body?.baseline.monthly], [200, "50.00", "3050.00"]);
    const spoofed = await call(tokenA, `date=${AS_OF}&businessId=${B.id}`, { "x-business-id": String(B.id) });
    eq("A's session naming B → still A's figures, byte for byte", JSON.stringify(spoofed.body), JSON.stringify(plainA.body));
    const ranged = await call(tokenA, `date=${AS_OF}&from=2026-09-29&to=2026-09-29`);
    eq("custom range: cash out on Sep 29", ranged.body?.range.cashOut, "50.00");
    eq("no session → 401", (await call(null, `date=${AS_OF}`)).status, 401);
    eq("malformed date → 400", (await call(tokenA, "date=30-09-2026")).status, 400);
    eq("from without to → 400", (await call(tokenA, "from=2026-09-01")).status, 400);
    check("no profit / margin / break-even field exists in the response", !/profit|margin|breakEven|break_even|revenue/i.test(JSON.stringify(plainA.body)));

    /* ── 7: real RLS ────────────────────────────────────────────────────── */
    console.log("\n7 · real RLS (NOSUPERUSER NOBYPASSRLS)");
    for (const s of migrationStatements("20260917090100_payables_phase_1a_tenant_rls")) await prisma.$executeRawUnsafe(s);
    for (const s of migrationStatements("20260824210000_d2_p7_wave1_tenant_rls", ["BusinessObligation", "BusinessObligationOrientation"])) await prisma.$executeRawUnsafe(s);
    const roleName = "bci_runtime";
    const pw = randomBytes(18).toString("hex");
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
    await prisma.$executeRawUnsafe(`ALTER ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${pw}'`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    for (const t of TABLES) await prisma.$executeRawUnsafe(`GRANT SELECT ON "${t}" TO ${roleName}`);
    const url = new URL(TEST_DB);
    url.username = roleName;
    url.password = pw;
    const child = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), process.argv[1]], {
      encoding: "utf8",
      env: { ...process.env, BCI_RLS_CHILD: "1", DATABASE_URL: url.toString(), BCI_A: String(A.id), BCI_B: String(B.id) },
      timeout: 180_000,
    });
    const match = /@@RESULT@@([\s\S]*)@@END@@/.exec(child.stdout ?? "");
    check("child ran under the runtime role", child.status === 0 && !!match, child.status === 0 ? "" : (child.stderr ?? "").slice(-1500));
    if (match) {
      const r = JSON.parse(match[1]);
      eq("runtime role: not superuser, not BYPASSRLS", [r.role.rolsuper, r.role.rolbypassrls], [false, false]);
      eq("no tenant context → zero rows in every table the summary reads", r.noContext, Object.fromEntries(TABLES.map((t) => [t, 0])));
      eq("under RLS, A's summary is byte-identical to the API's", JSON.stringify(r.a), JSON.stringify(plainA.body));
      eq("under RLS, B's last-30-day cash is B's own", r.bCash, 900000);
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
