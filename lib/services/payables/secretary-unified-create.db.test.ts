/**
 * One creation path (owner-approved, 25.10.2026) — database proofs for P3 creating a commitment through the
 * secretary with an existing payee and/or a real payment plan. Run against a disposable Postgres:
 *   TEST_DATABASE_URL=postgresql://… npx tsx lib/services/payables/secretary-unified-create.db.test.ts
 *
 * Every fixture goes through production code: the secretary service with the exact deps its route builds (both
 * store modes) and, for the comparison, the payables service the old form calls.
 *
 *   A  backward compatibility — a request without the new fields is exactly what it was
 *   B  a real plan: ONE commitment with N instalments, the payables split (remainder on the last), every cadence
 *   C  parity with the old form, field by field — plans (uneven splits, every cadence), payee links, recurring
 *   D  payee: linked by id, snapshot from the payee, a payee of another business is refused with nothing written
 *   E  learning: exactly ONE OBLIGATION_CHANGED per successful creation; none for a refused one; a series id for
 *      recurring, none for a plan
 *   F  legacy store: a payee or a plan is refused before writing; a plain request still works
 *   G  where it shows: the secretary (one open occurrence), payables (one plan row), history (COMMITMENT_CREATED),
 *      and the business cost
 */
import { randomBytes } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\//.test(TEST_DB)) {
  console.error("TEST_DATABASE_URL must point at a disposable Postgres. Refusing to run.");
  process.exit(2);
}
process.env.DATABASE_URL = TEST_DB;
process.env.AUTH_TOKEN_SECRET ??= "unified-create-db-test-secret-0123456789abcdef";

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

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const payables = await import("@/lib/services/payables/payables.service");
  const { listCommitments } = await import("@/lib/services/payables/payables-read");
  const secretary = await import("@/lib/services/obligations/obligation.service");
  const { obligationServiceDeps } = await import("@/lib/services/obligations/obligations.deps");
  const { deriveBusinessCost } = await import("@/lib/services/business-cost/business-cost.service");

  const runId = randomBytes(4).toString("hex");
  const makeBusiness = (label: string) =>
    prisma.business.create({
      data: {
        name: `UnifiedCreate ${label} ${runId}`,
        users: { create: { email: `uc-${label}-${runId}@example.test`, password: "x", name: `uc ${label}` } },
      },
      include: { users: { select: { id: true } } },
    });
  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const userA = A.users[0].id;

  const setMode = (mode: "ledger" | "legacy") => {
    process.env.SECRETARY_LEDGER_STORE = mode === "ledger" ? "true" : "false";
  };
  // The route's own deps: the tenant transaction and the signed-in owner (OWNER_USER / OWNER_UI on the sensor).
  const viaSecretary = <T>(businessId: number, actor: number, fn: (deps: ReturnType<typeof obligationServiceDeps>) => Promise<T>) =>
    tenantTx(businessId, (tx) => fn(obligationServiceDeps({ tx, actorUserId: actor })));
  const as = <T>(businessId: number, fn: () => Promise<T>) => runWithTenantContext({ businessId }, fn);
  const events = (businessId: number) => prisma.learningEvent.count({ where: { businessId, eventType: "OBLIGATION_CHANGED" } });
  const commitmentsOf = (businessId: number) => prisma.commitment.count({ where: { businessId } });
  const instOf = (commitmentId: number) => prisma.installment.findMany({ where: { commitmentId }, orderBy: { sequence: "asc" } });
  // A commitment as the old form and P3 must both leave it — every field that carries meaning.
  const shape = async (commitmentId: number) => {
    const c = await prisma.commitment.findUniqueOrThrow({ where: { id: commitmentId } });
    const inst = await instOf(commitmentId);
    const audit = await prisma.payablesAuditEvent.findMany({ where: { commitmentId }, orderBy: { id: "asc" }, select: { eventType: true } });
    return {
      title: c.title,
      payeeId: c.payeeId,
      payeeNameSnapshot: c.payeeNameSnapshot,
      currency: c.currency,
      scheduleKind: c.scheduleKind,
      totalAmount: c.totalAmount?.toString() ?? null,
      recurrence: c.recurrence,
      status: c.status,
      installments: inst.map((i) => ({ seq: i.sequence, due: ymd(i.dueAt), amount: i.scheduledAmount.toString(), status: i.status })),
      audit: audit.map((x) => x.eventType),
    };
  };

  const payeeA = await prisma.payee.create({ data: { businessId: A.id, displayName: "מחשבי הדר", kind: "SUPPLIER" } });
  const payeeB = await prisma.payee.create({ data: { businessId: B.id, displayName: "ספק של עסק אחר", kind: "SUPPLIER" } });

  try {
    setMode("ledger");

    /* ── A ─────────────────────────────────────────────────────────────── */
    section("A · a request without the new fields is exactly what it was");
    let ev0 = await events(A.id);
    const oneOff = await viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "טכנאי", amount: "1200", dueAt: D("2026-11-20T00:00:00Z") }, d));
    const rent = await viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "בעל הבית", amount: "9000", dueAt: D("2026-11-01T00:00:00Z"), recurrence: "MONTHLY" }, d));
    const oneOffC = await prisma.commitment.findUniqueOrThrow({ where: { id: oneOff.ledger!.commitmentId } });
    const rentC = await prisma.commitment.findUniqueOrThrow({ where: { id: rent.ledger!.commitmentId } });
    eq("one-off → ONE_OFF, total = amount, no payee, snapshot = name", [oneOffC.scheduleKind, oneOffC.totalAmount?.toString(), oneOffC.payeeId, oneOffC.payeeNameSnapshot], ["ONE_OFF", "1200", null, "טכנאי"]);
    eq("recurring → RECURRING, no total, a series id", [rentC.scheduleKind, rentC.totalAmount, !!rentC.recurrenceSeriesId], ["RECURRING", null, true]);
    eq("one OBLIGATION_CHANGED each (2)", (await events(A.id)) - ev0, 2);
    const oneOffEvent = await prisma.learningEvent.findFirstOrThrow({ where: { businessId: A.id, eventType: "OBLIGATION_CHANGED", entityId: oneOff.id } });
    eq("its payload is unchanged (no new field names)", oneOffEvent.payload, { action: "CREATED", fields: ["amount", "currency", "dueAt", "obligeeName", "recurrence"] });
    eq("actor and source are the owner's", [oneOffEvent.actorType, oneOffEvent.actorUserId, oneOffEvent.source], ["OWNER_USER", userA, "OWNER_UI"]);

    /* ── B ─────────────────────────────────────────────────────────────── */
    section("B · a real plan: one commitment, N instalments, the payables split");
    ev0 = await events(A.id);
    const before = await commitmentsOf(A.id);
    const laptop = await viaSecretary(A.id, userA, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "מחשב נייד", amount: "1000", dueAt: D("2026-11-10T00:00:00Z"), installmentPlan: { count: 3, cadence: "MONTHLY" } }, d),
    );
    eq("exactly ONE commitment was created", (await commitmentsOf(A.id)) - before, 1);
    const laptopShape = await shape(laptop.ledger!.commitmentId);
    eq("INSTALLMENT_PLAN, total 1000, cadence MONTHLY", [laptopShape.scheduleKind, laptopShape.totalAmount, laptopShape.recurrence], ["INSTALLMENT_PLAN", "1000", "MONTHLY"]);
    eq("3 instalments, remainder on the last, monthly dates", laptopShape.installments.map((i) => [i.seq, i.due, i.amount]), [[1, "2026-11-10", "333.33"], [2, "2026-12-10", "333.33"], [3, "2027-01-10", "333.34"]]);
    eq("the secretary item is the FIRST instalment", [laptop.ledger!.installmentId, laptop.amount], [(await instOf(laptop.ledger!.commitmentId))[0].id, "333.33"]);
    const laptopC = await prisma.commitment.findUniqueOrThrow({ where: { id: laptop.ledger!.commitmentId } });
    eq("a plan carries no series id", laptopC.recurrenceSeriesId, null);
    eq("exactly one OBLIGATION_CHANGED", (await events(A.id)) - ev0, 1);
    const laptopEvent = await prisma.learningEvent.findFirstOrThrow({ where: { businessId: A.id, eventType: "OBLIGATION_CHANGED", entityId: laptop.id } });
    check("its fields name the plan", JSON.stringify((laptopEvent.payload as { fields: string[] }).fields).includes("installmentPlan"));

    /* ── C ─────────────────────────────────────────────────────────────── */
    section("C · parity with the old form (payables service), field by field");
    const cases: Array<{ label: string; amount: string; count: number; cadence: "WEEKLY" | "MONTHLY" | "BIMONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "YEARLY"; first: string; payee: boolean }> = [
      { label: "100 / 3 monthly", amount: "100", count: 3, cadence: "MONTHLY", first: "2026-12-31T00:00:00Z", payee: false },
      { label: "1000 / 7 weekly", amount: "1000", count: 7, cadence: "WEEKLY", first: "2026-11-02T00:00:00Z", payee: true },
      { label: "2500.10 / 4 quarterly", amount: "2500.10", count: 4, cadence: "QUARTERLY", first: "2027-01-15T00:00:00Z", payee: true },
      { label: "999.99 / 2 yearly", amount: "999.99", count: 2, cadence: "YEARLY", first: "2026-12-01T00:00:00Z", payee: false },
      { label: "600 / 6 bimonthly", amount: "600", count: 6, cadence: "BIMONTHLY", first: "2026-11-30T00:00:00Z", payee: true },
      { label: "3600 / 12 semiannual", amount: "3600", count: 12, cadence: "SEMIANNUAL", first: "2026-11-05T00:00:00Z", payee: false },
    ];
    for (const k of cases) {
      const title = `השוואה ${k.label}`;
      const viaP3 = await viaSecretary(A.id, userA, (d) =>
        secretary.recognizeObligation(
          { businessId: A.id, obligeeName: title, amount: k.amount, dueAt: D(k.first), payeeId: k.payee ? payeeA.id : null, installmentPlan: { count: k.count, cadence: k.cadence } },
          d,
        ),
      );
      const viaOldForm = await as(A.id, () =>
        payables.createCommitment({
          businessId: A.id,
          actorUserId: userA,
          title,
          payeeId: k.payee ? payeeA.id : null,
          payeeNameSnapshot: k.payee ? null : title,
          scheduleKind: "INSTALLMENT_PLAN",
          totalAmount: k.amount,
          installmentCount: k.count,
          recurrence: k.cadence,
          firstDueAt: D(k.first),
        }),
      );
      eq(`${k.label}: P3 = old form`, await shape(viaP3.ledger!.commitmentId), await shape(viaOldForm.id));
    }
    // A recurring commitment with a payee, the two ways.
    const recP3 = await viaSecretary(A.id, userA, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "תחזוקה", amount: "450", dueAt: D("2026-11-15T00:00:00Z"), recurrence: "MONTHLY", payeeId: payeeA.id }, d),
    );
    const recOld = await as(A.id, () =>
      payables.createCommitment({ businessId: A.id, actorUserId: userA, title: "תחזוקה", payeeId: payeeA.id, scheduleKind: "RECURRING", recurringAmount: "450", recurrence: "MONTHLY", firstDueAt: D("2026-11-15T00:00:00Z") }),
    );
    eq("recurring + payee: P3 = old form", await shape(recP3.ledger!.commitmentId), await shape(recOld.id));
    const recC = await prisma.commitment.findUniqueOrThrow({ where: { id: recP3.ledger!.commitmentId } });
    check("…and P3's recurring keeps its series id (the secretary's, as before)", !!recC.recurrenceSeriesId);

    /* ── D ─────────────────────────────────────────────────────────────── */
    section("D · payee: linked by id, from this business only");
    ev0 = await events(A.id);
    const lease = await viaSecretary(A.id, userA, (d) =>
      secretary.recognizeObligation({ businessId: A.id, obligeeName: "ליסינג", amount: "2400", dueAt: D("2026-12-01T00:00:00Z"), payeeId: payeeA.id }, d),
    );
    const leaseC = await prisma.commitment.findUniqueOrThrow({ where: { id: lease.ledger!.commitmentId } });
    eq("payeeId is the payee; the snapshot is its name", [leaseC.payeeId, leaseC.payeeNameSnapshot], [payeeA.id, "מחשבי הדר"]);
    eq("the secretary shows the payee's name (as for every payables commitment with a payee)", lease.obligeeName, "מחשבי הדר");
    eq("exactly one OBLIGATION_CHANGED", (await events(A.id)) - ev0, 1);
    const evBefore = await events(A.id);
    const cBefore = await commitmentsOf(A.id);
    await rejects(
      "a payee of another business is refused",
      () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "ניסיון", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), payeeId: payeeB.id }, d)),
      "NotFoundError",
    );
    eq("…nothing was written", (await commitmentsOf(A.id)) - cBefore, 0);
    eq("…and no learning event", (await events(A.id)) - evBefore, 0);
    eq("business B saw nothing either", [await commitmentsOf(B.id), await events(B.id)], [0, 0]);

    /* ── E ─────────────────────────────────────────────────────────────── */
    section("E · refused requests: no write, no event");
    const ev1 = await events(A.id);
    const c1 = await commitmentsOf(A.id);
    await rejects("a plan of 1 instalment", () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "x", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), installmentPlan: { count: 1, cadence: "MONTHLY" } }, d)), "ValidationError");
    await rejects("a plan with a recurrence", () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "x", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), recurrence: "MONTHLY", installmentPlan: { count: 3, cadence: "MONTHLY" } }, d)), "ValidationError");
    await rejects("a plan of 121", () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "x", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), installmentPlan: { count: 121, cadence: "MONTHLY" } }, d)), "ValidationError");
    await rejects("a bad payee id", () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "x", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), payeeId: -4 }, d)), "ValidationError");
    eq("no commitment and no event from any of them", [(await commitmentsOf(A.id)) - c1, (await events(A.id)) - ev1], [0, 0]);

    /* ── F ─────────────────────────────────────────────────────────────── */
    section("F · the legacy store refuses a payee or a plan before writing");
    setMode("legacy");
    const evL = await events(A.id);
    const obL = await prisma.businessObligation.count({ where: { businessId: A.id } });
    await rejects("legacy + payee", () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "x", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), payeeId: payeeA.id }, d)), "ValidationError");
    await rejects("legacy + plan", () => viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "x", amount: "10", dueAt: D("2026-12-01T00:00:00Z"), installmentPlan: { count: 3, cadence: "MONTHLY" } }, d)), "ValidationError");
    eq("no BusinessObligation row and no event", [(await prisma.businessObligation.count({ where: { businessId: A.id } })) - obL, (await events(A.id)) - evL], [0, 0]);
    const legacyPlain = await viaSecretary(A.id, userA, (d) => secretary.recognizeObligation({ businessId: A.id, obligeeName: "ישן", amount: "50", dueAt: D("2026-12-01T00:00:00Z") }, d));
    eq("a plain request still works in the legacy store (one row, one event)", [legacyPlain.state, (await prisma.businessObligation.count({ where: { businessId: A.id } })) - obL, (await events(A.id)) - evL], ["OPEN", 1, 1]);
    setMode("ledger");

    /* ── G ─────────────────────────────────────────────────────────────── */
    section("G · where a P3 plan shows");
    const open = await viaSecretary(A.id, userA, (d) => secretary.listObligations(A.id, d));
    const laptopOpen = open.filter((o) => o.ledger?.commitmentId === laptop.ledger!.commitmentId);
    eq("the secretary shows ONE open occurrence of the plan — its first", laptopOpen.map((o) => o.id), [laptop.id]);
    const rows = await as(A.id, () => listCommitments({ businessId: A.id, scope: "all" }));
    const laptopRow = rows.find((r) => r.id === laptop.ledger!.commitmentId);
    eq("payables lists ONE plan row with 3 instalments", [laptopRow?.scheduleKind, laptopRow?.installmentCount, laptopRow?.next?.sequence], ["INSTALLMENT_PLAN", 3, 1]);
    eq("history: COMMITMENT_CREATED (as the old form)", laptopShape.audit, ["COMMITMENT_CREATED"]);
    const cost = await deriveBusinessCost({ businessId: A.id, date: "2026-11-10" });
    check("the business cost reads the plan's instalment on its day", JSON.stringify(cost).includes(String(laptop.ledger!.commitmentId)));
  } finally {
    for (const biz of [A, B]) {
      await prisma.business.delete({ where: { id: biz.id } }).catch((e) => console.error("cleanup", biz.id, e instanceof Error ? e.message : e));
    }
    await prisma.$disconnect();
  }

  console.log(`\nsecretary-unified-create.db: ${total - failures}/${total} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
