/**
 * Leads W1 — service + read-model integration test.
 *
 * Needs a dev DB with the `20260831090000_leads_w1_core` migration applied.
 * Run: npx tsx lib/services/crm/lead.service.test.ts
 *
 * Every call goes through `runWithTenantContext` + `withTenantTransaction`, so
 * this also exercises the real D2 path (ALS -> GUC -> RLS backstop) rather than
 * a bare Prisma client — the same way the routes do it in production.
 */
import assert from "node:assert/strict";

import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { leadService, LEAD_EVENTS } from "@/lib/services/crm/lead.service";
import { getLeadCard } from "@/lib/services/crm/lead-card.read-model";
import { resolveCrmSubject } from "@/lib/services/crm/crm-subject.resolver";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Unique per run so parallel runs never collide on the phone unique index. */
const stamp = String(Date.now()).slice(-7);
const PHONE_A = `97250${stamp}`;
const PHONE_B = `97252${stamp}`;

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function createBusinessWithUser(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `LEADS W1 ${label} ${runId}`,
      users: {
        create: {
          email: `leads-w1-${label}-${runId}@example.test`,
          password: "test-password",
          name: "Leads Test User",
        },
      },
    },
    include: { users: true },
  });
  return { businessId: business.id, userId: business.users[0].id };
}

/** The exact call shape the routes use. */
function asTenant<T>(businessId: number, fn: (tx: never) => Promise<T>): Promise<T> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) => fn(tx as never))
  );
}

async function expectRejection(
  label: string,
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean
): Promise<void> {
  let threw: unknown = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert.notEqual(threw, null, `${label}: expected a rejection, got success`);
  assert.equal(predicate(threw), true, `${label}: wrong error type — ${String(threw)}`);
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function main() {
  const a = await createBusinessWithUser("A");
  const b = await createBusinessWithUser("B");

  try {
    /* ================================================ 1. create + identity == */

    const lead1 = await asTenant(a.businessId, (tx) =>
      leadService.createLead(
        {
          businessId: a.businessId,
          name: "  דנה לוי  ",
          phone: PHONE_A,
          email: "  Dana@Example.COM ",
          intentSnapshot: "  צריכה הצעת מחיר לאירוע  ",
          sourceChannel: "PHONE",
        },
        { tx }
      )
    );

    check("create trims and normalizes every field", () => {
      assert.equal(lead1.customerName, "דנה לוי");
      assert.equal(lead1.email, "dana@example.com", "email lowercased");
      assert.equal(lead1.intentSnapshot, "צריכה הצעת מחיר לאירוע");
      assert.equal(lead1.sourceChannel, "PHONE");
      assert.equal(lead1.status, "NEW");
      assert.equal(lead1.businessId, a.businessId);
    });

    check("create stamps lastActivityAt and leaves the lead open", () => {
      assert.notEqual(lead1.lastActivityAt, null, "lastActivityAt must be set");
      assert.equal(lead1.closedAt, null);
      assert.equal(lead1.nextFollowUpAt, null);
    });

    check("a new lead is linked to a Customer (identity lives on Customer)", () => {
      assert.notEqual(lead1.customerId, null, "customerId must be set");
    });

    const linkedCustomer = await prisma.customer.findFirstOrThrow({
      where: { id: lead1.customerId as number },
    });

    check("the linked customer carries the canonical phone", () => {
      assert.equal(linkedCustomer.businessId, a.businessId);
      assert.equal(linkedCustomer.phone, lead1.phone);
      assert.equal(linkedCustomer.name, "דנה לוי");
    });

    /* ============================================ 2. customer REUSE, not dup = */

    // Close the first lead so the phone is free, then create another with the
    // same number: the customer must be REUSED, never duplicated.
    await asTenant(a.businessId, (tx) =>
      leadService.updateLeadStatus(
        { businessId: a.businessId, leadId: lead1.id, status: "WON" },
        { tx }
      )
    );

    const lead1b = await asTenant(a.businessId, (tx) =>
      leadService.createLead(
        { businessId: a.businessId, name: "דנה לוי", phone: lead1.phone },
        { tx }
      )
    );

    check("a repeat caller reuses the existing Customer row", () => {
      assert.equal(lead1b.customerId, lead1.customerId, "must reuse, not duplicate");
    });

    const customerCount = await prisma.customer.count({
      where: { businessId: a.businessId, phone: lead1.phone },
    });
    check("only ONE customer exists for that phone", () => {
      assert.equal(customerCount, 1);
    });

    /* ================================================ 3. duplicate protection */

    await expectRejection(
      "a SECOND open lead for the same phone is refused (409)",
      () =>
        asTenant(a.businessId, (tx) =>
          leadService.createLead(
            { businessId: a.businessId, name: "דנה שוב", phone: lead1.phone },
            { tx }
          )
        ),
      (err) => err instanceof ConflictError && err.code === "OPEN_LEAD_EXISTS"
    );

    const stillThere = await prisma.lead.findFirstOrThrow({ where: { id: lead1.id } });
    check("closing did not delete or archive the original lead", () => {
      assert.equal(stillThere.status, "WON");
      assert.notEqual(stillThere.closedAt, null, "closedAt stamped on close");
    });

    const leadOtherTenant = await asTenant(b.businessId, (tx) =>
      leadService.createLead(
        { businessId: b.businessId, name: "דנה של עסק ב", phone: lead1.phone },
        { tx }
      )
    );
    check("cross-tenant phone reuse is permitted (tenant-scoped constraint)", () => {
      assert.equal(leadOtherTenant.businessId, b.businessId);
    });

    /* ======================================================== 4. validation == */

    await expectRejection(
      "an invalid email is REFUSED at the service (audit regression)",
      () =>
        asTenant(a.businessId, (tx) =>
          leadService.createLead(
            { businessId: a.businessId, name: "בדיקה", email: "not-an-email" },
            { tx }
          )
        ),
      (err) => err instanceof ValidationError
    );

    await expectRejection(
      "an unusable phone is refused rather than silently dropped",
      () =>
        asTenant(a.businessId, (tx) =>
          leadService.createLead(
            { businessId: a.businessId, name: "בדיקה", phone: "12" },
            { tx }
          )
        ),
      (err) => err instanceof ValidationError
    );

    await expectRejection(
      "an empty name is refused",
      () =>
        asTenant(a.businessId, (tx) =>
          leadService.createLead({ businessId: a.businessId, name: "   " }, { tx })
        ),
      (err) => err instanceof ValidationError
    );

    const noEmailLead = await asTenant(a.businessId, (tx) =>
      leadService.createLead(
        { businessId: a.businessId, name: "ללא אימייל", phone: PHONE_B },
        { tx }
      )
    );
    check("a lead with no email stores null, not an empty string", () => {
      assert.equal(noEmailLead.email, null);
    });

    /* ================================================= 5. tenant isolation == */

    await expectRejection(
      "business B cannot READ business A's lead",
      () =>
        asTenant(b.businessId, (tx) =>
          leadService.getLead({ businessId: b.businessId, leadId: noEmailLead.id }, { tx })
        ),
      (err) => err instanceof NotFoundError
    );

    await expectRejection(
      "business B cannot UPDATE business A's lead",
      () =>
        asTenant(b.businessId, (tx) =>
          leadService.updateLead(
            { businessId: b.businessId, leadId: noEmailLead.id, name: "חטוף" },
            { tx }
          )
        ),
      (err) => err instanceof NotFoundError
    );

    await expectRejection(
      "business B cannot change the STATUS of business A's lead",
      () =>
        asTenant(b.businessId, (tx) =>
          leadService.updateLeadStatus(
            { businessId: b.businessId, leadId: noEmailLead.id, status: "WON" },
            { tx }
          )
        ),
      (err) => err instanceof NotFoundError
    );

    await expectRejection(
      "business B cannot set a FOLLOW-UP on business A's lead",
      () =>
        asTenant(b.businessId, (tx) =>
          leadService.setFollowUp(
            {
              businessId: b.businessId,
              leadId: noEmailLead.id,
              followUpAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
            { tx }
          )
        ),
      (err) => err instanceof NotFoundError
    );

    await expectRejection(
      "business B cannot read business A's lead CARD",
      () =>
        asTenant(b.businessId, (tx) =>
          getLeadCard({ businessId: b.businessId, leadId: noEmailLead.id }, { tx })
        ),
      (err) => err instanceof NotFoundError
    );

    const untouched = await prisma.lead.findFirstOrThrow({
      where: { id: noEmailLead.id },
    });
    check("after every cross-tenant attempt the row is byte-for-byte unchanged", () => {
      assert.equal(untouched.customerName, "ללא אימייל");
      assert.equal(untouched.status, "NEW");
      assert.equal(untouched.businessId, a.businessId);
      assert.equal(untouched.nextFollowUpAt, null);
    });

    /* ==================================================== 6. follow-up loop == */

    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const withFollowUp = await asTenant(a.businessId, (tx) =>
      leadService.setFollowUp(
        {
          businessId: a.businessId,
          leadId: noEmailLead.id,
          followUpAt: future,
          note: "לבדוק אם עדיין רלוונטי",
        },
        { tx }
      )
    );
    check("a follow-up is stored with its note", () => {
      assert.equal(withFollowUp.nextFollowUpAt?.toISOString(), future);
      assert.equal(withFollowUp.followUpNote, "לבדוק אם עדיין רלוונטי");
    });

    const rescheduled = await asTenant(a.businessId, (tx) =>
      leadService.setFollowUp(
        {
          businessId: a.businessId,
          leadId: noEmailLead.id,
          followUpAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
        { tx }
      )
    );
    check("rescheduling OVERWRITES — there is never a second open follow-up", () => {
      assert.notEqual(rescheduled.nextFollowUpAt?.toISOString(), future);
      assert.equal(rescheduled.followUpNote, null, "note replaced, not appended");
    });

    // Backdate so the derived state must read "overdue".
    await prisma.lead.update({
      where: { id: noEmailLead.id },
      data: { nextFollowUpAt: new Date(Date.now() - 3 * 86_400_000) },
    });

    const overdueCard = await asTenant(a.businessId, (tx) =>
      getLeadCard({ businessId: a.businessId, leadId: noEmailLead.id }, { tx })
    );
    check("an overdue follow-up is DERIVED at read time, never stored", () => {
      assert.equal(overdueCard.followUp.kind, "overdue");
      assert.equal(overdueCard.needsAttention, true);
    });

    const needsActionList = await asTenant(a.businessId, (tx) =>
      leadService.listLeads(
        { businessId: a.businessId, needsAction: true },
        { tx }
      )
    );
    check("the needs-action filter finds the overdue lead in SQL", () => {
      assert.equal(
        needsActionList.some((l) => l.id === noEmailLead.id),
        true,
        "overdue lead missing from needsAction"
      );
    });

    const completed = await asTenant(a.businessId, (tx) =>
      leadService.clearFollowUp(
        { businessId: a.businessId, leadId: noEmailLead.id },
        { tx }
      )
    );
    check("marking the follow-up done clears it (completion IS clearing)", () => {
      assert.equal(completed.nextFollowUpAt, null);
      assert.equal(completed.followUpNote, null);
    });

    const afterDone = await asTenant(a.businessId, (tx) =>
      leadService.listLeads({ businessId: a.businessId, needsAction: true }, { tx })
    );
    check("a completed follow-up leaves the needs-action queue immediately", () => {
      assert.equal(
        afterDone.some((l) => l.id === noEmailLead.id),
        false
      );
    });

    /* ==================================================== 7. status lifecycle */

    const quoted = await asTenant(a.businessId, (tx) =>
      leadService.updateLeadStatus(
        { businessId: a.businessId, leadId: noEmailLead.id, status: "QUOTED" },
        { tx }
      )
    );
    check("an open-to-open move does not stamp closedAt", () => {
      assert.equal(quoted.status, "QUOTED");
      assert.equal(quoted.closedAt, null);
    });

    const repeated = await asTenant(a.businessId, (tx) =>
      leadService.updateLeadStatus(
        { businessId: a.businessId, leadId: noEmailLead.id, status: "QUOTED" },
        { tx }
      )
    );
    check("repeating a status is an idempotent no-op", () => {
      assert.equal(repeated.status, "QUOTED");
    });

    // Park a follow-up, then close: closing must retire it.
    await asTenant(a.businessId, (tx) =>
      leadService.setFollowUp(
        {
          businessId: a.businessId,
          leadId: noEmailLead.id,
          followUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        { tx }
      )
    );
    const lost = await asTenant(a.businessId, (tx) =>
      leadService.updateLeadStatus(
        {
          businessId: a.businessId,
          leadId: noEmailLead.id,
          status: "LOST",
          lostReason: "בחר מתחרה",
        },
        { tx }
      )
    );
    check("closing stamps closedAt, records the reason, and retires the follow-up", () => {
      assert.equal(lost.status, "LOST");
      assert.notEqual(lost.closedAt, null);
      assert.equal(lost.lostReason, "בחר מתחרה");
      assert.equal(lost.nextFollowUpAt, null, "a closed lead must not stay due");
    });

    await expectRejection(
      "a closed lead refuses a new follow-up",
      () =>
        asTenant(a.businessId, (tx) =>
          leadService.setFollowUp(
            {
              businessId: a.businessId,
              leadId: noEmailLead.id,
              followUpAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
            { tx }
          )
        ),
      (err) => err instanceof ValidationError
    );

    const reopened = await asTenant(a.businessId, (tx) =>
      leadService.updateLeadStatus(
        { businessId: a.businessId, leadId: noEmailLead.id, status: "OPEN" },
        { tx }
      )
    );
    check("reopening clears closedAt so a lead is never open AND closed", () => {
      assert.equal(reopened.status, "OPEN");
      assert.equal(reopened.closedAt, null);
    });

    /* ======================================================== 8. list + search */

    const openOnly = await asTenant(a.businessId, (tx) =>
      leadService.listLeads({ businessId: a.businessId }, { tx })
    );
    check("the list defaults to OPEN leads (a work queue, not an archive)", () => {
      assert.equal(
        openOnly.every((l) => !["WON", "LOST", "DROPPED"].includes(l.status)),
        true
      );
      assert.equal(
        openOnly.some((l) => l.id === lead1.id),
        false,
        "the WON lead must not be in the default queue"
      );
    });

    const closedOnly = await asTenant(a.businessId, (tx) =>
      leadService.listLeads({ businessId: a.businessId, status: "closed" }, { tx })
    );
    check("the closed filter still finds the won lead — nothing was deleted", () => {
      assert.equal(
        closedOnly.some((l) => l.id === lead1.id),
        true
      );
    });

    const searched = await asTenant(a.businessId, (tx) =>
      leadService.listLeads(
        { businessId: a.businessId, query: PHONE_B, status: "all" },
        { tx }
      )
    );
    check("search matches on phone", () => {
      assert.equal(searched.some((l) => l.id === noEmailLead.id), true);
    });

    const otherTenantList = await asTenant(b.businessId, (tx) =>
      leadService.listLeads({ businessId: b.businessId, status: "all" }, { tx })
    );
    check("business B's list contains ONLY business B's leads", () => {
      assert.equal(
        otherTenantList.every((l) => l.businessId === b.businessId),
        true
      );
      assert.equal(otherTenantList.some((l) => l.id === lead1.id), false);
    });

    /* ==================================================== 9. CRM subject LEAD */

    const subject = await asTenant(a.businessId, (tx) =>
      resolveCrmSubject(
        { businessId: a.businessId, subjectType: "LEAD", subjectId: noEmailLead.id },
        { tx }
      )
    );
    check("a lead resolves as a generic CRM subject (notes + files for free)", () => {
      assert.equal(subject.subjectType, "LEAD");
      assert.equal(subject.subjectId, noEmailLead.id);
      assert.equal(subject.displayName, "ללא אימייל");
    });

    await expectRejection(
      "a lead of another business is NOT a resolvable subject",
      () =>
        asTenant(b.businessId, (tx) =>
          resolveCrmSubject(
            { businessId: b.businessId, subjectType: "LEAD", subjectId: noEmailLead.id },
            { tx }
          )
        ),
      (err) => err instanceof NotFoundError
    );

    /* ======================================================= 10. card + events */

    const card = await asTenant(a.businessId, (tx) =>
      getLeadCard({ businessId: a.businessId, leadId: noEmailLead.id }, { tx })
    );
    check("the card exposes the lead, its customer and a conversations section", () => {
      assert.equal(card.lead.id, noEmailLead.id);
      assert.notEqual(card.customer, null, "identity is shown by reference");
      assert.equal(card.customer?.id, noEmailLead.customerId);
      assert.equal(Array.isArray(card.conversations.items), true);
      assert.equal(card.followUp.kind, "none");
    });

    const events = await prisma.learningEvent.findMany({
      where: { businessId: a.businessId, entityType: "LEAD" },
      select: { eventType: true, entityId: true },
    });
    const types = new Set(events.map((e) => e.eventType));

    check("every business action landed in the EXISTING LearningEvent log", () => {
      for (const expected of [
        LEAD_EVENTS.CREATED,
        LEAD_EVENTS.STATUS_CHANGED,
        LEAD_EVENTS.FOLLOWUP_SET,
        LEAD_EVENTS.FOLLOWUP_COMPLETED,
        LEAD_EVENTS.WON,
        LEAD_EVENTS.LOST,
      ]) {
        assert.equal(types.has(expected), true, `missing event ${expected}`);
      }
    });

    check("a no-op status repeat emitted NO event", () => {
      const statusEvents = events.filter(
        (e) => e.eventType === LEAD_EVENTS.STATUS_CHANGED && e.entityId === noEmailLead.id
      );
      // QUOTED, LOST, OPEN — the repeated QUOTED must not appear a second time.
      assert.equal(statusEvents.length, 3, `expected 3 status events, got ${statusEvents.length}`);
    });

    const bEvents = await prisma.learningEvent.count({
      where: { businessId: b.businessId, entityType: "LEAD" },
    });
    check("business B only logged its own lead creation", () => {
      assert.equal(bEvents, 1);
    });

    console.log(`\nLEAD SERVICE VERIFY PASS — ${passed} checks green.`);
  } finally {
    // Cascade from Business removes leads, customers, users and events.
    await prisma.business
      .deleteMany({ where: { id: { in: [a.businessId, b.businessId] } } })
      .catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error("\nLEAD SERVICE VERIFY FAIL");
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
