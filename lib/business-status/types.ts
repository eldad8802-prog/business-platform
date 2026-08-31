/**
 * Business Status MVP v1 — read-only contract.
 */

export type BusinessStatusDomain =
  | "inbox"
  | "documents"
  | "inventory"
  | "billing"
  | "supplier"
  | "leads";

/** Semantic taxonomy subset used in MVP */
export type SemanticCategory =
  | "ACTION_REQUIRED"
  | "ALERT"
  | "WARNING"
  | "FAILURE_EVENT";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type BusinessStatusItemState = "open";

export type PrimaryAction = {
  kind: "navigate";
  label: string;
  href: string;
};

export type EntityRef = {
  type: string;
  id: number;
};

export type RelatedRef = {
  type: string;
  id: number;
};

export type MoneyImpactBand = "none" | "low" | "medium" | "high";

/**
 * An action a surface can perform WITHOUT navigating away.
 *
 * Optional and additive: only the leads domain populates it today, and every
 * other domain is unaffected. It exists because a follow-up the owner has
 * already handled should be dismissable from the Attention list itself —
 * making them open the lead just to say "done" is the kind of friction that
 * teaches people to ignore the list.
 */
export type QuickAction = {
  kind: "lead_followup_complete" | "lead_followup_snooze";
  label: string;
  /** The entity the action applies to. */
  leadId: number;
  /** Days to push the follow-up out by. Only for `lead_followup_snooze`. */
  days?: number;
};

export type BusinessStatusItem = {
  itemId: string;
  domain: BusinessStatusDomain;
  semanticCategory: SemanticCategory;
  title: string;
  summary: string | null;
  severity: Severity;
  priorityScore: number;
  entityRef: EntityRef;
  state: BusinessStatusItemState;
  createdAt: string;
  primaryAction: PrimaryAction;
  sourceEngine: string;
  confidence?: number;
  relatedRefs?: RelatedRef[];
  blocking?: boolean;
  moneyImpactBand?: MoneyImpactBand;
  /** Inline actions. Absent for every domain that has none. */
  quickActions?: QuickAction[];
};

/** Single proof-of-understanding insight (paperwork backlog). Optional on snapshot. */
export type PaperworkInsightPayload = {
  title: string;
  explanation: string;
  evidenceLines: [string, string];
  ctaLabel: string;
  ctaHref: string;
};

export type BusinessStatusSnapshot = {
  generatedAt: string;
  businessId: number;
  items: BusinessStatusItem[];
  /** Present only when deterministic rule passes; omitted or null otherwise. */
  paperworkInsight?: PaperworkInsightPayload | null;
};

/**
 * Built by translators; `priorityScore` is filled by the service from
 * `priorityReferenceDate` + severity + blocking.
 */
export type BusinessStatusItemBuild = Omit<BusinessStatusItem, "priorityScore"> & {
  priorityReferenceDate: Date;
};
