import { PLATFORM_AUDIT_ACTIONS } from "./constants";
import type { PlatformAuditRowTone } from "./platform-audit-list.types";

const ACTION_LABELS: Record<string, string> = {
  [PLATFORM_AUDIT_ACTIONS.OVERVIEW_VIEWED]: "צפייה בלוח בקרה",
  [PLATFORM_AUDIT_ACTIONS.BUSINESSES_LIST_VIEWED]: "צפייה ברשימת עסקים",
  [PLATFORM_AUDIT_ACTIONS.ATTENTION_VIEWED]: "צפייה בפיד תשומת לב",
  [PLATFORM_AUDIT_ACTIONS.USAGE_OVERVIEW_VIEWED]: "צפייה בתובנות שימוש",
  [PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED]: "צפייה בפרטי עסק",
  [PLATFORM_AUDIT_ACTIONS.AUDIT_VIEWED]: "צפייה ביומן ביקורת",
  [PLATFORM_AUDIT_ACTIONS.ACCOUNTANT_OPS_VIEWED]: "צפייה בניטור חבילת רואה החשבון",
  [PLATFORM_AUDIT_ACTIONS.AREA_ENTERED]: "כניסה לאזור Platform Admin",
  [PLATFORM_AUDIT_ACTIONS.SESSION_VIEWED]: "גישה ל-Platform Admin",
  [PLATFORM_AUDIT_ACTIONS.HOME_VIEWED]: "צפייה בסקירה",
  [PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED]: "שינוי גישה לפיצ׳ר",
  [PLATFORM_AUDIT_ACTIONS.PAYMENT_REVERSAL_RESOLVED]: "סגירת החזר תשלום ידנית",
  [PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED]: "אימות נוסף הצליח",
  [PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED]: "אימות נוסף נכשל",
  [PLATFORM_AUDIT_ACTIONS.MFA_ENROLLED]: "אפליקציית אימות הופעלה",
  [PLATFORM_AUDIT_ACTIONS.MFA_REPLACED]: "אפליקציית אימות הוחלפה",
  [PLATFORM_AUDIT_ACTIONS.PASSKEY_REGISTERED]: "מפתח גישה נוסף",
  [PLATFORM_AUDIT_ACTIONS.PASSKEY_REVOKED]: "מפתח גישה הוסר",
};

/** Page views — read-only; everything else changed something or proved a factor. */
const VIEW_ACTIONS = new Set<string>([
  PLATFORM_AUDIT_ACTIONS.OVERVIEW_VIEWED,
  PLATFORM_AUDIT_ACTIONS.BUSINESSES_LIST_VIEWED,
  PLATFORM_AUDIT_ACTIONS.ATTENTION_VIEWED,
  PLATFORM_AUDIT_ACTIONS.USAGE_OVERVIEW_VIEWED,
  PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED,
  PLATFORM_AUDIT_ACTIONS.AUDIT_VIEWED,
  PLATFORM_AUDIT_ACTIONS.ACCOUNTANT_OPS_VIEWED,
  PLATFORM_AUDIT_ACTIONS.SESSION_VIEWED,
  PLATFORM_AUDIT_ACTIONS.HOME_VIEWED,
]);

export function isAuditViewAction(action: string): boolean {
  return VIEW_ACTIONS.has(action);
}

/** Entering the area and proving (or failing) a factor, and managing factors. */
const SECURITY_ACTIONS = new Set<string>([
  PLATFORM_AUDIT_ACTIONS.AREA_ENTERED,
  PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED,
  PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED,
  PLATFORM_AUDIT_ACTIONS.MFA_ENROLLED,
  PLATFORM_AUDIT_ACTIONS.MFA_REPLACED,
  PLATFORM_AUDIT_ACTIONS.PASSKEY_REGISTERED,
  PLATFORM_AUDIT_ACTIONS.PASSKEY_REVOKED,
]);

export type AuditKind = "all" | "changes" | "views" | "security";

/** The action sets a kind filter selects; `changes` is everything else. */
export const AUDIT_KIND_SETS = {
  views: [...VIEW_ACTIONS],
  security: [...SECURITY_ACTIONS],
} as const;

const STATE_LABELS: Record<string, string> = {
  ENABLED: "פעיל",
  DISABLED: "כבוי",
  INHERIT: "ברירת מחדל",
};

const METHOD_LABELS: Record<string, string> = {
  totp: "אפליקציית אימות",
  recovery_code: "קוד שחזור",
  passkey: "מפתח גישה",
  enrollment: "הפעלת אימות",
};

const SENSITIVE_ACTIONS = new Set<string>([
  PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED,
]);

/** Changes with business or security consequence — shown with emphasis. */
const WARNING_ACTIONS = new Set<string>([
  PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED,
  PLATFORM_AUDIT_ACTIONS.PAYMENT_REVERSAL_RESOLVED,
  PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED,
  PLATFORM_AUDIT_ACTIONS.MFA_REPLACED,
  PLATFORM_AUDIT_ACTIONS.PASSKEY_REGISTERED,
  PLATFORM_AUDIT_ACTIONS.PASSKEY_REVOKED,
]);

export function formatAuditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function formatAuditActionTone(action: string): PlatformAuditRowTone {
  if (SENSITIVE_ACTIONS.has(action)) return "sensitive";
  if (WARNING_ACTIONS.has(action)) return "warning";
  return "info";
}

export function shortenUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const trimmed = userAgent.trim();
  if (trimmed.length <= 72) return trimmed;
  return `${trimmed.slice(0, 69)}…`;
}

export function formatAuditTargetDisplay(
  targetType: string | null,
  targetId: string | null
): string | null {
  if (!targetType && !targetId) return null;
  if (targetType === "BUSINESS" && targetId) {
    return `עסק #${targetId}`;
  }
  if (targetType === "SYSTEM") {
    return "מערכת";
  }
  if (targetType && targetId) {
    return `${targetType} · ${targetId}`;
  }
  return targetType ?? targetId;
}

export function formatAuditDetail(
  action: string,
  metadata: unknown
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const meta = metadata as Record<string, unknown>;

  if (action === PLATFORM_AUDIT_ACTIONS.BUSINESSES_LIST_VIEWED) {
    const page = meta.page;
    const total = meta.total;
    if (typeof page === "number" && typeof total === "number") {
      return `עמוד ${page} · ${total} עסקים`;
    }
  }

  if (action === PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED) {
    const key = typeof meta.featureKey === "string" ? meta.featureKey : null;
    const from = typeof meta.oldState === "string" ? STATE_LABELS[meta.oldState] ?? meta.oldState : null;
    const to = typeof meta.newState === "string" ? STATE_LABELS[meta.newState] ?? meta.newState : null;
    const reason = typeof meta.reason === "string" ? meta.reason : null;
    if (key && to) {
      const change = from ? `${from} ← ${to}` : to;
      return `${key}: ${change}${reason ? ` · סיבה: ${reason}` : ""}`;
    }
  }

  if (action === PLATFORM_AUDIT_ACTIONS.PAYMENT_REVERSAL_RESOLVED) {
    const outcome = typeof meta.outcome === "string" ? meta.outcome : null;
    const requestId = meta.requestId;
    if (outcome) {
      return `תוצאה: ${outcome === "REFUNDED" ? "הוחזר" : outcome === "REJECTED" ? "נדחה" : outcome}${
        typeof requestId === "number" || typeof requestId === "string" ? ` · בקשה ${requestId}` : ""
      }`;
    }
  }

  if (
    action === PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED ||
    action === PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED
  ) {
    const method = typeof meta.method === "string" ? METHOD_LABELS[meta.method] ?? meta.method : null;
    if (method) return method;
  }

  if (
    action === PLATFORM_AUDIT_ACTIONS.PASSKEY_REGISTERED ||
    action === PLATFORM_AUDIT_ACTIONS.PASSKEY_REVOKED
  ) {
    if (typeof meta.label === "string") return meta.label;
  }

  if (action === PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED && meta.businessName) {
    return typeof meta.businessName === "string" ? meta.businessName : null;
  }

  const keys = Object.keys(meta);
  if (keys.length === 0) return null;
  if (keys.length === 1 && typeof meta[keys[0]!] === "number") {
    return `${keys[0]}: ${meta[keys[0]!]}`;
  }
  return null;
}

export function formatActorDisplay(input: {
  email: string | null;
  name: string | null;
  id: number | null;
}): string {
  if (input.email) {
    return input.name ? `${input.name} (${input.email})` : input.email;
  }
  if (input.id) return `משתמש #${input.id}`;
  return "מערכת";
}
