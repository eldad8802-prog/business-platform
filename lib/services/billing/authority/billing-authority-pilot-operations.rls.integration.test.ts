/**
 * PRODUCTION pilot, per operation: "oauth,refresh,approval" opens Approval (and
 * refresh) without opening Decision, validation or the probe — on the real
 * execution path, under replayed RLS, with the never-re-send guarantees intact.
 *
 * Posture (same rules as every RLS proof in this repository):
 *   1. POLICIES: every RLS / policy statement the migrations ship is replayed.
 *   2. IDENTITY: asserted NOSUPERUSER / NOBYPASSRLS.
 *   3. AMBIENT CONTEXT: the services are called with NO tenant context.
 *
 * Real: the pilot gate, the shared runtime context, the token read + decrypt,
 * the submission reserve / record / re-entry gate, the document load. Stubbed:
 * the payload builder and the authority request itself (requestApproval /
 * requestDecision) — no request ever leaves; global fetch throws. Synthetic keys,
 * tokens and data only.
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-pilot-operations.rls.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
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
const PRODUCTION = BillingAuthorityEnvironment.PRODUCTION;

// ---- synthetic configuration (set BEFORE the services are imported) ----------
process.env.BILLING_AUTHORITY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.AUTHORITY_OAUTH_BASE_PRODUCTION = "https://oauth.stub.invalid";
process.env.AUTHORITY_API_BASE_PRODUCTION = "https://api.stub.invalid";
process.env.BILLING_AUTHORITY_OAUTH_REDIRECT_BASE_URL = "https://app.stub.invalid";
process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
let realFetchAttempts = 0;
globalThis.fetch = (async () => {
  realFetchAttempts++;
  throw new Error("network disabled in this test");
}) as typeof fetch;

async function replayRepositoryRls(adminUrl: string): Promise<number> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let applied = 0;
  try {
    for (const r of ["app_admin", "app_auth", "app_ctlplane", "app_runtime"]) {
      await admin.$executeRawUnsafe(
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
           CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
         END IF; END $do$`
      );
    }
    for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
      let sql: string;
      try {
        sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8");
      } catch {
        continue;
      }
      for (const st of sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
        .split(";").map((x) => x.trim()).filter(Boolean)) {
        if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
        try {
          await admin.$executeRawUnsafe(st);
          applied++;
        } catch {
          /* already present */
        }
      }
    }
  } finally {
    await admin.$disconnect();
  }
  return applied;
}

const SNAPSHOT = {
  schemaVersion: 1, issuedAt: "2026-11-05T10:00:00.000Z",
  document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
  issuer: { id: 3, name: "synthetic", legalName: "synthetic", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
  customer: { id: 7, name: "synthetic", legalName: null, taxId: "515000131", phone: null, email: null, city: null, address: null },
  lines: [{ lineIndex: 0, description: "service", quantity: "1.0000", unitPrice: "6000.0000", vatRatePercent: "18.00", lineSubtotal: "6000.00", vatAmount: "1080.00", lineTotal: "7080.00" }],
  totals: { subtotal: "6000.00", vat: "1080.00", total: "7080.00" },
  tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
  metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
  pdfTemplateStyle: "CLASSIC", extensions: {},
};

async function main() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set");
    process.exit(1);
  }
  const { getTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { encryptAuthorityAppSecret, encryptAuthorityConnectionToken } = await import(
    "@/lib/services/billing/authority/billing-authority-token-crypto.service"
  );
  const { executeAuthorityApproval, defaultSubmissionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-submission-execution.service"
  );
  const { executeAuthorityDecision, defaultDecisionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-decision.service"
  );

  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  const applied = await replayRepositoryRls(adminUrl);
  ok(`replayed ${applied} RLS/role statements from the repository`, applied > 50);
  ok("no ambient tenant context", getTenantContext() === undefined);

  // -------------------------------------------------------------- fixtures ---
  const owner = new PrismaClient({ datasourceUrl: adminUrl });
  const secret = encryptAuthorityAppSecret("synthetic-client-secret", PRODUCTION);
  const appData = {
    status: "ACTIVE" as const, accountingSoftwareNumber: "123456", itaClientId: "synthetic-client",
    clientSecretEncrypted: secret.encrypted, clientSecretIv: secret.iv, clientSecretTag: secret.tag, encryptionKeyId: "synthetic",
  };
  await owner.billingAuthorityApp.upsert({ where: { environment: PRODUCTION }, create: { environment: PRODUCTION, ...appData }, update: appData });

  async function tenant(label: string, accessExpiresAt: Date) {
    const business = await owner.business.create({ data: { name: `pilot-ops-${label}-${uniq()}` } });
    const user = await owner.user.create({
      data: { email: `pilot-ops-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
    });
    const a = encryptAuthorityConnectionToken(`${label}-access-synthetic`, business.id, PRODUCTION);
    const r = encryptAuthorityConnectionToken(`${label}-refresh-synthetic`, business.id, PRODUCTION);
    await tenantTx(business.id, (tx) =>
      tx.billingAuthorityConnection.create({
        data: {
          businessId: business.id, environment: PRODUCTION, status: "CONNECTED",
          accessTokenEncrypted: a.encrypted, accessTokenIv: a.iv, accessTokenTag: a.tag,
          refreshTokenEncrypted: r.encrypted, refreshTokenIv: r.iv, refreshTokenTag: r.tag,
          encryptionKeyId: "synthetic", accessTokenExpiresAt: accessExpiresAt, oauthAuthorizedAt: new Date(),
        },
      })
    );
    return { businessId: business.id, userId: user.id };
  }
  /** An ISSUED tax invoice with a READY submission (as issuance leaves it). */
  async function readyInvoice(businessId: number, n: number) {
    return tenantTx(businessId, async (tx) => {
      const doc = await tx.billingDocument.create({
        data: {
          businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
          customerNameSnapshot: "synthetic", currency: "ILS", subtotalAmount: "6000.00", vatAmount: "1080.00", totalAmount: "7080.00",
          documentNumber: n, documentNumberFormatted: String(n).padStart(6, "0"), issuedAt: new Date(), lockedAt: new Date(),
          legalSnapshotHash: `synthetic-${n}`, issuedSnapshot: SNAPSHOT as never,
        },
        select: { id: true },
      });
      // Issuance binds the legal snapshot hash to the submission; the reserve requires it.
      await tx.billingAuthoritySubmission.create({ data: { businessId, billingDocumentId: doc.id, status: BillingAuthoritySubmissionStatus.READY, legalSnapshotHash: `synthetic-${n}` } });
      return doc.id;
    });
  }
  async function submissionOf(businessId: number, billingDocumentId: number) {
    return tenantTx(businessId, async (tx) => ({
      sub: await tx.billingAuthoritySubmission.findUnique({ where: { billingDocumentId }, select: { status: true, errorCode: true, allocationNumber: true } }),
      doc: await tx.billingDocument.findUnique({ where: { id: billingDocumentId }, select: { allocationNumber: true } }),
    }));
  }

  const FUTURE = new Date(Date.now() + 3_600_000);
  const PAST = new Date(Date.now() - 3_600_000);
  const a = await tenant("a", FUTURE); // pilot business, fresh token
  const b = await tenant("b", FUTURE); // NOT on the pilot list
  const c = await tenant("c", PAST);   // pilot business, EXPIRED token
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = `${a.businessId},${c.businessId}`;
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = String(a.userId);
  const setOps = (v: string) => { process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = v; };

  // Approval with real deps; only the payload builder and the request are stubs.
  type Sent = { businessId: number; token: string };
  const sent: Sent[] = [];
  let nextOutcome: unknown = { outcome: "approved", confirmationNumber: "202611050000000000000001" };
  const approvalDeps = {
    ...defaultSubmissionExecutionDeps,
    buildPayload: () => ({ ok: true as const, payload: { synthetic: true } as never }),
    requestApproval: async (input: { businessId: number; accessToken: string }) => {
      sent.push({ businessId: input.businessId, token: input.accessToken });
      return nextOutcome as never;
    },
    reportSafetyEvent: () => {},
  };
  const approve = (t: { businessId: number; userId: number }, id: number) =>
    executeAuthorityApproval({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, approvalDeps as never);
  const decisions: Sent[] = [];
  const decisionDeps = {
    ...defaultDecisionExecutionDeps,
    requestDecision: async (input: { businessId: number; accessToken: string }) => {
      decisions.push({ businessId: input.businessId, token: input.accessToken });
      return { outcome: "accepted", message: null } as never;
    },
  };

  const a1 = await readyInvoice(a.businessId, 1);
  const a2 = await readyInvoice(a.businessId, 2);
  const b1 = await readyInvoice(b.businessId, 1);
  const c1 = await readyInvoice(c.businessId, 1);
  // N10: in PRODUCTION an Approval is also bound to business + document. This suite
  // is about the OPERATIONS switch, so every document it sends is authorized.
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS =
    `PRODUCTION:${a.businessId}:${a1},PRODUCTION:${a.businessId}:${a2},PRODUCTION:${b.businessId}:${b1},PRODUCTION:${c.businessId}:${c1}`;

  // ---------------------------------------- today's value: "oauth" (O) ---
  setOps("oauth");
  const o1 = await approve(a, a1);
  const o1s = await submissionOf(a.businessId, a1);
  ok("O1 \"oauth\": Approval refused STAGE_OAUTH_ONLY, nothing sent, submission still READY (no reserve)",
    o1.outcome === "preflight_failed" && (o1 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY" &&
    sent.length === 0 && o1s.sub?.status === "READY", JSON.stringify({ o1, s: o1s.sub }));
  const o2 = await executeAuthorityDecision({ businessId: a.businessId, billingDocumentId: a1, actorUserId: a.userId, action: "Continue" }, decisionDeps as never);
  ok("O2 \"oauth\": Decision refused STAGE_OAUTH_ONLY, nothing sent",
    o2.outcome === "preflight_failed" && (o2 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY" && decisions.length === 0);

  // ------------------------ "oauth,refresh,approval" (S) — Approval opens ---
  setOps("oauth,refresh,approval");
  const s1 = await approve(a, a1);
  const s1s = await submissionOf(a.businessId, a1);
  ok("S1 Approval sent once with tenant A's token; APPROVED with the allocation number on the submission and the document",
    s1.outcome === "completed_approved" && sent.length === 1 && sent[0].businessId === a.businessId && sent[0].token === "a-access-synthetic" &&
    s1s.sub?.status === "APPROVED" && s1s.sub.allocationNumber === "202611050000000000000001" && s1s.doc?.allocationNumber === "202611050000000000000001",
    JSON.stringify({ s1, sent: sent.length, s: s1s }));
  const s2 = await approve(a, a1);
  ok("S2 never re-send: a second Approval of the approved document is not sent (already_processed)",
    s2.outcome === "already_processed" && sent.length === 1, JSON.stringify(s2));

  const s3 = await executeAuthorityDecision({ businessId: a.businessId, billingDocumentId: a1, actorUserId: a.userId, action: "Continue" }, decisionDeps as never);
  ok("S3 Decision stays closed: refused OPERATION_NOT_ENABLED before any load or send",
    s3.outcome === "preflight_failed" && (s3 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_OPERATION_NOT_ENABLED" && decisions.length === 0,
    JSON.stringify(s3));

  const s4 = await approve(b, b1);
  const s4s = await submissionOf(b.businessId, b1);
  ok("S4 a business not on the list: refused NOT_ENABLED, nothing sent, its submission still READY",
    s4.outcome === "preflight_failed" && (s4 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_NOT_ENABLED" &&
    sent.length === 1 && s4s.sub?.status === "READY", JSON.stringify({ s4, s: s4s.sub }));

  // A send whose outcome is unknown is never repeated.
  nextOutcome = {
    outcome: "infrastructure_failure", classification: "TRANSIENT", message: "synthetic timeout after send",
    sendCertainty: "POSSIBLY_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: "ETIMEDOUT",
  };
  const s5 = await approve(a, a2);
  const s5s = await submissionOf(a.businessId, a2);
  ok("S5 possibly-sent outcome recorded as uncertain (sent once)",
    s5.outcome === "outcome_uncertain" && sent.length === 2 && s5s.sub?.status === "SUBMITTED" && /^AUTHORITY_OUTCOME_UNCERTAIN_/.test(s5s.sub.errorCode ?? ""),
    JSON.stringify({ s5: s5.outcome, sent: sent.length, s: s5s.sub }));
  const s6 = await approve(a, a2);
  ok("S6 never re-send: the uncertain document is not sent again", s6.outcome === "outcome_uncertain" && sent.length === 2, JSON.stringify(s6));

  // --------------------- "oauth,approval" without refresh (R) — fail closed ---
  setOps("oauth,approval");
  const r1 = await approve(c, c1);
  const r1s = await submissionOf(c.businessId, c1);
  ok("R1 approval-only + expired token: refresh refused, Approval NOT sent, submission still READY (re-executable)",
    r1.outcome === "preflight_failed" && (r1 as { errorCode?: string }).errorCode === "TOKEN_REFRESH_FAILED" &&
    sent.length === 2 && r1s.sub?.status === "READY", JSON.stringify({ r1, s: r1s.sub }));

  ok("T1 no tenant context leaks out", getTenantContext() === undefined);
  ok("N1 no real network request was attempted", realFetchAttempts === 0, `attempts=${realFetchAttempts}`);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("PILOT OPERATIONS UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("PILOT OPERATIONS UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
