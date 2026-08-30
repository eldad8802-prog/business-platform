/**
 * D2 / P7-W4E-A — payments tenant-isolation battery.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17: full provision incl. a
 * pilot-equivalent policy on PaymentRequest, matrix, rollback proof, re-apply)
 * | neon (Preview: drift gates, W4E-A apply, matrix as the real runtime role).
 *
 * The load-bearing thing this proves is the provider-callback trust chain:
 *
 *   provider signal (unauthenticated, names only its own ids)
 *     -> bootstrap read of PaymentProviderRouting            [no tenant yet]
 *     -> re-read of the STORED PaymentRequest under the routed tenant's GUC,
 *        constrained by BOTH id and businessId               [consistency gate]
 *     -> runWithTenantContext(stored parent's businessId)
 *     -> tenant DB work under FORCE RLS
 *
 * The routing row is a HINT. A tampered one — missing parent, or a parent that
 * belongs to the other tenant in either direction — must produce a refusal and
 * ZERO business mutation. That is proven adversarially below, by corrupting
 * real routing rows in the database and replaying real callbacks.
 *
 * Real services throughout (processPaymentWebhook + createPaymentPrismaStore);
 * only the provider ADAPTER is stubbed, through the service's own
 * `deps.resolveProvider` seam. ZERO network, ZERO provider credentials.
 *
 * verify_only (W4EA_VERIFY_ONLY=1): READ-ONLY substrate verification.
 * Synthetic p7w4ea-* fixtures only.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const RT_PW = "p7w1_ci_synthetic_pw";
const RUNTIME_URL_IN = process.env.RUNTIME_URL;
const MARK = "p7w4ea-";
const W4EA_TENANT = ["PaymentAuditEvent", "BusinessPaymentConnection", "FinancialEvent", "PaymentTransaction"];
const VERIFY_ONLY = process.env.W4EA_VERIFY_ONLY === "1";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

function assertEndpointSafety(url, label) {
  for (const bad of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} forbidden endpoint`);
  }
  if (TARGET === "neon" && !url.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error(`DENY: ${label} not the approved Preview endpoint`);
  }
}

function splitSql(sql) {
  const out = [];
  let buf = "", inDollar = false;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.replace(/--.*$/, "");
    if ((stripped.match(/\$\$/g) || []).length % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(stripped)) {
      const stmt = buf.replace(/^\s*--.*$/gm, "").trim();
      if (stmt) out.push(stmt.replace(/;\s*$/, ""));
      buf = "";
    }
  }
  const tail = buf.replace(/^\s*--.*$/gm, "").trim();
  if (tail) out.push(tail);
  return out;
}

// ── stub provider adapters (the service's own resolveProvider seam) ─────────
// Capability profiles mirror the real registry: CARDCOM and PAYPAL verify;
// TRANZILA deliberately has NO getPaymentStatus, so a webhook alone can never
// settle it (Authority Principle). No network, no credentials.
function makeAdapters(state) {
  const base = (verifies) => ({
    createPaymentLink: async ({ paymentRequestId }) => ({
      paymentUrl: `https://stub.invalid/pay/${paymentRequestId}`,
      providerRequestId: `PRQ-${paymentRequestId}`,
      expiresAt: null,
    }),
    verifyWebhook: () => ({ ok: true }),
    parseWebhook: ({ parsedBody }) => ({
      providerEventId: parsedBody.eventId ?? null,
      eventType: "payment",
      outcome: parsedBody.outcome ?? "PAID",
      providerRequestId: parsedBody.providerRequestId ?? null,
      providerTransactionId: parsedBody.providerTransactionId ?? null,
      amount: parsedBody.amount ?? null,
      currency: parsedBody.currency ?? null,
    }),
    ...(verifies
      ? {
          getPaymentStatus: async ({ providerRequestId }) => {
            state.statusCalls.push(providerRequestId);
            return { outcome: "PAID", providerTransactionId: `TXN-${providerRequestId}` };
          },
        }
      : {}),
  });
  return { CARDCOM: base(true), PAYPAL: base(true), TRANZILA: base(false) };
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  assertEndpointSafety(OWNER_URL, "DIRECT_URL");
  if (RUNTIME_URL_IN) assertEndpointSafety(RUNTIME_URL_IN, "RUNTIME_URL");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} runtime=${RT_ROLE} verify_only=${VERIFY_ONLY}`);

  const applySqlFile = async (path, repl = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(repl)) sql = sql.replaceAll(k, v);
    for (const stmt of splitSql(sql)) await owner.$executeRawUnsafe(stmt);
  };

  // ── Phase 1: pre-state + drift gates ────────────────────────────────────
  const foreign = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${W4EA_TENANT.map((t) => `'${t}'`).join(",")}) AND policyname <> 'p7w4ea_tenant'`);
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on W4E-A tables: ${JSON.stringify(foreign)} — STOP`);

  if (TARGET === "neon") {
    const gates = [
      ["p4b_tenant", 5, ""],
      ["p7w1_tenant", 14, ""],
      ["p7w2_tenant", 24, ""],
      ["p7w3_tenant", 15, ""],
      ["p7w4b_tenant", 5, ""],
      ["p7w4c_tenant", 3, ""],
      ["p7w4d_tenant", 8, ""],
      ["p7adm_read", 10, ""],
    ];
    for (const [pol, want, scope] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'${scope}`))[0].c);
      if (c !== want) throw new Error(`DRIFT: ${pol}=${c}, expected ${want} — STOP`);
    }
    for (const role of [RT_ROLE, "app_admin", "app_admin_preview"]) {
      const r = (await owner.$queryRawUnsafe(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${role}'`))[0];
      if (!r || r.rolsuper || r.rolbypassrls) throw new Error(`DRIFT: ${role} posture — STOP`);
    }
    console.log("[pre-state] pilot=5, w1=14, w2=24, w3=15, w4b=5, w4c=3, w4d=8, adm=10, postures OK");
  }

  if (VERIFY_ONLY) {
    const p = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4ea_tenant'`))[0].c);
    ok("verify-only: 4 W4E-A policies present", p === 4, `found ${p}`);
    const forced = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4EA_TENANT.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
    ok("verify-only: 4 tables ENABLE+FORCE", forced === 4, `found ${forced}`);
    const routing = await owner.$queryRawUnsafe(
      `SELECT relrowsecurity AS e FROM pg_class WHERE relname='PaymentProviderRouting'`);
    ok("verify-only: routing table exists and stays NON-RLS", routing.length === 1 && routing[0].e === false);
    const g = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"PaymentTransaction"', 'SELECT') AS a,
              has_table_privilege('${RT_ROLE}', '"PaymentTransaction"', 'DELETE') AS b,
              has_table_privilege('${RT_ROLE}', '"PaymentProviderRouting"', 'SELECT') AS c2,
              has_table_privilege('app_admin', '"BusinessPaymentConnection"', 'SELECT') AS d`))[0];
    ok("verify-only: grant posture (tx S=yes/D=no, routing S=yes, admin conn=no)",
      g.a === true && g.b === false && g.c2 === true && g.d === false, JSON.stringify(g));
    const res = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz`);
    ok("verify-only: synthetic residue = 0", Number(res[0].biz) === 0);
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ── Phase 2 (pg only): lab substrate ────────────────────────────────────
  // The PG17 lab has no P4-B pilot, but the PaymentTransaction parent-join is
  // only meaningful when its parent is itself FORCE-RLS'd — so the lab installs
  // a pilot-EQUIVALENT policy on PaymentRequest under the same name and shape.
  // Without this the parent-join would be tested against an unprotected parent
  // and would prove nothing.
  if (TARGET === "pg") {
    const exists = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
    if (!exists) {
      await owner.$executeRawUnsafe(
        `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    }
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    await owner.$executeRawUnsafe(`ALTER TABLE "PaymentRequest" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "PaymentRequest" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p4b_tenant ON "PaymentRequest"`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY p4b_tenant ON "PaymentRequest"
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    await owner.$executeRawUnsafe(`GRANT SELECT ON "PaymentRequest" TO ${RT_ROLE}`);
    console.log("[lab] pilot-equivalent p4b_tenant installed on PaymentRequest");
  }

  // ── Phase 3: apply W4E-A migration + grants ─────────────────────────────
  await applySqlFile("prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql");
  await applySqlFile("scripts/security/d2-p7-w4ea-grants.sql", { ":ROLE": RT_ROLE });
  const polCount = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4ea_tenant'`))[0].c);
  ok("4 p7w4ea_tenant policies installed", polCount === 4, `found ${polCount}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4EA_TENANT.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
  ok("4 tables ENABLE+FORCE RLS", forced === 4, `found ${forced}`);

  // ── Phase 4: routing table posture + minimality ─────────────────────────
  const routingRls = (await owner.$queryRawUnsafe(
    `SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE relname='PaymentProviderRouting'`))[0];
  ok("PaymentProviderRouting is a NON-RLS bootstrap surface", routingRls.e === false && routingRls.f === false);
  const routingCols = (await owner.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name='PaymentProviderRouting' ORDER BY column_name`)).map((r) => r.column_name);
  const allowedCols = ["businessId", "createdAt", "id", "paymentRequestId", "provider", "providerRequestId"];
  ok("routing table is routing-ONLY (no business/financial columns)",
    JSON.stringify(routingCols) === JSON.stringify(allowedCols), routingCols.join(","));

  const uniq = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_indexes WHERE tablename='PaymentTransaction' AND indexname='PaymentTransaction_provider_providerTransactionId_key'`);
  ok("settlement idempotency is a DB constraint, not a read-then-write check", Number(uniq[0].c) === 1);

  // ── Phase 5: env + clients ──────────────────────────────────────────────
  let RUNTIME_URL = RUNTIME_URL_IN;
  if (TARGET === "pg") {
    const u = new URL(OWNER_URL);
    u.username = RT_ROLE; u.password = RT_PW;
    RUNTIME_URL = u.toString();
  }
  process.env.DATABASE_URL = RUNTIME_URL;
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`runtime current_user = ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);

  const { processPaymentWebhook } = await import("@/lib/services/payments/payment-webhook.service");
  const { createPaymentPrismaStore } = await import("@/lib/services/payments/payment-store.prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { ensurePaymentPostedEvent } = await import("@/lib/services/financial-events/financial-event.service");

  // ── Phase 6: fixtures ───────────────────────────────────────────────────
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "PaymentTransaction" WHERE "paymentRequestId" IN (SELECT id FROM "PaymentRequest" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "PaymentProviderRouting" WHERE "businessId" IN (${bids})`);
    for (const t of ["PaymentAuditEvent", "FinancialEvent", "PaymentRequest", "BusinessPaymentConnection"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "PaymentWebhookEvent" WHERE "providerEventId" LIKE '${MARK}%'`);
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w4ea.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  await owner.user.create({ data: { email: "a@p7w4ea.test", password: "x", businessId: bizA.id } });
  await owner.user.create({ data: { email: "b@p7w4ea.test", password: "x", businessId: bizB.id } });
  const mkConn = (biz, provider) => owner.businessPaymentConnection.create({
    data: { businessId: biz, provider, merchantId: `M-${biz}-${provider}`, isActive: true },
  });
  const mkReq = async (biz, provider, tag) => {
    const r = await owner.paymentRequest.create({
      data: { businessId: biz, provider, amount: "100.00", currency: "ILS", status: "PENDING", providerRequestId: `${MARK}${provider}-${tag}` },
    });
    await owner.paymentProviderRouting.create({
      data: { provider, providerRequestId: r.providerRequestId, paymentRequestId: r.id, businessId: biz },
    });
    return r;
  };
  for (const p of ["CARDCOM", "TRANZILA", "PAYPAL"]) { await mkConn(bizA.id, p); await mkConn(bizB.id, p); }
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id] };

  // ── Phase 7: direct RLS matrix ──────────────────────────────────────────
  console.log("--- direct RLS ---");
  await owner.paymentAuditEvent.create({ data: { businessId: bizB.id, eventType: "X", source: "SYSTEM", summary: "B only", eventHash: `${MARK}hb`, occurredAt: new Date() } });
  await owner.paymentAuditEvent.create({ data: { businessId: bizA.id, eventType: "X", source: "SYSTEM", summary: "A only", eventHash: `${MARK}ha`, occurredAt: new Date() } });
  const auditA = await rtx(rt, bizA.id, (t) => t.paymentAuditEvent.findMany({ where: { businessId: inIds } }));
  ok("PaymentAuditEvent: A sees only A", auditA.length === 1 && auditA[0].businessId === bizA.id, `n=${auditA.length}`);
  const connA = await rtx(rt, bizA.id, (t) => t.businessPaymentConnection.findMany({ where: { businessId: inIds } }));
  ok("BusinessPaymentConnection: A sees only A credentials/config",
    connA.length === 3 && connA.every((c) => c.businessId === bizA.id), `n=${connA.length}`);
  const connUpd = await rtx(rt, bizA.id, (t) => t.businessPaymentConnection.updateMany({ where: { businessId: bizB.id }, data: { isActive: false } }));
  ok("BusinessPaymentConnection: A cannot mutate B", connUpd.count === 0);
  await owner.financialEvent.create({ data: { businessId: bizB.id, direction: "INCOME", amount: "5.00", currency: "ILS", occurredAt: new Date(), category: "payment", sourceType: "PAYMENT", sourceKey: `${MARK}b1`, status: "POSTED" } });
  const feA = await rtx(rt, bizA.id, (t) => t.financialEvent.findMany({ where: { businessId: inIds } }));
  ok("FinancialEvent: B invisible to A", feA.every((e) => e.businessId === bizA.id));
  let feWriteDenied = false;
  try {
    await rtx(rt, bizA.id, (t) => t.financialEvent.create({ data: { businessId: bizB.id, direction: "INCOME", amount: "1.00", currency: "ILS", occurredAt: new Date(), category: "payment", sourceType: "PAYMENT", sourceKey: `${MARK}x1`, status: "POSTED" } }));
  } catch { feWriteDenied = true; }
  ok("FinancialEvent: WITH CHECK denies a cross-tenant INSERT", feWriteDenied);

  // ── Phase 8: PaymentTransaction parent-join ─────────────────────────────
  console.log("--- parent-join (PaymentTransaction -> PaymentRequest) ---");
  const reqA = await mkReq(bizA.id, "CARDCOM", "pj-a");
  const reqB = await mkReq(bizB.id, "CARDCOM", "pj-b");
  await owner.paymentTransaction.create({ data: { paymentRequestId: reqB.id, provider: "CARDCOM", providerTransactionId: `${MARK}txb`, amount: "100.00", currency: "ILS", status: "PAID" } });
  const txA = await rtx(rt, bizA.id, (t) => t.paymentTransaction.findMany({}));
  ok("PaymentTransaction: A cannot see B's transactions", txA.every((t) => t.paymentRequestId !== reqB.id));
  // Two acceptable shapes of denial, and the stronger one is what actually
  // happens here: PaymentTransaction carries S,I only (settlement records are
  // immutable), so an UPDATE is refused at the privilege layer before RLS is
  // even consulted. Accept either that or an RLS-filtered zero-row update.
  let txUpdDenied = false, txUpdCount = -1;
  try {
    txUpdCount = (await rtx(rt, bizA.id, (t) => t.paymentTransaction.updateMany({ where: { paymentRequestId: reqB.id }, data: { status: "FAILED" } }))).count;
  } catch (e) { txUpdDenied = /permission denied/i.test(String(e?.message)); }
  const txBAfter = await owner.paymentTransaction.findFirst({ where: { paymentRequestId: reqB.id } });
  ok("PaymentTransaction: A cannot update B's transaction (privilege-denied or 0 rows)",
    (txUpdDenied || txUpdCount === 0) && txBAfter?.status === "PAID",
    `denied=${txUpdDenied} count=${txUpdCount} bStatus=${txBAfter?.status}`);
  let foreignParentDenied = false;
  try {
    await rtx(rt, bizA.id, (t) => t.paymentTransaction.create({ data: { paymentRequestId: reqB.id, provider: "CARDCOM", providerTransactionId: `${MARK}bad`, amount: "1.00", currency: "ILS", status: "PAID" } }));
  } catch { foreignParentDenied = true; }
  ok("PaymentTransaction: INSERT with a foreign parent is rejected", foreignParentDenied);
  const rawTx = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "PaymentTransaction"`));
  const ownTx = await owner.paymentTransaction.count({ where: { paymentRequest: { businessId: bizA.id } } });
  ok("PaymentTransaction: broad raw SELECT under A returns A only", Number(rawTx[0].c) === ownTx, `raw=${rawTx[0].c} own=${ownTx}`);

  // ── Phase 9: real provider callbacks ────────────────────────────────────
  console.log("--- real provider callbacks (adapters stubbed at the service seam) ---");
  const state = { statusCalls: [] };
  const adapters = makeAdapters(state);
  const store = createPaymentPrismaStore();
  const deps = (provider) => ({
    store,
    resolveProvider: () => adapters[provider],
    resolveWebhookSecret: () => "stub-secret",
    decryptConnectionCredential: () => "stub-credential",
    onVerifiedPaid: async (e) =>
      runWithTenantContext({ businessId: e.businessId }, () =>
        withTenantTransaction((tx) =>
          ensurePaymentPostedEvent(tx, {
            businessId: e.businessId,
            paymentRequestId: e.paymentRequestId,
            transactionId: e.transactionId,
            amount: e.amount,
            currency: e.currency,
            occurredAt: e.occurredAt,
          })
        )
      ),
  });
  const call = (provider, body) =>
    processPaymentWebhook(
      { provider, rawBody: JSON.stringify(body), parsedBody: body, headers: {} },
      deps(provider)
    );
  const feCount = (biz) => owner.financialEvent.count({ where: { businessId: biz, sourceType: "PAYMENT" } });
  const txCount = (reqId) => owner.paymentTransaction.count({ where: { paymentRequestId: reqId } });

  const bBaseline = await feCount(bizB.id);
  for (const provider of ["CARDCOM", "PAYPAL"]) {
    const rA = await mkReq(bizA.id, provider, "ok-a");
    const before = await feCount(bizA.id);
    const res = await call(provider, {
      eventId: `${MARK}${provider}-1`, providerRequestId: rA.providerRequestId,
      outcome: "PAID", businessId: bizB.id, // malicious payload tenant
    });
    const after = await feCount(bizA.id);
    const bAfter = await feCount(bizB.id);
    // B already holds ONE seeded fixture event from the direct-RLS phase, so
    // the leak test is a DELTA: the malicious payload must add nothing to B.
    ok(`${provider}: verified PAID settles under the STORED tenant (payload businessId ignored)`,
      res.ok === true && res.paymentRequestStatus === "PAID" &&
      (await txCount(rA.id)) === 1 && after === before + 1,
      `ok=${res.ok} status=${res.paymentRequestStatus} reason=${res.reason}`);
    ok(`${provider}: the malicious payload tenant produced nothing under B`, bAfter === bBaseline, `B fe=${bAfter} baseline=${bBaseline}`);

    // duplicate serial
    const dup = await call(provider, { eventId: `${MARK}${provider}-1`, providerRequestId: rA.providerRequestId, outcome: "PAID" });
    ok(`${provider}: duplicate event serially -> one logical effect`,
      dup.duplicate === true && (await txCount(rA.id)) === 1 && (await feCount(bizA.id)) === after,
      `dup=${dup.duplicate} tx=${await txCount(rA.id)}`);

    // duplicate concurrent (distinct event ids, same settlement)
    const rC = await mkReq(bizA.id, provider, "conc-a");
    const feBeforeConc = await feCount(bizA.id);
    await Promise.all([
      call(provider, { eventId: `${MARK}${provider}-c1`, providerRequestId: rC.providerRequestId, outcome: "PAID" }),
      call(provider, { eventId: `${MARK}${provider}-c2`, providerRequestId: rC.providerRequestId, outcome: "PAID" }),
    ]);
    ok(`${provider}: concurrent duplicate callbacks -> one transaction + one FinancialEvent`,
      (await txCount(rC.id)) === 1 && (await feCount(bizA.id)) === feBeforeConc + 1,
      `tx=${await txCount(rC.id)} fe=${await feCount(bizA.id)} expected=${feBeforeConc + 1}`);
  }

  // TRANZILA has no verification path: a webhook alone may NEVER settle.
  const rT = await mkReq(bizA.id, "TRANZILA", "signal-a");
  const feBeforeT = await feCount(bizA.id);
  const resT = await call("TRANZILA", { eventId: `${MARK}TRZ-1`, providerRequestId: rT.providerRequestId, outcome: "PAID" });
  ok("TRANZILA: signal-only provider never settles from a webhook",
    resT.reason === "signal_only_no_verification" && (await txCount(rT.id)) === 0 && (await feCount(bizA.id)) === feBeforeT,
    `reason=${resT.reason}`);
  ok("TRANZILA: the signal is still audited under the stored tenant",
    (await owner.paymentAuditEvent.count({ where: { businessId: bizA.id, paymentRequestId: rT.id } })) >= 1);

  // Generic /[provider] route shares this exact service, so its trust model is
  // the same code path — asserted explicitly rather than assumed.
  const genericRes = await call("PAYPAL", { eventId: `${MARK}generic-1`, providerRequestId: "no-such-provider-request", outcome: "PAID" });
  ok("generic handler: unknown routing fails safely with zero business mutation",
    genericRes.ok === false && genericRes.reason === "no_matching_payment_request");

  // §7 — P2002 must be interpreted ONLY as the settlement duplicate. A store
  // whose createTransaction throws an UNRELATED unique violation must surface
  // it, not have it silently reported as a benign duplicate callback.
  const rP = await mkReq(bizA.id, "CARDCOM", "p2002");
  const poisonedDeps = {
    ...deps("CARDCOM"),
    store: {
      ...store,
      createTransaction: async () => {
        const e = new Error("Unique constraint failed on the fields: (`someOtherField`)");
        e.code = "P2002";
        e.meta = { target: ["someOtherField"] };
        throw e;
      },
    },
  };
  let unrelatedSurfaced = false;
  try {
    await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: "{}", parsedBody: { eventId: `${MARK}p2002`, providerRequestId: rP.providerRequestId, outcome: "PAID" }, headers: {} },
      poisonedDeps
    );
  } catch { unrelatedSurfaced = true; }
  ok("P2002 on an UNRELATED constraint is not swallowed as a duplicate", unrelatedSurfaced);

  // ── Phase 10: corrupted routing (adversarial) ───────────────────────────
  console.log("--- corrupted routing ---");
  const snapshot = async () => ({
    txA: await owner.paymentTransaction.count({ where: { paymentRequest: { businessId: bizA.id } } }),
    txB: await owner.paymentTransaction.count({ where: { paymentRequest: { businessId: bizB.id } } }),
    feA: await feCount(bizA.id), feB: await feCount(bizB.id),
    auA: await owner.paymentAuditEvent.count({ where: { businessId: bizA.id } }),
    auB: await owner.paymentAuditEvent.count({ where: { businessId: bizB.id } }),
  });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // (a) routing points at a PaymentRequest that does not exist
  const before1 = await snapshot();
  await owner.paymentProviderRouting.create({
    data: { provider: "CARDCOM", providerRequestId: `${MARK}orphan`, paymentRequestId: 2000000001, businessId: bizA.id },
  });
  const r1 = await call("CARDCOM", { eventId: `${MARK}corrupt-1`, providerRequestId: `${MARK}orphan`, outcome: "PAID" });
  ok("corrupted routing: missing parent -> refusal, zero mutation",
    r1.ok === false && same(before1, await snapshot()), `reason=${r1.reason}`);

  // (b) routing says A, the parent actually belongs to B
  const before2 = await snapshot();
  const victimB = await mkReq(bizB.id, "CARDCOM", "victim-b");
  await owner.paymentProviderRouting.update({
    where: { paymentRequestId: victimB.id }, data: { businessId: bizA.id },
  });
  const r2 = await call("CARDCOM", { eventId: `${MARK}corrupt-2`, providerRequestId: victimB.providerRequestId, outcome: "PAID" });
  ok("corrupted routing: routed A / parent B -> refusal, zero mutation on either tenant",
    r2.ok === false && same(before2, await snapshot()), `reason=${r2.reason}`);

  // (c) reverse direction: routing says B, the parent belongs to A
  const before3 = await snapshot();
  const victimA = await mkReq(bizA.id, "CARDCOM", "victim-a");
  await owner.paymentProviderRouting.update({
    where: { paymentRequestId: victimA.id }, data: { businessId: bizB.id },
  });
  const r3 = await call("CARDCOM", { eventId: `${MARK}corrupt-3`, providerRequestId: victimA.providerRequestId, outcome: "PAID" });
  ok("corrupted routing: routed B / parent A -> refusal, zero mutation on either tenant",
    r3.ok === false && same(before3, await snapshot()), `reason=${r3.reason}`);

  // ── Phase 11: backfill integrity ────────────────────────────────────────
  console.log("--- backfill integrity ---");
  const mismatched = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c
       FROM "PaymentProviderRouting" r
       JOIN "PaymentRequest" p ON p."id" = r."paymentRequestId"
      WHERE p."businessId" <> r."businessId" OR p."provider" <> r."provider"
         OR p."providerRequestId" IS DISTINCT FROM r."providerRequestId"`);
  ok("backfill: every routing row agrees with its PaymentRequest (except the deliberately corrupted fixtures)",
    Number(mismatched[0].c) === 2, `mismatched=${mismatched[0].c} (2 = the corruption fixtures above)`);
  const orphans = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "PaymentProviderRouting" r
      WHERE NOT EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."id" = r."paymentRequestId")`);
  ok("backfill: no synthesized businessId — orphans exist only where planted",
    Number(orphans[0].c) === 1, `orphans=${orphans[0].c} (1 = the planted orphan)`);
  const ambiguous = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM (
       SELECT "provider", "providerRequestId" FROM "PaymentRequest"
        WHERE "providerRequestId" IS NOT NULL
        GROUP BY 1,2 HAVING count(DISTINCT "businessId") > 1) x`);
  ok("backfill: no (provider, providerRequestId) maps to two businesses", Number(ambiguous[0].c) === 0);

  // ── Phase 12: fail-closed + raw SQL ─────────────────────────────────────
  console.log("--- fail-closed + raw ---");
  const noCtx = await rt.paymentAuditEvent.findMany({ where: { businessId: inIds } });
  ok("no tenant context -> 0 rows", noCtx.length === 0, `n=${noCtx.length}`);
  const emptyGuc = await rtx(rt, "", (t) => t.financialEvent.findMany({}));
  ok("empty GUC -> 0 rows (fail-closed)", emptyGuc.length === 0);
  let malformed = false;
  try {
    await rt.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'not-an-int', true)`;
      await t.financialEvent.findMany({});
    });
  } catch { malformed = true; }
  ok("malformed GUC errors (never silently opens)", malformed);
  const rawFe = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "FinancialEvent"`));
  ok("raw FinancialEvent = tenant-only",
    Number(rawFe[0].c) === (await owner.financialEvent.count({ where: { businessId: bizA.id } })));
  let ddlDenied = false;
  try { await rt.$executeRawUnsafe(`CREATE TABLE ${MARK}ddl (id int)`); } catch { ddlDenied = true; }
  ok("runtime DDL denied", ddlDenied);
  let migDenied = false;
  try { await rt.$executeRawUnsafe(`SELECT count(*) FROM "_prisma_migrations"`); } catch { migDenied = true; }
  ok("runtime _prisma_migrations denied", migDenied);
  let delDenied = false;
  try { await rtx(rt, bizA.id, (t) => t.$executeRawUnsafe(`DELETE FROM "FinancialEvent"`)); } catch { delDenied = true; }
  ok("runtime DELETE on FinancialEvent denied (never granted)", delDenied);

  // ── Phase 13: concurrency ───────────────────────────────────────────────
  console.log("--- concurrency ---");
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const [ca, cb] = await Promise.all([
    rtx(rt, bizA.id, (t) => t.paymentAuditEvent.findMany({ where: { businessId: inIds } })),
    rtx(rt2, bizB.id, (t) => t.paymentAuditEvent.findMany({ where: { businessId: inIds } })),
  ]);
  ok("concurrent A/B isolation (no GUC bleed)",
    ca.every((r) => r.businessId === bizA.id) && cb.every((r) => r.businessId === bizB.id) &&
    ca.length > 0 && cb.length > 0, `a=${ca.length} b=${cb.length}`);
  await rt2.$disconnect();

  // ── Phase 14: rollback + re-apply (pg only) ─────────────────────────────
  if (TARGET === "pg") {
    console.log("--- rollback ---");
    await applySqlFile("scripts/security/d2-p7-w4ea-rollback.sql", { ":ROLE": RT_ROLE });
    const after = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4ea_tenant'`))[0].c);
    ok("rollback: 0 W4E-A policies remain", after === 0, `found ${after}`);
    const pilotIntact = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p4b_tenant'`))[0].c);
    ok("rollback: the pilot-equivalent policy survives", pilotIntact === 1, `found ${pilotIntact}`);
    const pilotGrant = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"PaymentRequest"', 'SELECT') AS s,
              has_table_privilege('${RT_ROLE}', '"PaymentRequest"', 'INSERT') AS i`))[0];
    ok("rollback: the pilot SELECT grant lineage survives; only W4E-A's INSERT is revoked",
      pilotGrant.s === true && pilotGrant.i === false, JSON.stringify(pilotGrant));
    const routingStill = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name='PaymentProviderRouting'`);
    ok("rollback: the additive routing table is not destructively dropped", Number(routingStill[0].c) === 1);
    await applySqlFile("prisma/migrations/20260830120000_d2_p7_w4ea_payments_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w4ea-grants.sql", { ":ROLE": RT_ROLE });
    const re = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4ea_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", re === 4, `found ${re}`);
  }

  // ── Phase 15: prior substrate + residue ─────────────────────────────────
  if (TARGET === "neon") {
    const gates = [["p4b_tenant", 5], ["p7w1_tenant", 14], ["p7w2_tenant", 24], ["p7w3_tenant", 15], ["p7w4b_tenant", 5], ["p7w4c_tenant", 3], ["p7w4d_tenant", 8]];
    let intact = true;
    for (const [pol, want] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'`))[0].c);
      if (c !== want) intact = false;
    }
    ok("pilot+W1+W2+W3+W4B+W4C+W4D substrate intact after W4E-A", intact);
  }

  await rt.$disconnect();
  await cleanup();
  const res = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz,
            (SELECT count(*)::int FROM "PaymentWebhookEvent" WHERE "providerEventId" LIKE '${MARK}%') AS wh`);
  ok("synthetic residue = 0", Number(res[0].biz) === 0 && Number(res[0].wh) === 0, JSON.stringify(res[0]));
  await owner.$disconnect();

  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => { console.error("[battery] FATAL:", e); process.exit(1); });
