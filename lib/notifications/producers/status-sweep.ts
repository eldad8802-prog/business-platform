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
 *     1. getBusinessStatusSnapshot          the existing derived truth (lib/business-status), unchanged;
 *     2. keep the items of the scopes the sweep OWNS whose catalog category's feature is available;
 *     3. decideForSnapshot                  the existing policy, unchanged (silence by default, quiet hours);
 *     4. persistSnapshotNotifications       the existing writer, unchanged (dedupe, cooldown, owed PUSH rows that
 *                                           only the engine's worker sends, with the catalog TTL);
 *     5. resolveAbsentNotifications         per owned (domain, entityType) scope, against an UNCAPPED identifier set
 *                                           (lib/notifications/exhaustive-facts.ts) — never against the capped
 *                                           snapshot; an incomplete read (lead queue overflow) resolves nothing;
 *     6. the existing reconcilers of two scopes the sweep does NOT own (inventory alerts, the documents review
 *        queue), called as their own event hooks call them — a catch-up for paths without a hook. Their scopes,
 *        identities and resolution stay theirs.
 *
 * Deliberately NOT swept (owned elsewhere or silent by policy): inbox conversations (resolved per conversation by
 * their own consumer, never from absence), per-document review items (the queue is the identity — one row, not
 * twenty), the accountant notices (lib/accountant/notify.ts), lead intake (the intake sweeper), payables and
 * forgotten money (no policy rule: silent). See docs/notifications/feature-coverage.md.
 *
 * Bounded: a time budget under the route's maxDuration; keyset continuation (`nextAfter`). Counts only in the report
 * and the log — no business id, no person, no text.
 */
import type { BusinessStatusItem } from "@/lib/business-status/types";
import { getBusinessStatusSnapshot } from "@/lib/business-status/business-status.service";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant/context";

import { classifyNotification, getCategory, type CategoryDefinition } from "../catalog";
import { syncDocumentsReviewQueueNotification } from "../documents-review-queue-notifications";
import { businessGates, type BusinessGates } from "../engine/engine-gate";
import {
  declareExhaustive,
  loadAllBillingPdfFailedIds,
  loadAllBillingPendingReviewIds,
  loadAllLeadAttentionIds,
  loadAllSupplierPurchasePendingIds,
  type ExhaustiveFactKeys,
} from "../exhaustive-facts";
import { syncInventoryAlertNotifications } from "../inventory-alert-notifications";
import { buildDedupeKey, decideForSnapshot } from "../notification-policy";
import { persistSnapshotNotifications, resolveAbsentNotifications, type WriteOutcome } from "../notification-writer";

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

/** Every catalog category the sweep can surface (owned scopes + reconcilers). */
export const STATUS_SWEEP_CATEGORIES: readonly string[] = [
  ...new Set([
    ...STATUS_SWEEP_SCOPES.flatMap((s) => s.categories),
    ...STATUS_SWEEP_RECONCILERS.map((r) => r.category),
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
 * Pure: the snapshot items the sweep may hand to the writer — in an owned scope that is available, with a known
 * catalog category whose feature is available. The policy still decides afterwards (most of these stay silent).
 */
export function selectSweepItems(items: readonly BusinessStatusItem[], gates: BusinessGates): BusinessStatusItem[] {
  return items.filter((item) => {
    const scope = scopeOfItem(item);
    if (!scope || !categoriesAvailable(scope.categories, gates)) return false;
    const cat = categoryOfItem(item);
    return cat !== null && scope.categories.includes(cat.key) && gates.categoryAvailable(cat);
  });
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

/** Reads a scope's uncapped identifier set inside the caller's tenant context. `complete` false ⇒ never resolve. */
async function loadPresentKeys(businessId: number, scope: SweepScopeId, now: Date): Promise<{ keys: string[]; complete: boolean }> {
  switch (scope) {
    case "billing": {
      const [pendingReview, pdfFailed] = await Promise.all([loadAllBillingPendingReviewIds(businessId), loadAllBillingPdfFailedIds(businessId)]);
      return { keys: presentKeysOf(businessId, scope, { pendingReview, pdfFailed }), complete: true };
    }
    case "leads": {
      const leads = await loadAllLeadAttentionIds(businessId, now);
      return { keys: presentKeysOf(businessId, scope, { leads: leads.ids }), complete: leads.complete };
    }
    case "supplier": {
      const supplierPending = await loadAllSupplierPurchasePendingIds(businessId);
      return { keys: presentKeysOf(businessId, scope, { supplierPending }), complete: true };
    }
  }
}

/* ──────────────────────────────────────────────────────────────── run ── */

export type StatusSweepDeps = {
  gates: (businessId: number) => Promise<BusinessGates>;
  /** Runs fn inside the business's tenant context. */
  inTenant: <T>(businessId: number, fn: () => Promise<T>) => Promise<T>;
  snapshot: (businessId: number) => Promise<BusinessStatusItem[]>;
  persist: (businessId: number, items: BusinessStatusItem[], now: Date) => Promise<WriteOutcome[]>;
  presentKeys: (businessId: number, scope: SweepScopeId, now: Date) => Promise<{ keys: string[]; complete: boolean }>;
  resolveAbsent: (businessId: number, scope: { domain: string; entityTypes: readonly string[] }, present: ExhaustiveFactKeys, now: Date) => Promise<number>;
  reconcile: (id: ReconcilerId, businessId: number, now: Date) => Promise<{ ok: boolean }>;
  liveBusinesses: (after: number, limit: number) => Promise<number[]>;
  clock: () => number;
};

export const defaultStatusSweepDeps: StatusSweepDeps = {
  gates: businessGates,
  inTenant: (businessId, fn) => runWithTenantContext({ businessId }, fn),
  snapshot: async (businessId) => (await getBusinessStatusSnapshot(businessId)).items,
  persist: persistSnapshotNotifications,
  presentKeys: loadPresentKeys,
  resolveAbsent: resolveAbsentNotifications,
  reconcile: async (id, businessId, now) =>
    id === "inventory" ? syncInventoryAlertNotifications(businessId, now) : syncDocumentsReviewQueueNotification(businessId, now),
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
  errors: number;
  /** Set when the time budget ended the pass: call again with ?after=<nextAfter>. */
  nextAfter: number | null;
};

const PAGE = 100;
export const STATUS_SWEEP_DEFAULT_BUDGET_MS = 45_000;

/** One business. Never throws (counted as an error). Exported for tests. */
export async function sweepBusiness(businessId: number, now: Date, deps: StatusSweepDeps, report: StatusSweepReport): Promise<void> {
  report.businesses += 1;
  try {
    const gates = await deps.gates(businessId);
    if (!gates.engineOn) {
      report.engineOff += 1;
      return;
    }
    await deps.inTenant(businessId, async () => {
      const items = selectSweepItems(await deps.snapshot(businessId), gates);
      report.candidates += items.length;
      const decided = decideForSnapshot(businessId, items, now);
      report.decided += decided.length;
      if (decided.length > 0) {
        const out = await deps.persist(businessId, decided.map((d) => d.item), now);
        report.written += out.length;
        report.notified += out.filter((o) => o.notified).length;
      }
      for (const scope of STATUS_SWEEP_SCOPES) {
        if (!categoriesAvailable(scope.categories, gates)) {
          report.scopesUnavailable += 1;
          continue;
        }
        const present = await deps.presentKeys(businessId, scope.id, now);
        if (!present.complete) {
          report.scopesIncomplete += 1;
          continue;
        }
        report.resolved += await deps.resolveAbsent(
          businessId,
          { domain: scope.domain, entityTypes: scope.entityTypes },
          declareExhaustive(present.keys),
          now,
        );
      }
      for (const r of STATUS_SWEEP_RECONCILERS) {
        if (!categoriesAvailable([r.category], gates)) continue;
        const res = await deps.reconcile(r.id, businessId, now);
        if (res.ok) report.reconciled += 1;
        else report.reconcileFailed += 1;
      }
    });
    report.swept += 1;
  } catch {
    report.errors += 1;
  }
}

/**
 * One sweep pass. `after` continues a pass the budget ended; `businessIds` (tests) replaces the live-business walk.
 */
export async function runStatusSweep(
  now: Date = new Date(),
  opts: { after?: number; budgetMs?: number; businessIds?: number[]; deps?: Partial<StatusSweepDeps>; quiet?: boolean } = {},
): Promise<StatusSweepReport> {
  const deps: StatusSweepDeps = { ...defaultStatusSweepDeps, ...opts.deps };
  const report: StatusSweepReport = {
    businesses: 0, engineOff: 0, swept: 0, candidates: 0, decided: 0, written: 0, notified: 0, resolved: 0,
    scopesUnavailable: 0, scopesIncomplete: 0, reconciled: 0, reconcileFailed: 0, errors: 0, nextAfter: null,
  };
  const started = deps.clock();
  const budget = opts.budgetMs ?? STATUS_SWEEP_DEFAULT_BUDGET_MS;
  const overBudget = () => deps.clock() - started >= budget;

  if (opts.businessIds) {
    for (const b of opts.businessIds) await sweepBusiness(b, now, deps, report);
  } else {
    let after = Math.max(0, Math.trunc(opts.after ?? 0));
    outer: for (;;) {
      const page = await deps.liveBusinesses(after, PAGE);
      if (page.length === 0) break;
      for (const b of page) {
        if (overBudget()) {
          report.nextAfter = after;
          break outer;
        }
        await sweepBusiness(b, now, deps, report);
        after = b;
      }
      if (page.length < PAGE) break;
    }
  }
  if (!opts.quiet) console.log("[notifications] status sweep", JSON.stringify(report));
  return report;
}
