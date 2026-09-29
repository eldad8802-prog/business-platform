/**
 * Business Intake M3 — REFERENCE adapter (TEST-ONLY).
 *
 * A fundamentally different source from WhatsApp — an explicit lead / form
 * submission — built ONLY to prove the canonical core is provider-neutral:
 * different source, different family, different identity strategy, different
 * routing destination — same receipt, lifecycle, idempotency and isolation.
 *
 * It is NOT registered in lib/intake/sources.ts, has no route handler, and lives
 * outside lib/ — no Production request can reach it.
 *
 * Its "trusted connection" is an injected map (a stand-in for the governed
 * connection a real connector will have). Its lead destination is an injected
 * sink (a stand-in for the Lead domain, which M3 does not redesign), idempotent
 * per receipt, with switchable failures for the failure matrix.
 */

import type { IntakeEventFamily, Prisma } from "@prisma/client";
import {
  IntakeTerminalError,
  type ClaimedIntakeEvent,
  type IntakeAdapter,
  type IntakeReceiptDraft,
  type RouteResult,
} from "../lib/intake/core/contract";
import { deriveEventIdentity } from "../lib/intake/core/event-identity";
import { sanitizeAttribution } from "../lib/intake/core/attribution";
import { normalizeContactHints } from "../lib/intake/core/contact";

export const REFERENCE_SOURCE = "reference.lead_form";

/** What the (imaginary) provider delivers. Note `claimedBusinessId`: untrusted. */
export type ReferenceDelivery = {
  kind: "lead" | "form";
  formId: string;
  submissionId: string | null;
  submittedAt: string | null;
  fields?: { fullName?: string; phone?: string; email?: string; company?: string } | null;
  tracking?: Record<string, unknown> | null;
  /** A hostile / confused provider payload naming a tenant. Must be ignored. */
  claimedBusinessId?: number;
};

type ReferencePayloadV1 = {
  v: 1;
  formId: string;
  fields: NonNullable<ReferenceDelivery["fields"]> | null;
};

function parseTime(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + 86_400_000 || d.getTime() < Date.UTC(2000, 0, 1)) return null;
  return d;
}

/** Builds the canonical draft. Throws MissingEventIdentityError when unkeyable. */
export function buildReferenceReceipt(d: ReferenceDelivery): IntakeReceiptDraft {
  const contact = normalizeContactHints({ phone: d.fields?.phone, email: d.fields?.email });
  const identity = d.submissionId
    ? deriveEventIdentity({ providerEventId: d.submissionId, accountScope: d.formId })
    : deriveEventIdentity({
        // No provider id: the adapter NAMES its fingerprint — form + time + contact.
        fingerprint: [d.formId, d.submittedAt, contact.hints?.email ?? null, contact.hints?.phone ?? null],
        accountScope: d.formId,
      });
  const family: IntakeEventFamily = d.kind === "lead" ? "LEAD" : "FORM_SUBMISSION";
  const payload: ReferencePayloadV1 = { v: 1, formId: d.formId, fields: d.fields ?? null };
  return {
    family,
    eventType: d.kind === "lead" ? "lead.submitted" : "form.submitted",
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    providerAccountRef: null, // set by acceptIntake from the trusted account
    occurredAt: parseTime(d.submittedAt),
    payload: payload as unknown as Prisma.InputJsonValue,
    // Attribution goes to metadata raw-ish; the normalizer sanitizes it.
    metadata: (d.tracking ?? null) as Prisma.InputJsonValue | null,
  };
}

export type LeadSink = {
  /** Idempotent per (businessId, receiptId): returns the same lead id on repeat. */
  upsert(businessId: number, receiptId: number): Promise<number>;
  calls: number;
  distinctLeads(): number;
};

export function createLeadSink(): LeadSink & {
  failNext: number;
  failAlways: boolean;
  terminal: boolean;
} {
  const leads = new Map<string, number>();
  let seq = 1000;
  const sink = {
    calls: 0,
    failNext: 0,
    failAlways: false,
    terminal: false,
    async upsert(businessId: number, receiptId: number) {
      sink.calls++;
      if (sink.terminal) throw new IntakeTerminalError("lead_rejected");
      if (sink.failAlways) throw new Error("sink down");
      if (sink.failNext > 0) {
        sink.failNext--;
        throw new Error("sink transient");
      }
      const key = `${businessId}:${receiptId}`;
      if (!leads.has(key)) leads.set(key, ++seq);
      return leads.get(key)!;
    },
    distinctLeads: () => leads.size,
  };
  return sink;
}

export function createReferenceAdapter(opts: {
  sourceKey?: string;
  /** Trusted configuration: the provider account (form) → the business that owns it. */
  connections: Map<string, number>;
  sink: LeadSink;
  resolverFails?: () => boolean;
  deferNext?: { count: number };
}): IntakeAdapter {
  return {
    sourceKey: opts.sourceKey ?? REFERENCE_SOURCE,
    families: ["LEAD", "FORM_SUBMISSION"],
    normalizerVersion: `${opts.sourceKey ?? REFERENCE_SOURCE}@1`,

    async resolveTenant(accountRef) {
      if (opts.resolverFails?.()) throw new Error("connection store unavailable");
      return opts.connections.get(accountRef) ?? null;
    },

    normalize(event: ClaimedIntakeEvent) {
      const p = event.payload as ReferencePayloadV1 | null;
      if (!p || p.v !== 1 || typeof p.formId !== "string" || !p.fields || typeof p.fields !== "object") {
        return { ok: false, code: "malformed_payload" };
      }
      const contact = normalizeContactHints({
        phone: p.fields.phone,
        email: p.fields.email,
        displayName: p.fields.fullName,
        companyName: p.fields.company,
      });
      const tracking = (event.metadata ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        normalized: {
          occurredAt: event.occurredAt,
          contactHints: contact.hints,
          signals: contact.signals,
          // No deterministic contact rule at this destination: M4 decides.
          identity: contact.hints ? "unresolved" : "none",
          attribution: sanitizeAttribution({
            channel: "lead_form",
            provider: "reference",
            form: tracking.formName,
            formId: p.formId,
            campaignId: tracking.campaignId,
            adSetId: tracking.adSetId,
            adId: tracking.adId,
            landingPage: tracking.landingPage,
            utm: tracking.utm as Record<string, unknown> | undefined,
          }),
          target: event.family === "LEAD" ? "lead" : "attention",
        },
      };
    },

    async route(ctx, normalized, event): Promise<RouteResult> {
      if (opts.deferNext && opts.deferNext.count > 0) {
        opts.deferNext.count--;
        return { kind: "deferred", code: "throttled", until: new Date(ctx.now.getTime() + 60_000) };
      }
      if (normalized.target !== "lead") return { kind: "ignored", code: "form_needs_owner" };
      const leadId = await opts.sink.upsert(ctx.businessId, event.id);
      return { kind: "routed", refs: { leadId } };
    },
  };
}
