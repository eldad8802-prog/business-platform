/**
 * /api/business/legal-identity/corrections — the business's correction requests for its locked legal identity
 * (owner decision 2026-11-13). Handlers take their dependencies so they are provable without a database
 * (handlers.test.ts); route.ts and [id]/route.ts bind the real ones.
 *
 *   GET     the confirmed identity, the re-verification this user needs, and the request history.
 *   POST    submit: validated (lib/legal-identity/correction.ts), the requester re-verified, then stored by the
 *           database function. Never applied here — an authorized party decides (not built; owner decision).
 *   DELETE  /[id] — the requester withdraws an open request.
 *
 * OFF unless LEGAL_IDENTITY_CORRECTION_ENABLED=true: every method answers 404 exactly like a missing route.
 * The tenant and the user are the session's; nothing is taken from the body but the requested values.
 */

import { NextResponse } from "next/server";

import {
  CorrectionValidationError,
  normalizeCorrection,
  type NormalizedCorrection,
} from "@/lib/legal-identity/correction";
import {
  CorrectionError,
  type CorrectionState,
  type VerificationMethod,
} from "@/lib/services/account/legal-identity-correction.service";
import {
  AttachmentInputError,
  MAX_CORRECTION_ATTACHMENT_BYTES,
} from "@/lib/services/legal-identity/correction-attachment-storage";

const noStore = { "Cache-Control": "no-store" };

export type CorrectionDeps = {
  enabled: () => boolean;
  auth: (req: Request) => Promise<{ user: { id: number; businessId: number }; sessionId: string | null } | null>;
  rateLimit: (key: string) => Promise<{ allowed: boolean }>;
  readState: (businessId: number, userId: number) => Promise<CorrectionState>;
  verify: (userId: number, sessionId: string | null, password: unknown) => Promise<{ method: VerificationMethod; verifiedAt: Date }>;
  submit: (businessId: number, userId: number, c: NormalizedCorrection, v: { method: VerificationMethod; verifiedAt: Date }) => Promise<number>;
  cancel: (businessId: number, userId: number, id: number) => Promise<"CANCELLED" | "NOT_FOUND" | "NOT_PENDING">;
  upload: (businessId: number, userId: number, requestId: number, file: { mimeType: unknown; body: Buffer }) => Promise<number>;
  download: (businessId: number, requestId: number, attachmentId: number) => Promise<{ body: Buffer; mimeType: string } | null>;
};

/** Hebrew messages for the stable codes. None carries a value. */
export const CORRECTION_MESSAGES: Record<string, string> = {
  IDENTITY_NOT_CONFIRMED: "פרטי העסק עדיין לא אושרו ולכן אינם נעולים. אפשר לעדכן אותם ישירות בפרטי העסק.",
  CORRECTION_ALREADY_OPEN: "כבר קיימת בקשת תיקון פתוחה לעסק. אפשר לבטל אותה ולהגיש בקשה חדשה.",
  PASSWORD_REQUIRED: "כדי להגיש בקשת תיקון יש להזין את הסיסמה של החשבון.",
  WRONG_PASSWORD: "הסיסמה שגויה.",
  SIGN_IN_AGAIN: "כדי להגיש בקשת תיקון יש להתחבר מחדש עם Google ולנסות שוב בתוך 10 דקות.",
  VERIFICATION_STALE: "האימות פג. יש לאמת שוב ולנסות שוב.",
  DIFFERENT_LEGAL_ENTITY: "הבקשה מתארת ישות משפטית אחרת. במקרה כזה יש לפתוח עסק חדש.",
  CORRECTION_KIND_RULE: "בשינוי סוג העסק מספר העוסק נשאר זהה. תיקון המספר מוגש בבקשה נפרדת.",
  CORRECTION_INVALID: "חלק מהפרטים המבוקשים אינם תקינים. יש לבדוק ולנסות שוב.",
  NOT_ALLOWED: "אין הרשאה לפעולה זו.",
  RATE_LIMITED: "נעשו יותר מדי ניסיונות. אפשר לנסות שוב מאוחר יותר.",
  NOT_FOUND: "הבקשה לא נמצאה.",
  NOT_PENDING: "הבקשה כבר אינה פתוחה.",
  ATTACHMENT_LIMIT: "אפשר לצרף עד 5 קבצים לבקשה.",
  ATTACHMENT_INVALID: "הקובץ אינו תקין. אפשר לצרף PDF, JPG או PNG עד 10MB.",
  ATTACHMENT_TOO_LARGE: "הקובץ גדול מדי (עד 10MB).",
  ATTACHMENT_MISSING: "לא נבחר קובץ.",
  ATTACHMENT_RETRY: "הצירוף לא נשמר. אפשר לנסות שוב.",
};

const notFound = () => NextResponse.json({ error: "Not Found" }, { status: 404, headers: noStore });
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
const coded = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ code, error: CORRECTION_MESSAGES[code] ?? code, ...extra }, { status, headers: noStore });

export async function handleGet(req: Request, deps: CorrectionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  const ctx = await deps.auth(req);
  if (!ctx) return unauthorized();
  const state = await deps.readState(ctx.user.businessId, ctx.user.id);
  return NextResponse.json(state, { headers: noStore });
}

export async function handlePost(req: Request, deps: CorrectionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  const ctx = await deps.auth(req);
  if (!ctx) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return coded("CORRECTION_INVALID", 400);
  }
  // A password is checked here: bound the attempts per user before anything else.
  if (!(await deps.rateLimit(`legal-identity-correction:${ctx.user.id}`)).allowed) return coded("RATE_LIMITED", 429);
  try {
    const state = await deps.readState(ctx.user.businessId, ctx.user.id);
    if (!state.identity) return coded("IDENTITY_NOT_CONFIRMED", 409);
    if (state.requests.some((r) => r.status === "PENDING")) return coded("CORRECTION_ALREADY_OPEN", 409);
    let c: NormalizedCorrection;
    try {
      c = normalizeCorrection(state.identity, body);
    } catch (error) {
      if (error instanceof CorrectionValidationError) {
        return NextResponse.json({ code: "CORRECTION_INVALID", field: error.field, error: error.message }, { status: 400, headers: noStore });
      }
      throw error;
    }
    const v = await deps.verify(ctx.user.id, ctx.sessionId, body.password);
    const id = await deps.submit(ctx.user.businessId, ctx.user.id, c, v);
    return NextResponse.json({ id, status: "PENDING", kind: c.kind }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof CorrectionError) return coded(error.code, error.status);
    console.error("LEGAL_IDENTITY_CORRECTION_ERROR:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: noStore });
  }
}

export async function handleDelete(req: Request, rawId: string, deps: CorrectionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  const ctx = await deps.auth(req);
  if (!ctx) return unauthorized();
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return coded("NOT_FOUND", 404);
  const r = await deps.cancel(ctx.user.businessId, ctx.user.id, id);
  if (r === "CANCELLED") return NextResponse.json({ id, status: "CANCELLED" }, { headers: noStore });
  return coded(r, r === "NOT_FOUND" ? 404 : 409);
}

const positiveId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** POST /[id]/attachments — multipart, field "file". The requester only, while the request is PENDING. */
export async function handleUpload(req: Request, rawId: string, deps: CorrectionDeps): Promise<NextResponse> {
  if (!deps.enabled()) return notFound();
  const ctx = await deps.auth(req);
  if (!ctx) return unauthorized();
  const requestId = positiveId(rawId);
  if (requestId === null) return coded("NOT_FOUND", 404);
  if (!(await deps.rateLimit(`legal-identity-attachment:${ctx.user.id}`)).allowed) return coded("RATE_LIMITED", 429);
  // Bounded BEFORE the body is buffered: a declared length over the limit is refused unread.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_CORRECTION_ATTACHMENT_BYTES + 64 * 1024) return coded("ATTACHMENT_TOO_LARGE", 413);
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return coded("ATTACHMENT_INVALID", 400);
  }
  if (!file) return coded("ATTACHMENT_MISSING", 400);
  if (file.size > MAX_CORRECTION_ATTACHMENT_BYTES) return coded("ATTACHMENT_TOO_LARGE", 413);
  try {
    const body = Buffer.from(await file.arrayBuffer());
    const id = await deps.upload(ctx.user.businessId, ctx.user.id, requestId, { mimeType: file.type, body });
    return NextResponse.json({ id }, { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof AttachmentInputError) {
      return NextResponse.json(
        { code: "ATTACHMENT_INVALID", error: error.message },
        { status: error.code === "TOO_LARGE" ? 413 : 400, headers: noStore }
      );
    }
    if (error instanceof CorrectionError) return coded(error.code, error.status);
    console.error("LEGAL_IDENTITY_ATTACHMENT_ERROR:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: noStore });
  }
}

const DOWNLOAD_EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

/** GET /[id]/attachments/[attachmentId] — a file of the session's own business, always downloaded, never rendered. */
export async function handleDownload(req: Request, rawId: string, rawAttachmentId: string, deps: CorrectionDeps): Promise<Response> {
  if (!deps.enabled()) return notFound();
  const ctx = await deps.auth(req);
  if (!ctx) return unauthorized();
  const requestId = positiveId(rawId);
  const attachmentId = positiveId(rawAttachmentId);
  if (requestId === null || attachmentId === null) return coded("NOT_FOUND", 404);
  const file = await deps.download(ctx.user.businessId, requestId, attachmentId);
  if (!file) return coded("NOT_FOUND", 404);
  const ext = DOWNLOAD_EXT[file.mimeType];
  return new Response(new Uint8Array(file.body), {
    status: 200,
    headers: {
      "Content-Type": ext ? file.mimeType : "application/octet-stream",
      "Content-Disposition": `attachment; filename="correction-${requestId}-${attachmentId}.${ext ?? "bin"}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
