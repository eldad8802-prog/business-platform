/**
 * Configuration + URL builder for the ITA InvoiceDecisionApi HTTP client.
 *
 * Deliberately SEPARATE from the Approval config/URL: the decision endpoints use
 * a different base segment (`InvoiceDecisionApi`) and a different version (`v1`)
 * than Approval (`/Invoices/v2/Approval`). No I/O, no env, no DB, no network.
 * Nothing hardcoded except the contract-fixed path shape.
 *
 * PATH PROVENANCE (verbatim from the official contract): the decision endpoints
 * are published as
 *   https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Cancel
 *   https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Continue
 *   https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/FurtherObjection
 * — "Israel Invoice Model API Description" v2.0 (7/2024), §4.2 (see
 * docs/compliance/tax-authority/invoice-decision-contract-evidence-v1.md).
 * The earlier `Invoice-decision` segment was NOT the published route and is
 * corrected here to `InvoiceDecisionApi`.
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

/** Contract-fixed version for the decision endpoints (v2.0/7.2024, §4.2). */
export const INVOICE_DECISION_API_VERSION = "v1" as const;

/**
 * Contract-fixed base path segment for the decision endpoints (v2.0/7.2024,
 * §4.2). Verbatim from the published route: `InvoiceDecisionApi`.
 */
export const INVOICE_DECISION_PATH_SEGMENT = "InvoiceDecisionApi" as const;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds `{apiBaseUrl}/InvoiceDecisionApi/{apiVersion}/{Action}` (no hardcoding
 * of host/version). `apiBaseUrl` already carries the single `shaam/{env}`
 * segment (resolved by the caller); this builder never adds its own `/shaam`.
 */
export function buildInvoiceDecisionUrl(
  config: Pick<AuthorityDecisionConfig, "apiBaseUrl" | "apiVersion">,
  action: InvoiceDecisionAction
): string {
  const base = trimTrailingSlashes(config.apiBaseUrl.trim());
  const version = config.apiVersion.trim().replace(/^\/+|\/+$/g, "");
  return `${base}/${INVOICE_DECISION_PATH_SEGMENT}/${version}/${action}`;
}
