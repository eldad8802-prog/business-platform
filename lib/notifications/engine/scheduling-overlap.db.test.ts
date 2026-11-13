/**
 * Scheduling overlap on a real database (notify/10-schedule — docs/notifications/scheduling.md), AS THE RESTRICTED
 * RUNTIME (app_runtime_prod, NOSUPERUSER NOBYPASSRLS) over the real migrations 20261210090000 + 20261211090000 +
 * 20261212090000 (`.nte2c/lab.sh <db> --with-nte2c`). Fake push providers; no network.
 *
 * A Vercel cron event can be delivered twice, the after() trigger and the digest's own worker pass run beside the cron
 * worker, and a manual call can meet a scheduled one. Each scheduled route must absorb that without a second send or
 * a second scan's worth of writes:
 *
 *   digest   three passes of the same instant at once ⇒ ONE digest per user (the per-user-per-day unique dedupe key)
 *            and ONE owed push for it;
 *   worker   three passes at once over those owed pushes ⇒ each claimed ONCE (conditional UPDATE under a lease); the
 *            racing-send-to-a-device case is pinned by notification-engine.db.test.ts ("claim / lease");
 *   sweep    two scheduled (rotation) passes at once ⇒ one notification and one owed push for the fact, no error (the
 *            writer's unique claim; the state producers' per-business try-lock reports the loser as leaseBusy).
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login, OWNER_URL = the migration role (fixtures only).
 *   npx tsx lib/notifications/engine/scheduling-overlap.db.test.ts
 */
import { PrismaClient } from "@prisma/client";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 600));
  }
}

const fakeDeps = {
  fetch: async () => ({ status: 200, text: async () => "{}" }),
  webPush: async () => ({ ok: true as const, status: 201 }),
};

async function main() {
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { notify } = await import("./notify");
  const { runPushWorker } = await import("./push-worker");
  const { runDailyDigest } = await import("./digest");
  const { runStatusSweep } = await import("../producers/status-sweep");
  const { STATUS_SWEEP_CADENCE_MS } = await import("./schedule");
  const store = await import("../preferences-store");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const NOW = new Date("2026-12-01T10:00:00.000Z"); // 12:00 Asia/Jerusalem
  const MORNING = new Date("2026-12-02T06:00:00.000Z"); // 08:00 the next day — a digest tick

  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
    VALUES ('notifications_engine', 'מנוע התראות', 'integrations', 'lab', false, true) ON CONFLICT ("key") DO NOTHING`);
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
    VALUES ('notifications_engine', false, false, now()) ON CONFLICT ("featureKey") DO NOTHING`);
  const X = (await owner.business.create({ data: { name: "nte10-overlap" } })).id;
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt")
    VALUES ($1, 'notifications_engine', 'ENABLED', TIMESTAMP '2026-11-01 00:00:00')`, X);
  const x1 = (await owner.user.create({ data: { email: `nte10-x1-${X}@lab.invalid`, businessId: X } })).id;
  const x2 = (await owner.user.create({ data: { email: `nte10-x2-${X}@lab.invalid`, businessId: X } })).id;

  console.log("digest — three passes of the same tick at once");
  for (const u of [x1, x2]) await store.putPreference({ businessId: X, userId: u }, "domain:billing", { inApp: null, push: null, delivery: "digest" }, NOW);
  const bill = await tenantTx(X, (tx) => notify(tx, { businessId: X, category: "billing.failure", entity: { type: "billing_document", id: 77 }, title: "חשבונית 77", href: "/billing/77", now: NOW }));
  await runPushWorker(NOW, { businessId: X, deps: fakeDeps, quiet: true });
  const held = await owner.notificationDelivery.count({ where: { businessId: X, notificationId: bill.notificationId, status: "SUPPRESSED", error: "to_digest" } });
  ok("fixture: the billing failure is held for both users' digests (to_digest)", held === 2, held);
  const runs = await Promise.all([1, 2, 3].map(() => runDailyDigest(MORNING, { businessIds: [X], quiet: true }).catch((e: Error) => ({ error: e.message }))));
  const digests = await owner.notification.findMany({ where: { businessId: X, semanticCategory: "digest.daily" }, select: { id: true, userId: true, dedupeKey: true } });
  ok("ONE digest per user, whatever the interleaving (2 rows for 2 users; no pass threw)",
    digests.length === 2 && new Set(digests.map((d) => d.userId)).size === 2 && runs.every((r) => !("error" in r)), { runs, digests });
  const owedDigest = await owner.notificationDelivery.findMany({ where: { businessId: X, notificationId: { in: digests.map((d) => d.id) }, channel: "PUSH" }, select: { id: true, notificationId: true, status: true } });
  ok("…each with exactly ONE owed push", owedDigest.length === 2 && new Set(owedDigest.map((d) => d.notificationId)).size === 2, owedDigest);
  const again = await runDailyDigest(new Date(MORNING.getTime() + 15 * 60_000), { businessIds: [X], quiet: true });
  ok("the next tick (08:15) writes nothing more", again.digests === 0 && (await owner.notification.count({ where: { businessId: X, semanticCategory: "digest.daily" } })) === 2, again);

  console.log("worker — three passes at once");
  const wr = await Promise.all([1, 2, 3].map(() => runPushWorker(MORNING, { deps: fakeDeps, quiet: true })));
  const claimed = wr.reduce((a, r) => a + r.claimed, 0);
  const after = await owner.notificationDelivery.findMany({ where: { businessId: X, notificationId: { in: digests.map((d) => d.id) }, channel: "PUSH" }, select: { status: true, completedAt: true, subscriptionId: true } });
  ok("each owed digest push claimed exactly once across the racing passes (2 claims, every row finished once)",
    claimed === 2 && after.length === 2 && after.every((d) => d.status !== "PENDING" && d.subscriptionId === null), { claimed, after, errors: wr.map((r) => r.errors) });

  console.log("sweep — two scheduled (rotation) passes at once");
  await owner.$executeRawUnsafe(`INSERT INTO "BillingDocument" ("businessId", "documentType", "status", "pdfRenderStatus", "updatedAt")
    VALUES ($1, 'TAX_INVOICE', 'DRAFT', 'FAILED', now())`, X).catch(async () => {
    await owner.billingDocument.create({ data: { businessId: X, documentType: "TAX_INVOICE", status: "DRAFT", pdfRenderStatus: "FAILED" } as never });
  });
  const before = await owner.notification.count({ where: { businessId: X } });
  const sw = await Promise.all([1, 2].map(() => runStatusSweep(NOW, { budgetMs: 45_000, quiet: true, rotation: { cadenceMs: STATUS_SWEEP_CADENCE_MS } })));
  const rows = await owner.notification.findMany({ where: { businessId: X, domain: "billing", NOT: { semanticCategory: "digest.daily" } }, select: { id: true, dedupeKey: true } });
  const dup = rows.length !== new Set(rows.map((r) => r.dedupeKey)).size;
  const created = (await owner.notification.count({ where: { businessId: X } })) - before;
  const owedSweep = await owner.notificationDelivery.count({ where: { businessId: X, channel: "PUSH", notification: { dedupeKey: { in: rows.map((r) => r.dedupeKey) } }, subscriptionId: null, userId: null } });
  ok("both passes reached the business, no error; the PDF failure is ONE notification (no duplicate dedupe key)",
    sw.every((r) => r.errors === 0 && (r.rotation?.covered ?? 0) >= 1) && !dup && created >= 1, { sw: sw.map((r) => ({ e: r.errors, rot: r.rotation, busy: r.leaseBusy, w: r.written })), rows, created });
  const sweptX = sw.reduce((a, r) => a + r.swept, 0);
  ok("…with ONE owed whole-business push for it, whichever pass wrote it", owedSweep <= rows.length && sweptX >= 2, { owedSweep, rows: rows.length });

  await owner.$disconnect();
  console.log(failed ? `\nscheduling overlap: ${failed} FAIL` : "\nscheduling overlap: all PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
