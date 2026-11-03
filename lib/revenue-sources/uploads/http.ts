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
import type { CloseOverlapBasis } from "@/lib/revenue-sources/overlap";
import type { ReportKind } from "./contract";
import { SALES_SOURCE_CHOICES, type ConflictDecision, type ConflictDecisions, type ReportAnswers, type SalesSourceChoice, type ZConfirmation } from "./core";
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
  // D-5: stage one takes summary files only.
  SETTLEMENT_FILE_NOT_SUMMARY:
    "בשלב זה אפשר לקלוט רק דוח זיכויים מסוכם — שורה לכל אצווה או לכל הפקדה, עם הסכום ברוטו, העמלה והסכום נטו. קובץ של פירוט עסקאות או של תשלומים אינו דוח זיכויים: כל עסקה בו כבר נספרה כמכירה, והוא לא מראה כמה הופקד. ייצאו מהמערכת את דוח הזיכויים המסוכם ונסו שוב. לא נקלט דבר.",
  // D-10 / D-11: asked, never defaulted.
  INPUT_REQUIRED: "בחלק מהדוחות לא מודפס יום העסקים או מספר הקופה. בחרו אותם לכל דוח ובדקו את הקובץ שוב. לא נקלט דבר.",
  ANSWERS_INVALID: "התשובות לא מתאימות לקובץ: אפשר להשלים רק יום עסקים או קופה שחסרים בדוח, ביום תקין. בדקו את הקובץ שוב.",
  // D-1 / D-11 interim: selected and confirmed on every upload, never defaulted.
  CONFIRMATION_REQUIRED: "לפני הקליטה צריך לבחור לכל קופה בקובץ איך נרשמות המכירות שלה, ולאשר. לא נקלט דבר.",
  CONFIRMATION_INVALID: "האישור לא מתאים לקובץ: בחרו לכל קופה שבקובץ, ורק לה, איך נרשמות המכירות שלה. בדקו את הקובץ שוב.",
  SALES_SOURCE_NOT_SUPPORTED:
    "סימנתם שהמכירות של קופה בקובץ נרשמות בדרך אחרת (חשבוניות או מערכת אחרת). בשלב זה אי אפשר לקלוט דוח Z של קופה כזו — הוא היה נספר בנוסף למכירות שכבר נרשמו. לא נקלט דבר.",
};

/** D-1 / D-11 interim: the sales-source choices the owner picks from, per register (Hebrew). */
export const SALES_SOURCE_TEXT: Record<SalesSourceChoice, string> = {
  THIS_Z_REPORT: "המכירות של הקופה הזו נרשמות בדוח ה-Z הזה",
  INVOICES_OR_OTHER_SYSTEM: "המכירות של הקופה הזו כבר נרשמות בדרך אחרת (חשבוניות לכל מכירה, או מערכת אחרת)",
};

/** Hebrew text for row codes the owner sees in the preview (codes not listed are shown by the screen's generic text). */
export const REPORT_ROW_CODE_TEXT: Record<string, string> = {
  INSTALLMENT_ROW_NOT_SUPPORTED: "שורה של תשלום (מתוך עסקה בתשלומים) — בשלב זה נקלטים רק סיכומי אצווה או הפקדה.",
  EXTERNAL_ID_RESERVED: "מזהה הזיכוי בדוח בתבנית שמורה לתיקונים, ולכן השורה לא נקלטה.",
};

/** D-2 / D-12 and the duplicate suspicion: what an overlap means for the owner (Hebrew), by its basis. */
export const REPORT_OVERLAP_TEXT: Record<CloseOverlapBasis, string> = {
  Z_DOCUMENT_SAME_DAY:
    "דוח Z של אותו יום כבר נרשם כהכנסה דרך המסמכים (מסמך מאושר). הדוח יישמר, אבל לא ייספר עד שתחליטו מה נכון — כדי שהמכירות לא ייספרו פעמיים.",
  HISTORY_SAME_DAY:
    "לאותו יום יש מסמכים בהיסטוריה שיובאה מהמערכת הקודמת. הדוח יישמר, אבל לא ייספר עד שתחליטו אם מדובר באותן מכירות.",
  AMOUNT_SAME_DAY:
    "באותו יום יש מסמך הכנסה מאושר על אותו סכום בדיוק. זה לא בהכרח אותו דבר — שום דבר לא הוסר ושום דבר לא אוחד. הדוח נספר כרגיל; בדקו אם מדובר באותן מכירות.",
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

/**
 * D-10 / D-11: the owner's answers, `{"<draft index>": {"businessDay": "YYYY-MM-DD", "registerKey": "<token>"}}`.
 * Shape only here; whether each answer fills something the report really left out is checked by core.resolveZDrafts.
 */
export function parseAnswers(raw: FormDataEntryValue | null): ReportAnswers | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RevenueReportError("ANSWERS_INVALID", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RevenueReportError("ANSWERS_INVALID", 400);
  const out: ReportAnswers = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d{1,6}$/.test(k) || !v || typeof v !== "object" || Array.isArray(v)) throw new RevenueReportError("ANSWERS_INVALID", 400);
    const a: { businessDay?: string; registerKey?: string } = {};
    for (const [field, value] of Object.entries(v as Record<string, unknown>)) {
      if ((field !== "businessDay" && field !== "registerKey") || typeof value !== "string" || value.length > 64) {
        throw new RevenueReportError("ANSWERS_INVALID", 400);
      }
      a[field] = value;
    }
    out[Number(k)] = a;
  }
  return out;
}

/**
 * D-1 / D-11 interim: `{"confirmed": true, "registers": {"<registerKey>": "THIS_Z_REPORT" | "INVOICES_OR_OTHER_SYSTEM"}}`.
 * Shape only here; whether it covers exactly the file's registers is checked by core.checkZConfirmation.
 */
export function parseConfirmation(raw: FormDataEntryValue | null): ZConfirmation | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RevenueReportError("CONFIRMATION_INVALID", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RevenueReportError("CONFIRMATION_INVALID", 400);
  const o = parsed as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "confirmed" && k !== "registers") || typeof o.confirmed !== "boolean") throw new RevenueReportError("CONFIRMATION_INVALID", 400);
  const regs = o.registers;
  if (!regs || typeof regs !== "object" || Array.isArray(regs)) throw new RevenueReportError("CONFIRMATION_INVALID", 400);
  const registers: Record<string, SalesSourceChoice> = {};
  const entries = Object.entries(regs as Record<string, unknown>);
  if (entries.length > 64) throw new RevenueReportError("CONFIRMATION_INVALID", 400);
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(k) || typeof v !== "string" || !(SALES_SOURCE_CHOICES as readonly string[]).includes(v)) {
      throw new RevenueReportError("CONFIRMATION_INVALID", 400);
    }
    registers[k] = v as SalesSourceChoice;
  }
  return { confirmed: o.confirmed, registers };
}

/** The multipart body analyze and commit take: file (and token, decisions, answers). Business and user from the actor. */
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
      answers: parseAnswers(form.get("answers")),
      confirmation: parseConfirmation(form.get("confirmation")),
    },
    token: form.get("token"),
    decisions: parseDecisions(form.get("decisions")),
  };
}
