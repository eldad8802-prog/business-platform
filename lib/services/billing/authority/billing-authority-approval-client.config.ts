/**
 * Configuration layer for the ITA allocation HTTP client.
 *
 * Nothing here is hardcoded: base URL, API version, timeout, and OAuth scope
 * are all supplied by the caller via `AuthorityApprovalConfig`. This lets
 * Production run against a different host / scope / version without any code
 * change. This module has no I/O, no env access, no DB, no network.
 */

export type AuthorityApprovalConfig = {
  /**
   * Full API base including the shaam/{env} path segment, e.g.
   * `https://t-ita-api.taxes.gov.il/shaam/tsandbox`. Resolved by the caller
   * (never derived here).
   */
  apiBaseUrl: string;
  /** Path version segment, e.g. `v2`. Not hardcoded. */
  apiVersion: string;
  /** Request timeout in milliseconds. Not a magic number — supplied by config. */
  timeoutMs: number;
  /**
   * OAuth scope value. The contract allows `scope` OR `invoices_scope`; the
   * exact value is a deployment decision, so it lives in config, not in code.
   */
  scope: string;
};

/**
 * Resolves the OAuth scope to use for token acquisition. Introduced so the
 * scope is never hardcoded and Production can switch it via configuration
 * alone. Standalone by design — this PR does not wire it into the existing
 * OAuth start flow (out of scope).
 */
export interface AuthorityOAuthScopeProvider {
  resolveScope(): string;
}

export function createAuthorityOAuthScopeProvider(
  config: Pick<AuthorityApprovalConfig, "scope">
): AuthorityOAuthScopeProvider {
  return {
    resolveScope: () => config.scope,
  };
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Builds `{apiBaseUrl}/Invoices/{apiVersion}/Approval` from config (no hardcoding). */
export function buildInvoiceApprovalUrl(
  config: Pick<AuthorityApprovalConfig, "apiBaseUrl" | "apiVersion">
): string {
  const base = trimTrailingSlashes(config.apiBaseUrl.trim());
  const version = config.apiVersion.trim().replace(/^\/+|\/+$/g, "");
  return `${base}/Invoices/${version}/Approval`;
}
