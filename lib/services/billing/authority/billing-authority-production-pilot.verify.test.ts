/**
 * Production pilot gate for the ITA integration. Run manually:
 *   npx tsx lib/services/billing/authority/billing-authority-production-pilot.verify.test.ts
 *
 * Pure: in-memory doubles, a throw-away local CA, and a stub transport. No ITA
 * call, no proxy, no DB (DATABASE_URL points at a closed loopback port, so a
 * stray DB write fails locally instead of reaching anything).
 *
 * Proves: the gate is off by default and fails closed on any malformed value;
 * SANDBOX is unaffected; in PRODUCTION every authority path — OAuth start, the
 * admin cross-tenant start, callback, refresh, validation, Approval, Decision,
 * and the platform network probe — refuses a business outside the allowlist
 * before any state change or token work; and the egress transport refuses an
 * unscoped or non-admitted PRODUCTION request before any network I/O.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = "postgresql://pilot-test@127.0.0.1:1/none";
process.env.AUTH_TOKEN_SECRET = "pilot-gate-test-secret-0123456789abcdef0123456789abcdef";

import { BillingAuthorityEnvironment, UserRole } from "@prisma/client";
import {
  AUTHORITY_PRODUCTION_PILOT_ENV_VAR,
  AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED,
  AuthorityProductionPilotError,
  isAuthorityPilotScopeAllowed,
  isAuthorityProductionPilotEnabled,
  parseProductionPilotBusinessIds,
} from "@/lib/services/billing/authority/billing-authority-production-pilot";
import {
  AUTHORITY_EGRESS_ERROR_CODES,
  createAuthorityEgressFetch,
  isAuthorityEgressError,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  AUTHORITY_START_REASONS,
  resolveAuthorityOAuthStart,
} from "@/lib/services/billing/authority/billing-authority-oauth-start-route.service";
import { startAuthorityOAuth } from "@/lib/services/billing/authority/billing-authority-oauth-start.service";
import {
  AUTHORITY_OAUTH_CALLBACK_ERROR_CODES,
  handleAuthorityOAuthCallback,
} from "@/lib/services/billing/authority/billing-authority-oauth-callback.service";
import { createSignedAuthorityState } from "@/lib/services/billing/authority/billing-authority-signed-state.service";
import {
  AUTHORITY_REFRESH_ERROR_CODES,
  refreshAuthorityConnectionToken,
} from "@/lib/services/billing/authority/billing-authority-token-refresh.service";
import {
  AUTHORITY_VALIDATION_ERROR_CODES,
  validateAuthorityConnection,
} from "@/lib/services/billing/authority/billing-authority-validation.service";
import {
  resolveApprovalRuntimeContext,
  type RuntimeContextProviderDeps,
} from "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider";
import {
  executeAuthorityApproval,
  type SubmissionExecutionDeps,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";
import {
  executeAuthorityDecision,
  type DecisionExecutionDeps,
} from "@/lib/services/billing/authority/billing-authority-decision.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const PRODUCTION = BillingAuthorityEnvironment.PRODUCTION;
const SANDBOX = BillingAuthorityEnvironment.SANDBOX;
const PILOT = 42;
const OTHER = 43;

function setPilot(value: string | undefined): void {
  if (value === undefined) delete process.env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR];
  else process.env[AUTHORITY_PRODUCTION_PILOT_ENV_VAR] = value;
}

/** A fetch double that records calls and must never be reached when refused. */
function countingFetch() {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response("{}", { status: 599 });
  }) as typeof fetch;
  return { fn, calls };
}

// ── 1. parsing: off by default, fail closed ─────────────────────────────────

function parsing(): void {
  const empty = (v: string | undefined) => parseProductionPilotBusinessIds(v).size === 0;
  ok("unset → closed", empty(undefined));
  ok("empty / whitespace → closed", empty("") && empty("   "));
  ok("single id parsed", [...parseProductionPilotBusinessIds(" 42 ")].join() === "42");
  ok("list parsed + deduped", [...parseProductionPilotBusinessIds("42, 57,42")].sort().join() === "42,57");
  for (const bad of ["0", "-1", "4.2", "42,", ",42", "42;57", "abc", "042", "1e3", "42 57", "99999999999", "*"]) {
    ok(`malformed "${bad}" closes the gate for everyone`, empty(bad));
  }
  ok("more than 20 entries → closed", empty(Array.from({ length: 21 }, (_, i) => i + 1).join(",")));
  ok("enabled only with a valid non-empty list",
    !isAuthorityProductionPilotEnabled({}) &&
    !isAuthorityProductionPilotEnabled({ [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: "x" }) &&
    isAuthorityProductionPilotEnabled({ [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: "42" }));

  const env = { [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: "42" };
  ok("SANDBOX is never gated", isAuthorityPilotScopeAllowed({ kind: "business", businessId: OTHER }, SANDBOX, {}));
  ok("PRODUCTION admits the listed business", isAuthorityPilotScopeAllowed({ kind: "business", businessId: PILOT }, PRODUCTION, env));
  ok("PRODUCTION refuses an unlisted business", !isAuthorityPilotScopeAllowed({ kind: "business", businessId: OTHER }, PRODUCTION, env));
  ok("PRODUCTION platform probe only while the pilot is enabled",
    isAuthorityPilotScopeAllowed({ kind: "platform-diagnostic" }, PRODUCTION, env) &&
    !isAuthorityPilotScopeAllowed({ kind: "platform-diagnostic" }, PRODUCTION, {}));
}

// ── 2. egress transport: refused before any I/O ─────────────────────────────

const pkiDir = mkdtempSync(join(tmpdir(), "ita-pilot-test-"));
function buildPki(): Record<string, string> {
  const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: pkiDir, stdio: ["ignore", "pipe", "pipe"] });
  const key = (n: string) => ossl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${n}.key`]);
  const ca = (n: string) => {
    key(n);
    ossl(["req", "-x509", "-new", "-key", `${n}.key`, "-subj", `/O=PilotTest/CN=${n}`, "-days", "30", "-out", `${n}.pem`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  };
  ca("server-ca");
  ca("client-ca");
  key("client");
  ossl(["req", "-new", "-key", "client.key", "-subj", "/O=PilotTest/CN=client", "-out", "client.csr"]);
  writeFileSync(join(pkiDir, "client.ext"), "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n");
  ossl(["x509", "-req", "-in", "client.csr", "-CA", "client-ca.pem", "-CAkey", "client-ca.key", "-CAcreateserial",
    "-days", "30", "-out", "client.pem", "-extfile", "client.ext"]);
  const b64 = (f: string) => Buffer.from(readFileSync(join(pkiDir, f), "utf8"), "utf8").toString("base64");
  return {
    BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: PRODUCTION,
    ITA_EGRESS_PROXY_URL_PRODUCTION: "https://127.0.0.1:1",
    ITA_EGRESS_PROXY_CA_PRODUCTION: b64("server-ca.pem"),
    ITA_EGRESS_CLIENT_CERT_PRODUCTION: b64("client.pem"),
    ITA_EGRESS_CLIENT_KEY_PRODUCTION: b64("client.key"),
  };
}

async function egressLayer(): Promise<void> {
  const prodEnv = buildPki();
  const url = "https://ita-api.taxes.gov.il/shaam/production/Invoices/v2/Approval";
  const run = async (env: Record<string, string>, scoped: Parameters<ReturnType<typeof createAuthorityEgressFetch>["forScope"]>[0] | null) => {
    const transport = countingFetch();
    const egress = createAuthorityEgressFetch({ env, transportFetch: transport.fn as never });
    const fetchFn = scoped ? egress.forScope(scoped) : egress;
    const err = await fetchFn(url, { method: "POST", body: "{}" }).then(() => null, (e: unknown) => e);
    return { err, sent: transport.calls.length };
  };
  const refused = (r: { err: unknown; sent: number }) =>
    isAuthorityEgressError(r.err) && r.err.code === AUTHORITY_EGRESS_ERROR_CODES.PILOT_SCOPE_REFUSED && r.sent === 0;

  const closed = prodEnv;
  const open = { ...prodEnv, [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: String(PILOT) };
  ok("egress PRODUCTION: unscoped fetch refused (gate closed)", refused(await run(closed, null)));
  ok("egress PRODUCTION: unscoped fetch refused even with the pilot open", refused(await run(open, null)));
  ok("egress PRODUCTION: pilot business refused while the gate is closed", refused(await run(closed, { kind: "business", businessId: PILOT })));
  ok("egress PRODUCTION: other business refused while the pilot is open", refused(await run(open, { kind: "business", businessId: OTHER })));
  ok("egress PRODUCTION: platform probe refused while the gate is closed", refused(await run(closed, { kind: "platform-diagnostic" })));
  const admitted = await run(open, { kind: "business", businessId: PILOT });
  ok("egress PRODUCTION: pilot business reaches the transport", admitted.err === null && admitted.sent === 1, admitted.err);
  const probe = await run(open, { kind: "platform-diagnostic" });
  ok("egress PRODUCTION: platform probe reaches the transport while the pilot is open", probe.err === null && probe.sent === 1, probe.err);
  const malformed = await run({ ...prodEnv, [AUTHORITY_PRODUCTION_PILOT_ENV_VAR]: "42,x" }, { kind: "business", businessId: PILOT });
  ok("egress PRODUCTION: malformed allowlist refuses the listed business too", refused(malformed));

  const sandboxEnv = Object.fromEntries(Object.entries(prodEnv).map(([k, v]) =>
    [k.replace(/_PRODUCTION$/, "_SANDBOX"), k === "BILLING_AUTHORITY_RUNTIME_ENVIRONMENT" ? SANDBOX : v]));
  const sandbox = await run(sandboxEnv, null);
  ok("egress SANDBOX: unaffected by the pilot gate", sandbox.err === null && sandbox.sent === 1, sandbox.err);
}

// ── 3. services: refused before any state change or token work ──────────────

async function services(): Promise<void> {
  setPilot(String(PILOT));

  // OAuth start (route orchestration) — own business and admin cross-tenant.
  let startCalls = 0;
  const startOAuth = (async () => {
    startCalls += 1;
    return { authorizationUrl: "https://example.invalid/authorize", cookies: [] };
  }) as unknown as typeof startAuthorityOAuth;
  const base = { redirectBaseUrl: "https://app.invalid", secureCookies: true };
  const owner = (businessId: number) => ({ id: 7, businessId, role: UserRole.OWNER });

  let r = await resolveAuthorityOAuthStart({ ...base, user: owner(OTHER), environment: "PRODUCTION" }, { startOAuth });
  ok("start: PRODUCTION for a non-pilot business → 403 PRODUCTION_PILOT_NOT_ENABLED, no transition",
    !r.ok && r.status === "forbidden" && r.reason === AUTHORITY_START_REASONS.PRODUCTION_PILOT_NOT_ENABLED && startCalls === 0, r);
  r = await resolveAuthorityOAuthStart(
    { ...base, user: { id: 1, businessId: PILOT, role: UserRole.PLATFORM_ADMIN }, adminElevated: true, requestedBusinessId: String(OTHER), environment: "PRODUCTION" },
    { startOAuth });
  ok("start: elevated admin targeting a non-pilot business is refused too",
    !r.ok && r.reason === AUTHORITY_START_REASONS.PRODUCTION_PILOT_NOT_ENABLED && startCalls === 0, r);
  r = await resolveAuthorityOAuthStart({ ...base, user: owner(PILOT), environment: "PRODUCTION" }, { startOAuth });
  ok("start: PRODUCTION for the pilot business proceeds", r.ok && startCalls === 1, r);
  r = await resolveAuthorityOAuthStart({ ...base, user: owner(OTHER) }, { startOAuth });
  ok("start: SANDBOX (default) is unaffected", r.ok && startCalls === 2, r);

  // OAuth start (service) — defense in depth, throws before env/app/DB work.
  const startErr = await startAuthorityOAuth({
    businessId: OTHER, actorUserId: 7, environment: PRODUCTION, redirectBaseUrl: "https://app.invalid", secureCookies: true,
  }).then(() => null, (e: unknown) => e);
  ok("start service: refuses a non-pilot business with AuthorityProductionPilotError", startErr instanceof AuthorityProductionPilotError, startErr);

  // OAuth callback — the business comes from the signed state.
  const callback = async (businessId: number) => {
    const state = createSignedAuthorityState({ businessId, userId: 7, environment: PRODUCTION });
    const transport = countingFetch();
    const result = await handleAuthorityOAuthCallback({
      query: { code: "test-code", state },
      cookies: { state, businessId: String(businessId), environment: PRODUCTION },
      redirectBaseUrl: "https://app.invalid",
      actorUserId: 7,
      fetchImpl: transport.fn,
    });
    return { result, sent: transport.calls.length };
  };
  const cb = await callback(OTHER);
  ok("callback: non-pilot business → PRODUCTION_PILOT_NOT_ENABLED before any exchange",
    !cb.result.ok && cb.result.errorCode === AUTHORITY_OAUTH_CALLBACK_ERROR_CODES.PRODUCTION_PILOT_NOT_ENABLED && cb.sent === 0, cb);

  // Refresh + validation — refused before the connection is read.
  const refreshFetch = countingFetch();
  const refresh = await refreshAuthorityConnectionToken({ businessId: OTHER, environment: PRODUCTION, fetchImpl: refreshFetch.fn });
  ok("refresh: non-pilot business refused, nothing sent",
    !refresh.ok && refresh.errorCode === AUTHORITY_REFRESH_ERROR_CODES.PRODUCTION_PILOT_NOT_ENABLED && refreshFetch.calls.length === 0, refresh);
  const validateFetch = countingFetch();
  const validation = await validateAuthorityConnection({ businessId: OTHER, environment: PRODUCTION, fetchImpl: validateFetch.fn });
  ok("validation: non-pilot business refused, nothing sent",
    !validation.ok && validation.errorCode === AUTHORITY_VALIDATION_ERROR_CODES.PRODUCTION_PILOT_NOT_ENABLED && validateFetch.calls.length === 0, validation);

  // Runtime context (shared by Approval and Decision) — no config/app/token work.
  const touched: string[] = [];
  const ctxDeps: RuntimeContextProviderDeps = {
    resolveConfig: (() => { touched.push("config"); return { ok: true, config: { apiBaseUrl: "https://ita-api.taxes.gov.il/shaam/production", apiVersion: "v2", timeoutMs: 1000 } }; }) as never,
    resolveAccountingSoftwareNumber: async () => { touched.push("app"); return { ok: true, value: "270901" }; },
    resolveToken: (async () => { touched.push("token"); return { ok: true, accessToken: "t", connectionId: 1 }; }) as never,
    tokenDeps: {} as never,
  };
  const ctx = await resolveApprovalRuntimeContext({ businessId: OTHER, environment: PRODUCTION }, ctxDeps);
  ok("runtime context: non-pilot business refused before config/app/token",
    !ctx.ok && ctx.code === AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED && touched.length === 0, { ctx, touched });
  await resolveApprovalRuntimeContext({ businessId: PILOT, environment: PRODUCTION }, ctxDeps);
  ok("runtime context: pilot business proceeds to config/app/token", touched.join() === "config,app,token", touched);

  // Approval execution — refused before the reserve; nothing recorded or sent.
  const writes: string[] = [];
  const never = (name: string) => (async () => { writes.push(name); throw new Error(`${name} must not run`); }) as never;
  const approvalDeps: SubmissionExecutionDeps = {
    loadDocumentWithSubmission: async () => { writes.push("loadDocument"); return {
      id: 1, businessId: OTHER, status: "ISSUED", lockedAt: new Date(), legalSnapshotHash: "h",
      issuedSnapshot: {}, submission: { id: 9, status: "READY", errorCode: null, lastAttemptAt: null, authorityPayloadHash: null },
    } as never; },
    resolveEnvironment: () => PRODUCTION,
    resolveRuntimeContext: (input) => resolveApprovalRuntimeContext(input, ctxDeps),
    buildPayload: never("buildPayload"),
    requestApproval: never("requestApproval"),
    hashPayload: () => "p",
    now: () => new Date(),
    runInTransaction: never("runInTransaction"),
    recordAttempt: never("recordAttempt"),
    recordApproved: never("recordApproved"),
    recordRejected: never("recordRejected"),
    recordFailed: never("recordFailed"),
    recordHeld: never("recordHeld"),
    recordOutcomeUncertain: never("recordOutcomeUncertain"),
    reportSafetyEvent: () => writes.push("reportSafetyEvent"),
  };
  touched.length = 0;
  const approval = await executeAuthorityApproval({ businessId: OTHER, billingDocumentId: 1, actorUserId: 7 }, approvalDeps);
  ok("approval: non-pilot business refused before load, reserve, token work or send",
    approval.outcome === "preflight_failed" && approval.errorCode === AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED &&
    approval.safeToRetry === false && writes.length === 0 && touched.length === 0, { approval, writes });

  // Decision execution — refused in the runtime context before the authority call.
  const decisionDeps: DecisionExecutionDeps = {
    loadContext: async () => { writes.push("loadContext"); return {
      id: 1, businessId: OTHER, status: "ISSUED", issuedSnapshot: {}, submission: { id: 9, status: "HELD", decisionAction: null },
    } as never; },
    loadOperatorName: async () => "op",
    resolveEnvironment: () => PRODUCTION,
    resolveRuntimeContext: (input) => resolveApprovalRuntimeContext(input, ctxDeps),
    requestDecision: never("requestDecision"),
    runInTransaction: never("runInTransaction"),
    recordDecision: never("recordDecision"),
    now: () => new Date(),
    newCorrelationId: () => "c",
  };
  const decision = await executeAuthorityDecision({ businessId: OTHER, billingDocumentId: 1, actorUserId: 7, action: "Continue" } as never, decisionDeps);
  ok("decision: non-pilot business refused before load, token work or send",
    decision.outcome === "preflight_failed" && decision.errorCode === AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED &&
    writes.length === 0 && touched.length === 0, { decision, writes });

  // Gate closed (unset): even the pilot business is refused everywhere.
  setPilot(undefined);
  const closedCtx = await resolveApprovalRuntimeContext({ businessId: PILOT, environment: PRODUCTION }, ctxDeps);
  ok("gate unset: pilot business refused in the runtime context", !closedCtx.ok && closedCtx.code === AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED);
  r = await resolveAuthorityOAuthStart({ ...base, user: owner(PILOT), environment: "PRODUCTION" }, { startOAuth });
  ok("gate unset: pilot business cannot start PRODUCTION OAuth", !r.ok && r.reason === AUTHORITY_START_REASONS.PRODUCTION_PILOT_NOT_ENABLED);
}

// ── 4. static guard: every authority call-site carries a pilot scope ────────

function staticGuard(): void {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  };
  const files = [...walk("lib"), ...walk("app")].filter((f) => !f.replace(/\\/g, "/").endsWith("billing-authority-egress.ts"));
  const bare = files.filter((f) => {
    const text = readFileSync(f, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(import|\*|\/\/)/.test(line) && !/^\s*authorityEgressFetch,?\s*$/.test(line))
      .join("\n");
    return /\bauthorityEgressFetch\b(?!\.forScope\()/.test(text);
  });
  ok(`no unscoped authorityEgressFetch use outside the egress module (${files.length} files)`, bare.length === 0, bare);
  const scoped = files.filter((f) => /authorityEgressFetch\.forScope\(/.test(readFileSync(f, "utf8")));
  ok("all 6 authority clients use a scoped fetch", scoped.length === 6, scoped);
}

async function main() {
  try {
    parsing();
    await egressLayer();
    await services();
    staticGuard();
  } finally {
    rmSync(pkiDir, { recursive: true, force: true });
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
