/**
 * Guard for the permanent ITA egress (#36423501). Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-egress-permanent-guard.verify.test.ts
 *
 * The Sandbox experiment used a temporary OAuth-only block with one-shot allowances, Preview-only
 * one-shot routes, tickets and run windows. None of that belongs in main: this fails if any of it
 * comes back, and proves an unconfigured egress refuses every authority call before network I/O.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as egress from "@/lib/services/billing/authority/billing-authority-egress";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const FORBIDDEN_EXPORTS = [
  "runWithAuthorityApprovalAllowance",
  "runWithAuthorityRefreshAllowance",
  "assertAuthorityOAuthCodeExchangeOnly",
  "AUTHORITY_EGRESS_OAUTH_ONLY_HOST",
  "AUTHORITY_EGRESS_APPROVAL_HOST",
];
const FORBIDDEN_TEXT = [/ita-sandbox-[a-z-]*oneshot/, /x-oneshot-ticket/, /ONESHOT_TICKET_SHA256/, /runWithAuthority(Approval|Refresh)Allowance/];
const THIS_FILE = "billing-authority-egress-permanent-guard.verify.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && name !== THIS_FILE) out.push(p);
  }
  return out;
}

async function main() {
  const exported = Object.keys(egress);
  for (const name of FORBIDDEN_EXPORTS) ok(`egress module does not export ${name}`, !exported.includes(name));

  const files = [...walk("lib"), ...walk("app")];
  const hits = files.filter((f) => FORBIDDEN_TEXT.some((re) => re.test(readFileSync(f, "utf8"))));
  ok(`no one-shot / allowance code in lib/ or app/ (${files.length} files scanned)`, hits.length === 0, hits);

  const fetchUnconfigured = egress.createAuthorityEgressFetch({ env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" } });
  for (const url of [
    "https://ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval",
    "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token",
  ]) {
    const err = await fetchUnconfigured(url, { method: "POST", body: "{}" }).then(() => null, (e: unknown) => e);
    ok(`unconfigured egress refuses ${new URL(url).pathname} before network I/O`,
      egress.isAuthorityEgressError(err) && err.code === egress.AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED, err);
  }

  if (failed > 0) {
    console.error(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(1);
});
