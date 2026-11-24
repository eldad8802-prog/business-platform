/**
 * Estimated cost of usage to Dubiz — for the admin console's "estimated cost" column only (subscriptions stage C).
 * PURE. ESTIMATES, not invoices: unit prices from the providers' public price pages read 2026-11-24 (Cloudflare R2,
 * OpenAI gpt-4.1-mini, Resend, Vercel) and the Google Vision list price as remembered (NOT verified — decision 22:
 * the real invoices replace these before prices are set). USD. Fixed infrastructure is not included.
 */
import type { UsageMetric } from "./usage-metrics";

export const UNIT_COST_ESTIMATE_USD: Readonly<Record<UsageMetric, { perUnit: number; basis: string; verified: boolean }>> = {
  business_documents: { perUnit: 0.0003, basis: "one PDF render on Vercel (estimate)", verified: false },
  document_uploads: { perUnit: 0.0000045, basis: "one R2 write (Class A $4.50 / million)", verified: true },
  ocr_pages: { perUnit: 0.0015, basis: "Google Vision ~$1.50 / 1,000 pages (from memory, NOT verified)", verified: false },
  storage_customer_bytes: { perUnit: 0.015 / 1024 ** 3, basis: "R2 $0.015 / GB-month (per byte, per month)", verified: true },
  accountant_packages: { perUnit: 0.001, basis: "ZIP build compute + R2 (estimate)", verified: false },
  accountant_emails: { perUnit: 0.0009, basis: "Resend $0.90 / 1,000 over the plan", verified: true },
  ai_owner_actions: { perUnit: 0.006, basis: "gpt-4.1-mini, up to 3 calls ~3,100 output tokens (estimate)", verified: false },
  video_renders: { perUnit: 0, basis: "Creatomate price unknown", verified: false },
  ocr_provider_units: { perUnit: 0.0015, basis: "as ocr_pages — the real provider calls", verified: false },
  storage_system_bytes: { perUnit: 0.015 / 1024 ** 3, basis: "R2 $0.015 / GB-month", verified: true },
  ai_internal_calls: { perUnit: 0.006, basis: "gpt-4.1-mini, one call (estimate)", verified: false },
};

/** Pure: estimated USD of these usage amounts. Customer-facing OCR is excluded — the provider units are the real bill. */
export function estimateUsageCostUsd(usage: Partial<Record<UsageMetric, number>>): number {
  let total = 0;
  for (const [metric, amount] of Object.entries(usage) as [UsageMetric, number][]) {
    if (metric === "ocr_pages") continue;
    total += (amount ?? 0) * UNIT_COST_ESTIMATE_USD[metric].perUnit;
  }
  return Math.round(total * 10000) / 10000;
}
