/**
 * /api/platform-admin/legal-identity-corrections — the approver's side of legal identity corrections (owner decision
 * 2026-11-13: only a Dubiz admin holding the dedicated permission may view, approve or reject).
 *
 * Every route.ts calls requirePlatformAdminOrResponse FIRST (AST-5) and hands the admin to these handlers, which add:
 *   1. the feature flag (LEGAL_IDENTITY_CORRECTION_ENABLED) — off: 404, exactly like a missing route;
 *   2. the dedicated permission (PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS) — missing: 403 LEGAL_IDENTITY_APPROVER_REQUIRED;
 *   3. for approve / reject / request-info: a FRESH MFA step-up (≤ 5 minutes), whatever the global MFA switch says;
 *   4. the database's own layer (LegalIdentityApprover row, four eyes, same entity, snapshot unchanged).
 * Every read of a request or a document, and every decision attempt, is written to the platform audit log — ids and
 * outcomes only, never a name or a number. Handlers take their dependencies so they are provable without a database.
 */

import { NextResponse } from "next/server";

import { LEGAL_IDENTITY_APPROVER_REQUIRED_CODE } from "@/lib/auth/legal-identity-approver";
import type { PlatformAdminUser } from "@/lib/auth/platform-admin";
import {
  normalizeDecisionNotes,
  normalizeInfoNote,
  statusForOutcome,
  type DecideOutcome,
  type RequestInfoOutcome,
} from "@/lib/services/account/legal-identity-correction-admin.service";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import type {
  CorrectionDetail,
  CorrectionListFilter,
  CorrectionListItem,
} from "@/lib/services/platform-admin/legal-identity-corrections.service";

const noStore = { "Cache-Control": "no-store" };

export type AuditInput = {
  actorUserId: number;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  req: Request;
};

export type CorrectionAdminDeps = {
  enabled: () => boolean;
  isApprover: (admin: PlatformAdminUser) => boolean;
  /** null = fresh step-up present; otherwise the 403 the client answers with a fresh prompt. */
  freshStepUp: (req: Request, userId: number) => NextResponse | null;
  list: (filter: CorrectionListFilter) => Promise<CorrectionListItem[]>;
  detail: (id: number) => Promise<CorrectionDetail | null>;
  attachment: (requestId: number, attachmentId: number) => Promise<{ businessId: number; storageKey: string; mimeType: string } | null>;
  readAttachment: (input: { businessId: number; storageKey: string }) => Promise<{ body: Buffer; contentType: string }>;
  decide: (input: { businessId: number; requestId: number; approverUserId: number; approve: boolean; publicNote: string; internalNote: string }) => Promise<DecideOutcome>;
  requestInfo: (input: { businessId: number; requestId: number; approverUserId: number; note: string }) => Promise<RequestInfoOutcome>;
  audit: (input: AuditInput) => Promise<void>;
};

/** Hebrew messages for the stable codes (shown to the admin). */
export const ADMIN_CORRECTION_MESSAGES: Record<string, string> = {
  LEGAL_IDENTITY_APPROVER_REQUIRED: "אין לך הרשאה לטפל בבקשות לתיקון זהות עסקית.",
  NOT_FOUND: "הבקשה לא נמצאה.",
  NOT_PENDING: "הבקשה כבר הוכרעה או בוטלה, ולא בוצע שינוי.",
  STALE: "פרטי העסק השתנו מאז שהבקשה הוגשה. לא בוצע שינוי, והבקשה סומנה כלא בוצעה.",
  NOT_ALLOWED: "המערכת סירבה לפעולה: אין הרשאת מאשר במסד הנתונים, או שהמאשר קשור לבקשה או לעסק.",
  NOTE_REQUIRED: "חובה לנמק: נימוק לבעל העסק (5–1000 תווים) ונימוק פנימי (5–2000 תווים).",
  INFO_NOTE_REQUIRED: "חובה לפרט מה נדרש מבעל העסק (5–1000 תווים).",
  CONFIRMATION_REQUIRED: "לפני אישור יש לאשר שבדקת את זהות המבקש ואת המסמכים ושמדובר באותה ישות משפטית.",
  INVALID_ID: "מזהה לא תקין.",
  APPLIED: "התיקון אושר ובוצע.",
  REJECTED: "הבקשה נדחתה. פרטי העסק לא השתנו.",
  REQUESTED: "הבקשה הוחזרה לבעל העסק לקבלת מידע נוסף.",
};

/** 200 for a decision taken; otherwise the same body plus error/code, which the console fetch surfaces as is. */
function outcomeResponse(outcome: DecideOutcome | RequestInfoOutcome): NextResponse {
  const status = statusForOutcome(outcome);
  const message = ADMIN_CORRECTION_MESSAGES[outcome] ?? outcome;
  return NextResponse.json(
    status === 200 ? { outcome, message } : { outcome, message, error: message, code: outcome },
    { status, headers: noStore }
  );
}

const notFound = () => NextResponse.json({ error: "Not Found" }, { status: 404, headers: noStore });

function positiveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Flag + dedicated permission. Returns the refusal, or null to go on. */
function gate(admin: PlatformAdminUser, deps: CorrectionAdminDeps): NextResponse | null {
  if (!deps.enabled()) return notFound();
  if (!deps.isApprover(admin)) {
    return NextResponse.json(
      { error: ADMIN_CORRECTION_MESSAGES.LEGAL_IDENTITY_APPROVER_REQUIRED, code: LEGAL_IDENTITY_APPROVER_REQUIRED_CODE },
      { status: 403, headers: noStore }
    );
  }
  return null;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await req.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handleList(req: Request, admin: PlatformAdminUser, deps: CorrectionAdminDeps): Promise<NextResponse> {
  const refused = gate(admin, deps);
  if (refused) return refused;
  const filter: CorrectionListFilter = new URL(req.url).searchParams.get("filter") === "all" ? "ALL" : "OPEN";
  const items = await deps.list(filter);
  await deps.audit({
    actorUserId: admin.id,
    action: PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTIONS_LIST_VIEWED,
    targetType: "LEGAL_IDENTITY_CORRECTION",
    targetId: "list",
    metadata: { filter, count: items.length },
    req,
  });
  return NextResponse.json({ items }, { headers: noStore });
}

export async function handleDetail(req: Request, admin: PlatformAdminUser, rawId: string, deps: CorrectionAdminDeps): Promise<NextResponse> {
  const refused = gate(admin, deps);
  if (refused) return refused;
  const id = positiveId(rawId);
  if (id === null) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.INVALID_ID }, { status: 400, headers: noStore });
  const detail = await deps.detail(id);
  if (!detail) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.NOT_FOUND, code: "NOT_FOUND" }, { status: 404, headers: noStore });
  await deps.audit({
    actorUserId: admin.id,
    action: PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_VIEWED,
    targetType: "LEGAL_IDENTITY_CORRECTION",
    targetId: String(id),
    metadata: { businessId: detail.businessId, status: detail.status },
    req,
  });
  return NextResponse.json({ request: detail }, { headers: noStore });
}

export async function handleAttachment(
  req: Request,
  admin: PlatformAdminUser,
  rawId: string,
  rawAttachmentId: string,
  deps: CorrectionAdminDeps
): Promise<NextResponse> {
  const refused = gate(admin, deps);
  if (refused) return refused;
  const id = positiveId(rawId);
  const attachmentId = positiveId(rawAttachmentId);
  if (id === null || attachmentId === null) {
    return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.INVALID_ID }, { status: 400, headers: noStore });
  }
  const meta = await deps.attachment(id, attachmentId);
  if (!meta) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.NOT_FOUND, code: "NOT_FOUND" }, { status: 404, headers: noStore });
  const file = await deps.readAttachment({ businessId: meta.businessId, storageKey: meta.storageKey });
  await deps.audit({
    actorUserId: admin.id,
    action: PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_ATTACHMENT_VIEWED,
    targetType: "LEGAL_IDENTITY_CORRECTION",
    targetId: String(id),
    metadata: { businessId: meta.businessId, attachmentId },
    req,
  });
  const ext = meta.mimeType === "application/pdf" ? "pdf" : meta.mimeType === "image/png" ? "png" : "jpg";
  return new NextResponse(new Uint8Array(file.body), {
    status: 200,
    headers: {
      "Content-Type": meta.mimeType,
      "Content-Disposition": `attachment; filename="correction-${id}-${attachmentId}.${ext}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

async function auditOutcome(
  req: Request,
  admin: PlatformAdminUser,
  requestId: number,
  businessId: number,
  outcome: DecideOutcome | RequestInfoOutcome,
  deps: CorrectionAdminDeps,
  intent: "APPROVE" | "REJECT" | "REQUEST_INFO"
) {
  const action =
    outcome === "APPLIED"
      ? PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_APPROVED
      : outcome === "REJECTED"
        ? PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REJECTED
        : outcome === "STALE"
          ? PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_STALE
          : outcome === "REQUESTED"
            ? PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_INFO_REQUESTED
            : PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REFUSED;
  await deps.audit({
    actorUserId: admin.id,
    action,
    targetType: "LEGAL_IDENTITY_CORRECTION",
    targetId: String(requestId),
    metadata: { businessId, intent, outcome },
    req,
  });
}

/** POST /[id]/decision — body { approve, publicNote, internalNote, confirmedReview }. */
export async function handleDecision(req: Request, admin: PlatformAdminUser, rawId: string, deps: CorrectionAdminDeps): Promise<NextResponse> {
  const refused = gate(admin, deps);
  if (refused) return refused;
  const stepUp = deps.freshStepUp(req, admin.id);
  if (stepUp) return stepUp;
  const id = positiveId(rawId);
  if (id === null) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.INVALID_ID }, { status: 400, headers: noStore });
  const body = await readBody(req);
  if (typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "approve must be true or false", code: "INVALID_BODY" }, { status: 400, headers: noStore });
  }
  const approve = body.approve;
  const notes = normalizeDecisionNotes({ publicNote: body.publicNote, internalNote: body.internalNote });
  if (!notes) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.NOTE_REQUIRED, code: "NOTE_REQUIRED" }, { status: 400, headers: noStore });
  // Approval is never a default: the approver states they checked the identity, the documents and the entity.
  if (approve && body.confirmedReview !== true) {
    return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.CONFIRMATION_REQUIRED, code: "CONFIRMATION_REQUIRED" }, { status: 400, headers: noStore });
  }
  const detail = await deps.detail(id);
  if (!detail) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.NOT_FOUND, code: "NOT_FOUND" }, { status: 404, headers: noStore });
  const outcome = await deps.decide({
    businessId: detail.businessId,
    requestId: id,
    approverUserId: admin.id,
    approve,
    publicNote: notes.publicNote,
    internalNote: notes.internalNote,
  });
  await auditOutcome(req, admin, id, detail.businessId, outcome, deps, approve ? "APPROVE" : "REJECT");
  return outcomeResponse(outcome);
}

/** POST /[id]/request-info — body { note }. The request stays open; the business sees the note. */
export async function handleRequestInfo(req: Request, admin: PlatformAdminUser, rawId: string, deps: CorrectionAdminDeps): Promise<NextResponse> {
  const refused = gate(admin, deps);
  if (refused) return refused;
  const stepUp = deps.freshStepUp(req, admin.id);
  if (stepUp) return stepUp;
  const id = positiveId(rawId);
  if (id === null) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.INVALID_ID }, { status: 400, headers: noStore });
  const body = await readBody(req);
  const note = normalizeInfoNote(body.note);
  if (!note) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.INFO_NOTE_REQUIRED, code: "NOTE_REQUIRED" }, { status: 400, headers: noStore });
  const detail = await deps.detail(id);
  if (!detail) return NextResponse.json({ error: ADMIN_CORRECTION_MESSAGES.NOT_FOUND, code: "NOT_FOUND" }, { status: 404, headers: noStore });
  const outcome = await deps.requestInfo({ businessId: detail.businessId, requestId: id, approverUserId: admin.id, note });
  await auditOutcome(req, admin, id, detail.businessId, outcome, deps, "REQUEST_INFO");
  return outcomeResponse(outcome);
}
