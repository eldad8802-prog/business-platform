/**
 * Status sweep performance harness (docs/notifications/sweep-performance.md). LAB ONLY (kept under .nte/, outside the
 * erasure contract's app/lib/scripts write-site scan: it seeds synthetic fixtures with the owner client) — synthetic data, never a
 * Production / Preview database.
 *
 *   seed:  OWNER_URL=… npx tsx .nte/sweep-perf.ts seed <N> <tag>
 *   run:   DATABASE_URL=<runtime> OWNER_URL=… npx tsx .nte/sweep-perf.ts run <tag> [passes]
 *          (SWEEP_PERF_MODULE=<module path> measures another revision of the sweep, e.g. the previous head copied aside)
 *
 * `seed` creates N engine-ON businesses (tag in the name) with a realistic, modest mix of the facts every sweep scope
 * reads: billing documents (waiting for review, PDF failed, issued), a supplier draft, leads (one overdue
 * follow-up), stock items with a critical alert, documents (review queue, one failed processing), obligations (due
 * today, overdue, later), payment requests (failed, pending), appointments (in 45 min, tomorrow, cancelled).
 *
 * `run` sweeps exactly those businesses (opts.businessIds, the same per-business path the live walk takes) and
 * measures, per pass:
 *   - queries        every statement Prisma sends (Prisma `query` events on the client lib/prisma picks up —
 *                    globalThis.prisma is set BEFORE the sweep module loads), including BEGIN / COMMIT;
 *   - transactions   BEGIN statements among them (every interactive / tenant transaction Prisma opens);
 *   - peak open tx   the maximum number of the runtime's backends of the lab database inside a transaction at the
 *                    same moment, and the peak connection count (pg_stat_activity sampled every ~5 ms as SAMPLER_URL,
 *                    a pg_read_all_stats member — another role's xact_start is hidden from the owner);
 *   - wall time      of the pass.
 * Pass 1 is the first pass over fresh data (writes); later passes are the steady state (cooldown: refresh only).
 * Prints one JSON line per pass. No business id, no text.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const DAY = 86_400_000;

async function seed(n: number, tag: string): Promise<void> {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  for (const [key, def] of [
    ["notifications_engine", false], ["billing", true], ["inventory", true], ["documents", true], ["appointments", true],
  ] as const) {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
      VALUES ($1, $1, 'lab', 'lab', $2, true) ON CONFLICT ("key") DO NOTHING`, key, def);
  }
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms);
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) ids.push((await owner.business.create({ data: { name: `${tag}-${i}` }, select: { id: true } })).id);
  const each = <T>(f: (b: number, i: number) => T[]) => ids.flatMap((b, i) => f(b, i));
  await owner.businessFeatureAccess.createMany({
    data: each((b) => ["notifications_engine", "billing", "inventory", "documents", "appointments"].map((featureKey) => ({ businessId: b, featureKey, state: "ENABLED" as const }))),
  });
  await owner.user.createMany({ data: each((b, i) => [{ email: `perf-${tag}-${i}@nte6b.lab`, password: "x", businessId: b }]) });
  await owner.billingDocument.createMany({
    data: each((b) => [
      { businessId: b, documentType: "TAX_INVOICE", status: "PENDING_REVIEW" },
      { businessId: b, documentType: "TAX_INVOICE", status: "DRAFT", pdfRenderStatus: "FAILED" },
      { businessId: b, documentType: "TAX_INVOICE", status: "ISSUED", pdfRenderStatus: "RENDERED" },
    ]) as never,
  });
  await owner.supplierPurchaseDraft.createMany({ data: each((b) => [{ businessId: b, status: "PENDING_REVIEW", supplierName: "ספק" }]) as never });
  await owner.lead.createMany({
    data: each((b) => [
      { businessId: b, status: "OPEN", nextFollowUpAt: at(-3 * DAY), firstHandledAt: at(-10 * DAY), createdAt: at(-20 * DAY) },
      { businessId: b, status: "OPEN", nextFollowUpAt: at(5 * DAY), firstHandledAt: at(-2 * DAY), createdAt: at(-4 * DAY) },
      { businessId: b, status: "OPEN", firstHandledAt: at(-1 * DAY), createdAt: at(-2 * DAY) },
    ]) as never,
  });
  await owner.inventoryItem.createMany({
    data: each((b) => [
      { businessId: b, name: "פריט א", unitType: "UNIT" },
      { businessId: b, name: "פריט ב", unitType: "UNIT" },
    ]) as never,
  });
  const items = await owner.inventoryItem.findMany({ where: { businessId: { in: ids } }, select: { id: true, businessId: true }, orderBy: { id: "asc" } });
  const firstItem = new Map<number, number>();
  for (const it of items) if (!firstItem.has(it.businessId)) firstItem.set(it.businessId, it.id);
  await owner.inventoryAlert.createMany({ data: each((b) => [{ businessId: b, type: "CRITICAL_STOCK", itemId: firstItem.get(b)! }]) as never });
  await owner.document.createMany({
    data: each((b) => [
      { businessId: b, fileUrl: "lab://a", source: "upload", mimeType: "application/pdf", status: "needs_review" },
      { businessId: b, fileUrl: "lab://b", source: "upload", mimeType: "application/pdf", status: "needs_review" },
      { businessId: b, fileUrl: "lab://c", source: "upload", mimeType: "application/pdf", status: "failed" },
      { businessId: b, fileUrl: "lab://d", source: "upload", mimeType: "application/pdf", status: "approved" },
    ]),
  });
  await owner.businessObligation.createMany({
    data: each((b) => [
      { businessId: b, obligeeName: "משכיר", amount: new Prisma.Decimal("100.00"), dueAt: at(0) },
      { businessId: b, obligeeName: "ספק", amount: new Prisma.Decimal("200.00"), dueAt: at(-3 * DAY) },
      { businessId: b, obligeeName: "חשמל", amount: new Prisma.Decimal("300.00"), dueAt: at(20 * DAY) },
    ]) as never,
  });
  await owner.paymentRequest.createMany({
    data: each((b) => [
      { businessId: b, provider: "CARDCOM", amount: new Prisma.Decimal("50.00"), status: "FAILED", updatedAt: at(-DAY) },
      { businessId: b, provider: "CARDCOM", amount: new Prisma.Decimal("60.00"), status: "PENDING", expiresAt: at(7 * DAY) },
    ]) as never,
  });
  await owner.appointment.createMany({
    data: each((b) => [
      { businessId: b, status: "CONFIRMED", startsAt: at(45 * 60_000), durationMinutes: 30, createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" },
      { businessId: b, status: "CONFIRMED", startsAt: at(DAY), durationMinutes: 30, createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" },
      { businessId: b, status: "CANCELED", startsAt: at(40 * 60_000), durationMinutes: 30, createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING" },
    ]) as never,
  });
  await owner.$disconnect();
  console.log(JSON.stringify({ seeded: n, tag }));
}

async function run(tag: string, passes: number): Promise<void> {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const runtime = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  let queries = 0;
  let begins = 0;
  // SWEEP_PERF_DUMP=1: statement shapes and their counts for the last pass (to see where the statements go).
  const dump = process.env.SWEEP_PERF_DUMP === "1" ? new Map<string, number>() : null;
  runtime.$on("query", (e) => {
    queries += 1;
    if (/^\s*BEGIN/i.test(e.query)) begins += 1;
    if (dump) {
      const t = e.query.replace(/\s+/g, " ").replace(/^SELECT .*? FROM ("public"\.)?("\w+")/, "SELECT … FROM $2").slice(0, 90);
      dump.set(t, (dump.get(t) ?? 0) + 1);
    }
  });
  (globalThis as unknown as { prisma: PrismaClient }).prisma = runtime;
  const mod = process.env.SWEEP_PERF_MODULE ?? "@/lib/notifications/producers/status-sweep";
  const { runStatusSweep } = (await import(mod)) as typeof import("@/lib/notifications/producers/status-sweep");

  const ids = (await owner.business.findMany({ where: { name: { startsWith: `${tag}-` } }, select: { id: true }, orderBy: { id: "asc" } })).map((b) => b.id);
  const db = (await owner.$queryRaw<{ d: string }[]>`SELECT current_database() AS d`)[0]!.d;
  // pg_stat_activity shows another role's xact_start only to a member of pg_read_all_stats: sample as the superuser.
  const sampler = new PrismaClient({ datasourceUrl: process.env.SAMPLER_URL ?? process.env.OWNER_URL! });
  const concurrency = process.env.SWEEP_PERF_CONCURRENCY ? Number(process.env.SWEEP_PERF_CONCURRENCY) : undefined;

  for (let p = 1; p <= passes; p += 1) {
    queries = 0;
    begins = 0;
    let peak = 0;
    let peakConn = 0;
    let sampling = true;
    const sampling$ = (async () => {
      while (sampling) {
        const r = await sampler.$queryRaw<{ tx: bigint; conn: bigint }[]>`
          SELECT count(*) FILTER (WHERE xact_start IS NOT NULL)::bigint AS tx, count(*)::bigint AS conn FROM pg_stat_activity
           WHERE datname = ${db} AND pid <> pg_backend_pid() AND usename <> 'lab_owner'`;
        peak = Math.max(peak, Number(r[0]!.tx));
        peakConn = Math.max(peakConn, Number(r[0]!.conn));
        await new Promise((res) => setTimeout(res, 5));
      }
    })();
    const t0 = Date.now();
    const report = await runStatusSweep(new Date(), { businessIds: ids, quiet: true, budgetMs: 10 * 60_000, concurrency } as never);
    const wallMs = Date.now() - t0;
    sampling = false;
    await sampling$;
    console.log(JSON.stringify({
      pass: p, businesses: ids.length, wallMs, msPerBusiness: +(wallMs / ids.length).toFixed(1),
      queries, queriesPerBusiness: +(queries / ids.length).toFixed(1),
      tx: begins, txPerBusiness: +(begins / ids.length).toFixed(1),
      peakOpenTx: peak, peakConnections: peakConn,
      report: { swept: report.swept, errors: report.errors, written: report.written, notified: report.notified, resolved: report.resolved, producerEvents: (report as { producerEvents?: number }).producerEvents ?? 0 },
    }));
  }
  await sampler.$disconnect();
  if (dump) for (const [k, v] of [...dump.entries()].sort((x, y) => y[1] - x[1])) console.log(String(v).padStart(6), k);
  await runtime.$disconnect();
  await owner.$disconnect();
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === "seed" ? seed(Number(a), b!) : cmd === "run" ? run(a!, Number(b ?? 2)) : Promise.reject(new Error("usage: seed <N> <tag> | run <tag> [passes]")))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
