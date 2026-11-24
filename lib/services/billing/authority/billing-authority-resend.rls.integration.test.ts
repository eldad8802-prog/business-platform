/**
 * Gap A — "שלח שוב": resend an allocation request that PROVABLY never reached the
 * authority, through real issuance, the real resend service, the real execution
 * service, real transitions, real payload building and the real runtime context.
 * Only the authority request itself is a stub; global fetch throws.
 *
 * Posture: every repository RLS statement replayed; NOSUPERUSER / NOBYPASSRLS
 * login (refuses otherwise); no ambient tenant context. Synthetic data only.
 *
 *   RS1  READY never sent (no connection yet) → resend → sent once → APPROVED
 *   RS2  FAILED not-sent (connect refused) → resend → sent once, SAME payload hash → APPROVED
 *   RS3  uncertain (possibly sent) → resend refused 409, nothing sent
 *   RS4  SUBMITTED in flight / crash after the reserve → refused, nothing sent
 *   RS5  HELD (460) → refused · RS6 REJECTED (400) → refused · RS7 APPROVED → refused, never re-sent
 *   RS8  two parallel resends of the same not-sent request → exactly ONE request
 *   RS9  N10: a not-sent document no longer on the list → refused by the send gate, nothing sent, row unchanged
 *   RS10 sending closed again ("oauth") → refused by the pilot gate, nothing sent
 *   RS11 another business cannot resend it (not found under its tenant), nothing sent
 *   RS12 READY carrying a reserve's traces (inconsistent) → refused
 *   RS13 FAILED with a code that does not prove "not sent" → refused
 *   RS14 another user of the same business → different payload → hash mismatch, nothing sent
 *   RS15 the real route: 401 without auth, 409 + code when not eligible, 200 + outcome when
 *        eligible (real egress, no proxy configured → refused before any socket → not sent again)
 *   RS16 numbering and documents: number, legal hash, snapshot, totals and the number
 *        sequence are byte-identical before and after every resend
 *   T1/T2 no tenant context leaks; no real network request
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-resend.rls.integration.test.ts
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
for (const k of Object.keys(process.env)) if (k.startsWith("ITA_EGRESS_")) delete process.env[k];
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

async function main() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set");
    process.exit(1);
  }
  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const { POST: resendRoute } = await import("@/app/api/billing/documents/[id]/authority-resend/route");
  const { getTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { encryptAuthorityAppSecret, encryptAuthorityConnectionToken } = await import(
    "@/lib/services/billing/authority/billing-authority-token-crypto.service"
  );
  const { executeAuthorityApproval, defaultSubmissionExecutionDeps } = await import(
    "@/lib/services/billing/authority/billing-authority-submission-execution.service"
  );
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { resendAuthorityApproval, AUTHORITY_RESEND_NOT_ELIGIBLE_CODE, AUTHORITY_RESEND_REFUSAL_MESSAGES } = await import(
    "@/lib/services/billing/authority/billing-authority-resend.service"
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

  const FUTURE = new Date(Date.now() + 3_600_000);
  async function connect(businessId: number, label: string) {
    const a = encryptAuthorityConnectionToken(`${label}-access-synthetic`, businessId, PRODUCTION);
    const r = encryptAuthorityConnectionToken(`${label}-refresh-synthetic`, businessId, PRODUCTION);
    await tenantTx(businessId, (tx) =>
      tx.billingAuthorityConnection.create({
        data: {
          businessId, environment: PRODUCTION, status: "CONNECTED",
          accessTokenEncrypted: a.encrypted, accessTokenIv: a.iv, accessTokenTag: a.tag,
          refreshTokenEncrypted: r.encrypted, refreshTokenIv: r.iv, refreshTokenTag: r.tag,
          encryptionKeyId: "synthetic", accessTokenExpiresAt: FUTURE, oauthAuthorizedAt: new Date(),
        },
      })
    );
  }
  async function tenant(label: string, connected: boolean) {
    const business = await owner.business.create({ data: { name: `resend-${label}-${uniq()}` } });
    const user = await owner.user.create({
      data: { email: `resend-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
    });
    const customerId = await tenantTx(business.id, async (tx) => {
      await tx.businessProfile.create({
        data: {
          businessId: business.id, billingLegalName: `Synthetic ${label} Ltd`, billingBusinessKind: "LTD_COMPANY",
          billingTaxId: "515000123", billingVatNumber: "515000123", billingAddress: "1 Synthetic St", billingPhone: "0500000000",
          billingEmail: `${label}@example.test`,
        },
      });
      const c = await tx.customer.create({
        data: { businessId: business.id, name: "Synthetic dealer customer", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER },
        select: { id: true },
      });
      return c.id;
    });
    if (connected) await connect(business.id, label);
    return { businessId: business.id, userId: user.id, customerId, token: signAuthToken(user.id, user.tokenVersion) };
  }
  type T = Awaited<ReturnType<typeof tenant>>;
  async function draft(t: T) {
    return (await tenantTx(t.businessId, (tx) =>
      tx.billingDocument.create({
        data: {
          businessId: t.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.DRAFT,
          customerId: t.customerId, customerNameSnapshot: "Synthetic dealer customer", currency: "ILS",
          subtotalAmount: "6000.00", vatAmount: "1080.00", totalAmount: "7080.00",
          lines: { create: [{ lineIndex: 0, description: "Synthetic service", quantity: "1", unitPrice: "6000", vatRatePercent: "18", lineSubtotal: "6000.00", vatAmount: "1080.00", lineTotal: "7080.00" }] },
        },
        select: { id: true },
      })
    )).id;
  }
  /** Everything a resend must never change, as one comparable string. */
  async function frozen(id: number) {
    const d = await owner.billingDocument.findUniqueOrThrow({
      where: { id },
      select: { status: true, documentNumber: true, documentNumberFormatted: true, legalSnapshotHash: true, issuedSnapshot: true, issuedAt: true, subtotalAmount: true, vatAmount: true, totalAmount: true, customerId: true, customerNameSnapshot: true, currency: true },
    });
    return JSON.stringify(d);
  }
  async function sub(id: number) {
    return owner.billingAuthoritySubmission.findUnique({
      where: { billingDocumentId: id },
      select: { status: true, errorCode: true, authorityPayloadHash: true, lastAttemptAt: true, allocationNumber: true },
    });
  }
  const seqOf = async (businessId: number) =>
    (await owner.billingDocumentNumberSequence.findUnique({ where: { businessId_documentType: { businessId, documentType: BillingDocumentType.TAX_INVOICE } } }))?.nextNumber ?? null;

  // The authority request is the only stub. `requests` counts calls that reached it.
  let requests = 0;
  let nextOutcome: unknown = null;
  let delayMs = 0;
  const approvalDeps = {
    ...defaultSubmissionExecutionDeps,
    requestApproval: async () => {
      requests++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return nextOutcome as never;
    },
    reportSafetyEvent: () => {},
  };
  const exec = (input: { businessId: number; billingDocumentId: number; actorUserId: number }) => executeAuthorityApproval(input, approvalDeps as never);
  const resendDeps = { loadDocumentWithSubmission: defaultSubmissionExecutionDeps.loadDocumentWithSubmission, executeApproval: exec };
  const issue = (t: T, id: number) => issueBillingDocument({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, { executeApproval: exec });
  async function resend(t: { businessId: number; userId: number }, id: number) {
    try {
      const r = await resendAuthorityApproval({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, resendDeps);
      return { ok: true as const, status: r.authority.status, basis: r.basis, errorCode: (r.authority as { errorCode?: string }).errorCode ?? null };
    } catch (e) {
      return { ok: false as const, code: (e as { code?: string }).code ?? null, message: (e as Error).message, name: (e as Error).name };
    }
  }
  const APPROVED = { outcome: "approved", confirmationNumber: "202611240000000000000001" };
  const NOT_SENT = {
    outcome: "infrastructure_failure", classification: "NETWORK", message: "synthetic connect refused",
    sendCertainty: "NOT_SENT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: null, transportCode: "ECONNREFUSED",
  };
  const POSSIBLY_SENT = { ...NOT_SENT, classification: "TIMEOUT", message: "synthetic timeout after send", sendCertainty: "POSSIBLY_SENT", transportCode: null };

  const a = await tenant("a", true);
  const n = await tenant("n", false); // not connected yet → its first attempt never leaves
  const b = await tenant("b", true);  // another business, also on the pilot list
  const a2user = await owner.user.create({ data: { email: `resend-a2-${uniq()}@example.test`, password: "x", businessId: a.businessId, role: "USER" } });
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = `${a.businessId},${n.businessId},${b.businessId}`;
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = String(a.userId);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth,refresh,approval";
  const docs: string[] = [];
  const list = () => { process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_APPROVAL_DOCUMENTS = docs.join(","); };
  const authorize = (t: { businessId: number }, id: number) => {
    // At most 5 entries: keep only the latest ones this suite still needs.
    docs.push(`PRODUCTION:${t.businessId}:${id}`);
    while (docs.length > 5) docs.shift();
    list();
  };

  // ------------------------------------------------ RS1 READY never sent ---
  const n1 = await draft(n);
  authorize(n, n1);
  const seqN = await seqOf(n.businessId);
  const i1 = await issue(n, n1);
  const s1a = await sub(n1);
  ok("RS1 setup: no connection → issued, READY, never reserved (no hash, no attempt time), nothing requested",
    i1.document.status === "ISSUED" && s1a?.status === "READY" && s1a.authorityPayloadHash === null && s1a.lastAttemptAt === null && requests === 0,
    JSON.stringify({ authority: i1.authority, s1a }));
  const f1 = await frozen(n1);
  const seqN1 = await seqOf(n.businessId);
  await connect(n.businessId, "n");
  nextOutcome = APPROVED;
  const r1 = await resend(n, n1);
  const s1b = await sub(n1);
  ok("RS1 READY never sent → resend → ONE request → APPROVED with the number stored",
    r1.ok && r1.basis === "READY_NEVER_SENT" && r1.status === "approved" && requests === 1 && s1b?.status === "APPROVED" && s1b.allocationNumber === APPROVED.confirmationNumber,
    JSON.stringify({ r1, s1b, requests }));
  ok("RS16a document and numbering untouched by the resend (number, hash, snapshot, totals, customer; sequence)",
    (await frozen(n1)) === f1 && (await seqOf(n.businessId)) === seqN1 && seqN1 === (seqN ?? 1) + 1, JSON.stringify({ seqN, seqN1 }));

  // ------------------------------------------------ RS2 FAILED not-sent ---
  const d2 = await draft(a);
  authorize(a, d2);
  nextOutcome = NOT_SENT;
  await issue(a, d2);
  const s2a = await sub(d2);
  ok("RS2 setup: connect refused → FAILED AUTHORITY_NOT_SENT_*, payload hash recorded",
    s2a?.status === "FAILED" && /^AUTHORITY_NOT_SENT_/.test(s2a.errorCode ?? "") && !!s2a.authorityPayloadHash && requests === 2, JSON.stringify(s2a));
  const f2 = await frozen(d2);
  const seqA = await seqOf(a.businessId);
  nextOutcome = APPROVED;
  const r2 = await resend(a, d2);
  const s2b = await sub(d2);
  ok("RS2 FAILED not-sent → resend → ONE request with the SAME payload hash → APPROVED",
    r2.ok && r2.basis === "FAILED_NOT_SENT" && r2.status === "approved" && requests === 3 && s2b?.status === "APPROVED" && s2b.authorityPayloadHash === s2a?.authorityPayloadHash,
    JSON.stringify({ r2, s2b }));
  ok("RS16b document and numbering untouched", (await frozen(d2)) === f2 && (await seqOf(a.businessId)) === seqA);

  // ------------------------------------------------ RS3 uncertain ---
  const d3 = await draft(a);
  authorize(a, d3);
  nextOutcome = POSSIBLY_SENT;
  await issue(a, d3);
  const before3 = requests;
  const r3 = await resend(a, d3);
  ok("RS3 uncertain (possibly sent) → refused 409 before anything runs, nothing requested",
    !r3.ok && r3.code === AUTHORITY_RESEND_NOT_ELIGIBLE_CODE && r3.message === AUTHORITY_RESEND_REFUSAL_MESSAGES.IN_FLIGHT_OR_UNCERTAIN && requests === before3 && (await sub(d3))?.status === "SUBMITTED",
    JSON.stringify({ r3 }));

  // ------------------------------------------------ RS4 in flight / crash after reserve ---
  const d4 = await draft(a);
  authorize(a, d4);
  nextOutcome = NOT_SENT;
  await issue(a, d4);
  // A process that crashed right after the reserve leaves SUBMITTED with no marker.
  await owner.billingAuthoritySubmission.update({ where: { billingDocumentId: d4 }, data: { status: "SUBMITTED", errorCode: null, lastAttemptAt: new Date() } });
  const before4 = requests;
  const r4 = await resend(a, d4);
  ok("RS4 SUBMITTED (in flight / crashed after reserve) → refused, nothing requested",
    !r4.ok && r4.code === AUTHORITY_RESEND_NOT_ELIGIBLE_CODE && requests === before4, JSON.stringify(r4));

  // ------------------------------------------------ RS5–RS7 answered states ---
  const d5 = await draft(a);
  authorize(a, d5);
  nextOutcome = { outcome: "decision_required", code: 460, confirmationNumber: "0", message: "synthetic" };
  await issue(a, d5);
  const d6 = await draft(a);
  authorize(a, d6);
  nextOutcome = { outcome: "authority_validation_failed", errors: [{ code: 100, message: "synthetic" }], providerTransactionId: null };
  await issue(a, d6);
  const before5 = requests;
  const r5 = await resend(a, d5);
  const r6 = await resend(a, d6);
  const r7 = await resend(a, d2); // APPROVED in RS2
  ok("RS5 HELD → refused", !r5.ok && r5.message === AUTHORITY_RESEND_REFUSAL_MESSAGES.HELD && (await sub(d5))?.status === "HELD", JSON.stringify(r5));
  ok("RS6 REJECTED → refused", !r6.ok && r6.message === AUTHORITY_RESEND_REFUSAL_MESSAGES.REJECTED && (await sub(d6))?.status === "REJECTED", JSON.stringify(r6));
  ok("RS7 APPROVED → refused, never re-sent", !r7.ok && r7.message === AUTHORITY_RESEND_REFUSAL_MESSAGES.APPROVED, JSON.stringify(r7));
  ok("RS5–7 nothing requested", requests === before5);

  // ------------------------------------------------ RS8 parallel resends ---
  const d8 = await draft(a);
  authorize(a, d8);
  nextOutcome = NOT_SENT;
  await issue(a, d8);
  nextOutcome = APPROVED;
  delayMs = 300;
  const before8 = requests;
  const [p1, p2] = await Promise.all([resend(a, d8), resend(a, d8)]);
  delayMs = 0;
  ok("RS8 two parallel resends → exactly ONE request; the row ends APPROVED",
    requests === before8 + 1 && (await sub(d8))?.status === "APPROVED", JSON.stringify({ p1, p2, requests: requests - before8 }));

  // ------------------------------------------------ RS9 N10 cannot be bypassed ---
  const d9 = await draft(a);
  authorize(a, d9);
  nextOutcome = NOT_SENT;
  await issue(a, d9);
  const s9a = await sub(d9);
  docs.length = 0;
  docs.push(`PRODUCTION:${a.businessId}:${d8}`);
  list();
  const before9 = requests;
  const r9 = await resend(a, d9);
  const s9b = await sub(d9);
  ok("RS9 N10: a not-sent document no longer on the list → refused by the send gate (DOCUMENT_NOT_AUTHORIZED), nothing requested, row unchanged",
    r9.ok && r9.errorCode === "AUTHORITY_PRODUCTION_PILOT_DOCUMENT_NOT_AUTHORIZED" && requests === before9 &&
    s9b?.status === s9a?.status && s9b?.errorCode === s9a?.errorCode && s9b?.authorityPayloadHash === s9a?.authorityPayloadHash,
    JSON.stringify({ r9, s9a, s9b }));

  // ------------------------------------------------ RS10 sending closed again ---
  authorize(a, d9);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
  const r10 = await resend(a, d9);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth,refresh,approval";
  ok("RS10 back to \"oauth\" → refused by the pilot gate (STAGE), nothing requested",
    r10.ok && r10.errorCode === "AUTHORITY_PRODUCTION_PILOT_STAGE_OAUTH_ONLY" && requests === before9, JSON.stringify(r10));

  // ------------------------------------------------ RS11 tenant isolation ---
  const r11 = await resend(b, d9);
  ok("RS11 another business cannot resend it: not found under its own tenant, nothing requested",
    !r11.ok && r11.name === "NotFoundError" && requests === before9, JSON.stringify(r11));

  // ------------------------------------------------ RS12 / RS13 inconsistent rows ---
  const d12 = await draft(a);
  authorize(a, d12);
  nextOutcome = NOT_SENT;
  await issue(a, d12);
  await owner.billingAuthoritySubmission.update({ where: { billingDocumentId: d12 }, data: { status: "READY", errorCode: null } });
  const r12 = await resend(a, d12);
  ok("RS12 READY carrying a reserve's traces (hash / attempt time) → refused as inconsistent",
    !r12.ok && r12.message === AUTHORITY_RESEND_REFUSAL_MESSAGES.INCONSISTENT_READY && requests === before9, JSON.stringify(r12));
  await owner.billingAuthoritySubmission.update({ where: { billingDocumentId: d12 }, data: { status: "FAILED", errorCode: "LEGACY_UNKNOWN_FAILURE" } });
  const r13 = await resend(a, d12);
  ok("RS13 FAILED with a code that does not prove \"not sent\" → refused",
    !r13.ok && r13.message === AUTHORITY_RESEND_REFUSAL_MESSAGES.NOT_PROVABLY_UNSENT && requests === before9, JSON.stringify(r13));

  // ------------------------------------------------ RS14 same content only ---
  const r14 = await resend({ businessId: a.businessId, userId: a2user.id }, d9);
  ok("RS14 another user of the same business → a different payload → hash mismatch, nothing requested, row unchanged",
    r14.ok && r14.errorCode === "AUTHORITY_PAYLOAD_HASH_MISMATCH" && requests === before9 && (await sub(d9))?.status === "FAILED", JSON.stringify(r14));

  // ------------------------------------------------ RS15 the real route ---
  const call = (id: number, token?: string) =>
    resendRoute(
      new NextRequest(`http://localhost/api/billing/documents/${id}/authority-resend`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      { params: Promise.resolve({ id: String(id) }) }
    );
  const u = await call(d9);
  ok("RS15a no auth → 401", u.status === 401);
  const ne = await call(d2, a.token);
  const neb = (await ne.json()) as { code?: string; error?: string };
  ok("RS15b not eligible (APPROVED) → 409 + code + Hebrew explanation", ne.status === 409 && neb.code === AUTHORITY_RESEND_NOT_ELIGIBLE_CODE && neb.error === AUTHORITY_RESEND_REFUSAL_MESSAGES.APPROVED, JSON.stringify(neb));
  const f9 = await frozen(d9);
  const el = await call(d9, a.token);
  const elb = (await el.json()) as { basis?: string; authority?: { status?: string } };
  const s9c = await sub(d9);
  ok("RS15c eligible → 200 + outcome; real egress with no proxy refuses before any socket → still FAILED not-sent, document unchanged",
    el.status === 200 && elb.basis === "FAILED_NOT_SENT" && elb.authority?.status === "infrastructure_failed" &&
    s9c?.status === "FAILED" && /^AUTHORITY_NOT_SENT_/.test(s9c.errorCode ?? "") && (await frozen(d9)) === f9,
    JSON.stringify({ status: el.status, elb, s9c }));

  ok("T1 no tenant context leaks out", getTenantContext() === undefined);
  ok("T2 no real network request was attempted", realFetchAttempts === 0, `attempts=${realFetchAttempts}`);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("ALLOCATION RESEND UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("ALLOCATION RESEND UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
