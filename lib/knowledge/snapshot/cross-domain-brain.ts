/**
 * Business Brain · cross-domain families built on bks.v2 — deterministic, non-causal, premise-checked. Pure.
 *
 * Each rule joins knowledge that ALREADY exists in the snapshot through a link the product itself
 * asserts (a foreign key, the business as a whole) and states what co-occurs. None of them states a
 * cause, a forecast, an adequacy judgement ("enough to pay") or a recommendation. Premises must be
 * ACTIVE and fresh; memory items (never fresh) can never be premises.
 *
 *   X-CUST-01  customer / billing / payments / collection / appointments / leads — what several domains
 *              know about ONE customer, joined by customerId only (never by phone, email or tax id)
 *   X-CASH-01  payables / billing / collection — obligations due and receivables due inside the same
 *              30-day window, side by side, with the business's own typical lateness when known
 *   X-REPL-01  inventory / purchasing / suppliers — an item's restock rhythm next to the purchase and
 *              delivery behaviour of the suppliers its own purchase orders name (stock quantities excluded)
 *   X-RESP-01  conversations / leads — the owner's responsiveness to inbound demand, measured in two domains
 */
import type { AuthorityClass, CrossDomainFinding, KnowledgeGap, KnowledgeItem, ProvenanceRef, RelationshipItem } from "./snapshot.contract";
import type { CrossDomainContext, CrossDomainRule } from "./cross-domain";

const DAY = 86_400_000;
const MAX_REFS = 20;
const premise = (i: KnowledgeItem) => ({ slot: i.slot, authority: i.authority, provenance: i.provenance });
const live = (i: KnowledgeItem) => i.freshness.fresh && (i.kind === "MEASURE" || i.kind === "TEMPORAL_STATE");
const links = (input: CrossDomainContext) => input.relationships.filter((r) => r.type === "RECORD_LINK" && r.status === "ACTIVE");
const relationOf = (r: RelationshipItem) => (r.via.type === "foreign-key" ? r.via.relation : "");
const gap = (ruleId: string, key: string, reason: string, n: number, need: number | null = null): KnowledgeGap => ({
  slot: `gap|${ruleId}|PREMISE_UNAVAILABLE`, domain: "cross-domain", key, ruleId, kind: "PREMISE_UNAVAILABLE",
  reason, subjectsAffected: n, have: null, need, needSpanDays: null,
});

/* ───────────────────────── X-CUST-01 ───────────────────────── */

const CUSTOMER_RELATION_DOMAIN: Record<string, string> = {
  "customer.invoices": "billing", "customer.payment_links": "payments", "customer.reminders": "collection",
  "customer.appointments": "appointments", "customer.leads": "leads",
};

export const X_CUST_01: CrossDomainRule = {
  ruleId: "X-CUST-01",
  version: "v1",
  domains: ["customers", "billing", "payments", "collection", "appointments", "leads"],
  requires:
    "ACTIVE, fresh learned knowledge about ONE customer (a customer-keyed measure or temporal state), and that " +
    "customer's records in at least one other domain joined by the product's own customerId foreign key " +
    "(invoices, payment links, reminders, appointments, leads) or an open awaiting-payment exposure.",
  evaluate(input) {
    const findings: CrossDomainFinding[] = [];
    const custItems = new Map<number, KnowledgeItem[]>();
    for (const i of input.items) {
      if (!live(i) || i.subject?.type !== "customer") continue;
      const id = Number(i.subject.id);
      custItems.set(id, [...(custItems.get(id) ?? []), i]);
    }
    const custLinks = new Map<number, RelationshipItem[]>();
    for (const r of links(input)) {
      if (r.left.type !== "customer" || !(relationOf(r) in CUSTOMER_RELATION_DOMAIN)) continue;
      const id = Number(r.left.id);
      custLinks.set(id, [...(custLinks.get(id) ?? []), r]);
    }
    const exposure = new Map(input.domain.awaiting.map((a) => [a.customerId, a]));
    let linkedWithoutKnowledge = 0;
    const ids = new Set([...custItems.keys(), ...custLinks.keys()]);
    for (const id of [...ids].sort((a, b) => a - b)) {
      const known = custItems.get(id) ?? [];
      const rels = custLinks.get(id) ?? [];
      const exp = exposure.get(id);
      if (known.length === 0) { if (rels.length > 0) linkedWithoutKnowledge += 1; continue; }
      const domains = new Set<string>(known.map((i) => i.domain));
      for (const r of rels) domains.add(CUSTOMER_RELATION_DOMAIN[relationOf(r)]);
      if (exp) domains.add("collection");
      if (domains.size < 2) continue;
      const byDomain: Record<string, string[]> = {};
      for (const i of known) (byDomain[i.domain] ??= []).push(i.slot);
      for (const k of Object.keys(byDomain)) byDomain[k].sort();
      findings.push({
        slot: `finding|X-CUST-01|customer|${id}`, ruleId: "X-CUST-01", ruleVersion: "v1", type: "CUSTOMER_CROSS_DOMAIN_PROFILE",
        domains: [...domains].sort(), subject: { type: "customer", id },
        establishes: "These records belong to one customer by the product's own customer link, and this is what each domain knows about that customer at the same time.",
        causal: false, authority: "CROSS_DOMAIN_DERIVATION",
        value: {
          knowledgeByDomain: byDomain,
          linkedRecords: Object.fromEntries(rels.map((r) => [relationOf(r), r.records ?? 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
          awaiting: exp ? { invoices: exp.invoiceCount, maxDaysAwaiting: exp.maxDaysAwaiting, outstanding: exp.totalOutstanding, currency: exp.currency } : null,
        },
        premises: [
          ...known.map(premise),
          ...rels.map((r) => ({ slot: r.slot, authority: r.authority, provenance: r.provenance })),
          ...(exp ? [{ slot: `state|awaiting|customer|${id}`, authority: "AUTHORITATIVE_DOMAIN_STATE" as AuthorityClass,
            provenance: exp.invoiceIds.slice(0, MAX_REFS).map((x) => ({ store: "AwaitingPayment" as const, id: `invoice:${x}` })) as ProvenanceRef[] }] : []),
        ].sort((a, b) => a.slot.localeCompare(b.slot)),
        caveats: ["CUSTOMER_JOINED_BY_FOREIGN_KEY_ONLY", "CO_OCCURRENCE_IS_NOT_CAUSE"],
      });
    }
    return { findings, gaps: linkedWithoutKnowledge > 0
      ? [gap("X-CUST-01", "customer_profile", "CUSTOMER_LINKED_BUT_NO_ACTIVE_CUSTOMER_KNOWLEDGE", linkedWithoutKnowledge, 1)] : [] };
  },
};

/* ───────────────────────── X-CASH-01 ───────────────────────── */

export const X_CASH_01: CrossDomainRule = {
  ruleId: "X-CASH-01",
  version: "v1",
  domains: ["payables", "billing", "collection"],
  requires:
    "Open payables installments due inside the next 30 days (M1 definition of unpaid), AND billing activity for the " +
    "business (invoices in the link window, an awaiting-payment exposure or invoices due inside the window), so that " +
    "a zero on the receivables side is a known zero, not a missing domain.",
  evaluate(input) {
    const horizon = input.asOf.getTime() + 30 * DAY;
    let dueCount = 0, dueAmount = 0, overdue = 0;
    let currency: string | null = null;
    const ids: number[] = [];
    for (const i of input.stored.installments) {
      const remaining = Number(i.scheduledAmount) - i.allocations.reduce((s, a) => s + Number(a.allocatedAmount), 0);
      if (remaining <= 0.009) continue;
      if (i.dueAt.getTime() < input.asOf.getTime()) { overdue += 1; continue; }
      if (i.dueAt.getTime() > horizon) continue;
      dueCount += 1; dueAmount += remaining; currency = currency ?? i.currency; ids.push(i.id);
    }
    const rw = input.stored.depth?.receivablesWindow ?? null;
    const billingActive = links(input).some((r) => relationOf(r) === "customer.invoices") || input.domain.awaiting.length > 0 || (rw?.invoices ?? 0) > 0;
    if (dueCount === 0 || !billingActive || !rw) {
      return { findings: [], gaps: [gap("X-CASH-01", "obligations_and_receivables",
        dueCount === 0 ? "NO_PAYABLES_DUE_IN_WINDOW" : "NO_BILLING_ACTIVITY_TO_COMPARE", 1)] };
    }
    const lateness = input.items.find((i) => i.key === "billing.payment_timing" && i.kind === "MEASURE" && i.freshness.fresh && i.subject == null);
    const overdueReceivables = input.domain.awaiting.reduce((s, a) => s + a.invoiceCount, 0);
    return {
      findings: [{
        slot: "finding|X-CASH-01|business", ruleId: "X-CASH-01", ruleVersion: "v1", type: "OBLIGATIONS_AND_RECEIVABLES_IN_WINDOW",
        domains: ["billing", "collection", "payables"], subject: { type: "business", id: 0 },
        establishes: "These obligations fall due and these receivables fall due inside the same next 30 days; nothing here says whether one covers the other.",
        causal: false, authority: "CROSS_DOMAIN_DERIVATION",
        value: {
          windowDays: 30,
          payablesDue: { installments: dueCount, amount: Math.round(dueAmount * 100) / 100, currency },
          payablesOverdue: { installments: overdue },
          receivablesDue: { invoices: rw.invoices, amount: rw.amount, currency: rw.currency },
          receivablesOverdue: { customers: input.domain.awaiting.length, invoices: overdueReceivables },
          typicalCustomerLatenessKnown: !!lateness,
        },
        premises: [
          { slot: "state|payables.due_30d", authority: "AUTHORITATIVE_DOMAIN_STATE" as AuthorityClass,
            provenance: ids.slice(0, MAX_REFS).map((x) => ({ store: "PayablesExposure" as const, id: `installment:${x}` })) as ProvenanceRef[] },
          { slot: "state|receivables.due_30d", authority: "AUTHORITATIVE_DOMAIN_STATE" as AuthorityClass,
            provenance: rw.invoiceIds.slice(0, MAX_REFS).map((x) => ({ store: "ReceivablesWindow" as const, id: `invoice:${x}` })) as ProvenanceRef[] },
          ...(lateness ? [premise(lateness)] : []),
        ].sort((a, b) => a.slot.localeCompare(b.slot)),
        caveats: ["NO_CASH_BALANCE_KNOWN", "NOT_A_FORECAST", "REFUNDS_NOT_NETTED_KNOWN_ACCOUNTING_GAP", "VOIDED_PAYMENT_DOES_NOT_CASCADE_KNOWN_GAP"],
      }],
      gaps: [],
    };
  },
};

/* ───────────────────────── X-REPL-01 ───────────────────────── */

export const X_REPL_01: CrossDomainRule = {
  ruleId: "X-REPL-01",
  version: "v1",
  domains: ["inventory", "suppliers"],
  requires:
    "An ACTIVE, fresh restock-interval measure for an inventory item, and at least one supplier that the business's own " +
    "purchase-order lines name for that item with ACTIVE, fresh purchase-cadence or delivery-lag knowledge. Stock " +
    "quantities (stock pressure) are never a premise: the POS held-sale defect can corrupt them.",
  evaluate(input) {
    const findings: CrossDomainFinding[] = [];
    const restock = new Map<number, KnowledgeItem>();
    for (const i of input.items) {
      if (i.kind === "MEASURE" && i.freshness.fresh && i.key === "inventory.restock_interval" && i.subject?.type === "inventory-item") restock.set(Number(i.subject.id), i);
    }
    const supplierKnowledge = new Map<number, KnowledgeItem[]>();
    for (const i of input.items) {
      if (i.kind !== "MEASURE" || !i.freshness.fresh || i.subject?.type !== "supplier") continue;
      if (i.key !== "suppliers.purchase_cadence" && i.key !== "suppliers.delivery_lag") continue;
      const id = Number(i.subject.id);
      supplierKnowledge.set(id, [...(supplierKnowledge.get(id) ?? []), i]);
    }
    let noSupplierKnowledge = 0;
    for (const itemId of [...restock.keys()].sort((a, b) => a - b)) {
      const rels = links(input).filter((r) => relationOf(r) === "supplier.items" && r.right.type === "inventory-item" && Number(r.right.id) === itemId);
      const suppliers = rels.map((r) => Number(r.left.id)).filter((s) => supplierKnowledge.has(s)).sort((a, b) => a - b);
      if (suppliers.length === 0) { noSupplierKnowledge += 1; continue; }
      const sk = suppliers.flatMap((s) => supplierKnowledge.get(s)!);
      const item = restock.get(itemId)!;
      findings.push({
        slot: `finding|X-REPL-01|inventory-item|${itemId}`, ruleId: "X-REPL-01", ruleVersion: "v1", type: "REPLENISHMENT_PROFILE",
        domains: ["inventory", "suppliers"], subject: { type: "inventory-item", id: itemId },
        establishes: "This item's restock rhythm and the purchase and delivery behaviour of the suppliers its purchase orders name, known at the same time.",
        causal: false, authority: "CROSS_DOMAIN_DERIVATION",
        value: { suppliers: suppliers.map((s) => ({ type: "supplier", id: s })), knowledge: [item.slot, ...sk.map((x) => x.slot)].sort() },
        premises: [premise(item), ...sk.map(premise),
          ...rels.filter((r) => suppliers.includes(Number(r.left.id))).map((r) => ({ slot: r.slot, authority: r.authority, provenance: r.provenance }))]
          .sort((a, b) => a.slot.localeCompare(b.slot)),
        caveats: ["STOCK_QUANTITIES_NOT_USED_POS_HELD_SALE_DEFECT", "CO_OCCURRENCE_IS_NOT_CAUSE"],
      });
    }
    return { findings, gaps: noSupplierKnowledge > 0
      ? [gap("X-REPL-01", "replenishment_profile", "ITEM_SUPPLIERS_HAVE_NO_ACTIVE_KNOWLEDGE", noSupplierKnowledge, 1)] : [] };
  },
};

/* ───────────────────────── X-RESP-01 ───────────────────────── */

const RESPONSIVENESS_KEYS = ["conversations.first_reply_days", "leads.first_handling_days", "leads.follow_up_punctuality"];

export const X_RESP_01: CrossDomainRule = {
  ruleId: "X-RESP-01",
  version: "v1",
  domains: ["conversations", "leads"],
  requires:
    "ACTIVE, fresh business-level responsiveness knowledge in BOTH conversations (first reply, real inbound only) and " +
    "leads (first handling or follow-up punctuality). Temporal states of those keys are attached when present.",
  evaluate(input) {
    const measures = input.items.filter((i) => i.kind === "MEASURE" && i.freshness.fresh && i.subject == null && RESPONSIVENESS_KEYS.includes(i.key));
    const domains = new Set(measures.map((m) => m.domain));
    if (!(domains.has("conversations") && domains.has("leads"))) {
      return { findings: [], gaps: [gap("X-RESP-01", "inbound_responsiveness", "RESPONSIVENESS_KNOWN_IN_FEWER_THAN_TWO_DOMAINS", 1, 2)] };
    }
    const states = input.items.filter((i) => i.kind === "TEMPORAL_STATE" && i.freshness.fresh && i.subject == null && RESPONSIVENESS_KEYS.includes(i.key));
    return {
      findings: [{
        slot: "finding|X-RESP-01|business", ruleId: "X-RESP-01", ruleVersion: "v1", type: "INBOUND_RESPONSIVENESS_PROFILE",
        domains: ["conversations", "leads"], subject: { type: "business", id: 0 },
        establishes: "How quickly this business responds to inbound demand is known in both its conversations and its leads, at the same time.",
        causal: false, authority: "CROSS_DOMAIN_DERIVATION",
        value: { knowledge: measures.map((m) => m.slot).sort(), temporalStates: states.map((s) => s.slot).sort() },
        premises: [...measures, ...states].map(premise).sort((a, b) => a.slot.localeCompare(b.slot)),
        caveats: ["REPLY_IS_ANY_OUTBOUND_MESSAGE_SENDER_TYPE_NOT_TRUSTED", "CO_OCCURRENCE_IS_NOT_CAUSE"],
      }],
      gaps: [],
    };
  },
};
