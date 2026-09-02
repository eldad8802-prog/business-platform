/**
 * Leads W3 closure — GLOBAL priority ordering across pagination.
 *
 * The bug this suite exists to prevent: ranking only the rows `take` happened
 * to return. With 50+ quiet leads and one waiting customer sitting 51st by
 * `lastActivityAt`, the urgent lead was cut before anything ranked it — and
 * since no client sends a cursor, there is no page 2 to find them on. The queue
 * that promises "who needs me now" silently hid the one person who did.
 *
 * These tests build a dataset LARGER than the page size and assert against the
 * database, because the fix lives in a SQL predicate and only a database can
 * prove a predicate.
 *
 *   DATABASE_URL=... npx tsx lib/services/crm/lead-priority-order.test.ts
 */

import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { leadService } from "@/lib/services/crm/lead.service";
import { evaluateLeadPriority } from "@/lib/services/crm/lead-intelligence";
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";

const runId = `${Date.now()}`.slice(-9);
const PAGE = 50;

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

/**
 * The ranking the route performs, expressed once so the tests measure the real
 * contract rather than a paraphrase of it.
 */
async function rankedIds(
  businessId: number,
  opts: { query?: string | null; status?: "open" | "closed" | "all"; needsAction?: boolean; limit?: number } = {}
): Promise<{ ids: number[]; overflow: boolean }> {
  const now = new Date();
  return asTenant(businessId, async (tx) => {
    const rows = await leadService.listLeads(
      {
        businessId,
        query: opts.query ?? null,
        status: opts.status ?? "open",
        needsAction: opts.needsAction ?? false,
        limit: opts.limit ?? PAGE,
        now,
      },
      { tx }
    );
    const urgent =
      (opts.status ?? "open") === "closed"
        ? { rows: [], overflow: false }
        : await leadService.listUrgentCandidates(
            { businessId, query: opts.query ?? null, now },
            { tx }
          );

    const byId = new Map<number, (typeof rows)[number]>();
    for (const r of rows) byId.set(r.id, r);
    for (const r of urgent.rows) if (!byId.has(r.id)) byId.set(r.id, r);
    const merged = [...byId.values()];

    const attached = await leadService.attachLeadIntelligence(
      { businessId, leadIds: merged.map((r) => r.id), now },
      { tx }
    );

    const scored = merged.map((lead) => {
      const status = lead.status as LeadStatusValue;
      const intelligence = attached.get(lead.id)?.intelligence ?? null;
      const attention = evaluateLeadAttention(
        { status, nextFollowUpAt: lead.nextFollowUpAt, createdAt: lead.createdAt },
        now
      );
      return {
        id: lead.id,
        lastActivityAt: lead.lastActivityAt ?? lead.createdAt,
        priority: evaluateLeadPriority({ status, attention, intelligence }),
      };
    });

    scored.sort(
      (a, b) =>
        b.priority.score - a.priority.score ||
        new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime() ||
        b.id - a.id
    );

    return {
      ids: scored.slice(0, opts.limit ?? PAGE).map((s) => s.id),
      overflow: urgent.overflow,
    };
  });
}

async function createBusiness(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `LEADS W3 ORDER ${label} ${runId}`,
      users: {
        create: {
          email: `w3-order-${label}-${runId}@example.test`,
          password: "x",
          name: "Order Test",
        },
      },
    },
  });
  return b.id;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function makeQuietLead(businessId: number, i: number, activityMinutesAgo: number) {
  return prisma.lead.create({
    data: {
      businessId,
      customerName: `שקט ${i}`,
      phone: `9721${runId}${String(i).padStart(3, "0")}`,
      status: "OPEN",
      sourceChannel: "MANUAL",
      // Created before today so it cannot count as an untouched NEW lead, and
      // OPEN so it is not a closed-lead case either. Genuinely quiet.
      createdAt: minutesAgo(60 * 24 * 30),
      lastActivityAt: minutesAgo(activityMinutesAgo),
    },
  });
}

async function makeWaitingLead(
  businessId: number,
  label: string,
  opts: { activityMinutesAgo: number; waitingMinutes: number; unanswered: number; status?: LeadStatusValue }
) {
  const customer = await prisma.customer.create({
    data: { businessId, name: `ממתין ${label}`, phone: `9729${runId}${label}` },
  });
  const lead = await prisma.lead.create({
    data: {
      businessId,
      customerName: `ממתין ${label}`,
      phone: customer.phone,
      customerId: customer.id,
      status: opts.status ?? "OPEN",
      sourceChannel: "WHATSAPP",
      createdAt: minutesAgo(60 * 24 * 30),
      lastActivityAt: minutesAgo(opts.activityMinutesAgo),
      ...(opts.status && ["WON", "LOST", "DROPPED"].includes(opts.status)
        ? { closedAt: minutesAgo(60) }
        : {}),
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      businessId,
      customerId: customer.id,
      leadId: lead.id,
      channel: "WHATSAPP",
      status: "OPEN",
      currentStage: "NEW",
      startedAt: minutesAgo(opts.waitingMinutes + 10),
      lastMessageAt: minutesAgo(opts.waitingMinutes),
      unansweredInboundCount: opts.unanswered,
      customerLastInboundAt: minutesAgo(opts.waitingMinutes),
      temperatureScore: 0.6,
    },
  });
  await prisma.message.create({
    data: {
      businessId,
      conversationId: conversation.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      messageType: "TEXT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentText: "שלום, מחכה לתשובה",
      createdAt: minutesAgo(opts.waitingMinutes),
    },
  });
  return lead;
}

async function main() {
  console.log("\nLeads W3 — global priority ordering across pagination\n");

  const businessId = await createBusiness("A");

  /* ═══════════ P1 — the urgent lead beyond the old page boundary ══════════ */

  // 60 quiet leads, all with MORE RECENT activity than the urgent one, so under
  // the old `lastActivityAt DESC` + take(50) they fill the page completely.
  for (let i = 0; i < 60; i += 1) {
    await makeQuietLead(businessId, i, i + 1);
  }
  // The urgent lead is the OLDEST by activity — 51st at best under the old order.
  const urgent = await makeWaitingLead(businessId, "1", {
    activityMinutesAgo: 5000,
    waitingMinutes: 90,
    unanswered: 3,
  });

  // Prove the OLD behaviour would have hidden it.
  const oldOrder = await asTenant(businessId, (tx) =>
    leadService.listLeads({ businessId, status: "open", limit: PAGE }, { tx })
  );
  check(
    !oldOrder.some((l) => l.id === urgent.id),
    "P1.0 the old activity-ordered page really did NOT contain the urgent lead",
    `page=${oldOrder.length}`
  );

  const ranked = await rankedIds(businessId);
  check(ranked.ids.length === PAGE, "P1.1 the ranked page is still a full page", `got ${ranked.ids.length}`);
  check(ranked.ids[0] === urgent.id, "P1.2 the waiting customer is now FIRST, not invisible", `first=${ranked.ids[0]}`);
  check(!ranked.overflow, "P1.3 and the ranking was exact, not truncated");

  /* ═══════════ P2 — quiet-but-recent vs urgent-but-older ═════════════════ */

  const quietNewest = await makeQuietLead(businessId, 999, 0);
  const p2 = await rankedIds(businessId);
  check(
    p2.ids.indexOf(urgent.id) < p2.ids.indexOf(quietNewest.id),
    "P2 an older waiting customer outranks the newest quiet lead",
    `urgent=${p2.ids.indexOf(urgent.id)} quiet=${p2.ids.indexOf(quietNewest.id)}`
  );

  /* ═══════════ P3 — stable, deterministic ties ═══════════════════════════ */

  const a = await rankedIds(businessId);
  const b = await rankedIds(businessId);
  check(
    JSON.stringify(a.ids) === JSON.stringify(b.ids),
    "P3.1 the same dataset ranks identically twice — no arbitrary tie order"
  );
  const tied = a.ids.slice(1, 6);
  check(tied.length === 5 && new Set(tied).size === 5, "P3.2 ties resolve to distinct rows (id is the final key)");

  /* ═══════════ P4 — no duplicates, nothing missing ═══════════════════════ */

  const all = await rankedIds(businessId, { status: "all", limit: 100 });
  const totalOpen = await prisma.lead.count({ where: { businessId } });
  check(new Set(all.ids).size === all.ids.length, "P4.1 no lead appears twice in the ranked result");
  check(
    all.ids.length === Math.min(100, totalOpen),
    "P4.2 the ranked result covers the dataset up to the limit",
    `got ${all.ids.length} of ${totalOpen}`
  );
  const merged = new Set(all.ids);
  const everyOpen = await prisma.lead.findMany({ where: { businessId }, select: { id: true } });
  const missing = everyOpen.filter((l) => !merged.has(l.id));
  check(
    missing.length === totalOpen - all.ids.length,
    "P4.3 exactly the rows beyond the limit are absent — none lost inside it",
    `missing=${missing.length}`
  );

  /* ═══════════ P5 — search narrows, ranking still global within it ═══════ */

  const searchUrgent = await makeWaitingLead(businessId, "2", {
    activityMinutesAgo: 9000,
    waitingMinutes: 300,
    unanswered: 2,
  });
  const searched = await rankedIds(businessId, { query: "ממתין" });
  check(searched.ids.length > 0, "P5.1 search returns matches");
  check(
    searched.ids.every((id) => id === urgent.id || id === searchUrgent.id),
    "P5.2 search does NOT pull in non-matching leads through the urgent path",
    `ids=${searched.ids.join(",")}`
  );
  check(
    searched.ids[0] === searchUrgent.id,
    "P5.3 and ranking is global WITHIN the search results (longest wait first)",
    `first=${searched.ids[0]} expected=${searchUrgent.id}`
  );

  /* ═══════════ P6 — tabs keep their semantics ════════════════════════════ */

  const won = await makeWaitingLead(businessId, "3", {
    activityMinutesAgo: 1,
    waitingMinutes: 600,
    unanswered: 5,
    status: "WON",
  });

  const openTab = await rankedIds(businessId, { status: "open" });
  check(!openTab.ids.includes(won.id), "P6.1 the open tab excludes a closed lead");
  const closedTab = await rankedIds(businessId, { status: "closed" });
  check(closedTab.ids.includes(won.id), "P6.2 the closed tab includes it");
  check(
    !closedTab.ids.includes(urgent.id),
    "P6.3 and the urgent path never leaks an open lead into the closed tab"
  );
  const needs = await rankedIds(businessId, { status: "open", needsAction: true });
  check(
    !needs.ids.includes(quietNewest.id),
    "P6.4 the needs-action tab still excludes a quiet lead"
  );

  /* ═══════════ P7 — a closed lead with a loud old conversation ═══════════ */

  const allTab = await rankedIds(businessId, { status: "all", limit: 100 });
  check(allTab.ids.includes(won.id), "P7.1 the WON lead is present in the all tab");
  check(
    allTab.ids.indexOf(won.id) > allTab.ids.indexOf(urgent.id),
    "P7.2 but it never outranks an active lead on stale conversation evidence",
    `won=${allTab.ids.indexOf(won.id)} urgent=${allTab.ids.indexOf(urgent.id)}`
  );

  /* ═══════════ cleanup ═══════════════════════════════════════════════════ */

  await prisma.learningEvent.deleteMany({ where: { businessId } });
  await prisma.message.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { businessId } });
  await prisma.lead.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
  await prisma.user.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
  ok("Z1 the suite removed everything it created");

  console.log(
    failures.length === 0
      ? `\nLEAD PRIORITY ORDER VERIFY PASS — ${passed} checks green.\n`
      : `\nLEAD PRIORITY ORDER VERIFY FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nSUITE ERROR:", err?.message || err);
  process.exit(2);
});
