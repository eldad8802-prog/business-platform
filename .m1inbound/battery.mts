/* eslint-disable @typescript-eslint/no-explicit-any -- test battery: loose JSON bodies */
/**
 * M1 — INBOUND MONEY TRUTH, proven against real PostgreSQL.
 *
 *   "If CardCom took money, Dubiz eventually knows about it exactly once —
 *    regardless of a lost webhook, an early webhook, retry, timeout or owner
 *    cancellation."
 *
 * WHAT IS REAL. The CardCom webhook ROUTE, the reconciliation ROUTE and service,
 * production dependency wiring (payments.deps), the CardCom adapter speaking
 * real HTTP, AES-GCM-encrypted connection credentials, the Prisma store, the C3
 * settlement, receipt issuance and allocation, and the FinancialEvent projection.
 *
 * WHAT IS SIMULATED. Only CardCom's server: a local HTTP service answering
 * LowProfile/GetLpResult per LowProfile, whose answers the cases script.
 *
 * UNDER FORCE RLS. The application connects as a NOSUPERUSER NOBYPASSRLS role
 * (measured, not assumed), and the tenant policies on the payment and billing
 * tables are replayed VERBATIM from prisma/migrations — the same DDL Production
 * runs. Seeding and ground-truth reads use the owner connection (M1_ADMIN_URL).
 *
 * Cases:
 *   A normal webhook                     B duplicate webhook (sequential + concurrent)
 *   C webhook completely lost            D early webhook → UNKNOWN → later PAID
 *   E verification temporarily failing   F concurrent reconciliation + webhook
 *   G cancelled request → later PAID     H cancel racing the verified payment
 *   I verified amount mismatch           J verified currency mismatch
 *   K PAID without provider tx id        L PAID without verified amount
 *   M duplicate provider transaction id  N cross-tenant isolation
 *   P F5 strict response codes / foreign ReturnValue
 *   R reconciliation route: auth, healthy run, degraded run
 *   S a forged callback with a chosen event id cannot pre-empt the real payment
 *   T an old lost payment behind many newer closed requests is still found
 *   Q the Production QA scenario: invoice 10, collect 5, receipt 5, outstanding 10 → 5
 *
 * Every successful path ends with exactly one incoming PaymentTransaction, one
 * PaymentAccountingSettlement, one automatic receipt, one FinancialEvent, and the
 * correct allocation. M1_ONLY=A,C… runs a subset (used by CI negative proofs).
 *
 * Synthetic data only. No secrets, no Neon, no real provider, no network beyond
 * localhost.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BillingDocumentStatus, BillingDocumentType, Prisma, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma as appPrisma } from "../lib/prisma";
import { runWithTenantContext } from "../lib/tenant/context";
import { createPaymentPrismaStore } from "../lib/services/payments/payment-store.prisma";
import { encryptPaymentCredential } from "../lib/services/payments/payment-crypto.service";
import { paymentReconciliationDeps } from "../lib/services/payments/payments.deps";
import {
  runPaymentReconciliation,
  type PaymentReconciliationReport,
} from "../lib/services/payments/payment-reconciliation.service";
import { cancelPaymentRequest } from "../lib/services/payments/payment-request-cancel.service";
import {
  requeueSettlement,
  settleVerifiedPayment,
} from "../lib/services/billing/settlement/payment-accounting-settlement.service";
import { loadCustomerFinancialThread } from "../lib/services/billing/collection/customer-financial-thread.service";
import * as cardcomWebhookRoute from "../app/api/payments/webhook/cardcom/route";
import * as reconciliationRoute from "../app/api/payments/reconciliation/route";

const ADMIN_URL = process.env.M1_ADMIN_URL;
if (!ADMIN_URL) {
  console.log("[FAIL] M1_ADMIN_URL is not set — the owner connection seeds and reads ground truth");
  process.exit(1);
}
const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
const store = createPaymentPrismaStore();
const ONLY = (process.env.M1_ONLY ?? "").split(",").filter(Boolean);
const run = (c: string) => ONLY.length === 0 || ONLY.includes(c);
const ITER = Number(process.env.M1_ITER ?? 15);

process.env.PAYMENTS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.CRON_SECRET = randomBytes(24).toString("hex"); // 48 chars
const TERMINAL = "1000";
const API_NAME = "m1-api";

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
const D = (v: string | number) => new Prisma.Decimal(v);
const PAST = () => new Date(Date.now() - 10 * 60_000); // older than reconciliation's minimum age
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${++seq}`;

// ── the CardCom simulator ─────────────────────────────────────────────────────

type LpState =
  | { mode: "none" }
  | {
      mode: "paid" | "declined";
      tranId?: number | null;
      amount?: number | null;
      coinId?: number | null;
      returnValue?: string | null;
      nullCodes?: boolean;
    }
  | { mode: "http"; status: number }
  | { mode: "reset" };

const lp = new Map<string, { state: LpState; returnValue: string; calls: number }>();
let authFailures = 0;

function answer(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const cardcom = createServer(async (req, res) => {
  const body = await readJson(req);
  if (req.url !== "/api/v11/LowProfile/GetLpResult" || !body) return answer(res, 404, {});
  if (String(body.TerminalNumber) !== TERMINAL || body.ApiName !== API_NAME) {
    authFailures++;
    return answer(res, 200, { ResponseCode: 5, Description: "authentication failed" });
  }
  const entry = lp.get(String(body.LowProfileId));
  if (!entry) return answer(res, 200, { ResponseCode: 0, TranzactionInfo: null });
  entry.calls++;
  const s = entry.state;
  if (s.mode === "reset") return req.socket.destroy();
  if (s.mode === "http") return answer(res, s.status, { Description: "unavailable" });
  const base = {
    ResponseCode: 0,
    Description: "OK",
    TerminalNumber: Number(TERMINAL),
    LowProfileId: body.LowProfileId,
    ReturnValue: entry.returnValue,
  };
  if (s.mode === "none") return answer(res, 200, { ...base, TranzactionInfo: null });
  const info: Record<string, unknown> = {
    ResponseCode: s.mode === "paid" ? 0 : 5,
    TerminalNumber: Number(TERMINAL),
  };
  if (s.tranId !== null) info.TranzactionId = s.tranId ?? 0;
  if (s.amount !== null) info.Amount = s.amount;
  if (s.coinId !== null) info.CoinId = s.coinId ?? 1;
  if (s.nullCodes) {
    return answer(res, 200, { ...base, ResponseCode: null, TranzactionInfo: { ...info, ResponseCode: null } });
  }
  return answer(res, 200, {
    ...base,
    ...(s.returnValue !== undefined ? { ReturnValue: s.returnValue } : {}),
    TranzactionInfo: info,
  });
});

let nextTranId = 5_000_000 + Math.floor(Math.random() * 1_000_000);
const tranId = () => ++nextTranId;

// ── RLS: the Production policies, replayed verbatim ──────────────────────────

const RLS_TABLES = [
  "PaymentRequest",
  "PaymentTransaction",
  "BusinessPaymentConnection",
  "PaymentAuditEvent",
  "FinancialEvent",
  "PaymentAccountingSettlement",
  "BillingDocument",
  "BillingDocumentLine",
  "BillingPaymentAllocation",
  "BillingReceiptPayment",
  "BillingDocumentNumberSequence",
  "BillingAuditEvent",
  "Customer",
  "BusinessProfile",
];

function rlsStatementsFromMigrations(): string[] {
  const dir = join(process.cwd(), "prisma", "migrations");
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "migration.sql");
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, "utf8").replace(/--[^\n]*/g, "");
    for (const raw of sql.split(";")) {
      const s = raw.trim().replace(/\s+/g, " ");
      const table = /(?:^ALTER TABLE|\bON) "([A-Za-z]+)"/.exec(s)?.[1];
      if (!table || !RLS_TABLES.includes(table)) continue;
      if (
        /^ALTER TABLE "[A-Za-z]+" (ENABLE|FORCE) ROW LEVEL SECURITY$/i.test(s) ||
        /^(CREATE|DROP|ALTER) POLICY\b/i.test(s)
      ) {
        out.push(s);
      }
    }
  }
  return out;
}

async function installProductionRls() {
  const statements = rlsStatementsFromMigrations();
  let applied = 0;
  const refused: string[] = [];
  for (const s of statements) {
    try {
      await admin.$executeRawUnsafe(s);
      applied++;
    } catch (e: any) {
      refused.push(`${s.slice(0, 80)} … ${String(e?.meta?.message ?? e?.message ?? e).slice(0, 80)}`);
    }
  }
  const rows = await admin.$queryRaw<{ relname: string; rls: boolean; forced: boolean; policies: bigint }[]>`
    SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c WHERE c.relname = ANY(${RLS_TABLES}) AND c.relkind = 'r'`;
  const unprotected = RLS_TABLES.filter((t) => {
    const r = rows.find((x) => x.relname === t);
    return !r || !r.rls || !r.forced || Number(r.policies) === 0;
  });
  ok(
    `RLS — ${applied} statements replayed from prisma/migrations; every payment/billing table ENABLE+FORCE with policies`,
    unprotected.length === 0,
    `unprotected: ${unprotected.join(", ")}${refused.length ? ` | refused: ${refused.join(" || ")}` : ""}`
  );
  const role = await appPrisma.$queryRaw<{ user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user AS "user", rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  ok(
    `the application runs as a NOSUPERUSER NOBYPASSRLS role (${role[0]?.user})`,
    role.length === 1 && role[0].rolsuper === false && role[0].rolbypassrls === false,
    JSON.stringify(role)
  );
}

// ── tenants, invoices, requests ───────────────────────────────────────────────

type Ctx = { businessId: number; actorUserId: number; customerId: number };
const created: number[] = [];

async function makeBusiness(label: string): Promise<Ctx> {
  const stamp = `${label}-${uniq()}`;
  const business = await admin.business.create({ data: { name: `m1-${stamp}` } });
  created.push(business.id);
  const actor = await admin.user.create({
    data: { email: `m1-${stamp}@example.test`, password: "synthetic", businessId: business.id, role: "USER" },
  });
  await admin.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "M1 Synthetic",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingAddress: "1 Test St",
      billingPhone: "0500000000",
      billingEmail: "m1@example.test",
    },
  });
  const customer = await admin.customer.create({ data: { businessId: business.id, name: "M1 Customer" } });
  const cred = encryptPaymentCredential(
    JSON.stringify({ apiName: API_NAME, apiPassword: "m1-pw" }),
    business.id,
    "CARDCOM"
  );
  await admin.businessPaymentConnection.create({
    data: { businessId: business.id, provider: "CARDCOM", isActive: true, merchantId: TERMINAL, ...cred },
  });
  return { businessId: business.id, actorUserId: actor.id, customerId: customer.id };
}

let invoiceNo = 0;
async function invoice(ctx: Ctx, total: string) {
  invoiceNo += 1;
  return admin.billingDocument.create({
    data: {
      businessId: ctx.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
      customerId: ctx.customerId,
      customerNameSnapshot: "M1 Customer",
      currency: "ILS",
      subtotalAmount: "0",
      vatAmount: "0",
      totalAmount: total,
      documentNumber: 700000 + invoiceNo + Math.floor(Math.random() * 1000) * 1000,
      documentNumberFormatted: `M1-${invoiceNo}-${uniq()}`,
      issuedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    },
  });
}

async function request(
  ctx: Ctx,
  amount: string,
  opts: { invoiceId?: number | null; currency?: string; status?: "PENDING" | "CANCELLED" | "EXPIRED" | "FAILED" } = {}
) {
  const lowProfileId = randomUUID();
  const req = await admin.paymentRequest.create({
    data: {
      businessId: ctx.businessId,
      customerId: ctx.customerId,
      billingDocumentId: opts.invoiceId ?? null,
      provider: "CARDCOM",
      amount,
      currency: opts.currency ?? "ILS",
      status: opts.status ?? "PENDING",
      providerRequestId: lowProfileId,
      createdAt: PAST(),
    },
  });
  await admin.paymentProviderRouting.create({
    data: { provider: "CARDCOM", providerRequestId: lowProfileId, paymentRequestId: req.id, businessId: ctx.businessId },
  });
  lp.set(lowProfileId, { state: { mode: "none" }, returnValue: String(req.id), calls: 0 });
  return { ...req, lowProfileId };
}

function provider(lowProfileId: string, state: LpState) {
  const entry = lp.get(lowProfileId)!;
  entry.state = state;
}

// ── the two ways in ───────────────────────────────────────────────────────────

async function webhook(req: { id: number; lowProfileId: string }, extra: Record<string, unknown> = {}) {
  const r = new NextRequest("https://app.test/api/payments/webhook/cardcom", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ LowProfileId: req.lowProfileId, ReturnValue: String(req.id), ...extra }),
  });
  const res = await cardcomWebhookRoute.POST(r);
  return res.status;
}

/** Reconciliation for the given tenants only — production deps, scoped candidate list. */
async function reconcile(...ctxs: Ctx[]): Promise<PaymentReconciliationReport> {
  const ids = ctxs.map((c) => c.businessId);
  return runPaymentReconciliation(
    { ...paymentReconciliationDeps(), listBusinessIds: async () => ids },
    { maxChecks: 1000, maxPerBusiness: 1000, timeBudgetMs: 120_000 }
  );
}

/** The reconciliation ROUTE, exactly as the scheduler calls it. */
async function reconcileRoute(authorization: string | null) {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.authorization = authorization;
  const res = await reconciliationRoute.POST(
    new NextRequest("https://app.test/api/payments/reconciliation", { method: "POST", headers })
  );
  return { status: res.status, body: (await res.json()) as any };
}

// ── ground truth (owner connection) ───────────────────────────────────────────

async function truth(requestId: number) {
  const req = await admin.paymentRequest.findUniqueOrThrow({ where: { id: requestId } });
  const incoming = await admin.paymentTransaction.findMany({
    where: { paymentRequestId: requestId, status: "PAID", amount: { gt: 0 } },
  });
  const ids = incoming.map((t) => t.id);
  const settlements = await admin.paymentAccountingSettlement.findMany({ where: { paymentTransactionId: { in: ids } } });
  const receipts = await admin.billingDocument.findMany({
    where: { sourcePaymentTransactionId: { in: ids }, documentType: BillingDocumentType.RECEIPT },
    include: { paymentAllocationsAsReceipt: true },
  });
  const events = await admin.financialEvent.count({
    where: { sourceType: "PAYMENT", sourceKey: { in: ids.map(String) } },
  });
  const allocated = receipts
    .flatMap((r) => r.paymentAllocationsAsReceipt)
    .reduce((s, a) => s.plus(a.allocatedAmount), D(0));
  return { req, incoming, settlements, receipts, events, allocated };
}

async function exactlyOnce(label: string, requestId: number, expect: { amount: string; allocated: string }) {
  const t = await truth(requestId);
  ok(`${label} — exactly 1 incoming PaymentTransaction`, t.incoming.length === 1, `got ${t.incoming.length}`);
  ok(
    `${label} — the money is what the provider verified (${expect.amount})`,
    t.incoming[0]?.amount.equals(D(expect.amount)) ?? false,
    String(t.incoming[0]?.amount)
  );
  ok(
    `${label} — exactly 1 settlement, SETTLED`,
    t.settlements.length === 1 && t.settlements[0].status === "SETTLED",
    JSON.stringify(t.settlements.map((s) => s.status))
  );
  ok(
    `${label} — exactly 1 automatic receipt, ISSUED, by no person`,
    t.receipts.length === 1 && t.receipts[0].status === "ISSUED" && t.receipts[0].issuedByUserId === null,
    `receipts=${t.receipts.length}`
  );
  ok(`${label} — allocation ${expect.allocated}`, t.allocated.equals(D(expect.allocated)), t.allocated.toString());
  ok(`${label} — exactly 1 money-in FinancialEvent`, t.events === 1, `events=${t.events}`);
  ok(`${label} — request is PAID`, t.req.status === "PAID", t.req.status);
  return t;
}

async function nothingRecorded(label: string, requestId: number, status: string) {
  const t = await truth(requestId);
  ok(
    `${label} — nothing recorded: no money row, no settlement, no receipt`,
    t.incoming.length === 0 && t.settlements.length === 0 && t.receipts.length === 0 && t.events === 0,
    `incoming=${t.incoming.length}`
  );
  ok(`${label} — request stays ${status}`, t.req.status === status, t.req.status);
}

async function outstanding(ctx: Ctx, invoiceId: number): Promise<string> {
  const doc = await runWithTenantContext({ businessId: ctx.businessId }, () =>
    store.findPayableDocument(ctx.businessId, invoiceId)
  );
  return doc ? D(doc.outstandingAmount).toFixed(2) : "missing";
}

async function events(requestId: number, eventType: string) {
  return admin.paymentAuditEvent.findMany({ where: { paymentRequestId: requestId, eventType } });
}

async function webhookEvents(lowProfileId: string) {
  return admin.paymentWebhookEvent.findMany({ where: { providerEventId: lowProfileId } });
}

// ── cases ─────────────────────────────────────────────────────────────────────

async function main() {
  await new Promise<void>((r) => cardcom.listen(0, "127.0.0.1", () => r()));
  process.env.CARDCOM_BASE_URL = `http://127.0.0.1:${(cardcom.address() as AddressInfo).port}`;
  console.log(`CardCom simulator on ${process.env.CARDCOM_BASE_URL}`);

  console.log("\n== RLS / runtime role ==");
  await installProductionRls();

  if (run("R")) {
    // Run first: the route scans every routed tenant, and later cases leave
    // deliberate anomalies behind.
    console.log("\n== R — the reconciliation route, as the scheduler calls it ==");
    // The route reconciles EVERY routed tenant. Tenants left by an earlier run
    // carry credentials encrypted under that run's key, which this run cannot
    // decrypt — the route rightly reports them as verification errors. R's
    // "healthy" claims are therefore only meaningful on a fresh database.
    const preexisting = await admin.paymentProviderRouting.count();
    ok("R — precondition: a fresh database (no routed tenants yet)", preexisting === 0, `${preexisting} routing rows already present — recreate the database`);
    const noAuth = await reconcileRoute(null);
    ok("R — no bearer → 401, nothing run", noAuth.status === 401, String(noAuth.status));
    const wrong = await reconcileRoute("Bearer not-the-secret-not-the-secret-not-the");
    ok("R — wrong bearer → 401", wrong.status === 401, String(wrong.status));

    const ctx = await makeBusiness("R");
    const inv = await invoice(ctx, "300.00");
    const req = await request(ctx, "300.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 300, coinId: 1 });
    const first = await reconcileRoute(`Bearer ${process.env.CRON_SECRET}`);
    ok("R — a healthy run answers 200", first.status === 200 && first.body.ok === true, JSON.stringify(first.body));
    ok("R — the lost payment was discovered by the route", (first.body.report?.recorded ?? 0) >= 1, JSON.stringify(first.body.report));
    ok("R — the response carries counts only", !JSON.stringify(first.body).includes(req.lowProfileId));
    await exactlyOnce("R", req.id, { amount: "300.00", allocated: "300.00" });
    const again = await reconcileRoute(`Bearer ${process.env.CRON_SECRET}`);
    ok("R — a second run records nothing new", again.status === 200 && (again.body.report?.recorded ?? -1) === 0, JSON.stringify(again.body.report));
    await exactlyOnce("R (after second run)", req.id, { amount: "300.00", allocated: "300.00" });
  }

  if (run("A")) {
    console.log("\n== A — normal webhook ==");
    const ctx = await makeBusiness("A");
    const inv = await invoice(ctx, "1000.00");
    const req = await request(ctx, "400.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 400, coinId: 1 });
    const status = await webhook(req);
    ok("A — the webhook route answers 200", status === 200);
    await exactlyOnce("A", req.id, { amount: "400.00", allocated: "400.00" });
    ok("A — outstanding 1000 → 600", (await outstanding(ctx, inv.id)) === "600.00");
    const ev = await webhookEvents(req.lowProfileId);
    ok("A — the event is consumed (PROCESSED)", ev.length === 1 && ev[0].processingStatus === "PROCESSED", JSON.stringify(ev.map((e) => e.processingStatus)));
  }

  if (run("B")) {
    console.log(`\n== B — duplicate webhook: sequential x3, then ${ITER} concurrent ==`);
    const ctx = await makeBusiness("B");
    const inv = await invoice(ctx, "500.00");
    const req = await request(ctx, "500.00", { invoiceId: inv.id });
    const id = tranId();
    provider(req.lowProfileId, { mode: "paid", tranId: id, amount: 500, coinId: 1 });
    for (let i = 0; i < 3; i++) await webhook(req);
    // CardCom's real callbacks carry the transaction id too — a distinct event id.
    await Promise.all(Array.from({ length: ITER }, (_, i) => webhook(req, i % 2 ? { TranzactionId: id } : {})));
    await exactlyOnce("B", req.id, { amount: "500.00", allocated: "500.00" });
    ok("B — outstanding 500 → 0, once", (await outstanding(ctx, inv.id)) === "0.00");
  }

  if (run("C")) {
    console.log("\n== C — webhook completely lost ==");
    const ctx = await makeBusiness("C");
    const inv = await invoice(ctx, "250.00");
    const req = await request(ctx, "250.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 250, coinId: 1 });
    await nothingRecorded("C (before reconciliation, no webhook ever)", req.id, "PENDING");
    const r1 = await reconcile(ctx);
    ok("C — reconciliation discovered and recorded it", r1.recorded === 1 && r1.healthy, JSON.stringify(r1));
    await exactlyOnce("C", req.id, { amount: "250.00", allocated: "250.00" });
    const audit = await events(req.id, "PAYMENT_VERIFIED_PAID");
    ok("C — audited as established by reconciliation", audit.length === 1 && (audit[0].metadata as any)?.source === "RECONCILIATION");
    const callsBefore = lp.get(req.lowProfileId)!.calls;
    const r2 = await reconcile(ctx);
    ok("C — running reconciliation again changes nothing", r2.recorded === 0 && r2.checked === 0 && r2.healthy, JSON.stringify(r2));
    ok("C — a PAID request is not asked about again", lp.get(req.lowProfileId)!.calls === callsBefore);
    await exactlyOnce("C (after second run)", req.id, { amount: "250.00", allocated: "250.00" });
    ok("C — outstanding 250 → 0", (await outstanding(ctx, inv.id)) === "0.00");
  }

  if (run("D")) {
    console.log("\n== D — early webhook → UNKNOWN → later PAID ==");
    // D1: the provider decides later, and the SAME early signal is redelivered.
    const ctx = await makeBusiness("D");
    const inv = await invoice(ctx, "180.00");
    const req = await request(ctx, "180.00", { invoiceId: inv.id });
    await webhook(req); // CardCom has no outcome yet
    await nothingRecorded("D1 (early signal)", req.id, "PENDING");
    let ev = await webhookEvents(req.lowProfileId);
    ok("D1 — the early event is NOT consumed (RECEIVED)", ev.length === 1 && ev[0].processingStatus === "RECEIVED", JSON.stringify(ev.map((e) => e.processingStatus)));
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 180, coinId: 1 });
    await webhook(req); // the very same body — same event id
    await exactlyOnce("D1 (redelivered signal)", req.id, { amount: "180.00", allocated: "180.00" });
    ev = await webhookEvents(req.lowProfileId);
    ok("D1 — one event row, now PROCESSED", ev.length === 1 && ev[0].processingStatus === "PROCESSED");

    // D2: the provider decides later and nothing is redelivered.
    const req2 = await request(ctx, "90.00");
    await webhook(req2);
    await nothingRecorded("D2 (early signal)", req2.id, "PENDING");
    provider(req2.lowProfileId, { mode: "paid", tranId: tranId(), amount: 90, coinId: 1 });
    const r = await reconcile(ctx);
    ok("D2 — reconciliation records the payment the early signal could not", r.recorded === 1, JSON.stringify(r));
    await exactlyOnce("D2", req2.id, { amount: "90.00", allocated: "0.00" });
  }

  if (run("E")) {
    console.log("\n== E — provider verification temporarily unavailable ==");
    const ctx = await makeBusiness("E");
    const inv = await invoice(ctx, "70.00");
    const req = await request(ctx, "70.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "http", status: 503 });
    await webhook(req);
    const r1 = await reconcile(ctx);
    ok("E — HTTP 503 is a verification error, and the run is NOT healthy", r1.verificationErrors === 1 && !r1.healthy, JSON.stringify(r1));
    await nothingRecorded("E (503)", req.id, "PENDING");
    provider(req.lowProfileId, { mode: "reset" });
    const r2 = await reconcile(ctx);
    ok("E — a dropped connection is a verification error, NOT healthy", r2.verificationErrors === 1 && !r2.healthy, JSON.stringify(r2));
    await nothingRecorded("E (connection reset)", req.id, "PENDING");
    ok("E — nothing was marked PAID or FAILED by inference", (await admin.paymentTransaction.count({ where: { paymentRequestId: req.id } })) === 0);
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 70, coinId: 1 });
    const r3 = await reconcile(ctx);
    ok("E — once CardCom answers, the payment is recorded", r3.recorded === 1 && r3.healthy, JSON.stringify(r3));
    await exactlyOnce("E", req.id, { amount: "70.00", allocated: "70.00" });
  }

  if (run("F")) {
    console.log(`\n== F — concurrent reconciliation + webhook, ${ITER} iterations ==`);
    const ctx = await makeBusiness("F");
    const tally = { exact: 0, wrong: 0 };
    let sample = "";
    for (let i = 0; i < ITER; i++) {
      const inv = await invoice(ctx, "100.00");
      const req = await request(ctx, "100.00", { invoiceId: inv.id });
      provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 100, coinId: 1 });
      await Promise.all([webhook(req), reconcile(ctx), webhook(req), reconcile(ctx)]);
      const t = await truth(req.id);
      const good =
        t.incoming.length === 1 &&
        t.settlements.length === 1 &&
        t.settlements[0].status === "SETTLED" &&
        t.receipts.length === 1 &&
        t.allocated.equals(D(100)) &&
        t.events === 1 &&
        t.req.status === "PAID";
      if (good) tally.exact++;
      else {
        tally.wrong++;
        sample = `tx=${t.incoming.length} set=${t.settlements.length} rc=${t.receipts.length} alloc=${t.allocated} ev=${t.events} st=${t.req.status}`;
      }
    }
    ok(`F — ${ITER}/${ITER} races ended exactly once`, tally.wrong === 0, `${JSON.stringify(tally)} ${sample}`);
  }

  if (run("G")) {
    console.log("\n== G — cancelled request → later verified PAID ==");
    const ctx = await makeBusiness("G");
    const inv = await invoice(ctx, "60.00");
    const req = await request(ctx, "60.00", { invoiceId: inv.id });
    await runWithTenantContext({ businessId: ctx.businessId }, () =>
      cancelPaymentRequest({ businessId: ctx.businessId, requestId: req.id, actorUserId: ctx.actorUserId }, { store })
    );
    ok("G — the owner cancelled it", (await admin.paymentRequest.findUniqueOrThrow({ where: { id: req.id } })).status === "CANCELLED");
    // The customer still pays through the link. Its webhook is lost.
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 60, coinId: 1 });
    const r = await reconcile(ctx);
    ok("G — reconciliation still asks about a cancelled request, and records the money", r.recorded === 1 && r.paidAfterClosed === 1, JSON.stringify(r));
    await exactlyOnce("G", req.id, { amount: "60.00", allocated: "60.00" });
    ok("G — the cancellation stays on the record", (await events(req.id, "PAYMENT_REQUEST_CANCELLED")).length === 1);
    const after = await events(req.id, "PAYMENT_PAID_AFTER_REQUEST_CLOSED");
    ok("G — the paid-after-cancellation fact is audited", after.length === 1 && (after[0].metadata as any)?.previousStatus === "CANCELLED");
    // The owner's customer thread — the same read model the screen renders.
    const thread = await loadCustomerFinancialThread(ctx.businessId, ctx.customerId);
    const mine = thread.events.filter((e: any) => e.requestId === req.id);
    const created = mine.find((e) => e.kind === "REQUEST_CREATED") as any;
    const cancelled = mine.find((e) => e.kind === "REQUEST_CANCELLED") as any;
    ok("G — the owner's thread shows the request as PAID", created?.status === "PAID", JSON.stringify(created));
    ok("G — the thread keeps the cancellation, marked as paid afterwards", cancelled?.paidAfterward === true, JSON.stringify(cancelled));
    ok("G — the thread shows the verified payment", mine.some((e) => e.kind === "PAYMENT_VERIFIED"));
  }

  if (run("H")) {
    console.log(`\n== H — owner cancel racing the verified payment, ${ITER} iterations ==`);
    const ctx = await makeBusiness("H");
    const tally = { paidExactlyOnce: 0, wrong: 0, cancelWon: 0, cancelRefused: 0 };
    let sample = "";
    for (let i = 0; i < ITER; i++) {
      const inv = await invoice(ctx, "40.00");
      const req = await request(ctx, "40.00", { invoiceId: inv.id });
      provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 40, coinId: 1 });
      const jitter = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const [, cancel] = await Promise.allSettled([
        (async () => {
          if (i % 2 === 1) await jitter(Math.floor(Math.random() * 40));
          return webhook(req);
        })(),
        (async () => {
          if (i % 2 === 0) await jitter(Math.floor(Math.random() * 40));
          return runWithTenantContext({ businessId: ctx.businessId }, () =>
            cancelPaymentRequest({ businessId: ctx.businessId, requestId: req.id, actorUserId: ctx.actorUserId }, { store })
          );
        })(),
      ]);
      if (cancel.status === "fulfilled") tally.cancelWon++;
      else tally.cancelRefused++;
      const t = await truth(req.id);
      if (t.incoming.length === 1 && t.receipts.length === 1 && t.settlements[0]?.status === "SETTLED" && t.req.status === "PAID") {
        tally.paidExactlyOnce++;
      } else {
        tally.wrong++;
        sample = `tx=${t.incoming.length} rc=${t.receipts.length} st=${t.req.status}`;
      }
    }
    ok(`H — money wins every race: ${ITER}/${ITER} PAID exactly once`, tally.wrong === 0, `${JSON.stringify(tally)} ${sample}`);
    console.log(`    (cancel won ${tally.cancelWon}, refused ${tally.cancelRefused} — either way the money is PAID)`);

    // H2 — the exact interleaving that used to paint real money CANCELLED:
    // the owner's cancel READS the request while it is still PENDING, the
    // verified payment then lands and moves it to PAID, and only then does the
    // cancel WRITE. Forced deterministically by handing cancel its stale read.
    console.log("\n== H2 — cancel with a stale read, after the money landed ==");
    const inv = await invoice(ctx, "45.00");
    const req = await request(ctx, "45.00", { invoiceId: inv.id });
    const staleView = await runWithTenantContext({ businessId: ctx.businessId }, () =>
      store.findPaymentRequestById(req.id)
    );
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 45, coinId: 1 });
    await webhook(req);
    const staleStore = {
      ...store,
      findPaymentRequestById: async () => staleView,
      listTransactionsByRequest: async () => [],
    };
    let refused = false;
    try {
      await runWithTenantContext({ businessId: ctx.businessId }, () =>
        cancelPaymentRequest(
          { businessId: ctx.businessId, requestId: req.id, actorUserId: ctx.actorUserId },
          { store: staleStore }
        )
      );
    } catch {
      refused = true;
    }
    ok("H2 — the stale cancel is refused by the database, not applied", refused);
    await exactlyOnce("H2", req.id, { amount: "45.00", allocated: "45.00" });
    ok("H2 — no cancellation was recorded over the money", (await events(req.id, "PAYMENT_REQUEST_CANCELLED")).length === 0);
  }

  if (run("I")) {
    console.log("\n== I — verified amount differs from the request ==");
    const ctx = await makeBusiness("I");
    const inv = await invoice(ctx, "100.00");
    const req = await request(ctx, "100.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 120, coinId: 1 });
    await webhook(req);
    const t = await truth(req.id);
    ok("I — the money is recorded as CardCom verified it (120.00), not normalised", t.incoming.length === 1 && t.incoming[0].amount.equals(D(120)), String(t.incoming[0]?.amount));
    ok(
      "I — settlement paused: REQUIRES_ATTENTION / VERIFIED_AMOUNT_MISMATCH",
      t.settlements.length === 1 && t.settlements[0].status === "REQUIRES_ATTENTION" && t.settlements[0].attentionReason === "VERIFIED_AMOUNT_MISMATCH",
      JSON.stringify(t.settlements.map((s) => [s.status, s.attentionReason]))
    );
    ok("I — no receipt, no allocation", t.receipts.length === 0 && t.allocated.equals(D(0)));
    ok("I — the invoice is untouched (outstanding 100)", (await outstanding(ctx, inv.id)) === "100.00");
    const ev = await events(req.id, "PAYMENT_VERIFIED_AMOUNT_MISMATCH");
    const m = ev[0]?.metadata as any;
    ok("I — evidence audited: requested 100, verified 120.00", ev.length === 1 && m?.requestedAmount === "100" && m?.verifiedAmount === "120.00", JSON.stringify(m));
    // A person retrying cannot push it through: the check is deterministic.
    await runWithTenantContext({ businessId: ctx.businessId }, () =>
      requeueSettlement({ businessId: ctx.businessId, paymentTransactionId: t.incoming[0].id })
    ).catch(() => undefined);
    const retry = await settleVerifiedPayment({ businessId: ctx.businessId, paymentTransactionId: t.incoming[0].id });
    ok("I — a retry pauses again, still no receipt", retry.outcome === "REQUIRES_ATTENTION" && (await truth(req.id)).receipts.length === 0, JSON.stringify(retry));
    const r = await reconcile(ctx);
    ok("I — reconciliation does not record it a second time", r.recorded === 0 && (await truth(req.id)).incoming.length === 1, JSON.stringify(r));
  }

  if (run("J")) {
    console.log("\n== J — verified currency differs from the request ==");
    const ctx = await makeBusiness("J");
    const inv = await invoice(ctx, "50.00");
    const req = await request(ctx, "50.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 50, coinId: 2 }); // 2 = USD
    const r = await reconcile(ctx);
    ok("J — reported as a currency anomaly; the run is NOT healthy", r.anomalies.currencyMismatch === 1 && !r.healthy, JSON.stringify(r));
    const t = await truth(req.id);
    ok("J — recorded in the currency CardCom verified (USD)", t.incoming.length === 1 && t.incoming[0].currency === "USD", t.incoming[0]?.currency);
    ok(
      "J — settlement paused: VERIFIED_CURRENCY_MISMATCH, no receipt",
      t.settlements[0]?.status === "REQUIRES_ATTENTION" && t.settlements[0]?.attentionReason === "VERIFIED_CURRENCY_MISMATCH" && t.receipts.length === 0,
      JSON.stringify(t.settlements.map((s) => [s.status, s.attentionReason]))
    );
    ok("J — evidence audited", (await events(req.id, "PAYMENT_VERIFIED_CURRENCY_MISMATCH")).length === 1);
    ok("J — the invoice is untouched", (await outstanding(ctx, inv.id)) === "50.00");
  }

  if (run("K")) {
    console.log("\n== K — PAID without the provider's transaction id ==");
    const ctx = await makeBusiness("K");
    const inv = await invoice(ctx, "30.00");
    const req = await request(ctx, "30.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: null, amount: 30, coinId: 1 });
    // The callback body even offers a transaction id — it must not be used.
    await webhook(req, { TranzactionId: 424242 });
    const r1 = await reconcile(ctx);
    const r2 = await reconcile(ctx);
    ok("K — reported as an anomaly on every run; NOT healthy", r1.anomalies.paidWithoutTransactionId === 1 && r2.anomalies.paidWithoutTransactionId === 1 && !r1.healthy, JSON.stringify(r1));
    await nothingRecorded("K", req.id, "PENDING");
    ok("K — the callback's claimed id was not recorded anywhere", (await admin.paymentTransaction.count({ where: { providerTransactionId: "424242" } })) === 0);
    ok("K — audited once, not once per run", (await events(req.id, "PAYMENT_VERIFIED_WITHOUT_TRANSACTION_ID")).length === 1);
    ok("K — NULL cannot open a second path: zero rows with a NULL provider id for this request", (await admin.paymentTransaction.count({ where: { paymentRequestId: req.id, providerTransactionId: null } })) === 0);
  }

  if (run("L")) {
    console.log("\n== L — PAID without a verified amount ==");
    const ctx = await makeBusiness("L");
    const req = await request(ctx, "30.00");
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: null, coinId: 1 });
    const r = await reconcile(ctx);
    ok("L — reported as an anomaly; NOT healthy", r.anomalies.paidWithoutVerifiedAmount === 1 && !r.healthy, JSON.stringify(r));
    await nothingRecorded("L", req.id, "PENDING");
    ok("L — audited", (await events(req.id, "PAYMENT_VERIFIED_WITHOUT_AMOUNT")).length === 1);
  }

  if (run("M")) {
    console.log("\n== M — duplicate provider transaction id across two requests ==");
    const ctx = await makeBusiness("M");
    const inv = await invoice(ctx, "80.00");
    const first = await request(ctx, "80.00", { invoiceId: inv.id });
    const second = await request(ctx, "80.00", { invoiceId: inv.id });
    const shared = tranId();
    provider(first.lowProfileId, { mode: "paid", tranId: shared, amount: 80, coinId: 1 });
    await webhook(first);
    await exactlyOnce("M (first request)", first.id, { amount: "80.00", allocated: "80.00" });
    provider(second.lowProfileId, { mode: "paid", tranId: shared, amount: 80, coinId: 1 });
    await webhook(second);
    const r = await reconcile(ctx);
    ok("M — reported as a transaction conflict; NOT healthy", r.anomalies.transactionConflict === 1 && !r.healthy, JSON.stringify(r));
    await nothingRecorded("M (second request)", second.id, "PENDING");
    ok("M — the conflict is audited", (await events(second.id, "PAYMENT_PROVIDER_TRANSACTION_CONFLICT")).length === 1);
    await exactlyOnce("M (first request, untouched)", first.id, { amount: "80.00", allocated: "80.00" });
    ok("M — the database holds one row for that provider transaction", (await admin.paymentTransaction.count({ where: { provider: "CARDCOM", providerTransactionId: String(shared) } })) === 1);
  }

  if (run("N")) {
    console.log("\n== N — cross-tenant isolation ==");
    const a = await makeBusiness("N-A");
    const b = await makeBusiness("N-B");
    const reqA = await request(a, "55.00");
    provider(reqA.lowProfileId, { mode: "paid", tranId: tranId(), amount: 55, coinId: 1 });
    const rb = await reconcile(b);
    ok("N — reconciling tenant B never touches tenant A's payment", rb.checked === 0 && (await truth(reqA.id)).incoming.length === 0, JSON.stringify(rb));
    const seen = await runWithTenantContext({ businessId: b.businessId }, async () => ({
      byId: await store.findPaymentRequestById(reqA.id),
      candidates: await store.listReconciliationCandidates(a.businessId, {
        createdAfter: new Date(0),
        createdBefore: new Date(),
        limit: 100,
      }),
    }));
    ok("N — under B's context the database hides A's request, even by id", seen.byId === null);
    ok("N — under B's context A's candidates are invisible, even with A's id in the predicate", seen.candidates.length === 0, String(seen.candidates.length));
    const ra = await reconcile(a);
    ok("N — tenant A's own reconciliation records it", ra.recorded === 1, JSON.stringify(ra));
    const tA = await truth(reqA.id);
    ok("N — recorded under tenant A", tA.incoming.length === 1 && tA.req.businessId === a.businessId);

    // The same CardCom transaction id offered to another tenant is refused by the
    // global unique — and the winner is invisible to B, so nothing leaks either.
    const reqB = await request(b, "55.00");
    provider(reqB.lowProfileId, { mode: "paid", tranId: Number(tA.incoming[0].providerTransactionId), amount: 55, coinId: 1 });
    const rb2 = await reconcile(b);
    ok("N — a colliding id from another tenant is not recorded and the run is NOT healthy", (await truth(reqB.id)).incoming.length === 0 && !rb2.healthy, JSON.stringify(rb2));
    ok("N — it surfaces as a failure in the run report (never swallowed)", rb2.failed === 1, JSON.stringify(rb2));
    ok("N — tenant A's money is untouched", (await truth(reqA.id)).incoming.length === 1);
    const leaked = await runWithTenantContext({ businessId: b.businessId }, () =>
      store.findTransactionByProviderTransactionId("CARDCOM", String(tA.incoming[0].providerTransactionId))
    );
    ok("N — tenant B cannot read tenant A's transaction by provider id", leaked === null);
  }

  if (run("P")) {
    console.log("\n== P — F5: strict CardCom response codes; a foreign answer ==");
    const ctx = await makeBusiness("P");
    const nulls = await request(ctx, "20.00");
    provider(nulls.lowProfileId, { mode: "paid", tranId: tranId(), amount: 20, coinId: 1, nullCodes: true });
    const foreign = await request(ctx, "20.00");
    provider(foreign.lowProfileId, { mode: "paid", tranId: tranId(), amount: 20, coinId: 1, returnValue: "999999999" });
    const r = await reconcile(ctx);
    ok("P — null response codes are not success: still pending", r.recorded === 0 && r.pending === 1, JSON.stringify(r));
    ok("P — an answer about another payment is an anomaly, and the run is NOT healthy", r.anomalies.providerAnswerMismatch === 1 && !r.healthy, JSON.stringify(r));
    await reconcile(ctx);
    ok("P — the foreign answer is audited once, not once per run", (await events(foreign.id, "PAYMENT_PROVIDER_ANSWER_MISMATCH")).length === 1);
    await nothingRecorded("P (null codes)", nulls.id, "PENDING");
    await nothingRecorded("P (foreign ReturnValue)", foreign.id, "PENDING");
    ok("P — CardCom was always asked with this connection's credentials", authFailures === 0, String(authFailures));
  }

  if (run("S")) {
    console.log("\n== S — a forged callback with a chosen event id cannot pre-empt the real payment ==");
    // Anyone holding the checkout link knows its LowProfileId and can guess the
    // ReturnValue, so they can post a correlatable callback and pick its event
    // id (CardCom's event id is the TranzactionId in the body). Worst case: the
    // forger's id is exactly the id CardCom will later use.
    const ctx = await makeBusiness("S");
    const inv = await invoice(ctx, "35.00");
    const req = await request(ctx, "35.00", { invoiceId: inv.id });
    const realId = tranId();
    await webhook(req, { TranzactionId: realId }); // forged, before any payment
    await nothingRecorded("S (forged signal)", req.id, "PENDING");
    let ev = await admin.paymentWebhookEvent.findMany({ where: { providerEventId: String(realId) } });
    ok("S — the forged event is stored but NOT consumed", ev.length === 1 && ev[0].processingStatus === "RECEIVED", JSON.stringify(ev.map((e) => e.processingStatus)));
    provider(req.lowProfileId, { mode: "paid", tranId: realId, amount: 35, coinId: 1 });
    await webhook(req, { TranzactionId: realId }); // CardCom's real callback — same event id
    await exactlyOnce("S (real callback, same event id)", req.id, { amount: "35.00", allocated: "35.00" });
    ev = await admin.paymentWebhookEvent.findMany({ where: { providerEventId: String(realId) } });
    ok("S — one event row, consumed only by the authoritative outcome", ev.length === 1 && ev[0].processingStatus === "PROCESSED");

    // S2: the forger pre-empts, and the real callback never arrives at all.
    const req2 = await request(ctx, "15.00");
    const realId2 = tranId();
    await webhook(req2, { TranzactionId: realId2 });
    provider(req2.lowProfileId, { mode: "paid", tranId: realId2, amount: 15, coinId: 1 });
    const r = await reconcile(ctx);
    ok("S2 — reconciliation records it regardless of any event row", r.recorded === 1, JSON.stringify(r));
    await exactlyOnce("S2", req2.id, { amount: "15.00", allocated: "0.00" });
  }

  if (run("T")) {
    console.log("\n== T — an old lost payment behind 205 newer closed requests is still found ==");
    const ctx = await makeBusiness("T");
    const old = await request(ctx, "12.00");
    await admin.paymentRequest.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 20 * 24 * 60 * 60_000) } });
    provider(old.lowProfileId, { mode: "paid", tranId: tranId(), amount: 12, coinId: 1 });
    const newer = Array.from({ length: 205 }, () => ({
      businessId: ctx.businessId,
      customerId: ctx.customerId,
      provider: "CARDCOM" as const,
      amount: "1.00",
      currency: "ILS",
      status: "CANCELLED" as const,
      providerRequestId: randomUUID(),
      createdAt: PAST(),
    }));
    await admin.paymentRequest.createMany({ data: newer });
    const r = await reconcile(ctx);
    ok("T — every candidate in the window is reachable (no 200 cut-off)", r.candidates === 206, String(r.candidates));
    ok("T — the old lost payment is recorded", r.recorded === 1, JSON.stringify(r));
    await exactlyOnce("T", old.id, { amount: "12.00", allocated: "0.00" });
  }

  if (run("Q")) {
    console.log("\n== Q — the Production QA scenario, webhook lost: invoice 10, collect 5 ==");
    const ctx = await makeBusiness("Q");
    const inv = await invoice(ctx, "10.00");
    const req = await request(ctx, "5.00", { invoiceId: inv.id });
    provider(req.lowProfileId, { mode: "paid", tranId: tranId(), amount: 5, coinId: 1 });
    ok("Q — outstanding before: 10.00", (await outstanding(ctx, inv.id)) === "10.00");
    const r1 = await reconcile(ctx);
    ok("Q — reconciliation discovered the 5.00", r1.recorded === 1 && r1.healthy, JSON.stringify(r1));
    const t = await exactlyOnce("Q", req.id, { amount: "5.00", allocated: "5.00" });
    ok("Q — receipt total 5.00", t.receipts[0]?.totalAmount.equals(D(5)) ?? false, String(t.receipts[0]?.totalAmount));
    ok("Q — outstanding 10 → 5", (await outstanding(ctx, inv.id)) === "5.00");
    const r2 = await reconcile(ctx);
    ok("Q — again: nothing changes", r2.recorded === 0 && r2.checked === 0, JSON.stringify(r2));
    ok("Q — outstanding still 5", (await outstanding(ctx, inv.id)) === "5.00");
  }

  if (run("R")) {
    console.log("\n== R — a degraded run turns the route red ==");
    // Earlier cases left anomalies in the window (K, L, M, N), so a full run
    // across every routed tenant is unhealthy — and must say so by status code.
    const degraded = await reconcileRoute(`Bearer ${process.env.CRON_SECRET}`);
    const anomalous = ONLY.length === 0 || ONLY.some((c) => ["J", "K", "L", "M", "N", "E"].includes(c));
    if (anomalous) {
      ok("R — an unhealthy run answers 500 with its report", degraded.status === 500 && degraded.body.ok === false && degraded.body.report?.healthy === false, JSON.stringify(degraded.body));
    }
  }
}

main()
  .catch((e) => {
    failures.push(`BATTERY ERROR: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    console.log("BATTERY ERROR", e);
  })
  .finally(async () => {
    cardcom.close();
    await admin.$disconnect();
    await appPrisma.$disconnect();
    console.log(
      failures.length === 0
        ? `\nM1 inbound money truth battery: ${pass} passed, 0 failed`
        : `\nM1 inbound money truth battery: ${pass} passed, ${failures.length} FAILED\n  - ${failures.join("\n  - ")}`
    );
    process.exit(failures.length === 0 ? 0 : 1);
  });
