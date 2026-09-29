/**
 * Business Intake · the canonical contract (M3).
 *
 * Every source — WhatsApp today; Meta Lead Ads, Google Lead Forms, telephony,
 * commerce, partner feeds later — enters Dubiz through ONE pipeline:
 *
 *   source request ──(adapter: verify + build receipts)──▶ acceptIntake()
 *     tenant ONLY from the adapter's trusted resolver (never from a payload)
 *     durable receipt (IntakeEvent)  ◀── provider is acknowledged after this
 *   processor (lease / retry / dead-letter — provider-neutral)
 *     adapter.normalize()  → IntakeNormalizedEvent  (what Dubiz understood)
 *     adapter.route()      → domain records          (operational truth)
 *     adapter.enrich()     → optional, retry-safe follow-up
 *
 * Three layers, three homes: the RECEIPT is evidence of what the provider
 * delivered; the NORMALIZED record is Dubiz's understanding (contact hints,
 * attribution, identity outcome, routing decision); the DOMAIN records
 * (Customer / Conversation / Message / Lead / …) stay the operational truth.
 *
 * The core never branches on a provider. Everything provider-specific lives in
 * an adapter behind {@link IntakeAdapter}; the core only sees these types.
 */

import type { IntakeEventFamily, IntakeEventKind, IntakeProvider, Prisma } from "@prisma/client";

// ─── vocabularies (mirrored by CHECK constraints in the M3 migration) ─────

export const INTAKE_FAMILIES = [
  "MESSAGE",
  "LEAD",
  "FORM_SUBMISSION",
  "CALL",
  "COMMERCE",
  "EMAIL",
  "DOCUMENT",
  "CUSTOM",
] as const satisfies readonly IntakeEventFamily[];

/** Where a normalized event is routed. The domain decides what it becomes. */
export const ROUTE_TARGETS = [
  "conversation", // Conversation / Message
  "message_status", // a provider receipt about an OUTBOUND message
  "lead", // an explicit lead / opportunity (never a plain inbound message)
  "customer", // a contact record only
  "commerce", // an order / checkout (never a Lead)
  "document", // the documents intake (stays authoritative for documents)
  "attention", // needs a human; no domain write
  "none", // understood, deliberately not materialised
] as const;
export type RouteTarget = (typeof ROUTE_TARGETS)[number];

/**
 * M3 never merges identities.
 *  - none       no contact signal (e.g. a delivery receipt)
 *  - delegated  the destination resolved the contact by its own existing
 *               deterministic rule (WhatsApp: phone → Customer)
 *  - unresolved hints kept for M4 to turn into an owner proposal
 */
export const IDENTITY_OUTCOMES = ["none", "delegated", "unresolved"] as const;
export type IdentityOutcome = (typeof IDENTITY_OUTCOMES)[number];

export const INTAKE_STAGES = ["received", "normalized", "routed", "completed"] as const;
export type IntakeStage = (typeof INTAKE_STAGES)[number];

/** How a receipt's externalEventId was derived. */
export type DedupeBasis = "provider_event_id" | "content_fingerprint";

/** A registry key: dotted lowercase identifier ("whatsapp", "meta.lead_ads"). */
export const SOURCE_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
export function isValidSourceKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 64 && SOURCE_KEY_PATTERN.test(key);
}
export function isValidEventType(type: unknown): type is string {
  return typeof type === "string" && type.length <= 64 && SOURCE_KEY_PATTERN.test(type);
}

// ─── receipt (what the provider delivered) ─────────────────────────────────

/**
 * One receipt, as an adapter builds it. There is deliberately NO businessId
 * here: the tenant comes only from the adapter's trusted resolver.
 */
export type IntakeReceiptDraft = {
  family: IntakeEventFamily;
  eventType: string;
  /** From {@link deriveEventIdentity} — never a raw provider value. */
  externalEventId: string;
  dedupeBasis: DedupeBasis;
  /** The business's own account at the provider (routing evidence, not a person). */
  providerAccountRef: string | null;
  /** Business time as the provider reports it; null when absent/implausible. */
  occurredAt: Date | null;
  /** Minimal envelope needed to process. PERSONAL DATA until processed; purged. */
  payload: Prisma.InputJsonValue;
  /** Non-personal facts kept after the payload is purged. */
  metadata: Prisma.InputJsonValue | null;
  /** LEGACY (M2) columns — only the WhatsApp adapter sets them. */
  legacy?: { provider: IntakeProvider; kind: IntakeEventKind };
};

/** A claimed receipt, as the processor hands it to an adapter. */
export type ClaimedIntakeEvent = {
  id: number;
  businessId: number;
  sourceKey: string;
  family: IntakeEventFamily;
  eventType: string;
  externalEventId: string;
  providerAccountRef: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
  status: "RECEIVED" | "PERSISTED" | "PROCESSED" | "FAILED" | "IGNORED";
  attempts: number;
  payload: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
};

// ─── normalized (what Dubiz understood) ────────────────────────────────────

/**
 * Contact HINTS — never proven identity. Personal data: purged when the event
 * completes (unless the identity outcome is 'unresolved') and by erasure.
 */
export type ContactHints = {
  /** Digits-only, normalized by the ONE shared phone normalizer. */
  phone?: string;
  /** Lower-cased, trimmed, syntactically valid. */
  email?: string;
  /** The person's id AT THIS PROVIDER — strong only within the provider scope. */
  providerUserId?: string;
  displayName?: string;
  companyName?: string;
};

/** Non-personal: which hints were present and whether they were usable. */
export type ContactSignals = Partial<
  Record<"phone" | "email" | "providerUserId" | "displayName" | "companyName", "valid" | "invalid">
>;

/**
 * Structured acquisition evidence (M8 builds on it; M3 only preserves it).
 * Every field optional — a source fills what it truly knows.
 */
export type IntakeAttributionV1 = {
  v: 1;
  channel?: string;
  source?: string;
  provider?: string;
  campaign?: string;
  campaignId?: string;
  adSet?: string;
  adSetId?: string;
  ad?: string;
  adId?: string;
  form?: string;
  formId?: string;
  /** origin + path only — query strings can carry personal data. */
  landingPage?: string;
  utm?: Partial<Record<"source" | "medium" | "campaign" | "content" | "term", string>>;
  /** Provider click / referral identifiers (e.g. WhatsApp ctwa_clid). */
  clickId?: string;
  referralSourceType?: string;
  referralSourceUrl?: string;
  headline?: string;
  /** First time the provider saw the acquisition touch, when it says. */
  firstTouchAt?: string;
};

export type NormalizedIntake = {
  occurredAt: Date | null;
  contactHints: ContactHints | null;
  signals: ContactSignals;
  identity: IdentityOutcome;
  attribution: IntakeAttributionV1 | null;
  target: RouteTarget;
};

// ─── adapter ───────────────────────────────────────────────────────────────

/** Domain records an event produced — plain ids, never content. */
export type ResultRefs = Partial<
  Record<"customerId" | "conversationId" | "messageId" | "leadId" | "documentImportId" | "orderId", number>
>;

export type RouteResult =
  | {
      kind: "routed";
      refs: ResultRefs;
      /** True when the domain record already existed (a resumed attempt). */
      alreadyExisted?: boolean;
      /** Opaque, adapter-only hand-off to its own enrich step. */
      context?: unknown;
    }
  | { kind: "ignored"; code: string; refs?: ResultRefs }
  | { kind: "deferred"; code: string; until: Date };

export type NormalizeResult =
  | { ok: true; normalized: NormalizedIntake }
  | { ok: false; code: string };

/** M4 — the routing decision the core made before route() runs. */
export type RouteDecisionInfo = {
  rule: string;
  destination: RouteTarget;
  ownerReviewRequired: boolean;
};

export type IntakeRouteContext = {
  businessId: number;
  now: Date;
  /** M4: the deterministic routing decision (always set by the processor). */
  decision?: RouteDecisionInfo;
  /** M4: identity state at decision time ('resolved' | 'candidate' | …). */
  identityState?: string;
  /** M4: the Customer identity resolution named, when resolved. */
  identityCustomerId?: number | null;
};

/**
 * What a source must provide to plug into Business Intake. Adding a provider =
 * one of these + its verification + its tests. Nothing in the core changes.
 */
export interface IntakeAdapter {
  readonly sourceKey: string;
  /** Families this source may emit; a receipt outside them is not processed. */
  readonly families: readonly IntakeEventFamily[];
  /** "<source>@<n>" — bump when normalization semantics change. */
  readonly normalizerVersion: string;
  /**
   * Trusted tenant resolution: the business's own account at the provider →
   * the business that owns it (a governed connection record). Returns null for
   * an unknown / owner-stopped account. A database error must THROW.
   */
  resolveTenant(accountRef: string): Promise<number | null>;
  /** Pure and deterministic. A failure is terminal: retrying cannot fix it. */
  normalize(event: ClaimedIntakeEvent): NormalizeResult;
  /** Writes the domain records. MUST be idempotent: a retry re-runs it. */
  route(ctx: IntakeRouteContext, normalized: NormalizedIntake, event: ClaimedIntakeEvent): Promise<RouteResult>;
  /** Optional follow-up after routing (retry-safe; `resume` = a repeat run). */
  enrich?(
    ctx: IntakeRouteContext,
    routed: Extract<RouteResult, { kind: "routed" }>,
    event: ClaimedIntakeEvent,
    resume: boolean
  ): Promise<void>;
  /** Bootstrap reader: businesses that may hold receipts of this source (sweeper). */
  listTenants?(): Promise<number[]>;
  /**
   * M4 — destinations this adapter lets the CORE execute with its own
   * provider-neutral handler (e.g. "lead": identity-resolved Customer + Lead).
   * Payload-bound destinations (conversation, message status, document) stay
   * with the adapter's route().
   */
  readonly coreDestinations?: readonly RouteTarget[];
}

/** Thrown by an adapter for a failure retrying cannot fix (dead-letter now). */
export class IntakeTerminalError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "IntakeTerminalError";
    this.code = code;
  }
}
