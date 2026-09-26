/**
 * Phase 2 — secretary → ledger. Database proofs. Run against a disposable Postgres:
 *   TEST_DATABASE_URL=postgresql://… npx tsx lib/services/payables/secretary-ledger.db.test.ts
 *
 * Every fixture goes through production code: the secretary service with the
 * exact deps its routes build (in BOTH store modes), the payables service, the
 * backfill migration file, this phase's migration file, and the cutover.
 *
 *   A  the secretary in ledger mode writes Commitment/Installment, never
 *      BusinessObligation; its ids are installment ids
 *   B  handled ≠ paid — "טופל" creates no Payment and no installment status;
 *      the ledger still says it is owed; cost is unchanged
 *   C  "שילמת? כן" — the real payment flow, then handled; the next occurrence
 *      is materialised exactly ONCE
 *   D  snooze never changes a due date, a cost or a cash figure
 *   E  release: a series that ran keeps its history and ends; a first
 *      occurrence withdraws the commitment
 *   F  amount change from a date keeps history; paid occurrences refuse it
 *   G  end from a date; paid occurrences after it refuse it
 *   H  settlement materialises the next occurrence, anchored (Jan 31 → Feb 28 → Mar 31)
 *   I  every-2-months / quarterly / half-yearly through the real path
 *   J  cutover: exact dry-run counts, execute, idempotent re-run, conflicts
 *      untouched, no Payment ever synthesized, and the ledger-mode secretary
 *      continues a migrated series inside its own commitment
 *   K  tenant isolation: the ledger store, the workflow table under a
 *      NOSUPERUSER NOBYPASSRLS role, and the same-business trigger
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";

const IS_RLS_CHILD = process.env.SECRETARY_LEDGER_RLS_CHILD === "1";
const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
if (!IS_RLS_CHILD) {
  if (!/^postgres(ql)?:\/\//.test(TEST_DB)) {
    console.error("TEST_DATABASE_URL must point at a disposable Postgres. Refusing to run.");
    process.exit(2);
  }
  process.env.DATABASE_URL = TEST_DB;
}
process.env.AUTH_TOKEN_SECRET ??= "secretary-ledger-db-test-secret-0123456789abcdef";

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
async function rejects(name: string, fn: () => Promise<unknown>, errorName: string): Promise<void> {
  total += 1;
  try {
    await fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — no error thrown`);
  } catch (e) {
    const ok = e instanceof Error && e.constructor.name === errorName;
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — got ${e instanceof Error ? e.constructor.name + ": " + e.message : String(e)}`}`);
  }
}
function section(t: string) {
  console.log(`\n${t}`);
}
const D = (s: string) => new Date(s);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Split a migration into statements, respecting $tag$ … $tag$ bodies. */
export function splitSql(sql: string): string[] {
  const text = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
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

function migration(name: string): string {
  return readFileSync(path.join(process.cwd(), "prisma", "migrations", name, "migration.sql"), "utf8");
}

/* ─────────────────────────── child: real RLS role ────────────────────────── */

async function rlsChild(): Promise<void> {
  const a = Number(process.env.SL_BUSINESS_A);
  const b = Number(process.env.SL_BUSINESS_B);
  const bInstallment = Number(process.env.SL_B_INSTALLMENT);
  const { prisma } = await import("@/lib/prisma");
  const underA = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(a)}, true)`;
      return fn(tx);
    });
  const rows = await underA((tx) => tx.$queryRawUnsafe<Array<{ businessId: number }>>(`SELECT "businessId" FROM "InstallmentWorkflow"`));
  const noCtx = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "InstallmentWorkflow"`);
  let crossTenantRow = "allowed";
  try {
    await underA((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "InstallmentWorkflow" ("installmentId","businessId","followUpAt","updatedAt") VALUES ($1,$2,now(),now())`,
        bInstallment,
        b,
      ),
    );
  } catch (e) {
    const msg = String((e as Error).message);
    crossTenantRow = msg.includes("row-level security") ? "rls" : msg.includes("does not belong") ? "trigger" : "refused";
  }
  let foreignInstallment = "allowed";
  try {
    await underA((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "InstallmentWorkflow" ("installmentId","businessId","followUpAt","updatedAt") VALUES ($1,$2,now(),now())`,
        bInstallment,
        a,
      ),
    );
  } catch (e) {
    foreignInstallment = String((e as Error).message).includes("does not belong") ? "trigger" : "refused";
  }
  let deleteRefused = false;
  try {
    await underA((tx) => tx.$executeRawUnsafe(`DELETE FROM "InstallmentWorkflow"`));
  } catch {
    deleteRefused = true;
  }
  const role = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  process.stdout.write(
    "\n@@RESULT@@" +
      JSON.stringify({
        leaked: rows.filter((r) => r.businessId === b).length,
        own: rows.filter((r) => r.businessId === a).length,
        noContext: Number(noCtx[0].n),
        crossTenantRow,
        foreignInstallment,
        deleteRefused,
        role: role[0],
      }) +
      "@@END@@\n",
  );
  await prisma.$disconnect();
}

/* ────────────────────────────────── parent ───────────────────────────────── */

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const payables = await import("@/lib/services/payables/payables.service");
  const { getCommitmentBalance } = payables;
  const secretary = await import("@/lib/services/obligations/obligation.service");
  const { obligationServiceDeps, secretaryStoreMode } = await import("@/lib/services/obligations/obligations.deps");
  const { deriveBusinessCost } = await import("@/lib/services/business-cost/business-cost.service");
  const { runSecretaryLedgerCutover } = await import("./secretary-ledger-cutover.service");

  // This phase's migration: the table comes from `db push`; its trigger, RLS
  // policy and grants are applied here from the migration file itself.
  for (const s of splitSql(migration("20260927090000_payables_installment_workflow"))) {
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE "InstallmentWorkflow" ADD CONSTRAINT)/.test(s)) continue;
    await prisma.$executeRawUnsafe(s);
  }

  const runId = randomBytes(4).toString("hex");
  const makeBusiness = (label: string) =>
    prisma.business.create({
      data: {
        name: `SecretaryLedger ${label} ${runId}`,
        users: { create: { email: `sl-${label}-${runId}@example.test`, password: "x", name: `sl ${label}` } },
      },
      include: { users: { select: { id: true } } },
    });
  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const C = await makeBusiness("C"); // the cutover business
  const created = [A, B, C];

  const setMode = (mode: "ledger" | "legacy") => {
    process.env.SECRETARY_LEDGER_STORE = mode === "ledger" ? "true" : "false";
  };
  const viaSecretary = <T>(businessId: number, fn: (deps: ReturnType<typeof obligationServiceDeps>) => Promise<T>) =>
    tenantTx(businessId, (tx) => fn(obligationServiceDeps({ tx, actorUserId: undefined })));
  const as = <T>(businessId: number, fn: () => Promise<T>) => runWithTenantContext({ businessId }, fn);
  const paymentsOf = (businessId: number) => prisma.payment.count({ where: { businessId } });
  const installmentsOf = (commitmentId: number) =>
    prisma.installment.findMany({ where: { commitmentId }, orderBy: { sequence: "asc" } });
  const costJson = async (businessId: number, date: string) =>
    JSON.stringify(await deriveBusinessCost({ businessId, date }));

  try {
    section("mode switch");
    process.env.SECRETARY_LEDGER_STORE = "";
    eq("unset → legacy (today's Production)", secretaryStoreMode(), "legacy");
    process.env.SECRETARY_LEDGER_STORE = "yes";
    let threw = false;
    try {
      secretaryStoreMode();
    } catch {
      threw = true;
    }
    check("a typo never silently picks a store", threw);
    setMode("ledger");
    eq("\"true\" → ledger", secretaryStoreMode(), "ledger");

    /* ── A ─────────────────────────────────────────────────────────────── */
    section("A · the secretary writes the ledger, never BusinessObligation");
    const rent = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "בעל הבית", amount: "9000", dueAt: D("2026-09-01T00:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    const repair = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "טכנאי", amount: "1200", dueAt: D("2026-09-20T00:00:00Z") }, d),
    );
    eq("no BusinessObligation row was written", await prisma.businessObligation.count({ where: { businessId: A.id } }), 0);
    const rentC = await prisma.commitment.findUniqueOrThrow({ where: { id: rent.ledger!.commitmentId } });
    eq("recurring → RECURRING commitment, no total, a series id", [rentC.scheduleKind, rentC.totalAmount, !!rentC.recurrenceSeriesId], ["RECURRING", null, true]);
    eq("the obligation id IS the installment id", rent.id, rent.ledger!.installmentId);
    const repairC = await prisma.commitment.findUniqueOrThrow({ where: { id: repair.ledger!.commitmentId } });
    eq("one-off → ONE_OFF with total = amount", [repairC.scheduleKind, repairC.totalAmount?.toString()], ["ONE_OFF", "1200"]);
    eq("both are OPEN in the secretary", [rent.state, repair.state], ["OPEN", "OPEN"]);

    /* ── B ─────────────────────────────────────────────────────────────── */
    section("B · handled ≠ paid");
    const costBefore = await costJson(A.id, "2026-09-15");
    const done = await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, rent.id, d));
    eq("the secretary shows it MET", done.obligation.state, "MET");
    eq("NO Payment was created", await paymentsOf(A.id), 0);
    const rentRows = await installmentsOf(rentC.id);
    eq("the installment status is untouched (SCHEDULED — no 'handled' status exists)", rentRows[0].status, "SCHEDULED");
    const wf = await prisma.installmentWorkflow.findUniqueOrThrow({ where: { installmentId: rent.id } });
    check("handled lives only in the workflow row", wf.handledAt !== null);
    const bal = await as(A.id, () => getCommitmentBalance({ businessId: A.id, commitmentId: rentC.id, now: D("2026-09-15T12:00:00Z") }));
    eq("the ledger still says ₪9,000 is owed on it (OVERDUE, paid 0)", [bal.installments[0].state, bal.installments[0].paid, bal.installments[0].remaining], ["OVERDUE", "0.00", "9000.00"]);
    eq("the next occurrence was materialised, Oct 1", [rentRows.length, ymd(rentRows[1].dueAt)], [2, "2026-10-01"]);
    eq("nextInstance is that occurrence", done.nextInstance?.id, rentRows[1].id);
    eq("cost on Sep 15 is identical before and after 'טופל'", await costJson(A.id, "2026-09-15"), costBefore);

    /* ── C ─────────────────────────────────────────────────────────────── */
    section("C · 'שילמת? כן' — real payment flow, then handled");
    const oct = rentRows[1];
    const cashBefore = (await deriveBusinessCost({ businessId: A.id, date: "2026-10-02" })).cashOut.totalMinor;
    await as(A.id, () =>
      payables.recordManualPayment({ businessId: A.id, commitmentId: rentC.id, amount: "9000", paidAt: D("2026-10-02T09:00:00Z"), method: "BANK_TRANSFER", installmentIds: [oct.id] }),
    );
    const afterPay = await installmentsOf(rentC.id);
    eq("settling the latest occurrence materialised Nov 1", afterPay.map((i) => ymd(i.dueAt)), ["2026-09-01", "2026-10-01", "2026-11-01"]);
    const done2 = await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, oct.id, d));
    eq("'טופל' after paying is a no-op (the ledger already closed it)", done2.nextInstance, null);
    eq("…and did NOT create a second next occurrence", (await installmentsOf(rentC.id)).length, 3);
    eq("exactly one Payment", await paymentsOf(A.id), 1);
    const oct2 = (await deriveBusinessCost({ businessId: A.id, date: "2026-10-02" }));
    eq("cash out on Oct 2 moved by ₪9,000", oct2.cashOut.totalMinor - cashBefore, 900000);
    eq("allocation on Oct 2 is still ₪290.32 (9,000/31), not the payment", oct2.allocatedCost.lines.find((l) => l.commitmentId === rentC.id)?.allocatedMinor, 29032);

    /* ── D ─────────────────────────────────────────────────────────────── */
    section("D · snooze never moves a due date, a cost or cash");
    const nov = (await installmentsOf(rentC.id))[2];
    const novCost = await costJson(A.id, "2026-11-10");
    const follow = new Date(Date.now() + 3 * 86_400_000);
    const snoozed = await viaSecretary(A.id, (d) => secretary.snoozeObligation(A.id, nov.id, follow, d));
    eq("followUpAt is set", snoozed.followUpAt?.getTime(), follow.getTime());
    eq("the due date did not move", ymd((await prisma.installment.findUniqueOrThrow({ where: { id: nov.id } })).dueAt), "2026-11-01");
    eq("cost/cash on Nov 10 byte-identical after snooze", await costJson(A.id, "2026-11-10"), novCost);

    /* ── F ─────────────────────────────────────────────────────────────── */
    section("F · amount change from a date keeps history");
    const sepSum = async (commitmentId: number, from: string, to: string) => {
      let s = 0;
      for (let t = D(from + "T00:00:00Z").getTime(); t <= D(to + "T00:00:00Z").getTime(); t += 86_400_000) {
        const r = await deriveBusinessCost({ businessId: A.id, date: ymd(new Date(t)) });
        s += r.allocatedCost.lines.filter((l) => l.source === "COMMITMENT" && l.commitmentId === commitmentId).reduce((x, l) => x + l.allocatedMinor, 0);
      }
      return s;
    };
    await rejects("a change reaching the PAID October is refused", () =>
      as(A.id, () => payables.changeRecurringAmountFrom({ businessId: A.id, commitmentId: rentC.id, effectiveFrom: D("2026-10-01T00:00:00Z"), amount: "9500" })),
      "PayablesConflictError",
    );
    const change = await as(A.id, () =>
      payables.changeRecurringAmountFrom({ businessId: A.id, commitmentId: rentC.id, effectiveFrom: D("2026-10-15T00:00:00Z"), amount: "9500" }),
    );
    eq("'from Oct 15' starts at the next occurrence, Nov 1", ymd(change.effectiveDueAt), "2026-11-01");
    eq("Σ September unchanged = 9,000", await sepSum(rentC.id, "2026-09-01", "2026-09-30"), 900000);
    eq("Σ October unchanged = 9,000", await sepSum(rentC.id, "2026-10-01", "2026-10-31"), 900000);
    eq("Σ November = 9,500", await sepSum(rentC.id, "2026-11-01", "2026-11-30"), 950000);
    eq("December projects 9,500", (await deriveBusinessCost({ businessId: A.id, date: "2026-12-10" })).allocatedCost.lines.find((l) => l.commitmentId === rentC.id)?.periodAmountMinor, 950000);

    /* ── G ─────────────────────────────────────────────────────────────── */
    section("G · end from a date");
    await rejects("ending before the PAID October is refused", () =>
      as(A.id, () => payables.endCommitment({ businessId: A.id, commitmentId: rentC.id, endsOn: D("2026-09-20T00:00:00Z") })),
      "PayablesConflictError",
    );
    const ended = await as(A.id, () => payables.endCommitment({ businessId: A.id, commitmentId: rentC.id, endsOn: D("2026-11-15T00:00:00Z") }));
    eq("nothing after Nov 15 was due, so nothing cancelled", ended.cancelledInstallmentIds, []);
    eq("Σ Nov 1–15 = the full 9,500 compressed into 15 days", await sepSum(rentC.id, "2026-11-01", "2026-11-15"), 950000);
    eq("Nov 16: nothing", (await deriveBusinessCost({ businessId: A.id, date: "2026-11-16" })).allocatedCost.lines.filter((l) => l.commitmentId === rentC.id).length, 0);
    eq("history untouched: Σ September still 9,000", await sepSum(rentC.id, "2026-09-01", "2026-09-30"), 900000);
    const mat = await as(A.id, () => payables.materialiseNextRecurringInstallment({ businessId: A.id, commitmentId: rentC.id }));
    eq("nothing materialises past the end", mat, null);

    /* ── E ─────────────────────────────────────────────────────────────── */
    section("E · release");
    const phone = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "טלפון", amount: "310", dueAt: D("2026-08-01T00:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    const phoneSep = (await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, phone.id, d))).nextInstance!;
    const released = await viaSecretary(A.id, (d) => secretary.releaseObligation(A.id, phoneSep.id, d));
    eq("releasing a running series → RELEASED in the secretary", released.state, "RELEASED");
    const phoneC = await prisma.commitment.findUniqueOrThrow({ where: { id: phone.ledger!.commitmentId } });
    eq("…it ENDS the day before (Aug 31), status stays ACTIVE", [phoneC.endAt ? ymd(phoneC.endAt) : null, phoneC.status], ["2026-08-31", "ACTIVE"]);
    eq("…August still costs ₪10/day (history kept)", (await deriveBusinessCost({ businessId: A.id, date: "2026-08-10" })).allocatedCost.lines.find((l) => l.commitmentId === phoneC.id)?.allocatedMinor, 1000);
    eq("…September costs nothing", (await deriveBusinessCost({ businessId: A.id, date: "2026-09-10" })).allocatedCost.lines.filter((l) => l.commitmentId === phoneC.id).length, 0);
    const firstRel = await viaSecretary(A.id, (d) => secretary.releaseObligation(A.id, repair.id, d));
    eq("releasing a first occurrence withdraws the whole commitment", [firstRel.state, (await prisma.commitment.findUniqueOrThrow({ where: { id: repairC.id } })).status], ["RELEASED", "RELEASED"]);

    section("edit an occurrence");
    const gym = await viaSecretary(A.id, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "מנוי", amount: "200", dueAt: D("2026-09-05T00:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    const edited = await viaSecretary(A.id, (d) => secretary.updateObligation(A.id, gym.id, { amount: "250" }, d));
    eq("an unpaid occurrence's amount can be corrected", edited.amount, "250");
    await as(A.id, () => payables.recordManualPayment({ businessId: A.id, commitmentId: gym.ledger!.commitmentId, amount: "100", paidAt: D("2026-09-05T09:00:00Z"), method: "CASH" }));
    await rejects("once money is on it, its amount cannot change (409)", () =>
      viaSecretary(A.id, (d) => secretary.updateObligation(A.id, gym.id, { amount: "300" }, d)),
      "ConflictError",
    );

    /* ── H · I ─────────────────────────────────────────────────────────── */
    section("H · settlement materialises the next occurrence, anchored");
    const eom = await as(A.id, () =>
      payables.createCommitment({ businessId: A.id, title: "סוף חודש", payeeNameSnapshot: "x", scheduleKind: "RECURRING", recurrence: "MONTHLY", recurringAmount: "100", firstDueAt: D("2027-01-31T00:00:00Z") }),
    );
    for (let k = 0; k < 2; k += 1) {
      const rows = await installmentsOf(eom.id);
      await as(A.id, () => payables.recordManualPayment({ businessId: A.id, commitmentId: eom.id, amount: "100", paidAt: D("2027-01-31T09:00:00Z"), method: "CASH", installmentIds: [rows[rows.length - 1].id] }));
    }
    eq("Jan 31 → Feb 28 → Mar 31 (the anchor survives February)", (await installmentsOf(eom.id)).map((i) => ymd(i.dueAt)), ["2027-01-31", "2027-02-28", "2027-03-31"]);

    section("I · every 2 months, quarterly, half-yearly");
    for (const [cadence, expect] of [
      ["BIMONTHLY", "2026-11-01"],
      ["QUARTERLY", "2026-12-01"],
      ["SEMIANNUAL", "2027-03-01"],
    ] as const) {
      const o = await viaSecretary(A.id, (d) =>
        secretary.recognizeObligation({ businessId: A.id, obligeeName: `ארנונה ${cadence}`, amount: "4200", dueAt: D("2026-09-01T00:00:00Z"), recurrence: cadence }, d),
      );
      const n = (await viaSecretary(A.id, (d) => secretary.completeObligation(A.id, o.id, d))).nextInstance!;
      eq(`${cadence}: next occurrence ${expect}`, ymd(n.dueAt), expect);
    }
    const arnona = (await deriveBusinessCost({ businessId: A.id, date: "2026-10-20" })).allocatedCost.lines.find((l) => l.title === "ארנונה BIMONTHLY");
    eq("the engine spreads 4,200 over Sep 1 – Oct 31 (61 days)", [arnona?.period.days, arnona?.basis], [61, "RECORDED"]);

    /* ── J · cutover ───────────────────────────────────────────────────── */
    section("J · cutover (legacy writes → backfill → drift → cutover)");
    setMode("legacy");
    const acc = await viaSecretary(C.id, (d) =>
      secretary.recognizeObligation({ businessId: C.id, obligeeName: "רואה חשבון", amount: "600", dueAt: D("2026-07-01T00:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    const accAug = (await viaSecretary(C.id, (d) => secretary.completeObligation(C.id, acc.id, d))).nextInstance!;
    const vat = await viaSecretary(C.id, (d) =>
      secretary.recognizeObligation({ businessId: C.id, obligeeName: "מעמ", amount: "5000", dueAt: D("2026-09-15T00:00:00Z") }, d),
    );
    const oldSupplier = await viaSecretary(C.id, (d) =>
      secretary.recognizeObligation({ businessId: C.id, obligeeName: "ספק ישן", amount: "700", dueAt: D("2026-09-10T00:00:00Z") }, d),
    );
    const paidBeforeCutover = await viaSecretary(C.id, (d) =>
      secretary.recognizeObligation({ businessId: C.id, obligeeName: "חשמל", amount: "800", dueAt: D("2026-09-12T00:00:00Z") }, d),
    );
    // Production ran the backfill once, here.
    for (const s of splitSql(migration("20260917090200_payables_phase_1a_obligation_backfill"))) await prisma.$executeRawUnsafe(s);
    const copiedPaid = await prisma.commitment.findFirstOrThrow({ where: { businessId: C.id, legacyObligationId: paidBeforeCutover.id } });
    await as(C.id, () => payables.recordManualPayment({ businessId: C.id, commitmentId: copiedPaid.id, amount: "800", paidAt: D("2026-09-12T09:00:00Z"), method: "BANK_TRANSFER" }));
    const paymentsBefore = await paymentsOf(C.id);

    // After the backfill the secretary kept writing BusinessObligation:
    const accSep = (await viaSecretary(C.id, (d) => secretary.completeObligation(C.id, accAug.id, d))).nextInstance!; // Aug MET (drift) + Sep new (uncopied)
    await viaSecretary(C.id, (d) => secretary.updateObligation(C.id, vat.id, { amount: "5200", obligeeName: "מע\"מ" }, d)); // amount + rename drift
    await viaSecretary(C.id, (d) => secretary.releaseObligation(C.id, oldSupplier.id, d)); // released drift
    await viaSecretary(C.id, (d) => secretary.snoozeObligation(C.id, accSep.id, new Date(Date.now() + 5 * 86_400_000), d)); // follow-up on an uncopied row
    await viaSecretary(C.id, (d) => secretary.completeObligation(C.id, paidBeforeCutover.id, d)); // MET on a row that carries money → conflict
    const newOne = await viaSecretary(C.id, (d) =>
      secretary.recognizeObligation({ businessId: C.id, obligeeName: "ביטוח", amount: "7300", dueAt: D("2026-10-01T00:00:00Z"), recurrence: "YEARLY" }, d),
    );

    const dry = await runSecretaryLedgerCutover(prisma, { mode: "dry-run", onlyBusinessIds: [C.id] });
    eq("dry run: uncopied = Sep accountant (OPEN, recurring) + insurance (OPEN, recurring)", dry.before.uncopied, { OPEN: 2, MET: 0, RELEASED: 0, recurring: 2 });
    eq("dry run: drift found", dry.before.drift, { metNotSettled: 2, releasedNotReleased: 1, amountChanged: 1, dueAtChanged: 0, renamed: 1, noteChanged: 0, followUpToCopy: 0 });
    eq("dry run: the paid row is a conflict, listed by id", dry.before.conflicts.map((c) => [c.obligationId, c.reason]), [[paidBeforeCutover.id, "installment already carries a payment"]]);
    eq("dry run: migrated recurring rows with a total", dry.before.recurringWithTotalAmount, 2);
    eq("dry run wrote nothing", await prisma.commitment.count({ where: { businessId: C.id, legacyObligationId: newOne.id } }), 0);

    // The read-only SQL preflight an operator can paste must agree with the dry run.
    const preflight = splitSql(readFileSync(path.join(process.cwd(), "scripts", "payables", "secretary-ledger-cutover-preflight.sql"), "utf8"));
    const [sqlCounts] = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(preflight[0]);
    const n = (k: string) => Number(sqlCounts[k]);
    eq(
      "SQL preflight = dry run (uncopied, drift, conflicts, recurring totals)",
      [n("uncopied_open"), n("uncopied_met"), n("uncopied_released"), n("uncopied_recurring"), n("drift_met_not_settled"), n("drift_released_not_released"), n("drift_amount_changed"), n("drift_due_changed"), n("drift_renamed"), n("conflicts"), n("recurring_with_total")],
      [dry.before.uncopied.OPEN, dry.before.uncopied.MET, dry.before.uncopied.RELEASED, dry.before.uncopied.recurring, dry.before.drift.metNotSettled, dry.before.drift.releasedNotReleased, dry.before.drift.amountChanged, dry.before.drift.dueAtChanged, dry.before.drift.renamed, dry.before.conflicts.length, dry.before.recurringWithTotalAmount],
    );
    const conflictRows = await prisma.$queryRawUnsafe<Array<{ obligation_id: number }>>(preflight[1]);
    eq("SQL preflight lists the same conflict by id", conflictRows.map((r) => Number(r.obligation_id)), [paidBeforeCutover.id]);

    const exec = await runSecretaryLedgerCutover(prisma, { mode: "execute", onlyBusinessIds: [C.id] });
    eq("execute: copied 2 · synced 3 (Aug MET, VAT, old supplier — the conflict is skipped) · 2 recurring totals cleared", [exec.applied?.copied, exec.applied?.synced, exec.applied?.totalsCleared], [2, 3, 2]);
    eq("after: nothing uncopied", exec.after?.uncopied, { OPEN: 0, MET: 0, RELEASED: 0, recurring: 0 });
    eq("after: only the conflict's MET remains as drift", exec.after?.drift.metNotSettled, 1);
    eq("after: no recurring totals", exec.after?.recurringWithTotalAmount, 0);
    eq("NO Payment was synthesized by the cutover", await paymentsOf(C.id), paymentsBefore);
    const vatC = await prisma.commitment.findFirstOrThrow({ where: { businessId: C.id, legacyObligationId: vat.id }, include: { installments: true } });
    eq("VAT synced: 5,200 and the new name", [vatC.installments[0].scheduledAmount.toString(), vatC.title, vatC.totalAmount?.toString()], ["5200", "מע\"מ", "5200"]);
    const accSepC = await prisma.commitment.findFirstOrThrow({ where: { businessId: C.id, legacyObligationId: accSep.id }, include: { installments: { include: { workflow: true } } } });
    eq("uncopied recurring row: RECURRING with NO total, and its snooze copied", [accSepC.scheduleKind, accSepC.totalAmount, !!accSepC.installments[0].workflow?.followUpAt], ["RECURRING", null, true]);
    const paidC = await prisma.installment.findFirstOrThrow({ where: { commitmentId: copiedPaid.id } });
    eq("the conflicting paid row was NOT rewritten", paidC.status, "SCHEDULED");
    const again = await runSecretaryLedgerCutover(prisma, { mode: "execute", onlyBusinessIds: [C.id] });
    eq("idempotent: a second run changes nothing", again.applied, { copied: 0, synced: 0, totalsCleared: 0 });
    let series = 0;
    for (const d of ["2026-07-15", "2026-08-15", "2026-09-15"]) {
      const r = await deriveBusinessCost({ businessId: C.id, date: d });
      series += r.allocatedCost.lines.filter((l) => l.title === "רואה חשבון").length;
    }
    eq("after cutover the accountant series is one line per day (Jul/Aug/Sep)", series, 3);
    eq("after cutover the engine's bridge reads nothing", (await deriveBusinessCost({ businessId: C.id, date: "2026-09-15" })).allocatedCost.lines.filter((l) => l.source === "LEGACY_OBLIGATION").length, 0);

    const obligationsBeforeLedger = await prisma.businessObligation.count({ where: { businessId: C.id } });
    setMode("ledger");
    const open = await viaSecretary(C.id, (d) => secretary.listObligations(C.id, d));
    eq("ledger mode lists the migrated work, one open occurrence per commitment", open.map((o) => o.obligeeName).sort(), ["ביטוח", "רואה חשבון", "מע\"מ"].sort());
    const accOpen = open.find((o) => o.obligeeName === "רואה חשבון")!;
    const cont = (await viaSecretary(C.id, (d) => secretary.completeObligation(C.id, accOpen.id, d))).nextInstance!;
    eq("…and continues a migrated series inside its own commitment, Oct 1", [cont.ledger?.commitmentId, ymd(cont.dueAt)], [accSepC.id, "2026-10-01"]);
    eq("…still without writing BusinessObligation", await prisma.businessObligation.count({ where: { businessId: C.id } }), obligationsBeforeLedger);

    /* ── K ─────────────────────────────────────────────────────────────── */
    section("K · tenant isolation");
    const bRent = await viaSecretary(B.id, (d) =>
      secretary.recognizeObligation({ businessId: B.id, obligeeName: "שכירות B", amount: "100000", dueAt: D("2026-09-01T00:00:00Z"), recurrence: "MONTHLY" }, d),
    );
    await viaSecretary(B.id, (d) => secretary.snoozeObligation(B.id, bRent.id, new Date(Date.now() + 86_400_000), d));
    const listA = await viaSecretary(A.id, (d) => secretary.listObligations(A.id, d, { includeClosed: true }));
    check("A's secretary list contains none of B's installments", listA.every((o) => o.id !== bRent.id));
    await rejects("A completing B's installment id → not found", () => viaSecretary(A.id, (d) => secretary.completeObligation(A.id, bRent.id, d)), "NotFoundError");
    await rejects("A snoozing B's installment id → not found", () => viaSecretary(A.id, (d) => secretary.snoozeObligation(A.id, bRent.id, new Date(Date.now() + 86_400_000), d)), "NotFoundError");
    await rejects("A changing B's amount → not found", () => as(A.id, () => payables.changeRecurringAmountFrom({ businessId: A.id, commitmentId: bRent.ledger!.commitmentId, effectiveFrom: D("2026-10-01T00:00:00Z"), amount: "1" })), "PayablesNotFoundError");
    await rejects("A ending B's commitment → not found", () => as(A.id, () => payables.endCommitment({ businessId: A.id, commitmentId: bRent.ledger!.commitmentId, endsOn: D("2026-10-01T00:00:00Z") })), "PayablesNotFoundError");
    let triggerFired = false;
    try {
      await prisma.installmentWorkflow.create({ data: { installmentId: bRent.id, businessId: A.id } });
    } catch (e) {
      triggerFired = String((e as Error).message).includes("does not belong");
    }
    check("same-business trigger: a workflow row for B's installment under A's id is refused (even as owner)", triggerFired);

    const installed = await prisma.$queryRawUnsafe<Array<{ rls: boolean; forced: boolean; policies: bigint }>>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname
                 AND p.qual LIKE '%app.current_business_id%' AND p.with_check LIKE '%app.current_business_id%')::bigint AS policies
         FROM pg_class c WHERE c.relname = 'InstallmentWorkflow'`,
    );
    eq("InstallmentWorkflow: RLS enabled + FORCED + tenant policy (from the migration)", [installed[0]?.rls, installed[0]?.forced, Number(installed[0]?.policies)], [true, true, 1]);

    const roleName = "secretary_ledger_runtime";
    const pw = randomBytes(18).toString("hex");
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF; END $$`);
    await prisma.$executeRawUnsafe(`ALTER ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${pw}'`);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "InstallmentWorkflow" TO ${roleName}`);
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "Installment" TO ${roleName}`);
    // The migration's own grants model: no DELETE for the application role.
    await prisma.$executeRawUnsafe(`REVOKE DELETE, TRUNCATE ON "InstallmentWorkflow" FROM ${roleName}`);
    for (const s of splitSql(migration("20260917090100_payables_phase_1a_tenant_rls"))) await prisma.$executeRawUnsafe(s);
    const url = new URL(TEST_DB);
    url.username = roleName;
    url.password = pw;
    const child = spawnSync("npx", ["tsx", process.argv[1]], {
      shell: process.platform === "win32",
      encoding: "utf8",
      env: {
        ...process.env,
        SECRETARY_LEDGER_RLS_CHILD: "1",
        DATABASE_URL: url.toString(),
        SL_BUSINESS_A: String(A.id),
        SL_BUSINESS_B: String(B.id),
        SL_B_INSTALLMENT: String(bRent.id),
      },
      timeout: 180_000,
    });
    const m = /@@RESULT@@(.*)@@END@@/s.exec(child.stdout ?? "");
    check("child ran as the runtime role", child.status === 0 && !!m, (child.stderr ?? "").slice(-1200));
    if (m) {
      const r = JSON.parse(m[1]);
      eq("role is neither superuser nor BYPASSRLS", [r.role.rolsuper, r.role.rolbypassrls], [false, false]);
      eq("no context → zero workflow rows", r.noContext, 0);
      eq("under A: zero of B's workflow rows", r.leaked, 0);
      check("under A: A's own workflow rows are visible", r.own > 0, String(r.own));
      // Postgres runs BEFORE ROW triggers before RLS WITH CHECK, and under A's
      // context B's installment is invisible to the trigger — so the database
      // refuses at the trigger first. Either layer refusing is the property.
      check("writing a B-owned workflow row under A → refused (trigger, then RLS)", r.crossTenantRow === "trigger" || r.crossTenantRow === "rls", r.crossTenantRow);
      eq("pointing A's workflow at B's installment → refused (B's installment is invisible to A)", r.foreignInstallment, "trigger");
      check("the application role cannot DELETE workflow rows", r.deleteRefused);
    }
  } finally {
    for (const b of created) await prisma.business.delete({ where: { id: b.id } }).catch((e) => console.error("cleanup", b.id, e));
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
