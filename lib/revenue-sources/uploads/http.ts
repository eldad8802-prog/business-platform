/**
 * The HTTP edge of revenue report uploads. SERVER-ONLY. docs/revenue-report-uploads.md.
 *
 *   - authenticated owner only (401); the business and the user come from the session, never from the request;
 *   - per kind, its flag (`z_report_upload` / `settlement_report_upload`): OFF ⇒ 404, as if the route did not exist;
 *     the flag is resolved fail-closed (an error reads as OFF);
 *   - RevenueReportError ⇒ its status + a stable code + a Hebrew message; anything else ⇒ 500 with no detail;
 *   - every response is `private, no-store`.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";
import type { ReportKind } from "./contract";
import type { ConflictDecision, ConflictDecisions } from "./core";
import { RevenueReportError, type RevenueReportErrorCode, type RevenueReportInput } from "./service";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export const REPORT_FEATURE_KEY = {
  z: PLATFORM_FEATURE_KEYS.Z_REPORT_UPLOAD,
  settlement: PLATFORM_FEATURE_KEYS.SETTLEMENT_REPORT_UPLOAD,
} as const;

export type ReportUploadState = "ON" | "OFF" | "UNKNOWN";
export type ReportActor = { businessId: number; userId: number };

/** ON / OFF / UNKNOWN (the resolution failed) for one kind. The uploads screen shows a link only for ON. */
export async function revenueReportUploadState(businessId: number, kind: ReportKind): Promise<ReportUploadState> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, REPORT_FEATURE_KEY[kind]));
    return r.allowed === true ? "ON" : "OFF";
  } catch {
    return "UNKNOWN";
  }
}

/** Fail-closed: anything but a resolved ON is OFF. */
export async function revenueReportUploadEnabled(businessId: number, kind: ReportKind): Promise<boolean> {
  return (await revenueReportUploadState(businessId, kind)) === "ON";
}

/** Hebrew text per error code (the screens show it as is). */
export const REPORT_ERROR_TEXT: Record<RevenueReportErrorCode, string> = {
  FILE_UNREADABLE: "לא הצלחנו לקרוא את הקובץ. בדקו שזה הקובץ שהמערכת מייצאת, בלי שינויים, ונסו שוב.",
  FORMAT_NOT_SUPPORTED: "עדיין לא תומכים בקובץ מהמערכת הזו. שלחו לנו דוגמה של הקובץ, ונוסיף תמיכה בו. בינתיים לא נקלט דבר.",
  FORMAT_AMBIGUOUS: "לא הצלחנו לקבוע מאיזו מערכת הקובץ. שלחו לנו דוגמה של הקובץ ונבדוק. לא נקלט דבר.",
  NO_REPORTS: "לא נמצאו בקובץ דוחות לקליטה.",
  TOO_MANY_REPORTS: "בקובץ יותר מדי דוחות. פצלו אותו לתקופות קצרות יותר.",
  TOKEN_INVALID: "הבדיקה פגה או לא תקפה. בדקו את הקובץ שוב לפני הקליטה.",
  FILE_CHANGED: "הקובץ השתנה מאז הבדיקה. בדקו את הקובץ שוב לפני הקליטה.",
  DECISIONS_REQUIRED: "יש דוחות שסותרים דוח שכבר נקלט ועדיין לא החלטתם עליהם. בחרו לכל אחד מה לעשות.",
  DECISIONS_INVALID: "מאז הבדיקה השתנה מה שכבר נקלט. בדקו את הקובץ שוב.",
  STATE_CHANGED: "מאז הבדיקה השתנה מה שכבר נקלט. בדקו את הקובץ שוב.",
};

export function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function reportError(e: unknown): Response {
  if (e instanceof RevenueReportError) {
    return NextResponse.json(
      { error: e.code, message: REPORT_ERROR_TEXT[e.code], ...(Object.keys(e.detail).length ? { details: e.detail } : {}) },
      { status: e.status, headers: NO_STORE }
    );
  }
  console.error("[revenue-report-upload] unexpected error", e instanceof Error ? e.name : "unknown");
  return NextResponse.json({ error: "INTERNAL", message: "משהו השתבש. נסו שוב." }, { status: 500, headers: NO_STORE });
}

/** Session ⇒ 401; the kind's flag OFF ⇒ 404; then the handler under the session business's tenant context. */
export async function reportRoute(
  req: Request,
  kinds: readonly ReportKind[],
  handler: (actor: ReportActor, enabled: ReportKind[]) => Promise<Response>
): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    const businessId = user.businessId;
    const states = await Promise.all(kinds.map((k) => revenueReportUploadEnabled(businessId, k)));
    const enabled = kinds.filter((_, i) => states[i]);
    if (enabled.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    return await runWithTenantContext({ businessId }, () => handler({ businessId, userId: user.id }, enabled));
  } catch (e) {
    return reportError(e);
  }
}

const DECISIONS: readonly ConflictDecision[] = ["SKIP", "SUPERSEDE", "ADD"];

export function parseDecisions(raw: FormDataEntryValue | null): ConflictDecisions | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RevenueReportError("DECISIONS_INVALID", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RevenueReportError("DECISIONS_INVALID", 400);
  const out: ConflictDecisions = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // A preview row index: digits only, and one of the three decisions.
    if (!/^\d{1,6}$/.test(k) || typeof v !== "string" || !(DECISIONS as readonly string[]).includes(v)) {
      throw new RevenueReportError("DECISIONS_INVALID", 400);
    }
    out[Number(k)] = v as ConflictDecision;
  }
  return out;
}

/** The multipart body analyze and commit take: file (and token, decisions). Business and user from the actor. */
export async function readReportForm(
  req: Request,
  actor: ReportActor,
  kind: ReportKind
): Promise<{ input: RevenueReportInput; token: FormDataEntryValue | null; decisions: ConflictDecisions | null }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new RevenueReportError("FILE_UNREADABLE", 400, { reason: "INVALID_BODY" });
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new RevenueReportError("FILE_UNREADABLE", 400, { reason: "FILE_MISSING" });
  // Declared size first (cheap), then the actual bytes: `file.size` is client-reported.
  if (typeof file.size === "number" && file.size > IMPORT_MAX_FILE_BYTES) {
    throw new RevenueReportError("FILE_UNREADABLE", 413, { reason: "FILE_TOO_LARGE" });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > IMPORT_MAX_FILE_BYTES) throw new RevenueReportError("FILE_UNREADABLE", 413, { reason: "FILE_TOO_LARGE" });
  return {
    input: {
      businessId: actor.businessId,
      userId: actor.userId,
      kind,
      filename: (file.name || "upload").slice(0, 200),
      bytes,
      mime: typeof file.type === "string" && file.type ? file.type.slice(0, 100) : null,
    },
    token: form.get("token"),
    decisions: parseDecisions(form.get("decisions")),
  };
}
