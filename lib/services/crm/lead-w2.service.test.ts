/**
 * Leads W2 — action-loop integration test.
 *
 * Covers the two things W2 adds to the service layer: the attention queue
 * (which leads surface, and how many), and turning a conversation into a lead
 * without ever producing a duplicate.
 *
 * Needs a dev DB with the Leads W1 migration applied.
 * Run: npx tsx lib/services/crm/lead-w2.service.test.ts
 */
import assert from "node:assert/strict";

import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NotFoundError } from "@/lib/errors";
import { leadService, LEAD_EVENTS } from "@/lib/services/crm/lead.service";
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const stamp = String(Date.now()).slice(-7);

let passed = 0;
const ok = (l: string) => {
  passed += 1;
  console.log(`  ok  ${l}`);
};
function check(cond: boolean, label: string, detail = "assertion failed") {
  assert.equal(cond, true, `${label}: ${detail}`);
  ok(label);
}

async function tenant(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `LEADS W2 ${label} ${runId}`,
      users: {
        create: {
          email: `leads-w2-${label}-${runId}@example.test`,
          password: "test-password",
          name: "W2 Test User",
        },
      },
    },
    include: { users: true },
  });
  return { businessId: business.id, userId: business.users[0].id };
}

function asTenant<T>(businessId: number, fn: (tx: never) => Promise<T>): Promise<T> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) => fn(tx as never))
  );
}

async function expectRejection(
  label: string,
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean
) {
  let threw: unknown = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert.notEqual(threw, null, `${label}: expected a rejection`);
  assert.equal(predicate(threw), true, `${label}: wrong error — ${String(threw)}`);
  ok(label);
}

/** A conversation with one inbound customer message, as WhatsApp intake makes. */
async function seedConversation(
  businessId: number,
  phone: string,
  name: string,
  text: string
) {
  const customer = await prisma.customer.create({
    data: { businessId, name, phone },
  });
  const conversation = await prisma.conversation.create({
    data: {
      businessId,
      customerId: customer.id,
      channel: "WHATSAPP",
      status: "OPEN",
      startedAt: new Date(),
    },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      businessId,
      customerId: customer.id,
      channel: "WHATSAPP",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentText: text,
    },
  });
  return { customer, conversation };
}

async function main() {
  const a = await tenant("A");
  const b = await tenant("B");

  try {
    /* ================================ conversation -> lead (scenarios E–G) == */

    const seedA = await seedConversation(
      a.businessId,
      `97250${stamp}`,
      "דנה מוואטסאפ",
      "היי, כמה עולה ניקוי ספות?"
    );

    const first = await asTenant(a.businessId, (tx) =>
      leadService.createFromConversation(
        { businessId: a.businessId, conversationId: seedA.conversation.id },
        { tx }
      )
    );

    check(first.outcome === "created", "E1 a conversation with no lead creates one", first.outcome);
    check(
      first.lead.customerId === seedA.customer.id,
      "E2 the lead is linked to the conversation's customer"
    );
    check(
      first.lead.sourceChannel === "WHATSAPP",
      "E3 source is derived from the conversation channel",
      String(first.lead.sourceChannel)
    );
    check(
      first.lead.intentSnapshot === "היי, כמה עולה ניקוי ספות?",
      "E4 the first inbound message becomes the intent snapshot",
      String(first.lead.intentSnapshot)
    );

    const linkedConv = await prisma.conversation.findFirstOrThrow({
      where: { id: seedA.conversation.id },
    });
    check(linkedConv.leadId === first.lead.id, "E5 Conversation.leadId is actually set");

    // CONTEXT, NOT COPIES.
    const messagesOnA = await prisma.message.count({
      where: { conversationId: seedA.conversation.id },
    });
    check(messagesOnA === 1, "E6 no message history was duplicated into the lead");

    /* --- F: run it again --- */
    const second = await asTenant(a.businessId, (tx) =>
      leadService.createFromConversation(
        { businessId: a.businessId, conversationId: seedA.conversation.id },
        { tx }
      )
    );
    check(second.outcome === "already_linked", "F1 a second call reports already_linked", second.outcome);
    check(second.lead.id === first.lead.id, "F2 it returns the SAME lead");

    const leadCountAfter = await prisma.lead.count({ where: { businessId: a.businessId } });
    check(leadCountAfter === 1, "F3 no duplicate lead was created", `count=${leadCountAfter}`);

    /* --- G: a second conversation for a customer who already has an open lead --- */
    const secondConv = await prisma.conversation.create({
      data: {
        businessId: a.businessId,
        customerId: seedA.customer.id,
        channel: "WHATSAPP",
        status: "OPEN",
        startedAt: new Date(),
      },
    });
    const adopted = await asTenant(a.businessId, (tx) =>
      leadService.createFromConversation(
        { businessId: a.businessId, conversationId: secondConv.id },
        { tx }
      )
    );
    check(
      adopted.outcome === "linked_existing",
      "G1 a new conversation adopts the contact's existing OPEN lead",
      adopted.outcome
    );
    check(adopted.lead.id === first.lead.id, "G2 it is the same lead, not a second one");
    check(
      (await prisma.lead.count({ where: { businessId: a.businessId } })) === 1,
      "G3 still exactly one lead for this contact"
    );

    /* --- closed lead does NOT get adopted --- */
    await asTenant(a.businessId, (tx) =>
      leadService.updateLeadStatus(
        { businessId: a.businessId, leadId: first.lead.id, status: "WON" },
        { tx }
      )
    );
    const thirdConv = await prisma.conversation.create({
      data: {
        businessId: a.businessId,
        customerId: seedA.customer.id,
        channel: "WHATSAPP",
        status: "OPEN",
        startedAt: new Date(),
      },
    });
    const afterClose = await asTenant(a.businessId, (tx) =>
      leadService.createFromConversation(
        { businessId: a.businessId, conversationId: thirdConv.id },
        { tx }
      )
    );
    check(
      afterClose.outcome === "created" && afterClose.lead.id !== first.lead.id,
      "G4 a CLOSED lead is not adopted — the next enquiry starts a fresh one",
      afterClose.outcome
    );

    /* ================================ H. cross-tenant ====================== */

    await expectRejection(
      "H1 tenant B cannot turn tenant A's conversation into a lead",
      () =>
        asTenant(b.businessId, (tx) =>
          leadService.createFromConversation(
            { businessId: b.businessId, conversationId: thirdConv.id },
            { tx }
          )
        ),
      (err) => err instanceof NotFoundError
    );

    const bLeads = await prisma.lead.count({ where: { businessId: b.businessId } });
    check(bLeads === 0, "H2 the refused attempt mutated nothing in tenant B", `count=${bLeads}`);
    const stillLinked = await prisma.conversation.findFirstOrThrow({ where: { id: thirdConv.id } });
    check(
      stillLinked.leadId === afterClose.lead.id && stillLinked.businessId === a.businessId,
      "H3 tenant A's conversation link is untouched"
    );

    /* ================================ attention queue ====================== */

    // Backdate: an overdue follow-up, and an untouched new lead from yesterday.
    const overdueLead = await asTenant(a.businessId, (tx) =>
      leadService.createLead(
        { businessId: a.businessId, name: "W2 overdue", phone: `97251${stamp}` },
        { tx }
      )
    );
    await prisma.lead.update({
      where: { id: overdueLead.id },
      data: { nextFollowUpAt: new Date(Date.now() - 3 * 86400000) },
    });

    const staleNew = await asTenant(a.businessId, (tx) =>
      leadService.createLead(
        { businessId: a.businessId, name: "W2 stale new", phone: `97252${stamp}` },
        { tx }
      )
    );
    await prisma.lead.update({
      where: { id: staleNew.id },
      data: { createdAt: new Date(Date.now() - 4 * 86400000) },
    });

    // A fresh lead created just now must NOT be in the queue.
    const freshLead = await asTenant(a.businessId, (tx) =>
      leadService.createLead(
        { businessId: a.businessId, name: "W2 fresh", phone: `97253${stamp}` },
        { tx }
      )
    );

    const queue = await asTenant(a.businessId, (tx) =>
      leadService.listLeads({ businessId: a.businessId, needsAction: true }, { tx })
    );
    const queueIds = queue.map((l) => l.id);
    check(queueIds.includes(overdueLead.id), "A1 an overdue follow-up is in the queue");
    check(queueIds.includes(staleNew.id), "A2 an untouched new lead from before today is in the queue");
    check(!queueIds.includes(freshLead.id), "A3 a lead created moments ago is NOT in the queue");
    check(!queueIds.includes(first.lead.id), "A4 a CLOSED lead is never in the queue");

    const count = await asTenant(a.businessId, (tx) =>
      leadService.countNeedingAttention({ businessId: a.businessId }, { tx })
    );
    check(
      count === queue.length,
      "A5 the Home count and the queue agree exactly",
      `count=${count} queue=${queue.length}`
    );

    // The SQL and the pure evaluator must reach the same verdict.
    for (const row of queue) {
      const full = await prisma.lead.findFirstOrThrow({ where: { id: row.id } });
      const verdict = evaluateLeadAttention(
        {
          status: full.status as LeadStatusValue,
          nextFollowUpAt: full.nextFollowUpAt,
          createdAt: full.createdAt,
        },
        new Date()
      );
      assert.equal(
        verdict.needsAttention,
        true,
        `SQL surfaced lead ${row.id} but the evaluator disagrees`
      );
    }
    ok("A6 every row the SQL surfaced is confirmed by the pure evaluator");

    const bCount = await asTenant(b.businessId, (tx) =>
      leadService.countNeedingAttention({ businessId: b.businessId }, { tx })
    );
    check(bCount === 0, "A7 the attention count is tenant-scoped", `bCount=${bCount}`);

    /* --- complete / reschedule --- */
    await asTenant(a.businessId, (tx) =>
      leadService.clearFollowUp({ businessId: a.businessId, leadId: overdueLead.id }, { tx })
    );
    const afterComplete = await asTenant(a.businessId, (tx) =>
      leadService.countNeedingAttention({ businessId: a.businessId }, { tx })
    );
    check(afterComplete === count - 1, "C1 completing a follow-up drops it from the count");

    await asTenant(a.businessId, (tx) =>
      leadService.setFollowUp(
        {
          businessId: a.businessId,
          leadId: staleNew.id,
          followUpAt: new Date(Date.now() + 5 * 86400000).toISOString(),
        },
        { tx }
      )
    );
    const afterReschedule = await asTenant(a.businessId, (tx) =>
      leadService.countNeedingAttention({ businessId: a.businessId }, { tx })
    );
    check(
      afterReschedule === afterComplete - 1,
      "D1 rescheduling into the future drops it from the queue now",
      `${afterReschedule} vs ${afterComplete}`
    );

    /* ================================ events =============================== */

    const events = await prisma.learningEvent.findMany({
      where: { businessId: a.businessId, entityType: "LEAD" },
      select: { eventType: true },
    });
    const types = new Set(events.map((e) => e.eventType));
    for (const expected of [
      LEAD_EVENTS.CREATED_FROM_CONVERSATION,
      LEAD_EVENTS.CONVERSATION_LINKED,
      LEAD_EVENTS.FOLLOWUP_COMPLETED,
    ]) {
      check(types.has(expected), `EV ${expected} recorded via the existing LearningEvent log`);
    }

    const linkEvents = events.filter(
      (e) => e.eventType === LEAD_EVENTS.CONVERSATION_LINKED
    ).length;
    check(
      linkEvents === 3,
      "EV one link event per conversation actually linked — no duplicates from the repeat call",
      `got ${linkEvents}`
    );

    console.log(`\nLEAD W2 VERIFY PASS — ${passed} checks green.`);
  } finally {
    await prisma.business
      .deleteMany({ where: { id: { in: [a.businessId, b.businessId] } } })
      .catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error("\nLEAD W2 VERIFY FAIL");
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
