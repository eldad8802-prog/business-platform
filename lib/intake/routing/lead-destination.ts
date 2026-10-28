/**
 * Business Intake M4 · the Lead destination (R4_EXPLICIT_LEAD), run by the core.
 *
 * ONE tenant transaction, so every effect is all-or-nothing and retry-safe:
 *
 *   1. idempotency  the normalized record already names a Lead → return it
 *                   (a replay / retry after commit can never create a second)
 *   2. locks        every identifier of the event (phone shares M2's WhatsApp
 *                   sender lock), in one global order
 *   3. identity     resolved AGAIN, authoritatively, under the locks
 *   4. contact      resolved   → that Customer (+ deterministic links for the
 *                                event's other identifiers nobody else holds)
 *                   unresolved → a NEW Customer (phone / email / name from the
 *                                hints) + deterministic links
 *                   self-asserted (website form, identity-policy@2) → never
 *                                resolved, never a new Customer, never a link:
 *                                a match is only a candidate for the owner
 *                   no identifiers → no contact (never a blind duplicate)
 *                   candidate / ambiguous / conflict → NO contact; the Lead is
 *                                created contact-less and one proposal per
 *                                candidate asks the owner. Nothing is merged.
 *   5. lead         createLead(contact decided above). An open lead already on
 *                   that phone → a VERIFIED event attaches to it (one lead per
 *                   phone, the domain's own rule); a SELF-ASSERTED one becomes its
 *                   own lead beside it and never touches it (G-01b).
 *   6. evidence     identity state / evidence categories / rule / destination /
 *                   result refs written onto the event's normalized record in the
 *                   SAME transaction — the idempotency anchor of step 1.
 */

import { appendLeadLifecycleEvent, lockLeadForLifecycle } from "@/lib/services/crm/lead-lifecycle.service";
import { Prisma } from "@prisma/client";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { leadService } from "@/lib/services/crm/lead.service";
import { customerService } from "@/lib/services/crm/customer.service";
import { LEAD_INTENT_MAX, OPEN_LEAD_STATUSES } from "@/lib/services/crm/lead-core";
import { recordSensor } from "@/lib/sensors/record-sensor";
import type {
  ClaimedIntakeEvent,
  IntakeRouteContext,
  NormalizedIntake,
  RouteResult,
} from "@/lib/intake/core/contract";
import { identifiersFromHints } from "@/lib/intake/identity/identifiers";
import { lockIdentifiers } from "@/lib/intake/identity/locks";
import { resolveIdentity, type IdentityResult } from "@/lib/intake/identity/resolve";
import { ensureLinks, unheldIdentifiers } from "@/lib/intake/identity/links";
import { openProposals } from "@/lib/intake/identity/proposals";
import type { RoutingDecision } from "./rules";

const SOURCE_CHANNEL_MAX = 60;

function leadName(n: NormalizedIntake): string {
  const h = n.contactHints;
  return (h?.displayName || h?.companyName || h?.email || h?.phone || "Lead").slice(0, 120);
}

async function findOpenLeadByPhone(tx: TenantTx, businessId: number, phone: string): Promise<number | null> {
  const open = await tx.lead.findFirst({
    // The domain's own definition of "open" (the one Lead_open_phone_key enforces).
    where: { businessId, phone, status: { in: [...OPEN_LEAD_STATUSES] } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return open?.id ?? null;
}

export async function routeToLead(
  ctx: IntakeRouteContext & { decision: RoutingDecision },
  normalized: NormalizedIntake,
  event: ClaimedIntakeEvent
): Promise<RouteResult> {
  const { businessId } = ctx;
  const identifiers = identifiersFromHints(normalized.contactHints, {
    sourceKey: event.sourceKey,
    accountRef: event.providerAccountRef,
  });

  const out = await withTenantTransaction(async (tx) => {
    // 1. idempotency anchor
    const prior = await tx.intakeNormalizedEvent.findFirst({
      where: { businessId, intakeEventId: event.id },
      select: { resultRefs: true },
    });
    const priorRefs = (prior?.resultRefs ?? null) as { leadId?: number; customerId?: number } | null;
    if (priorRefs?.leadId) {
      return { refs: { leadId: priorRefs.leadId, ...(priorRefs.customerId ? { customerId: priorRefs.customerId } : {}) }, identity: null, alreadyExisted: true };
    }

    // 2–3. lock, then resolve authoritatively
    await lockIdentifiers(tx, businessId, identifiers);
    const assurance = normalized.contactAssurance ?? "verified";
    const identity: IdentityResult = await resolveIdentity(tx, businessId, identifiers, { assurance });

    // 4. contact
    let customerId: number | null = null;
    let created = false;
    if (identity.state === "resolved") {
      customerId = identity.customerId;
    } else if (identity.state === "unresolved" && assurance === "verified") {
      // A self-asserted submission never CREATES a Customer either (G-01b): a Customer seeded from an
      // anonymous form would later attract verified events for that phone. The Lead carries the contact.
      const hints = normalized.contactHints ?? {};
      const c = await customerService.createCustomer(
        {
          businessId,
          name: leadName(normalized),
          phone: identifiers.find((i) => i.kind === "phone")?.value ?? null,
          email: identifiers.find((i) => i.kind === "email")?.value ?? hints.email ?? null,
        },
        { tx }
      );
      customerId = c.id;
      created = true;
    }
    // identity-policy@2 — self-asserted contact details never become identity links: a typed email on
    // a found Customer would make every later event with that email resolve to them (poisoning).
    if (customerId !== null && assurance === "verified") {
      await ensureLinks(tx, {
        businessId,
        customerId,
        identifiers,
        method: "deterministic",
        sourceIntakeEventId: event.id,
      });
    }

    // 5. lead
    const phone = identifiers.find((i) => i.kind === "phone")?.value ?? null;
    const openLeadId: number | null = phone ? await findOpenLeadByPhone(tx, businessId, phone) : null;
    // A verified event for a phone with an open lead attaches to it (one lead per phone). A self-asserted one
    // NEVER touches an existing lead (G-01b: no lifecycle event, no version bump, no change to its clock): it is
    // kept as its OWN lead, beside it — without the phone column (the one-open-lead-per-phone rule holds), the
    // typed phone stated in its text for the owner. Nothing is lost, nothing existing is altered.
    const attachedToOpenLead = openLeadId !== null && assurance === "verified";
    const heldBesideLeadId = openLeadId !== null && assurance === "self_asserted" ? openLeadId : null;
    let leadId: number | null = attachedToOpenLead ? openLeadId : null;
    if (leadId === null) {
      const answers = normalized.leadIntent ? normalized.leadIntent.trim() : "";
      const intent = heldBesideLeadId !== null
        ? [`טלפון שהוזן בטופס: ${phone} — כבר קיים ליד פתוח עם המספר הזה (ייתכן שזו אותה פנייה; הפרטים לא אומתו).`, answers].filter(Boolean).join("\n")
        : answers;
      const lead = await leadService.createLead(
        {
          businessId,
          name: leadName(normalized),
          phone: heldBesideLeadId !== null ? null : phone,
          email: identifiers.find((i) => i.kind === "email")?.value ?? null,
          sourceChannel: `intake:${event.sourceKey}`.slice(0, SOURCE_CHANNEL_MAX),
          // M6 — an explicit lead form's answers, as the owner reads them (personal; erased with the lead).
          intentSnapshot: intent.slice(0, LEAD_INTENT_MAX) || null,
          contact: { customerId },
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          lifecycleEvidence: { kind: "intake_event", ref: String(event.id) },
        },
        { tx }
      );
      leadId = lead.id;
    } else {
      // M5 — a further explicit lead event for a phone with an open lead: recorded
      // on that lead's lifecycle, once per intake event (the stage does not move).
      const locked = await lockLeadForLifecycle(tx, businessId, leadId);
      if (locked) {
        await appendLeadLifecycleEvent(tx, locked, {
          kind: "intake_attached",
          idempotencyKey: `intake:${event.id}:lead-attached`,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          evidence: { kind: "intake_event", ref: String(event.id) },
        });
      }
    }

    // Uncertain identity → ask the owner (idempotent per event + candidate).
    let proposalIds: number[] = [];
    if (identity.state === "candidate" || identity.state === "ambiguous" || identity.state === "conflict") {
      proposalIds = await openProposals(tx, {
        businessId,
        intakeEventId: event.id,
        leadId: attachedToOpenLead ? null : leadId,
        identity,
        // Only what nobody holds may be proposed; held identifiers are evidence.
        links: await unheldIdentifiers(tx, businessId, identifiers),
      });
    }

    if (created && customerId !== null) {
      await recordSensor(
        {
          businessId,
          sensor: "CUSTOMER_CREATED",
          entityId: customerId,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          payload: { origin: "INTAKE", leadId },
          idempotencyKey: `customer:${customerId}:created`,
        },
        { tx }
      );
    }

    // 6. evidence + idempotency anchor, same transaction
    const refs: { leadId: number; customerId?: number } = { leadId, ...(customerId ? { customerId } : {}) };
    await tx.intakeNormalizedEvent.updateMany({
      where: { businessId, intakeEventId: event.id },
      data: {
        identityState: identity.state,
        identityPolicyVersion: identity.policyVersion,
        identityCustomerId: identity.state === "resolved" || created ? customerId : null,
        identityEvidence: {
          ...identity.evidence,
          createdCustomer: created,
          attachedToOpenLead,
          // G-01b — kept beside an existing open lead with the same typed phone (never attached to it).
          heldBesideOpenLead: heldBesideLeadId !== null,
          proposals: proposalIds.length,
        } as Prisma.InputJsonValue,
        identityCandidateCount: identity.candidates.length,
        routingRule: ctx.decision.rule,
        routingDestination: ctx.decision.destination,
        ownerReviewRequired: proposalIds.length > 0,
        resultRefs: refs as Prisma.InputJsonValue,
      },
    });
    return { refs, identity, alreadyExisted: false };
  });

  return { kind: "routed", refs: out.refs, alreadyExisted: out.alreadyExisted };
}
