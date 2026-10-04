/**
 * Business Intake · the provider-neutral processor (M3).
 *
 * ONE lifecycle for every source. It knows receipts, adapters and stages — not
 * WhatsApp, not Meta, not Google:
 *
 *   acceptIntake     tenant from the adapter's trusted resolver → durable
 *                    receipts (the provider may be acknowledged after this)
 *   processIntakeEvent
 *     claim          lease (conditional UPDATE — one worker per event)
 *     adapter        by sourceKey; unknown source / family → dead-letter
 *                    (payload KEPT for replay once the adapter exists)
 *     normalize      pure; failure → dead-letter (retrying cannot fix it)
 *                    → IntakeNormalizedEvent (first record wins on retry)
 *     route          adapter writes domain records, idempotently
 *                    routed → PERSISTED (+ refs) · ignored → IGNORED ·
 *                    deferred → back on the queue, attempt not counted
 *     enrich         optional, retry-safe; resume flag on a repeat run
 *     complete       PROCESSED, payload purged, contact hints purged unless
 *                    identity is 'unresolved'
 *     failure        retryable → FAILED on backoff (bounded attempts);
 *                    IntakeTerminalError → dead-letter now
 *
 * Every step runs inside the caller's tenant context (runTenantJob); nothing
 * here takes a businessId from a payload.
 */

import type { IntakeEventFamily, Prisma } from "@prisma/client";
import { runTenantJob } from "@/lib/tenant/job";
import {
  replacePayload,
  claimEvent,
  errorCodeOf,
  listDueEventIds,
  markDeadLetter,
  markDeferred,
  markFailed,
  markIgnored,
  markPersisted,
  markProcessed,
  markStage,
  recordReceipts,
  type ClaimedEvent,
  type IntakeOutcomeRefs,
  type RecordedReceipt,
} from "@/lib/intake/intake-event.store";
import {
  IntakeTerminalError,
  type IntakeAdapter,
  type IntakeReceiptDraft,
  type ResultRefs,
} from "./contract";
import type { IntakeRegistry } from "./registry";
import {
  finalizeIdentityFromRefs,
  purgeContactHintsIfResolved,
  readIdentityDecision,
  recordIdentityDecision,
  recordRouteOutcome,
  saveNormalized,
} from "./normalized-store";
import { identifiersFromHints } from "@/lib/intake/identity/identifiers";
import { preResolveIdentity } from "@/lib/intake/identity/pre-resolve";
import { decideRoute } from "@/lib/intake/routing/rules";
import { CORE_DESTINATION_HANDLERS } from "@/lib/intake/routing/core-destinations";
import { logIntake } from "./observability";
import { recordSensor } from "@/lib/sensors/record-sensor";

type SettledOutcome = "processed" | "ignored" | "dead_letter";

/**
 * The learning signal for a terminal outcome: facts about the RECEIPT only
 * (source, family, route, attempts, latency) — never content or contact values.
 * Idempotent per (receipt, outcome); a sensor failure never fails intake.
 */
async function emitSettled(
  event: ClaimedEvent,
  outcome: SettledOutcome,
  stored: { routeTarget: string | null; identityOutcome: string } | null,
  now: Date
): Promise<void> {
  await recordSensor({
    businessId: event.businessId,
    sensor: "INTAKE_EVENT_SETTLED",
    entityId: event.id,
    actor: { type: "INTEGRATION" },
    source: "INTEGRATION",
    occurredAt: now,
    idempotencyKey: `intake:${event.id}:${outcome}`,
    payload: {
      sourceKey: event.sourceKey,
      family: event.family,
      eventType: event.eventType,
      outcome,
      routeTarget: stored?.routeTarget ?? null,
      identityOutcome: stored?.identityOutcome ?? null,
      attempts: event.attempts,
      latencyMs: Math.max(0, now.getTime() - event.receivedAt.getTime()),
    },
  });
}

export type IntakeProcessResult = "not_claimed" | "processed" | "ignored" | "deferred" | "failed";

// ─── accept (the durability boundary) ──────────────────────────────────────

export type AcceptResult =
  | { status: "accepted"; businessId: number; recorded: RecordedReceipt[] }
  | { status: "unknown_account" };

/**
 * Durably record receipts for the business that OWNS `accountRef` at this
 * source, as decided by the adapter's trusted resolver. There is no businessId
 * parameter: a caller (or a payload) cannot choose the tenant.
 *
 * Throws on any database failure (resolution or write) — the caller must then
 * NOT acknowledge the provider, so it redelivers.
 */
export async function acceptIntake(input: {
  registry: IntakeRegistry;
  sourceKey: string;
  accountRef: string;
  receipts: IntakeReceiptDraft[];
}): Promise<AcceptResult> {
  const adapter = input.registry.get(input.sourceKey);
  if (!adapter) throw new Error("intake: no adapter registered for source");
  for (const r of input.receipts) {
    if (!adapter.families.includes(r.family)) throw new Error("intake: family not declared by adapter");
  }
  const accountRef = typeof input.accountRef === "string" ? input.accountRef.trim() : "";
  if (!accountRef) return { status: "unknown_account" };

  const businessId = await adapter.resolveTenant(accountRef);
  if (businessId === null) return { status: "unknown_account" };

  const recorded = await runTenantJob({ businessId }, () =>
    recordReceipts(
      businessId,
      adapter.sourceKey,
      input.receipts.map((r) => ({ ...r, providerAccountRef: accountRef }))
    )
  );
  logIntake("accepted", {
    businessId,
    sourceKey: adapter.sourceKey,
    count: recorded.length,
    outcome: recorded.some((r) => r.isNew) ? "new" : "replay",
  });
  return { status: "accepted", businessId, recorded };
}

/** M4 learning signal: identity CATEGORIES and the routing rule — never values. */
async function emitIdentityResolved(event: ClaimedEvent, now: Date): Promise<void> {
  const d = await readIdentityDecision(event.businessId, event.id);
  if (!d || !d.identityState) return;
  const ev = (d.identityEvidence ?? {}) as { identifierKinds?: string[]; strongBases?: string[] };
  await recordSensor({
    businessId: event.businessId,
    sensor: "INTAKE_IDENTITY_RESOLVED",
    entityId: event.id,
    actor: { type: "INTEGRATION" },
    source: "INTEGRATION",
    occurredAt: now,
    idempotencyKey: `intake:${event.id}:identity`,
    payload: {
      state: d.identityState,
      identifierKinds: ev.identifierKinds ?? [],
      strongBases: ev.strongBases ?? [],
      candidateCount: d.identityCandidateCount ?? 0,
      policyVersion: d.identityPolicyVersion ?? null,
      routingRule: d.routingRule ?? null,
      destination: d.routingDestination ?? null,
    },
  });
}

// ─── process one receipt ────────────────────────────────────────────────────

function legacyRefs(refs: ResultRefs | undefined): IntakeOutcomeRefs {
  return {
    ...(refs?.messageId !== undefined ? { messageId: refs.messageId } : {}),
    ...(refs?.conversationId !== undefined ? { conversationId: refs.conversationId } : {}),
    ...(refs?.customerId !== undefined ? { customerId: refs.customerId } : {}),
  };
}

function familyAllowed(adapter: IntakeAdapter, family: IntakeEventFamily): boolean {
  return adapter.families.includes(family);
}

/**
 * Process ONE receipt. Never throws for a processing failure — the failure is
 * recorded on the receipt (retry on backoff, or dead-letter). Must run inside
 * the business's tenant context.
 */
export async function processIntakeEvent(
  registry: IntakeRegistry,
  businessId: number,
  eventId: number,
  now: Date = new Date()
): Promise<IntakeProcessResult> {
  const event: ClaimedEvent | null = await claimEvent(businessId, eventId, now);
  if (!event) return "not_claimed";
  const started = Date.now();
  const base = {
    businessId,
    eventId: event.id,
    sourceKey: event.sourceKey,
    family: event.family,
    eventType: event.eventType,
    attempt: event.attempts,
  };

  const adapter = registry.get(event.sourceKey);
  if (!adapter) {
    await markDeadLetter(businessId, event.id, "unknown_source");
    logIntake("dead_letter", { ...base, code: "unknown_source" });
    await emitSettled(event, "dead_letter", null, now);
    return "failed";
  }
  if (!familyAllowed(adapter, event.family)) {
    await markDeadLetter(businessId, event.id, "unsupported_family");
    logIntake("dead_letter", { ...base, code: "unsupported_family" });
    await emitSettled(event, "dead_letter", null, now);
    return "failed";
  }

  let status = event.status;
  const ctx = { businessId, now };
  try {
    if (event.payload === null) {
      // Purged (completed earlier, or an exhausted event past retention):
      // nothing left to act on, and retrying cannot help.
      await markIgnored(businessId, event.id, "payload_unavailable");
      logIntake("ignored", { ...base, code: "payload_unavailable" });
      await emitSettled(event, "ignored", null, now);
      return "ignored";
    }

    // M6 — a notification-only source completes its receipt first (normalize stays pure).
    if (adapter.hydrate) {
      const h = await adapter.hydrate(ctx, event);
      if (h.kind === "deferred") {
        await markDeferred(businessId, event, h.until, h.code);
        logIntake("deferred", { ...base, stage: "hydrate", code: h.code });
        return "deferred";
      }
      if (h.kind === "ignored") {
        await markIgnored(businessId, event.id, h.code);
        logIntake("ignored", { ...base, stage: "hydrate", code: h.code });
        await emitSettled(event, "ignored", null, now);
        return "ignored";
      }
      if (h.kind === "hydrated") {
        await replacePayload(businessId, event.id, h.payload, h.metadata);
        event.payload = h.payload as Prisma.JsonValue;
        if (h.metadata !== undefined) event.metadata = h.metadata as Prisma.JsonValue;
      }
    }

    const normalized = adapter.normalize(event);
    if (!normalized.ok) {
      await markDeadLetter(businessId, event.id, `normalize:${normalized.code}`);
      logIntake("dead_letter", { ...base, stage: "normalize", code: normalized.code });
      await emitSettled(event, "dead_letter", null, now);
      return "failed";
    }
    const stored = await saveNormalized(businessId, event.id, adapter.normalizerVersion, normalized.normalized);
    if (event.lastStage === null || event.lastStage === "received") {
      await markStage(businessId, event.id, "normalized");
    }

    // ── M4: identity (who is this about?) → deterministic routing decision ──
    const n = normalized.normalized;
    const identifiers = identifiersFromHints(n.contactHints, {
      sourceKey: event.sourceKey,
      accountRef: event.providerAccountRef,
    });
    const identity = await preResolveIdentity(businessId, identifiers);
    const decision = decideRoute({
      family: event.family,
      eventType: event.eventType,
      target: n.target,
      identityState: identity.state,
      coreDestinations: adapter.coreDestinations ?? [],
    });
    await recordIdentityDecision(businessId, event.id, identity, decision);
    if (decision.executor === "forbidden" || decision.executor === "unavailable") {
      const code =
        decision.executor === "forbidden"
          ? `routing:forbidden:${decision.rule}`
          : `routing:destination_unavailable:${decision.destination}`;
      await markDeadLetter(businessId, event.id, code);
      logIntake("dead_letter", { ...base, stage: "route", code, routeTarget: decision.destination });
      await emitSettled(event, "dead_letter", { routeTarget: decision.destination, identityOutcome: identity.state }, now);
      return "failed";
    }
    const routeCtx = {
      ...ctx,
      decision,
      identityState: identity.state,
      identityCustomerId: identity.customerId,
    };
    const coreHandler = decision.executor === "core" ? CORE_DESTINATION_HANDLERS[decision.destination] : undefined;
    const routed = coreHandler
      ? await coreHandler(routeCtx, n, event)
      : await adapter.route(routeCtx, n, event);
    if (routed.kind === "deferred") {
      await markDeferred(businessId, event, routed.until, routed.code);
      logIntake("deferred", { ...base, code: routed.code });
      return "deferred";
    }
    if (routed.kind === "ignored") {
      await recordRouteOutcome(businessId, event.id, "ignored", routed.refs, now);
      await emitIdentityResolved(event, now);
      await markIgnored(businessId, event.id, routed.code, legacyRefs(routed.refs));
      await purgeContactHintsIfResolved(businessId, event.id, now);
      logIntake("ignored", {
        ...base,
        code: routed.code,
        routeTarget: stored.routeTarget,
        durationMs: Date.now() - started,
      });
      await emitSettled(event, "ignored", stored, now);
      return "ignored";
    }

    await recordRouteOutcome(businessId, event.id, "routed", routed.refs, now);
    // A core destination already wrote the authoritative identity (resolved
    // again under the identity locks); only an adapter's result is folded in.
    if (!coreHandler) await finalizeIdentityFromRefs(businessId, event.id, identity, routed.refs);
    await emitIdentityResolved(event, now);
    await markPersisted(businessId, event.id, legacyRefs(routed.refs));
    status = "PERSISTED";

    if (adapter.enrich) {
      await adapter.enrich(ctx, routed, event, routed.alreadyExisted === true || event.status === "PERSISTED");
    }

    await markProcessed(businessId, event.id, legacyRefs(routed.refs));
    await purgeContactHintsIfResolved(businessId, event.id, now, { identityDecided: !!coreHandler });
    logIntake("processed", {
      ...base,
      routeTarget: stored.routeTarget,
      identityOutcome: stored.identityOutcome,
      resultKinds: Object.keys(routed.refs),
      durationMs: Date.now() - started,
    });
    await emitSettled(event, "processed", stored, now);
    return "processed";
  } catch (error) {
    if (error instanceof IntakeTerminalError) {
      await markDeadLetter(businessId, event.id, error.code);
      logIntake("dead_letter", { ...base, code: error.code });
      await emitSettled(event, "dead_letter", null, now);
      return "failed";
    }
    const code = errorCodeOf(error);
    await markFailed(businessId, { id: event.id, attempts: event.attempts, status }, code);
    logIntake("failed", { ...base, code });
    return "failed";
  }
}

// ─── drain ─────────────────────────────────────────────────────────────────

export function emptyTally(): Record<IntakeProcessResult, number> {
  return { not_claimed: 0, processed: 0, ignored: 0, deferred: 0, failed: 0 };
}

/**
 * Process the named receipts, then whatever else of this business is due —
 * every source, oldest first, one at a time. Bounded per call. A poison event
 * costs one attempt per call and never blocks the others: each event is
 * claimed, failed and re-queued on its own.
 */
export async function drainIntake(
  registry: IntakeRegistry,
  businessId: number,
  options: { eventIds?: number[]; limit?: number; now?: Date } = {}
): Promise<Record<IntakeProcessResult, number>> {
  const now = options.now ?? new Date();
  const due = await listDueEventIds(businessId, now, options.limit ?? 25);
  const ids = [...new Set([...(options.eventIds ?? []), ...due])].sort((a, b) => a - b);
  const tally = emptyTally();
  for (const id of ids) {
    tally[await processIntakeEvent(registry, businessId, id, now)] += 1;
  }
  return tally;
}
