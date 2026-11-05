/**
 * The Approval / Decision token path and its Refresh under the Production RLS posture.
 *
 * WHY THIS EXISTS
 *
 * The approval-token provider and the refresh service read
 * `BillingAuthorityConnection` through billingDbStep. Their live callers — the
 * post-commit Approval after issuance (POST /api/billing/documents/[id]/issue)
 * and the Decision route (POST /api/billing/documents/[id]/authority-decision) —
 * run with NO tenant context. The table is FORCE RLS and the runtime role cannot
 * bypass it, so the row was invisible: every Approval and Decision stopped at
 * CONNECTION_NOT_FOUND before any HTTP, and the refresh read could not see the
 * row either. The fix re-asserts the tenant from the trusted businessId
 * (billingTenantTx) at both reads.
 *
 * Same rules as every RLS proof in this repository:
 *   1. POLICIES installed exactly as 20260831120000_d2_p7_w4eb2_billing_tenant_rls.
 *   2. IDENTITY asserted NOSUPERUSER / NOBYPASSRLS.
 *   3. AMBIENT CONTEXT: the services are called with NO tenant context.
 *
 * NO NETWORK: every authority call is a local stub (refresh fetchImpl, requestApproval,
 * requestDecision) and globalThis.fetch throws for the whole run. Synthetic keys,
 * tokens and data only. SANDBOX environment for the token path; the PRODUCTION
 * OAUTH_ONLY refusal is asserted separately and is unchanged.
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-approval-path.rls.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SANDBOX = BillingAuthorityEnvironment.SANDBOX;
const PRODUCTION = BillingAuthorityEnvironment.PRODUCTION;

// ---- synthetic configuration (set BEFORE the services are imported) ----------
process.env.BILLING_AUTHORITY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.AUTHORITY_OAUTH_BASE_SANDBOX = "https://oauth.stub.invalid";
process.env.AUTHORITY_API_BASE_SANDBOX = "https://api.stub.invalid";
process.env.BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL = "https://app.stub.invalid";
process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS;
delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS;
delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS;

// No real network, ever: any un-stubbed fetch fails the run loudly.
let realFetchAttempts = 0;
globalThis.fetch = (async () => {
  realFetchAttempts++;
  throw new Error("network disabled in this test");
}) as typeof fetch;

/** As 20260831120000_d2_p7_w4eb2_billing_tenant_rls installs it (one policy, all commands). */
const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;

async function installRls() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policy under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const t = "BillingAuthorityConnection";
    await admin.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w4eb2_tenant ON "${t}"`);
    await admin.$executeRawUnsafe(
      `CREATE POLICY p7w4eb2_tenant ON "${t}" USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
    );
  } finally {
    await admin.$disconnect();
  }
}

async function main() {
  const { getTenantContext, runWithTenantContext, TenantContextError } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { encryptAuthorityAppSecret, encryptAuthorityConnectionToken, decryptAuthorityConnectionToken } = await import(
    "@/lib/services/billing/authority/billing-authority-token-crypto.service"
  );
  const { resolveAccessToken, defaultAccessTokenProviderDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-approval-token.provider"
  );
  const { refreshAuthorityConnectionToken } = await import("@/lib/services/billing/authority/billing-authority-token-refresh.service");
  const { resolveApprovalRuntimeContext } = await import(
    "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider"
  );
  const { executeAuthorityApproval, defaultSubmissionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-submission-execution.service"
  );
  const { executeAuthorityDecision, defaultDecisionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-decision.service"
  );

  // ------------------------------------------------------------ identity ---
  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("no ambient tenant context, as on the real post-commit / route path", getTenantContext() === undefined);
  await installRls();

  // -------------------------------------------------------------- fixtures ---
  const secret = encryptAuthorityAppSecret("synthetic-client-secret", SANDBOX);
  const appData = {
    status: "ACTIVE" as const,
    accountingSoftwareNumber: "123456",
    itaClientId: "synthetic-client",
    clientSecretEncrypted: secret.encrypted,
    clientSecretIv: secret.iv,
    clientSecretTag: secret.tag,
    encryptionKeyId: "synthetic",
  };
  await prisma.billingAuthorityApp.upsert({ where: { environment: SANDBOX }, create: { environment: SANDBOX, ...appData }, update: appData });

  async function tenant(label: string) {
    const business = await prisma.business.create({ data: { name: `rls-appr-${label}-${uniq()}` } });
    const user = await prisma.user.create({
      data: { email: `rls-appr-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
    });
    return { businessId: business.id, userId: user.id };
  }
  async function connect(businessId: number, access: string, refresh: string, accessExpiresAt: Date) {
    const a = encryptAuthorityConnectionToken(access, businessId, SANDBOX);
    const r = encryptAuthorityConnectionToken(refresh, businessId, SANDBOX);
    return tenantTx(businessId, (tx) =>
      tx.billingAuthorityConnection.create({
        data: {
          businessId,
          environment: SANDBOX,
          status: "CONNECTED",
          accessTokenEncrypted: a.encrypted, accessTokenIv: a.iv, accessTokenTag: a.tag,
          refreshTokenEncrypted: r.encrypted, refreshTokenIv: r.iv, refreshTokenTag: r.tag,
          encryptionKeyId: "synthetic",
          accessTokenExpiresAt: accessExpiresAt,
          oauthAuthorizedAt: new Date(),
        },
        select: { id: true },
      })
    );
  }
  const FUTURE = new Date(Date.now() + 3_600_000);
  const PAST = new Date(Date.now() - 3_600_000);
  const a = await tenant("a"); // connected, fresh access token
  const b = await tenant("b"); // connected, different token
  const c = await tenant("c"); // no connection
  const d = await tenant("d"); // connected, EXPIRED access token -> refresh path
  const connA = await connect(a.businessId, "A-access-synthetic", "A-refresh-synthetic", FUTURE);
  await connect(b.businessId, "B-access-synthetic", "B-refresh-synthetic", FUTURE);
  const connD = await connect(d.businessId, "D-access-old", "D-refresh-synthetic", PAST);

  // ------------------------------------------------------------ the posture ---
  const unscoped = await prisma.billingAuthorityConnection.findMany({ where: { businessId: a.businessId } });
  ok("G1 an unscoped connection read returns nothing (RLS is in force)", unscoped.length === 0, `got ${unscoped.length}`);

  // ---------------------------------------------------- token provider (P) ---
  const ta = await resolveAccessToken({ businessId: a.businessId, environment: SANDBOX });
  ok(
    "T1 the approval-token provider finds tenant A's connection and decrypts A's token",
    ta.ok === true && ta.accessToken === "A-access-synthetic" && ta.connectionId === connA.id,
    JSON.stringify(ta.ok ? { connectionId: ta.connectionId } : ta)
  );
  const tb = await resolveAccessToken({ businessId: b.businessId, environment: SANDBOX });
  ok("T2 tenant B gets B's own token, never A's", tb.ok === true && tb.accessToken === "B-access-synthetic");
  const tc = await resolveAccessToken({ businessId: c.businessId, environment: SANDBOX });
  ok("T3 a tenant with no connection → CONNECTION_NOT_FOUND", tc.ok === false && tc.code === "CONNECTION_NOT_FOUND", JSON.stringify(tc));

  let conflictRefused = false;
  try {
    await runWithTenantContext({ businessId: b.businessId }, () =>
      resolveAccessToken({ businessId: a.businessId, environment: SANDBOX })
    );
  } catch (error) {
    conflictRefused = error instanceof TenantContextError;
  }
  ok("T4 an established context for another business is refused, not switched", conflictRefused);
  const same = await runWithTenantContext({ businessId: a.businessId }, () =>
    resolveAccessToken({ businessId: a.businessId, environment: SANDBOX })
  );
  ok("T5 an established context for the same business is accepted", same.ok === true && same.accessToken === "A-access-synthetic");
  ok("T6 no tenant context leaks out", getTenantContext() === undefined);

  // ------------------------------------------- shared runtime context (RC) ---
  const rc = await resolveApprovalRuntimeContext({ businessId: a.businessId, environment: SANDBOX });
  ok(
    "RC1 the shared runtime context (Approval + Decision) carries A's token and the software number",
    rc.ok === true && rc.context.accessToken === "A-access-synthetic" && rc.context.accountingSoftwareNumber === "123456",
    JSON.stringify(rc.ok ? { connectionId: rc.context.connectionId } : rc)
  );

  // ----------------------------------------------------------- refresh (R) ---
  type Call = { url: string; body: string };
  const calls: Call[] = [];
  const stubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ access_token: "D-access-new", refresh_token: "D-refresh-new", expires_in: 3600, token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const refreshingDeps = {
    ...defaultAccessTokenProviderDeps,
    refresh: (input: { businessId: number; environment: BillingAuthorityEnvironment }) =>
      refreshAuthorityConnectionToken({ ...input, fetchImpl: stubFetch }),
  };
  const td = await resolveAccessToken({ businessId: d.businessId, environment: SANDBOX }, refreshingDeps);
  const sent = new URLSearchParams(calls[0]?.body ?? "");
  ok(
    "R1 an expired token is refreshed: the refresh read sees D's row and sends D's own refresh token (stub)",
    calls.length === 1 && sent.get("grant_type") === "refresh_token" && sent.get("refresh_token") === "D-refresh-synthetic",
    `calls=${calls.length} grant=${sent.get("grant_type")} sameRefresh=${sent.get("refresh_token") === "D-refresh-synthetic"}`
  );
  ok("R1 the stub was the only endpoint (stub host, no real network)", calls.every((x) => x.url.startsWith("https://oauth.stub.invalid")));
  ok("R2 the provider returns the refreshed token", td.ok === true && td.accessToken === "D-access-new" && td.connectionId === connD.id,
    JSON.stringify(td.ok ? { connectionId: td.connectionId } : td));
  const dRow = await tenantTx(d.businessId, (tx) =>
    tx.billingAuthorityConnection.findUnique({
      where: { id: connD.id },
      select: { accessTokenEncrypted: true, accessTokenIv: true, accessTokenTag: true, lastTokenRefreshAt: true },
    })
  );
  const stored = dRow
    ? decryptAuthorityConnectionToken({ encrypted: dRow.accessTokenEncrypted!, iv: dRow.accessTokenIv!, tag: dRow.accessTokenTag! }, d.businessId, SANDBOX)
    : null;
  ok("R3 the refreshed token is stored on D's row only", stored === "D-access-new" && dRow?.lastTokenRefreshAt != null);

  calls.length = 0;
  const rc2 = await refreshAuthorityConnectionToken({ businessId: c.businessId, environment: SANDBOX, fetchImpl: stubFetch });
  ok("R4 refresh for a tenant with no connection → not ok, nothing sent", rc2.ok === false && calls.length === 0, JSON.stringify(rc2));

  let refreshConflict = false;
  try {
    await runWithTenantContext({ businessId: a.businessId }, () =>
      refreshAuthorityConnectionToken({ businessId: d.businessId, environment: SANDBOX, fetchImpl: stubFetch })
    );
  } catch (error) {
    refreshConflict = error instanceof TenantContextError;
  }
  ok("R5 refresh under another business's context is refused, nothing sent", refreshConflict && calls.length === 0);

  // ------------------------------------------ Approval execution (E) ---
  // Everything stubbed EXCEPT resolveRuntimeContext (the real shared provider).
  const SNAPSHOT = {
    schemaVersion: 1, issuedAt: "2026-06-15T10:00:00.000Z",
    document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
    issuer: { id: 3, name: "synthetic", legalName: "synthetic", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "synthetic", legalName: null, taxId: "515000131", phone: null, email: null, city: null, address: null },
    lines: [{ lineIndex: 0, description: "service", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }],
    totals: { subtotal: "100.00", vat: "17.00", total: "117.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC", extensions: {},
  };
  const approvalTokens: string[] = [];
  const approvalDeps = (businessId: number) => ({
    ...defaultSubmissionExecutionDeps,
    loadDocumentWithSubmission: async () => ({
      id: 42, businessId, status: BillingDocumentStatus.ISSUED, lockedAt: new Date(), legalSnapshotHash: "synthetic",
      issuedSnapshot: SNAPSHOT as never,
      submission: { id: 55, status: BillingAuthoritySubmissionStatus.READY, authorityPayloadHash: null, errorCode: null, lastAttemptAt: null },
    }),
    buildPayload: () => ({ ok: true as const, payload: { synthetic: true } as never }),
    requestApproval: async (input: { accessToken: string }) => {
      approvalTokens.push(input.accessToken);
      return { outcome: "approved" as const, confirmationNumber: "000000000" };
    },
    runInTransaction: async <T,>(_b: number, fn: (tx: never) => Promise<T>) => fn({} as never),
    recordAttempt: async () => ({ submission: { id: 55 } }),
    recordApproved: async () => ({}),
    recordRejected: async () => ({}),
    recordFailed: async () => ({}),
    recordHeld: async () => ({}),
    recordOutcomeUncertain: async () => ({}),
    reportSafetyEvent: () => {},
  });
  await executeAuthorityApproval({ businessId: a.businessId, billingDocumentId: 42, actorUserId: a.userId }, approvalDeps(a.businessId) as never);
  ok("E1 the Approval request (stub) is sent with tenant A's token", approvalTokens.length === 1 && approvalTokens[0] === "A-access-synthetic",
    `sent=${approvalTokens.length}`);
  approvalTokens.length = 0;
  const ec = await executeAuthorityApproval({ businessId: c.businessId, billingDocumentId: 42, actorUserId: c.userId }, approvalDeps(c.businessId) as never);
  ok("E2 no connection → preflight CONNECTION_NOT_FOUND, nothing sent",
    ec.outcome === "preflight_failed" && (ec as { errorCode?: string }).errorCode === "CONNECTION_NOT_FOUND" && approvalTokens.length === 0,
    JSON.stringify(ec));

  // -------------------------------------------------- Decision (DC) ---
  const decisionTokens: string[] = [];
  const decisionDeps = (businessId: number) => ({
    ...defaultDecisionExecutionDeps,
    loadContext: async () => ({
      id: 42, businessId, status: BillingDocumentStatus.ISSUED, issuedSnapshot: SNAPSHOT as never,
      submission: { id: 55, status: BillingAuthoritySubmissionStatus.HELD, heldDecisionType: null, heldDecisionReportedAt: null },
    }),
    loadOperatorName: async () => "synthetic",
    requestDecision: async (input: { accessToken: string }) => {
      decisionTokens.push(input.accessToken);
      return { outcome: "accepted" as const, message: null };
    },
    runInTransaction: async <T,>(_b: number, fn: (tx: never) => Promise<T>) => fn({} as never),
    recordDecision: async () => ({ outcome: "APPLIED", status: BillingAuthoritySubmissionStatus.HELD, decisionType: null, reportedAt: new Date(), auditWritten: true }) as never,
  });
  await executeAuthorityDecision({ businessId: b.businessId, billingDocumentId: 42, actorUserId: b.userId, action: "Continue" }, decisionDeps(b.businessId) as never);
  ok("DC1 the Decision request (stub) is sent with tenant B's token", decisionTokens.length === 1 && decisionTokens[0] === "B-access-synthetic",
    `sent=${decisionTokens.length}`);
  decisionTokens.length = 0;
  const dc = await executeAuthorityDecision({ businessId: c.businessId, billingDocumentId: 42, actorUserId: c.userId, action: "Continue" }, decisionDeps(c.businessId) as never);
  ok("DC2 no connection → preflight CONNECTION_NOT_FOUND, nothing sent",
    dc.outcome === "preflight_failed" && (dc as { errorCode?: string }).errorCode === "CONNECTION_NOT_FOUND" && decisionTokens.length === 0,
    JSON.stringify(dc));

  // ------------------------------- PRODUCTION OAUTH_ONLY stays closed (P) ---
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = String(a.businessId);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = String(a.userId);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
  calls.length = 0;
  const prodCtx = await resolveApprovalRuntimeContext({ businessId: a.businessId, environment: PRODUCTION });
  const prodRefresh = await refreshAuthorityConnectionToken({ businessId: a.businessId, environment: PRODUCTION, fetchImpl: stubFetch });
  ok("P1 PRODUCTION in OAUTH_ONLY: runtime context refused by the stage, unchanged",
    prodCtx.ok === false && prodCtx.code === "AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY", JSON.stringify(prodCtx));
  ok("P2 PRODUCTION in OAUTH_ONLY: refresh refused, nothing sent", prodRefresh.ok === false && calls.length === 0, JSON.stringify(prodRefresh));

  ok("N1 no real network request was attempted", realFetchAttempts === 0, `attempts=${realFetchAttempts}`);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("AUTHORITY APPROVAL PATH UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("AUTHORITY APPROVAL PATH UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
