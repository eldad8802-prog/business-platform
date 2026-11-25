/**
 * Usage metrics — the closed list of what the central quota mechanism counts (subscriptions stage C, decisions 17–29).
 * PURE, no I/O. The QUOTA values live in the database (PlatformQuotaPolicy, admin-editable without a deploy, seeded
 * with the owner's opening matrix of 2026-11-24 by migration 20261228090000_subscriptions_stage_c); this file only
 * names the metrics, their unit, whether they reset each period, and whether they carry a quota at all.
 *
 *   quota     — limited per plan / trial (a PlatformQuotaPolicy row exists for every tier). Counted for EVERY business;
 *               refused only for a CUSTOMER, only when the metric's mode is ENFORCE, and never for the rights floor.
 *   measured  — counted for cost visibility only (no policy row, never refused): provider calls including retries,
 *               storage the system creates, AI that an approved feature uses internally.
 *
 * Metric names ending in `_bytes` are cumulative (period ALL — never reset); every other metric resets with the
 * subscription period (trial: the whole trial; paid: the current period; otherwise the Israel calendar month). The
 * database applies the same rule (usage_quota_context), so the suffix is a contract, checked by the tests.
 */

export const QUOTA_METRICS = [
  "business_documents",
  "document_uploads",
  "ocr_pages",
  "storage_customer_bytes",
  "accountant_packages",
  "accountant_emails",
  "ai_owner_actions",
  "video_renders",
] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

export const MEASURED_METRICS = [
  /** Every Vision call actually made (retries and fallbacks included) — the provider's bill, not the customer's. */
  "ocr_provider_units",
  /** Bytes the system writes for the business (issued tax-document PDFs, accountant packages, slips). */
  "storage_system_bytes",
  /** AI calls an approved feature makes on its own (landing composer, knowledge, bot drafts). */
  "ai_internal_calls",
] as const;
export type MeasuredMetric = (typeof MEASURED_METRICS)[number];

export type UsageMetric = QuotaMetric | MeasuredMetric;

export const SUBSCRIPTION_TIERS = ["TRIAL", "BASIC", "ADVANCED", "PREMIUM", "FREE_LIMITED"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export type MetricUnit = "document" | "upload" | "page" | "byte" | "package" | "email" | "action" | "render" | "call";

export type MetricDefinition = {
  metric: UsageMetric;
  kind: "quota" | "measured";
  unit: MetricUnit;
  cumulative: boolean;
  /** Hebrew label for the owner's "my usage" and the admin console. */
  label: string;
};

export const METRIC_DEFINITIONS: Readonly<Record<UsageMetric, MetricDefinition>> = {
  business_documents: { metric: "business_documents", kind: "quota", unit: "document", cumulative: false, label: "מסמכים עסקיים חדשים" },
  document_uploads: { metric: "document_uploads", kind: "quota", unit: "upload", cumulative: false, label: "העלאת מסמכים" },
  ocr_pages: { metric: "ocr_pages", kind: "quota", unit: "page", cumulative: false, label: "סריקת עמודים (OCR)" },
  storage_customer_bytes: { metric: "storage_customer_bytes", kind: "quota", unit: "byte", cumulative: true, label: "נפח אחסון" },
  accountant_packages: { metric: "accountant_packages", kind: "quota", unit: "package", cumulative: false, label: "הכנת חבילות לרואה החשבון" },
  accountant_emails: { metric: "accountant_emails", kind: "quota", unit: "email", cumulative: false, label: "שליחת חבילות לרואה החשבון במייל" },
  ai_owner_actions: { metric: "ai_owner_actions", kind: "quota", unit: "action", cumulative: false, label: "פעולות AI" },
  video_renders: { metric: "video_renders", kind: "quota", unit: "render", cumulative: false, label: "סרטוני וידאו" },
  ocr_provider_units: { metric: "ocr_provider_units", kind: "measured", unit: "page", cumulative: false, label: "יחידות סריקה אצל הספק" },
  storage_system_bytes: { metric: "storage_system_bytes", kind: "measured", unit: "byte", cumulative: true, label: "אחסון שנוצר במערכת" },
  ai_internal_calls: { metric: "ai_internal_calls", kind: "measured", unit: "call", cumulative: false, label: "שימוש פנימי ב-AI" },
};

/**
 * The owner's opening matrix (2026-11-24) — the values the migration seeds. Kept here ONLY so tests can prove the seed
 * and the code agree and so the admin console can show "opening value" next to the current one. The live quota is
 * always the database's.
 */
export const OPENING_MATRIX: Readonly<Record<QuotaMetric, Readonly<Record<SubscriptionTier, number>>>> = {
  business_documents: { TRIAL: 50, BASIC: 200, ADVANCED: 600, PREMIUM: 2000, FREE_LIMITED: 0 },
  document_uploads: { TRIAL: 100, BASIC: 200, ADVANCED: 600, PREMIUM: 2000, FREE_LIMITED: 0 },
  ocr_pages: { TRIAL: 150, BASIC: 300, ADVANCED: 1000, PREMIUM: 3000, FREE_LIMITED: 0 },
  storage_customer_bytes: { TRIAL: 1 * 1024 ** 3, BASIC: 5 * 1024 ** 3, ADVANCED: 20 * 1024 ** 3, PREMIUM: 50 * 1024 ** 3, FREE_LIMITED: 0 },
  accountant_packages: { TRIAL: 2, BASIC: 3, ADVANCED: 6, PREMIUM: 12, FREE_LIMITED: 1 },
  accountant_emails: { TRIAL: 3, BASIC: 5, ADVANCED: 20, PREMIUM: 50, FREE_LIMITED: 0 },
  ai_owner_actions: { TRIAL: 0, BASIC: 0, ADVANCED: 0, PREMIUM: 300, FREE_LIMITED: 0 },
  video_renders: { TRIAL: 0, BASIC: 0, ADVANCED: 0, PREMIUM: 0, FREE_LIMITED: 0 },
};

/** The database's own ceiling against a typing slip (PlatformQuotaPolicy_quota CHECK): 1,000,000 units or 1 TiB. */
export function quotaCeiling(metric: string): number {
  return metric.endsWith("_bytes") ? 1024 ** 4 : 1_000_000;
}

export function isQuotaMetric(value: unknown): value is QuotaMetric {
  return typeof value === "string" && (QUOTA_METRICS as readonly string[]).includes(value);
}

export function isUsageMetric(value: unknown): value is UsageMetric {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(METRIC_DEFINITIONS, value);
}

export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && (SUBSCRIPTION_TIERS as readonly string[]).includes(value);
}
