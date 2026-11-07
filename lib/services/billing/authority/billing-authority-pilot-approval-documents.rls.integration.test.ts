/**
 * N10 — in the PRODUCTION pilot, an Approval is bound to environment + business +
 * document: through real issuance and the real Approval execution path.
 *
 * Posture: every repository RLS statement replayed; NOSUPERUSER / NOBYPASSRLS;
 * no ambient tenant context. Real: issuance (lock, numbering, submission), the
 * pilot gates, the runtime context, token read/decrypt, refresh entry, reserve /
 * record / re-entry. Stubbed: the payload builder and the authority request —
 * nothing ever leaves; global fetch throws. Synthetic keys, tokens and data only.
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-pilot-approval-documents.rls.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  CustomerTaxIdType,
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
  schemaVersion: 1, issuedAt: "2026-11-06T10:00:00.000Z",
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
  const { issueBillingDocument, AUTHORITY_PILOT_DOCUMENT_NOT_AUTHORIZED_AT_ISSUE_MESSAGE } = await import(
    "@/lib/services/billing/billing-issue.service"
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
    const business = await owner.business.create({ data: { name: `n10-${label}-${uniq()}` } });
    const user = await owner.user.create({
      data: { email: `n10-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
    });
    const a = encryptAuthorityConnectionToken(`${label}-access-synthetic`, business.id, PRODUCTION);
    const r = encryptAuthorityConnectionToken(`${label}-refresh-synthetic`, business.id, PRODUCTION);
    const customerId = await tenantTx(business.id, async (tx) => {
      await tx.businessProfile.create({
        data: {
          businessId: business.id, billingLegalName: `Synthetic ${label} Ltd`, billingBusinessKind: "LTD_COMPANY",
          billingTaxId: "515000123", billingAddress: "1 Synthetic St", billingPhone: "0500000000", billingEmail: `${label}@example.test`,
        },
      });
      await tx.billingAuthorityConnection.create({
        data: {
          businessId: business.id, environment: PRODUCTION, status: "CONNECTED",
          accessTokenEncrypted: a.encrypted, accessTokenIv: a.iv, accessTokenTag: a.tag,
          refreshTokenEncrypted: r.encrypted, refreshTokenIv: r.iv, refreshTokenTag: r.tag,
          encryptionKeyId: "synthetic", accessTokenExpiresAt: accessExpiresAt, oauthAuthorizedAt: new Date(),
        },
      });
      const c = await tx.customer.create({
        data: { businessId: business.id, name: "Synthetic dealer customer", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER },
        select: { id: true },
      });
      return c.id;
    });
    return { businessId: business.id, userId: user.id, customerId };
  }
  /** A draft; READY for a licensed issuer when ready=true (≥ 5,000 ILS + VAT, dealer customer). */
  async function draft(t: { businessId: number; customerId: number }, ready = true) {
    const [sub, vat, tot, unit] = ready ? ["6000.00", "1080.00", "7080.00", "6000"] : ["100.00", "18.00", "118.00", "100"];
    return (await tenantTx(t.businessId, (tx) =>
      tx.billingDocument.create({
        data: {
          businessId: t.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.DRAFT,
          customerId: t.customerId, customerNameSnapshot: "Synthetic dealer customer", currency: "ILS",
          subtotalAmount: sub, vatAmount: vat, totalAmount: tot,
          lines: { create: [{ lineIndex: 0, description: "Synthetic service", quantity: "1", unitPrice: unit, vatRatePercent: "18", lineSubtotal: sub, vatAmount: vat, lineTotal: tot }] },
        },
        select: { id: true },
      })
    )).id;
  }
  /** An ISSUED tax invoice with a READY submission (as issuance leaves it). */
  async function readyIssued(businessId: number, n: number) {
    return tenantTx(businessId, async (tx) => {
      const doc = await tx.billingDocument.create({
        data: {
          businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
          customerNameSnapshot: "synthetic", currency: "ILS", subtotalAmount: "6000.00", vatAmount: "1080.00", totalAmount: "7080.00",
          documentNumber: 100 + n, documentNumberFormatted: String(100 + n).padStart(6, "0"), issuedAt: new Date(), lockedAt: new Date(),
          legalSnapshotHash: `seed-${n}`, issuedSnapshot: SNAPSHOT as never,
        },
        select: { id: true },
      });
      await tx.billingAuthoritySubmission.create({
        data: { businessId, billingDocumentId: doc.id, status: BillingAuthoritySubmissionStatus.READY, legalSnapshotHash: `seed-${n}` },
      });
      return doc.id;
    });
  }
  async function state(businessId: number, id: number) {
    return tenantTx(businessId, async (tx) => ({
      doc: await tx.billingDocument.findUnique({ where: { id }, select: { status: true, documentNumber: true, allocationNumber: true } }),
      sub: await tx.billingAuthoritySubmission.findUnique({ where: { billingDocumentId: id }, select: { status: true, errorCode: true } }),
    }));
  }

  const FUTURE = new Date(Date.now() + 3_600_000);
  const PAST = new Date(Date.now() - 3_600_000);
  const a = await tenant("a", FUTURE); // pilot business
  const b = await tenant("b", FUTURE); // also on the business list (to test the business binding)
  const c = await tenant("c", PAST);   // pilot business with an EXPIRED access token
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = `${a.businessId},${b.businessId},${c.businessId}`;
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = String(a.userId);
  const setOps = (v: string) => { process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = v; };
  const setDocs = (v: string | undefined) => {
    if (v === undefined) delete process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS;
    else process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS = v;
  };

  // The authority request is a stub; it waits a moment so concurrent callers overlap.
  const sent: Array<{ businessId: number; token: string }> = [];
  let nextOutcome: unknown = { outcome: "approved", confirmationNumber: "202611060000000000000001" };
  const approvalDeps = {
    ...defaultSubmissionExecutionDeps,
    buildPayload: () => ({ ok: true as const, payload: { synthetic: true } as never }),
    requestApproval: async (input: { businessId: number; accessToken: string }) => {
      sent.push({ businessId: input.businessId, token: input.accessToken });
      await new Promise((r) => setTimeout(r, 300));
      return nextOutcome as never;
    },
    reportSafetyEvent: () => {},
  };
  const approve = (t: { businessId: number; userId: number }, id: number) =>
    executeAuthorityApproval({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, approvalDeps as never);
  const authorityDeps = { executeApproval: (input: { businessId: number; billingDocumentId: number; actorUserId: number }) => executeAuthorityApproval(input, approvalDeps as never) };
  const issue = async (t: { businessId: number; userId: number }, id: number) => {
    try {
      const r = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, authorityDeps as never);
      return { ok: true as const, authority: r.authority };
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
  };

  // ------------------------------------------ today's value "oauth" (U) ---
  setOps("oauth");
  setDocs(undefined);
  const u0 = await draft(a);
  const u = await issue(a, u0);
  ok("U1 \"oauth\" (today): issuance unchanged — the READY invoice issues; Approval refused (STAGE), nothing sent",
    u.ok && (u.authority as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY" && sent.length === 0,
    JSON.stringify(u));

  // --------------------- Approval open; one document authorized (I) ---
  setOps("oauth,refresh,approval");
  const d1 = await draft(a);
  const d2 = await draft(a);
  const d3 = await draft(a, false);
  setDocs(`PRODUCTION:${a.businessId}:${d1}`);

  const i1 = await issue(a, d1);
  const i1s = await state(a.businessId, d1);
  ok("I1 the authorized document issues and its Approval is sent ONCE with tenant A's token → APPROVED + allocation",
    i1.ok && sent.length === 1 && sent[0].token === "a-access-synthetic" && i1s.sub?.status === "APPROVED" && i1s.doc?.allocationNumber === "202611060000000000000001",
    JSON.stringify({ i1, sent: sent.length, s: i1s }));

  const i2 = await issue(a, d2);
  const i2s = await state(a.businessId, d2);
  ok("I2 an unauthorized READY document is refused AT ISSUANCE: stays DRAFT, no number, no submission, nothing sent",
    !i2.ok && i2.message === AUTHORITY_PILOT_DOCUMENT_NOT_AUTHORIZED_AT_ISSUE_MESSAGE &&
    i2s.doc?.status === "DRAFT" && i2s.doc.documentNumber === null && i2s.sub === null && sent.length === 1,
    JSON.stringify({ i2, s: i2s }));

  const i3 = await issue(a, d3);
  ok("I3 a document that needs no allocation issues normally, nothing sent", i3.ok && (i3.authority as { status?: string }).status === "not_required" && sent.length === 1,
    JSON.stringify(i3));

  // ------------------------------------- the send gate on its own (G) ---
  const w = await readyIssued(a.businessId, 1);
  const g1 = await approve(a, w);
  const g1s = await state(a.businessId, w);
  ok("G1 send gate: an issued READY document not on the list → DOCUMENT_NOT_AUTHORIZED, not sent, still READY",
    g1.outcome === "preflight_failed" && (g1 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED" &&
    sent.length === 1 && g1s.sub?.status === "READY", JSON.stringify({ g1, s: g1s.sub }));

  // Business binding: the document listed under ANOTHER business authorizes nothing.
  setDocs(`PRODUCTION:${b.businessId}:${w}`);
  const g2 = await approve(a, w);
  ok("G2 business binding: A's document listed under business B → A refused (DOCUMENT_NOT_AUTHORIZED), not sent",
    (g2 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED" && sent.length === 1, JSON.stringify(g2));
  const g3 = await approve(b, w);
  ok("G3 ...and B cannot use that entry to reach A's document (not found under B's tenant), not sent",
    g3.outcome === "preflight_failed" && (g3 as { errorCode?: string }).errorCode === "DOCUMENT_NOT_FOUND" && sent.length === 1, JSON.stringify(g3));
  setDocs(`SANDBOX:${a.businessId}:${w}`);
  ok("G4 environment binding: a SANDBOX entry authorizes nothing in PRODUCTION",
    ((await approve(a, w)) as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED" && sent.length === 1);
  setDocs(undefined);
  ok("G5 missing list → refused", ((await approve(a, w)) as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED" && sent.length === 1);

  // Before refresh: with an expired token, an unauthorized document never reaches refresh.
  const wc = await readyIssued(c.businessId, 2);
  setDocs(`PRODUCTION:${a.businessId}:${d1}`);
  const r1 = await approve(c, wc);
  ok("R1 unauthorized + expired token → refused DOCUMENT_NOT_AUTHORIZED (refresh never reached), nothing sent",
    (r1 as { errorCode?: string }).errorCode === "AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED" && sent.length === 1, JSON.stringify(r1));
  setDocs(`PRODUCTION:${c.businessId}:${wc}`);
  const r2 = await approve(c, wc);
  ok("R2 contrast: once authorized, the same document DOES reach refresh (fails closed here: no egress config) — still not sent",
    (r2 as { errorCode?: string }).errorCode === "TOKEN_REFRESH_FAILED" && sent.length === 1 && (await state(c.businessId, wc)).sub?.status === "READY",
    JSON.stringify(r2));

  // ------------------------------------------------ concurrency (C) ---
  const d5 = await draft(a);
  setDocs(`PRODUCTION:${a.businessId}:${d5}`);
  const [c1, c2] = await Promise.all([issue(a, d5), issue(a, d5)]);
  const c5 = await state(a.businessId, d5);
  ok("C1 two parallel issuances of the authorized draft → exactly one issues, ONE Approval sent",
    [c1, c2].filter((x) => x.ok).length === 1 && sent.length === 2 && c5.sub?.status === "APPROVED", JSON.stringify({ c1: c1.ok, c2: c2.ok, sent: sent.length, s: c5 }));

  const w2 = await readyIssued(a.businessId, 3);
  setDocs(`PRODUCTION:${a.businessId}:${w2}`);
  const [e1, e2] = await Promise.all([approve(a, w2), approve(a, w2)]);
  ok("C2 two parallel Approvals of the same authorized document → ONE send (the reserve admits one caller)",
    sent.length === 3 && [e1.outcome, e2.outcome].includes("completed_approved"), JSON.stringify({ e1: e1.outcome, e2: e2.outcome, sent: sent.length }));

  // ------------------------------------------- uncertain outcome (N) ---
  const w3 = await readyIssued(a.businessId, 4);
  setDocs(`PRODUCTION:${a.businessId}:${w3}`);
  nextOutcome = {
    outcome: "infrastructure_failure", classification: "TRANSIENT", message: "synthetic timeout after send",
    sendCertainty: "POSSIBLY_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: "ETIMEDOUT",
  };
  const n1 = await approve(a, w3);
  const n2 = await approve(a, w3);
  ok("N1 a possibly-sent Approval is recorded uncertain and never re-sent, even while authorized",
    n1.outcome === "outcome_uncertain" && n2.outcome === "outcome_uncertain" && sent.length === 4, JSON.stringify({ n1: n1.outcome, n2: n2.outcome, sent: sent.length }));

  ok("T1 no tenant context leaks out", getTenantContext() === undefined);
  ok("T2 no real network request was attempted", realFetchAttempts === 0, `attempts=${realFetchAttempts}`);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("PILOT APPROVAL DOCUMENTS UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("PILOT APPROVAL DOCUMENTS UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
