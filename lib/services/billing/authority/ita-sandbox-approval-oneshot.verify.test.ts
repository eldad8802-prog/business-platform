/**
 * Approval one-shot verification (run manually, no DB, no network):
 *   npx tsx lib/services/billing/authority/ita-sandbox-approval-oneshot.verify.test.ts
 *
 *   S  egress scope: Approval refused outside the scope; admitted once inside;
 *      a second Approval in the same scope, Decision, validation, refresh and a
 *      non-SANDBOX path stay refused inside it — all before any transport
 *   F  fuses (window / ticket / document pin / env / gateway / endpoint /
 *      document shape / threshold / customer tax id / issuer identity /
 *      connection / token validity / existing submission) → no issue call
 *   P  preflight mode: PREFLIGHT_OK, no issue call, latch not consumed
 *   O  outcome classes from the post-run submission state; one issue per
 *      instance; the issue runs inside the Approval allowance
 *   X  no token or secret in any result
 */

import { createHash } from "node:crypto";
import {
  AUTHORITY_EGRESS_ERROR_CODES,
  createAuthorityEgressFetch,
  isAuthorityEgressError,
  runWithAuthorityApprovalAllowance,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  APPROVAL_ONESHOT_BRANCH,
  APPROVAL_ONESHOT_NOT_AFTER,
  APPROVAL_ONESHOT_NOT_BEFORE,
  APPROVAL_ONESHOT_PRIOR_SUBMISSIONS,
  APPROVAL_ONESHOT_URL,
  resetApprovalOneshotForTests,
  runSandboxApprovalOneshot,
  type ApprovalOneshotDeps,
  type DocumentSnapshot,
} from "@/lib/services/billing/authority/ita-sandbox-approval-oneshot";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const APPROVAL = APPROVAL_ONESHOT_URL;
const TOKEN = "https://openapi.taxes.gov.il/shaam/tsandbox/longtimetoken/oauth2/token";

async function scopeTests() {
  const f = createAuthorityEgressFetch({ env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" } });
  const code = (url: string, body: string) =>
    f(url, { method: "POST", body }).then(() => "RESOLVED", (e) => (isAuthorityEgressError(e) ? e.code : String(e)));
  const BLOCKED = AUTHORITY_EGRESS_ERROR_CODES.OPERATION_BLOCKED;
  const PASSED = AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED; // block passed → config check fails, no socket

  ok("S Approval outside the scope → refused", (await code(APPROVAL, "{}")) === BLOCKED);
  const scope = { approvalUsed: false };
  const inside = await runWithAuthorityApprovalAllowance(async () => [
    await code(APPROVAL, "{}"),
    await code(APPROVAL, "{}"),
    await code("https://ita-api.taxes.gov.il/shaam/tsandbox/InvoiceDecisionApi/v1/Cancel", "{}"),
    await code("https://ita-api.taxes.gov.il/shaam/tsandbox/invoice-information/v1/details", "{}"),
    await code(TOKEN, "grant_type=refresh_token&refresh_token=r"),
    await code("https://ita-api.taxes.gov.il/shaam/production/Invoices/v2/Approval", "{}"),
    await code("https://openapi.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval", "{}"),
  ], scope);
  ok("S first Approval inside the scope passes the block", inside[0] === PASSED, inside[0]);
  ok("S the scope reports that the Approval was admitted", scope.approvalUsed === true);
  ok("S second Approval in the same scope → refused", inside[1] === BLOCKED, inside[1]);
  ok("S Decision inside the scope → refused", inside[2] === BLOCKED, inside[2]);
  ok("S validation inside the scope → refused", inside[3] === BLOCKED, inside[3]);
  ok("S refresh inside the Approval scope → refused", inside[4] === BLOCKED, inside[4]);
  ok("S production Approval path inside the scope → refused", inside[5] === BLOCKED, inside[5]);
  ok("S Approval path on the wrong host inside the scope → refused", inside[6] === BLOCKED, inside[6]);
  ok("S Approval after the scope ended → refused", (await code(APPROVAL, "{}")) === BLOCKED);
  const prod = createAuthorityEgressFetch({ env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" } });
  const prodCode = await runWithAuthorityApprovalAllowance(() => prod(APPROVAL, { method: "POST", body: "{}" }).then(() => "R", (e) => (isAuthorityEgressError(e) ? e.code : "X")));
  ok("S PRODUCTION runtime inside the scope → refused", prodCode === BLOCKED, prodCode);
}

// ── fixtures ──
const TICKET = "a".repeat(63) + "f";
const PIN = {
  documentId: "77",
  ticketSha256: createHash("sha256").update(TICKET).digest("hex"),
  notBefore: new Date(Date.now() - 60_000).toISOString(),
  notAfter: new Date(Date.now() + 3_600_000).toISOString(),
};
const GW = "https://127.0.0.1:44300";
const DOC: DocumentSnapshot = {
  id: 77, businessId: 9, documentType: "TAX_INVOICE", status: "DRAFT", currency: "ILS",
  subtotalAmount: 5000, vatAmount: 900, customerId: 5, lineDescriptions: ["Sandbox test service"],
};
const PROFILE = { billingLegalName: "ITA Sandbox Test 9", billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: "123456782", billingAddress: "Test St 1", billingPhone: "0500000000", billingEmail: "t@example.test" };

const RUN1 = { id: 1, billingDocumentId: 1, status: "SUBMITTED", errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_AUTHENTICATION" };

function harness(env: Record<string, string>, over: Partial<ApprovalOneshotDeps> = {}, afterStatus: { status: string; errorCode: string | null; allocationNumber: string | null } | null = { status: "APPROVED", errorCode: null, allocationNumber: "A123456789" }) {
  let issues = 0;
  let docStatus = "DRAFT";
  const deps: ApprovalOneshotDeps = {
    env, ticket: TICKET, pinned: PIN, gatewayOrigin: GW, mode: "run",
    resolveApprovalUrl: () => APPROVAL,
    loadDocument: async () => ({ ...DOC, status: docStatus }),
    loadCustomer: async () => ({ taxId: "987654321", taxIdType: "AUTHORIZED_DEALER" }),
    loadProfile: async () => PROFILE,
    loadConnection: async () => ({ id: 2, status: "CONNECTED", accessTokenPresent: true, accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000), oauthAuthorizedAt: new Date() }),
    listSubmissions: async () => [{ ...RUN1 }],
    loadSubmission: async () => (issues > 0 && afterStatus ? { ...afterStatus, retryCount: 0 } : null),
    issue: async () => {
      docStatus = "ISSUED";
      return { authority: { status: "approved" } };
    },
    ...over,
  };
  // Count every issue call, default or overridden.
  const innerIssue = deps.issue!;
  deps.issue = async (input) => {
    issues += 1;
    return innerIssue(input);
  };
  return { deps, issues: () => issues };
}

async function withValidEgress<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ita-approval-oneshot-"));
  const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const key = (n: string) => ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${n}.key`]);
  key("ca");
  ossl(["req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=Test CA", "-days", "30", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  key("client");
  ossl(["req", "-new", "-key", "client.key", "-subj", "/CN=client", "-out", "client.csr"]);
  writeFileSync(join(dir, "client.ext"), "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n");
  ossl(["x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "30", "-out", "client.pem", "-extfile", "client.ext"]);
  const pem = (f: string) => Buffer.from(readFileSync(join(dir, f), "utf8")).toString("base64");
  try {
    return await fn({
      VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: APPROVAL_ONESHOT_BRANCH, BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX",
      ITA_EGRESS_PROXY_URL_SANDBOX: GW, ITA_EGRESS_PROXY_CA_SANDBOX: pem("ca.pem"),
      ITA_EGRESS_CLIENT_CERT_SANDBOX: pem("client.pem"), ITA_EGRESS_CLIENT_KEY_SANDBOX: pem("client.key"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function oneshotTests(env: Record<string, string>) {
  const refused = async (name: string, over: Partial<ApprovalOneshotDeps>, fuse: string) => {
    resetApprovalOneshotForTests();
    const h = harness(env, over);
    const r = await runSandboxApprovalOneshot(h.deps);
    ok(`F ${name} → ${fuse}`, r.outcome === "REFUSED_BY_FUSE" && r.fuse === fuse, r.fuse);
    ok(`F ${name}: no issue call`, h.issues() === 0);
  };
  // Before pinning: placeholder window → WINDOW_NOT_SET.
  await refused("placeholder window", { pinned: { ...PIN, notBefore: "__NOT_BEFORE__", notAfter: "__NOT_AFTER__" } }, "WINDOW_NOT_SET");
  // As committed: placeholders → WINDOW_NOT_SET; once pinned at push, a test
  // ticket can never pass (inside the window → TICKET_INVALID, else OUTSIDE_WINDOW).
  const committedFuse = APPROVAL_ONESHOT_NOT_BEFORE.startsWith("__")
    ? "WINDOW_NOT_SET"
    : Date.now() >= Date.parse(APPROVAL_ONESHOT_NOT_BEFORE) && Date.now() <= Date.parse(APPROVAL_ONESHOT_NOT_AFTER)
      ? "TICKET_INVALID"
      : "OUTSIDE_WINDOW";
  await refused("pinned constants (as committed)", { pinned: undefined }, committedFuse);
  await refused("outside window", { now: () => Date.parse(PIN.notAfter) + 1 }, "OUTSIDE_WINDOW");
  await refused("wrong ticket", { ticket: "b".repeat(64) }, "TICKET_INVALID");
  await refused("document not pinned", { pinned: { ...PIN, documentId: "__DOCUMENT_ID__" } }, "DOCUMENT_NOT_PINNED");
  await refused("production deployment", { env: { ...env, VERCEL_ENV: "production" } }, "NOT_PREVIEW");
  await refused("wrong branch", { env: { ...env, VERCEL_GIT_COMMIT_REF: "main" } }, "WRONG_BRANCH");
  await refused("PRODUCTION runtime", { env: { ...env, BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "PRODUCTION" } }, "NOT_SANDBOX");
  await refused("gateway mismatch", { gatewayOrigin: "https://91.223.106.183" }, "GATEWAY_MISMATCH");
  await refused("t-ita-api endpoint", { resolveApprovalUrl: () => "https://t-ita-api.taxes.gov.il/shaam/tsandbox/Invoices/v2/Approval" }, "APPROVAL_URL_UNEXPECTED");
  await refused("production endpoint", { resolveApprovalUrl: () => "https://ita-api.taxes.gov.il/shaam/production/Invoices/v2/Approval" }, "APPROVAL_URL_UNEXPECTED");
  await refused("document missing", { loadDocument: async () => null }, "DOCUMENT_NOT_FOUND");
  await refused("other business", { loadDocument: async () => ({ ...DOC, businessId: 5 }) }, "DOCUMENT_WRONG_BUSINESS");
  await refused("receipt type", { loadDocument: async () => ({ ...DOC, documentType: "RECEIPT" }) }, "DOCUMENT_TYPE:RECEIPT");
  await refused("already issued", { loadDocument: async () => ({ ...DOC, status: "ISSUED" }) }, "DOCUMENT_STATUS:ISSUED");
  await refused("USD", { loadDocument: async () => ({ ...DOC, currency: "USD" }) }, "DOCUMENT_CURRENCY");
  await refused("no VAT", { loadDocument: async () => ({ ...DOC, vatAmount: 0 }) }, "DOCUMENT_NO_VAT");
  await refused("below threshold", { loadDocument: async () => ({ ...DOC, subtotalAmount: 4999.99 }) }, "DOCUMENT_BELOW_THRESHOLD");
  await refused("31-char line", { loadDocument: async () => ({ ...DOC, lineDescriptions: ["x".repeat(31)] }) }, "DOCUMENT_LINES");
  await refused("no customer", { loadDocument: async () => ({ ...DOC, customerId: null }) }, "DOCUMENT_NO_CUSTOMER");
  await refused("private-id customer", { loadCustomer: async () => ({ taxId: "987654321", taxIdType: "PRIVATE_ID" }) }, "CUSTOMER_TAX_ID");
  await refused("non-digit customer id", { loadCustomer: async () => ({ taxId: "98765432X", taxIdType: "LTD_COMPANY" }) }, "CUSTOMER_TAX_ID");
  await refused("incomplete issuer", { loadProfile: async () => ({ ...PROFILE, billingPhone: null }) }, "ISSUER_IDENTITY");
  await refused("exempt-dealer issuer", { loadProfile: async () => ({ ...PROFILE, billingBusinessKind: "EXEMPT_DEALER" }) }, "ISSUER_KIND");
  await refused("non-digit issuer id", { loadProfile: async () => ({ ...PROFILE, billingTaxId: "12-345" }) }, "ISSUER_IDENTITY");
  await refused("other connection", { loadConnection: async () => ({ id: 1, status: "CONNECTED", accessTokenPresent: true, accessTokenExpiresAt: new Date(Date.now() + 3_600_000), oauthAuthorizedAt: new Date() }) }, "CONNECTION_MISMATCH");
  await refused("not connected", { loadConnection: async () => ({ id: 2, status: "AUTHORIZATION_REQUIRED", accessTokenPresent: false, accessTokenExpiresAt: null, oauthAuthorizedAt: null }) }, "CONNECTION_STATUS:AUTHORIZATION_REQUIRED");
  await refused("token expires in 9 min", { loadConnection: async () => ({ id: 2, status: "CONNECTED", accessTokenPresent: true, accessTokenExpiresAt: new Date(Date.now() + 9 * 60_000), oauthAuthorizedAt: new Date() }) }, "ACCESS_TOKEN_EXPIRES_SOON_REFRESH_NEEDED");
  const conn = (oauthAuthorizedAt: Date | null) => async () => ({ id: 2, status: "CONNECTED", accessTokenPresent: true, accessTokenExpiresAt: new Date(Date.now() + 3_600_000), oauthAuthorizedAt });
  await refused("token from an OAuth before the window", { loadConnection: conn(new Date(Date.now() - 2 * 60_000)) }, "OAUTH_NOT_IN_WINDOW");
  await refused("no OAuth timestamp", { loadConnection: conn(null) }, "OAUTH_NOT_IN_WINDOW");
  await refused("document 1 pinned (run-1 document stays blocked)", { pinned: { ...PIN, documentId: "1" } }, "DOCUMENT_BLOCKED");
  await refused("no prior submission (run 1 missing)", { listSubmissions: async () => [] }, "PRIOR_SUBMISSIONS_MISMATCH");
  await refused("an extra submission exists", { listSubmissions: async () => [{ ...RUN1 }, { id: 2, billingDocumentId: 77, status: "READY", errorCode: null }] }, "PRIOR_SUBMISSIONS_MISMATCH");
  await refused("run-1 submission changed status", { listSubmissions: async () => [{ ...RUN1, status: "FAILED" }] }, "PRIOR_SUBMISSIONS_MISMATCH");
  await refused("run-1 submission changed code", { listSubmissions: async () => [{ ...RUN1, errorCode: "AUTHORITY_NOT_SENT_NETWORK" }] }, "PRIOR_SUBMISSIONS_MISMATCH");
  await refused("other prior submission instead of run 1", { listSubmissions: async () => [{ ...RUN1, id: 3 }] }, "PRIOR_SUBMISSIONS_MISMATCH");
  ok("C run-1 pin matches the lab record", JSON.stringify(APPROVAL_ONESHOT_PRIOR_SUBMISSIONS) === JSON.stringify([RUN1]));

  {
    resetApprovalOneshotForTests();
    const h = harness(env, { mode: "preflight" });
    const r = await runSandboxApprovalOneshot(h.deps);
    ok("P preflight → PREFLIGHT_OK with the exact endpoint, no issue", r.outcome === "PREFLIGHT_OK" && r.approvalUrl === APPROVAL && h.issues() === 0, r);
    const r2 = await runSandboxApprovalOneshot({ ...h.deps, mode: "run" });
    ok("P preflight does not consume the instance latch", r2.outcome === "APPROVED", r2.outcome);
  }

  const outcome = async (name: string, after: Parameters<typeof harness>[2], expect: string, over: Partial<ApprovalOneshotDeps> = {}) => {
    resetApprovalOneshotForTests();
    const h = harness(env, over, after);
    const r = await runSandboxApprovalOneshot(h.deps);
    ok(`O ${name} → ${expect}`, r.outcome === expect, { outcome: r.outcome, sub: r.submission });
    ok(`O ${name}: no secrets in result`, !/Bearer|access_token|refresh_token|BEGIN/.test(JSON.stringify(r)));
    return r;
  };
  const r = await outcome("approved", { status: "APPROVED", errorCode: null, allocationNumber: "A123456789" }, "APPROVED");
  ok("O approved: allocation number reported, document ISSUED", r.allocationNumber === "A123456789" && r.documentStatusAfter === "ISSUED");
  await outcome("rejected", { status: "REJECTED", errorCode: "ITA_E010", allocationNumber: null }, "REJECTED");
  await outcome("held", { status: "HELD", errorCode: null, allocationNumber: null }, "HELD");
  await outcome("not sent (provable, by the execution service)", { status: "FAILED", errorCode: "AUTHORITY_NOT_SENT_NETWORK", allocationNumber: null }, "NOT_SENT");
  await outcome("FAILED without a not-sent code", { status: "FAILED", errorCode: "SOMETHING_ELSE", allocationNumber: null }, "UNCERTAIN");
  await outcome("uncertain (SUBMITTED)", { status: "SUBMITTED", errorCode: "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT", allocationNumber: null }, "UNCERTAIN");
  await outcome("READY, request never admitted", { status: "READY", errorCode: null, allocationNumber: null }, "NOT_EXECUTED");
  await outcome("no submission created", null, "NO_SUBMISSION");
  await outcome("issue threw before the POST", null, "ISSUE_FAILED", { issue: async () => { throw new Error("db"); } });

  {
    resetApprovalOneshotForTests();
    let admitted: string | null = null;
    const h = harness(env, {
      issue: async () => {
        const real = createAuthorityEgressFetch({ env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" } });
        admitted = await real(APPROVAL, { method: "POST", body: "{}" }).then(() => "R", (e) => (isAuthorityEgressError(e) ? e.code : "X"));
        throw new Error("after admission");
      },
    });
    const res = await runSandboxApprovalOneshot(h.deps);
    ok("O the issue runs inside the Approval allowance (real block admits it)", admitted === AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED, admitted);
    ok("O a throw after the POST was admitted → UNCERTAIN, admitted=true", res.outcome === "UNCERTAIN" && res.approvalRequestAdmitted === true, res);
  }
  {
    resetApprovalOneshotForTests();
    const h = harness(env);
    await runSandboxApprovalOneshot(h.deps);
    const again = await runSandboxApprovalOneshot(h.deps);
    ok("O second start on the instance → ALREADY_RAN_ON_INSTANCE", again.fuse === "ALREADY_RAN_ON_INSTANCE");
  }
}

async function main() {
  await scopeTests();
  await withValidEgress(oneshotTests);
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNCAUGHT", e);
  process.exit(1);
});
