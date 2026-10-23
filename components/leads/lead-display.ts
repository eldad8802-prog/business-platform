import {
  LEAD_STATUS_LABELS,
  isClosedLeadStatus,
  type LeadFollowUpState,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";
import type { LeadConversationIntelligence } from "@/lib/services/crm/lead-intelligence";
import { intlTag, type Locale } from "@/lib/i18n/config";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

/**
 * Presentation helpers shared by the Leads list and card, so a status or a
 * follow-up never renders two different ways on two surfaces.
 *
 * Colors come from the CRM theme variables (`--crm-*`) — never hard-coded hex —
 * so a palette change still flows from the one injection point.
 *
 * i18n: every text helper takes an optional `t` (or `locale`). Without it the
 * output is the Hebrew it always was — the Hebrew dictionary holds these strings
 * verbatim — so existing callers keep working unchanged.
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

/** Hebrew translator — the default of every text helper below. */
const HE_T: Translator = createTranslator(he);

const LEAD_STATUS_KEYS: Readonly<Record<LeadStatusValue, MessageKey>> = {
  NEW: "customers.leads.status.new",
  OPEN: "customers.leads.status.open",
  QUALIFIED: "customers.leads.status.qualified",
  QUOTED: "customers.leads.status.quoted",
  WON: "customers.leads.status.won",
  LOST: "customers.leads.status.lost",
  DROPPED: "customers.leads.status.dropped",
};

export function leadStatusLabel(status: LeadStatusValue, t?: Translator): string {
  const key = LEAD_STATUS_KEYS[status];
  // A value outside the enum (e.g. a history row cast from a string): same output as before.
  if (!key) return LEAD_STATUS_LABELS[status];
  return (t ?? HE_T)(key);
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

/**
 * Localised twin of `leadFollowUpLabel` (lib/services/crm/lead-core), which stays
 * Hebrew for its server-side callers. Same branches, same output in Hebrew.
 */
export function leadFollowUpText(state: LeadFollowUpState, t: Translator = HE_T): string {
  switch (state.kind) {
    case "none":
      return "";
    case "due_today":
      return t("customers.leads.followUp.dueToday");
    case "overdue":
      return state.overdueDays === 1
        ? t("customers.leads.followUp.overdueOne")
        : t("customers.leads.followUp.overdueMany", { days: state.overdueDays });
    case "scheduled":
      return state.inDays === 1
        ? t("customers.leads.followUp.tomorrow")
        : t("customers.leads.followUp.inDays", { days: state.inDays });
  }
}

/** How long a customer has been waiting ("18 דק׳" / "2 שע׳" / "3 ימים"). */
export function formatWait(minutes: number, t: Translator = HE_T): string {
  if (minutes < 60) return t("customers.leads.wait.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("customers.leads.wait.hours", { count: hours });
  return t("customers.leads.wait.days", { count: Math.floor(hours / 24) });
}

/**
 * Localised twin of `leadIntelligenceHeadline` (lib/services/crm/lead-intelligence):
 * same parts in the same order. `signalLabel` is server-derived text and passes through.
 */
export function leadIntelligenceHeadlineText(
  intelligence: LeadConversationIntelligence | null,
  t: Translator = HE_T
): string | null {
  if (!intelligence) return null;
  const parts: string[] = [];
  if (intelligence.temperatureBucket === "hot") parts.push(t("customers.leads.intelligence.hot"));
  if (intelligence.unansweredInboundCount > 0 && intelligence.waitingMinutes != null) {
    parts.push(
      t("customers.leads.intelligence.waiting", { wait: formatWait(intelligence.waitingMinutes, t) })
    );
  } else if (intelligence.signalLabel) {
    parts.push(intelligence.signalLabel);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Localised twin of `leadIntelligenceDetail`; the situation label is server-derived and passes through. */
export function leadIntelligenceDetailText(
  intelligence: LeadConversationIntelligence | null,
  t: Translator = HE_T
): string | null {
  if (!intelligence) return null;
  if (intelligence.unansweredInboundCount > 1) {
    return t("customers.leads.intelligence.unanswered", {
      count: intelligence.unansweredInboundCount,
    });
  }
  if (intelligence.businessSituation?.label) return intelligence.businessSituation.label;
  return null;
}

/** Human "when did anything last happen here" (Hebrew unless a `t` is passed). */
export function formatLastActivity(iso: string | null, t: Translator = HE_T): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const diffMs = Date.now() - then.getTime();
  if (diffMs < 0) return t("customers.leads.activity.now");

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t("customers.leads.activity.now");
  if (minutes < 60) return t("customers.leads.activity.minutes", { count: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1
      ? t("customers.leads.activity.hourOne")
      : t("customers.leads.activity.hours", { count: hours });
  }

  const days = Math.floor(hours / 24);
  if (days === 1) return t("customers.leads.activity.yesterday");
  if (days < 30) return t("customers.leads.activity.days", { count: days });

  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1
      ? t("customers.leads.activity.monthOne")
      : t("customers.leads.activity.months", { count: months });
  }

  const years = Math.floor(months / 12);
  return years === 1
    ? t("customers.leads.activity.yearOne")
    : t("customers.leads.activity.years", { count: years });
}

export function formatDateTime(iso: string | null, locale: Locale = "he"): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(intlTag(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  }).format(d);
}

export function formatDate(iso: string | null, locale: Locale = "he"): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(intlTag(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Jerusalem",
  }).format(d);
}

const LEAD_SOURCE_KEYS: Readonly<Record<string, MessageKey>> = {
  MANUAL: "customers.leads.sources.manual",
  WHATSAPP: "customers.leads.sources.whatsapp",
  PHONE: "customers.leads.sources.phone",
  EMAIL: "customers.leads.sources.email",
  REFERRAL: "customers.leads.sources.referral",
  WEBSITE: "customers.leads.sources.website",
  OTHER: "customers.leads.sources.other",
  // Business Intake sources (sourceChannel "intake:<sourceKey>").
  "intake:whatsapp": "customers.leads.sources.whatsapp",
  "intake:meta.lead_ads": "customers.leads.sources.metaLeadAds",
  "intake:google.lead_form": "customers.leads.sources.googleLeadForm",
  "intake:web.form": "customers.leads.sources.webForm",
};

/** Label for a stored `sourceChannel` string (Hebrew unless a `t` is passed). Unknown values pass through. */
export function leadSourceLabel(source: string | null, t: Translator = HE_T): string | null {
  if (!source) return null;
  const key = Object.prototype.hasOwnProperty.call(LEAD_SOURCE_KEYS, source)
    ? LEAD_SOURCE_KEYS[source]
    : undefined;
  return key ? t(key) : source;
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

/** The same options as `LEAD_SOURCE_OPTIONS`, as dictionary keys (resolve with `t()` at render). */
export const LEAD_SOURCE_OPTION_KEYS: ReadonlyArray<{ value: string; labelKey: MessageKey }> = [
  { value: "MANUAL", labelKey: "customers.leads.sources.manual" },
  { value: "PHONE", labelKey: "customers.leads.sources.phone" },
  { value: "WHATSAPP", labelKey: "customers.leads.sources.whatsapp" },
  { value: "REFERRAL", labelKey: "customers.leads.sources.referral" },
  { value: "WEBSITE", labelKey: "customers.leads.sources.website" },
  { value: "OTHER", labelKey: "customers.leads.sources.other" },
];

export function isClosed(status: LeadStatusValue): boolean {
  return isClosedLeadStatus(status);
}
