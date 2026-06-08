import { PLATFORM_AUDIT_ACTIONS } from "./constants";
import type { PlatformAuditRowTone } from "./platform-audit-list.types";

const ACTION_LABELS: Record<string, string> = {
  [PLATFORM_AUDIT_ACTIONS.OVERVIEW_VIEWED]: "צפייה בלוח בקרה",
  [PLATFORM_AUDIT_ACTIONS.BUSINESSES_LIST_VIEWED]: "צפייה ברשימת עסקים",
  [PLATFORM_AUDIT_ACTIONS.ATTENTION_VIEWED]: "צפייה בפיד תשומת לב",
  [PLATFORM_AUDIT_ACTIONS.USAGE_OVERVIEW_VIEWED]: "צפייה בתובנות שימוש",
  [PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED]: "צפייה בפרטי עסק",
  [PLATFORM_AUDIT_ACTIONS.AUDIT_VIEWED]: "צפייה ביומן ביקורת",
  [PLATFORM_AUDIT_ACTIONS.AREA_ENTERED]: "כניסה לאזור Platform Admin",
  [PLATFORM_AUDIT_ACTIONS.SESSION_VIEWED]: "גישה ל-Platform Admin",
  [PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED]: "עדכון גישת פיצ'ר לעסק",
  [PLATFORM_AUDIT_ACTIONS.BUSINESS_ARCHIVED]: "ארכוב עסק",
  [PLATFORM_AUDIT_ACTIONS.BUSINESS_UNARCHIVED]: "ביטול ארכוב עסק",
};

const SENSITIVE_ACTIONS = new Set<string>([
  PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED,
]);

const WARNING_ACTIONS = new Set<string>([
  PLATFORM_AUDIT_ACTIONS.BUSINESS_ARCHIVED,
  PLATFORM_AUDIT_ACTIONS.BUSINESS_UNARCHIVED,
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
