/**
 * Service Desk 1.3c — quotes on a service case: send, revise, the owner's record of the customer's decision, and the read
 * model. SERVER-ONLY. No UI, no flag logic (the HTTP edge decides FULL / READ_ONLY / NONE first).
 *
 * Every command is ONE case command of the module (service-case.service): the case row locked FOR UPDATE, an earlier
 * answer by Idempotency-Key + request digest from the case journal, expectedVersion compared under the lock, the pure core
 * (evaluateTransition) decides, every server check it lists is verified here, then the effects, the case row and exactly
 * one journal event (commitTransition) and the quote / charge rows — all in that transaction.
 *
 * Send / revise (billing quotes are never issued and are re-rendered on demand — so the service freezes its own copy):
 *   1. preflight (no render on a replay or on a refusal): the case, the billing document (same business, QUOTE, ILS, the
 *      case's customer, lines, not converted), its canonical content (quote.core) and the core's verdict on the action;
 *   2. OUTSIDE the case transaction (no lock held while a browser works or bytes travel): the billing renderer is called
 *      (injected — the routes pass the billing getOrRenderQuotePdf; a lab may pass a stub), the bytes stored
 *      content-addressed under biz/<b>/service/cases/<c>/quotes/<sha256>.pdf (create-once);
 *   3. the content is read again: changed since the preflight → QUOTE_DOCUMENT_CHANGED (nothing recorded);
 *   4. the command: under the lock the document is read a THIRD time and must still hash to the frozen docHash
 *      (QUOTE_DOCUMENT_MATCHES_HASH, with the stored copy present), then the transition and ServiceQuote version N.
 *   A refused or failed command leaves at most an unreferenced, content-addressed object in the business's own prefix
 *   (the account erasure removes the whole prefix) — never a row.
 *
 * Decision (owner records it — PHONE or IN_PERSON, actor OWNER_USER; LINK is the customer's link, a contract only, refused):
 *   APPROVE → the case IN_REPAIR, the version APPROVED (bound to its version / total / docHash), and — same transaction —
 *             ServiceCaseCharge seq = last + 1, CHARGEABLE, the approved total, APPROVED_QUOTE, quoteVersion. A ₪0 quote
 *             records no charge (quote.core chargeForApproval: free of charge is the owner's NO_CHARGE decision).
 *   REJECT  → the case READY with outcome QUOTE_REJECTED (the core), the version REJECTED.
 */
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { NotFoundError, ValidationError } from "@/lib/errors";
import { getStorageService, type StorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import type { ServiceCaseAction, ServiceCaseContext, ServiceServerCheck, ServiceTransitionDecision } from "./contracts";
import {
  chargeForApproval,
  checkQuoteDocument,
  decisionAction,
  looksLikePdf,
  quoteRowRefusal,
  readQuoteDecision,
  type BillingQuoteDocument,
  type BillingQuoteLine,
} from "./quote.core";
import { insertSentQuote, type FrozenQuote } from "./quote-rows";
import { checkCommandEnvelope, evaluateTransition } from "./service-case.core";
import {
  commitTransition,
  isNonNegativeInt,
  isPositiveInt,
  journaled,
  lockCase,
  prepare,
  summaryOf,
  type CommandResult,
  type Locked,
  type Prepared,
  type ServiceDeskPrincipal,
  type Tx,
  type WriteRequest,
} from "./service-case.service";
import { ServiceDeskError, refused } from "./service-desk-errors";
import { SERVICE_STORAGE_DOMAIN, isServiceKeyOfBusiness, quoteSentPdfFolder, quoteSentPdfKey } from "./storage/service-storage-keys";

/** The billing renderer, injected (the routes pass quote-render.ts; the lab may stub it when no browser is available). */
export type QuoteRenderer = (input: { businessId: number; billingDocumentId: number; actorUserId: number }) => Promise<{ buffer: Buffer }>;
export type QuoteSendDeps = { render: QuoteRenderer; storage?: StorageService };

export type QuoteView = {
  version: number; billingDocumentId: number; totalAgorot: number; currency: string; docHash: string; sentPdfSha256: string;
  state: string; sentAt: string; sentByUserId: number | null; decidedAt: string | null; decidedByActor: string | null;
  decidedByUserId: number | null; approvalMethod: string | null;
};
export type QuoteCommandResult = CommandResult & { quote: QuoteView | null; charge?: { seq: number; amountAgorot: number } | null };

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const violations = (codes: readonly string[]) => new ServiceDeskError("REFUSED", { violations: [...new Set(codes)] });
type Ok = Extract<ServiceTransitionDecision, { ok: true }>;

// ── Reads of billing rows (only reads; under the tenant's RLS, naming the business) ──────────────────────────

async function readBillingQuote(tx: Tx, b: number, billingDocumentId: number): Promise<{ doc: BillingQuoteDocument | null; lines: BillingQuoteLine[] }> {
  const d = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT id, "businessId", "documentType"::text AS "documentType", status::text AS status, currency, "customerId", "customerNameSnapshot",
           to_char("validUntil", 'YYYY-MM-DD') AS "validUntil", "subtotalAmount"::text AS "subtotalAmount", "vatAmount"::text AS "vatAmount",
           "totalAmount"::text AS "totalAmount", "convertedToInvoiceId"
      FROM "BillingDocument" WHERE id = ${billingDocumentId}::int AND "businessId" = ${b}::int`)[0];
  if (!d) return { doc: null, lines: [] };
  const lines = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT l."lineIndex", l.description, l.quantity::text AS quantity, l."unitPrice"::text AS "unitPrice", l."vatRatePercent"::text AS "vatRatePercent",
           l."lineSubtotal"::text AS "lineSubtotal", l."vatAmount"::text AS "vatAmount", l."lineTotal"::text AS "lineTotal"
      FROM "BillingDocumentLine" l JOIN "BillingDocument" d ON d.id = l."billingDocumentId"
     WHERE d.id = ${billingDocumentId}::int AND d."businessId" = ${b}::int ORDER BY l."lineIndex"`;
  return {
    doc: {
      id: Number(d.id), businessId: Number(d.businessId), documentType: String(d.documentType), status: String(d.status), currency: String(d.currency),
      customerId: d.customerId === null ? null : Number(d.customerId), customerNameSnapshot: (d.customerNameSnapshot as string) ?? null,
      validUntil: (d.validUntil as string) ?? null, subtotalAmount: String(d.subtotalAmount), vatAmount: String(d.vatAmount),
      totalAmount: String(d.totalAmount), convertedToInvoiceId: d.convertedToInvoiceId === null ? null : Number(d.convertedToInvoiceId),
    },
    lines: lines.map((l) => ({
      lineIndex: Number(l.lineIndex), description: String(l.description), quantity: String(l.quantity), unitPrice: String(l.unitPrice),
      vatRatePercent: String(l.vatRatePercent), lineSubtotal: String(l.lineSubtotal), vatAmount: String(l.vatAmount), lineTotal: String(l.lineTotal),
    })),
  };
}

async function caseCustomer(tx: Tx, b: number, caseId: number): Promise<number> {
  const r = (await tx.$queryRaw<{ c: number }[]>`SELECT "customerId" AS c FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int`)[0];
  if (!r) throw new ServiceDeskError("NOT_FOUND");
  return Number(r.c);
}

/** The document's content as this business's quote for this case — or the refusal. */
async function quoteContent(tx: Tx, b: number, caseId: number, billingDocumentId: number) {
  const { doc, lines } = await readBillingQuote(tx, b, billingDocumentId);
  const c = checkQuoteDocument(doc, lines, { businessId: b, customerId: await caseCustomer(tx, b, caseId) });
  if (!c.ok) throw violations(c.violations);
  // One billing document belongs to one case (EXCLUDE ServiceQuote_billing_document_one_case) — refused before the guard.
  const other = (await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "ServiceQuote" WHERE "businessId" = ${b}::int AND "billingDocumentId" = ${billingDocumentId}::int AND "caseId" <> ${caseId}::int) AS ok`)[0]?.ok;
  if (other) throw violations(["QUOTE_DOCUMENT_OF_ANOTHER_CASE"]);
  return c.content;
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────────────────

const ISO = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const QUOTE_COLUMNS = Prisma.sql`version, "billingDocumentId", "totalAgorot", currency, "docHash", "sentPdfSha256", state::text AS state, "sentAt", "sentByUserId",
  "decidedAt", "decidedByActor"::text AS "decidedByActor", "decidedByUserId", "approvalMethod"::text AS "approvalMethod"`;
const toView = (r: Record<string, unknown>): QuoteView => ({
  version: Number(r.version), billingDocumentId: Number(r.billingDocumentId), totalAgorot: Number(r.totalAgorot), currency: String(r.currency),
  docHash: String(r.docHash), sentPdfSha256: String(r.sentPdfSha256), state: String(r.state), sentAt: String(ISO(r.sentAt)),
  sentByUserId: r.sentByUserId === null ? null : Number(r.sentByUserId), decidedAt: ISO(r.decidedAt), decidedByActor: (r.decidedByActor as string) ?? null,
  decidedByUserId: r.decidedByUserId === null ? null : Number(r.decidedByUserId), approvalMethod: (r.approvalMethod as string) ?? null,
});

async function quoteOf(tx: Tx, b: number, caseId: number, version: number): Promise<QuoteView | null> {
  const r = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT ${QUOTE_COLUMNS} FROM "ServiceQuote" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND version = ${version}::int`)[0];
  return r ? toView(r) : null;
}

/** The case's quote versions, oldest first. FULL and READ_ONLY. */
export async function listQuotes(businessId: number, caseId: unknown): Promise<{ quotes: QuoteView[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    await caseCustomer(tx, businessId, caseId); // NOT_FOUND for another business's case
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${QUOTE_COLUMNS} FROM "ServiceQuote" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY version`;
    return { quotes: rows.map(toView) };
  });
}

export async function getQuote(businessId: number, caseId: unknown, version: unknown): Promise<QuoteView> {
  if (!isPositiveInt(caseId) || !isPositiveInt(version)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const q = await quoteOf(tx, businessId, caseId, version);
    if (!q) throw new ServiceDeskError("NOT_FOUND");
    return q;
  });
}

/** The stored copy the customer received — only through this case's own version row (never a key from the request). */
export async function readQuotePdf(businessId: number, caseId: unknown, version: unknown, storage: StorageService = getStorageService()): Promise<{ bytes: Buffer; caseNumber: number; version: number }> {
  if (!isPositiveInt(caseId) || !isPositiveInt(version)) throw new ServiceDeskError("NOT_FOUND");
  const row = await tenantTx(businessId, async (tx) => (await tx.$queryRaw<{ key: string; sha: string; n: number }[]>`
    SELECT q."sentPdfKey" AS key, q."sentPdfSha256" AS sha, c."caseNumber" AS n FROM "ServiceQuote" q
      JOIN "ServiceCase" c ON c.id = q."caseId" AND c."businessId" = q."businessId"
     WHERE q."businessId" = ${businessId}::int AND q."caseId" = ${caseId}::int AND q.version = ${version}::int AND c."erasedAt" IS NULL`)[0] ?? null);
  const folder = quoteSentPdfFolder({ businessId, caseId });
  if (!row || !isServiceKeyOfBusiness(row.key, businessId) || row.key !== `${folder}${row.sha}.pdf`) throw new ServiceDeskError("NOT_FOUND");
  let bytes: Buffer;
  try {
    bytes = Buffer.from((await storage.getObject(row.key)).body);
  } catch {
    throw new ServiceDeskError("NOT_FOUND");
  }
  if (!looksLikePdf(bytes) || sha256Hex(bytes) !== row.sha) throw new ServiceDeskError("NOT_FOUND");
  return { bytes, caseNumber: Number(row.n), version };
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────

async function storedCopyPresent(storage: StorageService, b: number, caseId: number, key: string, sha: string): Promise<boolean> {
  if (key !== quoteSentPdfKey({ businessId: b, caseId, sha256: sha })) return false;
  try { return (await storage.headObject(key)).exists === true; } catch { return false; }
}

/** Every server check of a quote decision, verified — or refused (fail closed: one this layer cannot verify refuses). */
function requireChecks(checks: readonly ServiceServerCheck[], verified: ReadonlySet<ServiceServerCheck>) {
  for (const check of checks) if (!verified.has(check)) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
}

function judge(context: ServiceCaseContext, caseId: number, action: ServiceCaseAction, expectedVersion: number, prepared: Prepared, userId: number): Ok {
  const env = checkCommandEnvelope(context, { caseId, action, expectedVersion, idempotencyKey: prepared.key });
  if (!env.ok) throw refused(env.violations);
  const d = evaluateTransition(context, action, { kind: "OWNER", userId });
  if (!d.ok) throw refused(d.violations);
  return d;
}

const isExclusionOnDocument = (e: unknown) => /ServiceQuote_billing_document_one_case/.test(e instanceof Error ? e.message : String(e));

type SendBody = { billingDocumentId?: unknown; expectedVersion?: unknown; replacesVersion?: unknown };

async function sendOrRevise(mode: "SEND" | "REVISE", p: ServiceDeskPrincipal, caseId: unknown, body: SendBody, req: WriteRequest, deps: QuoteSendDeps): Promise<QuoteCommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isPositiveInt(body.billingDocumentId)) throw new ServiceDeskError("INVALID_INPUT", { field: "billingDocumentId" });
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  if (mode === "REVISE" && !isPositiveInt(body.replacesVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "replacesVersion" });
  if (!deps || typeof deps.render !== "function") throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { capability: "quote_render" });
  const b = p.businessId;
  const billingDocumentId = body.billingDocumentId;
  const expectedVersion = body.expectedVersion;
  const replaces = mode === "REVISE" ? (body.replacesVersion as number) : null;
  const storage = deps.storage ?? getStorageService();
  const prepared = prepare(p, req, mode === "SEND" ? "service-desk/cases:quote-send" : "service-desk/cases:quote-revise",
    mode === "SEND" ? { caseId, billingDocumentId, expectedVersion } : { caseId, billingDocumentId, replacesVersion: replaces, expectedVersion });
  const actionFor = (context: ServiceCaseContext, q: { totalAgorot: number; docHash: string }): ServiceCaseAction => {
    const version = (context.currentQuote?.version ?? 0) + 1;
    return mode === "SEND"
      ? { type: "SEND_QUOTE", quote: { version, ...q } }
      : { type: "REVISE_QUOTE", replaces: { version: replaces as number }, quote: { version, ...q } };
  };

  // 1. Preflight: a replay renders nothing; a refusal renders and stores nothing.
  const pre = await tenantTx(b, async (tx) => {
    const prior = (await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "ServiceCaseEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}::text) AS ok`)[0]?.ok === true;
    if (prior) return null;
    const { context } = await lockCase(tx, b, caseId);
    const content = await quoteContent(tx, b, caseId, billingDocumentId);
    judge(context, caseId, actionFor(context, content), expectedVersion, prepared, p.userId);
    return content;
  });

  // 2–3. Render and store OUTSIDE the case transaction; then the content must still be what was judged.
  let frozen: Omit<FrozenQuote, "version"> | null = null;
  if (pre) {
    let buffer: Buffer;
    try {
      buffer = (await deps.render({ businessId: b, billingDocumentId, actorUserId: p.userId })).buffer;
    } catch (e) {
      if (e instanceof ServiceDeskError) throw e;
      if (e instanceof ValidationError || e instanceof NotFoundError) throw violations(["QUOTE_DOCUMENT_NOT_RENDERABLE"]);
      throw e;
    }
    if (!buffer || !looksLikePdf(buffer)) throw violations(["QUOTE_RENDER_FAILED"]);
    const sha = sha256Hex(buffer);
    const key = quoteSentPdfKey({ businessId: b, caseId, sha256: sha });
    await storage.putObjectIfAbsent({ key, body: buffer, contentType: "application/pdf", metadata: { businessId: b, domain: SERVICE_STORAGE_DOMAIN, visibility: "private" } });
    const after = await tenantTx(b, (tx) => quoteContent(tx, b, caseId, billingDocumentId));
    if (after.docHash !== pre.docHash || after.totalAgorot !== pre.totalAgorot) throw violations(["QUOTE_DOCUMENT_CHANGED"]);
    frozen = { billingDocumentId, totalAgorot: pre.totalAgorot, docHash: pre.docHash, sentPdfKey: key, sentPdfSha256: sha };
  }

  // 4. The command.
  try {
    return await journaled<QuoteCommandResult, Locked>(p, prepared, (tx) => lockCase(tx, b, caseId), async (tx, { context }) => {
      if (!frozen) throw new ServiceDeskError("CONFLICT"); // the preflight saw this key answered; it must replay
      const now = await quoteContent(tx, b, caseId, billingDocumentId);
      if (now.docHash !== frozen.docHash || now.totalAgorot !== frozen.totalAgorot) throw violations(["QUOTE_DOCUMENT_CHANGED"]);
      const action = actionFor(context, { totalAgorot: frozen.totalAgorot, docHash: frozen.docHash });
      const d = judge(context, caseId, action, expectedVersion, prepared, p.userId);
      const verified = new Set<ServiceServerCheck>();
      if (await storedCopyPresent(storage, b, caseId, frozen.sentPdfKey, frozen.sentPdfSha256)) verified.add("QUOTE_DOCUMENT_MATCHES_HASH");
      requireChecks(d.serverChecks, verified);
      const q: FrozenQuote = { ...frozen, version: (action as { quote: { version: number } }).quote.version };
      const decision: Ok = { ...d, event: { ...d.event, payload: { ...d.event.payload, billingDocumentId, docHash: q.docHash, sentPdfSha256: q.sentPdfSha256 } } };
      const next = await commitTransition(tx, b, caseId, context, decision, p.userId, prepared, mode === "REVISE" ? { nextQuote: q } : {});
      if (mode === "SEND") await insertSentQuote(tx, b, caseId, q, p.userId);
      return { case: await summaryOf(tx, b, caseId), event: { seq: next }, replayed: false, quote: await quoteOf(tx, b, caseId, q.version) };
    }, async (tx, prior) => {
      if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      const v = (await tx.$queryRaw<{ v: number | null }[]>`
        SELECT (payload->>'quoteVersion')::int AS v FROM "ServiceCaseEvent" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND seq = ${prior.seq}::int`)[0]?.v;
      return { case: await summaryOf(tx, b, caseId), event: { seq: prior.seq }, replayed: true, quote: v ? await quoteOf(tx, b, caseId, Number(v)) : null };
    });
  } catch (e) {
    if (isExclusionOnDocument(e)) throw violations(["QUOTE_DOCUMENT_OF_ANOTHER_CASE"]);
    throw e;
  }
}

/** POST /cases/[id]/quotes — send version N (the first, or the next after a decided one) from a billing QUOTE document. */
export function sendQuote(p: ServiceDeskPrincipal, caseId: unknown, body: { billingDocumentId?: unknown; expectedVersion?: unknown }, req: WriteRequest, deps: QuoteSendDeps): Promise<QuoteCommandResult> {
  return sendOrRevise("SEND", p, caseId, { billingDocumentId: body.billingDocumentId, expectedVersion: body.expectedVersion }, req, deps);
}

/** POST /cases/[id]/quotes/revise — replace the SENT version N with N+1 while QUOTE_PENDING (ז-1 A: N → SUPERSEDED). */
export function reviseQuote(p: ServiceDeskPrincipal, caseId: unknown, body: SendBody, req: WriteRequest, deps: QuoteSendDeps): Promise<QuoteCommandResult> {
  return sendOrRevise("REVISE", p, caseId, body, req, deps);
}

/** Is the charge history of migration 20261126090000 present? An approval without its charge record is refused. */
async function chargeLedgerReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (to_regclass('public."ServiceCaseCharge"') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceChargeSource' AND e.enumlabel = 'APPROVED_QUOTE')) AS ok`;
  return r[0]?.ok === true;
}

/** POST /cases/[id]/quotes/[version]/decision — the owner records the customer's APPROVE / REJECT (PHONE or IN_PERSON). */
export async function decideQuote(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  version: unknown,
  body: { decision?: unknown; method?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
  deps: { storage?: StorageService } = {},
): Promise<QuoteCommandResult> {
  if (!isPositiveInt(caseId) || !isPositiveInt(version)) throw new ServiceDeskError("NOT_FOUND");
  const input = readQuoteDecision(body);
  if (!input.ok) {
    if (input.linkRefused) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { method: "LINK", until: "customer_link_m2" });
    throw new ServiceDeskError("INVALID_INPUT", { field: input.field });
  }
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const expectedVersion = body.expectedVersion;
  const storage = deps.storage ?? getStorageService();
  const b = p.businessId;
  const prepared = prepare(p, req, "service-desk/cases:quote-decision", { caseId, version, decision: input.decision, method: input.method, expectedVersion });

  return journaled<QuoteCommandResult, Locked>(p, prepared, (tx) => lockCase(tx, b, caseId), async (tx, { context }) => {
    const row = (await tx.$queryRaw<{ total: number; hash: string; state: string; doc: number; key: string; sha: string }[]>`
      SELECT "totalAgorot" AS total, "docHash" AS hash, state::text AS state, "billingDocumentId" AS doc, "sentPdfKey" AS key, "sentPdfSha256" AS sha
        FROM "ServiceQuote" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND version = ${version}::int`)[0];
    if (!row) throw new ServiceDeskError("NOT_FOUND");
    const rowRefusal = quoteRowRefusal(row.state as never);
    if (rowRefusal) throw refused([{ code: rowRefusal }]);
    const quote = { version, totalAgorot: Number(row.total), docHash: String(row.hash) };
    const d = judge(context, caseId, decisionAction(quote, input), expectedVersion, prepared, p.userId);
    const verified = new Set<ServiceServerCheck>();
    if (d.serverChecks.includes("QUOTE_DOCUMENT_MATCHES_HASH")) {
      // The approval binds the stored version (core); here: the billing document still has exactly that content, and the
      // copy the customer received is still stored. A document edited after sending is a new version (revise), never approved.
      const { doc, lines } = await readBillingQuote(tx, b, Number(row.doc));
      const c = checkQuoteDocument(doc, lines, { businessId: b, customerId: await caseCustomer(tx, b, caseId) });
      if (c.ok && c.content.docHash === quote.docHash && c.content.totalAgorot === quote.totalAgorot && (await storedCopyPresent(storage, b, caseId, String(row.key), String(row.sha)))) {
        verified.add("QUOTE_DOCUMENT_MATCHES_HASH");
      }
    }
    requireChecks(d.serverChecks, verified);
    const charge = input.decision === "APPROVE" ? chargeForApproval(quote) : null;
    if (charge && !(await chargeLedgerReady(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_AUDIT", { ledger: "case_charge" });
    const decision: Ok = { ...d, event: { ...d.event, payload: { ...d.event.payload, chargeRecorded: charge !== null } } };
    const next = await commitTransition(tx, b, caseId, context, decision, p.userId, prepared);
    const n = input.decision === "APPROVE"
      ? await tx.$executeRaw`
          UPDATE "ServiceQuote" SET state = 'APPROVED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER'::"ServiceActor", "decidedByUserId" = ${p.userId}::int,
                 "approvalMethod" = ${input.method}::"ServiceQuoteApprovalMethod", "approvedVersion" = version, "approvedTotalAgorot" = "totalAgorot", "approvedDocHash" = "docHash"
           WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND version = ${version}::int AND state = 'SENT'
             AND "totalAgorot" = ${quote.totalAgorot}::int AND "docHash" = ${quote.docHash}::text`
      : await tx.$executeRaw`
          UPDATE "ServiceQuote" SET state = 'REJECTED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER'::"ServiceActor", "decidedByUserId" = ${p.userId}::int
           WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND version = ${version}::int AND state = 'SENT'`;
    if (n !== 1) throw new ServiceDeskError("STALE_STATE");
    let recorded: { seq: number; amountAgorot: number } | null = null;
    if (charge) {
      // seq = last + 1 under the case lock (the charge guard locks the same row and re-checks the gap-free seq and that
      // the amount is this APPROVED version's approved ILS total). Raw SQL: the new enum types are cast explicitly.
      const seq = Number((await tx.$queryRaw<{ n: number }[]>`
        SELECT COALESCE(max(seq), 0)::int + 1 AS n FROM "ServiceCaseCharge" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int`)[0].n);
      await tx.$executeRaw`
        INSERT INTO "ServiceCaseCharge" ("businessId", "caseId", seq, mode, "amountAgorot", currency, source, "quoteVersion", reason, actor, "actorUserId")
        VALUES (${b}::int, ${caseId}::int, ${seq}::int, ${charge.mode}::"ServiceChargeMode", ${charge.amountAgorot}::int, 'ILS',
                ${charge.source}::"ServiceChargeSource", ${charge.quoteVersion}::int, NULL, 'OWNER_USER'::"ServiceActor", ${p.userId}::int)`;
      recorded = { seq, amountAgorot: charge.amountAgorot };
    }
    return { case: await summaryOf(tx, b, caseId), event: { seq: next }, replayed: false, quote: await quoteOf(tx, b, caseId, version), charge: recorded };
  }, async (tx, prior) => {
    if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { case: await summaryOf(tx, b, caseId), event: { seq: prior.seq }, replayed: true, quote: await quoteOf(tx, b, caseId, version) };
  });
}
