/**
 * Service Desk 1.3b-C — the intake screen's pure logic (no React, no fetch): which section is current, the history lines,
 * the photo downscale target, and whether a drawn signature is plausible. The server decides what is allowed
 * (IntakeView.allowed); this module only orders and words it.
 */
import type { IntakeView } from "./intake-client";

/** Photos leave the phone at most this long edge, as JPEG — under the server's 4 MB request cap with a wide margin. */
export const PHOTO_MAX_EDGE = 1600;
export const PHOTO_JPEG_QUALITY = 0.85;

export function downscaleTarget(width: number, height: number, maxEdge = PHOTO_MAX_EDGE): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export type IntakeSection = "data" | "photos" | "terms" | "sign" | "done";

/** The section to open first: the earliest one still needing work, from the server's facts. */
export function currentSection(v: Pick<IntakeView, "intake" | "terms" | "allowed">): IntakeSection {
  if (v.intake?.signed) return "done";
  if (!v.intake || !v.intake.conditionRecorded || !v.intake.accessoriesRecorded) return "data";
  if (!v.terms) return "terms";
  return "sign";
}

/** Why signing is not possible right now, in the owner's words — or null when the server allows it. */
export function signBlocker(v: Pick<IntakeView, "intake" | "terms" | "activeTerms" | "allowed">): string | null {
  if (v.allowed.sign) return null;
  if (v.intake?.signed) return "הקליטה כבר נחתמה.";
  if (!v.terms && !v.activeTerms.approved) return "אין עדיין נוסח תנאים שאושר משפטית — אי אפשר להחתים לקוח. המנגנון מוכן, ההחתמה תיפתח לאחר אישור הנוסח.";
  if (!v.intake || !v.intake.conditionRecorded || !v.intake.accessoriesRecorded) return "קודם מלאו ושמרו את מצב המכשיר והאביזרים.";
  if (!v.terms) return "קודם הציגו ללקוח את תנאי השירות.";
  return "ההחתמה לא זמינה במצב הנוכחי של התיק.";
}

const STEP_TEXT: Record<string, string> = {
  TERMS_PRESENTED: "התנאים הוצגו ללקוח",
  PHOTO_ADDED: "נוספה תמונה",
  SIGNED: "הלקוח חתם",
  SLIP_STORED: "נשמר טופס הקליטה (PDF)",
};

export function historyLine(step: string | null): string {
  return (step && STEP_TEXT[step]) ?? "עודכנו פרטי הקליטה";
}

/** "dd.mm.yyyy hh:mm" in Israel time. */
export function israelDateTime(isoText: string): string {
  const d = new Date(isoText);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** A signature is plausible when the customer drew at least one real stroke (not a tap): enough points and extent. */
export function signatureLooksDrawn(strokes: { x: number; y: number }[][]): boolean {
  const points = strokes.flat();
  if (points.length < 8) return false;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return Math.max(...xs) - Math.min(...xs) >= 40 && Math.max(...ys) - Math.min(...ys) >= 8;
}
