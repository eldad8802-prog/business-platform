/**
 * M7-C — Voicenter (source "telephony.voicenter"). Built ONLY on what Voicenter publishes
 * (voicenter.com/API/CDR-Notification-System-API): after a call ends Voicenter POSTs its CDR (JSON, XML-RPC or
 * form-encoded — Dubiz accepts JSON and form) to a URL "provided to us"; it re-sends when it gets no valid
 * response, and the expected answer is HTTP 200 + {"Err":0,"Errdesc":"OK"}.
 *
 * Fields used (published meanings): ivruniqueid (the call id — dedupe), direction (incoming / outgoing /
 * internal), isAnswer (0/1), status (ANSWER / BUSY / NOANSWER / CANCEL / ABANDONE / VOEND / VOICEMAIL / …),
 * time (epoch seconds), duration / actualCallDuration, did (the business number dialled — incoming only),
 * caller / callerPhone (the client on incoming; the business number shown on outgoing), target (the party
 * dialled on outgoing). `record`, `aiData`, `IVR`, representative and dialer fields are DROPPED here.
 *
 * AUTHENTICATION: Voicenter documents NONE for the CDR push (no signature, no secret, no IP list). Dubiz
 * therefore authenticates the URL itself: an unguessable endpoint id + a 256-bit key in the path, stored as a
 * sha256 hash only (the Google / website pattern). Whether Voicenter can add a signature or publish source IPs,
 * its retry schedule, ivruniqueid stability across retries and the DID format are OPEN with Voicenter.
 */
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { callReceipt, canonicalCall, CallInvalid, type CallOutcome } from "./canonical";

export const VOICENTER_SOURCE = "telephony.voicenter" as const;

/** The JSON (or form) CDR body → a flat string map. */
export function readVoicenterCdr(raw: string, contentType: string | null): Record<string, unknown> | null {
  const ct = (contentType ?? "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const UNANSWERED: Record<string, CallOutcome> = {
  NOANSWER: "missed",
  CANCEL: "missed",
  ABANDONE: "missed",
  VOEND: "missed",
  NOTDIALED: "missed",
  NOTCALLED: "missed",
  BUSY: "busy",
  VOICEMAIL: "voicemail",
  CONGESTION: "failed",
  CHANUNAVAIL: "failed",
  INVALIDARGS: "failed",
  SSWPREAUTH: "failed",
  TE: "failed",
};

export type VoicenterParse = { ok: true; receipt: IntakeReceiptDraft } | { ok: true; ignored: string } | { ok: false; code: string };

export function parseVoicenterCdr(cdr: Record<string, unknown>, accountScope: string): VoicenterParse {
  const s = (k: string) => (typeof cdr[k] === "string" || typeof cdr[k] === "number" ? String(cdr[k]).trim() : "");
  const id = s("ivruniqueid");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, code: "call_id" };
  const directionRaw = s("direction").toLowerCase();
  const type = s("type").toLowerCase();
  const direction = directionRaw === "incoming" || (!directionRaw && type.startsWith("incoming"))
    ? "inbound"
    : directionRaw === "outgoing" || (!directionRaw && type.includes("outgoing"))
      ? "outbound"
      : null;
  if (!direction) return { ok: true, ignored: "internal_or_unknown_direction" };
  const status = s("status").toUpperCase();
  const answered = s("isAnswer") === "1" || (s("isAnswer") === "" && status === "ANSWER");
  const outcome: CallOutcome = answered ? "answered" : UNANSWERED[status] ?? "missed";
  const epoch = Number(s("time"));
  if (!Number.isFinite(epoch) || epoch <= 0) return { ok: false, code: "time" };
  const talk = Number(s("actualCallDuration") || s("duration"));
  const counterpart = direction === "inbound" ? s("callerPhone") || s("caller") : s("target");
  const businessLine = direction === "inbound" ? s("did") : s("caller");
  try {
    const call = canonicalCall({
      providerCallId: id,
      direction,
      outcome,
      durationSec: answered && Number.isFinite(talk) ? talk : 0,
      startedAt: new Date(epoch * 1000).toISOString(),
      businessLine,
      // An extension (a few digits) is an internal party, never a person's number.
      counterpartNumber: counterpart.replace(/\D/g, "").length >= 7 ? counterpart : undefined,
    });
    return { ok: true, receipt: callReceipt(call, accountScope) };
  } catch (e) {
    return { ok: false, code: e instanceof CallInvalid ? e.code : "malformed" };
  }
}
