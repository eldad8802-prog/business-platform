/**
 * Daily Tasks — the eight first-version source adapters (Daily Tasks spec section 4, M2 rows). SERVER-ONLY.
 *
 *   S01 supplier payments  — the secretary's own port (getBriefing): the same items, the same order, both stores
 *   S02 customer debt      — the collection list (awaiting-payment rules)
 *   S06 invoice review     — billing documents in PENDING_REVIEW
 *   S13/S14 leads          — evaluateLeadAttention: follow-up due / overdue, customer wrote, new and unhandled;
 *                            follow-ups of the next 7 days for "בהמשך השבוע"
 *   S16 conversations      — open conversations whose last message is the customer's
 *   S23 documents queue    — one row while documents wait for review
 *   S25 stock              — open low / critical stock alerts
 *
 * READ-ONLY. Every adapter runs in the business's tenant context (a context-less read would silently return
 * nothing under RLS — `runAdapter` refuses to run without a business), in isolation and under a time limit: one
 * source failing makes that source FAILED and the agenda PARTIAL, never empty and never wrong. An adapter that hits
 * its fetch cap says CAPPED, so the count reads "N+". Nothing here writes, and nothing names money that the
 * secretary does not already show.
 */
import { BillingDocumentStatus } from "@prisma/client";

import { loadAttentionWaiting, loadLeadsNeedingAttention } from "@/lib/business-status/loaders";
import { countPendingReviewAllTime, listPendingReviewMonths, pendingReviewInboxHref } from "@/lib/documents/pending-review";
import { loadAwaitingPaymentList } from "@/lib/services/billing/collection/awaiting-payment.loader";
import { evaluateLeadAttention } from "@/lib/services/crm/lead-attention";
import { OPEN_LEAD_STATUSES, endOfLeadDayUtc, type LeadStatusValue } from "@/lib/services/crm/lead-core";
import { getBriefing } from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { addCalendarDays, daysBetweenDayKeys, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { DEFAULT_LOCALE, intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";

import { HEBREW_TEXT, SOURCE_KINDS, shortDate, type SourceItem, type SourceKind, type SourceResult } from "./agenda-core";

export const ADAPTER_TIMEOUT_MS = 6000;

/**
 * `t` / `locale`: the interface language of the request the agenda is built for (titles, facts and action labels
 * are read-time text — nothing an adapter builds is stored). Absent → Hebrew, as before.
 */
export type AdapterCtx = { businessId: number; now: Date; today: JerusalemDayKey; t?: Translator; locale?: Locale };
type AdapterOut = { items: SourceItem[]; capped: boolean };
type Adapter = (ctx: AdapterCtx) => Promise<AdapterOut>;

const epoch = (d: Date | null | undefined) => (d ? String(d.getTime()) : "0");
const money = (amount: string | number, currency = "ILS", locale: Locale = DEFAULT_LOCALE) => {
  const n = Number(amount);
  const s = Number.isFinite(n) ? n.toLocaleString(intlTag(locale), { maximumFractionDigits: 2 }) : String(amount);
  return currency === "ILS" ? `₪${s}` : `${s} ${currency}`;
};

/** "לפני 3 שעות" / "מאתמול" — relative facts, a fixed template. */
export function relativeHe(at: Date, now: Date, t: Translator = HEBREW_TEXT): string {
  const mins = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
  if (mins < 60) return mins <= 1 ? t("system.tasks.relative.justNow") : t("system.tasks.relative.minutes", { n: mins });
  const hours = Math.round(mins / 60);
  const today = jerusalemDayKey(now);
  const day = jerusalemDayKey(at);
  if (day === today) return hours === 1 ? t("system.tasks.relative.hour") : t("system.tasks.relative.hours", { n: hours });
  if (addCalendarDays(day, 1) === today) return t("system.tasks.relative.yesterday");
  return t("system.tasks.relative.since", { date: shortDate(day) });
}

// ── S01 Supplier payments (the secretary's port) ─────────────────────────────────────────────────

export const supplierPayments: Adapter = async ({ businessId, now, today, t = HEBREW_TEXT, locale }) => {
  const briefing = await tenantTx(businessId, (tx) => getBriefing(businessId, obligationServiceDeps({ tx })));
  const items: SourceItem[] = briefing.attention.map(({ obligation: o }, idx) => {
    const dueOn = jerusalemDayKey(o.dueAt);
    const remaining = o.ledger ? money(o.ledger.remaining, o.currency, locale) : null;
    const facts = dueOn < today
      ? [t("system.tasks.supplier.wasDue", { date: shortDate(dueOn) }), t("system.tasks.supplier.notPaid")]
      : dueOn === today ? [t("system.tasks.supplier.dueToday")] : [t("system.tasks.supplier.dueOn", { date: shortDate(dueOn) })];
    if (remaining) facts.push(t("system.tasks.supplier.remaining", { amount: remaining }));
    // A postponed reminder on a payment due today or overdue: the debt stays visible and counted (3.5).
    const postponed = o.followUpAt && o.followUpAt > now && dueOn <= today ? { until: jerusalemDayKey(o.followUpAt) } : null;
    return {
      sourceKind: "supplier_payment",
      dedupeKey: `obligation:${o.id}`,
      cycleKey: `i${o.id}`,
      evidenceVersion: `d${dueOn}`,
      placement: "BY_DATE",
      dueOn,
      severity: "NORMAL",
      title: o.obligeeName,
      fact: facts.join(" · "),
      factAt: o.dueAt.toISOString(),
      action: { label: t("system.tasks.supplier.action"), href: `/secretary?screen=detail&id=${o.id}` },
      snooze: "PAYMENT",
      reminderPostponed: postponed,
      orderHint: idx,
      entity: { kind: "obligation", id: o.id },
      details: {
        amount: o.amount,
        currency: o.currency,
        remaining: o.ledger ? o.ledger.remaining : null,
        commitmentId: o.ledger ? o.ledger.commitmentId : null,
        installmentId: o.ledger ? o.ledger.installmentId : null,
        followUpOn: o.followUpAt ? jerusalemDayKey(o.followUpAt) : null,
      },
    } satisfies SourceItem;
  });
  return { items, capped: false };
};

// ── S02 Customer debt ────────────────────────────────────────────────────────────────────────────

const CUSTOMER_DEBT_CAP = 50;
export const customerDebt: Adapter = async ({ businessId, now, t = HEBREW_TEXT, locale }) => {
  const list = await loadAwaitingPaymentList(businessId, now);
  const items: SourceItem[] = list.customers
    .filter((c) => c.customerId !== null)
    .slice(0, CUSTOMER_DEBT_CAP)
    .map((c) => {
      const n = c.invoices.length;
      const maxId = Math.max(...c.invoices.map((i) => i.id));
      return {
        sourceKind: "customer_debt",
        dedupeKey: `customer:${c.customerId}:collect`,
        cycleKey: `s${jerusalemDayKey(c.awaitingSince)}`,
        evidenceVersion: `n${n}.m${maxId}`,
        placement: "TODAY",
        dueOn: null,
        severity: "NORMAL",
        title: t("system.tasks.debt.title", { name: c.customerName ?? t("system.tasks.debt.customerFallback") }),
        fact: [n === 1 ? t("system.tasks.debt.oneInvoice") : t("system.tasks.debt.invoices", { n }), money(String(c.totalOutstanding), c.currency, locale),
               t("system.tasks.debt.afterDue", { days: c.maxDaysAwaiting === 1 ? t("system.tasks.debt.oneDay") : t("system.tasks.debt.days", { n: c.maxDaysAwaiting }) })].join(" · "),
        factAt: c.awaitingSince.toISOString(),
        action: { label: t("system.tasks.debt.action"), href: `/collection/c/${c.customerId}` },
        snooze: "STATE",
        entity: { kind: "customer", id: c.customerId as number },
        customerId: c.customerId as number,
      } satisfies SourceItem;
    });
  return { items, capped: list.customers.length > CUSTOMER_DEBT_CAP };
};

// ── S06 Invoices waiting for review ──────────────────────────────────────────────────────────────

const INVOICE_REVIEW_CAP = 50;
export const invoiceReview: Adapter = async ({ businessId, t = HEBREW_TEXT }) => {
  const rows = await tenantTx(businessId, (tx) => tx.billingDocument.findMany({
    where: { businessId, status: BillingDocumentStatus.PENDING_REVIEW },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: INVOICE_REVIEW_CAP + 1,
    select: { id: true, createdAt: true, updatedAt: true, documentNumberFormatted: true, customerNameSnapshot: true },
  }));
  const items: SourceItem[] = rows.slice(0, INVOICE_REVIEW_CAP).map((d) => ({
    sourceKind: "invoice_review",
    dedupeKey: `billing_document:${d.id}:review`,
    cycleKey: `r${d.id}`,
    evidenceVersion: `u${d.updatedAt.getTime()}`,
    placement: "NO_DATE",
    dueOn: null,
    severity: "NORMAL",
    title: t("system.tasks.invoiceReview.title", { number: d.documentNumberFormatted ?? "" }).replace(/\s+/g, " "),
    fact: [d.customerNameSnapshot, t("system.tasks.invoiceReview.created", { date: shortDate(jerusalemDayKey(d.createdAt)) })].filter(Boolean).join(" · "),
    factAt: d.createdAt.toISOString(),
    action: { label: t("system.tasks.invoiceReview.action"), href: `/billing/${d.id}` },
    snooze: "STATE",
    entity: { kind: "billing_document", id: d.id },
  }));
  return { items, capped: rows.length > INVOICE_REVIEW_CAP };
};

// ── S13 / S14 Leads ──────────────────────────────────────────────────────────────────────────────

const LEAD_SQL_LIMIT = 24; // loadLeadsNeedingAttention's own LIMIT
const UPCOMING_LEADS_CAP = 30;
const LEAD_REASONS = new Set(["FOLLOWUP_OVERDUE", "FOLLOWUP_DUE_TODAY", "CUSTOMER_WROTE", "NEW_UNHANDLED"]);

export const leads: Adapter = async ({ businessId, now, today, t = HEBREW_TEXT }) => {
  const raw = await runWithTenantContext({ businessId }, () => loadLeadsNeedingAttention(businessId, now));
  const extra = await tenantTx(businessId, async (tx) => ({
    customers: await tx.lead.findMany({ where: { businessId, id: { in: raw.map((r) => r.id) } }, select: { id: true, customerId: true } }),
    upcoming: await tx.lead.findMany({
      where: { businessId, status: { in: [...OPEN_LEAD_STATUSES] as LeadStatusValue[] as never }, nextFollowUpAt: { gt: endOfLeadDayUtc(now), lte: new Date(now.getTime() + 8 * 86_400_000) } },
      orderBy: [{ nextFollowUpAt: "asc" }, { id: "asc" }],
      take: UPCOMING_LEADS_CAP + 1,
      select: { id: true, customerName: true, nextFollowUpAt: true, followUpNote: true, createdAt: true, customerId: true },
    }),
  }));
  const customerOf = new Map(extra.customers.map((c) => [c.id, c.customerId]));
  const items: SourceItem[] = [];
  for (const r of raw) {
    const a = evaluateLeadAttention({
      status: r.status as LeadStatusValue, nextFollowUpAt: r.nextFollowUpAt, createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt, lastCustomerInboundAt: r.lastCustomerInboundAt,
      lastUnreturnedCallAt: r.lastUnreturnedCallAt ?? null, openIdentityProposals: r.openIdentityProposals,
      firstHandledAt: r.firstHandledAt ?? null,
    }, now);
    if (!a.needsAttention || !a.reason || !LEAD_REASONS.has(a.reason)) continue;
    const name = r.customerName?.trim() || t("system.tasks.lead.unnamed");
    const followUp = a.reason === "FOLLOWUP_OVERDUE" || a.reason === "FOLLOWUP_DUE_TODAY";
    const dueOn = followUp && r.nextFollowUpAt ? jerusalemDayKey(r.nextFollowUpAt) : null;
    const wrote = a.reason === "CUSTOMER_WROTE";
    items.push({
      sourceKind: "lead",
      dedupeKey: `lead:${r.id}`,
      cycleKey: `o${r.createdAt.getTime()}`,
      evidenceVersion: `${a.reason.toLowerCase()}.${epoch(r.nextFollowUpAt)}.${epoch(r.lastCustomerInboundAt)}`,
      placement: followUp ? "BY_DATE" : "TODAY",
      dueOn,
      severity: wrote ? "HIGH" : "NORMAL",
      title: wrote ? t("system.tasks.lead.newMessage", { name }) : followUp ? t("system.tasks.lead.followUp", { name }) : t("system.tasks.lead.newLead", { name }),
      fact: wrote && r.lastCustomerInboundAt ? t("system.tasks.lead.lastMessage", { when: relativeHe(r.lastCustomerInboundAt, now, t) })
        : followUp ? (r.followUpNote?.trim() || t("system.tasks.lead.plannedFor", { date: shortDate(dueOn ?? today) }))
        : t("system.tasks.lead.entered", { when: relativeHe(r.createdAt, now, t) }),
      factAt: (wrote ? r.lastCustomerInboundAt : followUp ? r.nextFollowUpAt : r.createdAt)?.toISOString() ?? null,
      action: { label: wrote ? t("system.tasks.lead.toConversation") : t("system.tasks.lead.toLead"), href: `/leads/${r.id}` },
      snooze: "LEAD",
      entity: { kind: "lead", id: r.id },
      customerId: customerOf.get(r.id) ?? null,
      details: { reason: a.reason, followUpDue: followUp },
    });
  }
  for (const l of extra.upcoming.slice(0, UPCOMING_LEADS_CAP)) {
    if (items.some((i) => i.dedupeKey === `lead:${l.id}`) || !l.nextFollowUpAt) continue;
    const dueOn = jerusalemDayKey(l.nextFollowUpAt);
    if (daysBetweenDayKeys(today, dueOn) < 1) continue;
    const name = l.customerName?.trim() || t("system.tasks.lead.unnamed");
    items.push({
      sourceKind: "lead",
      dedupeKey: `lead:${l.id}`,
      cycleKey: `o${l.createdAt.getTime()}`,
      evidenceVersion: `upcoming.${epoch(l.nextFollowUpAt)}`,
      placement: "BY_DATE",
      dueOn,
      severity: "NORMAL",
      title: t("system.tasks.lead.followUp", { name }),
      fact: l.followUpNote?.trim() || t("system.tasks.lead.plannedFor", { date: shortDate(dueOn) }),
      factAt: l.nextFollowUpAt.toISOString(),
      action: { label: t("system.tasks.lead.toLead"), href: `/leads/${l.id}` },
      snooze: "LEAD",
      entity: { kind: "lead", id: l.id },
      customerId: l.customerId ?? null,
      details: { reason: "FOLLOWUP_UPCOMING", followUpDue: true },
    });
  }
  return { items, capped: raw.length >= LEAD_SQL_LIMIT || extra.upcoming.length > UPCOMING_LEADS_CAP };
};

// ── S16 Conversations waiting for a reply ───────────────────────────────────────────────────────

const WAITING_CAP = 12; // loadAttentionWaiting's own cap (BS_ATTENTION_WAITING_CAP)
/** Brand names stay as they are; the rest follows the interface language. */
function channelName(channel: string, t: Translator): string {
  switch (channel) {
    case "WHATSAPP": return "WhatsApp";
    case "INSTAGRAM": return "Instagram";
    case "FACEBOOK": return "Facebook";
    case "EMAIL": return t("system.tasks.conversation.channel.email");
    case "PHONE": return t("system.tasks.conversation.channel.phone");
    default: return t("system.tasks.conversation.channel.other");
  }
}

export const conversations: Adapter = async ({ businessId, now, t = HEBREW_TEXT }) => {
  const waiting = await runWithTenantContext({ businessId }, () => loadAttentionWaiting(businessId));
  const convs = await tenantTx(businessId, (tx) => tx.conversation.findMany({
    where: { businessId, id: { in: waiting.map((w) => w.conversationId) } },
    select: { id: true, customerId: true, businessLastOutboundAt: true },
  }));
  const byId = new Map(convs.map((c) => [c.id, c]));
  const items: SourceItem[] = waiting.map((w) => {
    const c = byId.get(w.conversationId);
    return {
      sourceKind: "conversation",
      dedupeKey: `conversation:${w.conversationId}`,
      cycleKey: `a${epoch(c?.businessLastOutboundAt ?? null)}`,
      evidenceVersion: `m${w.relevantAt.getTime()}`,
      placement: "TODAY",
      dueOn: null,
      severity: "HIGH",
      title: t("system.tasks.conversation.waiting", { name: w.customerName?.trim() || t("system.tasks.conversation.customerFallback") }),
      fact: t("system.tasks.conversation.fact", { channel: channelName(String(w.channel), t), when: relativeHe(w.relevantAt, now, t) }),
      factAt: w.relevantAt.toISOString(),
      action: { label: t("system.tasks.conversation.action"), href: `/inbox?conversationId=${w.conversationId}` },
      snooze: "STATE",
      entity: { kind: "conversation", id: w.conversationId },
      customerId: c?.customerId ?? null,
    } satisfies SourceItem;
  });
  return { items, capped: waiting.length >= WAITING_CAP };
};

// ── S23 Documents waiting for review (always one row) ───────────────────────────────────────────

export const documentsQueue: Adapter = async ({ businessId, now, t = HEBREW_TEXT }) => {
  const { count, months, oldest } = await runWithTenantContext({ businessId }, async () => ({
    count: await countPendingReviewAllTime(businessId),
    months: await listPendingReviewMonths(businessId),
    oldest: await tenantTx(businessId, (tx) => tx.document.findFirst({
      where: { businessId, status: "needs_review" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { createdAt: true },
    })),
  }));
  if (count === 0 || !oldest) return { items: [], capped: false };
  const ageDays = daysBetweenDayKeys(jerusalemDayKey(oldest.createdAt), jerusalemDayKey(now));
  return {
    capped: false,
    items: [{
      sourceKind: "documents_queue",
      dedupeKey: "documents:review_queue",
      cycleKey: `q${oldest.createdAt.getTime()}`,
      evidenceVersion: `n${count}`,
      placement: "NO_DATE",
      dueOn: null,
      severity: "NORMAL",
      title: count === 1 ? t("system.tasks.documents.one") : t("system.tasks.documents.many", { n: count }),
      fact: ageDays <= 0 ? t("system.tasks.documents.oldestToday") : ageDays === 1 ? t("system.tasks.documents.oldestYesterday") : t("system.tasks.documents.oldestDays", { n: ageDays }),
      factAt: oldest.createdAt.toISOString(),
      action: { label: t("system.tasks.documents.action"), href: pendingReviewInboxHref(months) },
      snooze: "STATE",
    }],
  };
};

// ── S25 Stock alerts ─────────────────────────────────────────────────────────────────────────────

const STOCK_CAP = 50;
export const stock: Adapter = async ({ businessId, t = HEBREW_TEXT }) => {
  const rows = await tenantTx(businessId, (tx) => tx.inventoryAlert.findMany({
    where: { businessId, isResolved: false, type: { in: ["LOW_STOCK", "CRITICAL_STOCK"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: STOCK_CAP + 1,
    select: { id: true, type: true, message: true, createdAt: true, itemId: true, item: { select: { name: true } } },
  }));
  const items: SourceItem[] = rows.slice(0, STOCK_CAP).map((a) => {
    const critical = a.type === "CRITICAL_STOCK";
    return {
      sourceKind: "stock",
      dedupeKey: a.itemId ? `item:${a.itemId}:stock` : `inventory_alert:${a.id}`,
      cycleKey: `a${a.id}`,
      evidenceVersion: `t${critical ? "c" : "l"}`,
      // A critical shortage waits for the owner today; a low one joins the undated queue (7.2, 7.3).
      placement: critical ? "TODAY" : "NO_DATE",
      dueOn: null,
      severity: critical ? "HIGH" : "NORMAL",
      title: t("system.tasks.stock.title", { name: a.item?.name ?? t("system.tasks.stock.itemFallback"), level: critical ? t("system.tasks.stock.critical") : t("system.tasks.stock.low") }),
      // `message` is stored with the alert (written in Hebrew when the alert was raised): shown as stored.
      fact: a.message?.trim() || (critical ? t("system.tasks.stock.belowCritical") : t("system.tasks.stock.belowReorder")),
      factAt: a.createdAt.toISOString(),
      action: { label: t("system.tasks.stock.action"), href: "/inventory/alerts" },
      snooze: "STATE",
      entity: { kind: "inventory_alert", id: a.id },
    } satisfies SourceItem;
  });
  return { items, capped: rows.length > STOCK_CAP };
};

export const ADAPTERS: Readonly<Record<SourceKind, Adapter>> = {
  supplier_payment: supplierPayments,
  customer_debt: customerDebt,
  invoice_review: invoiceReview,
  lead: leads,
  conversation: conversations,
  documents_queue: documentsQueue,
  stock,
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("source adapter timed out")), ms); }),
  ]);
}

/** One adapter, isolated: its failure is its own status, never an exception for the agenda. */
export async function runAdapter(kind: SourceKind, ctx: AdapterCtx, disabled: ReadonlySet<string>): Promise<SourceResult> {
  if (!Number.isInteger(ctx.businessId) || ctx.businessId <= 0) throw new Error("runAdapter: a server-derived businessId is required");
  if (disabled.has(kind)) return { kind, status: "DISABLED", items: [] };
  try {
    const out = await withTimeout(ADAPTERS[kind](ctx), ADAPTER_TIMEOUT_MS);
    return { kind, status: out.capped ? "CAPPED" : "OK", items: out.items };
  } catch (e) {
    console.warn(`[tasks] source ${kind} failed: ${(e as Error).name}`);
    return { kind, status: "FAILED", items: [] };
  }
}

export async function runAllAdapters(ctx: AdapterCtx, disabled: ReadonlySet<string>): Promise<SourceResult[]> {
  return Promise.all(SOURCE_KINDS.map((k) => runAdapter(k, ctx, disabled)));
}
