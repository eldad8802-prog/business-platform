/**
 * Daily Business Cost — database proofs. Run against a disposable Postgres:
 *   TEST_DATABASE_URL=postgresql://… npx tsx lib/services/business-cost/business-cost.db.test.ts
 *
 * Every fixture is written through the code path production uses — nothing here
 * hand-builds a row the engine then reads back, except the one per-occurrence
 * amount change the ledger has no operation for yet (marked below):
 *   payables ledger     createPayee / createCommitment / recordManualPayment /
 *                       materialiseNextRecurringInstallment
 *   secretary           recognizeObligation / completeObligation / markOriented,
 *                       with the same deps the /api/obligations routes build
 *   legacy backfill     migration 20260917090200 itself, executed
 *   security            the repo's RLS migration files themselves, executed
 *   API                 the real GET handler, with a real signed session token
 *
 * What only a database can prove:
 *   1. Monthly allocation through the real DB path.
 *   2. A Payment moves cash out and nothing else.
 *   3. A secretary series migrated by the real backfill, then rolled forward
 *      again by the secretary AFTER the backfill (production's actual state),
 *      is counted once per day — never once per row.
 *   4. Business A cannot affect or appear in business B's result.
 *   5. Under a NOSUPERUSER NOBYPASSRLS role — the superuser test connection
 *      bypasses RLS, so without this role the policies are never exercised.
 *   6. The policies are really installed (pg_class / pg_policies), not assumed.
 *   7. 28/29/30/31-day months and historical per-occurrence amounts, via the DB.
 *   8. The API answers for the SESSION's business, whatever id the caller sends.
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
  "BusinessObligation",
  "BusinessObligationOrientation",
  "Commitment",
  "Installment",
  "Payee",
  "Payment",
  "PaymentAllocation",
] as const;

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

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
  const noContext: Record<string, number> = {};
  for (const table of ENGINE_TABLES) {
    const r = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${table}"`);
    noContext[table] = Number(r[0].n);
  }
  // A write naming B under A's context must be refused by WITH CHECK.
  let crossWriteRefused = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(a)}, true)`;
      await tx.$executeRawUnsafe(
        `INSERT INTO "BusinessObligation" ("businessId","obligeeName","amount","dueAt","updatedAt") VALUES ($1,'x',1,now(),now())`,
        b,
      );
    });
  } catch {
    crossWriteRefused = true;
  }
  const role = await prisma.$queryRawUnsafe<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
  );

  const dayA = serializeBusinessCostDay(await deriveBusinessCost({ businessId: a, date: DATE }));
  const dayB = serializeBusinessCostDay(await deriveBusinessCost({ businessId: b, date: DATE }));
  process.stdout.write(
    "\n@@RESULT@@" +
      JSON.stringify({ leaked, own, noContext, crossWriteRefused, role: role[0], dayA, dayB }) +
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
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const payables = await import("@/lib/services/payables/payables.service");
  const secretary = await import("@/lib/services/obligations/obligation.service");
  const { obligationServiceDeps } = await import("@/lib/services/obligations/obligations.deps");
  const { deriveBusinessCost } = await import("./business-cost.service");
  const { dailyShareMinor } = await import("./business-cost-core");
  const { signAuthToken } = await import("@/lib/auth");
  const { GET } = await import("@/app/api/business-cost/route");
  const { NextRequest } = await import("next/server");

  const runId = randomBytes(4).toString("hex");
  async function makeBusiness(label: string) {
    return prisma.business.create({
      data: {
        name: `BusinessCost ${label} ${runId}`,
        users: {
          create: { email: `bc-${label}-${runId}@example.test`, password: "x", name: `bc ${label}` },
        },
      },
      include: { users: { select: { id: true } } },
    });
  }

  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A.id }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B.id }, fn);
  // Exactly what the /api/obligations routes do.
  const viaSecretary = <T>(businessId: number, fn: (deps: ReturnType<typeof obligationServiceDeps>) => Promise<T>) =>
    tenantTx(businessId, (tx) => fn(obligationServiceDeps({ tx })));

  try {
    /* ── A: the secretary, BEFORE the backfill ──────────────────────────── */
    // Accountant, 600 monthly from July; July and August handled by the owner.
    const julAcc = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation(
        { businessId: A.id, obligeeName: "רואה חשבון", amount: "600", dueAt: new Date("2026-07-01T00:00:00Z"), recurrence: "MONTHLY" },
        d,
      ),
    );
    const augAcc = (await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, julAcc.id, d))).nextInstance!;
    const sepAcc = (await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, augAcc.id, d))).nextInstance!;
    // B's secretary row, also pre-backfill.
    await viaSecretary(B.id, (d) =>
      secretary.recognizeObligation(
        { businessId: B.id, obligeeName: "ספק B", amount: "77777", dueAt: new Date("2026-09-01T00:00:00Z"), recurrence: "MONTHLY" },
        d,
      ),
    );

    /* ── the real backfill migration, as Production ran it ──────────────── */
    for (const s of migrationStatements("20260917090200_payables_phase_1a_obligation_backfill")) {
      await prisma.$executeRawUnsafe(s);
    }
    const migrated = await prisma.commitment.findMany({
      where: { businessId: A.id, legacyObligationId: { not: null } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, scheduleKind: true, totalAmount: true },
    });
    eq("backfill: three accountant rows became three RECURRING commitments", migrated.map((c) => [c.scheduleKind, c.status]), [
      ["RECURRING", "CLOSED"],
      ["RECURRING", "CLOSED"],
      ["RECURRING", "ACTIVE"],
    ]);
    check(
      "backfill: migrated RECURRING rows carry a totalAmount (the audit finding) — the engine must ignore it",
      migrated.every((c) => c.totalAmount !== null),
    );

    /* ── A: the secretary AFTER the backfill (production's current state) ─ */
    // September handled → October exists ONLY in BusinessObligation; the
    // September Commitment still says ACTIVE, because nothing syncs.
    const octAcc = (await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, sepAcc.id, d))).nextInstance!;
    // A post-backfill row saved at Israeli local midnight (21:00Z the day before).
    await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation(
        { businessId: A.id, obligeeName: "ניקיון", amount: "300", dueAt: new Date("2026-08-31T21:00:00Z"), recurrence: "MONTHLY" },
        d,
      ),
    );
    await viaSecretary(A.id, (d) => secretary.markOriented(A.id, d));

    /* ── A: the payables ledger ──────────────────────────────────────────── */
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
    // The rent is paid LATE, on the 15th at 10:00 Israel time.
    await asA(() =>
      payables.recordManualPayment({
        businessId: A.id, commitmentId: rent.id, amount: "9000",
        paidAt: new Date("2026-09-15T07:00:00Z"), method: "BANK_TRANSFER",
      }),
    );

    /* ── B: much larger numbers, same day ───────────────────────────────── */
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
    const bCommitmentIds = new Set((await prisma.commitment.findMany({ where: { businessId: B.id }, select: { id: true } })).map((c) => c.id));
    const bObligationIds = new Set((await prisma.businessObligation.findMany({ where: { businessId: B.id }, select: { id: true } })).map((o) => o.id));
    const bPaymentIds = new Set((await prisma.payment.findMany({ where: { businessId: B.id }, select: { id: true } })).map((p) => p.id));

    /* ── 1: figures from real rows ──────────────────────────────────────── */
    console.log("\n1 · business A on 2026-09-15 through the real DB path");
    const day = await deriveBusinessCost({ businessId: A.id, date: DATE });
    const byTitle = Object.fromEntries(day.allocatedCost.lines.map((l) => [l.title, l]));
    eq("rent: ₪300.00 of 9,000 (September, 30 days)", byTitle["שכירות"]?.allocatedMinor, 30000);
    eq("insurance: ₪20.00 of 7,300 (2026, 365 days)", byTitle["ביטוח עסק"]?.allocatedMinor, 2000);
    eq("cleaning (post-backfill, stored 21:00Z Aug 31) is read as due Sep 1", [byTitle["ניקיון"]?.period.from, byTitle["ניקיון"]?.allocatedMinor, byTitle["ניקיון"]?.source], ["2026-09-01", 1000, "LEGACY_OBLIGATION"]);
    eq("allocated total = 300 + 20 + 20 + 10", day.allocatedCost.totalMinor, 35000);
    eq("baseline total = 295.69 + 19.99 + 19.71 + 9.86", day.baselineDailyCost.totalMinor, 34525);
    eq("loan is debt service (₪80.00), not operating cost", [day.debtService.allocatedMinor, day.debtService.lines[0]?.commitmentId], [8000, loan.id]);
    eq("one-off repair is uncertain, never added", day.uncertain.items.map((u) => [u.commitmentId, u.reason, u.amountMinor]), [[repair.id, "ONE_OFF_COVERAGE_UNKNOWN", 300000]]);
    eq("owner affirmation read from orientation (markOriented)", day.completeness.ownerAffirmedBackboneCaptured, true);
    check("insurance line points at its commitment", byTitle["ביטוח עסק"]?.commitmentId === insurance.id);

    /* ── 2: payment vs allocation ───────────────────────────────────────── */
    console.log("\n2 · payment vs allocation");
    eq("cash out on Sep 15 = the late rent payment, ₪9,000", day.cashOut.totalMinor, 900000);
    eq("cash-out row traces to the rent commitment", day.cashOut.payments[0]?.allocations[0]?.commitmentId, rent.id);
    const rentByDay: string[] = [];
    for (const d of eachDay("2026-09-01", "2026-09-30")) {
      const r = await deriveBusinessCost({ businessId: A.id, date: d });
      rentByDay.push(`${d}:${r.allocatedCost.lines.find((l) => l.title === "שכירות")?.allocatedMinor}/${r.cashOut.totalMinor}`);
    }
    check(
      "every September day allocates ₪300 rent; cash out is ₪9,000 on the 15th only",
      rentByDay.every((s) => (s.startsWith("2026-09-15") ? s.endsWith(":30000/900000") : s.endsWith(":30000/0"))),
      rentByDay.filter((s) => !s.startsWith("2026-09-15") && !s.endsWith(":30000/0")).join(" "),
    );

    /* ── 3: migrated secretary series ───────────────────────────────────── */
    console.log("\n3 · migrated secretary series (real backfill, then post-backfill roll-forward)");
    const accLines = async (d: string) =>
      (await deriveBusinessCost({ businessId: A.id, date: d })).allocatedCost.lines.filter((l) => l.title === "רואה חשבון");
    const jul = await accLines("2026-07-15");
    const sep = await accLines("2026-09-15");
    const oct = await accLines("2026-10-15");
    eq("July: one line, from the migrated ledger row", [jul.length, jul[0]?.source, jul[0]?.allocatedMinor], [1, "COMMITMENT", dailyShareMinor(60000, 31, 14)]);
    eq("September: one line, from the ledger (not also from its obligation)", [sep.length, sep[0]?.source, sep[0]?.allocatedMinor], [1, "COMMITMENT", 2000]);
    eq("October: one line, from the post-backfill obligation via the bridge", [oct.length, oct[0]?.source, oct[0]?.commitmentId, oct[0]?.basis], [1, "LEGACY_OBLIGATION", octAcc.id, "RECORDED"]);
    let series = 0;
    for (const d of eachDay("2026-07-01", "2026-10-31")) {
      const r = await deriveBusinessCost({ businessId: A.id, date: d });
      series += r.allocatedCost.lines.filter((l) => l.title === "רואה חשבון").reduce((s, l) => s + l.allocatedMinor, 0);
    }
    eq("Σ Jul–Oct = exactly 4 × 600, never once per row", series, 240000);
    check(
      "the migrated totalAmount never reaches a line (period amounts are installment amounts)",
      jul[0]?.periodAmountMinor === 60000 && sep[0]?.periodAmountMinor === 60000,
    );

    /* ── 7: month lengths and historical amounts through the DB ─────────── */
    console.log("\n7 · month lengths, materialisation and historical amounts");
    await asA(() => payables.materialiseNextRecurringInstallment({ businessId: A.id, commitmentId: rent.id }));
    const sumFor = async (commitmentId: number, from: string, to: string) => {
      let s = 0;
      for (const d of eachDay(from, to)) {
        const r = await deriveBusinessCost({ businessId: A.id, date: d });
        s += r.allocatedCost.lines.filter((l) => l.source === "COMMITMENT" && l.commitmentId === commitmentId).reduce((x, l) => x + l.allocatedMinor, 0);
      }
      return s;
    };
    eq("Σ Sep 2026 (30 days) = 9,000", await sumFor(rent.id, "2026-09-01", "2026-09-30"), 900000);
    eq("Σ Oct 2026 (31 days, materialised) = 9,000", await sumFor(rent.id, "2026-10-01", "2026-10-31"), 900000);
    eq(
      "October is now RECORDED (the real materialiser ran)",
      (await deriveBusinessCost({ businessId: A.id, date: "2026-10-15" })).allocatedCost.lines.find((l) => l.source === "COMMITMENT" && l.commitmentId === rent.id)?.basis,
      "RECORDED",
    );
    eq("Σ Feb 2027 (28 days, projected) = 9,000", await sumFor(rent.id, "2027-02-01", "2027-02-28"), 900000);
    eq("Σ Feb 2028 (29 days, leap) = 9,000", await sumFor(rent.id, "2028-02-01", "2028-02-29"), 900000);

    // The ledger has no amount-change operation yet (Phase 2). A changed amount
    // can only ever be stored as an installment carrying it — written here
    // directly, and the ONLY hand-written ledger row in this suite.
    const storage = await asA(() =>
      payables.createCommitment({
        businessId: A.id, title: "מחסן", payeeNameSnapshot: "מחסנים", scheduleKind: "RECURRING",
        recurrence: "MONTHLY", recurringAmount: "3000", firstDueAt: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    await tenantTx(A.id, (tx) =>
      tx.installment.create({
        data: { businessId: A.id, commitmentId: storage.id, sequence: 2, scheduledAmount: "3500", currency: "ILS", dueAt: new Date("2026-10-01T00:00:00Z") },
      }),
    );
    eq("history: Σ September stays 3,000 after October became 3,500", await sumFor(storage.id, "2026-09-01", "2026-09-30"), 300000);
    eq("Σ October = 3,500", await sumFor(storage.id, "2026-10-01", "2026-10-31"), 350000);
    const nov = (await deriveBusinessCost({ businessId: A.id, date: "2026-11-10" })).allocatedCost.lines.find((l) => l.source === "COMMITMENT" && l.commitmentId === storage.id);
    eq("November projects the new amount", [nov?.basis, nov?.periodAmountMinor], ["PROJECTED", 350000]);

    /* ── 4: service-level isolation ──────────────────────────────────────── */
    console.log("\n4 · tenant isolation — service");
    const dayA = await deriveBusinessCost({ businessId: A.id, date: DATE });
    const idsInA = [
      ...dayA.allocatedCost.lines.map((l) => [l.source, l.commitmentId] as const),
      ...dayA.debtService.lines.map((l) => [l.source, l.commitmentId] as const),
      ...dayA.uncertain.items.map((u) => [u.source, u.commitmentId] as const),
      ...dayA.excluded.map((e) => [e.source, e.commitmentId] as const),
    ];
    check(
      "A's answer references none of B's commitments or obligations",
      idsInA.every(([src, id]) => (src === "COMMITMENT" ? !bCommitmentIds.has(id) : !bObligationIds.has(id))),
    );
    check("A's cash out contains none of B's payments", dayA.cashOut.payments.every((p) => !bPaymentIds.has(p.paymentId)));
    const dayB = await deriveBusinessCost({ businessId: B.id, date: DATE });
    eq("B sees only its own rent + its migrated obligation", dayB.allocatedCost.lines.map((l) => l.title).sort(), ["ספק B", "שכירות B"]);
    eq("B's cash out is B's payment only", dayB.cashOut.totalMinor, 5555500);
    eq("A = its own lines only (35,000 + storage 10,000), unmoved by B", dayA.allocatedCost.totalMinor, 45000);

    /* ── 8: the API answers for the session's business only ─────────────── */
    console.log("\n8 · API scoping");
    const call = async (token: string | null, query: string, headers: Record<string, string> = {}) => {
      const res = await GET(
        new NextRequest(`http://localhost/api/business-cost?${query}`, {
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        }),
      );
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };
    const tokenA = signAuthToken(A.users[0].id);
    const tokenB = signAuthToken(B.users[0].id);
    const plainA = await call(tokenA, `date=${DATE}`);
    eq("A's session → A's figures", [plainA.status, plainA.body?.allocatedCost.total, plainA.body?.cashOut.total], [200, "450.00", "9000.00"]);
    const spoofed = await call(tokenA, `date=${DATE}&businessId=${B.id}`, {
      "x-business-id": String(B.id),
      "x-tenant-id": String(B.id),
    });
    eq("A's session naming B (query + headers) → still A's figures, byte for byte", JSON.stringify(spoofed.body), JSON.stringify(plainA.body));
    const plainB = await call(tokenB, `date=${DATE}&businessId=${A.id}`);
    eq("B's session naming A → B's figures", [plainB.status, plainB.body?.cashOut.total], [200, "55555.00"]);
    eq("no session → 401", (await call(null, `date=${DATE}`)).status, 401);
    eq("malformed date → 400", (await call(tokenA, "date=15-09-2026")).status, 400);
    eq("impossible date → 400", (await call(tokenA, "date=2027-02-29")).status, 400);

    /* ── 5 · 6: real RLS, as a role that cannot bypass it ────────────────── */
    console.log("\n5–6 · tenant isolation — real RLS (NOSUPERUSER NOBYPASSRLS)");
    for (const s of migrationStatements("20260917090100_payables_phase_1a_tenant_rls")) await prisma.$executeRawUnsafe(s);
    for (const s of migrationStatements("20260824210000_d2_p7_wave1_tenant_rls", ["BusinessObligation", "BusinessObligationOrientation"])) {
      await prisma.$executeRawUnsafe(s);
    }
    const installed = await prisma.$queryRawUnsafe<Array<{ relname: string; rls: boolean; forced: boolean; policies: bigint }>>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname
                 AND p.qual LIKE '%app.current_business_id%' AND p.with_check LIKE '%app.current_business_id%')::bigint AS policies
         FROM pg_class c WHERE c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [...ENGINE_TABLES],
    );
    eq(
      "every engine table: RLS enabled + FORCED + a tenant policy on USING and WITH CHECK",
      installed.map((r) => [r.relname, r.rls, r.forced, Number(r.policies) >= 1]),
      [...ENGINE_TABLES].map((t) => [t, true, true, true]),
    );

    const roleName = "business_cost_runtime";
    const rolePassword = randomBytes(18).toString("hex");
    await prisma.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
        CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
      END IF; END $$`);
    await prisma.$executeRawUnsafe(`ALTER ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${rolePassword}'`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    for (const t of ENGINE_TABLES) await prisma.$executeRawUnsafe(`GRANT SELECT ON "${t}" TO ${roleName}`);
    // INSERT on one table, so the WITH CHECK half is what refuses the cross-
    // tenant write — not a missing privilege masquerading as isolation.
    await prisma.$executeRawUnsafe(`GRANT INSERT ON "BusinessObligation" TO ${roleName}`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`);

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
      timeout: 180_000,
    });
    const match = /@@RESULT@@(.*)@@END@@/s.exec(child.stdout ?? "");
    check("child ran under the runtime role", child.status === 0 && !!match, child.status === 0 ? "" : (child.stderr ?? "").slice(-1500));
    if (match) {
      const r = JSON.parse(match[1]);
      eq("runtime role is neither superuser nor BYPASSRLS", [r.role.rolsuper, r.role.rolbypassrls], [false, false]);
      eq("no tenant context → zero rows in every engine table (fails closed)", r.noContext, Object.fromEntries(ENGINE_TABLES.map((t) => [t, 0])));
      eq("under A's context → zero rows of B in every engine table", r.leaked, Object.fromEntries(ENGINE_TABLES.map((t) => [t, 0])));
      check("…while A's own rows ARE visible in every engine table", ENGINE_TABLES.every((t) => r.own[t] > 0), JSON.stringify(r.own));
      check("WITH CHECK: writing a B row under A's context is refused", r.crossWriteRefused === true);
      eq("engine under RLS: A's result identical to the API result", JSON.stringify(r.dayA), JSON.stringify(plainA.body));
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
