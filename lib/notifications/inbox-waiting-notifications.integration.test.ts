/**
 * Second notification consumer — DB integration proof.
 *
 * Drives real conversations and real messages through real tenant transactions
 * and asserts what the notification layer ends up believing. Nothing is mocked:
 * the waiting fact is read back through the same business-status loader
 * `/api/business-status` uses, and the policy and writer are the merged ones.
 *
 * The sequence mirrors the routes exactly — a tenant transaction that commits,
 * then the sync afterwards — because the whole point of the design is that
 * persistence happens after the commit and cannot affect it.
 *
 * THE IDENTITY THIS PROVES
 *
 *   Message      = one EVENT.     Every inbound message is a new row.
 *   Notification = one CONDITION. Keyed on the conversation, so a customer
 *                                 sending five messages before anyone answers
 *                                 is one notification, not five.
 *
 * That is the whole noise argument for this producer, and it is asserted here
 * against real rows rather than reasoned about.
 *
 * Requires env: DATABASE_URL / DIRECT_URL pointing at a THROWAWAY database at
 * the current migration head. Writes no production data.
 *
 * Run: npx tsx lib/notifications/inbox-waiting-notifications.integration.test.ts
 */
import { prisma } from "../prisma";
import { runWithTenantContext } from "../tenant/context";
import { withTenantTransaction } from "../tenant/transaction";

import { syncInboxWaitingNotifications } from "./inbox-waiting-notifications";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/** 09:00 Jerusalem — outside quiet hours, so nothing is downgraded by them. */
const T0 = new Date("2026-09-10T06:00:00.000Z");
const HOUR = 3_600_000;

const inboxNotifs = (businessId: number) =>
  prisma.notification.findMany({
    where: { businessId, domain: "inbox" },
    orderBy: { id: "asc" },
    include: { deliveries: true },
  });

/**
 * Exactly what the intake service does: persist the message and bump the
 * conversation counters in ONE tenant transaction, then reconcile afterwards.
 */
async function inboundThenSync(
  businessId: number,
  conversationId: number,
  customerId: number,
  text: string,
  now: Date,
) {
  const message = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          businessId,
          customerId,
          channel: "WHATSAPP",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          messageType: "text",
          contentText: text,
          sentAt: now,
        },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          customerLastInboundAt: now,
          unansweredInboundCount: { increment: 1 },
        },
      });
      return created;
    }),
  );
  const sync = await runWithTenantContext({ businessId }, () =>
    syncInboxWaitingNotifications(businessId, now),
  );
  return { message, sync };
}

/** What `/api/message` does for anything that is not an inbound customer message. */
async function outboundThenSync(
  businessId: number,
  conversationId: number,
  senderType: "BUSINESS_USER" | "AI" | "SYSTEM",
  text: string,
  now: Date,
) {
  const message = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.message.create({
        data: {
          conversationId,
          businessId,
          channel: "WHATSAPP",
          direction: "OUTBOUND",
          senderType,
          messageType: "text",
          contentText: text,
          sentAt: now,
        },
      }),
    ),
  );
  const sync = await runWithTenantContext({ businessId }, () =>
    syncInboxWaitingNotifications(businessId, now),
  );
  return { message, sync };
}

/** What both conversation-close routes do. */
async function closeThenSync(businessId: number, conversationId: number, now: Date) {
  await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.conversation.update({
        where: { id: conversationId },
        data: { status: "CLOSED", closedAt: now },
      }),
    ),
  );
  return runWithTenantContext({ businessId }, () =>
    syncInboxWaitingNotifications(businessId, now),
  );
}

(async () => {
  const a = await prisma.business.create({ data: { name: "inbox-consumer-A" } });
  const b = await prisma.business.create({ data: { name: "inbox-consumer-B" } });

  const mkConversation = async (businessId: number, customerName: string) => {
    const customer = await prisma.customer.create({
      data: { businessId, name: customerName },
    });
    const conversation = await prisma.conversation.create({
      data: { businessId, customerId: customer.id, channel: "WHATSAPP", status: "OPEN" },
    });
    return { customer, conversation };
  };

  const a1 = await mkConversation(a.id, "Dana");
  const a2 = await mkConversation(a.id, "Yossi");
  const b1 = await mkConversation(b.id, "Rivka");

  /** Businesses created mid-test, so the cleanup below can still find them. */
  const extraBusinessIds: number[] = [];

  try {
    /* ── 1. first inbound message opens exactly one notification ───────────── */
    const first = await inboundThenSync(a.id, a1.conversation.id, a1.customer.id, "היי, יש לכם במלאי?", T0);
    check("the inbound message itself committed", first.message.id > 0 && first.sync.ok);

    let rows = await inboxNotifs(a.id);
    check("exactly one notification was persisted", rows.length === 1, `count=${rows.length}`);
    check("it is the inbox waiting fact",
      rows[0]?.semanticCategory === "ACTION_REQUIRED" && rows[0]?.severity === "HIGH",
      `${rows[0]?.semanticCategory}/${rows[0]?.severity}`);
    check("identity is the CONVERSATION",
      rows[0]?.entityType === "conversation" && rows[0]?.entityId === a1.conversation.id,
      `${rows[0]?.entityType}:${rows[0]?.entityId}`);
    check("dedupe key is the logical condition",
      rows[0]?.dedupeKey === `b${a.id}:inbox:ACTION_REQUIRED:conversation:${a1.conversation.id}`,
      rows[0]?.dedupeKey);
    check("it links to the inbox", rows[0]?.href === "/inbox", rows[0]?.href);
    check("it is open", rows[0]?.resolvedAt === null);
    const notificationId = rows[0]!.id;

    /* ── 2. channels: in-app only, and nothing is ever sent ────────────────── */
    check("policy granted IN_APP only",
      JSON.stringify(rows[0]?.intendedChannels) === '["IN_APP"]',
      JSON.stringify(rows[0]?.intendedChannels));
    check("NO PUSH delivery exists for inbox",
      rows[0]?.deliveries.every((d) => d.channel !== "PUSH") === true);
    check("the IN_APP delivery is SENT — the row existing IS the delivery",
      rows[0]?.deliveries.find((d) => d.channel === "IN_APP")?.status === "SENT");
    check("exactly one delivery row", rows[0]?.deliveries.length === 1, `n=${rows[0]?.deliveries.length}`);
    check("the cooldown is the policy's twelve hours", rows[0]?.cooldownHours === 12,
      String(rows[0]?.cooldownHours));

    /* ── 3. a burst before anyone answers is still ONE notification ────────── */
    await inboundThenSync(a.id, a1.conversation.id, a1.customer.id, "הודעה שנייה", new Date(T0.getTime() + 60_000));
    await inboundThenSync(a.id, a1.conversation.id, a1.customer.id, "הודעה שלישית", new Date(T0.getTime() + 120_000));
    const burst = await inboundThenSync(a.id, a1.conversation.id, a1.customer.id, "הודעה רביעית", new Date(T0.getTime() + 180_000));

    check("four inbound messages exist on the conversation",
      (await prisma.message.count({
        where: { conversationId: a1.conversation.id, direction: "INBOUND" },
      })) === 4);
    rows = await inboxNotifs(a.id);
    check("a burst produces NO extra notification rows", rows.length === 1, `count=${rows.length}`);
    check("it is still the same notification row", rows[0]?.id === notificationId);
    check("the burst never re-notified — the cooldown held",
      burst.sync.written.every((w) => w.withinCooldown), JSON.stringify(burst.sync.written.map((w) => w.withinCooldown)));
    check("no second delivery was written", rows[0]?.deliveries.length === 1);

    /* ── 4. reading it does not resolve it, and a burst does not un-read it ── */
    await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date(T0.getTime() + 200_000) },
    });
    await inboundThenSync(a.id, a1.conversation.id, a1.customer.id, "הודעה חמישית", new Date(T0.getTime() + 240_000));
    rows = await inboxNotifs(a.id);
    check("readAt survives a sync inside the cooldown", rows[0]?.readAt !== null);
    check("read is still not resolved", rows[0]?.resolvedAt === null);

    /* ── 5. a second conversation is a second notification ─────────────────── */
    await inboundThenSync(a.id, a2.conversation.id, a2.customer.id, "שאלה אחרת", new Date(T0.getTime() + 300_000));
    rows = await inboxNotifs(a.id);
    check("a different conversation gets its own notification", rows.length === 2, `count=${rows.length}`);
    check("the two identities are distinct",
      rows[0]?.dedupeKey !== rows[1]?.dedupeKey);

    /* ── 6. tenant isolation ───────────────────────────────────────────────── */
    await inboundThenSync(b.id, b1.conversation.id, b1.customer.id, "עסק אחר", new Date(T0.getTime() + 360_000));
    const bRows = await inboxNotifs(b.id);
    check("business B has its own notification", bRows.length === 1, `count=${bRows.length}`);
    check("B's key carries B's id", bRows[0]?.dedupeKey.startsWith(`b${b.id}:`), bRows[0]?.dedupeKey);
    check("A's rows never leaked into B",
      bRows.every((r) => r.businessId === b.id));
    check("A still has exactly its own two",
      (await inboxNotifs(a.id)).length === 2);
    check("syncing B did not touch A's notifications",
      (await prisma.notification.count({ where: { businessId: a.id, resolvedAt: { not: null } } })) === 0);

    /* ── 7. an owner reply resolves it ─────────────────────────────────────── */
    const reply = await outboundThenSync(a.id, a1.conversation.id, "BUSINESS_USER", "היי דנה, כן!", new Date(T0.getTime() + 400_000));
    check("the reply committed", reply.message.id > 0 && reply.sync.ok);
    check("the sync closed exactly one notification", reply.sync.resolved === 1, String(reply.sync.resolved));
    let one = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    check("the answered conversation's notification is resolved", one.resolvedAt !== null);
    check("resolution did NOT delete it — it is history",
      (await prisma.notification.count({ where: { id: notificationId } })) === 1);
    check("the other conversation stays open",
      (await prisma.notification.count({
        where: { businessId: a.id, entityId: a2.conversation.id, resolvedAt: null },
      })) === 1);

    /* ── 8. a bot answer counts too — the customer is not waiting on a human ─ */
    const botReply = await outboundThenSync(a.id, a2.conversation.id, "AI", "אשמח לעזור", new Date(T0.getTime() + 440_000));
    check("an AI reply also resolves the wait", botReply.sync.resolved === 1, String(botReply.sync.resolved));
    check("nothing in business A is left open",
      (await prisma.notification.count({ where: { businessId: a.id, resolvedAt: null } })) === 0);

    /* ── 9. the customer writes again: the SAME identity reopens ───────────── */
    const later = new Date(T0.getTime() + 13 * HOUR); // past the 12h cooldown
    const reopen = await inboundThenSync(a.id, a1.conversation.id, a1.customer.id, "עוד שאלה", later);
    rows = await inboxNotifs(a.id);
    check("no new row was created for the reopened condition", rows.length === 2, `count=${rows.length}`);
    one = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    check("the SAME notification row reopened", one.resolvedAt === null);
    check("the writer reported a reopen",
      reopen.sync.written.some((w) => w.notificationId === notificationId && w.reopened));
    check("past its cooldown it notified again",
      reopen.sync.written.some((w) => w.notificationId === notificationId && w.notified));
    check("a genuine re-notification reads as news again", one.readAt === null);
    check("a second delivery was written for the new notification",
      (await prisma.notificationDelivery.count({ where: { notificationId } })) === 2);

    /* ── 10. closing the conversation resolves it as well ──────────────────── */
    const closed = await closeThenSync(a.id, a1.conversation.id, new Date(later.getTime() + HOUR));
    check("closing resolved the notification", closed.resolved === 1, String(closed.resolved));
    one = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    check("a closed conversation leaves nothing waiting", one.resolvedAt !== null);
    check("the history row survives the close",
      (await inboxNotifs(a.id)).length === 2);

    /* ── 11. a closed conversation cannot reopen the wait ──────────────────── */
    const afterClose = await inboundThenSync(
      a.id, a1.conversation.id, a1.customer.id, "הודעה אחרי סגירה", new Date(later.getTime() + 2 * HOUR),
    );
    check("the message still committed", afterClose.message.id > 0);
    one = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    check("a CLOSED conversation is not waiting, so nothing reopened", one.resolvedAt !== null);

    /* ── 12. repeated syncs are idempotent ─────────────────────────────────── */
    const beforeReplay = await inboxNotifs(a.id);
    for (let i = 0; i < 3; i++) {
      await runWithTenantContext({ businessId: a.id }, () =>
        syncInboxWaitingNotifications(a.id, new Date(later.getTime() + 3 * HOUR)),
      );
    }
    const afterReplay = await inboxNotifs(a.id);
    check("replaying the sync creates no rows", afterReplay.length === beforeReplay.length,
      `${beforeReplay.length} -> ${afterReplay.length}`);
    check("replaying the sync creates no deliveries",
      (await prisma.notificationDelivery.count({ where: { businessId: a.id } })) ===
        beforeReplay.reduce((n, r) => n + r.deliveries.length, 0));

    /* ── 13. duplicate inbound delivery does not duplicate the notification ── */
    const c = await prisma.business.create({ data: { name: "inbox-consumer-C-replay" } });
    extraBusinessIds.push(c.id);
    const c1 = await mkConversation(c.id, "Noa");
    const dupTime = new Date(T0.getTime() + 500_000);
    await inboundThenSync(c.id, c1.conversation.id, c1.customer.id, "הודעה כפולה", dupTime);
    await inboundThenSync(c.id, c1.conversation.id, c1.customer.id, "הודעה כפולה", dupTime);
    const cRows = await inboxNotifs(c.id);
    check("a redelivered message yields ONE notification", cRows.length === 1, `count=${cRows.length}`);
    check("and one delivery", cRows[0]?.deliveries.length === 1);

    /* ── 14. failure isolation: a failing sync never undoes the message ────── */
    // Real failure, not a stub: the loaders refuse to run without a tenant
    // context, which is exactly what a mis-wired producer would hit.
    const before = await prisma.message.count({ where: { businessId: c.id } });
    const failed = await syncInboxWaitingNotifications(c.id, dupTime);
    check("the sync failed", failed.ok === false && typeof failed.error === "string");
    check("it reported the failure as data rather than throwing", failed.written.length === 0 && failed.resolved === 0);
    check("the messages are all still committed",
      (await prisma.message.count({ where: { businessId: c.id } })) === before, `${before}`);
    check("the conversation is untouched",
      (await prisma.conversation.findUniqueOrThrow({ where: { id: c1.conversation.id } })).status === "OPEN");
    check("no notification was corrupted by the failure",
      (await inboxNotifs(c.id)).length === 1);

    /* ── 15. a failing resolution sync never undoes the reply ──────────────── */
    const outbound = await runWithTenantContext({ businessId: c.id }, () =>
      withTenantTransaction((tx) =>
        tx.message.create({
          data: {
            conversationId: c1.conversation.id,
            businessId: c.id,
            channel: "WHATSAPP",
            direction: "OUTBOUND",
            senderType: "BUSINESS_USER",
            contentText: "תשובה",
            sentAt: dupTime,
          },
        }),
      ),
    );
    const failedResolve = await syncInboxWaitingNotifications(c.id, dupTime);
    check("the resolution sync failed", failedResolve.ok === false);
    check("the reply is still committed",
      (await prisma.message.count({ where: { id: outbound.id } })) === 1);
    check("the notification simply stayed open — no silent corruption",
      (await inboxNotifs(c.id))[0]?.resolvedAt === null);

    /* ── 16. the consumer stays inside its own domain ──────────────────────── */
    check("no non-inbox notification was ever written by these syncs",
      (await prisma.notification.count({
        where: { businessId: { in: [a.id, b.id, c.id] }, domain: { not: "inbox" } },
      })) === 0);

  } finally {
    const ids = [a.id, b.id, ...extraBusinessIds];
    await prisma.business.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }

  console.log(
    failures === 0
      ? `\nINBOX-WAITING CONSUMER: all checks passed\n`
      : `\nINBOX-WAITING CONSUMER: ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("integration harness error:", err);
  process.exit(1);
});
