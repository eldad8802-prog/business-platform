/**
 * Auto-capture collision recovery — atomic convergence under a real race.
 *
 * The behaviour this exists to prove: when two conversations for the same phone
 * try to open a lead simultaneously, BOTH end up pointing at the same canonical
 * lead **within the same logical operation** — not eventually, not after
 * another message arrives.
 *
 * Everything here runs against a real Postgres with real concurrent
 * transactions, because the thing under test IS what Postgres does to a
 * transaction when a unique index rejects an insert. A mock would prove nothing.
 *
 * CONNECTION POOL. Recovery opens a SECOND transaction, so a racing pair needs
 * up to four transaction slots at once. Prisma's default pool is smaller than
 * that against a remote database, and the suite then fails with "Unable to
 * start a transaction in the given time" — an environment limit, not a defect.
 * Give the test URL room:
 *
 *   DATABASE_URL='...?connection_limit=20&pool_timeout=30'
 *     npx tsx lib/services/crm/lead-collision-recovery.test.ts
 *
 * Worth knowing beyond the test: the recovery path doubles peak transaction
 * usage for the duration of a collision. Bounded (one retry, only on the race),
 * but real.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { maybeCaptureLeadFromMessage } from "@/lib/services/crm/lead-auto-capture.service";
import { isOpenPhoneCollision } from "@/lib/services/crm/lead.service";

const runId = `${Date.now()}`.slice(-9);

let passed = 0;
const failures: string[] = [];
const ok = (l: string) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l: string, d = "") => { failures.push(`${l}${d ? ` — ${d}` : ""}`); console.log(`  FAIL  ${l}${d ? ` — ${d}` : ""}`); };
const check = (c: boolean, l: string, d = "") => (c ? ok(l) : bad(l, d));

async function createBusiness(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `RECOVERY ${label} ${runId}`,
      users: {
        create: { email: `rec-${label}-${runId}@example.test`, password: "x", name: "Recovery" },
      },
    },
  });
  return b.id;
}

async function seed(businessId: number, suffix: string, phoneOverride?: string) {
  const phone = phoneOverride ?? `9728${runId}${suffix}`;
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
      contentText: "שלום, מעוניין בהצעה",
    },
  });
  return { customerId: customer.id, phone, conversation, message };
}

/** Exactly how the pipeline calls it: inside tenant context, no wrapper tx. */
const capture = (businessId: number, conversation: unknown, message: unknown) =>
  runWithTenantContext({ businessId }, () =>
    maybeCaptureLeadFromMessage({
      businessId,
      conversation: conversation as never,
      message: message as never,
    })
  ).catch((error) => ({ captured: false as const, reason: "threw" as const, error }));

const creationEvents = (businessId: number) =>
  prisma.learningEvent.count({
    where: { businessId, eventType: "LEAD_CREATED_FROM_CONVERSATION" },
  });

async function wipe(businessId: number) {
  await prisma.learningEvent.deleteMany({ where: { businessId } });
  await prisma.conversation.updateMany({ where: { businessId }, data: { leadId: null } });
  await prisma.message.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { businessId } });
  await prisma.lead.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
}

async function main() {
  console.log("\nAuto-capture collision recovery — atomic convergence\n");
  process.env.LEADS_AUTO_CAPTURE_ENABLED = "true";

  const A = await createBusiness("A");
  const B = await createBusiness("B");

  /* ═══════════ R1 — same conversation, same message, raced ═══════════════ */

  {
    const s = await seed(A, "1");
    const [x, y] = await Promise.all([
      capture(A, s.conversation, s.message),
      capture(A, s.conversation, s.message),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: A } });
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: s.conversation.id } });
    check(leads.length === 1, "R1.1 one lead", `got ${leads.length}`);
    check(convo.leadId === leads[0]?.id, "R1.2 the conversation is linked to it");
    check(
      (await prisma.message.count({ where: { conversationId: s.conversation.id } })) === 1,
      "R1.3 one message"
    );
    check((await creationEvents(A)) === 1, "R1.4 exactly ONE creation event", `got ${await creationEvents(A)}`);
    check(
      !("error" in x) && !("error" in y),
      "R1.5 neither call threw",
      JSON.stringify([x, y]).slice(0, 140)
    );
    await wipe(A);
  }

  /* ═══════════ R2 — same conversation, two distinct messages ════════════ */

  {
    const s = await seed(A, "2");
    const second = await prisma.message.create({
      data: {
        businessId: A,
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
      capture(A, s.conversation, s.message),
      capture(A, s.conversation, second),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: A } });
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: s.conversation.id } });
    check(leads.length === 1, "R2.1 one lead", `got ${leads.length}`);
    check(convo.leadId === leads[0]?.id, "R2.2 the conversation is linked");
    check((await creationEvents(A)) === 1, "R2.3 exactly ONE creation event", `got ${await creationEvents(A)}`);
    await wipe(A);
  }

  /* ═══════════ R3 — THE CORE PROOF: two conversations, same phone ═══════ */

  {
    const phone = `9729${runId}33`;
    const one = await seed(A, "3a", phone);
    const two = await seed(A, "3b", phone);

    const [r1, r2] = await Promise.all([
      capture(A, one.conversation, one.message),
      capture(A, two.conversation, two.message),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: A } });
    const c1 = await prisma.conversation.findUniqueOrThrow({ where: { id: one.conversation.id } });
    const c2 = await prisma.conversation.findUniqueOrThrow({ where: { id: two.conversation.id } });

    check(leads.length === 1, "R3.1 exactly ONE lead exists", `got ${leads.length}`);
    check(c1.leadId != null, "R3.2 conversation A is linked", `leadId=${c1.leadId}`);
    check(c2.leadId != null, "R3.3 conversation B is linked — NO waiting for another message", `leadId=${c2.leadId}`);
    check(
      c1.leadId === c2.leadId && c1.leadId === leads[0]?.id,
      "R3.4 BOTH point at the SAME canonical lead",
      `${c1.leadId} vs ${c2.leadId} vs ${leads[0]?.id}`
    );
    check(
      (await creationEvents(A)) === 1,
      "R3.5 exactly ONE creation event — the adopter did not claim a creation",
      `got ${await creationEvents(A)}`
    );
    check(
      !("error" in r1) && !("error" in r2),
      "R3.6 no uncaught P2002 escaped",
      JSON.stringify([r1, r2]).slice(0, 160)
    );

    const outcomes = [r1, r2].map((r) => (r.captured ? r.outcome : `refused:${r.reason}`));
    check(
      outcomes.filter((o) => o === "created").length === 1,
      "R3.7 exactly one call reports 'created'",
      outcomes.join(",")
    );
    check(
      outcomes.filter((o) => o === "linked_existing" || o === "already_linked").length === 1,
      "R3.8 and the other reports an ADOPTION, not a failure",
      outcomes.join(",")
    );

    const orphans = await prisma.conversation.count({
      where: { businessId: A, leadId: { not: null }, lead: { is: null } },
    });
    check(orphans === 0, "R3.9 no conversation points at a lead that does not exist", `got ${orphans}`);
    await wipe(A);
  }

  /* ═══════════ R4 — two businesses, same phone ══════════════════════════ */

  {
    const phone = `9720${runId}44`;
    const a = await seed(A, "4a", phone);
    const b = await seed(B, "4b", phone);
    await Promise.all([
      capture(A, a.conversation, a.message),
      capture(B, b.conversation, b.message),
    ]);

    const aLeads = await prisma.lead.findMany({ where: { businessId: A } });
    const bLeads = await prisma.lead.findMany({ where: { businessId: B } });
    check(aLeads.length === 1 && bLeads.length === 1, "R4.1 one lead in EACH business", `${aLeads.length}/${bLeads.length}`);
    check(aLeads[0]?.id !== bLeads[0]?.id, "R4.2 they are different leads");

    const aConv = await prisma.conversation.findUniqueOrThrow({ where: { id: a.conversation.id } });
    const bConv = await prisma.conversation.findUniqueOrThrow({ where: { id: b.conversation.id } });
    check(aConv.leadId === aLeads[0]?.id, "R4.3 A's conversation links to A's lead");
    check(bConv.leadId === bLeads[0]?.id, "R4.4 B's conversation links to B's lead");
    check(
      bConv.leadId !== aLeads[0]?.id,
      "R4.5 recovery never adopted across the tenant boundary",
      `${bConv.leadId} vs ${aLeads[0]?.id}`
    );
    check(
      (await creationEvents(A)) === 1 && (await creationEvents(B)) === 1,
      "R4.6 one creation event per tenant"
    );
    await wipe(A);
    await wipe(B);
  }

  /* ═══════════ R5 — closed historical lead + two racing inquiries ═══════ */

  {
    const phone = `9721${runId}55`;
    const closed = await prisma.lead.create({
      data: {
        businessId: A,
        customerName: "לקוח ותיק",
        phone,
        status: "WON",
        sourceChannel: "MANUAL",
        closedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const one = await seed(A, "5a", phone);
    const two = await seed(A, "5b", phone);

    await Promise.all([
      capture(A, one.conversation, one.message),
      capture(A, two.conversation, two.message),
    ]);

    const leads = await prisma.lead.findMany({ where: { businessId: A }, orderBy: { id: "asc" } });
    const open = leads.filter((l) => !["WON", "LOST", "DROPPED"].includes(l.status));
    const c1 = await prisma.conversation.findUniqueOrThrow({ where: { id: one.conversation.id } });
    const c2 = await prisma.conversation.findUniqueOrThrow({ where: { id: two.conversation.id } });

    check(open.length === 1, "R5.1 exactly ONE new open opportunity", `got ${open.length}`);
    check(
      c1.leadId === open[0]?.id && c2.leadId === open[0]?.id,
      "R5.2 BOTH conversations converged on it",
      `${c1.leadId}/${c2.leadId} vs ${open[0]?.id}`
    );
    check(
      leads.find((l) => l.id === closed.id)?.status === "WON",
      "R5.3 the historical WON lead was not touched"
    );
    check(
      (await prisma.conversation.count({ where: { businessId: A, leadId: closed.id } })) === 0,
      "R5.4 and nothing was linked to it"
    );
    check((await creationEvents(A)) === 1, "R5.5 one creation event", `got ${await creationEvents(A)}`);
    await wipe(A);
  }

  /* ═══════════ R6 — a P2002 that is NOT the open-phone race ═════════════ */

  {
    const notOurs = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "x",
      meta: { modelName: "Customer", target: ["businessId", "phone"] },
    });
    check(
      isOpenPhoneCollision(notOurs) === false,
      "R6.1 a P2002 on a DIFFERENT model does not trigger adoption"
    );

    const otherColumns = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "x",
      meta: { modelName: "Lead", target: ["businessId", "email"] },
    });
    check(
      isOpenPhoneCollision(otherColumns) === false,
      "R6.2 a P2002 on different Lead columns does not trigger adoption"
    );

    for (const [label, target] of [
      ["the index name", "Lead_open_phone_key"],
      ["the column list", ["businessId", "phone"]],
    ] as const) {
      const ours = new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "x",
        meta: { modelName: "Lead", target },
      });
      check(isOpenPhoneCollision(ours) === true, `R6.3 the race IS recognised when Prisma reports ${label}`);
    }

    const notP2002 = new Prisma.PrismaClientKnownRequestError("other", {
      code: "P2003",
      clientVersion: "x",
      meta: { modelName: "Lead" },
    });
    check(isOpenPhoneCollision(notP2002) === false, "R6.4 a non-P2002 error never triggers adoption");
    check(isOpenPhoneCollision(new Error("boom")) === false, "R6.5 nor does an ordinary Error");
  }

  /* ═══════════════════════════ cleanup ══════════════════════════════════ */

  for (const businessId of [A, B]) {
    await wipe(businessId);
    await prisma.user.deleteMany({ where: { businessId } });
    await prisma.business.delete({ where: { id: businessId } });
  }
  ok("Z1 the suite removed everything it created");

  delete process.env.LEADS_AUTO_CAPTURE_ENABLED;

  console.log(
    failures.length === 0
      ? `\nCOLLISION RECOVERY VERIFY PASS — ${passed} checks green.\n`
      : `\nCOLLISION RECOVERY VERIFY FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSUITE ERROR:", err?.message || err);
  process.exit(2);
});
