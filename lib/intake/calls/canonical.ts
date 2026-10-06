/**
 * M7-A — the ONE canonical business call (docs/business-intake-m7-decision-v1.md §6–§7, D8, D9).
 *
 * Every telephony adapter (CloudTalk, Voicenter — M7-C) turns its provider's TERMINAL call event
 * (the call ended / the CDR) into a {@link CallV1}. From here on nothing knows the provider:
 *
 *   provider event ──adapter──▶ CallV1 ──▶ IntakeReceiptDraft (family CALL)
 *        ──acceptIntake──▶ IntakeEvent ──processor──▶ normalizeCall ──▶ M4 identity (read only)
 *        ──▶ R9_CALL ──▶ routeToCall ──▶ CallActivity (+ Secretary, + sensors)
 *
 * A call is NEVER a Lead (R0), never creates a Customer (D8: an unknown caller stays a hash), never
 * creates an IdentityLink (caller id is spoofable), never moves a lead. Recordings, transcripts and
 * any AI fields a provider sends are dropped HERE, before the receipt exists (D9).
 *
 * Receipt identity: the provider's call id within the connection (a call has one terminal event; a
 * redelivery or a later correction of the same call is the same CallActivity).
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ClaimedIntakeEvent, IntakeReceiptDraft, NormalizeResult } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { sanitizeAttribution } from "@/lib/intake/core/attribution";
import { normalizeContactHints } from "@/lib/intake/core/contact";

export const TELEPHONY_SOURCE_KEYS = ["telephony.cloudtalk", "telephony.voicenter"] as const;
export type TelephonySourceKey = (typeof TELEPHONY_SOURCE_KEYS)[number];
export function isTelephonySourceKey(v: unknown): v is TelephonySourceKey {
  return typeof v === "string" && (TELEPHONY_SOURCE_KEYS as readonly string[]).includes(v);
}

export const CALL_DIRECTIONS = ["inbound", "outbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];
export const CALL_OUTCOMES = ["answered", "missed", "voicemail", "busy", "failed", "rejected"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
/** Outcomes of an INBOUND call that leave the caller waiting for the business. */
export const UNRETURNED_OUTCOMES: readonly CallOutcome[] = ["missed", "voicemail", "busy", "rejected"];

export type CallV1 = {
  v: 1;
  kind: "business_call";
  providerCallId: string;
  direction: CallDirection;
  outcome: CallOutcome;
  durationSec: number;
  startedAt: string;
  endedAt?: string;
  /** The business's own line (digits) — routing / attribution evidence, never a person. */
  businessLine?: string;
  /** PERSONAL — the other party's number as the provider reports it. Only ever an M4 contact hint. */
  counterpartNumber?: string;
  /** The provider reported no usable caller id (hidden / anonymous / private). */
  counterpartHidden: boolean;
  /** The provider's modification time for this event (ordering); defaults to endedAt ?? startedAt. */
  providerUpdatedAt: string;
  /** M7-C — the owner's own name for the line at the provider ("Sales line"); business data, attribution only. */
  lineName?: string;
};

export class CallInvalid extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CallInvalid";
  }
}

const isoOf = (v: unknown): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number" && !(v instanceof Date)) return undefined;
  const d = v instanceof Date ? v : typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const HIDDEN = /^(anonymous|private|restricted|unknown|unavailable|hidden|blocked|withheld|0+|\+?)$/i;

/**
 * Bound and validate a provider's parts into the canonical call. Throws {@link CallInvalid}.
 * Anything not named here (recording URLs, transcripts, AI summaries, agent names) never enters.
 */
export function canonicalCall(input: {
  providerCallId: unknown;
  direction: unknown;
  outcome: unknown;
  durationSec?: unknown;
  startedAt: unknown;
  endedAt?: unknown;
  businessLine?: unknown;
  counterpartNumber?: unknown;
  providerUpdatedAt?: unknown;
}): CallV1 {
  const id = typeof input.providerCallId === "string" || typeof input.providerCallId === "number" ? String(input.providerCallId).trim() : "";
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new CallInvalid("call_id");
  if (!(CALL_DIRECTIONS as readonly unknown[]).includes(input.direction)) throw new CallInvalid("direction");
  if (!(CALL_OUTCOMES as readonly unknown[]).includes(input.outcome)) throw new CallInvalid("outcome");
  const startedAt = isoOf(input.startedAt);
  if (!startedAt) throw new CallInvalid("time");
  let endedAt = isoOf(input.endedAt);
  if (endedAt && endedAt < startedAt) endedAt = undefined;
  const d = input.durationSec;
  const durationSec = typeof d === "number" && Number.isFinite(d) && d >= 0 ? Math.min(86_400, Math.round(d)) : 0;
  const lineDigits = typeof input.businessLine === "string" || typeof input.businessLine === "number"
    ? String(input.businessLine).replace(/\D/g, "") : "";
  const raw = typeof input.counterpartNumber === "string" || typeof input.counterpartNumber === "number"
    ? String(input.counterpartNumber).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";
  const hidden = !raw || HIDDEN.test(raw.replace(/\s+/g, ""));
  return {
    v: 1,
    kind: "business_call",
    providerCallId: id,
    direction: input.direction as CallDirection,
    outcome: input.outcome as CallOutcome,
    durationSec,
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(lineDigits.length >= 3 && lineDigits.length <= 20 ? { businessLine: lineDigits } : {}),
    ...(hidden ? {} : { counterpartNumber: raw }),
    counterpartHidden: hidden,
    providerUpdatedAt: isoOf(input.providerUpdatedAt) ?? endedAt ?? startedAt,
  };
}

/** The receipt for one terminal call event. Metadata is non-personal by construction. */
export function callReceipt(call: CallV1, accountScope: string): IntakeReceiptDraft {
  const identity = deriveEventIdentity({ providerEventId: `${call.providerCallId}@${call.providerUpdatedAt}`, accountScope });
  return {
    family: "CALL",
    eventType: call.direction === "inbound" && call.outcome !== "answered" ? "call.missed" : "call.completed",
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    providerAccountRef: null,
    occurredAt: new Date(call.startedAt),
    payload: call as unknown as Prisma.InputJsonValue,
    metadata: {
      v: 1,
      direction: call.direction,
      outcome: call.outcome,
      durationBucket: durationBucket(call.durationSec),
      callerPresent: !call.counterpartHidden,
    } as Prisma.InputJsonValue,
  };
}

export function isCall(v: unknown): v is CallV1 {
  const c = v as Partial<CallV1> | null;
  return !!c && c.v === 1 && c.kind === "business_call" && typeof c.providerCallId === "string" &&
    typeof c.direction === "string" && typeof c.outcome === "string" && typeof c.startedAt === "string" &&
    typeof c.providerUpdatedAt === "string" && typeof c.counterpartHidden === "boolean";
}

/** Coarse, non-identifying duration category (learning signals). */
export function durationBucket(sec: number): "0" | "1-30s" | "31-120s" | "2-10m" | "10m+" {
  if (sec <= 0) return "0";
  if (sec <= 30) return "1-30s";
  if (sec <= 120) return "31-120s";
  if (sec <= 600) return "2-10m";
  return "10m+";
}

const CALLER_HASH_VERSION = "m7a.caller.v1";
/**
 * Unknown caller → a domain-separated sha256 of (business, normalized number): repeat calls group,
 * the number is never stored, and the same number in another business hashes differently.
 */
export function callerHash(businessId: number, normalizedPhone: string): string {
  return `sha256:${createHash("sha256").update([CALLER_HASH_VERSION, String(businessId), normalizedPhone].join("\u001f"), "utf8").digest("hex")}`;
}

/** The ONE call normalizer: the counterpart's number → an M4 phone hint; target call (never lead). */
export function normalizeCall(event: ClaimedIntakeEvent): NormalizeResult {
  const call = event.payload;
  if (!isCall(call)) return { ok: false, code: "malformed_payload" };
  const contact = call.counterpartHidden ? { hints: null, signals: {} } : normalizeContactHints({ phone: call.counterpartNumber });
  return {
    ok: true,
    normalized: {
      occurredAt: event.occurredAt,
      contactHints: contact.hints,
      signals: contact.signals,
      identity: contact.hints ? "unresolved" : "none",
      attribution: sanitizeAttribution({
        channel: "call",
        provider: "telephony",
        source: typeof call.lineName === "string" && call.lineName.trim()
          ? `line:${call.lineName.trim().slice(0, 60)}`
          : call.businessLine ? `line:${call.businessLine.slice(-4)}` : undefined,
      }),
      target: "call",
    },
  };
}
