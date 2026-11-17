/**
 * Legal identity corrections — the approver's ACTIONS (owner decision 2026-11-13): approve, reject, request more
 * information. Called only from the platform-admin routes, AFTER the platform-admin
 * guard, the dedicated approver check and (for decisions) a fresh MFA step-up.
 *
 * Every action runs in the TARGET business's own tenant transaction on the runtime — the same pattern as the manual
 * payment-reversal resolution — and the database decides: legal_identity_correction_decide / _request_info re-check,
 * under the business's advisory lock and FOR UPDATE, that the approver holds a "LegalIdentityApprover" row, is a
 * platform admin, is neither the requester nor a user of that business, that the request is still PENDING, that the
 * profile still holds the snapshot the request was made against (else STALE: nothing applied), that the business is
 * not being deleted, that the change stays within the same legal entity, and that the business has no live issuer
 * declaration (else DECLARATION_ACTIVE: its identity lock stands, nothing applied, the request stays open). Approving updates the profile as the
 * table owner in that one transaction; issued documents are never touched (they keep their own frozen snapshot).
 *
 * Lives outside lib/services/platform-admin on purpose: that folder must not touch the tenant runtime (CI-4).
 * Values never reach a log; results carry codes only.
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";

export type DecideOutcome =
  | "APPLIED"
  | "REJECTED"
  | "STALE"
  | "NOT_PENDING"
  | "NOT_FOUND"
  | "NOT_ALLOWED"
  | "NOTE_REQUIRED"
  /** The business has a live issuer declaration: its identity lock stands, nothing is applied, the request stays open. */
  | "DECLARATION_ACTIVE";
export type RequestInfoOutcome = "REQUESTED" | "NOT_PENDING" | "NOT_FOUND" | "NOT_ALLOWED" | "NOTE_REQUIRED";

const DECIDE: readonly DecideOutcome[] = ["APPLIED", "REJECTED", "STALE", "NOT_PENDING", "NOT_FOUND", "NOT_ALLOWED", "NOTE_REQUIRED", "DECLARATION_ACTIVE"];
const REQUEST_INFO: readonly RequestInfoOutcome[] = ["REQUESTED", "NOT_PENDING", "NOT_FOUND", "NOT_ALLOWED", "NOTE_REQUIRED"];

export const PUBLIC_NOTE_MIN = 5;
export const PUBLIC_NOTE_MAX = 1000;
export const INTERNAL_NOTE_MIN = 5;
export const INTERNAL_NOTE_MAX = 2000;

/** HTTP status for each outcome (the route answers it). */
export function statusForOutcome(outcome: DecideOutcome | RequestInfoOutcome): number {
  switch (outcome) {
    case "APPLIED":
    case "REJECTED":
    case "REQUESTED":
      return 200;
    case "STALE":
    case "NOT_PENDING":
    case "DECLARATION_ACTIVE":
      return 409;
    case "NOT_FOUND":
      return 404;
    case "NOT_ALLOWED":
      return 403;
    case "NOTE_REQUIRED":
      return 400;
  }
}

/** The note rules, checked before the database (which checks them again). Returns the trimmed notes or null. */
export function normalizeDecisionNotes(input: { publicNote: unknown; internalNote: unknown }):
  | { publicNote: string; internalNote: string }
  | null {
  const pub = typeof input.publicNote === "string" ? input.publicNote.trim() : "";
  const int = typeof input.internalNote === "string" ? input.internalNote.trim() : "";
  if (pub.length < PUBLIC_NOTE_MIN || pub.length > PUBLIC_NOTE_MAX) return null;
  if (int.length < INTERNAL_NOTE_MIN || int.length > INTERNAL_NOTE_MAX) return null;
  return { publicNote: pub, internalNote: int };
}

export function normalizeInfoNote(note: unknown): string | null {
  const n = typeof note === "string" ? note.trim() : "";
  return n.length >= PUBLIC_NOTE_MIN && n.length <= PUBLIC_NOTE_MAX ? n : null;
}

export type CorrectionAdminDeps = {
  /** Runs `fn` in the business's tenant transaction (tenantTx in production). */
  inTenant: <T>(businessId: number, fn: (tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }) => Promise<T>) => Promise<T>;
};

const defaultDeps: CorrectionAdminDeps = {
  inTenant: (businessId, fn) => tenantTx(businessId, (tx) => fn(tx as never)),
};

/** Approve or reject. `approverUserId` is the guarded session admin; `businessId` comes from the admin read plane. */
export async function decideCorrection(
  input: { businessId: number; requestId: number; approverUserId: number; approve: boolean; publicNote: string; internalNote: string },
  deps: CorrectionAdminDeps = defaultDeps
): Promise<DecideOutcome> {
  const rows = (await deps.inTenant(input.businessId, (tx) =>
    tx.$queryRaw`SELECT public.legal_identity_correction_decide(
      ${input.requestId}::integer, ${input.approverUserId}::integer, ${input.approve}::boolean,
      ${input.publicNote}::text, ${input.internalNote}::text) AS r`
  )) as { r: string }[];
  const r = rows[0]?.r;
  return (DECIDE as readonly string[]).includes(r ?? "") ? (r as DecideOutcome) : "NOT_ALLOWED";
}

/** Return the request to the business for more information; it stays open (PENDING). */
export async function requestCorrectionInfo(
  input: { businessId: number; requestId: number; approverUserId: number; note: string },
  deps: CorrectionAdminDeps = defaultDeps
): Promise<RequestInfoOutcome> {
  const rows = (await deps.inTenant(input.businessId, (tx) =>
    tx.$queryRaw`SELECT public.legal_identity_correction_request_info(
      ${input.requestId}::integer, ${input.approverUserId}::integer, ${input.note}::text) AS r`
  )) as { r: string }[];
  const r = rows[0]?.r;
  return (REQUEST_INFO as readonly string[]).includes(r ?? "") ? (r as RequestInfoOutcome) : "NOT_ALLOWED";
}
