/**
 * M7-C — CloudTalk (source "telephony.cloudtalk"). Official behaviour this module is built on
 * (developers.cloudtalk.io: webhooks overview / events/calls / verify-signatures / delivery; openapi.json):
 *
 *   delivery   Svix-signed (svix-id / svix-timestamp / svix-signature; per-endpoint secret whsec_…, shown under
 *              Account → Webhooks); envelope {event_id, type, version, occurred_at, company_id, data}; at-least-once,
 *              up to 50 retries over ~11.5 h, out of order possible. Dubiz uses only `call.ended`.
 *   call.ended data: call_id, call_uuid, direction (incoming / outgoing / internal / monitor), external_number
 *              (absent when withheld), internal_number {number_e164, internal_name}, started_at, ended_at, duration,
 *              talking_time (omitted when not available), is_voicemail. There is NO answered / missed field.
 *   outcome    therefore the webhook records a REFERENCE (no guess): the processor's hydrate step reads the call
 *              from the call-history API (GET https://my.cloudtalk.io/api/calls/index.json?call_id=…, HTTP Basic
 *              with the customer's API Access Key ID / Secret) and takes answered / missed from it — the same
 *              pattern as Meta Lead Ads. Without an API key the receipt waits (deferred), never guessed.
 *   tenant     the Dubiz endpoint (publicId) + its secret; company_id is cross-checked (bound on first delivery).
 */
import type { Prisma } from "@prisma/client";
import { IntakeTerminalError, type ClaimedIntakeEvent, type HydrateResult, type IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { callReceipt, canonicalCall, CallInvalid, type CallOutcome } from "./canonical";

export const CLOUDTALK_SOURCE = "telephony.cloudtalk" as const;

/** What a call.ended delivery becomes before the outcome is known (no personal data beyond the number). */
export type CloudTalkCallRefV1 = {
  v: 1;
  kind: "cloudtalk_call_ref";
  callId: string;
  direction: "inbound" | "outbound";
  startedAt: string;
  endedAt?: string;
  durationSec: number;
  talkingSec?: number;
  isVoicemail: boolean;
  /** PERSONAL — the other party's number (E.164), absent when withheld. */
  externalNumber?: string;
  businessLine?: string;
  /** The owner's own name for the line in CloudTalk ("Sales line") — business data. */
  lineName?: string;
};

export type CloudTalkParse =
  | { ok: true; companyId: string; receipt: IntakeReceiptDraft }
  | { ok: true; companyId: string | null; ignored: string }
  | { ok: false; code: string };

export function parseCloudTalkWebhook(raw: string): CloudTalkParse {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "malformed" };
  }
  const companyId = typeof body.company_id === "string" || typeof body.company_id === "number" ? String(body.company_id) : null;
  if (!companyId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(companyId)) return { ok: false, code: "company_id" };
  if (body.type !== "call.ended") return { ok: true, companyId, ignored: "not_call_ended" };
  const d = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  const callId = typeof d.call_id === "string" || typeof d.call_id === "number" ? String(d.call_id) : "";
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(callId)) return { ok: false, code: "call_id" };
  const dir = d.direction === "incoming" ? "inbound" : d.direction === "outgoing" ? "outbound" : null;
  if (!dir) return { ok: true, companyId, ignored: "internal_call" };
  const internal = (d.internal_number && typeof d.internal_number === "object" ? d.internal_number : {}) as Record<string, unknown>;
  const startedAt = typeof d.started_at === "string" ? d.started_at : "";
  if (!startedAt || Number.isNaN(new Date(startedAt).getTime())) return { ok: false, code: "time" };
  const ref: CloudTalkCallRefV1 = {
    v: 1,
    kind: "cloudtalk_call_ref",
    callId,
    direction: dir,
    startedAt: new Date(startedAt).toISOString(),
    ...(typeof d.ended_at === "string" && !Number.isNaN(new Date(d.ended_at).getTime()) ? { endedAt: new Date(d.ended_at).toISOString() } : {}),
    durationSec: typeof d.duration === "number" && d.duration >= 0 ? Math.min(86_400, Math.round(d.duration)) : 0,
    ...(typeof d.talking_time === "number" && d.talking_time >= 0 ? { talkingSec: Math.round(d.talking_time) } : {}),
    isVoicemail: d.is_voicemail === true,
    ...(typeof d.external_number === "string" && d.external_number.trim() ? { externalNumber: d.external_number.trim().slice(0, 40) } : {}),
    ...(typeof internal.number_e164 === "string" ? { businessLine: internal.number_e164.replace(/\D/g, "").slice(0, 20) } : {}),
    ...(typeof internal.internal_name === "string" && internal.internal_name.trim() ? { lineName: internal.internal_name.trim().slice(0, 60) } : {}),
  };
  // One receipt per call (event ids differ between event types; retries share the call id).
  const identity = deriveEventIdentity({ providerEventId: `call:${callId}`, accountScope: companyId });
  return {
    ok: true,
    companyId,
    receipt: {
      family: "CALL",
      eventType: dir === "inbound" ? "call.ended_inbound" : "call.ended_outbound",
      externalEventId: identity.externalEventId,
      dedupeBasis: identity.dedupeBasis,
      providerAccountRef: null,
      occurredAt: new Date(ref.startedAt),
      payload: ref as unknown as Prisma.InputJsonValue,
      metadata: { v: 1, direction: dir, hydrated: false, callerPresent: !!ref.externalNumber } as Prisma.InputJsonValue,
    },
  };
}

// ── call-history API (hydrate) ─────────────────────────────────────────────────────────────────────

type CtFetch = (url: string, auth: string) => Promise<{ status: number; json: unknown }>;
const realFetch: CtFetch = async (url, auth) => {
  const r = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
};
let ctFetch: CtFetch = realFetch;
export function setCloudTalkFetchForTests(fn: CtFetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  ctFetch = fn ?? realFetch;
}

const HOUR = 3_600_000;

/** The call's record in CloudTalk: answered iff it has an answered_at. */
export async function fetchCloudTalkOutcome(callId: string, apiKeyId: string, apiKeySecret: string): Promise<{ answered: boolean; voicemail: boolean } | "not_found" | "unauthorized" | "rate_limited" | "error"> {
  const auth = Buffer.from(`${apiKeyId}:${apiKeySecret}`, "utf8").toString("base64");
  let res;
  try {
    res = await ctFetch(`https://my.cloudtalk.io/api/calls/index.json?call_id=${encodeURIComponent(callId)}&limit=1`, auth);
  } catch {
    return "error";
  }
  if (res.status === 401 || res.status === 403) return "unauthorized";
  if (res.status === 429) return "rate_limited";
  if (res.status !== 200) return "error";
  const rows = ((res.json as { responseData?: { data?: unknown[] } } | null)?.responseData?.data ?? []) as Array<{ Cdr?: Record<string, unknown> }>;
  const cdr = rows[0]?.Cdr;
  if (!cdr) return "not_found";
  const answeredAt = cdr.answered_at;
  return { answered: typeof answeredAt === "string" && answeredAt.trim() !== "" && !answeredAt.startsWith("0000"), voicemail: cdr.is_voicemail === true || cdr.is_voicemail === "1" };
}

/**
 * Hydrate: reference → canonical call with the AUTHORITATIVE outcome. Inbound: answered / voicemail / missed.
 * Outbound: answered, else "missed" means the business called and nobody answered.
 */
export async function hydrateCloudTalkCall(
  ctx: { businessId: number; now: Date },
  event: ClaimedIntakeEvent,
  readKey: (businessId: number, publicId: string) => Promise<{ apiKeyId: string; apiKeySecret: string } | null>
): Promise<HydrateResult> {
  const p = event.payload as Partial<CloudTalkCallRefV1> | null;
  if (!p || p.kind !== "cloudtalk_call_ref") return { kind: "unchanged" }; // already canonical (resume)
  if (typeof p.callId !== "string" || (p.direction !== "inbound" && p.direction !== "outbound")) throw new IntakeTerminalError("malformed_reference");
  if (!event.providerAccountRef) throw new IntakeTerminalError("no_connection_reference");
  const key = await readKey(ctx.businessId, event.providerAccountRef);
  if (!key) return { kind: "deferred", code: "cloudtalk_api_key_missing", until: new Date(ctx.now.getTime() + 6 * HOUR) };
  const r = await fetchCloudTalkOutcome(p.callId, key.apiKeyId, key.apiKeySecret);
  if (r === "unauthorized") return { kind: "deferred", code: "cloudtalk_api_key_invalid", until: new Date(ctx.now.getTime() + 6 * HOUR) };
  if (r === "rate_limited") return { kind: "deferred", code: "cloudtalk_rate_limited", until: new Date(ctx.now.getTime() + 5 * 60_000) };
  // The history may lag the webhook by seconds: a not-yet-visible call is retried, then dead-letters.
  if (r === "not_found") {
    if (ctx.now.getTime() - event.receivedAt.getTime() < 24 * HOUR) return { kind: "deferred", code: "cloudtalk_call_not_yet_visible", until: new Date(ctx.now.getTime() + 10 * 60_000) };
    throw new IntakeTerminalError("cloudtalk_call_not_found");
  }
  if (r === "error") throw new Error("cloudtalk_api_error");
  const outcome: CallOutcome = r.answered ? "answered" : r.voicemail || p.isVoicemail ? "voicemail" : "missed";
  try {
    const call = canonicalCall({
      providerCallId: p.callId,
      direction: p.direction,
      outcome,
      durationSec: r.answered ? (p.talkingSec ?? p.durationSec ?? 0) : 0,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      businessLine: p.businessLine,
      counterpartNumber: p.externalNumber,
    });
    const receipt = callReceipt(call, event.providerAccountRef);
    return {
      kind: "hydrated",
      payload: { ...call, ...(p.lineName ? { lineName: p.lineName } : {}) } as unknown as Prisma.InputJsonValue,
      metadata: { ...(receipt.metadata as Record<string, unknown>), hydrated: true } as Prisma.InputJsonValue,
    };
  } catch (e) {
    throw new IntakeTerminalError(e instanceof CallInvalid ? `call_${e.code}` : "call_invalid");
  }
}
