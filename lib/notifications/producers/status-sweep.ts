/**
 * The status sweep — STATE-BASED notification coverage with zero domain-code changes (notifications track, owner
 * decision 2026-11-13: notifications for every feature active in Production, from real events / state only, never
 * changing business logic, money, statuses, documents or payments). SERVER-ONLY.
 *
 * Several facts already have a policy rule and a catalog category but NO producer: nothing ever feeds them to the
 * writer, so they exist only on the Attention list (billing PDF failures, billing documents waiting for review, lead
 * follow-ups, supplier purchases waiting for review). Billing and payments are protected paths, so a hook there is
 * an owner decision; the sweep reads the SAME derived truth the home screen reads instead, and adds nothing to any
 * domain module:
 *
 *   per live business (notification_live_businesses — identifiers only, the digest's walk), when notifications_engine
 *   is ON for it, inside ITS tenant context:
 *     1. ownedFacts                         the business-status loaders + translators + finalize of the sweep's OWN
 *                                           scopes only (lib/business-status, unchanged), read ONE AT A TIME — not
 *                                           the whole 14-loader home snapshot at once — together with each scope's
 *                                           uncapped identifier set (lib/notifications/exhaustive-facts.ts), which is
 *                                           re-read only when the capped loader actually hit its cap;
 *     2. keep the items whose catalog category's feature is available;
 *     3. decideForSnapshot                  the existing policy, unchanged (silence by default, quiet hours);
 *     4. persistSnapshotNotifications       the existing writer, unchanged (dedupe, cooldown, owed PUSH rows that
 *                                           only the engine's worker sends, with the catalog TTL);
 *     5. resolveAbsentNotifications         per owned (domain, entityType) scope, against the UNCAPPED set — never
 *                                           against a capped list; an incomplete read (lead queue overflow) resolves
 *                                           nothing;
 *     6. the existing reconcilers of two scopes the sweep does NOT own (inventory alerts, the documents review
 *        queue), called as their own event hooks call them — a catch-up for paths without a hook;
 *     7. the state producers A–E (./state-producers.ts — obligations due / overdue, payment requests failed /
 *        expired, ITA allocation problems, document processing failures, upcoming appointments) through the
 *        engine's notify(), in ONE tenant transaction behind a per-business advisory lock;
 *     8. a push owed by this pass ⇒ the after-response worker kick for this business (trigger.ts), so a 30-minute
 *        appointment reminder does not wait for the worker route.
 *
 * Deliberately NOT swept (owned elsewhere or silent by policy): inbox conversations (resolved per conversation by
 * their own consumer, never from absence), per-document review items (the queue is the identity — one row, not
 * twenty), the accountant notices (lib/accountant/notify.ts), lead intake (the intake sweeper), stale drafts / payment
 * links (silent). See docs/notifications/feature-coverage.md.
 *
 * Bounded (docs/notifications/sweep-performance.md): businesses run in a small pool (default 2, NOTIFICATIONS_SWEEP_
 * CONCURRENCY 1–8), each business strictly sequentially (one open transaction at a time); a time budget under the
 * route's maxDuration; keyset continuation (`nextAfter` = the last id of the last fully finished chunk, so a business
 * is never skipped). Counts only in the report and the log — no business id, no person, no text.
 */
import type { BusinessStatusItem } from "@/lib/business-status/types";
import { STATUS_HE_T } from "@/lib/business-status/i18n";
import { BS_BILLING_PDF_FAILED_CAP, BS_BILLING_PENDING_CAP, BS_LEADS_CAP, BS_SUPPLIER_CAP } from "@/lib/business-status/limits";
import { loadBillingPdfFailed, loadBillingPendingReview, loadSupplierPurchasesPending } from "@/lib/business-status/loaders";
import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateBillingPdfFailed, translateBillingPendingReview } from "@/lib/business-status/translators/billing";
import { translateLeadsNeedingAttention } from "@/lib/business-status/translators/leads";
import { translateSupplierPurchasesPending } from "@/lib/business-status/translators/supplier";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";

import { classifyNotification, getCategory, type CategoryDefinition } from "../catalog";
import { syncDocumentsReviewQueueNotification } from "../documents-review-queue-notifications";
import { businessGates, type BusinessGates } from "../engine/engine-gate";
import { kickPushWorkerAfterResponse } from "../engine/trigger";
import {
  declareExhaustive,
  loadAllBillingPdfFailedIds,
  loadAllBillingPendingReviewIds,
  loadAllSupplierPurchasePendingIds,
  loadLeadAttentionForSweep,
  type ExhaustiveFactKeys,
} from "../exhaustive-facts";
import { syncInventoryAlertNotifications } from "../inventory-alert-notifications";
import { buildDedupeKey, decideForSnapshot } from "../notification-policy";
import { persistSnapshotNotifications, resolveAbsentNotifications, type WriteOutcome } from "../notification-writer";
import { runStateProducers, type StateProducersReport } from "./state-producers";

/* ─────────────────────────────────────────────────────────────── scopes ── */

export type SweepScopeId = "billing" | "leads" | "supplier";

export type SweepScope = {
  id: SweepScopeId;
  domain: string;
  entityTypes: readonly string[];
  /** Every catalog category an item of this scope can classify to. The scope is swept only when ALL are available. */
  categories: readonly string[];
};

/**
 * The (domain, entityType) slices the sweep OWNS — it writes and resolves notifications in exactly these, nowhere else.
 * No other writer produces rows in them today (the producers test pins that).
 */
export const STATUS_SWEEP_SCOPES: readonly SweepScope[] = [
  // lib/business-status/translators/billing.ts: PENDING_REVIEW → ACTION_REQUIRED MEDIUM, PDF FAILED → FAILURE_EVENT HIGH.
  { id: "billing", domain: "billing", entityTypes: ["billing_document"], categories: ["billing.failure", "billing.review"] },
  // lib/business-status/translators/leads.ts: the shared lead attention queue → ACTION_REQUIRED HIGH / MEDIUM.
  { id: "leads", domain: "leads", entityTypes: ["lead"], categories: ["leads.follow_up"] },
  // lib/business-status/translators/supplier.ts: PENDING_REVIEW drafts → ACTION_REQUIRED MEDIUM.
  { id: "supplier", domain: "supplier", entityTypes: ["supplier_purchase_draft"], categories: ["suppliers.purchase_pending"] },
];

/** The existing reconcilers the sweep calls (scopes NOT owned by the sweep), each gated on its category's feature. */
export type ReconcilerId = "inventory" | "documents_queue";
export const STATUS_SWEEP_RECONCILERS: readonly { id: ReconcilerId; category: string }[] = [
  { id: "inventory", category: "inventory.critical_stock" },
  { id: "documents_queue", category: "documents.review" },
];

/** The state producers' categories (./state-producers.ts STATE_PRODUCERS). */
export const STATE_PRODUCER_CATEGORIES: readonly string[] = [
  "obligations.due",
  "payments.request_failed",
  "billing.allocation_failed",
  "documents.processing_failed",
  "appointments.upcoming",
];

/** Every catalog category the sweep can surface (owned scopes + reconcilers + state producers). */
export const STATUS_SWEEP_CATEGORIES: readonly string[] = [
  ...new Set([
    ...STATUS_SWEEP_SCOPES.flatMap((s) => s.categories),
    ...STATUS_SWEEP_RECONCILERS.map((r) => r.category),
    ...STATE_PRODUCER_CATEGORIES,
  ]),
].sort();

export function scopeOfItem(item: Pick<BusinessStatusItem, "domain" | "entityRef">): SweepScope | null {
  return STATUS_SWEEP_SCOPES.find((s) => s.domain === item.domain && s.entityTypes.includes(item.entityRef.type)) ?? null;
}

function categoriesAvailable(keys: readonly string[], gates: BusinessGates): boolean {
  return keys.every((k) => {
    const cat = getCategory(k);
    return cat !== null && gates.categoryAvailable(cat);
  });
}

/** The catalog category of a snapshot item (null = unknown: never written by the sweep). */
export function categoryOfItem(item: BusinessStatusItem): CategoryDefinition | null {
  return classifyNotification({
    domain: item.domain,
    semanticCategory: item.semanticCategory,
    severity: item.severity,
    entityType: item.entityRef.type,
  });
}

/**
 * Pure: the items the sweep may hand to the writer — in an owned scope that is available, with a known catalog
 * category whose feature is available. The policy still decides afterwards (most of these stay silent).
 */
export function selectSweepItems(items: readonly BusinessStatusItem[], gates: BusinessGates): BusinessStatusItem[] {
  return items.filter((item) => {
    const scope = scopeOfItem(item);
    if (!scope || !categoriesAvailable(scope.categories, gates)) return false;
    const cat = categoryOfItem(item);
    return cat !== null && scope.categories.includes(cat.key) && gates.categoryAvailable(cat);
  });
}

/** Pure: the owned scopes available to a business. */
export function availableScopes(gates: BusinessGates): SweepScopeId[] {
  return STATUS_SWEEP_SCOPES.filter((s) => categoriesAvailable(s.categories, gates)).map((s) => s.id);
}

/* ─────────────────────────────────────────────────────── present keys ── */

/** The dedupe key of a fact, built by the policy itself (the same function the writer uses). */
const keyOf = (businessId: number, domain: string, semanticCategory: string, type: string, id: number) =>
  buildDedupeKey(businessId, { domain, semanticCategory, entityRef: { type, id } } as Parameters<typeof buildDedupeKey>[1]);

/** Pure: the present-key set of a scope from its uncapped identifier sets. */
export function presentKeysOf(
  businessId: number,
  scope: SweepScopeId,
  ids: { pendingReview?: readonly number[]; pdfFailed?: readonly number[]; leads?: readonly number[]; supplierPending?: readonly number[] },
): string[] {
  switch (scope) {
    case "billing":
      return [
        ...(ids.pendingReview ?? []).map((id) => keyOf(businessId, "billing", "ACTION_REQUIRED", "billing_document", id)),
        ...(ids.pdfFailed ?? []).map((id) => keyOf(businessId, "billing", "FAILURE_EVENT", "billing_document", id)),
      ];
    case "leads":
      return (ids.leads ?? []).map((id) => keyOf(businessId, "leads", "ACTION_REQUIRED", "lead", id));
    case "supplier":
      return (ids.supplierPending ?? []).map((id) => keyOf(businessId, "supplier", "ACTION_REQUIRED", "supplier_purchase_draft", id));
  }
}

/** Pure: a capped loader that returned FEWER rows than its cap returned everything its predicate matches. */
export function cappedIsComplete(rows: number, cap: number): boolean {
  return rows < cap;
}

export type OwnedFacts = {
  items: BusinessStatusItem[];
  present: Partial<Record<SweepScopeId, { keys: string[]; complete: boolean }>>;
};

/**
 * The owned scopes' items and present keys, inside the caller's tenant context, ONE READ AT A TIME (never more than
 * one open transaction for this business). Items: the same loaders, translators (Hebrew, as the home snapshot) and
 * finalize the home snapshot uses for these domains — without the other ten domains and without the global
 * presentation cap, which can only drop owned items, never add any. Present keys: the uncapped selector only when
 * the capped loader hit its cap; otherwise the loader's own rows ARE the complete set (same predicate, pinned).
 */
export async function loadOwnedFacts(businessId: number, scopes: readonly SweepScopeId[], now: Date): Promise<OwnedFacts> {
  const out: OwnedFacts = { items: [], present: {} };
  if (scopes.includes("billing")) {
    const pending = await loadBillingPendingReview(businessId);
    const failed = await loadBillingPdfFailed(businessId);
    out.items.push(...translateBillingPendingReview(pending, STATUS_HE_T, "he").map(finalizeBusinessStatusItem));
    out.items.push(...translateBillingPdfFailed(failed, STATUS_HE_T).map(finalizeBusinessStatusItem));
    const pendingIds = cappedIsComplete(pending.length, BS_BILLING_PENDING_CAP) ? pending.map((r) => r.id) : await loadAllBillingPendingReviewIds(businessId);
    const failedIds = cappedIsComplete(failed.length, BS_BILLING_PDF_FAILED_CAP) ? failed.map((r) => r.id) : await loadAllBillingPdfFailedIds(businessId);
    out.present.billing = { keys: presentKeysOf(businessId, "billing", { pendingReview: pendingIds, pdfFailed: failedIds }), complete: true };
  }
  if (scopes.includes("leads")) {
    const q = await loadLeadAttentionForSweep(businessId, now, BS_LEADS_CAP * 3);
    out.items.push(...translateLeadsNeedingAttention(q.rows, now, STATUS_HE_T).map(finalizeBusinessStatusItem));
    out.present.leads = { keys: presentKeysOf(businessId, "leads", { leads: q.ids }), complete: q.complete };
  }
  if (scopes.includes("supplier")) {
    const drafts = await loadSupplierPurchasesPending(businessId);
    out.items.push(...translateSupplierPurchasesPending(drafts, STATUS_HE_T).map(finalizeBusinessStatusItem));
    const ids = cappedIsComplete(drafts.length, BS_SUPPLIER_CAP) ? drafts.map((d) => d.id) : await loadAllSupplierPurchasePendingIds(businessId);
    out.present.supplier = { keys: presentKeysOf(businessId, "supplier", { supplierPending: ids }), complete: true };
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────── run ── */

export type StatusSweepDeps = {
  gates: (businessId: number) => Promise<BusinessGates>;
  /** Runs fn inside the business's tenant context. */
  inTenant: <T>(businessId: number, fn: () => Promise<T>) => Promise<T>;
  ownedFacts: (businessId: number, scopes: readonly SweepScopeId[], now: Date) => Promise<OwnedFacts>;
  persist: (businessId: number, items: BusinessStatusItem[], now: Date) => Promise<WriteOutcome[]>;
  resolveAbsent: (businessId: number, scope: { domain: string; entityTypes: readonly string[] }, present: ExhaustiveFactKeys, now: Date) => Promise<number>;
  reconcile: (id: ReconcilerId, businessId: number, now: Date) => Promise<{ ok: boolean }>;
  stateProducers: (businessId: number, gates: BusinessGates, now: Date) => Promise<StateProducersReport>;
  /** A push is owed by this pass: wake the worker for this business after the response (no-op outside a request). */
  kick: (businessId: number) => void;
  liveBusinesses: (after: number, limit: number) => Promise<number[]>;
  clock: () => number;
};

export const defaultStatusSweepDeps: StatusSweepDeps = {
  gates: businessGates,
  inTenant: (businessId, fn) => runWithTenantContext({ businessId }, fn),
  ownedFacts: loadOwnedFacts,
  persist: persistSnapshotNotifications,
  resolveAbsent: resolveAbsentNotifications,
  reconcile: async (id, businessId, now) =>
    id === "inventory" ? syncInventoryAlertNotifications(businessId, now) : syncDocumentsReviewQueueNotification(businessId, now),
  stateProducers: (businessId, gates, now) => runStateProducers(businessId, gates, now),
  kick: kickPushWorkerAfterResponse,
  liveBusinesses: async (after, limit) => {
    const rows = await prisma.$queryRaw<{ businessId: number }[]>`
      SELECT "businessId" FROM public.notification_live_businesses(${after}::int, ${limit}::int)`;
    return rows.map((r) => Number(r.businessId));
  },
  clock: () => Date.now(),
};

export type StatusSweepReport = {
  businesses: number;
  engineOff: number;
  swept: number;
  /** Items handed to the writer (after scope + feature filtering) / of those, the policy granted a channel. */
  candidates: number;
  decided: number;
  /** Writer outcomes: rows written or refreshed / of those, notified now (outside the cooldown). */
  written: number;
  notified: number;
  resolved: number;
  /** Scopes skipped because the business lacks the feature / scopes whose read was incomplete (nothing resolved). */
  scopesUnavailable: number;
  scopesIncomplete: number;
  reconciled: number;
  reconcileFailed: number;
  /** State producers A–E: producers run / events offered to notify() / notified now / resolved / failed / lock busy. */
  producersRan: number;
  producerEvents: number;
  producerNotified: number;
  producerResolved: number;
  producersFailed: number;
  leaseBusy: number;
  /** Businesses whose pass owed a push (the worker was kicked for them). */
  kicked: number;
  errors: number;
  /** Set when the time budget ended the pass: call again with ?after=<nextAfter>. */
  nextAfter: number | null;
};

const PAGE = 100;
export const STATUS_SWEEP_DEFAULT_BUDGET_MS = 45_000;
export const STATUS_SWEEP_DEFAULT_CONCURRENCY = 2;
export const STATUS_SWEEP_MAX_CONCURRENCY = 8;

/** Pure: the pool size — the option, else NOTIFICATIONS_SWEEP_CONCURRENCY, else 2; clamped to 1..8. */
export function sweepConcurrency(option: number | undefined, env: string | undefined = process.env.NOTIFICATIONS_SWEEP_CONCURRENCY): number {
  const raw = option ?? (env !== undefined && /^\d{1,2}$/.test(env.trim()) ? Number(env.trim()) : STATUS_SWEEP_DEFAULT_CONCURRENCY);
  return Math.min(STATUS_SWEEP_MAX_CONCURRENCY, Math.max(1, Math.trunc(raw)));
}

/** One business. Never throws (counted as an error). Exported for tests. */
export async function sweepBusiness(businessId: number, now: Date, deps: StatusSweepDeps, report: StatusSweepReport): Promise<void> {
  report.businesses += 1;
  try {
    const gates = await deps.gates(businessId);
    if (!gates.engineOn) {
      report.engineOff += 1;
      return;
    }
    let owedPush = false;
    await deps.inTenant(businessId, async () => {
      const scopes = availableScopes(gates);
      report.scopesUnavailable += STATUS_SWEEP_SCOPES.length - scopes.length;
      const owned = scopes.length > 0 ? await deps.ownedFacts(businessId, scopes, now) : { items: [], present: {} };
      const items = selectSweepItems(owned.items, gates);
      report.candidates += items.length;
      const decided = decideForSnapshot(businessId, items, now);
      report.decided += decided.length;
      if (decided.length > 0) {
        const out = await deps.persist(businessId, decided.map((d) => d.item), now);
        report.written += out.length;
        report.notified += out.filter((o) => o.notified).length;
        if (out.some((o) => o.notified && o.channels.includes("PUSH"))) owedPush = true;
      }
      for (const scope of STATUS_SWEEP_SCOPES) {
        if (!scopes.includes(scope.id)) continue;
        const present = owned.present[scope.id];
        if (!present || !present.complete) {
          report.scopesIncomplete += 1;
          continue;
        }
        // Await FIRST, then add: `report.x += await …` reads the shared counter before the await, so two businesses
        // running in the pool would overwrite each other's count.
        const resolved = await deps.resolveAbsent(
          businessId,
          { domain: scope.domain, entityTypes: scope.entityTypes },
          declareExhaustive(present.keys),
          now,
        );
        report.resolved += resolved;
      }
      for (const r of STATUS_SWEEP_RECONCILERS) {
        if (!categoriesAvailable([r.category], gates)) continue;
        const res = await deps.reconcile(r.id, businessId, now);
        if (res.ok) report.reconciled += 1;
        else report.reconcileFailed += 1;
      }
      const sp = await deps.stateProducers(businessId, gates, now);
      report.producersRan += sp.ran;
      report.producerEvents += sp.events;
      report.producerNotified += sp.notified;
      report.producerResolved += sp.resolved;
      report.producersFailed += sp.failed;
      if (sp.leaseBusy) report.leaseBusy += 1;
      if (sp.owedPush > 0) owedPush = true;
    });
    if (owedPush) {
      report.kicked += 1;
      deps.kick(businessId);
    }
    report.swept += 1;
  } catch {
    report.errors += 1;
  }
}

/**
 * One sweep pass. `after` continues a pass the budget ended; `businessIds` (tests) replaces the live-business walk.
 * Businesses run in chunks of `concurrency`; the budget is checked between chunks, and `nextAfter` is the last id of
 * the last finished chunk — every business up to it is done, none after it was started.
 */
export async function runStatusSweep(
  now: Date = new Date(),
  opts: { after?: number; budgetMs?: number; businessIds?: number[]; deps?: Partial<StatusSweepDeps>; quiet?: boolean; concurrency?: number } = {},
): Promise<StatusSweepReport> {
  const deps: StatusSweepDeps = { ...defaultStatusSweepDeps, ...opts.deps };
  const report: StatusSweepReport = {
    businesses: 0, engineOff: 0, swept: 0, candidates: 0, decided: 0, written: 0, notified: 0, resolved: 0,
    scopesUnavailable: 0, scopesIncomplete: 0, reconciled: 0, reconcileFailed: 0,
    producersRan: 0, producerEvents: 0, producerNotified: 0, producerResolved: 0, producersFailed: 0, leaseBusy: 0, kicked: 0,
    errors: 0, nextAfter: null,
  };
  const started = deps.clock();
  const budget = opts.budgetMs ?? STATUS_SWEEP_DEFAULT_BUDGET_MS;
  const overBudget = () => deps.clock() - started >= budget;
  const pool = sweepConcurrency(opts.concurrency);
  const chunk = async (ids: number[]) => {
    await Promise.all(ids.map((b) => sweepBusiness(b, now, deps, report)));
  };

  if (opts.businessIds) {
    // The same business never twice in one pass (and so never concurrently with itself).
    const ids = [...new Set(opts.businessIds)];
    for (let i = 0; i < ids.length; i += pool) await chunk(ids.slice(i, i + pool));
  } else {
    let after = Math.max(0, Math.trunc(opts.after ?? 0));
    outer: for (;;) {
      const page = await deps.liveBusinesses(after, PAGE);
      if (page.length === 0) break;
      for (let i = 0; i < page.length; i += pool) {
        if (overBudget()) {
          report.nextAfter = after;
          break outer;
        }
        const ids = page.slice(i, i + pool);
        await chunk(ids);
        after = ids[ids.length - 1]!;
      }
      if (page.length < PAGE) break;
    }
  }
  if (!opts.quiet) console.log("[notifications] status sweep", JSON.stringify(report));
  return report;
}
