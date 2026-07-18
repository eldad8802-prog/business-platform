/**
 * Configuration + URL builder for the ITA Invoice-decision HTTP client.
 *
 * Deliberately SEPARATE from the Approval config/URL: the decision endpoints use
 * a different base segment (`Invoice-decision`, singular, hyphenated) and a
 * different version (`v1`) than Approval (`/Invoices/v2/Approval`). No I/O, no
 * env, no DB, no network. Nothing hardcoded except the contract-fixed path shape.
 */

import type { InvoiceDecisionAction } from "@/lib/services/billing/authority/billing-authority-decision.types";

export type AuthorityDecisionConfig = {
  /** Full API base incl. the shaam/{env} segment (resolved by the caller). */
  apiBaseUrl: string;
  /** Path version segment for decisions. Contract value: `v1`. */
  apiVersion: string;
  /** Request timeout (ms). Supplied by config. */
  timeoutMs: number;
};

/** Contract-fixed version for the decision endpoints (2.0/7.2024, §4). */
export const INVOICE_DECISION_API_VERSION = "v1" as const;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Builds `{apiBaseUrl}/Invoice-decision/{apiVersion}/{Action}` (no hardcoding of host/version). */
export function buildInvoiceDecisionUrl(
  config: Pick<AuthorityDecisionConfig, "apiBaseUrl" | "apiVersion">,
  action: InvoiceDecisionAction
): string {
  const base = trimTrailingSlashes(config.apiBaseUrl.trim());
  const version = config.apiVersion.trim().replace(/^\/+|\/+$/g, "");
  return `${base}/Invoice-decision/${version}/${action}`;
}
