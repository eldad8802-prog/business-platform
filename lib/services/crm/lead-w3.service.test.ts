/**
 * Leads W3 — auto-capture and durable evidence, against a real database.
 *
 * The pure rules live in `lead-intelligence.test.ts` and run in CI. This suite
 * covers the parts that only a database can answer: does an inbound message
 * really become exactly one lead, does a replay really stay at one, does the
 * flag really hold the whole thing shut, and does the evidence a future
 * analytics engine will depend on really land.
 *
 * It creates its own businesses and cleans up after itself.
 *
 *   DATABASE_URL=... npx tsx lib/services/crm/lead-w3.service.test.ts
 */

import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { leadService } from "@/lib/services/crm/lead.service";
import {
  maybeCaptureLeadFromMessage,
  isLeadAutoCaptureEnabled,
} from "@/lib/services/crm/lead-auto-capture.service";
import {
  recordConversationEvidence,
  CONVERSATION_EVIDENCE_EVENTS,
} from "@/lib/services/conversation/conversation-evidence.service";
import { getLeadCard } from "@/lib/services/crm/lead-card.read-model";

const runId = `${Date.now()}`.slice(-9);
const stamp = runId.slice(-7);

let passed = 0;
const failures: string[] = [];
const ok = (l: string) => {
  passed += 1;
  console.log(`  ok  ${l}`);
};
const bad = (l: string, d = "") => {
  failures.push(`${l}${d ? ` — ${d}` : ""}`);
  console.log(`  FAIL  ${l}${d ? ` — ${d}` : ""}`);
};
const check = (c: boolean, l: string, d = "") => (c ? ok(l) : bad(l, d));

function asTenant<T>(businessId: number, fn: (tx: never) => Promise<T>): Promise<T> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) => fn(tx as never), { timeoutMs: 20000 })
  );
}

async function createBusiness(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `LEADS W3 ${label} ${runId}`,
      users: {
        create: {
          email: `leads-w3-${label}-${runId}@example.test`,
          password: "test-password",
          name: "Leads W3 Test User",
        },
      },
    },
  });
  return business.id;
}

async function seedConversation(
  businessId: number,
  suffix: string,
  over: { name?: string | null } = {}
) {
  const customer = await prisma.customer.create({
    data: {
      businessId,
      name: over.name === undefined ? `לקוח ${suffix}` : (over.name as string),
      phone: `9725${stamp}${suffix}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      businessId,
      customerId: customer.id,
      channel: "WHATSAPP",
      status: "OPEN",
      currentStage: "NEW",
      startedAt: new Date(),
    },
  });
  return { customerId: customer.id, conversation };
}

async function addMessage(
  businessId: number,
  conversationId: number,
  customerId: number,
  over: Partial<{ direction: string; senderType: string; contentText: string | null }> = {}
) {
  return prisma.message.create({
    data: {
      businessId,
      conversationId,
      customerId,
      channel: "WHATSAPP",
      messageType: "TEXT",
      direction: (over.direction ?? "INBOUND") as never,
      senderType: (over.senderType ?? "CUSTOMER") as never,
      contentText: over.contentText === undefined ? "שלום, כמה זה עולה?" : over.contentText,
    },
  });
}

const withFlag = async <T,>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const previous = process.env.LEADS_AUTO_CAPTURE_ENABLED;
  if (value === undefined) delete process.env.LEADS_AUTO_CAPTURE_ENABLED;
  else process.env.LEADS_AUTO_CAPTURE_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LEADS_AUTO_CAPTURE_ENABLED;
    else process.env.LEADS_AUTO_CAPTURE_ENABLED = previous;
  }
};

async function main() {
  console.log("\nLeads W3 — auto-capture + durable evidence\n");

  const businessA = await createBusiness("A");
  const businessB = await createBusiness("B");

  /* ═════════════════════ the flag holds it shut ═══════════════════════════ */

  check(isLeadAutoCaptureEnabled() === false, "F1 auto-capture is OFF unless the flag says otherwise");

  {
    const { customerId, conversation } = await seedConversation(businessA, "1");
    const message = await addMessage(businessA, conversation.id, customerId);

    for (const [value, label] of [
      [undefined, "absent"],
      ["false", '"false"'],
      ["1", '"1"'],
      ["TRUE ", '"TRUE " (trims and lowercases → enabled)'],
    ] as const) {
      const result = await withFlag(value, () =>
        asTenant(businessA, async (tx) =>
          maybeCaptureLeadFromMessage({ businessId: businessA, conversation, message }, { tx })
        )
      );
      if (value === "TRUE ") {
        check(result.captured === true, `F2 the flag ${label}`, JSON.stringify(result));
      } else {
        check(
          result.captured === false && result.reason === "flag_disabled",
          `F2 the flag ${label} → no capture`,
          JSON.stringify(result)
        );
      }
    }

    // Clean the lead that the "TRUE " case legitimately created.
    await prisma.lead.deleteMany({ where: { businessId: businessA } });
    await prisma.conversation.updateMany({
      where: { id: conversation.id },
      data: { leadId: null },
    });
  }

  /* ═════════════════════ capture: what creates a lead ═════════════════════ */

  await withFlag("true", async () => {
    {
      const { customerId, conversation } = await seedConversation(businessA, "2");
      const message = await addMessage(businessA, conversation.id, customerId);

      const first = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage({ businessId: businessA, conversation, message }, { tx })
      );
      check(first.captured === true, "C1 a first inbound customer message creates a lead", JSON.stringify(first));
      check(
        first.captured === true && first.outcome === "created",
        "C2 and reports it as a creation",
        JSON.stringify(first)
      );

      // Replay the SAME message. The conversation now carries the lead, so the
      // cheap guard refuses; even without it `createFromConversation` is
      // idempotent.
      const replay = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage(
          {
            businessId: businessA,
            conversation: await tx2Conversation(tx, conversation.id),
            message,
          },
          { tx }
        )
      );
      check(
        replay.captured === false && replay.reason === "already_linked",
        "C3 replaying the same message does not create a second lead",
        JSON.stringify(replay)
      );

      const leads = await prisma.lead.count({ where: { businessId: businessA } });
      check(leads === 1, "C4 exactly ONE lead exists for that conversation", `got ${leads}`);

      // A second inbound on the same thread also must not duplicate.
      const second = await addMessage(businessA, conversation.id, customerId, {
        contentText: "עוד שאלה",
      });
      const again = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage(
          {
            businessId: businessA,
            conversation: await tx2Conversation(tx, conversation.id),
            message: second,
          },
          { tx }
        )
      );
      check(again.captured === false, "C5 a second inbound on a captured thread captures nothing", JSON.stringify(again));
      const leadsAfter = await prisma.lead.count({ where: { businessId: businessA } });
      check(leadsAfter === 1, "C6 and the lead count is still one", `got ${leadsAfter}`);
    }

    /* ═══════════════════ capture: what must NOT create ═══════════════════ */

    {
      const { customerId, conversation } = await seedConversation(businessA, "3");
      const outbound = await addMessage(businessA, conversation.id, customerId, {
        direction: "OUTBOUND",
        senderType: "BUSINESS_USER",
        contentText: "שלום, איך אפשר לעזור?",
      });
      const r = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage({ businessId: businessA, conversation, message: outbound }, { tx })
      );
      check(
        r.captured === false && r.reason === "not_customer_inbound",
        "N1 an OUTBOUND message never creates a lead",
        JSON.stringify(r)
      );
    }

    {
      const { customerId, conversation } = await seedConversation(businessA, "4");
      const system = await addMessage(businessA, conversation.id, customerId, {
        senderType: "SYSTEM",
        contentText: "conversation started",
      });
      const r = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage({ businessId: businessA, conversation, message: system }, { tx })
      );
      check(
        r.captured === false && r.reason === "not_customer_inbound",
        "N2 a SYSTEM message never creates a lead",
        JSON.stringify(r)
      );
    }

    {
      const { customerId, conversation } = await seedConversation(businessA, "5");
      const empty = await addMessage(businessA, conversation.id, customerId, { contentText: "   " });
      const r = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage({ businessId: businessA, conversation, message: empty }, { tx })
      );
      check(
        r.captured === false && r.reason === "empty_message",
        "N3 an empty message never creates a lead",
        JSON.stringify(r)
      );
    }

    {
      // Tenant safety: B's message can never be evidence about A's conversation.
      const a = await seedConversation(businessA, "6");
      const b = await seedConversation(businessB, "7");
      const foreign = await addMessage(businessB, b.conversation.id, b.customerId);
      const r = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage(
          { businessId: businessA, conversation: a.conversation, message: foreign },
          { tx }
        )
      );
      check(
        r.captured === false && r.reason === "tenant_mismatch",
        "N4 a message from another business is refused as evidence",
        JSON.stringify(r)
      );
      const bLeads = await prisma.lead.count({ where: { businessId: businessB } });
      check(bLeads === 0, "N5 and the refusal wrote nothing anywhere", `got ${bLeads}`);
    }

    /* ═══════════════════ identity: closed lead, new inquiry ══════════════ */

    {
      const { customerId, conversation } = await seedConversation(businessA, "8");
      const message = await addMessage(businessA, conversation.id, customerId);
      const created = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage({ businessId: businessA, conversation, message }, { tx })
      );
      assert.equal(created.captured, true);
      const leadId = created.captured ? created.leadId : 0;

      // Win it, then a brand-new inquiry arrives on a NEW conversation.
      await asTenant(businessA, async (tx) =>
        leadService.updateLeadStatus({ businessId: businessA, leadId, status: "WON" }, { tx })
      );

      const second = await prisma.conversation.create({
        data: {
          businessId: businessA,
          customerId,
          channel: "WHATSAPP",
          status: "OPEN",
          currentStage: "NEW",
          startedAt: new Date(),
        },
      });
      const newInquiry = await addMessage(businessA, second.id, customerId, {
        contentText: "היי, יש לי פרויקט חדש",
      });
      const reopened = await asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage(
          { businessId: businessA, conversation: second, message: newInquiry },
          { tx }
        )
      );
      check(
        reopened.captured === true && reopened.leadId !== leadId,
        "I1 a new inquiry after a WON lead creates a NEW opportunity, not a reopening",
        JSON.stringify(reopened)
      );
      const won = await prisma.lead.findUnique({ where: { id: leadId } });
      check(won?.status === "WON", "I2 and the won lead stays won", `got ${won?.status}`);
    }
  });

  /* ═════════════════════════ durable evidence ═════════════════════════════ */

  {
    const { customerId, conversation } = await seedConversation(businessA, "9");
    const inbound = await addMessage(businessA, conversation.id, customerId);

    const before = await prisma.learningEvent.count({
      where: { businessId: businessA, entityType: "CONVERSATION" },
    });

    const r1 = await asTenant(businessA, async (tx) =>
      recordConversationEvidence(
        {
          businessId: businessA,
          conversationId: conversation.id,
          messageId: inbound.id,
          leadId: null,
          channel: "WHATSAPP",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          occurredAt: new Date(),
          state: {
            stageBefore: "NEW",
            stageAfter: "QUALIFIED",
            temperatureBefore: 0.5,
            temperatureAfter: 0.85,
          },
        },
        { tx }
      )
    );

    check(
      r1.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.INBOUND_RECEIVED),
      "E1 an inbound message is recorded as conversation evidence",
      r1.emitted.join(",")
    );
    check(
      r1.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.BECAME_HOT),
      "E2 crossing into hot is recorded as a transition",
      r1.emitted.join(",")
    );
    check(
      r1.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.STAGE_ADVANCED),
      "E3 a stage change is recorded as a transition",
      r1.emitted.join(",")
    );

    const rows = await prisma.learningEvent.findMany({
      where: { businessId: businessA, entityType: "CONVERSATION" },
      orderBy: { id: "desc" },
      take: 3,
    });
    check(
      rows.every((r) => r.entityId === conversation.id),
      "E4 evidence is filed under the CONVERSATION, not the lead"
    );
    check(
      rows.length === r1.emitted.length && before + r1.emitted.length === before + rows.length,
      "E5 one row per emitted event"
    );

    // Already hot, already at that stage → a recomputation emits neither.
    const r2 = await asTenant(businessA, async (tx) =>
      recordConversationEvidence(
        {
          businessId: businessA,
          conversationId: conversation.id,
          messageId: inbound.id,
          direction: "INBOUND",
          senderType: "CUSTOMER",
          occurredAt: new Date(),
          state: {
            stageBefore: "QUALIFIED",
            stageAfter: "QUALIFIED",
            temperatureBefore: 0.85,
            temperatureAfter: 0.9,
          },
        },
        { tx }
      )
    );
    check(
      !r2.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.BECAME_HOT),
      "E6 a thread that is ALREADY hot does not 'become hot' again",
      r2.emitted.join(",")
    );
    check(
      !r2.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.STAGE_ADVANCED),
      "E7 an unchanged stage emits no transition",
      r2.emitted.join(",")
    );

    const outboundEv = await asTenant(businessA, async (tx) =>
      recordConversationEvidence(
        {
          businessId: businessA,
          conversationId: conversation.id,
          messageId: inbound.id,
          direction: "OUTBOUND",
          senderType: "BUSINESS_USER",
          occurredAt: new Date(),
          state: null,
        },
        { tx }
      )
    );
    check(
      outboundEv.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.BUSINESS_RESPONDED) &&
        !outboundEv.emitted.includes(CONVERSATION_EVIDENCE_EVENTS.INBOUND_RECEIVED),
      "E8 a business reply is recorded as a response, never as an inbound",
      outboundEv.emitted.join(",")
    );

    const payloads = await prisma.learningEvent.findMany({
      where: { businessId: businessA, entityType: "CONVERSATION" },
      take: 20,
    });
    check(
      payloads.every((p) => {
        const raw = JSON.stringify(p.payload ?? {});
        return !raw.includes("כמה זה עולה");
      }),
      "E9 no message text is copied into the evidence payload"
    );
  }

  /* ═══════════════════ the card surfaces the intelligence ═════════════════ */

  {
    const { customerId, conversation } = await seedConversation(businessA, "0");
    await addMessage(businessA, conversation.id, customerId);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unansweredInboundCount: 2,
        customerLastInboundAt: new Date(Date.now() - 30 * 60_000),
        temperatureScore: 0.9,
        lastMessageAt: new Date(),
        currentStage: "NEGOTIATION",
      },
    });
    const lead = await withFlag("true", () =>
      asTenant(businessA, async (tx) =>
        maybeCaptureLeadFromMessage(
          {
            businessId: businessA,
            conversation: await tx2Conversation(tx, conversation.id),
            message: await prisma.message.findFirstOrThrow({
              where: { conversationId: conversation.id },
            }),
          },
          { tx }
        )
      )
    );
    assert.equal(lead.captured, true);
    const leadId = lead.captured ? lead.leadId : 0;

    const card = await asTenant(businessA, async (tx) =>
      getLeadCard({ businessId: businessA, leadId }, { tx: tx as never })
    );

    check(card.intelligence != null, "X1 the lead card carries conversation intelligence");
    check(
      card.intelligence?.unansweredInboundCount === 2,
      "X2 with the real unanswered count",
      `got ${card.intelligence?.unansweredInboundCount}`
    );
    check(
      card.intelligence?.temperatureBucket === "hot",
      "X3 and the real temperature bucket",
      `got ${card.intelligence?.temperatureBucket}`
    );
    check(
      card.intelligence?.conversationStage === "NEGOTIATION",
      "X4 the conversation stage is reported as evidence",
      `got ${card.intelligence?.conversationStage}`
    );
    check(
      card.lead.status !== "NEGOTIATION" && card.lead.status === "NEW",
      "X5 AND THE LEAD STATUS IS UNCHANGED — evidence never mutates the owner's decision",
      `got ${card.lead.status}`
    );
    check(card.priority.score > 0, "X6 the card explains why the lead is in the queue", `got ${card.priority.score}`);
    check(
      !/[A-Z_]{4,}/.test(card.priority.label),
      "X7 in Hebrew, never an enum",
      card.priority.label
    );
  }

  /* ═══════════════════════════ cleanup ════════════════════════════════════ */

  for (const businessId of [businessA, businessB]) {
    await prisma.learningEvent.deleteMany({ where: { businessId } });
    await prisma.message.deleteMany({ where: { businessId } });
    await prisma.conversation.deleteMany({ where: { businessId } });
    await prisma.lead.deleteMany({ where: { businessId } });
    await prisma.customer.deleteMany({ where: { businessId } });
    await prisma.user.deleteMany({ where: { businessId } });
    await prisma.business.delete({ where: { id: businessId } });
  }
  ok("Z1 the suite removed everything it created");

  console.log(
    failures.length === 0
      ? `\nLEAD W3 VERIFY PASS — ${passed} checks green.\n`
      : `\nLEAD W3 VERIFY FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

/** Re-read a conversation inside the current tenant transaction. */
async function tx2Conversation(tx: never, id: number) {
  const db = tx as unknown as typeof prisma;
  return db.conversation.findFirstOrThrow({ where: { id } });
}

main().catch((err) => {
  console.error("\nSUITE ERROR:", err?.message || err);
  process.exit(2);
});
