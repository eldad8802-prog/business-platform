/**
 * Pure logic for the FCM credential check button (Platform Admin → בדיקות מערכת).
 *
 * The button calls the existing route POST /api/platform-admin/notifications/fcm-auth-check through the
 * canonical privileged request path, with Bearer + MFA elevation + step-up. The server keeps every guard: the
 * platform-admin role + allowlist + MFA, and the fail-closed rate limit (3 per admin per 10 min, 20 per day).
 * The server performs ONE token exchange at Google and sends no push.
 *
 * Kept framework-free so it can be unit-tested without a DOM:
 *   - strict response validation: only the four known result classes are accepted, nothing else from the
 *     body is ever copied (no key, token or Google response can reach the UI);
 *   - sanitized error mapping: HTTP status only, never a raw body/headers/stack;
 *   - one request in flight at a time (a double-click sends one request). Nothing is persisted.
 */

import {
  PlatformAdminFetchError,
  type TokenProbeInvocation,
} from "@/lib/platform-admin/fetch-platform-admin";

export const FCM_AUTH_CHECK_RESULTS = [
  "configured",
  "authentication_failed",
  "not_configured",
  "unavailable",
] as const;

export type FcmAuthCheckResultClass = (typeof FCM_AUTH_CHECK_RESULTS)[number];

export type FcmAuthCheckTone = "success" | "attention" | "urgent";

export type FcmAuthCheckView = {
  result: FcmAuthCheckResultClass;
  title: string;
  detail: string;
  tone: FcmAuthCheckTone;
};

export type FcmAuthCheckState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "succeeded"; view: FcmAuthCheckView }
  | { phase: "failed"; routeHttpStatus: number | null; message: string };

const VIEWS: Record<FcmAuthCheckResultClass, Omit<FcmAuthCheckView, "result">> = {
  configured: {
    title: "ההזדהות מול Google הצליחה",
    detail: "השרת קיבל אישור גישה מ-Google. לא נשלחה התראה. הרשאת השליחה עצמה תיבדק בשליחה הראשונה בפיילוט.",
    tone: "success",
  },
  authentication_failed: {
    title: "Google דחתה את ההזדהות",
    detail: "פרטי חשבון השירות שהוגדרו בשרת לא התקבלו. יש לבדוק את המפתח ואת חשבון השירות ב-Google Cloud.",
    tone: "urgent",
  },
  not_configured: {
    title: "פרטי FCM לא הוגדרו בשרת",
    detail: "חסר אחד ממשתני הסביבה של FCM, או שהוא לא בפורמט הנכון.",
    tone: "attention",
  },
  unavailable: {
    title: "לא ניתן היה להגיע ל-Google",
    detail: "הבדיקה לא הושלמה בגלל תקלת רשת או שירות. אפשר לנסות שוב מאוחר יותר.",
    tone: "attention",
  },
};

/** Accepts exactly `{ result: <one of the four classes> }`; anything else → null. Copies nothing else. */
export function parseFcmAuthCheckResult(raw: unknown): FcmAuthCheckResultClass | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).result;
  if (typeof value !== "string") return null;
  return (FCM_AUTH_CHECK_RESULTS as readonly string[]).includes(value)
    ? (value as FcmAuthCheckResultClass)
    : null;
}

export function fcmAuthCheckView(result: FcmAuthCheckResultClass): FcmAuthCheckView {
  return { result, ...VIEWS[result] };
}

/** Sanitized, status-only message. Never includes a raw body/headers/stack. */
export function sanitizeFcmAuthCheckErrorMessage(status: number | null): string {
  switch (status) {
    case 401:
      return "אין הרשאה לבצע את הבדיקה. יש להתחבר מחדש (401).";
    case 403:
      return "הבדיקה זמינה רק למנהל מערכת מורשה אחרי אימות דו-שלבי (403).";
    case 429:
      return "הגעת למגבלת הבדיקות. אפשר עד 3 בדיקות ב-10 דקות (429).";
    case 503:
      return "מנגנון הגבלת הקצב לא זמין, ולכן הבדיקה לא הורצה (503).";
    case 500:
      return "שגיאת שרת בזמן הבדיקה (500).";
    case null:
      return "בקשת הרשת נכשלה בדפדפן (לא התקבלה תגובה מהשרת).";
    default:
      return `הבדיקה נכשלה (${status}).`;
  }
}

/** Runs the check once and maps the outcome to a terminal state. Never throws. */
export async function executeFcmAuthCheck(
  request: () => Promise<TokenProbeInvocation>
): Promise<FcmAuthCheckState> {
  try {
    const { routeHttpStatus, result } = await request();
    const parsed = parseFcmAuthCheckResult(result);
    if (!parsed) {
      return { phase: "failed", routeHttpStatus, message: "התקבלה תשובה במבנה לא צפוי." };
    }
    return { phase: "succeeded", view: fcmAuthCheckView(parsed) };
  } catch (error) {
    if (error instanceof PlatformAdminFetchError) {
      return {
        phase: "failed",
        routeHttpStatus: error.status,
        message: sanitizeFcmAuthCheckErrorMessage(error.status),
      };
    }
    return { phase: "failed", routeHttpStatus: null, message: sanitizeFcmAuthCheckErrorMessage(null) };
  }
}

export type FcmAuthCheckRunner = { run: () => Promise<void>; isRunning: () => boolean };

/**
 * One request in flight at a time: `run()` while a check is running does nothing (a double-click sends one
 * request). After it finishes the admin may run it again; the server's rate limit caps repeats.
 */
export function createFcmAuthCheckRunner(deps: {
  request: () => Promise<TokenProbeInvocation>;
  onState: (state: FcmAuthCheckState) => void;
}): FcmAuthCheckRunner {
  let running = false;
  return {
    isRunning: () => running,
    async run() {
      if (running) return;
      running = true;
      deps.onState({ phase: "running" });
      try {
        deps.onState(await executeFcmAuthCheck(deps.request));
      } finally {
        running = false;
      }
    },
  };
}
