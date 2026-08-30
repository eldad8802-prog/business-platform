import {
  LEAD_STATUS_LABELS,
  isClosedLeadStatus,
  type LeadFollowUpState,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";

/**
 * Presentation helpers shared by the Leads list and card, so a status or a
 * follow-up never renders two different ways on two surfaces.
 *
 * Colors come from the CRM theme variables (`--crm-*`) — never hard-coded hex —
 * so a palette change still flows from the one injection point.
 */

export type BadgeTone = {
  bg: string;
  color: string;
  border: string;
};

const NEUTRAL: BadgeTone = {
  bg: "var(--crm-surface2)",
  color: "var(--crm-muted)",
  border: "var(--crm-line)",
};

const INFO: BadgeTone = {
  bg: "var(--crm-info-bg)",
  color: "var(--crm-info-ink)",
  border: "transparent",
};

const WARNING: BadgeTone = {
  bg: "var(--crm-warning-bg)",
  color: "var(--crm-warning-ink)",
  border: "transparent",
};

const SUCCESS: BadgeTone = {
  bg: "var(--crm-success-bg)",
  color: "var(--crm-success)",
  border: "transparent",
};

const DANGER: BadgeTone = {
  bg: "var(--crm-error-bg)",
  color: "var(--crm-error)",
  border: "transparent",
};

export function leadStatusLabel(status: LeadStatusValue): string {
  return LEAD_STATUS_LABELS[status];
}

/**
 * State is encoded in FORM as well as text: a new lead reads as information, a
 * sent quote as something awaiting an answer, a won lead as settled. Closed
 * statuses go quiet so the queue is dominated by what is still live.
 */
export function leadStatusTone(status: LeadStatusValue): BadgeTone {
  switch (status) {
    case "NEW":
      return INFO;
    case "QUOTED":
      return WARNING;
    case "WON":
      return SUCCESS;
    case "LOST":
    case "DROPPED":
      return NEUTRAL;
    default:
      return NEUTRAL;
  }
}

export function followUpTone(state: LeadFollowUpState): BadgeTone | null {
  switch (state.kind) {
    case "overdue":
      return DANGER;
    case "due_today":
      return WARNING;
    case "scheduled":
      return NEUTRAL;
    case "none":
      return null;
  }
}

/** Human "when did anything last happen here", in Hebrew. */
export function formatLastActivity(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const diffMs = Date.now() - then.getTime();
  if (diffMs < 0) return "עכשיו";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דק׳`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "לפני שעה" : `לפני ${hours} שעות`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "אתמול";
  if (days < 30) return `לפני ${days} ימים`;

  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "לפני חודש" : `לפני ${months} חודשים`;

  const years = Math.floor(months / 12);
  return years === 1 ? "לפני שנה" : `לפני ${years} שנים`;
}

export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(d);
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Jerusalem",
  }).format(d);
}

/** Hebrew label for a stored `sourceChannel` string. Unknown values pass through. */
export function leadSourceLabel(source: string | null): string | null {
  if (!source) return null;
  const known: Record<string, string> = {
    MANUAL: "הוזן ידנית",
    WHATSAPP: "וואטסאפ",
    PHONE: "טלפון",
    EMAIL: "אימייל",
    REFERRAL: "המלצה",
    WEBSITE: "אתר",
    OTHER: "אחר",
  };
  return known[source] ?? source;
}

/** Sources offered in the create form. Free text stays possible via the API. */
export const LEAD_SOURCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "MANUAL", label: "הוזן ידנית" },
  { value: "PHONE", label: "טלפון" },
  { value: "WHATSAPP", label: "וואטסאפ" },
  { value: "REFERRAL", label: "המלצה" },
  { value: "WEBSITE", label: "אתר" },
  { value: "OTHER", label: "אחר" },
];

export function isClosed(status: LeadStatusValue): boolean {
  return isClosedLeadStatus(status);
}
