/**
 * Third notification consumer — DB integration proof.
 *
 * The whole argument for this producer is a claim about volume: that a business
 * with fifty documents waiting gets ONE notification, not fifty. That is not
 * something to reason about — it is something to count. So this drives real
 * documents into a real database and counts the rows.
 *
 * THE IDENTITY THIS PROVES
 *
 *   Document     = one ITEM in a queue.
 *   Notification = one QUEUE. Keyed on the business, so the number of documents
 *                  changes the words on the card and never the number of cards.
 *
 * It also pins the two behaviours that make an aggregated notification bearable
 * rather than annoying: reading it survives the count changing underneath, and
 * a backlog hovering around the threshold does not turn into a stream.
 *
 * Requires env: DATABASE_URL / DIRECT_URL pointing at a THROWAWAY database at
 * the current migration head. Writes no production data.
 *
 * Run: npx tsx lib/notifications/documents-review-queue-notifications.integration.test.ts
 */
import { PAPERWORK_PENDING_MIN } from "../business-status/paperwork-insight";
import { countPendingReviewAllTime } from "../documents/pending-review";
import { prisma } from "../prisma";
import { runWithTenantContext } from "../tenant/context";
import { withTenantTransaction } from "../tenant/transaction";

import { syncDocumentsReviewQueueNotification } from "./documents-review-queue-notifications";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/** 09:00 Jerusalem — outside quiet hours. */
const T0 = new Date("2026-09-10T06:00:00.000Z");
const HOUR = 3_600_000;

const queueNotifs = (businessId: number) =>
  prisma.notification.findMany({
    where: { businessId, domain: "documents" },
    orderBy: { id: "asc" },
    include: { deliveries: true },
  });

/** A document in the review queue, written the way ingestion writes it. */
async function addPending(businessId: number, n: number, createdAt: Date) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const doc = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) =>
        tx.document.create({
          data: {
            businessId,
            fileUrl: `qa/doc-${Date.now()}-${i}.pdf`,
            source: "file",
            mimeType: "application/pdf",
            status: "needs_review",
            createdAt,
          },
        }),
      ),
    );
    ids.push(doc.id);
  }
  return ids;
}

/** What the approve route does to the queue. */
async function approve(businessId: number, documentId: number) {
  await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.document.updateMany({
        where: { id: documentId, businessId },
        data: { status: "approved" },
      }),
    ),
  );
}

const sync = (businessId: number, now: Date) =>
  runWithTenantContext({ businessId }, () =>
    syncDocumentsReviewQueueNotification(businessId, now),
  );

(async () => {
  const a = await prisma.business.create({ data: { name: "docs-queue-A" } });
  const b = await prisma.business.create({ data: { name: "docs-queue-B" } });
  const extraBusinessIds: number[] = [];

  try {
    check("the threshold is the ratified one", PAPERWORK_PENDING_MIN === 5,
      String(PAPERWORK_PENDING_MIN));

    /* ── 1. below the threshold, nothing is said ───────────────────────────── */
    const docs = await addPending(a.id, 1, T0);
    let out = await sync(a.id, T0);
    check("one pending document is not news", out.ok && out.pendingCount === 1);
    check("no notification at 1", (await queueNotifs(a.id)).length === 0);

    docs.push(...(await addPending(a.id, 3, T0)));
    out = await sync(a.id, T0);
    check("four pending is still not a backlog", out.pendingCount === 4, String(out.pendingCount));
    check("no notification at 4", (await queueNotifs(a.id)).length === 0,
      `count=${(await queueNotifs(a.id)).length}`);

    /* ── 2. crossing the threshold opens exactly one ───────────────────────── */
    docs.push(...(await addPending(a.id, 1, T0)));
    out = await sync(a.id, T0);
    check("five pending crosses the line", out.pendingCount === 5);

    let rows = await queueNotifs(a.id);
    check("ONE notification at 5", rows.length === 1, `count=${rows.length}`);
    check("its identity is the QUEUE, not a document",
      rows[0]?.entityType === "documents_review_queue" && rows[0]?.entityId === a.id,
      `${rows[0]?.entityType}:${rows[0]?.entityId}`);
    check("the dedupe key is the business's queue",
      rows[0]?.dedupeKey === `b${a.id}:documents:ACTION_REQUIRED:documents_review_queue:${a.id}`,
      rows[0]?.dedupeKey);
    check("it is documents / ACTION_REQUIRED / MEDIUM",
      rows[0]?.domain === "documents" && rows[0]?.semanticCategory === "ACTION_REQUIRED" &&
        rows[0]?.severity === "MEDIUM");
    check("the title carries the count", rows[0]?.title.startsWith("5 "), rows[0]?.title);
    check("the link is the month-scoped inbox",
      rows[0]?.href.startsWith("/documents/inbox"), rows[0]?.href);
    check("the month in the link is one that actually holds pending work",
      rows[0]?.href === "/documents/inbox?month=2026-09", rows[0]?.href);
    check("IN_APP only", JSON.stringify(rows[0]?.intendedChannels) === '["IN_APP"]',
      JSON.stringify(rows[0]?.intendedChannels));
    check("no PUSH delivery", rows[0]?.deliveries.every((d) => d.channel !== "PUSH") === true);
    check("exactly one delivery", rows[0]?.deliveries.length === 1);
    check("the cooldown is the policy's 72 hours", rows[0]?.cooldownHours === 72,
      String(rows[0]?.cooldownHours));
    const notificationId = rows[0]!.id;

    /* ── 3. THE NOISE PROOF: 10, 20, 50 are all still one row ──────────────── */
    for (const target of [10, 20, 50]) {
      const have = await runWithTenantContext({ businessId: a.id }, () =>
        countPendingReviewAllTime(a.id),
      );
      docs.push(...(await addPending(a.id, target - have, T0)));
      out = await sync(a.id, new Date(T0.getTime() + 60_000));
      rows = await queueNotifs(a.id);
      const deliveries = rows.reduce((n, r) => n + r.deliveries.length, 0);
      check(`${target} pending documents => ONE notification`, rows.length === 1,
        `rows=${rows.length}`);
      check(`${target} pending documents => ONE delivery`, deliveries === 1,
        `deliveries=${deliveries}`);
      check(`${target} pending: still the same row`, rows[0]?.id === notificationId);
      check(`${target} pending: the count is reported`, out.pendingCount === target,
        String(out.pendingCount));
      check(`${target} pending: the title says so`, rows[0]?.title.startsWith(`${target} `),
        rows[0]?.title);
    }

    const unreadAt50 = await prisma.notification.count({
      where: { businessId: a.id, domain: "documents", readAt: null, resolvedAt: null },
    });
    check("the owner has ONE unread thing to do about paperwork", unreadAt50 === 1,
      String(unreadAt50));

    /* ── 4. READ SURVIVES THE COUNT MOVING ─────────────────────────────────── */
    await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date(T0.getTime() + 2 * 60_000) },
    });
    await approve(a.id, docs[0]!);
    await approve(a.id, docs[1]!);
    out = await sync(a.id, new Date(T0.getTime() + 3 * 60_000));
    rows = await queueNotifs(a.id);
    check("the count fell to 48", out.pendingCount === 48, String(out.pendingCount));
    check("the title followed the count", rows[0]?.title.startsWith("48 "), rows[0]?.title);
    check("READ SURVIVES — the owner is not re-interrupted by a number changing",
      rows[0]?.readAt !== null);
    check("and it is still open", rows[0]?.resolvedAt === null);
    check("no second row appeared", rows.length === 1);

    /* ── 5. falling below the threshold resolves it ────────────────────────── */
    const remaining = await runWithTenantContext({ businessId: a.id }, () =>
      prisma.document.findMany({
        where: { businessId: a.id, status: "needs_review" },
        select: { id: true },
      }),
    );
    // Leave exactly four.
    for (const d of remaining.slice(0, remaining.length - 4)) await approve(a.id, d.id);
    out = await sync(a.id, new Date(T0.getTime() + 4 * 60_000));
    check("four are left", out.pendingCount === 4, String(out.pendingCount));
    check("the sync closed it", out.resolved === 1, String(out.resolved));
    rows = await queueNotifs(a.id);
    check("the queue notification is resolved", rows[0]?.resolvedAt !== null);
    check("resolution did NOT delete it — it is history", rows.length === 1);
    check("it no longer counts as unread",
      (await prisma.notification.count({
        where: { businessId: a.id, domain: "documents", readAt: null, resolvedAt: null },
      })) === 0);

    /* ── 6. crossing again reopens THE SAME row ────────────────────────────── */
    const later = new Date(T0.getTime() + 73 * HOUR); // past the 72h cooldown
    await addPending(a.id, 1, later);
    out = await sync(a.id, later);
    check("back to five", out.pendingCount === 5, String(out.pendingCount));
    rows = await queueNotifs(a.id);
    check("no new row was created", rows.length === 1, `count=${rows.length}`);
    check("the SAME row reopened", rows[0]?.id === notificationId && rows[0]?.resolvedAt === null);
    check("past the cooldown it reads as news again", rows[0]?.readAt === null);
    check("a second delivery was written",
      (await prisma.notificationDelivery.count({ where: { notificationId } })) === 2);

    /* ── 7. THRESHOLD FLAPPING DOES NOT SPAM ───────────────────────────────── */
    // 5 -> 4 -> 5 -> 4 -> 5, all inside one cooldown window.
    const flapDocs = await runWithTenantContext({ businessId: a.id }, () =>
      prisma.document.findMany({
        where: { businessId: a.id, status: "needs_review" },
        select: { id: true },
      }),
    );
    const deliveriesBeforeFlap = await prisma.notificationDelivery.count({
      where: { notificationId },
    });
    let flapAt = later.getTime();
    for (let i = 0; i < 2; i++) {
      flapAt += 10 * 60_000;
      await approve(a.id, flapDocs[i]!.id);
      await sync(a.id, new Date(flapAt)); // 4 -> resolves
      flapAt += 10 * 60_000;
      await addPending(a.id, 1, new Date(flapAt));
      await sync(a.id, new Date(flapAt)); // 5 -> reopens
    }
    rows = await queueNotifs(a.id);
    check("flapping created no extra notification rows", rows.length === 1, `count=${rows.length}`);
    check("flapping created no extra deliveries — the cooldown held",
      (await prisma.notificationDelivery.count({ where: { notificationId } })) ===
        deliveriesBeforeFlap,
      `${deliveriesBeforeFlap} before`);
    check("it ends open, because the backlog is back", rows[0]?.resolvedAt === null);

    /* ── 8. tenant isolation ───────────────────────────────────────────────── */
    await addPending(b.id, 6, T0);
    const bOut = await sync(b.id, T0);
    check("business B gets its own queue notification", bOut.pendingCount === 6);
    const bRows = await queueNotifs(b.id);
    check("one row for B", bRows.length === 1, `count=${bRows.length}`);
    check("B's key carries B's id", bRows[0]?.dedupeKey.includes(`b${b.id}:`), bRows[0]?.dedupeKey);
    check("B's entityId is B, not A", bRows[0]?.entityId === b.id);
    check("A still has exactly one row", (await queueNotifs(a.id)).length === 1);
    check("syncing B did not resolve A's",
      (await queueNotifs(a.id))[0]?.resolvedAt === null);
    check("A's documents never counted toward B",
      (await runWithTenantContext({ businessId: b.id }, () => countPendingReviewAllTime(b.id))) === 6);

    /* ── 9. failure isolation, both directions ─────────────────────────────── */
    const c = await prisma.business.create({ data: { name: "docs-queue-C-failure" } });
    extraBusinessIds.push(c.id);
    await addPending(c.id, 6, T0);
    const docsBefore = await prisma.document.count({ where: { businessId: c.id } });

    // A real failure: the count selector refuses to run without a tenant context.
    const failedOpen = await syncDocumentsReviewQueueNotification(c.id, T0);
    check("the opening sync failed", failedOpen.ok === false && typeof failedOpen.error === "string");
    check("it returned the failure as data rather than throwing",
      failedOpen.written.length === 0 && failedOpen.resolved === 0);
    check("every document is still committed",
      (await prisma.document.count({ where: { businessId: c.id } })) === docsBefore,
      String(docsBefore));
    check("no notification was written by the failure", (await queueNotifs(c.id)).length === 0);

    await sync(c.id, T0);
    const cDocs = await prisma.document.findMany({
      where: { businessId: c.id, status: "needs_review" },
      select: { id: true },
    });
    for (const d of cDocs.slice(0, 3)) await approve(c.id, d.id);
    const failedResolve = await syncDocumentsReviewQueueNotification(c.id, T0);
    check("the resolving sync failed too", failedResolve.ok === false);
    check("the approvals are still committed",
      (await prisma.document.count({ where: { businessId: c.id, status: "approved" } })) === 3);
    check("the notification simply stayed open — no silent corruption",
      (await queueNotifs(c.id))[0]?.resolvedAt === null);

    /* ── 10. the consumer stays inside its own identity ────────────────────── */
    check("no per-document notification was ever written",
      (await prisma.notification.count({
        where: { businessId: { in: [a.id, b.id, c.id] }, entityType: "document" },
      })) === 0);
    check("no other domain was touched",
      (await prisma.notification.count({
        where: { businessId: { in: [a.id, b.id, c.id] }, domain: { not: "documents" } },
      })) === 0);
    check("exactly one queue row per business",
      (await prisma.notification.count({
        where: { businessId: { in: [a.id, b.id, c.id] }, entityType: "documents_review_queue" },
      })) === 3);
  } finally {
    const ids = [a.id, b.id, ...extraBusinessIds];
    await prisma.business.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? `\nDOCUMENTS REVIEW QUEUE: all checks passed\n`
      : `\nDOCUMENTS REVIEW QUEUE: ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("integration harness error:", err);
  process.exit(1);
});
