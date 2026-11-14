/**
 * The status sweep on a real database, AS THE RESTRICTED RUNTIME (NOSUPERUSER NOBYPASSRLS, a member of app_runtime),
 * over the real migration 20261210090000_notification_engine_foundation (built by `.nte/lab.sh <db> --with-nte`).
 * No push is sent (the sweep only writes rows; the engine's worker is not run here).
 *
 *   write            an engine-ON business: its billing document waiting for review, its billing PDF failure, its
 *                    overdue lead follow-up and its supplier purchase draft become ONE whole-business notification
 *                    each (userId NULL) through the existing writer; only the billing failure owes a PUSH (PENDING,
 *                    expiresAt = the catalog TTL) — the rest are in-app.
 *   two businesses   the other engine-ON business gets only its own fact; neither business's runtime sees the other's.
 *   two users        both users of the business see the same whole-business notifications through the read side.
 *   cooldown         a second pass an hour later writes no delivery and claims nothing (lastNotifiedAt unchanged).
 *   resolve          the supplier draft approved and the PDF re-rendered ⇒ exactly those two resolve; the others and
 *                    the other business stay open; a fact that returns inside the cooldown reopens without a new
 *                    delivery.
 *   feature off      billing DISABLED for a business ⇒ no billing notification and its open billing row is NOT
 *                    resolved (the scope is not swept at all); its supplier fact is still written.
 *   engine OFF       nothing at all, even with facts present.
 *   live walk        the definer walk (notification_live_businesses) reaches the businesses with no error.
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). Synthetic data only. Run: npx tsx lib/notifications/producers/status-sweep.db.test.ts
 */
import { PrismaClient } from "@prisma/client";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 600));
  }
}

async function main() {
  const { runStatusSweep } = await import("./status-sweep");
  const read = await import("../notification-read.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const HOUR = 3_600_000;
  // The snapshot reads the real clock (lib/business-status), so the sweep's instant is the real one too; a fixed
  // Israeli daytime is not needed — only the billing push depends on quiet hours, and both outcomes are checked.
  const T0 = new Date();
  const at = (h: number) => new Date(T0.getTime() + h * HOUR);

  /* ── fixtures (owner) ──────────────────────────────────────────────────────────────────────────────────────── */
  for (const [key, def] of [["notifications_engine", false], ["billing", true], ["inventory", true], ["documents", true]] as const) {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
      VALUES ($1, $1, 'lab', 'lab', $2, true) ON CONFLICT ("key") DO NOTHING`, key, def);
  }
  const access = (businessId: number, featureKey: string, state: "ENABLED" | "DISABLED") =>
    owner.businessFeatureAccess.create({ data: { businessId, featureKey, state } });
  const stamp = Date.now();
  const biz = async (name: string, engine: boolean) => {
    const b = await owner.business.create({ data: { name: `${name}-${stamp}` } });
    if (engine) await access(b.id, "notifications_engine", "ENABLED");
    for (const k of ["billing", "inventory", "documents"]) await access(b.id, k, "ENABLED").catch(() => undefined);
    return b.id;
  };
  const A = await biz("nte6-A", true);
  const B = await biz("nte6-B", true);
  const C = await biz("nte6-C", false);
  const D = await biz("nte6-D", true);
  await owner.businessFeatureAccess.updateMany({ where: { businessId: D, featureKey: "billing" }, data: { state: "DISABLED" } });
  const user = async (b: number, tag: string) => (await owner.user.create({ data: { email: `${tag}-${stamp}@nte6.lab`, password: "x", businessId: b } })).id;
  const a1 = await user(A, "a1");
  const a2 = await user(A, "a2");
  const b1 = await user(B, "b1");
  await user(C, "c1");
  await user(D, "d1");

  const billingDoc = (businessId: number, over: Record<string, unknown>) =>
    owner.billingDocument.create({ data: { businessId, documentType: "TAX_INVOICE", ...over } as never, select: { id: true } });
  const draft = (businessId: number) =>
    owner.supplierPurchaseDraft.create({ data: { businessId, status: "PENDING_REVIEW", supplierName: "ספק מעבדה" } as never, select: { id: true } });
  const lead = (businessId: number) =>
    owner.lead.create({
      data: { businessId, status: "OPEN", nextFollowUpAt: at(-72), firstHandledAt: at(-24 * 10), createdAt: at(-24 * 20) } as never,
      select: { id: true },
    });

  const aReview = await billingDoc(A, { status: "PENDING_REVIEW" });
  const aFailed = await billingDoc(A, { status: "DRAFT", pdfRenderStatus: "FAILED", createdAt: at(-1) });
  const aDraft = await draft(A);
  const aLead = await lead(A);
  const bDraft = await draft(B);
  await draft(C);
  await billingDoc(C, { status: "PENDING_REVIEW" });
  await billingDoc(D, { status: "DRAFT", pdfRenderStatus: "FAILED", createdAt: at(-1) });
  await draft(D);
  // D: an open billing notification from before billing was switched off — the sweep must not resolve it.
  const dOpen = await owner.notification.create({
    data: {
      businessId: D, dedupeKey: `b${D}:billing:FAILURE_EVENT:billing_document:999999`, domain: "billing", semanticCategory: "FAILURE_EVENT",
      severity: "HIGH", entityType: "billing_document", entityId: 999999, title: "x", href: "/billing/999999",
      intendedChannels: ["IN_APP"], reason: "lab", cooldownHours: 12, updatedAt: at(-48),
    },
    select: { id: true },
  });

  const rows = (businessId: number) =>
    owner.notification.findMany({ where: { businessId, NOT: { id: dOpen.id } }, orderBy: { id: "asc" } });
  const deliveries = (businessId: number) => owner.notificationDelivery.findMany({ where: { businessId }, orderBy: { id: "asc" } });
  const key = (b: number, domain: string, cat: string, type: string, id: number) => `b${b}:${domain}:${cat}:${type}:${id}`;

  /* ── 1. first pass ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("1. write");
  const r1 = await runStatusSweep(T0, { businessIds: [A, B, C, D], quiet: true });
  ok("report: four businesses, one engine OFF, no error", r1.businesses === 4 && r1.engineOff === 1 && r1.errors === 0 && r1.swept === 3, r1);
  const aRows = await rows(A);
  const aKeys = aRows.map((n) => n.dedupeKey).sort();
  const wantA = [
    key(A, "billing", "ACTION_REQUIRED", "billing_document", aReview.id),
    key(A, "billing", "FAILURE_EVENT", "billing_document", aFailed.id),
    key(A, "leads", "ACTION_REQUIRED", "lead", aLead.id),
    key(A, "supplier", "ACTION_REQUIRED", "supplier_purchase_draft", aDraft.id),
  ].sort();
  ok("A: exactly the four facts, one row each", JSON.stringify(aKeys) === JSON.stringify(wantA), { aKeys, wantA });
  ok("A: whole-business rows (userId NULL), open, unread", aRows.every((n) => n.userId === null && n.resolvedAt === null && n.readAt === null));
  const aDel = await deliveries(A);
  const failRow = aRows.find((n) => n.semanticCategory === "FAILURE_EVENT")!;
  const pushRows = aDel.filter((d) => d.channel === "PUSH");
  ok("A: every fact delivered in-app (SENT)", aRows.every((n) => aDel.some((d) => d.notificationId === n.id && d.channel === "IN_APP" && d.status === "SENT")));
  ok("A: a PUSH is owed only for the billing failure (or none in quiet hours), PENDING with the catalog TTL (12 h)",
    pushRows.every((d) => d.notificationId === failRow.id && d.status === "PENDING" && d.userId === null && d.expiresAt !== null &&
      Math.abs(d.expiresAt.getTime() - T0.getTime() - 12 * HOUR) < 5_000) && pushRows.length <= 1, pushRows);
  ok("A: the push choice is the policy's (in-app only inside Israeli quiet hours)",
    (failRow.intendedChannels.includes("PUSH")) === (pushRows.length === 1), { channels: failRow.intendedChannels, push: pushRows.length });
  ok("A: no push owed for review / lead / supplier", aRows.filter((n) => n.id !== failRow.id).every((n) => n.intendedChannels.join() === "IN_APP"));

  console.log("2. two businesses / two users");
  const bRows = await rows(B);
  ok("B: only its own supplier fact", bRows.length === 1 && bRows[0]!.dedupeKey === key(B, "supplier", "ACTION_REQUIRED", "supplier_purchase_draft", bDraft.id), bRows.map((n) => n.dedupeKey));
  const list = async (businessId: number, userId: number) =>
    (await read.listNotifications(businessId, { limit: 50, cursor: null, unreadOnly: false, viewer: { userId } })).notifications.map((n) => n.id).sort();
  const seenA1 = await list(A, a1);
  const seenA2 = await list(A, a2);
  ok("two users of A see the same four notifications", JSON.stringify(seenA1) === JSON.stringify(aRows.map((n) => n.id).sort()) && JSON.stringify(seenA1) === JSON.stringify(seenA2), { seenA1, seenA2 });
  ok("B's user sees only B's", JSON.stringify(await list(B, b1)) === JSON.stringify(bRows.map((n) => n.id)));
  const crossRead = await tenantTx(B, (tx) => tx.notification.count({ where: { businessId: A } }));
  ok("B's runtime cannot read A's rows (RLS)", crossRead === 0, crossRead);

  console.log("3. engine OFF / feature unavailable");
  ok("C (engine OFF): nothing written though facts exist", (await rows(C)).length === 0 && (await deliveries(C)).length === 0);
  const dRows = await rows(D);
  ok("D (billing DISABLED): no billing notification, the supplier fact written",
    dRows.length === 1 && dRows[0]!.domain === "supplier", dRows.map((n) => n.dedupeKey));
  ok("D: its open billing row is NOT resolved (the scope is not swept)", (await owner.notification.findUniqueOrThrow({ where: { id: dOpen.id } })).resolvedAt === null);

  /* ── 4. cooldown ───────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("4. cooldown");
  const beforeDel = (await deliveries(A)).length;
  const beforeNotified = new Map(aRows.map((n) => [n.id, n.lastNotifiedAt?.getTime()]));
  const r2 = await runStatusSweep(at(1), { businessIds: [A], quiet: true });
  ok("an hour later: the facts are refreshed, nothing notified", r2.written === 4 && r2.notified === 0 && r2.errors === 0, r2);
  ok("…no new delivery row", (await deliveries(A)).length === beforeDel);
  const aRows2 = await rows(A);
  ok("…lastNotifiedAt unchanged, lastSurfacedAt moved", aRows2.every((n) => n.lastNotifiedAt?.getTime() === beforeNotified.get(n.id) && n.lastSurfacedAt.getTime() > n.firstSurfacedAt.getTime()));
  await owner.notification.update({ where: { id: aRows2.find((n) => n.domain === "leads")!.id }, data: { readAt: at(1) } });
  await runStatusSweep(at(2), { businessIds: [A], quiet: true });
  ok("a read notification stays read inside the cooldown (owner action untouched)", (await owner.notification.findFirstOrThrow({ where: { businessId: A, domain: "leads" } })).readAt !== null);

  /* ── 5. resolve on disappear ──────────────────────────────────────────────────────────────────────────────── */
  console.log("5. resolve");
  await owner.supplierPurchaseDraft.update({ where: { id: aDraft.id }, data: { status: "APPROVED" } });
  await owner.billingDocument.update({ where: { id: aFailed.id }, data: { pdfRenderStatus: "RENDERED" } });
  const r3 = await runStatusSweep(at(3), { businessIds: [A, B], quiet: true });
  const aRows3 = await rows(A);
  const resolved = aRows3.filter((n) => n.resolvedAt !== null).map((n) => n.dedupeKey).sort();
  ok("exactly the approved draft and the re-rendered PDF resolve", r3.resolved === 2 &&
    JSON.stringify(resolved) === JSON.stringify([key(A, "billing", "FAILURE_EVENT", "billing_document", aFailed.id), key(A, "supplier", "ACTION_REQUIRED", "supplier_purchase_draft", aDraft.id)].sort()), { resolved, r3 });
  ok("the review and the lead stay open", aRows3.filter((n) => n.resolvedAt === null).length === 2);
  ok("B's supplier fact stays open", (await rows(B)).every((n) => n.resolvedAt === null));
  const delBeforeReopen = (await deliveries(A)).length;
  await owner.supplierPurchaseDraft.update({ where: { id: aDraft.id }, data: { status: "PENDING_REVIEW" } });
  await runStatusSweep(at(4), { businessIds: [A], quiet: true });
  const reopened = await owner.notification.findFirstOrThrow({ where: { businessId: A, dedupeKey: key(A, "supplier", "ACTION_REQUIRED", "supplier_purchase_draft", aDraft.id) } });
  ok("a fact that returns inside the cooldown reopens (resolvedAt cleared) without a new delivery",
    reopened.resolvedAt === null && (await deliveries(A)).length === delBeforeReopen);
  const r5 = await runStatusSweep(at(80), { businessIds: [A], quiet: true });
  ok("after the cooldown (72 h for supplier, 48 h for review, 24 h for the lead) the standing facts are told again", r5.notified === 3, r5);

  /* ── 6. live walk ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("6. live walk");
  const r6 = await runStatusSweep(at(81), { quiet: true });
  ok("the definer walk visits the lab's businesses with no error and continues to the end", r6.businesses >= 4 && r6.errors === 0 && r6.nextAfter === null, r6);
  const rBudget = await runStatusSweep(at(82), { quiet: true, budgetMs: 0 });
  ok("a zero budget sweeps nothing and hands back a continuation", rBudget.swept === 0 && rBudget.nextAfter === 0, rBudget);

  await owner.$disconnect();
  console.log(`\n[status-sweep.db] checks=${checks} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
