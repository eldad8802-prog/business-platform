/**
 * The status sweep — pure checks (fakes for every dependency; no database, no network, no clock of its own).
 *
 *   npx tsx lib/notifications/producers/status-sweep.test.ts
 *
 *  1. Gate: notifications_engine OFF ⇒ no snapshot, no write, no resolve, no reconcile.
 *  2. Items → writer: only the owned scopes' items whose category's feature is available reach the writer, and only
 *     those the EXISTING policy grants a channel (silent facts, inbox, per-document, payables, accountant, intake are
 *     never written by the sweep); quiet hours downgrade the billing push to in-app (policy semantics kept).
 *  3. Resolve: exactly the three owned (domain, entityType) scopes, with the uncapped present keys; an incomplete
 *     read (lead queue overflow) resolves nothing; a scope whose feature is unavailable is neither written nor
 *     resolved; the reconcilers run only with their feature.
 *  4. Identity pins: the present keys equal the dedupe keys of the real translators' items (the two halves cannot
 *     drift), and the uncapped selectors use the loaders' predicates.
 *  5. Push privacy: every category the sweep can surface has generic lock-screen text (no digits / placeholders),
 *     never marks its stored text lock-screen safe, and the real push builder hides a stored name / amount / number.
 *  6. Catalog completeness: EVERY policy rule (enumerated over the type unions) classifies to a catalog category;
 *     push rules ⇒ a push-by-default category; in-app rules ⇒ a category that does not push by default; the
 *     translators' hrefs pass the category's deep-link prefixes.
 *  7. Bounded run: the time budget ends a pass with nextAfter (keyset continuation); one failing business is
 *     counted and the pass continues.
 *  8. Static: the route authenticates through decideCronAuth only, is scheduled once (rotation mode), logs counts only.
 */
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";

import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateBillingPdfFailed, translateBillingPendingReview } from "@/lib/business-status/translators/billing";
import { translateLeadsNeedingAttention } from "@/lib/business-status/translators/leads";
import { translateSupplierPurchasesPending } from "@/lib/business-status/translators/supplier";
import type { BusinessStatusDomain, BusinessStatusItem, SemanticCategory, Severity } from "@/lib/business-status/types";

import { classifyNotification, getCategory, safeHref, type CategoryDefinition } from "../catalog";
import type { BusinessGates } from "../engine/engine-gate";
import { buildDedupeKey, decideNotification } from "../notification-policy";
import { buildPushMessage } from "../push/push-content";
import {
  STATE_PRODUCER_CATEGORIES,
  STATUS_SWEEP_CATEGORIES,
  STATUS_SWEEP_SCOPES,
  cappedIsComplete,
  presentKeysOf,
  runStatusSweep,
  sweepConcurrency,
  type StatusSweepDeps,
  type SweepScopeId,
} from "./status-sweep";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)); }
}
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DAY = new Date("2026-12-01T10:00:00.000Z"); // 12:00 Asia/Jerusalem
const NIGHT = new Date("2026-12-01T21:30:00.000Z"); // 23:30 — quiet hours
const B = 41;

/* ── fixtures: real translators, synthetic rows ─────────────────────────────────────────────────────────────── */
const billingRow = (id: number, over: Record<string, unknown> = {}) => ({
  id, status: "PENDING_REVIEW", customerNameSnapshot: "יוסי כהן", totalAmount: new Prisma.Decimal("1234.50"), currency: "ILS",
  createdAt: new Date("2026-11-20T09:00:00Z"), pdfRenderStatus: "FAILED", pdfRenderError: "x", documentNumberFormatted: "INV-0042", ...over,
}) as never;
const leadRow = (id: number, over: Record<string, unknown> = {}) => ({
  id, customerName: "דנה לוי", status: "OPEN", nextFollowUpAt: new Date("2026-11-28T08:00:00Z"), followUpNote: null,
  createdAt: new Date("2026-11-01T08:00:00Z"), lastActivityAt: new Date("2026-11-25T08:00:00Z"), lastCustomerInboundAt: null,
  lastUnreturnedCallAt: null, openIdentityProposals: 0, firstHandledAt: new Date("2026-11-02T08:00:00Z"), ...over,
}) as never;
const supplierRow = (id: number) => ({ id, createdAt: new Date("2026-11-29T08:00:00Z"), supplierName: "ספק בע\"מ", externalOrderId: "PO-77", lineCount: 3 });

const pending = translateBillingPendingReview([billingRow(101)]).map(finalizeBusinessStatusItem);
const pdfFailed = translateBillingPdfFailed([billingRow(102)]).map(finalizeBusinessStatusItem);
const leads = translateLeadsNeedingAttention([leadRow(201)], DAY).map(finalizeBusinessStatusItem);
const supplier = translateSupplierPurchasesPending([supplierRow(301)]).map(finalizeBusinessStatusItem);

const item = (domain: BusinessStatusDomain, semanticCategory: SemanticCategory, severity: Severity, type: string, id: number, href = "/"): BusinessStatusItem => ({
  itemId: `${domain}:${type}:${id}`, domain, semanticCategory, title: "t", summary: null, severity, priorityScore: 1,
  entityRef: { type, id }, state: "open", createdAt: DAY.toISOString(), primaryAction: { kind: "navigate", label: "x", href }, sourceEngine: "test",
});
const foreign = [
  item("billing", "WARNING", "MEDIUM", "billing_document", 103, "/billing/103"), // stale draft: silent by policy
  item("billing", "WARNING", "LOW", "payment_request", 104, "/collection"), // stale payment link: not an owned scope
  item("inbox", "ACTION_REQUIRED", "HIGH", "conversation", 401, "/inbox"), // owned by the inbox consumer
  item("documents", "ACTION_REQUIRED", "MEDIUM", "document", 501, "/documents/review/501"), // the queue is the identity
  item("documents", "FAILURE_EVENT", "HIGH", "accountant_period_send_failed", 601, "/documents/accountant-pack"), // accountant/notify
  item("leads", "ACTION_REQUIRED", "HIGH", "intake_failed", B, "/settings/connections"), // the intake sweeper
  item("payables", "ACTION_REQUIRED", "HIGH", "installment", 701, "/payables"), // no policy rule: silent
  item("inventory", "ALERT", "CRITICAL", "inventory_item", 801, "/inventory"), // the inventory reconciler's
];
const SNAPSHOT: BusinessStatusItem[] = [...pending, ...pdfFailed, ...leads, ...supplier, ...foreign];

/* ── fakes ─────────────────────────────────────────────────────────────────────────────────────────────────── */
type Calls = {
  snapshot: number[]; scopes: SweepScopeId[][]; persist: { b: number; keys: string[]; now: Date }[]; resolve: { b: number; scope: string; keys: readonly string[] }[];
  reconcile: string[]; tenant: number[]; producers: number[]; kicked: number[];
};
function gatesOf(engineOn: boolean, off: string[] = []): BusinessGates {
  return { engineOn, cutoverAt: null, categoryAvailable: (c: CategoryDefinition) => !(c.featureKey && off.includes(c.featureKey)) };
}
function fakes(opts: { engineOn?: boolean; off?: string[]; leadsComplete?: boolean; snapshot?: BusinessStatusItem[]; failFor?: number; producerPush?: boolean; writerPush?: boolean } = {}) {
  const calls: Calls = { snapshot: [], scopes: [], persist: [], resolve: [], reconcile: [], tenant: [], producers: [], kicked: [] };
  let inTenant = 0;
  const deps: Partial<StatusSweepDeps> = {
    gates: async () => gatesOf(opts.engineOn ?? true, opts.off ?? []),
    inTenant: async (b, fn) => { calls.tenant.push(b); inTenant = b; try { return await fn(); } finally { inTenant = 0; } },
    ownedFacts: async (b, scopes) => {
      if (inTenant !== b) throw new Error("owned facts outside its tenant");
      if (opts.failFor === b) throw new Error("boom");
      calls.snapshot.push(b);
      calls.scopes.push([...scopes]);
      const ids = { pendingReview: [101], pdfFailed: [102], leads: [201], supplierPending: [301] };
      const present: Partial<Record<SweepScopeId, { keys: string[]; complete: boolean }>> = {};
      for (const sc of scopes) present[sc] = { keys: presentKeysOf(b, sc, ids), complete: sc === "leads" ? (opts.leadsComplete ?? true) : true };
      // The fake hands back foreign items too: the sweep must still filter to its owned, available scopes.
      return { items: opts.snapshot ?? SNAPSHOT, present };
    },
    persist: async (b, items, now) => {
      calls.persist.push({ b, keys: items.map((i) => buildDedupeKey(b, i)), now });
      return items.map((i) => ({ dedupeKey: buildDedupeKey(b, i), notificationId: 1, created: true, notified: true, reopened: false, withinCooldown: false, channels: opts.writerPush ? ["IN_APP", "PUSH"] : ["IN_APP"] })) as never;
    },
    resolveAbsent: async (b, scope, present) => { calls.resolve.push({ b, scope: `${scope.domain}|${scope.entityTypes.join(",")}`, keys: present.keys }); return 0; },
    reconcile: async (id) => { calls.reconcile.push(id); return { ok: true }; },
    stateProducers: async (b) => {
      if (inTenant !== b) throw new Error("producers outside its tenant");
      calls.producers.push(b);
      return { leaseBusy: false, ran: 4, unavailable: 1, incomplete: 0, failed: 0, events: 2, notified: 2, owedPush: opts.producerPush ? 1 : 0, resolved: 0 };
    },
    kick: (b) => { calls.kicked.push(b); },
  };
  return { calls, deps };
}
const run = (deps: Partial<StatusSweepDeps>, now = DAY, extra: Record<string, unknown> = {}) =>
  runStatusSweep(now, { businessIds: [B], deps, quiet: true, ...extra });

async function main() {
  console.log("1. engine gate");
  {
    const { calls, deps } = fakes({ engineOn: false });
    const r = await run(deps);
    ok("engine OFF: no tenant work, no read, no write, no resolve, no reconcile, no state producer, no kick",
      calls.tenant.length === 0 && calls.snapshot.length === 0 && calls.persist.length === 0 && calls.resolve.length === 0 && calls.reconcile.length === 0 && calls.producers.length === 0 && calls.kicked.length === 0, calls);
    ok("engine OFF: counted", r.engineOff === 1 && r.swept === 0, r);
    const throwing: Partial<StatusSweepDeps> = { ...deps, gates: async () => { throw new Error("caps"); } };
    const r2 = await run(throwing);
    ok("a gate failure is an error, never a write", r2.errors === 1 && calls.persist.length === 0, r2);
  }

  console.log("2. items → writer");
  {
    const { calls, deps } = fakes();
    const r = await run(deps);
    const keys = calls.persist[0]?.keys ?? [];
    const want = [...pending, ...pdfFailed, ...leads, ...supplier].map((i) => buildDedupeKey(B, i)).sort();
    ok("one writer call, inside the business's tenant", calls.persist.length === 1 && calls.tenant.join() === String(B), calls.tenant);
    ok("the writer receives exactly the owned, policy-granted facts (billing review + failure, the lead, the supplier draft)",
      JSON.stringify([...keys].sort()) === JSON.stringify(want), { keys, want });
    ok("never: the stale draft, payment links, inbox, per-document, accountant, intake, payables, inventory",
      !keys.some((k) => /WARNING|payment_request|conversation|:document:|accountant|intake|installment|inventory/.test(k)), keys);
    ok("report counts", r.candidates === 4 && r.decided === 4 && r.written === 4 && r.notified === 4 && r.swept === 1, r);
    ok("the writer gets the sweep's instant", calls.persist[0]?.now.getTime() === DAY.getTime());

    const silentLead = translateLeadsNeedingAttention([leadRow(202, { status: "QUOTED", nextFollowUpAt: null, lastActivityAt: new Date("2026-11-01T08:00:00Z") })], DAY).map(finalizeBusinessStatusItem);
    const low = silentLead.filter((i) => i.severity === "LOW");
    if (low.length > 0) {
      const f = fakes({ snapshot: low });
      await run(f.deps);
      ok("a LOW lead (no policy rule) is silent: the writer is not called", f.calls.persist.length === 0, low.map((i) => i.severity));
    } else {
      ok("a silent fact (no policy rule) never reaches the writer", decideNotification(B, item("leads", "ACTION_REQUIRED", "LOW", "lead", 9), DAY).notify === false);
    }
  }
  {
    // quiet hours: the policy downgrades the billing push to in-app — the sweep does not re-decide.
    const decision = decideNotification(B, pdfFailed[0]!, NIGHT);
    ok("quiet hours: the billing failure is in-app only (existing policy semantics)", decision.notify && decision.channels.join() === "IN_APP", decision);
    ok("daytime: the billing failure may push (existing policy semantics)", decideNotification(B, pdfFailed[0]!, DAY).channels.includes("PUSH"));
  }

  console.log("3. resolve scopes");
  {
    const { calls, deps } = fakes();
    await run(deps);
    const scopes = calls.resolve.map((c) => c.scope).sort();
    ok("resolve runs for exactly the three owned scopes", JSON.stringify(scopes) === JSON.stringify(["billing|billing_document", "leads|lead", "supplier|supplier_purchase_draft"]), scopes);
    const billing = calls.resolve.find((c) => c.scope.startsWith("billing"))!;
    ok("billing present keys: the review AND the failure identity of the uncapped sets",
      billing.keys.length === 2 && billing.keys.includes(buildDedupeKey(B, pending[0]!)) && billing.keys.includes(buildDedupeKey(B, pdfFailed[0]!)), billing.keys);
    ok("every resolve is for this business", calls.resolve.every((c) => c.b === B));
    ok("the scopes are disjoint from every other consumer's (inventory, documents queue, intake, inbox, accountant)",
      STATUS_SWEEP_SCOPES.every((s) => !s.entityTypes.some((t) => /^(inventory_|documents_review_queue|document$|intake_|conversation|accountant_)/.test(t))));
    ok("the reconcilers ran (inventory, documents queue)", JSON.stringify(calls.reconcile) === JSON.stringify(["inventory", "documents_queue"]), calls.reconcile);
  }
  {
    const { calls, deps } = fakes({ leadsComplete: false });
    const r = await run(deps);
    ok("lead queue overflow: the leads scope resolves nothing", !calls.resolve.some((c) => c.scope.startsWith("leads")) && r.scopesIncomplete === 1, calls.resolve.map((c) => c.scope));
    ok("…while the other scopes still resolve", calls.resolve.length === 2);
  }
  {
    const { calls, deps } = fakes({ off: ["billing"] });
    const r = await run(deps);
    const keys = calls.persist[0]?.keys ?? [];
    ok("billing unavailable: no billing fact written", !keys.some((k) => k.includes(":billing:")), keys);
    ok("billing unavailable: the billing scope is not resolved", !calls.resolve.some((c) => c.scope.startsWith("billing")) && r.scopesUnavailable === 1, r);
  }
  {
    const { calls, deps } = fakes({ off: ["inventory", "documents"] });
    await run(deps);
    ok("inventory unavailable: no supplier fact, no supplier resolve, no inventory reconcile",
      !(calls.persist[0]?.keys ?? []).some((k) => k.includes(":supplier:")) && !calls.resolve.some((c) => c.scope.startsWith("supplier")) && !calls.reconcile.includes("inventory"));
    ok("documents unavailable: no documents-queue reconcile", !calls.reconcile.includes("documents_queue"));
  }
  {
    const { calls, deps } = fakes({ off: ["billing", "inventory", "documents"], snapshot: [...pending, ...pdfFailed, ...supplier] });
    await run(deps);
    ok("nothing available but leads (no feature key): nothing written, only leads resolved",
      calls.persist.length === 0 && calls.resolve.map((c) => c.scope).join() === "leads|lead", calls);
    ok("…and only the leads scope was read (no billing / supplier query at all)", JSON.stringify(calls.scopes) === JSON.stringify([["leads"]]), calls.scopes);
  }

  console.log("4. identity pins");
  ok("billing review key = the translator's", presentKeysOf(B, "billing", { pendingReview: [101] })[0] === buildDedupeKey(B, pending[0]!));
  ok("billing failure key = the translator's", presentKeysOf(B, "billing", { pdfFailed: [102] })[0] === buildDedupeKey(B, pdfFailed[0]!));
  ok("lead key = the translator's", leads.length === 1 && presentKeysOf(B, "leads", { leads: [201] })[0] === buildDedupeKey(B, leads[0]!), leads.map((l) => l.severity));
  ok("supplier key = the translator's", presentKeysOf(B, "supplier", { supplierPending: [301] })[0] === buildDedupeKey(B, supplier[0]!));
  ok("keys carry the business (never collide across tenants)", presentKeysOf(7, "supplier", { supplierPending: [301] })[0] !== presentKeysOf(8, "supplier", { supplierPending: [301] })[0]);
  {
    const loaders = code("lib/business-status/loaders.ts");
    const facts = code("lib/notifications/exhaustive-facts.ts");
    ok("pending-review predicate = loadBillingPendingReview's", /status: BillingDocumentStatus\.PENDING_REVIEW,\s*\},\s*orderBy: \[\{ createdAt: "desc" \}/.test(loaders) && /where: \{ businessId, status: "PENDING_REVIEW" \}, select: \{ id: true \} \}\),\s*\);\s*return rows\.map\(\(r\) => r\.id\);\s*\}\s*export async function loadAllBillingPdfFailedIds/.test(facts));
    ok("pdf-failed predicate = loadBillingPdfFailed's", /pdfRenderStatus: BillingPdfRenderStatus\.FAILED,/.test(loaders) && /where: \{ businessId, pdfRenderStatus: "FAILED" \}, select: \{ id: true \}/.test(facts));
    ok("supplier predicate = loadSupplierPurchasesPending's", /status: SupplierPurchaseDraftStatus\.PENDING_REVIEW,/.test(loaders) && /supplierPurchaseDraft\.findMany\(\{ where: \{ businessId, status: "PENDING_REVIEW" \}, select: \{ id: true \} \}\)/.test(facts));
    ok("the uncapped selectors have no take / limit / orderBy", !/take:|orderBy:|\.slice\(/.test(facts.slice(facts.indexOf("loadAllBillingPendingReviewIds"), facts.indexOf("loadLeadAttentionForSweep"))));
    ok("the sweep's single lead read: the loader's display slice, the queue's own completeness", /queue\.items\.slice\(0, displayCap\)/.test(facts) && /ids: queue\.items\.map/.test(facts) && /BS_LEADS_CAP \* 3/.test(code("lib/notifications/producers/status-sweep.ts")) && /slice\(0, BS_LEADS_CAP \* 3\)/.test(loaders));
    ok("a capped loader below its cap is complete; at its cap the uncapped selector is read", cappedIsComplete(7, 8) && !cappedIsComplete(8, 8));
    const sweepCode = code("lib/notifications/producers/status-sweep.ts");
    ok("the narrow reads use the home snapshot's own loaders, translators and finalize for the owned domains (not the 14-loader snapshot)",
      /loadBillingPendingReview\(businessId\)/.test(sweepCode) && /loadBillingPdfFailed\(businessId\)/.test(sweepCode) && /loadSupplierPurchasesPending\(businessId\)/.test(sweepCode) &&
      /translateBillingPendingReview\(pending, STATUS_HE_T, "he"\)/.test(sweepCode) && /map\(finalizeBusinessStatusItem\)/.test(sweepCode) && !/getBusinessStatusSnapshot/.test(sweepCode));
    ok("leads: the shared queue, complete only without overflow", /loadLeadAttentionQueue\(db, businessId, now\)/.test(facts) && /complete: !queue\.overflow/.test(facts));
  }

  console.log("5. push privacy");
  ok("the sweep's categories include the five state producers", STATE_PRODUCER_CATEGORIES.every((k) => STATUS_SWEEP_CATEGORIES.includes(k)));
  for (const key of STATUS_SWEEP_CATEGORIES.filter((k) => !STATE_PRODUCER_CATEGORIES.includes(k))) {
    const cat = getCategory(key);
    ok(`${key}: a catalog category`, cat !== null);
    if (!cat) continue;
    ok(`${key}: generic lock-screen text (no digits / placeholders)`, !/[0-9{}$<>]/.test(cat.lockScreen.title + cat.lockScreen.body));
    ok(`${key}: stored text is NOT lock-screen safe (it carries names / amounts)`, cat.storedTextLockScreenSafe !== true);
  }
  for (const it of [...pending, ...pdfFailed, ...leads, ...supplier]) {
    const cat = classifyNotification({ domain: it.domain, semanticCategory: it.semanticCategory, severity: it.severity, entityType: it.entityRef.type })!;
    const msg = buildPushMessage(cat, { id: 1, title: it.title, summary: it.summary, href: it.primaryAction.href, entityType: it.entityRef.type, entityId: it.entityRef.id }, { lockScreenDetails: false, ttlSeconds: 60 });
    const text = `${msg.title} ${msg.body}`;
    ok(`${cat.key}: the push names nobody, no amount, no number`, !/יוסי|דנה|ספק בע|1,?234|INV-0042|PO-77|[0-9]/.test(text), text);
    ok(`${cat.key}: the push deep link is the item's own internal href`, msg.href === it.primaryAction.href, msg.href);
  }

  console.log("6. catalog completeness over the policy");
  const DOMAINS: BusinessStatusDomain[] = ["inbox", "documents", "inventory", "billing", "supplier", "leads", "payables"];
  const CATS: SemanticCategory[] = ["ACTION_REQUIRED", "ALERT", "WARNING", "FAILURE_EVENT"];
  const SEVS: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
  let rules = 0;
  for (const d of DOMAINS) for (const c of CATS) for (const s of SEVS) {
    const dec = decideNotification(B, item(d, c, s, "x", 1), DAY);
    if (!dec.notify) continue;
    rules += 1;
    const cat = classifyNotification({ domain: d, semanticCategory: c, severity: s, entityType: d === "documents" ? (c === "FAILURE_EVENT" ? "accountant_period_send_failed" : "document") : d === "leads" ? "lead" : "x" });
    ok(`policy rule ${d}|${c}|${s} → a catalog category (${cat?.key})`, cat !== null);
    if (cat) ok(`…push by default exactly when the rule pushes (${cat.key})`, cat.defaults.push === dec.channels.includes("PUSH"), { rule: dec.channels, cat: cat.defaults });
  }
  ok("the policy has the 11 known rules (a new rule must be catalogued)", rules === 11, rules);
  ok("only explicitly urgent, action-required facts push by default among the sweep's categories",
    JSON.stringify(STATUS_SWEEP_CATEGORIES.filter((k) => getCategory(k)!.defaults.push).sort()) === JSON.stringify(["appointments.upcoming", "billing.allocation_failed", "billing.failure", "inventory.critical_stock", "payments.request_failed"]));
  ok("no sweep category bypasses quiet hours or the rate limit", STATUS_SWEEP_CATEGORIES.every((k) => !getCategory(k)!.quietBypass && !getCategory(k)!.rateExempt));
  ok("slow-moving standing states go to the digest by default (billing review, supplier purchases)",
    getCategory("billing.review")!.defaults.delivery === "digest" && getCategory("suppliers.purchase_pending")!.defaults.delivery === "digest");
  ok("the accountant complaint notice is classified (accountant.send_failed), not unknown",
    classifyNotification({ domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "accountant_delivery_complained" })?.key === "accountant.send_failed");
  for (const it of [...pending, ...pdfFailed, ...leads, ...supplier]) {
    const cat = classifyNotification({ domain: it.domain, semanticCategory: it.semanticCategory, severity: it.severity, entityType: it.entityRef.type })!;
    ok(`${cat.key}: the translator's href ${it.primaryAction.href} passes the deep-link prefixes`, safeHref(it.primaryAction.href, cat.hrefPrefixes) !== null);
  }

  console.log("7. bounded run");
  {
    const { deps } = fakes();
    const all = Array.from({ length: 103 }, (_, i) => i + 1);
    let t = 0;
    const seen: number[] = [];
    const bounded: Partial<StatusSweepDeps> = {
      ...deps,
      liveBusinesses: async (after, limit) => all.filter((b) => b > after).slice(0, limit),
      gates: async (b) => { seen.push(b); t += 10; return gatesOf(false); },
      clock: () => t,
    };
    const r = await runStatusSweep(DAY, { deps: bounded, budgetMs: 255, quiet: true });
    ok("the budget ends the pass with a keyset continuation", r.nextAfter === 26 && seen.length === 26 && seen[25] === 26, { nextAfter: r.nextAfter, n: seen.length });
    t = 0; seen.length = 0;
    const r2 = await runStatusSweep(DAY, { deps: bounded, after: r.nextAfter!, budgetMs: 10_000, quiet: true });
    ok("the continuation starts after it and reaches the end (next page too)", seen[0] === 27 && seen[seen.length - 1] === 103 && r2.nextAfter === null, { first: seen[0], last: seen[seen.length - 1] });
  }
  {
    const f = fakes({ failFor: 2 });
    const r = await runStatusSweep(DAY, { businessIds: [1, 2, 3], deps: f.deps, quiet: true, concurrency: 1 });
    ok("one failing business is counted, the others are swept", r.errors === 1 && r.swept === 2 && f.calls.persist.map((p) => p.b).join() === "1,3", r);
  }

  console.log("7b. pool, dedupe, kick");
  {
    ok("pool size: default 2, env, option, clamped 1..8", sweepConcurrency(undefined, undefined) === 2 && sweepConcurrency(undefined, "4") === 4 && sweepConcurrency(undefined, "x") === 2 &&
      sweepConcurrency(0) === 1 && sweepConcurrency(50) === 8 && sweepConcurrency(3, "6") === 3);
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    const f = fakes();
    const slow: Partial<StatusSweepDeps> = {
      ...f.deps,
      gates: async (b) => { inFlight += 1; peak = Math.max(peak, inFlight); seen.push(b); await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return gatesOf(false); },
    };
    const r = await runStatusSweep(DAY, { businessIds: [1, 2, 3, 2, 4, 5, 1], deps: slow, quiet: true, concurrency: 3 });
    ok("never more businesses in flight than the pool", peak <= 3 && peak >= 2, peak);
    ok("a business listed twice is swept once per pass", r.businesses === 5 && new Set(seen).size === seen.length, seen);
    const all = Array.from({ length: 10 }, (_, i) => i + 1);
    let t = 0;
    const bounded: Partial<StatusSweepDeps> = { ...f.deps, liveBusinesses: async (after, limit) => all.filter((b) => b > after).slice(0, limit), gates: async () => { t += 10; return gatesOf(false); }, clock: () => t };
    const rb = await runStatusSweep(DAY, { deps: bounded, budgetMs: 35, quiet: true, concurrency: 3 });
    ok("pooled continuation: nextAfter is the last id of the last finished chunk (6 after two chunks of 3)", rb.nextAfter === 6 && rb.businesses === 6, rb);
    const done = new Set<number>();
    t = 0;
    const cont: Partial<StatusSweepDeps> = { ...bounded, gates: async (b) => { done.add(b); return gatesOf(false); } };
    await runStatusSweep(DAY, { deps: cont, after: rb.nextAfter!, quiet: true, concurrency: 3 });
    ok("…and the continuation sweeps exactly the rest (7..10), none skipped, none repeated", [...done].join() === "7,8,9,10", [...done]);
  }
  {
    // Counters under the pool: two businesses resolving at once must both be counted (no `x += await` race).
    const f = fakes();
    const pooled: Partial<StatusSweepDeps> = {
      ...f.deps,
      inTenant: async (_b, fn) => fn(),
      ownedFacts: async (_b, scopes) => ({ items: [], present: Object.fromEntries(scopes.map((sc) => [sc, { keys: [], complete: true }])) }),
      resolveAbsent: async () => { await new Promise((r) => setTimeout(r, 3)); return 1; },
      stateProducers: async () => { await new Promise((r) => setTimeout(r, 2)); return { leaseBusy: false, ran: 1, unavailable: 0, incomplete: 0, failed: 0, events: 1, notified: 1, owedPush: 0, resolved: 1 }; },
    };
    const r = await runStatusSweep(DAY, { businessIds: [1, 2, 3, 4], deps: pooled, quiet: true, concurrency: 4 });
    ok("pooled counters add up (4 businesses × 3 scopes resolved, 4 producer runs)", r.resolved === 12 && r.producersRan === 4 && r.producerResolved === 4, r);
  }
  {
    const quiet = fakes();
    await run(quiet.deps);
    ok("no push owed: the worker is not kicked", quiet.calls.kicked.length === 0);
    const owed = fakes({ producerPush: true });
    const ro = await run(owed.deps);
    ok("a state producer owed a push: the worker is kicked once for that business", owed.calls.kicked.join() === String(B) && ro.kicked === 1, owed.calls.kicked);
    const writer = fakes({ writerPush: true });
    await run(writer.deps);
    ok("the existing writer notified with PUSH (billing failure): kicked too", writer.calls.kicked.join() === String(B));
    ok("the state producers run inside the business's tenant, after the owned scopes", owed.calls.producers.join() === String(B));
  }

  console.log("8. static");
  const route = code("app/api/notifications/status-sweep/route.ts");
  ok("route: decideCronAuth on the authorization header", /decideCronAuth\(req\.headers\.get\("authorization"\)\)/.test(route));
  ok("route: never reads CRON_SECRET itself, never a session, no business / user id from the request",
    !/process\.env\.CRON_SECRET|getAuthContext|getCurrentUser|businessId|userId/.test(route));
  ok("route: maxDuration 60 and a budget under it", /maxDuration = 60/.test(route) && /BUDGET_MS = 45_000/.test(route));
  ok("sweep: the state producers and the kick are wired (default deps)", /stateProducers: \(businessId, gates, now\) => runStateProducers\(businessId, gates, now\)/.test(code("lib/notifications/producers/status-sweep.ts")) && /kick: kickPushWorkerAfterResponse/.test(code("lib/notifications/producers/status-sweep.ts")));
  const vercel = fs.existsSync(path.join(root, "vercel.json")) ? read("vercel.json") : "";
  const sweepCrons = ((JSON.parse(vercel || "{}") as { crons?: { path: string; schedule: string }[] }).crons ?? []).filter((c) => c.path.startsWith("/api/notifications/status-sweep"));
  ok("route: scheduled in vercel.json exactly once, every 15 min off the quarter hour, no query (the rotation mode)",
    sweepCrons.length === 1 && sweepCrons[0]!.path === "/api/notifications/status-sweep" && sweepCrons[0]!.schedule === "7,22,37,52 * * * *", sweepCrons);
  ok("route: the cron call (no after) runs the rotation; ?after keeps the keyset continuation",
    /rawAfter === null\s*\?\s*await runStatusSweep\(new Date\(\), \{ budgetMs: BUDGET_MS, rotation: \{ cadenceMs: STATUS_SWEEP_CADENCE_MS \} \}\)/.test(route) &&
    /await runStatusSweep\(new Date\(\), \{ after, budgetMs: BUDGET_MS \}\)/.test(route));
  const sweep = code("lib/notifications/producers/status-sweep.ts");
  const logs = sweep.match(/console\.\w+\([^;]*;/g) ?? [];
  ok("sweep: one log line, counts only", logs.length === 1 && /JSON\.stringify\(report\)/.test(logs[0]!), logs);
  ok("sweep: no domain write — only the existing writer / resolver / reconcilers write",
    !/\.(create|update|upsert|delete)(Many)?\(|\$executeRaw/.test(sweep));
  ok("sweep: the engine gate, read only", /businessGates/.test(sweep) && !/featureAccess\.(create|update|upsert)/.test(sweep));

  console.log(`\n[status-sweep] PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
