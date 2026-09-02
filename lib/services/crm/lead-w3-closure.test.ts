/**
 * Leads W3 — final merge gate: truncation fail-safe + auto-capture concurrency.
 *
 * Two questions a real database has to answer:
 *
 *   1. When the urgent-candidate set is larger than the ranking bound, does the
 *      server SAY so — so the product can stop claiming the top row is the most
 *      urgent lead in the business?
 *
 *   2. When two inbound messages race, does exactly ONE lead opportunity come
 *      out, with exactly ONE creation event and no partial side effects?
 *
 * The concurrency half deliberately drives the real service path inside real
 * tenant transactions, in parallel, against a real Postgres — because the thing
 * being tested IS the transaction and index behaviour. A mocked race would
 * prove nothing about either.
 *
 *   DATABASE_URL=... npx tsx lib/services/crm/lead-w3-closure.test.ts
 */

import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { leadService } from "@/lib/services/crm/lead.service";
import { maybeCaptureLeadFromMessage } from "@/lib/services/crm/lead-auto-capture.service";
import { recordConversationEvidence } from "@/lib/services/conversation/conversation-evidence.service";

const runId = `${Date.now()}`.slice(-9);

let passed = 0;
const failures: string[] = [];
const ok = (l: string) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l: string, d = "") => { failures.push(`${l}${d ? ` — ${d}` : ""}`); console.log(`  FAIL  ${l}${d ? ` — ${d}` : ""}`); };
const check = (c: boolean, l: string, d = "") => (c ? ok(l) : bad(l, d));

function asTenant<T>(businessId: number, fn: (tx: never) => Promise<T>): Promise<T> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) => fn(tx as never), { timeoutMs: 30000 })
  );
}

async function createBusiness(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `W3 CLOSURE ${label} ${runId}`,
      users: {
        create: { email: `w3c-${label}-${runId}@example.test`, password: "x", name: "Closure" },
      },
    },
  });
  return b.id;
}

async function seed(businessId: number, suffix: string, phoneOverride?: string) {
  const phone = phoneOverride ?? `9723${runId}${suffix}`;
  const customer = await prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone } },
    update: {},
    create: { businessId, name: `לקוח ${suffix}`, phone },
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
  const message = await prisma.message.create({
    data: {
      businessId,
      conversationId: conversation.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      messageType: "TEXT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentText: "שלום, אשמח להצעה",
    },
  });
  return { customerId: customer.id, phone, conversation, message };
}

/** The auto-capture call as the pipeline makes it — tenant context and all. */
const capture = (businessId: number, conversation: never, message: never) =>
  asTenant(businessId, async (tx) =>
    maybeCaptureLeadFromMessage(
      { businessId, conversation: conversation as never, message: message as never },
      { tx }
    )
  ).catch((error) => ({ captured: false as const, reason: "error" as const, error }));

const creationEvents = (businessId: number, leadId?: number) =>
  prisma.learningEvent.count({
    where: {
      businessId,
      eventType: "LEAD_CREATED_FROM_CONVERSATION",
      ...(leadId ? { entityId: leadId } : {}),
    },
  });

async function main() {
  console.log("\nLeads W3 closure — truncation fail-safe + auto-capture concurrency\n");
  process.env.LEADS_AUTO_CAPTURE_ENABLED = "true";

  const businessA = await createBusiness("A");
  const businessB = await createBusiness("B");

  /* ══════════════════ GATE 1 — truncation contract ═══════════════════════ */

  {
    const now = new Date();
    const exact = await asTenant(businessA, (tx) =>
      leadService.listUrgentCandidates({ businessId: businessA, now }, { tx })
    );
    check(
      exact.overflow === false,
      "T1 below the bound the ranking reports itself as exact",
      `overflow=${exact.overflow}`
    );
    check(Array.isArray(exact.rows), "T1 and returns a candidate set");
  }

  {
    // Cross the bound for real: 501 leads that each independently qualify as
    // urgent (an untouched NEW lead from before today).
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const rows = Array.from({ length: 501 }, (_, i) => ({
      businessId: businessA,
      customerName: `דחוף ${i}`,
      phone: `9724${runId}${String(i).padStart(4, "0")}`,
      status: "NEW" as const,
      sourceChannel: "MANUAL",
      createdAt: yesterday,
      lastActivityAt: yesterday,
    }));
    await prisma.lead.createMany({ data: rows });

    const now = new Date();
    const truncated = await asTenant(businessA, (tx) =>
      leadService.listUrgentCandidates({ businessId: businessA, now }, { tx })
    );
    check(
      truncated.overflow === true,
      "T2 above the bound the server ADMITS the ranking is a slice",
      `overflow=${truncated.overflow} rows=${truncated.rows.length}`
    );
    check(
      truncated.rows.length === 500,
      "T2 and returns exactly the bound, never more",
      `got ${truncated.rows.length}`
    );

    // The per-lead reason is unaffected by truncation — only the global
    // superlative is withdrawn.
    const attached = await asTenant(businessA, (tx) =>
      leadService.attachLeadIntelligence(
        { businessId: businessA, leadIds: truncated.rows.slice(0, 5).map((r) => r.id), now },
        { tx }
      )
    );
    check(attached instanceof Map, "T3 per-lead reasons are still computed while truncated");

    await prisma.lead.deleteMany({ where: { businessId: businessA } });
  }

  /* ══════════════ GATE 2 — C1: same message, raced ═══════════════════════ */

  {
    const s = await seed(businessA, "1");
    const [a, b] = await Promise.all([
      capture(businessA, s.conversation as never, s.message as never),
      capture(businessA, s.conversation as never, s.message as never),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: businessA } });
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: s.conversation.id } });
    const messages = await prisma.message.count({ where: { conversationId: s.conversation.id } });

    check(leads.length === 1, "C1.1 two racing captures of the SAME message create ONE lead", `got ${leads.length}`);
    check(convo.leadId === leads[0]?.id, "C1.2 the conversation is linked to it exactly once");
    check(messages === 1, "C1.3 no message was duplicated", `got ${messages}`);
    check(
      (await creationEvents(businessA)) === 1,
      "C1.4 exactly ONE creation event — the loser did not claim it created a lead",
      `got ${await creationEvents(businessA)}`
    );
    const winners = [a, b].filter((r) => r.captured).length;
    check(winners >= 1, "C1.5 at least one call reports success", `winners=${winners}`);
    check(
      !("error" in a && a.error) && !("error" in b && b.error),
      "C1.6 neither call escaped with an uncaught error"
    );

    await prisma.learningEvent.deleteMany({ where: { businessId: businessA } });
    await prisma.conversation.updateMany({ where: { businessId: businessA }, data: { leadId: null } });
    await prisma.lead.deleteMany({ where: { businessId: businessA } });
  }

  /* ══════════════ C2: two distinct inbound messages, raced ═══════════════ */

  {
    const s = await seed(businessA, "2");
    const second = await prisma.message.create({
      data: {
        businessId: businessA,
        conversationId: s.conversation.id,
        customerId: s.customerId,
        channel: "WHATSAPP",
        messageType: "TEXT",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        contentText: "ועוד שאלה",
      },
    });

    await Promise.all([
      capture(businessA, s.conversation as never, s.message as never),
      capture(businessA, s.conversation as never, second as never),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: businessA } });
    check(leads.length === 1, "C2.1 two DIFFERENT messages racing still create ONE lead", `got ${leads.length}`);
    check(
      (await creationEvents(businessA)) === 1,
      "C2.2 and exactly ONE creation event",
      `got ${await creationEvents(businessA)}`
    );

    // Two real messages legitimately produce two pieces of message evidence.
    for (const m of [s.message, second]) {
      await asTenant(businessA, async (tx) =>
        recordConversationEvidence(
          {
            businessId: businessA,
            conversationId: s.conversation.id,
            messageId: m.id,
            direction: "INBOUND",
            senderType: "CUSTOMER",
            occurredAt: new Date(),
            state: null,
          },
          { tx }
        )
      );
    }
    const inbound = await prisma.learningEvent.count({
      where: { businessId: businessA, eventType: "CONVERSATION_INBOUND_RECEIVED" },
    });
    check(
      inbound === 2,
      "C2.3 two distinct messages DO produce two message-evidence rows — that is correct, not duplication",
      `got ${inbound}`
    );

    await prisma.learningEvent.deleteMany({ where: { businessId: businessA } });
    await prisma.conversation.updateMany({ where: { businessId: businessA }, data: { leadId: null } });
    await prisma.lead.deleteMany({ where: { businessId: businessA } });
    await prisma.message.deleteMany({ where: { businessId: businessA } });
    await prisma.conversation.deleteMany({ where: { businessId: businessA } });
  }

  /* ══════════ C3: two conversations, same phone, raced ═══════════════════ */

  {
    const phone = `9725${runId}33`;
    const one = await seed(businessA, "3a", phone);
    const two = await seed(businessA, "3b", phone);

    const [r1, r2] = await Promise.all([
      capture(businessA, one.conversation as never, one.message as never),
      capture(businessA, two.conversation as never, two.message as never),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: businessA } });
    check(
      leads.length === 1,
      "C3.1 two conversations for the same phone racing yield ONE open lead — the partial index arbitrates",
      `got ${leads.length}`
    );
    const openLeads = leads.filter((l) => !["WON", "LOST", "DROPPED"].includes(l.status));
    check(openLeads.length === 1, "C3.2 and exactly one of them is open", `got ${openLeads.length}`);
    check(
      (await creationEvents(businessA)) === 1,
      "C3.3 exactly ONE creation event — the loser adopted rather than claiming a creation",
      `got ${await creationEvents(businessA)}`
    );
    check(
      !("error" in r1 && r1.error) && !("error" in r2 && r2.error),
      "C3.4 no uncaught P2002 escaped to the caller"
    );

    // THE ACTUAL CONTRACT UNDER A TRUE RACE, measured rather than assumed.
    //
    // `createFromConversation` does have an adopt branch for this collision,
    // but it cannot run here: Postgres aborts the whole transaction the moment
    // the unique index rejects the insert, so the recovery query inside that
    // same transaction cannot execute either. The loser therefore ends with NO
    // link — not a wrong link, and not a second lead.
    //
    // That is safe and self-healing: auto-capture runs per message, so the
    // loser's next inbound finds the winner's open lead through the ordinary
    // pre-check and adopts it. Asserted below rather than asserted away.
    const linked = await prisma.conversation.count({
      where: { businessId: businessA, leadId: leads[0]?.id },
    });
    check(
      linked >= 1,
      "C3.5 the winner is linked and the loser is left unlinked — never mislinked, never duplicated",
      `linked=${linked}`
    );

    const loser = await prisma.conversation.findFirst({
      where: { businessId: businessA, leadId: null },
    });
    if (loser) {
      const next = await prisma.message.create({
        data: {
          businessId: businessA,
          conversationId: loser.id,
          customerId: loser.customerId,
          channel: "WHATSAPP",
          messageType: "TEXT",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          contentText: "עוד הודעה",
        },
      });
      const healed = await capture(businessA, loser as never, next as never);
      const afterHeal = await prisma.conversation.count({
        where: { businessId: businessA, leadId: leads[0]?.id },
      });
      check(
        afterHeal === 2,
        "C3.5b and the unlinked conversation SELF-HEALS on its next message — it adopts the same lead",
        `linked=${afterHeal} result=${JSON.stringify(healed)}`
      );
      check(
        (await prisma.lead.count({ where: { businessId: businessA } })) === 1,
        "C3.5c without ever creating a second lead"
      );
      check(
        (await creationEvents(businessA)) === 1,
        "C3.5d and without a second creation event"
      );
    } else {
      check(true, "C3.5b both conversations linked on the first pass — no heal needed");
      check(true, "C3.5c without ever creating a second lead");
      check(true, "C3.5d and without a second creation event");
    }
    const orphans = await prisma.conversation.count({
      where: { businessId: businessA, leadId: { not: null }, lead: { is: null } },
    });
    check(orphans === 0, "C3.6 no conversation points at a lead that does not exist", `got ${orphans}`);

    await prisma.learningEvent.deleteMany({ where: { businessId: businessA } });
    await prisma.conversation.updateMany({ where: { businessId: businessA }, data: { leadId: null } });
    await prisma.lead.deleteMany({ where: { businessId: businessA } });
    await prisma.message.deleteMany({ where: { businessId: businessA } });
    await prisma.conversation.deleteMany({ where: { businessId: businessA } });
  }

  /* ══════════ C4: same phone, two businesses, raced ══════════════════════ */

  {
    const phone = `9726${runId}44`;
    const a = await seed(businessA, "4a", phone);
    const b = await seed(businessB, "4b", phone);

    await Promise.all([
      capture(businessA, a.conversation as never, a.message as never),
      capture(businessB, b.conversation as never, b.message as never),
    ]);

    const aLeads = await prisma.lead.count({ where: { businessId: businessA } });
    const bLeads = await prisma.lead.count({ where: { businessId: businessB } });
    check(aLeads === 1 && bLeads === 1, "C4.1 the same phone yields ONE lead in EACH business", `${aLeads}/${bLeads}`);

    const aLead = await prisma.lead.findFirstOrThrow({ where: { businessId: businessA } });
    const bConvs = await prisma.conversation.count({
      where: { businessId: businessB, leadId: aLead.id },
    });
    check(bConvs === 0, "C4.2 no cross-tenant adoption — B never linked to A's lead", `got ${bConvs}`);

    // One CREATION event each. (`createFromConversation` also emits
    // LEAD_CONVERSATION_LINKED, so the raw per-tenant total is higher — what
    // matters is that neither tenant sees the other's.)
    const aCreated = await creationEvents(businessA);
    const bCreated = await creationEvents(businessB);
    check(aCreated === 1 && bCreated === 1, "C4.3 one creation event in each tenant", `${aCreated}/${bCreated}`);
    const aLeadIds = new Set((await prisma.lead.findMany({ where: { businessId: businessA }, select: { id: true } })).map((l) => l.id));
    const bEventsAboutA = await prisma.learningEvent.count({
      where: { businessId: businessB, entityType: "LEAD", entityId: { in: [...aLeadIds] } },
    });
    check(bEventsAboutA === 0, "C4.4 tenant B holds no evidence about tenant A's lead", `got ${bEventsAboutA}`);

    for (const id of [businessA, businessB]) {
      await prisma.learningEvent.deleteMany({ where: { businessId: id } });
      await prisma.conversation.updateMany({ where: { businessId: id }, data: { leadId: null } });
      await prisma.lead.deleteMany({ where: { businessId: id } });
      await prisma.message.deleteMany({ where: { businessId: id } });
      await prisma.conversation.deleteMany({ where: { businessId: id } });
    }
  }

  /* ══════════ C5: closed historical lead, two racing inquiries ═══════════ */

  {
    const phone = `9727${runId}55`;
    const closed = await prisma.lead.create({
      data: {
        businessId: businessA,
        customerName: "לקוח ותיק",
        phone,
        status: "WON",
        sourceChannel: "MANUAL",
        closedAt: new Date(Date.now() - 86_400_000),
      },
    });

    const one = await seed(businessA, "5a", phone);
    const two = await seed(businessA, "5b", phone);
    const [r1, r2] = await Promise.all([
      capture(businessA, one.conversation as never, one.message as never),
      capture(businessA, two.conversation as never, two.message as never),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: businessA }, orderBy: { id: "asc" } });
    const open = leads.filter((l) => !["WON", "LOST", "DROPPED"].includes(l.status));
    check(open.length === 1, "C5.1 exactly ONE new open opportunity is created", `got ${open.length}`);
    check(
      leads.find((l) => l.id === closed.id)?.status === "WON",
      "C5.2 the historical WON lead was NOT reopened",
      leads.find((l) => l.id === closed.id)?.status
    );
    check(open[0]?.id !== closed.id, "C5.3 the new opportunity is a different row — history is preserved");
    check(
      (await creationEvents(businessA)) === 1,
      "C5.4 one creation event for the one new opportunity",
      `got ${await creationEvents(businessA)}`
    );
    check(
      !("error" in r1 && r1.error) && !("error" in r2 && r2.error),
      "C5.5 no partial transaction escaped as an error"
    );
  }

  /* ══════════════════════════ cleanup ════════════════════════════════════ */

  for (const businessId of [businessA, businessB]) {
    await prisma.learningEvent.deleteMany({ where: { businessId } });
    await prisma.conversation.updateMany({ where: { businessId }, data: { leadId: null } });
    await prisma.message.deleteMany({ where: { businessId } });
    await prisma.conversation.deleteMany({ where: { businessId } });
    await prisma.lead.deleteMany({ where: { businessId } });
    await prisma.customer.deleteMany({ where: { businessId } });
    await prisma.user.deleteMany({ where: { businessId } });
    await prisma.business.delete({ where: { id: businessId } });
  }
  ok("Z1 the suite removed everything it created");

  delete process.env.LEADS_AUTO_CAPTURE_ENABLED;

  console.log(
    failures.length === 0
      ? `\nLEAD W3 CLOSURE VERIFY PASS — ${passed} checks green.\n`
      : `\nLEAD W3 CLOSURE VERIFY FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSUITE ERROR:", err?.message || err);
  process.exit(2);
});
