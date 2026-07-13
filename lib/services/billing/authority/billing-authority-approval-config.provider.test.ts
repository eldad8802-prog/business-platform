/**
 * Unit tests for AuthorityApprovalConfigProvider (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-config.provider.test.ts
 *
 * Uses process.env (env.service reads it live). No network/DB.
 */
import { BillingAuthorityEnvironment } from "@prisma/client";
import {
  resolveApprovalConfig,
  APPROVAL_API_VERSION,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "@/lib/services/billing/authority/billing-authority-approval-config.provider";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

process.env.AUTHORITY_OAUTH_BASE_SANDBOX = "https://openapi.taxes.gov.il";
process.env.AUTHORITY_API_BASE_SANDBOX = "https://t-ita-api.taxes.gov.il";
process.env.AUTHORITY_OAUTH_BASE_PRODUCTION = "https://openapi.taxes.gov.il";
process.env.AUTHORITY_API_BASE_PRODUCTION = "https://ita-api.taxes.gov.il";
process.env.BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL = "https://app.dubiz.test";

{
  const r = resolveApprovalConfig({ environment: BillingAuthorityEnvironment.SANDBOX });
  ok("sandbox ok", r.ok && r.config.apiBaseUrl === "https://t-ita-api.taxes.gov.il/shaam/tsandbox", r);
  ok("apiVersion = v2", r.ok && r.config.apiVersion === APPROVAL_API_VERSION && r.config.apiVersion === "v2");
  ok("timeout default", r.ok && r.config.timeoutMs === DEFAULT_APPROVAL_TIMEOUT_MS);
  ok("no scope key in config", r.ok && !("scope" in (r.config as Record<string, unknown>)));
  ok("config has exactly 3 keys", r.ok && JSON.stringify(Object.keys(r.config).sort()) === JSON.stringify(["apiBaseUrl", "apiVersion", "timeoutMs"]));
}

{
  const r = resolveApprovalConfig({ environment: BillingAuthorityEnvironment.PRODUCTION });
  ok("production url", r.ok && r.config.apiBaseUrl === "https://ita-api.taxes.gov.il/shaam/production", r);
}

{
  // Remove SANDBOX config → env.service throws → sanitized ENVIRONMENT_NOT_CONFIGURED.
  delete process.env.AUTHORITY_API_BASE_SANDBOX;
  delete process.env.AUTHORITY_OAUTH_BASE_SANDBOX;
  delete process.env.BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL;
  const r = resolveApprovalConfig({ environment: BillingAuthorityEnvironment.SANDBOX });
  ok("missing env → ENVIRONMENT_NOT_CONFIGURED", !r.ok && r.code === "ENVIRONMENT_NOT_CONFIGURED", r);
  ok("error message leaks no env var names/values", !r.ok && !/AUTHORITY_|taxes\.gov|dubiz\.test/.test(r.message));
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll approval config provider tests passed.");
