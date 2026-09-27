/**
 * M7 · Cross-domain rules — deterministic, non-causal, premise-checked. Pure.
 *
 * A rule declares its domains, its required premises and what its output establishes. It fires only
 * when every required premise is ACTIVE, fresh and reachable through an AUTHORITATIVE relationship;
 * otherwise it returns a gap saying which premise is missing. A finding can never outlive its
 * premises: findings are derived at snapshot time from the current premises, so a reversed or stale
 * premise simply produces no finding.
 *
 * Nothing here names a cause. "An overdue exposure exists and N reminders are recorded" is what the
 * evidence shows; "the reminders did not work" is not, and is never written.
 *
 * The audit of every candidate family, and why only two are READY, is in
 * docs/learning/BUSINESS_KNOWLEDGE_SNAPSHOT.md and in CROSS_DOMAIN_FAMILIES below.
 */
import type {
  AuthorityClass,
  CrossDomainFinding,
  KnowledgeGap,
  KnowledgeItem,
  ProvenanceRef,
  RelationshipItem,
} from "./snapshot.contract";
import type { DomainState, StoredKnowledge } from "./snapshot-sources";

const DAY = 86_400_000;
const MAX_REFS = 20;

export type CrossDomainContext = {
  readonly asOf: Date;
  readonly items: readonly KnowledgeItem[];
  readonly relationships: readonly RelationshipItem[];
  readonly domain: DomainState;
  readonly stored: Pick<StoredKnowledge, "installments" | "actions">;
};

export type CrossDomainRule = {
  readonly ruleId: string;
  readonly version: string;
  readonly domains: readonly string[];
  readonly requires: string;
  evaluate(input: CrossDomainContext): { findings: CrossDomainFinding[]; gaps: KnowledgeGap[] };
};

/* ───────────────────────── X-COLL-01 · overdue exposure with recorded collection activity ───────────────────────── */

export const X_COLL_01: CrossDomainRule = {
  ruleId: "X-COLL-01",
  version: "v1",
  domains: ["billing", "collections", "customers"],
  requires:
    "An issued, customer-linked invoice past its expected payment date with a balance (awaiting-payment, " +
    "AUTHORITATIVE_DOMAIN_STATE), joined by customerId (a verified FK) to owner-initiated reminders " +
    "(CollectionAction, append-only, AUTHORITATIVE_DOMAIN_STATE).",
  evaluate(input) {
    const byCustomer = new Map<number, { id: number; at: Date }[]>();
    for (const a of input.stored.actions) {
      if (a.customerId == null) continue;
      const list = byCustomer.get(a.customerId) ?? [];
      list.push({ id: a.id, at: a.occurredAt });
      byCustomer.set(a.customerId, list);
    }
    const findings: CrossDomainFinding[] = [];
    for (const c of [...input.domain.awaiting].sort((x, y) => x.customerId - y.customerId)) {
      const acts = (byCustomer.get(c.customerId) ?? []).sort((x, y) => x.at.getTime() - y.at.getTime() || x.id - y.id);
      const last = acts.length > 0 ? acts[acts.length - 1] : null;
      const sinceAwaiting = acts.filter((a) => a.at >= c.awaitingSince).length;
      const exposureSlot = `state|billing.awaiting|customer|${c.customerId}`;
      const activitySlot = `state|collections.reminders_90d|customer|${c.customerId}`;
      findings.push({
        slot: `finding|X-COLL-01|customer|${c.customerId}`,
        ruleId: "X-COLL-01",
        ruleVersion: "v1",
        type: "EXPOSURE_WITH_RECORDED_ACTIVITY",
        domains: ["billing", "collections"],
        subject: { type: "customer", id: c.customerId },
        establishes:
          "This customer has invoices past their expected payment date, and this many owner-initiated reminders are recorded in Dubiz for them in the last 90 days.",
        causal: false,
        authority: "CROSS_DOMAIN_DERIVATION",
        value: {
          invoicesAwaiting: c.invoiceCount,
          maxDaysAwaiting: c.maxDaysAwaiting,
          totalOutstanding: c.totalOutstanding,
          currency: c.currency,
          recordedRemindersLast90d: acts.length,
          remindersSinceAwaiting: sinceAwaiting,
          lastReminderDaysAgo: last ? Math.floor((input.asOf.getTime() - last.at.getTime()) / DAY) : null,
        },
        premises: [
          {
            slot: exposureSlot,
            authority: "AUTHORITATIVE_DOMAIN_STATE",
            provenance: c.invoiceIds.slice(0, MAX_REFS).map((id) => ({ store: "AwaitingPayment" as const, id: `invoice:${id}` })),
          },
          {
            slot: activitySlot,
            authority: "AUTHORITATIVE_DOMAIN_STATE",
            provenance: acts.slice(-MAX_REFS).map((a) => ({ store: "CollectionAction" as const, id: a.id })),
          },
        ],
        caveats: [
          "REMINDERS_OUTSIDE_DUBIZ_NOT_OBSERVED",
          "A_RECORDED_REMINDER_PROVES_NEITHER_DELIVERY_NOR_EFFECT",
          "REFUNDS_NOT_NETTED_KNOWN_ACCOUNTING_GAP",
        ],
      });
    }
    return { findings, gaps: [] };
  },
};

/* ───────────────────────── X-PARTY-01 · one counterparty, knowledge in several domains ───────────────────────── */

type ExposureSummary = { open: number; overdue: number; dueWithin30: number; unpaid: number; currency: string | null; ids: number[] };

function payableExposure(input: CrossDomainContext, payeeIds: ReadonlySet<number>): ExposureSummary {
  const s: ExposureSummary = { open: 0, overdue: 0, dueWithin30: 0, unpaid: 0, currency: null, ids: [] };
  for (const i of input.stored.installments) {
    const payee = i.commitment.payeeId;
    if (payee == null || !payeeIds.has(payee)) continue;
    const allocated = i.allocations.reduce((sum, a) => sum + Number(a.allocatedAmount), 0);
    const remaining = Number(i.scheduledAmount) - allocated;
    if (remaining <= 0.009) continue;
    s.open += 1;
    s.unpaid += remaining;
    s.currency = s.currency ?? i.currency;
    s.ids.push(i.id);
    if (i.dueAt < input.asOf) s.overdue += 1;
    else if (i.dueAt.getTime() - input.asOf.getTime() <= 30 * DAY) s.dueWithin30 += 1;
  }
  s.unpaid = Math.round(s.unpaid * 100) / 100;
  s.ids.sort((a, b) => a - b);
  return s;
}

export const X_PARTY_01: CrossDomainRule = {
  ruleId: "X-PARTY-01",
  version: "v1",
  domains: ["suppliers", "documents", "payables"],
  requires:
    "Two or more of this business's supplier / payee / document-vendor records bound to ONE Party by an " +
    "owner's confirmation or a valid tax id (never a name or phone resemblance), and ACTIVE, fresh knowledge " +
    "or open payables exposure for that counterparty in at least two domains.",
  evaluate(input) {
    const findings: CrossDomainFinding[] = [];
    let insufficient = 0;
    const byParty = new Map<number, RelationshipItem[]>();
    for (const r of input.relationships) {
      if (r.status !== "ACTIVE") continue; // PROPOSED and REJECTED can never be premises
      const list = byParty.get(r.via.id) ?? [];
      list.push(r);
      byParty.set(r.via.id, list);
    }
    for (const partyId of [...byParty.keys()].sort((a, b) => a - b)) {
      const rels = byParty.get(partyId)!;
      const subjects = new Map<string, { type: string; id: number }>();
      for (const r of rels) for (const s of [r.left, r.right]) subjects.set(`${s.type}:${s.id}`, s as { type: string; id: number });
      const supplierIds = new Set([...subjects.values()].filter((s) => s.type === "SUPPLIER").map((s) => s.id));
      const payeeIds = new Set([...subjects.values()].filter((s) => s.type === "PAYEE").map((s) => s.id));

      const premiseItems = input.items.filter((it) =>
        it.freshness.fresh && it.subject != null && (
          (it.subject.type === "supplier" && supplierIds.has(Number(it.subject.id))) ||
          (it.subject.type === "payee" && payeeIds.has(Number(it.subject.id))) ||
          (it.subject.type === "party" && Number(it.subject.id) === partyId)));
      const exposure = payableExposure(input, payeeIds);
      const domains = new Set(premiseItems.map((i) => i.domain));
      if (exposure.open > 0) domains.add("payables");
      if (domains.size < 2) { insufficient += 1; continue; }

      const byDomain: Record<string, string[]> = {};
      for (const it of premiseItems) (byDomain[it.domain] ??= []).push(it.slot);
      for (const k of Object.keys(byDomain)) byDomain[k].sort();

      findings.push({
        slot: `finding|X-PARTY-01|party|${partyId}`,
        ruleId: "X-PARTY-01",
        ruleVersion: "v1",
        type: "LINKED_COUNTERPARTY_CONDITION",
        domains: [...domains].sort(),
        subject: { type: "party", id: partyId },
        establishes:
          "These records are one counterparty by owner confirmation or tax id, and this knowledge about them exists at the same time in several domains.",
        causal: false,
        authority: "CROSS_DOMAIN_DERIVATION",
        value: {
          linkedSubjects: [...subjects.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id),
          knowledgeByDomain: byDomain,
          payablesExposure: exposure.open > 0
            ? { openInstallments: exposure.open, overdue: exposure.overdue, dueWithin30Days: exposure.dueWithin30, unpaid: exposure.unpaid, currency: exposure.currency }
            : null,
        },
        premises: [
          ...rels.map((r) => ({ slot: r.slot, authority: r.authority, provenance: r.provenance })),
          ...premiseItems.map((i) => ({ slot: i.slot, authority: i.authority, provenance: i.provenance })),
          ...(exposure.open > 0
            ? [{ slot: `state|payables.exposure|party|${partyId}`, authority: "AUTHORITATIVE_DOMAIN_STATE" as AuthorityClass,
                provenance: exposure.ids.slice(0, MAX_REFS).map((id) => ({ store: "PayablesExposure" as const, id: `installment:${id}` })) as ProvenanceRef[] }]
            : []),
        ].sort((a, b) => a.slot.localeCompare(b.slot)),
        caveats: ["VOIDED_PAYMENT_DOES_NOT_CASCADE_KNOWN_GAP"],
      });
    }
    const gaps: KnowledgeGap[] = insufficient > 0
      ? [{
          slot: "gap|X-PARTY-01|PREMISE_UNAVAILABLE", domain: "cross-domain", key: "linked_counterparty", ruleId: "X-PARTY-01",
          kind: "PREMISE_UNAVAILABLE", reason: "LINKED_COUNTERPARTY_HAS_FRESH_KNOWLEDGE_IN_FEWER_THAN_TWO_DOMAINS",
          subjectsAffected: insufficient, have: null, need: 2, needSpanDays: null,
        }]
      : [];
    return { findings, gaps };
  },
};

export const CROSS_DOMAIN_RULES: readonly CrossDomainRule[] = [X_COLL_01, X_PARTY_01];

/**
 * Every audited family and its status. Blocked families become RULE_BLOCKED gaps in the snapshot, so
 * a consumer is told that Dubiz CANNOT know this yet, and why — rather than meeting silence.
 */
export const CROSS_DOMAIN_FAMILIES = [
  { family: "A", name: "customer / collections / payments", status: "READY", rule: "X-COLL-01",
    note: "Exposure + recorded reminders is READY. 'Payment after reminder' is NOT built: paidAt is processing time, and sequence is not effect." },
  { family: "B", name: "supplier / purchasing / payables", status: "READY", rule: "X-PARTY-01",
    note: "Only through a Party bound by owner confirmation or a valid tax id." },
  { family: "C", name: "documents / suppliers / payables", status: "READY", rule: "X-PARTY-01",
    note: "Document knowledge is keyed on a resolved Party; the same rule joins it — never a vendor string." },
  { family: "D", name: "inventory / purchasing / suppliers", status: "BLOCKED_PRODUCT_DEFECT", rule: null,
    note: "Stock pressure (INV-05) is corrupted by the POS held-sale defect; restock ↔ receiving is the same event seen twice, not a relationship." },
  { family: "E", name: "leads / customers / billing / revenue", status: "BLOCKED_SENSOR", rule: null,
    note: "No authoritative lead → paying-customer link (Lead.customerId is bound at creation); conversion cannot be established." },
  { family: "F", name: "response / conversations / leads", status: "BLOCKED_SENSOR", rule: null,
    note: "Message senderType is client-asserted and first-response has no writer (manifest PARTIAL/GAP)." },
  { family: "G", name: "business cost / obligations / payments", status: "PARTIAL", rule: null,
    note: "A commitments list alone is single-domain; its cross-domain half (recurring vendor + payee) is X-PARTY-01." },
  { family: "H", name: "document processing / financial operations", status: "NOT_JUSTIFIED", rule: null,
    note: "Filing lag and review backlog are both documents-domain; combining them is not cross-domain knowledge." },
] as const;
