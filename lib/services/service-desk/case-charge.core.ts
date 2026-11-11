/**
 * Service Desk — the case charge and its billing links (migration 20261126090000): the PURE rules of the three owner
 * commands (record a charge, link a billing document, unlink one). No database, no clock. The service
 * (case-charge.service.ts) reads the facts under the case lock and writes what this decides; the database guards
 * re-check every rule that is theirs (seq, reason, role / type, issued receipt, one active link per document).
 *
 * Owner decisions 2026-11-11 carried here:
 *   - no customer signature; the owner confirms, every write is journaled (status-preserving, version bumped);
 *   - NO_CHARGE always has a reason; any change after the first record has a reason (a quote approval excepted — quotes
 *     are not implemented yet, so this module only writes OWNER_ENTERED / NO_CHARGE records);
 *   - a correction after DELIVERED is allowed (a new record; the handover row is never touched);
 *   - CLOSED / CANCELLED are final (the core's TERMINAL_STATUSES): nothing is recorded, linked or unlinked there;
 *   - the journal payload is closed: tokens, numbers, booleans — reasons live in their own columns, never the journal.
 */
import { TERMINAL_STATUSES, type ServiceCaseStatus } from "./contracts";
import type { CaseBillingLink, CaseCharge } from "./case-balance";

export const CHARGE_MODES = ["CHARGEABLE", "NO_CHARGE"] as const;
export type ChargeMode = (typeof CHARGE_MODES)[number];
export const LINK_ROLES = ["CHARGE", "STANDALONE_PAYMENT"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** CHECK ServiceCaseCharge_reason_text / ServiceCaseBillingLink_unlink: 1..1000 characters after trimming. */
export const REASON_MAX = 1000;
/** amountAgorot is an INTEGER column (int4). */
export const AMOUNT_MAX = 2_147_483_647;

export type InputError = { ok: false; field: string };

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** undefined / null / blank → null; a string of 1..1000 characters (code points, as char_length counts) → trimmed; else invalid. */
export function parseReason(v: unknown): { ok: true; reason: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, reason: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  if (t === "") return { ok: true, reason: null };
  return [...t].length <= REASON_MAX ? { ok: true, reason: t } : { ok: false };
}

export type ChargeInput = { mode: ChargeMode; amountAgorot: number | null; reason: string | null };

export function parseChargeInput(body: { mode?: unknown; amountAgorot?: unknown; reason?: unknown }): { ok: true; input: ChargeInput } | InputError {
  if (!CHARGE_MODES.includes(body.mode as ChargeMode)) return { ok: false, field: "mode" };
  const mode = body.mode as ChargeMode;
  let amountAgorot: number | null = null;
  if (mode === "CHARGEABLE") {
    if (!isPositiveInt(body.amountAgorot) || body.amountAgorot > AMOUNT_MAX) return { ok: false, field: "amountAgorot" };
    amountAgorot = body.amountAgorot;
  } else if (body.amountAgorot !== undefined && body.amountAgorot !== null) {
    return { ok: false, field: "amountAgorot" };
  }
  const r = parseReason(body.reason);
  if (!r.ok) return { ok: false, field: "reason" };
  return { ok: true, input: { mode, amountAgorot, reason: r.reason } };
}

export function parseLinkInput(body: { billingDocumentId?: unknown; role?: unknown }): { ok: true; billingDocumentId: number; role: LinkRole } | InputError {
  if (!isPositiveInt(body.billingDocumentId) || body.billingDocumentId > AMOUNT_MAX) return { ok: false, field: "billingDocumentId" };
  if (!LINK_ROLES.includes(body.role as LinkRole)) return { ok: false, field: "role" };
  return { ok: true, billingDocumentId: body.billingDocumentId, role: body.role as LinkRole };
}

export function parseUnlinkInput(body: { billingDocumentId?: unknown; reason?: unknown }): { ok: true; billingDocumentId: number; reason: string } | InputError {
  if (!isPositiveInt(body.billingDocumentId) || body.billingDocumentId > AMOUNT_MAX) return { ok: false, field: "billingDocumentId" };
  const r = parseReason(body.reason);
  if (!r.ok || r.reason === null) return { ok: false, field: "reason" };
  return { ok: true, billingDocumentId: body.billingDocumentId, reason: r.reason };
}

export type ChargeViolation = "TERMINAL_STATUS" | "REASON_REQUIRED" | "NO_CHANGE";

export const isFinalStatus = (s: ServiceCaseStatus) => TERMINAL_STATUSES.includes(s);

/** The previous charge record as the core needs it. */
export type PreviousCharge = { seq: number; mode: ChargeMode; amountAgorot: number | null } | null;

/**
 * May the owner record this charge now? (The check against linked documents — checkChargeChange — runs next, on the
 * facts read in the same transaction.) Returns the record to write: seq, source, and the closed journal payload.
 */
export function decideCharge(status: ServiceCaseStatus, previous: PreviousCharge, next: ChargeInput):
  | { ok: true; seq: number; source: "OWNER_ENTERED" | null; charge: Exclude<CaseCharge, null>; payload: { mode: ChargeMode; amountAgorot: number | null; chargeSeq: number } }
  | { ok: false; violations: ChargeViolation[] } {
  const violations: ChargeViolation[] = [];
  if (isFinalStatus(status)) violations.push("TERMINAL_STATUS");
  if (next.reason === null && (next.mode === "NO_CHARGE" || previous !== null)) violations.push("REASON_REQUIRED");
  if (previous !== null && previous.mode === next.mode && (previous.amountAgorot ?? null) === next.amountAgorot) violations.push("NO_CHANGE");
  if (violations.length > 0) return { ok: false, violations };
  const seq = (previous?.seq ?? 0) + 1;
  const charge: Exclude<CaseCharge, null> = next.mode === "CHARGEABLE" ? { mode: "CHARGEABLE", amountAgorot: next.amountAgorot as number } : { mode: "NO_CHARGE" };
  return { ok: true, seq, source: next.mode === "CHARGEABLE" ? "OWNER_ENTERED" : null, charge, payload: { mode: next.mode, amountAgorot: next.amountAgorot, chargeSeq: seq } };
}

/** A previous ServiceCaseCharge row → the balance's CaseCharge. */
export function currentCharge(previous: PreviousCharge): CaseCharge {
  if (previous === null) return null;
  return previous.mode === "NO_CHARGE" ? { mode: "NO_CHARGE" } : { mode: "CHARGEABLE", amountAgorot: previous.amountAgorot as number };
}

export type LinkViolation = "TERMINAL_STATUS" | "NO_CHARGE_WITH_DOCUMENTS";

/**
 * May the owner link a billing document now? A case marked free of charge takes no document (it would contradict the
 * owner's own decision and leave the balance UNKNOWN / CONFLICT): record a charge first. The document's existence, type
 * and status are the database guard's (read under RLS).
 */
export function decideLink(status: ServiceCaseStatus, charge: CaseCharge): { ok: true } | { ok: false; violations: LinkViolation[] } {
  const violations: LinkViolation[] = [];
  if (isFinalStatus(status)) violations.push("TERMINAL_STATUS");
  if (charge?.mode === "NO_CHARGE") violations.push("NO_CHARGE_WITH_DOCUMENTS");
  return violations.length ? { ok: false, violations } : { ok: true };
}

export function decideUnlink(status: ServiceCaseStatus): { ok: true } | { ok: false; violations: ["TERMINAL_STATUS"] } {
  return isFinalStatus(status) ? { ok: false, violations: ["TERMINAL_STATUS"] } : { ok: true };
}

export type LinkGuardCode = "BILLING_DOCUMENT_NOT_FOUND" | "BILLING_DOCUMENT_ROLE_MISMATCH" | "RECEIPT_NOT_ISSUED" | "BILLING_DOCUMENT_ALREADY_LINKED";

/**
 * A refusal of the link guard (DZU13) or the one-active-link UNIQUE (23505) → a stable code. Another business's document
 * reads exactly like a missing one (the guard reads under RLS and by business). Anything else → null (not ours to name).
 */
export function linkGuardCode(e: unknown): LinkGuardCode | null {
  const text = e instanceof Error ? e.message : String(e);
  if (/SERVICE_BILLING_LINK_RECEIPT_NOT_ISSUED/.test(text)) return "RECEIPT_NOT_ISSUED";
  if (/SERVICE_BILLING_LINK_DOCUMENT\b/.test(text)) return "BILLING_DOCUMENT_NOT_FOUND";
  if (/SERVICE_BILLING_LINK_ROLE\b/.test(text)) return "BILLING_DOCUMENT_ROLE_MISMATCH";
  const code = (e as { code?: string; meta?: { code?: string } })?.meta?.code ?? (e as { code?: string })?.code;
  if (code === "P2002" || code === "23505" || /23505|ServiceCaseBillingLink_one_active_per_document/.test(text)) return "BILLING_DOCUMENT_ALREADY_LINKED";
  return null;
}

/** The journal payload of a link / unlink: the role token and the document id (an id into the business's own records). */
export const linkPayload = (l: CaseBillingLink) => ({ role: l.role, billingDocumentId: l.billingDocumentId });

/*
 * OUT OF SCOPE here: the quote approval's automatic charge (source APPROVED_QUOTE, quoteVersion, written under the
 * quote.approved event) — quotes are not implemented yet (APPROVE_QUOTE is ACTION_NOT_IN_SCOPE in service-case.service).
 * When they are, the approval writes its ServiceCaseCharge record in the same transaction; the guard already demands the
 * approved version's ILS amount, and no reason is required for it.
 */
