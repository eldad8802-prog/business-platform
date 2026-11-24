/**
 * Which feature guards which API route — the reviewable map behind subscriptions phase 1.
 *
 * Every route under ROUTE_FEATURE_SCOPE (the API surface of the eleven core features) is listed here exactly once:
 *   - `feature`  — each exported handler calls guardFeature(req, <that key>) first, except the methods named in
 *                  `ungated`, each with its reason;
 *   - `exempt`   — the route is deliberately not guarded, with its reason (no session to guard on, a public page,
 *                  a provider webhook, a track that is frozen, …).
 * route-feature-map.test.ts fails when a route in scope is missing from this map, when an entry points at a route
 * that does not exist, or when a guarded handler does not call the guard with its key. A new route in scope is
 * therefore a reviewed decision, never a silent hole.
 *
 * The reasons are the vocabulary of the planning document (Dubiz — תכנון סופי של מסלולי המנויים, sections 4–5):
 *   data-rights-floor — reading or exporting what the business already has, above all its tax documents. Never
 *                       guarded: the law requires access to issued tax documents, whatever the business's state.
 *   legal-correction  — correcting or finishing a tax document already in flight (credit note, the authority's
 *                       held decision, issuing/submitting an existing draft). Never blocked automatically; the exact
 *                       list for FREE_LIMITED is mapped separately in phase 4 with the accountant.
 *   existing-operation — finishing or undoing a money operation that ALREADY exists (owner decision 2026-11-20):
 *                       cancelling an open payment request, refunding / verifying the refund of money already
 *                       received, retrying the settlement of a payment already verified. Each acts on an id in the
 *                       path, keeps its own authentication and permission check, and cannot create a request, a
 *                       charge or a connection — opening NEW collection stays guarded (payments/requests POST,
 *                       collection/actions, payments/connections*).
 *   frozen-track      — the legal-identity / issuer-declaration track is frozen by the owner; not touched here.
 *   provider-webhook  — called by a payment or messaging provider, not by the owner; money and messages already
 *                       sent must be recorded. Background effects are guarded downstream where they exist.
 *   cron              — a scheduled job; see the note on the entry.
 *   public            — answered to anyone (a public coupon page); there is no business session to guard on.
 *   integration-key   — called by an external system authenticated by its own key, not by a session.
 *   oauth-callback    — the provider's redirect back, bound by a signed state; connecting is guarded at its start.
 *   retired           — already answers 404 / 410 / a static stub; nothing to guard.
 */
import { PLATFORM_FEATURE_KEYS } from "./platform-feature-catalog";
import type { GuardedFeatureKey } from "./feature-guard";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type UngatedReason =
  | "data-rights-floor"
  | "legal-correction"
  | "existing-operation"
  | "frozen-track"
  | "provider-webhook"
  | "cron"
  | "public"
  | "integration-key"
  | "oauth-callback"
  | "retired";

export type RouteFeatureEntry =
  | { route: string; feature: GuardedFeatureKey; ungated?: Partial<Record<HttpMethod, UngatedReason>>; note?: string }
  | { route: string; exempt: UngatedReason; note?: string };

/** Route folders (under app/api) that belong to the eleven features. Every route.ts below them must be mapped. */
export const ROUTE_FEATURE_SCOPE: readonly string[] = [
  "documents",
  "billing",
  "collection",
  "payments",
  "conversations",
  "conversation",
  "inbox",
  "message",
  "reply-suggestion",
  "inventory",
  "content",
  "video",
  "pricing",
  "revenue",
  "coupons",
  "offers",
  "reports",
  "integrations/gmail",
  "integrations/whatsapp",
  "business/bot",
  "business/bot-hub",
  "business/bot-settings",
];

const D = PLATFORM_FEATURE_KEYS.DOCUMENTS;
const B = PLATFORM_FEATURE_KEYS.BILLING;
const I = PLATFORM_FEATURE_KEYS.INBOX;
const V = PLATFORM_FEATURE_KEYS.INVENTORY;
const C = PLATFORM_FEATURE_KEYS.CONTENT;
const P = PLATFORM_FEATURE_KEYS.PRICING;
const R = PLATFORM_FEATURE_KEYS.REVENUE;
const G = PLATFORM_FEATURE_KEYS.GMAIL_IMPORT;
const W = PLATFORM_FEATURE_KEYS.WHATSAPP;
const S = PLATFORM_FEATURE_KEYS.STARTER_BOT;
const RP = PLATFORM_FEATURE_KEYS.REPORTS;

const FLOOR = "data-rights-floor" as const;
const LEGAL = "legal-correction" as const;
const EXISTING = "existing-operation" as const;

export const ROUTE_FEATURE_MAP: readonly RouteFeatureEntry[] = [
  /* ---------------- documents ---------------- */
  { route: "documents/upload", feature: D },
  { route: "documents/inbox", feature: D, ungated: { GET: FLOOR } },
  { route: "documents/[id]", feature: D, ungated: { GET: FLOOR } },
  { route: "documents/[id]/file", feature: D, ungated: { GET: FLOOR } },
  { route: "documents/[id]/approve", feature: D },
  { route: "documents/[id]/process", feature: D },
  { route: "documents/[id]/supplier-link", feature: D, ungated: { GET: FLOOR } },
  { route: "documents/debug-extract", exempt: "retired" },
  { route: "documents/debug-ocr", exempt: "retired" },
  { route: "documents/debug-unified", exempt: "retired" },

  /* ---------------- billing (tax documents, customers, collection, payment links) ---------------- */
  { route: "billing/documents", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/documents/[id]", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/documents/[id]/pdf", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/documents/[id]/credit-state", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/documents/[id]/settlement-state", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/documents/[id]/lines", feature: B },
  { route: "billing/documents/[id]/allocations", feature: B },
  { route: "billing/documents/[id]/convert-to-invoice", feature: B },
  { route: "billing/documents/[id]/payments", feature: B },
  { route: "billing/documents/[id]/revert", feature: B },
  { route: "billing/documents/[id]/issue", feature: B, ungated: { POST: LEGAL }, note: "issuing an existing draft; creating the draft is guarded" },
  { route: "billing/kind-transition/interim-documents", feature: B, ungated: { GET: FLOOR }, note: "4a T4: read-only count/list of the business's own issued documents for the \"מעבר לעוסק מורשה\" screens (flag OFF → 404)" },
  { route: "billing/documents/[id]/vat-review", feature: B, ungated: { GET: FLOOR, POST: LEGAL }, note: "4a T3: the owner's VAT review of an existing pre-transition draft — a step of issuing it; creating the draft is guarded" },
  { route: "billing/documents/[id]/submit", feature: B, ungated: { POST: LEGAL }, note: "submitting an existing draft; creating the draft is guarded" },
  { route: "billing/documents/[id]/credit-note", feature: B, ungated: { POST: LEGAL } },
  { route: "billing/documents/[id]/authority-decision", feature: B, ungated: { POST: LEGAL } },
  { route: "billing/customers", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/customers/[id]", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/invoice-profile", feature: B, ungated: { GET: FLOOR } },
  { route: "billing/collection/awaiting", feature: B },
  { route: "billing/issuer-declaration", exempt: "frozen-track" },
  { route: "billing/issuer-declaration/check", exempt: "frozen-track" },
  { route: "billing/issuer-declaration/confirm", exempt: "frozen-track" },
  { route: "billing/issuer-declaration/request", exempt: "frozen-track" },
  { route: "collection/actions", feature: B },
  { route: "collection/customers/[customerId]", feature: B },
  { route: "collection/inbox", feature: B },
  { route: "collection/invoices/[id]", feature: B },
  { route: "collection/readiness", feature: B },
  { route: "collection/settlements/[paymentTransactionId]/retry", feature: B, ungated: { POST: EXISTING }, note: "settles a payment already verified; the settlement row must exist" },
  { route: "payments/attention", feature: B },
  { route: "payments/collection-workspace", feature: B },
  { route: "payments/connections", feature: B },
  { route: "payments/connections/cardcom", feature: B },
  { route: "payments/connections/tranzila", feature: B },
  { route: "payments/providers", feature: B },
  { route: "payments/requests", feature: B },
  { route: "payments/requests/[id]", feature: B },
  { route: "payments/requests/[id]/cancel", feature: B, ungated: { POST: EXISTING }, note: "open (PENDING), unpaid requests only" },
  { route: "payments/requests/[id]/refund", feature: B, ungated: { GET: EXISTING, POST: EXISTING }, note: "money already received; amount bounded by the refundable balance" },
  { route: "payments/requests/[id]/refund/verify", feature: B, ungated: { POST: EXISTING }, note: "asks the provider about a reversal already started" },
  { route: "payments/webhook/[provider]", exempt: "provider-webhook" },
  { route: "payments/webhook/cardcom", exempt: "provider-webhook" },
  { route: "payments/webhook/paypal", exempt: "provider-webhook" },
  { route: "payments/webhook/sumit/[secret]", exempt: "provider-webhook" },
  { route: "payments/webhook/tranzila", exempt: "provider-webhook" },
  { route: "payments/qa-webhook-sink", exempt: "provider-webhook", note: "discards the callback; no payment code" },
  { route: "payments/reconciliation", exempt: "cron", note: "records money already received at the provider" },
  { route: "payments/settlement-recovery", exempt: "cron", note: "finishes settlements of payments already received" },

  /* ---------------- inbox (conversations) ---------------- */
  { route: "conversations", feature: I },
  { route: "conversations/take-over", feature: I },
  { route: "conversations/[id]/appointment", feature: I },
  { route: "conversations/[id]/lead", feature: I },
  { route: "conversations/[id]/pending-state", feature: I },
  { route: "conversation", feature: I },
  { route: "conversation/[id]", feature: I },
  { route: "conversation/[id]/close", feature: I },
  { route: "inbox/attention", feature: I },
  { route: "message", feature: I },
  { route: "reply-suggestion", feature: I },
  { route: "reply-suggestion/action", feature: I },

  /* ---------------- inventory ---------------- */
  { route: "inventory/alerts", feature: V },
  { route: "inventory/categories", feature: V },
  { route: "inventory/drafts", feature: V },
  { route: "inventory/drafts/[id]/approve", feature: V },
  { route: "inventory/drafts/[id]/merge", feature: V },
  { route: "inventory/drafts/[id]/reject", feature: V },
  { route: "inventory/insights", feature: V },
  { route: "inventory/insights/action", feature: V },
  { route: "inventory/items", feature: V },
  { route: "inventory/items/[id]", feature: V },
  { route: "inventory/items/[id]/image", feature: V },
  { route: "inventory/movements", feature: V },
  { route: "inventory/pos/sale", exempt: "integration-key", note: "an external POS posts sales with its own key; guarded per business in phase 2" },
  { route: "inventory/purchase-orders", feature: V },
  { route: "inventory/purchase-orders/[id]", feature: V },
  { route: "inventory/purchase-orders/[id]/lines/[lineId]/remaining-decision", feature: V },
  { route: "inventory/purchase-orders/[id]/receiving-sessions", feature: V },
  { route: "inventory/receiving-sessions/[id]", feature: V },
  { route: "inventory/receiving-sessions/[id]/post", feature: V },
  { route: "inventory/reorder-suggestions", feature: V },
  { route: "inventory/sales", feature: V },
  { route: "inventory/supplier-purchases", feature: V },
  { route: "inventory/supplier-purchases/[id]/approve", feature: V },
  { route: "inventory/supplier-purchases/[id]/reject", feature: V },
  { route: "inventory/supplier-purchases/import/csv", feature: V },
  { route: "inventory/supplier-purchases/integrations/mock", exempt: "retired" },
  { route: "inventory/supplier-purchases/reorder-suggestions", feature: V },
  { route: "inventory/suppliers", feature: V },
  { route: "inventory/suppliers/[id]", feature: V },
  { route: "inventory/suppliers/[id]/documents", feature: V },
  { route: "inventory/suppliers/[id]/purchase-orders", feature: V },
  { route: "inventory/unmatched", feature: V },
  { route: "inventory/unmatched/[id]/resolve", feature: V },

  /* ---------------- content studio ---------------- */
  { route: "content/ai-assets", feature: C },
  { route: "content/decisions", feature: C },
  { route: "content/directions", feature: C },
  { route: "content/generate", feature: C },
  { route: "content/improve", feature: C },
  { route: "content/render", feature: C },
  { route: "content/render/status/[id]", feature: C },
  { route: "content/social-post-link", feature: C },
  { route: "content/social-post-performance", feature: C },
  { route: "content/upload", feature: C },
  { route: "video/generate", feature: C },
  { route: "video/generate-final", feature: C },
  { route: "video/plan", feature: C },
  { route: "video/status", exempt: "retired", note: "a static { status: ready } stub" },

  /* ---------------- pricing ---------------- */
  { route: "pricing/calculate", feature: P },
  { route: "pricing/calculations", feature: P },
  { route: "pricing/profiles", feature: P },
  { route: "pricing/profiles/[id]", feature: P },

  /* ---------------- revenue (coupons) ---------------- */
  { route: "revenue/coupons", feature: R },
  { route: "revenue/coupons/mine", feature: R },
  { route: "revenue/coupons/my-business", feature: R },
  { route: "revenue/coupons/[id]/code", feature: R },
  { route: "revenue/coupons/[id]/disable", feature: R },
  { route: "revenue/coupons/[id]/enable", feature: R },
  { route: "revenue/coupons/[id]", exempt: "public", note: "the public coupon page" },
  { route: "revenue/coupons/active", exempt: "public", note: "the public list of active coupons" },
  { route: "coupons/[token]/redeem", feature: R },
  { route: "offers", feature: R, ungated: { POST: "retired" } },
  { route: "offers/[id]", feature: R },
  { route: "offers/[id]/coupon", feature: R },
  { route: "offers/image", feature: R },

  /* ---------------- reports ---------------- */
  { route: "reports/summary", feature: RP },
  { route: "reports/uniform", exempt: FLOOR, note: "the uniform-structure export of tax documents (owner decision 2026-11-20): available in every state incl. FREE_LIMITED; the route keeps its own authentication and tenant isolation (it has no role check — pre-existing, flagged to the owner)" },
  { route: "reports/export", exempt: FLOOR },
  { route: "reports/export-zip", exempt: FLOOR },

  /* ---------------- gmail import ---------------- */
  { route: "integrations/gmail/connect", feature: G },
  { route: "integrations/gmail/disconnect", feature: G },
  { route: "integrations/gmail/import", feature: G },
  { route: "integrations/gmail/scan", feature: G },
  { route: "integrations/gmail/status", feature: G },
  { route: "integrations/gmail/sync", feature: G },
  { route: "integrations/gmail/callback", exempt: "oauth-callback" },

  /* ---------------- whatsapp ---------------- */
  { route: "integrations/whatsapp/connection", feature: W },
  { route: "integrations/whatsapp/connection/disconnect", feature: W },
  { route: "integrations/whatsapp/connection/meta-data", feature: W },
  { route: "integrations/whatsapp/embedded-signup", feature: W },
  { route: "integrations/whatsapp/webhook", exempt: "provider-webhook", note: "messages are always recorded; the starter bot step is guarded in the inbound pipeline" },

  /* ---------------- starter bot ---------------- */
  { route: "business/bot", feature: S },
  { route: "business/bot-hub", feature: S },
  { route: "business/bot-settings", feature: S },
  { route: "business/bot/goal-catalog", feature: S },
  { route: "business/bot/goals", feature: S },
  { route: "business/bot/knowledge", feature: S },
  { route: "business/bot/learning-suggestions", feature: S },
  { route: "business/bot/learning-suggestions/[id]/adopt", feature: S },
  { route: "business/bot/learning-suggestions/[id]/dismiss", feature: S },
  { route: "business/bot/memory-policy", feature: S },
  { route: "business/bot/recommendations", feature: S },
  { route: "business/bot/recommendations/[id]/apply", feature: S },
  { route: "business/bot/recommendations/[id]/dismiss", feature: S },
  { route: "business/bot/setup", feature: S },
  { route: "business/bot/setup/activate", feature: S },
  { route: "business/bot/setup/assemble", feature: S },
];

/**
 * Routes whose guard ships in a SEPARATE Draft PR, because the billing protected-paths guard
 * (scripts/ci/billing-protected-paths-guard.mjs, G1) treats any change to them as a change to the existing billing
 * mechanism that needs the owner's explicit approval (owner decision 2026-11-20). Their map entries above are the
 * final decision; until that PR lands, the test checks that these files do NOT call the guard yet.
 * That PR empties this list, which turns the full R3 check back on for every one of them.
 */
export const PENDING_SEPARATE_BILLING_REVIEW: readonly string[] = [];
