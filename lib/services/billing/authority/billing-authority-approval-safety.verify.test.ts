/**
 * Approval safety battery (run manually / CI tsx):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-safety.verify.test.ts
 *
 * Proves the invariant: an Approval request that may already have reached the
 * Tax Authority is never sent again by Dubiz.
 *
 * The REAL stack runs end to end — executeAuthorityApproval → orchestrator →
 * sendInvoiceApproval (classification) → transition service — against:
 *   - a fake `fetch` that COUNTS Approval POSTs (no Internet; the only sockets
 *     opened are two loopback fixtures on 127.0.0.1 that prove real undici
 *     error shapes), and
 *   - an in-memory Prisma double with atomic compare-and-set updateMany and
 *     per-transaction undo (rollback), so concurrent executions interleave on
 *     real awaits.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BillingAuthorityEnvironment,
  BillingAuthoritySubmissionChannel,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  type Prisma,
} from "@prisma/client";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { ForbiddenError } from "@/lib/errors";
import {
  executeAuthorityApproval,
  hashApprovalPayload,
  type AuthoritySafetyEvent,
  type ExecutionResult,
  type LoadedDocumentSubmission,
  type SubmissionExecutionDeps,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";
import { requestInvoiceApproval } from "@/lib/services/billing/authority/billing-authority-approval-orchestrator";
import {
  classifyTransportFailure,
  sendInvoiceApproval,
} from "@/lib/services/billing/authority/billing-authority-approval-client";
import { createAuthorityEgressFetch } from "@/lib/services/billing/authority/billing-authority-egress";
import {
  recordAuthorityApprovedTx,
  recordAuthorityFailedTx,
  recordAuthorityHeldTx,
  recordAuthorityOutcomeUncertainTx,
  recordAuthorityRejectedTx,
  recordAuthoritySubmissionAttemptTx,
} from "@/lib/services/billing/authority/billing-authority-transition.service";
import type { RuntimeContextResult } from "@/lib/services/billing/authority/billing-authority-approval-runtime-context.provider";
import type { InvoiceApprovalRequest } from "@/lib/services/billing/authority/billing-authority-approval.types";
import type { ApprovalPayloadBuildResult } from "@/lib/services/billing/authority/billing-authority-approval-payload";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) { passed += 1; console.log(`OK: ${name}`); }
  else { failed += 1; console.error(`FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

const BIZ = 3;
const DOC = 42;
const ACTOR = 1;
const IN = { businessId: BIZ, billingDocumentId: DOC, actorUserId: ACTOR };
const ALLOCATION = "20240718181618323199093572";
const TOKEN = "SECRET_ACCESS_TOKEN_XYZ";
const ITA_BASE = "https://ita-api.taxes.gov.il/shaam/tsandbox";

function snapshot() {
  return {
    schemaVersion: 1, issuedAt: "2026-06-15T10:00:00.000Z",
    document: { id: DOC, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber: null, referenceDocumentId: null },
    issuer: { id: BIZ, name: "דוביז", legalName: "דוביז", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "לקוח", legalName: null, taxId: "514000000", phone: null, email: null, city: "תל אביב", address: null },
    lines: [{ lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "10000.0000", vatRatePercent: "18.00", lineSubtotal: "10000.00", vatAmount: "1800.00", lineTotal: "11800.00" }],
    totals: { subtotal: "10000.00", vat: "1800.00", total: "11800.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: ACTOR, source: "manual" },
    pdfTemplateStyle: "CLASSIC", extensions: {},
  };
}

const PAYLOAD: InvoiceApprovalRequest = {
  invoice_id: String(DOC), invoice_type: 305, vat_number: 515000123, invoice_reference_number: "000007",
  customer_vat_number: 514000000, invoice_date: "2026-06-15", invoice_issuance_date: "2026-06-15",
  accounting_software_number: 270901, amount_before_discount: 10000, discount: 0, payment_amount: 10000,
  vat_amount: 1800, payment_amount_including_vat: 11800,
};
const BUILT: ApprovalPayloadBuildResult = { ok: true, payload: PAYLOAD };

// ---------------------------------------------------------------------------
// In-memory DB: atomic CAS + per-transaction undo journal.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: number; businessId: number; billingDocumentId: number; status: BillingAuthoritySubmissionStatus; errorCode: string | null };
type Doc = Record<string, unknown> & { id: number; businessId: number };
type Audit = { eventType: string; metadata: Record<string, unknown> };
type FailRule = (op: string, data: Record<string, unknown>) => boolean;

function makeStore(initial: { status: BillingAuthoritySubmissionStatus; errorCode?: string | null; lastAttemptAt?: Date | null }) {
  const sub: Row = {
    id: 55, businessId: BIZ, billingDocumentId: DOC, status: initial.status,
    submissionChannel: BillingAuthoritySubmissionChannel.STANDARD, legalSnapshotHash: "legal-hash",
    allocationNumber: null, isEmergencyAllocation: false, authoritySubmissionId: null,
    authorityPayloadHash: null, authorityResponseHash: null, submittedAt: null, approvedAt: null,
    rejectedAt: null, lastAttemptAt: initial.lastAttemptAt ?? null, errorCode: initial.errorCode ?? null,
    errorMessage: initial.errorCode ?? null, retryCount: 0, heldDecisionType: null, heldDecisionReportedAt: null,
    createdAt: new Date("2026-06-15T10:00:00Z"), updatedAt: new Date("2026-06-15T10:00:00Z"),
  };
  const doc: Doc = {
    id: DOC, businessId: BIZ, status: BillingDocumentStatus.ISSUED, documentType: BillingDocumentType.TAX_INVOICE,
    legalSnapshotHash: "legal-hash", lockedAt: new Date("2026-06-15T10:00:00Z"), issuedSnapshot: snapshot(),
    allocationNumber: null, allocationApprovedAt: null, isEmergencyAllocation: false, pdfRenderStatus: "RENDERED",
  };
  const audits: Audit[] = [];
  let failRule: FailRule | null = null;
  const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

  function makeTx(journal: Array<() => void>, txBusinessId: number) {
    const fail = (op: string, data: Record<string, unknown>) => {
      if (failRule && failRule(op, data)) throw new Error(`injected DB failure on ${op}`);
    };
    const visible = (businessId: number) => businessId === txBusinessId; // RLS-like tenant scoping
    return {
      billingAuthoritySubmission: {
        async findFirst(args: { where: { billingDocumentId: number; businessId: number } }) {
          await yieldTurn();
          if (!visible(args.where.businessId) || args.where.billingDocumentId !== sub.billingDocumentId || args.where.businessId !== sub.businessId) return null;
          return { ...sub };
        },
        async update(args: { where: { id: number }; data: Record<string, unknown> }) {
          await yieldTurn();
          fail("submission.update", args.data);
          const before = { ...sub };
          Object.assign(sub, args.data, { updatedAt: new Date() });
          journal.push(() => Object.assign(sub, before));
          return { ...sub };
        },
        async updateMany(args: { where: { id?: number; businessId?: number; status?: string }; data: Record<string, unknown> }) {
          await yieldTurn();
          // Atomic: check + write happen synchronously (no await in between).
          if (args.where.businessId !== undefined && (!visible(args.where.businessId) || args.where.businessId !== sub.businessId)) return { count: 0 };
          if (args.where.id !== undefined && args.where.id !== sub.id) return { count: 0 };
          if (args.where.status !== undefined && args.where.status !== sub.status) return { count: 0 };
          fail("submission.updateMany", args.data);
          const before = { ...sub };
          Object.assign(sub, args.data, { updatedAt: new Date() });
          journal.push(() => Object.assign(sub, before));
          return { count: 1 };
        },
      },
      billingDocument: {
        async findFirst(args: { where: { id: number; businessId: number } }) {
          await yieldTurn();
          if (!visible(args.where.businessId) || args.where.id !== doc.id || args.where.businessId !== doc.businessId) return null;
          return { ...doc };
        },
        async update(args: { where: { id: number; businessId: number }; data: Record<string, unknown> }) {
          await yieldTurn();
          fail("document.update", args.data);
          const before = { ...doc };
          Object.assign(doc, args.data);
          journal.push(() => Object.assign(doc, before));
          return { ...doc };
        },
      },
      billingAuditEvent: {
        async create(args: { data: { eventType: string; metadata: Record<string, unknown> } }) {
          await yieldTurn();
          fail("audit.create", { eventType: args.data.eventType });
          audits.push({ eventType: args.data.eventType, metadata: args.data.metadata });
          const index = audits.length - 1;
          journal.push(() => { audits.splice(index, 1); });
          return { id: audits.length };
        },
        async findMany() { return []; },
      },
    };
  }

  async function runInTransaction<T>(businessId: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const journal: Array<() => void> = [];
    try {
      return await fn(makeTx(journal, businessId) as unknown as Prisma.TransactionClient);
    } catch (error) {
      for (const undo of journal.reverse()) undo();
      throw error;
    }
  }

  async function load(businessId: number, billingDocumentId: number): Promise<LoadedDocumentSubmission | null> {
    await yieldTurn();
    if (businessId !== doc.businessId || billingDocumentId !== doc.id) return null;
    return {
      id: doc.id, businessId: doc.businessId, status: doc.status as BillingDocumentStatus,
      lockedAt: doc.lockedAt as Date, legalSnapshotHash: doc.legalSnapshotHash as string,
      issuedSnapshot: doc.issuedSnapshot as LoadedDocumentSubmission["issuedSnapshot"],
      submission: { id: sub.id, status: sub.status, authorityPayloadHash: sub.authorityPayloadHash as string | null, errorCode: sub.errorCode, lastAttemptAt: sub.lastAttemptAt as Date | null },
    };
  }

  return {
    sub, doc, audits, runInTransaction, load,
    setFailRule: (rule: FailRule | null) => { failRule = rule; },
    count: (eventType: string) => audits.filter((a) => a.eventType === eventType).length,
  };
}

// ---------------------------------------------------------------------------
// Transport doubles (count every Approval POST)
// ---------------------------------------------------------------------------
type Behavior = (init: RequestInit | undefined) => Promise<Response>;
function transport(behavior: Behavior) {
  const t = {
    posts: 0,
    fetch: (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") t.posts += 1;
      return behavior(init);
    }) as typeof fetch,
    behavior,
  };
  return t;
}
const jsonResponse = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const APPROVED_BODY = { status: 200, message: "ok", confirmation_number: ALLOCATION, approved: true };
function undiciError(code: string, message = code): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}
const waitForAbort: Behavior = (init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });

// ---------------------------------------------------------------------------
// Execution wiring: real orchestrator + client + transitions, fake fetch + DB.
// ---------------------------------------------------------------------------
type Harness = {
  deps: SubmissionExecutionDeps;
  forceRefreshCalls: () => number;
  safetyEvents: AuthoritySafetyEvent[];
};
function harness(
  store: ReturnType<typeof makeStore>,
  fetchImpl: typeof fetch,
  opts: { now?: () => Date; recordAttempt?: SubmissionExecutionDeps["recordAttempt"]; apiBaseUrl?: string } = {},
): Harness {
  let forceRefresh = 0;
  const safetyEvents: AuthoritySafetyEvent[] = [];
  const ctx = (): RuntimeContextResult => ({
    ok: true,
    context: {
      accessToken: TOKEN,
      approvalConfig: { apiBaseUrl: opts.apiBaseUrl ?? ITA_BASE, apiVersion: "v2", timeoutMs: 60 },
      accountingSoftwareNumber: "270901", connectionId: 1, environment: BillingAuthorityEnvironment.SANDBOX,
    },
  });
  const deps: SubmissionExecutionDeps = {
    loadDocumentWithSubmission: store.load,
    resolveEnvironment: () => BillingAuthorityEnvironment.SANDBOX,
    resolveRuntimeContext: async (input) => { if (input.forceRefresh) forceRefresh += 1; return ctx(); },
    buildPayload: () => BUILT,
    requestApproval: (input) =>
      requestInvoiceApproval(input, {
        buildPayload: () => BUILT,
        sendApproval: (i) => sendInvoiceApproval({ ...i, fetchImpl }),
      }),
    hashPayload: hashApprovalPayload,
    now: opts.now ?? (() => new Date("2026-06-15T10:00:00.000Z")),
    runInTransaction: store.runInTransaction,
    recordAttempt: opts.recordAttempt ?? recordAuthoritySubmissionAttemptTx,
    recordApproved: recordAuthorityApprovedTx,
    recordRejected: recordAuthorityRejectedTx,
    recordFailed: recordAuthorityFailedTx,
    recordHeld: recordAuthorityHeldTx,
    recordOutcomeUncertain: recordAuthorityOutcomeUncertainTx,
    reportSafetyEvent: (e) => { safetyEvents.push(e); },
  };
  return { deps, forceRefreshCalls: () => forceRefresh, safetyEvents };
}

const isUncertain = (r: ExecutionResult, code: string) =>
  r.outcome === "outcome_uncertain" && r.errorCode === code && r.safeToRetry === false;

/** Runs one attempt with `first`, then a second execute; returns POST counts. */
async function possiblySentCase(name: string, first: Behavior, expectedCode: string) {
  const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
  const t = transport(first);
  const h = harness(store, t.fetch);
  const r1 = await executeAuthorityApproval(IN, h.deps);
  ok(`${name}: OUTCOME_UNCERTAIN (${expectedCode}), safeToRetry=false`, isUncertain(r1, expectedCode), r1);
  ok(`${name}: exactly one POST`, t.posts === 1, t.posts);
  ok(`${name}: row stays SUBMITTED with uncertain marker`, store.sub.status === "SUBMITTED" && store.sub.errorCode === expectedCode, store.sub);
  ok(`${name}: OUTCOME_UNCERTAIN audit written once`, store.count("BILLING_AUTHORITY_OUTCOME_UNCERTAIN") === 1);
  // Second execute — the transport would now succeed; still no re-POST.
  t.behavior = () => jsonResponse(200, APPROVED_BODY);
  const r2 = await executeAuthorityApproval(IN, h.deps);
  ok(`${name}: second execute → ZERO additional POSTs`, t.posts === 1 && r2.outcome === "outcome_uncertain", { posts: t.posts, r2 });
  return { store, t, h };
}

async function notSentCase(name: string, first: Behavior | null, fetchImpl: typeof fetch | null, expectedCode: string) {
  const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
  const t = transport(first ?? (() => jsonResponse(200, APPROVED_BODY)));
  const h = harness(store, fetchImpl ?? t.fetch);
  const r1 = await executeAuthorityApproval(IN, h.deps);
  ok(`${name}: NOT_SENT → FAILED ${expectedCode}, safeToRetry=true`, r1.outcome === "infrastructure_failed" && r1.errorCode === expectedCode && r1.safeToRetry === true, r1);
  ok(`${name}: row FAILED with not-sent code`, store.sub.status === "FAILED" && store.sub.errorCode === expectedCode, store.sub);
  // Retry semantics: a provably not-sent failure may be executed again — once.
  const t2 = transport(() => jsonResponse(200, APPROVED_BODY));
  const h2 = harness(store, t2.fetch);
  const r2 = await executeAuthorityApproval(IN, h2.deps);
  ok(`${name}: retry after NOT_SENT → exactly one POST → APPROVED`, r2.outcome === "completed_approved" && t2.posts === 1 && store.sub.status === "APPROVED", { r2, posts: t2.posts });
  ok(`${name}: retryCount incremented once`, store.sub.retryCount === 1, store.sub.retryCount);
}

async function main(): Promise<void> {
  // ===== 1. configuration / pre-send =====
  {
    let transportCalls = 0;
    const egressFetch = createAuthorityEgressFetch({
      env: { BILLING_AUTHORITY_RUNTIME_ENVIRONMENT: "SANDBOX" }, // egress vars missing
      transportFetch: (async () => { transportCalls += 1; throw new Error("must not be called"); }) as never,
    });
    await notSentCase("1 egress not configured", null, egressFetch, "AUTHORITY_NOT_SENT_CONFIGURATION");
    ok("1 egress not configured: ZERO transport calls (no socket)", transportCalls === 0, transportCalls);
  }
  {
    // URL construction failure happens before fetch.
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, APPROVED_BODY));
    const h = harness(store, t.fetch, { apiBaseUrl: undefined as unknown as string });
    (h.deps as { resolveRuntimeContext: SubmissionExecutionDeps["resolveRuntimeContext"] }).resolveRuntimeContext = async () => ({
      ok: true,
      context: { accessToken: TOKEN, approvalConfig: { apiBaseUrl: null as unknown as string, apiVersion: "v2", timeoutMs: 60 }, accountingSoftwareNumber: "270901", connectionId: 1, environment: BillingAuthorityEnvironment.SANDBOX },
    });
    const r = await executeAuthorityApproval(IN, h.deps);
    ok("1b request construction failure → NOT_SENT CONFIGURATION, zero POST", r.outcome === "infrastructure_failed" && r.errorCode === "AUTHORITY_NOT_SENT_CONFIGURATION" && t.posts === 0, { r, posts: t.posts });
  }

  // ===== 2. connect-phase transport failures (provably not sent) =====
  await notSentCase("2 ECONNREFUSED", () => Promise.reject(undiciError("ECONNREFUSED")), null, "AUTHORITY_NOT_SENT_NETWORK");
  await notSentCase("2 proxy CONNECT refused", () => Promise.reject(undiciError("UND_ERR_ABORTED", "Proxy response (403) !== 200 when HTTP Tunneling")), null, "AUTHORITY_NOT_SENT_NETWORK");
  await notSentCase("2 proxy TLS failure", () => Promise.reject(undiciError("UND_ERR_PRX_TLS")), null, "AUTHORITY_NOT_SENT_NETWORK");
  await notSentCase("2 egress tunnel closed at connect", () => Promise.reject(undiciError("ITA_EGRESS_TUNNEL_CLOSED")), null, "AUTHORITY_NOT_SENT_NETWORK");
  await notSentCase("2 connect timeout", () => Promise.reject(undiciError("UND_ERR_CONNECT_TIMEOUT")), null, "AUTHORITY_NOT_SENT_NETWORK");
  {
    // UND_ERR_ABORTED without the proxy-tunnel message is NOT proof.
    await possiblySentCase("2 generic UND_ERR_ABORTED", () => Promise.reject(undiciError("UND_ERR_ABORTED", "Request aborted")), "AUTHORITY_OUTCOME_UNCERTAIN_NETWORK");
  }

  // Real undici error shapes on loopback only (no Internet traffic).
  {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    let refused: unknown;
    try { await undiciFetch(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}" }); } catch (e) { refused = e; }
    const c1 = classifyTransportFailure(refused);
    ok("2 REAL undici ECONNREFUSED (closed loopback port) → NOT_SENT", c1.kind === "infrastructure_error" && c1.sendCertainty === "NOT_SENT" && c1.transportCode === "ECONNREFUSED", c1);

    let connectSeen = 0;
    const proxy: Server = createServer((_req, res) => { res.statusCode = 500; res.end(); });
    proxy.on("connect", (_req, socket) => { connectSeen += 1; socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const agent = new ProxyAgent(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    let tunnelRefused: unknown;
    try {
      await undiciFetch(`${ITA_BASE}/Invoices/v2/Approval`, { method: "POST", body: "{}", dispatcher: agent });
    } catch (e) { tunnelRefused = e; }
    await agent.close();
    await new Promise<void>((r) => proxy.close(() => r()));
    const c2 = classifyTransportFailure(tunnelRefused);
    ok("2 REAL undici ProxyAgent CONNECT 403 (loopback proxy, never forwards) → NOT_SENT", connectSeen === 1 && c2.kind === "infrastructure_error" && c2.sendCertainty === "NOT_SENT" && c2.transportCode === "PROXY_TUNNEL_REFUSED", { connectSeen, c2 });
  }

  // ===== 3. ambiguous connection reset =====
  await possiblySentCase("3 ECONNRESET", () => Promise.reject(undiciError("ECONNRESET")), "AUTHORITY_OUTCOME_UNCERTAIN_NETWORK");
  await possiblySentCase("3 UND_ERR_SOCKET (other side closed)", () => Promise.reject(undiciError("UND_ERR_SOCKET", "other side closed")), "AUTHORITY_OUTCOME_UNCERTAIN_NETWORK");
  await possiblySentCase("3 unknown transport error (no code)", () => Promise.reject(new TypeError("fetch failed")), "AUTHORITY_OUTCOME_UNCERTAIN_NETWORK");

  // ===== 4. timeouts after the request may have been written =====
  await possiblySentCase("4 request timeout (abort)", waitForAbort, "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT");
  await possiblySentCase("4 headers timeout", () => Promise.reject(undiciError("UND_ERR_HEADERS_TIMEOUT")), "AUTHORITY_OUTCOME_UNCERTAIN_NETWORK");
  await possiblySentCase(
    "4 body read aborted after status",
    () => Promise.resolve({ status: 200, text: () => Promise.reject(new DOMException("aborted", "AbortError")) } as unknown as Response),
    "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT",
  );

  // ===== 5. ambiguous provider/server failures =====
  for (const status of [500, 502, 503, 504]) {
    await possiblySentCase(`5 HTTP ${status}`, () => jsonResponse(status, { status, message: "err", error_id: "E-1" }), "AUTHORITY_OUTCOME_UNCERTAIN_SERVER");
  }
  await possiblySentCase("5 HTTP 408", () => jsonResponse(408, {}), "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT");
  await possiblySentCase("5 HTTP 404", () => jsonResponse(404, {}), "AUTHORITY_OUTCOME_UNCERTAIN_UNEXPECTED_STATUS");
  await possiblySentCase("5 HTTP 429", () => jsonResponse(429, {}), "AUTHORITY_OUTCOME_UNCERTAIN_NETWORK");
  await possiblySentCase("5 HTTP 406", () => jsonResponse(406, { status: 406, message: "Not Acceptable", error_id: "E-406" }), "AUTHORITY_OUTCOME_UNCERTAIN_NOT_ACCEPTABLE");

  // ===== 6. malformed / truncated / ambiguous provider responses =====
  await possiblySentCase("6 200 non-JSON body", () => jsonResponse(200, "<html>gateway</html>"), "AUTHORITY_OUTCOME_UNCERTAIN_MALFORMED_RESPONSE");
  await possiblySentCase("6 200 truncated JSON", () => jsonResponse(200, '{"status":200,"approved":tr'), "AUTHORITY_OUTCOME_UNCERTAIN_MALFORMED_RESPONSE");
  await possiblySentCase("6 200 empty body", () => jsonResponse(200, ""), "AUTHORITY_OUTCOME_UNCERTAIN_NOT_APPROVED_AMBIGUOUS");
  await possiblySentCase("6 200 approved without confirmation", () => jsonResponse(200, { status: 200, message: "ok", confirmation_number: null, approved: true }), "AUTHORITY_OUTCOME_UNCERTAIN_APPROVED_NO_CONFIRMATION");
  await possiblySentCase("6 500 non-JSON", () => jsonResponse(500, "oops"), "AUTHORITY_OUTCOME_UNCERTAIN_SERVER");

  // ===== 7. concurrency =====
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(APPROVED_BODY), { status: 200 })), 20)));
    const h = harness(store, t.fetch);
    const results = await Promise.all(Array.from({ length: 2 }, () => executeAuthorityApproval(IN, h.deps)));
    ok("7 two concurrent executes → exactly ONE Approval POST", t.posts === 1, { posts: t.posts, results });
    ok("7 one owner approved, the other in_progress", results.filter((r) => r.outcome === "completed_approved").length === 1 && results.filter((r) => r.outcome === "in_progress").length === 1, results);
    ok("7 one SUBMISSION_ATTEMPTED audit", store.count("BILLING_AUTHORITY_SUBMISSION_ATTEMPTED") === 1);
  }
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(APPROVED_BODY), { status: 200 })), 20)));
    const h = harness(store, t.fetch);
    const results = await Promise.all(Array.from({ length: 10 }, () => executeAuthorityApproval(IN, h.deps)));
    ok("7 ten concurrent executes → exactly ONE Approval POST", t.posts === 1 && results.filter((r) => r.outcome === "completed_approved").length === 1, { posts: t.posts });
  }
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.FAILED, errorCode: "AUTHORITY_NOT_SENT_NETWORK" });
    const t = transport(() => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(APPROVED_BODY), { status: 200 })), 20)));
    const h = harness(store, t.fetch);
    const results = await Promise.all(Array.from({ length: 5 }, () => executeAuthorityApproval(IN, h.deps)));
    ok("7 five concurrent retries of a NOT_SENT FAILED row → exactly ONE POST", t.posts === 1, { posts: t.posts, results });
  }
  {
    // Negative control: the same race WITHOUT compare-and-set double-POSTs,
    // proving the harness really interleaves the reservations.
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(APPROVED_BODY), { status: 200 })), 20)));
    const unsafeReserve: SubmissionExecutionDeps["recordAttempt"] = async (tx) => {
      const row = await tx.billingAuthoritySubmission.findFirst({ where: { billingDocumentId: DOC, businessId: BIZ } });
      if (!row || (row.status !== "READY" && row.status !== "FAILED")) throw new Error("not reservable");
      await tx.billingAuthoritySubmission.update({ where: { id: row.id }, data: { status: BillingAuthoritySubmissionStatus.SUBMITTED } });
      return { submission: { id: row.id } };
    };
    const h = harness(store, t.fetch, { recordAttempt: unsafeReserve });
    await Promise.all(Array.from({ length: 2 }, () => executeAuthorityApproval(IN, h.deps)));
    ok("7 NEGATIVE CONTROL: a non-CAS reserve lets both callers POST (race is real)", t.posts === 2, t.posts);
  }

  // ===== 8. definitive provider rejection =====
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(400, { status: 400, message: { errors: [{ code: 434, message: "bad date", param: "invoice_date", location: "request" }] }, confirmation_number: null, approved: false }));
    const h = harness(store, t.fetch);
    const r1 = await executeAuthorityApproval(IN, h.deps);
    ok("8 400 → completed_rejected ITA_434, REJECTED persisted", r1.outcome === "completed_rejected" && r1.errorCode === "ITA_434" && store.sub.status === "REJECTED", { r1, sub: store.sub });
    const r2 = await executeAuthorityApproval(IN, h.deps);
    ok("8 rejection: second execute → already_processed, ZERO extra POSTs", r2.outcome === "already_processed" && t.posts === 1, { r2, posts: t.posts });
  }
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, { status: 200, message: { errors: [{ code: 460, message: "held", param: "", location: "approval" }] }, confirmation_number: null, approved: false }));
    const h = harness(store, t.fetch);
    const r1 = await executeAuthorityApproval(IN, h.deps);
    ok("8 460 → HELD (decision_required)", r1.outcome === "decision_required" && store.sub.status === "HELD", { r1, sub: store.sub });
    const r2 = await executeAuthorityApproval(IN, h.deps);
    ok("8 HELD: second execute → not executable, ZERO extra POSTs", r2.outcome === "preflight_failed" && t.posts === 1, { r2, posts: t.posts });
  }
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, { status: 200, message: { errors: [{ code: 462, message: "reported", param: "", location: "approval" }] }, confirmation_number: null, approved: false }));
    const h = harness(store, t.fetch);
    const r1 = await executeAuthorityApproval(IN, h.deps);
    ok("8 462 → decision_already_reported, marked uncertain", r1.outcome === "decision_already_reported" && store.sub.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_DECISION_ALREADY_REPORTED", { r1, sub: store.sub });
    await executeAuthorityApproval(IN, h.deps);
    ok("8 462: second execute → ZERO extra POSTs", t.posts === 1, t.posts);
  }

  // ===== 9. success =====
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, APPROVED_BODY));
    const h = harness(store, t.fetch);
    const r1 = await executeAuthorityApproval(IN, h.deps);
    ok("9 success → completed_approved", r1.outcome === "completed_approved" && r1.allocationNumber === ALLOCATION, r1);
    ok("9 allocation persisted on submission + document exactly once", store.sub.status === "APPROVED" && store.sub.allocationNumber === ALLOCATION && store.doc.allocationNumber === ALLOCATION && store.count("BILLING_AUTHORITY_APPROVED") === 1, { sub: store.sub, doc: store.doc });
    const r2 = await executeAuthorityApproval(IN, h.deps);
    ok("9 second execute → already_processed, ZERO extra POSTs, still one APPROVED audit", r2.outcome === "already_processed" && t.posts === 1 && store.count("BILLING_AUTHORITY_APPROVED") === 1, { r2, posts: t.posts });
  }

  // ===== 10. APPROVED + DB persistence failure =====
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, APPROVED_BODY));
    const h = harness(store, t.fetch);
    // Fail the document projection inside the APPROVE transaction (rolls back).
    store.setFailRule((op) => op === "document.update");
    const r1 = await executeAuthorityApproval(IN, h.deps);
    store.setFailRule(null);
    ok("10a approved + TX2 failure → OUTCOME_UNCERTAIN APPROVED_PERSIST_FAILED", isUncertain(r1, "AUTHORITY_OUTCOME_UNCERTAIN_APPROVED_PERSIST_FAILED"), r1);
    ok("10a row SUBMITTED (never FAILED), APPROVE rolled back", store.sub.status === "SUBMITTED" && store.sub.allocationNumber === null && store.count("BILLING_AUTHORITY_APPROVED") === 0, store.sub);
    const marker = store.audits.find((a) => a.eventType === "BILLING_AUTHORITY_OUTCOME_UNCERTAIN");
    ok("10a received allocation number preserved in uncertain audit evidence", marker?.metadata.receivedAllocationNumber === ALLOCATION && marker?.metadata.resend === "BLOCKED", marker);
    ok("10a safety event carries a hash, never the number", h.safetyEvents.length === 1 && h.safetyEvents[0].event === "AUTHORITY_APPROVED_PERSIST_FAILED" && !JSON.stringify(h.safetyEvents).includes(ALLOCATION), h.safetyEvents);
    const r2 = await executeAuthorityApproval(IN, h.deps);
    ok("10a second execute → ZERO additional POSTs", t.posts === 1 && r2.outcome === "outcome_uncertain", { r2, posts: t.posts });
  }
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, APPROVED_BODY));
    let clock = new Date("2026-06-15T10:00:00.000Z");
    const h = harness(store, t.fetch, { now: () => clock });
    // Catastrophic: every write after the reserve fails (DB unreachable).
    let posted = false;
    const wrapped = t.fetch;
    const h2 = harness(store, (async (u: unknown, i?: RequestInit) => { posted = true; return wrapped(u as string, i); }) as typeof fetch, { now: () => clock });
    store.setFailRule(() => posted);
    const r1 = await executeAuthorityApproval(IN, h2.deps);
    store.setFailRule(null);
    ok("10b approved + ALL later writes fail → outcome_uncertain (never FAILED)", r1.outcome === "outcome_uncertain" && r1.safeToRetry === false, r1);
    ok("10b row remains SUBMITTED from the reserve (non-executable)", store.sub.status === "SUBMITTED" && store.sub.errorCode === null, store.sub);
    ok("10b both safety events emitted, hash only", h2.safetyEvents.map((e) => e.event).join(",") === "AUTHORITY_APPROVED_PERSIST_FAILED,AUTHORITY_UNCERTAIN_MARKER_WRITE_FAILED" && !JSON.stringify(h2.safetyEvents).includes(ALLOCATION), h2.safetyEvents);
    const r2 = await executeAuthorityApproval(IN, h.deps);
    ok("10b immediate second execute → in_progress, ZERO additional POSTs", r2.outcome === "in_progress" && t.posts === 1, { r2, posts: t.posts });
    clock = new Date(clock.getTime() + 16 * 60 * 1000);
    const r3 = await executeAuthorityApproval(IN, h.deps);
    ok("10b later execute (stale in-flight) → outcome_uncertain, ZERO additional POSTs", r3.outcome === "outcome_uncertain" && t.posts === 1, { r3, posts: t.posts });
  }

  // ===== 11. 401 policy: no in-attempt re-POST =====
  for (const status of [401, 403]) {
    const { h, t } = await possiblySentCase(`11 HTTP ${status}`, () => jsonResponse(status, {}), status === 401 ? "AUTHORITY_OUTCOME_UNCERTAIN_AUTHENTICATION" : "AUTHORITY_OUTCOME_UNCERTAIN_AUTHORIZATION");
    ok(`11 HTTP ${status}: no forced token refresh + re-POST (posts=${t.posts})`, h.forceRefreshCalls() === 0 && t.posts === 1, { refresh: h.forceRefreshCalls(), posts: t.posts });
  }

  // ===== 12. legacy / persistence-layer guards =====
  for (const legacy of ["AUTHORITY_NETWORK", "AUTHORITY_TIMEOUT", "AUTHORITY_SERVER", "AUTHORITY_NOT_ACCEPTABLE", null]) {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.FAILED, errorCode: legacy });
    const t = transport(() => jsonResponse(200, APPROVED_BODY));
    const r = await executeAuthorityApproval(IN, harness(store, t.fetch).deps);
    ok(`12 legacy FAILED(${legacy}) → not executable, ZERO POSTs`, r.outcome === "preflight_failed" && r.errorCode === "SUBMISSION_NOT_PROVABLY_UNSENT" && t.posts === 0, { r, posts: t.posts });
    let threw: unknown = null;
    try {
      await store.runInTransaction(BIZ, (tx) => recordAuthoritySubmissionAttemptTx(tx, { businessId: BIZ, billingDocumentId: DOC, actorUserId: ACTOR }));
    } catch (e) { threw = e; }
    ok(`12 legacy FAILED(${legacy}): reserve refused at persistence layer`, threw instanceof ForbiddenError && store.sub.status === "FAILED", threw);
  }
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.SUBMITTED });
    let threw: unknown = null;
    try {
      await store.runInTransaction(BIZ, (tx) => recordAuthorityFailedTx(tx, { businessId: BIZ, billingDocumentId: DOC, lastAttemptAt: new Date(), errorCode: "AUTHORITY_TIMEOUT", errorMessage: "AUTHORITY_TIMEOUT" }));
    } catch (e) { threw = e; }
    ok("12 SUBMITTED → FAILED with a possibly-sent code is refused", threw instanceof ForbiddenError && store.sub.status === "SUBMITTED", threw);
    const applied = await store.runInTransaction(BIZ, (tx) => recordAuthorityOutcomeUncertainTx(tx, { businessId: BIZ, billingDocumentId: DOC, reason: "TIMEOUT", observedAt: new Date(), evidence: { sendCertainty: "POSSIBLY_SENT", classification: "TIMEOUT", failureKind: "TRANSPORT", providerHttpStatus: null, providerErrorId: "x y <script>", transportCode: null, receivedAllocationNumber: null } }));
    const again = await store.runInTransaction(BIZ, (tx) => recordAuthorityOutcomeUncertainTx(tx, { businessId: BIZ, billingDocumentId: DOC, reason: "SERVER", observedAt: new Date(), evidence: { sendCertainty: "POSSIBLY_SENT", classification: null, failureKind: null, providerHttpStatus: 500, providerErrorId: null, transportCode: null, receivedAllocationNumber: null } }));
    ok("12 uncertain marker idempotent (first wins, second NOOP)", applied.outcome === "APPLIED" && again.outcome === "NOOP" && store.sub.errorCode === "AUTHORITY_OUTCOME_UNCERTAIN_TIMEOUT" && store.count("BILLING_AUTHORITY_OUTCOME_UNCERTAIN") === 1, { applied, again });
    const ev = store.audits.find((a) => a.eventType === "BILLING_AUTHORITY_OUTCOME_UNCERTAIN");
    ok("12 unsafe diagnostic token dropped from evidence", ev?.metadata.providerErrorId === null, ev);
  }

  // ===== 13. tenant isolation =====
  {
    const store = makeStore({ status: BillingAuthoritySubmissionStatus.READY });
    const t = transport(() => jsonResponse(200, APPROVED_BODY));
    const r = await executeAuthorityApproval({ ...IN, businessId: BIZ + 1 }, harness(store, t.fetch).deps);
    ok("13 other tenant → DOCUMENT_NOT_FOUND, ZERO POSTs, row untouched", r.outcome === "preflight_failed" && r.errorCode === "DOCUMENT_NOT_FOUND" && t.posts === 0 && store.sub.status === "READY", { r, posts: t.posts });
    let threw: unknown = null;
    try {
      await store.runInTransaction(BIZ + 1, (tx) => recordAuthorityOutcomeUncertainTx(tx, { businessId: BIZ + 1, billingDocumentId: DOC, reason: "UNKNOWN", observedAt: new Date(), evidence: { sendCertainty: "POSSIBLY_SENT", classification: null, failureKind: null, providerHttpStatus: null, providerErrorId: null, transportCode: null, receivedAllocationNumber: null } }));
    } catch (e) { threw = e; }
    ok("13 other tenant cannot mark the submission", threw !== null && store.sub.errorCode === null, threw);
  }

  // ===== 14. observability: no secrets / payload in persisted evidence =====
  {
    const { store } = await possiblySentCase("14 evidence sample (502)", () => jsonResponse(502, { status: 502, message: "bad gateway", error_id: "GW-502-abc" }), "AUTHORITY_OUTCOME_UNCERTAIN_SERVER");
    const dump = JSON.stringify({ audits: store.audits, sub: store.sub });
    ok("14 no access token in DB evidence", !dump.includes(TOKEN));
    ok("14 no customer VAT number / payload in DB evidence", !dump.includes("514000000") && !dump.includes("invoice_reference_number"));
    const ev = store.audits.find((a) => a.eventType === "BILLING_AUTHORITY_OUTCOME_UNCERTAIN")?.metadata ?? {};
    ok("14 evidence has stage/class/status/error id", ev.reason === "SERVER" && ev.providerHttpStatus === 502 && ev.providerErrorId === "GW-502-abc" && ev.sendCertainty === "POSSIBLY_SENT", ev);
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FATAL", error);
  process.exit(1);
});
