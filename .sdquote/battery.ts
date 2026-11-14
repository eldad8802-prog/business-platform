/**
 * Service Desk 1.3c — quotes and close: quote.service + the case-command effects AS the real runtime role, on the P4 lab
 * (.sd3p4/lab.sh <db> then --deploy-only) with 20261125090000 (#1096) and 20261126090000 (case charge) applied by psql as the
 * lab owner. Synthetic only. Objects go to the real storage adapter (STORAGE_PROVIDER=local, a scratch LOCAL_STORAGE_ROOT).
 *
 * The billing quote is rendered through an INJECTED renderer: by default a stub returning unique synthetic PDF bytes (no
 * browser needed); SDQUOTE_RENDER=billing runs the billing module's real getOrRenderQuotePdf (Chromium — the workflow
 * installs the Playwright browser) for the S-section's first send.
 *
 *   S  send: the row (version 1, exact agorot, the canonical docHash, the frozen copy stored under the case's quotes folder,
 *      its sha256), the case QUOTE_PENDING, ONE quote.sent event; replay (no second render, row or event); a QUOTE of another
 *      business / another customer / a tax invoice / USD → refused before any render, nothing written; a stale version;
 *      one SENT per case (the core, and the database's unique index against the runtime role); a document already used by
 *      another case; a document edited while it renders → QUOTE_DOCUMENT_CHANGED; the read model and the stored bytes.
 *   R  revise: v1 → SUPERSEDED (decided once, by the owner), v2 the one SENT version, the case stays QUOTE_PENDING, one
 *      quote.revised event; a wrong replacesVersion; approving the superseded v1 → QUOTE_SUPERSEDED.
 *   A  approve (PHONE): the case IN_REPAIR, v2 APPROVED bound to its version / total / docHash, ServiceCaseCharge seq 1 =
 *      CHARGEABLE, the approved amount, APPROVED_QUOTE, quoteVersion 2, OWNER_USER + the user — same transaction, one event;
 *      replay (no second charge); LINK refused; a second decision refused; a billing document edited after sending refuses
 *      the approval (QUOTE_DOCUMENT_MATCHES_HASH); a ₪0 quote under an approved cover → approved, no charge.
 *   J  reject (IN_PERSON): READY / QUOTE_REJECTED, the version REJECTED, no charge.
 *   X  cancel: a SENT quote → WITHDRAWN with the cancel, approving it afterwards refused; RESERVED parts → released (NEEDED,
 *      one RELEASED event each, keyed by the cancel) in the cancel's transaction; a refused cancel releases nothing.
 *   C  close: READY → CLOSE refused (not handed over); DELIVER (injected settlement SETTLED / 0) → DELIVERED → CLOSE → CLOSED,
 *      closedAt stamped, case.closed; an open part line refuses the close (OPEN_PART_RESERVATIONS); replay.
 *   G  the generic action route still refuses the quote actions (use: quotes) and SCHEDULE.
 *   I  isolation: another business cannot send on, decide, list or fetch A's quotes; the runtime as B sees none of A's rows.
 *   P  every journal payload written here is tokens / numbers / booleans (no Hebrew, no text).
 *
 * env: OWNER_URL (lab owner — fixtures only), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET, STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT; optional SDQUOTE_RENDER=billing.
 */
import { createHash } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { getStorageService } from "../lib/storage";
import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { addCasePart, runPartAction } from "../lib/services/service-desk/parts.service";
import { decideQuote, getQuote, listQuotes, readQuotePdf, reviseQuote, sendQuote, type QuoteRenderer } from "../lib/services/service-desk/quote.service";
import { canonicalQuoteContent } from "../lib/services/service-desk/quote.core";
import { releaseEventKey } from "../lib/services/service-desk/part-release";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const key = () => uuidV7(new Date());
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.replace(/\s+/g, " ").trim().slice(-300)}`;
  }
}
/** Lab owner in a tenant context (billing and the service tables are FORCE RLS: the owner sees only the tenant's rows). */
async function own<T = Rows>(b: number, sql: string, ...a: unknown[]): Promise<T> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as T;
  });
}
async function rt(b: number, sql: string, ...a: unknown[]): Promise<string> {
  try {
    await runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      await tx.$executeRawUnsafe(sql, ...a);
    });
    return "OK";
  } catch (e) { return `ERR:${(e as Error).message.replace(/\s+/g, " ").trim().slice(-260)}`; }
}
const n1 = async (b: number, sql: string, ...a: unknown[]) => Number((await own(b, sql, ...a))[0]?.n);

const store = getStorageService();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── renderers ──
let renders = 0;
let renderHook: ((i: { businessId: number; billingDocumentId: number }) => Promise<void>) | null = null;
const stubRender: QuoteRenderer = async (i) => {
  renders++;
  if (renderHook) await renderHook(i);
  return { buffer: Buffer.from(`%PDF-1.4\n% sdquote synthetic quote ${i.businessId}/${i.billingDocumentId} #${renders} ${Date.now()}\n%%EOF\n`, "latin1") };
};
let realRender: QuoteRenderer | null = null;
async function renderer(): Promise<QuoteRenderer> {
  if (process.env.SDQUOTE_RENDER !== "billing") return stubRender;
  if (!realRender) {
    const { renderBillingQuote } = await import("../lib/services/service-desk/quote-render");
    realRender = async (i) => { renders++; return renderBillingQuote(i); };
  }
  return realRender;
}

// ── fixtures ──
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdquote-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdquote-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  const cust2 = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח אחר', now()) RETURNING id`, b))[0].id);
  const item = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך סינתטי', 'UNIT', 5, now()) RETURNING id`, b))[0].id);
  return { b, u, cust, cust2, item, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;

/** A billing document as the billing screens leave it (DRAFT), written by the lab owner — billing code is not involved. */
async function billingQuote(z: Biz, o: { customerId?: number | null; type?: string; currency?: string; lines?: [string, string, string][] } = {}): Promise<number> {
  const lines = o.lines ?? [["החלפת מסך", "1", "400.00"], ["עבודה", "2", "50.00"]];
  const sub = lines.reduce((s, [, qn, up]) => s + Math.round(Number(qn) * Number(up) * 100), 0);
  const vat = Math.round(sub * 0.18);
  const doc = Number((await own(z.b, `INSERT INTO "BillingDocument" ("businessId", "documentType", status, "customerId", "customerNameSnapshot", "validUntil",
      "subtotalAmount", "vatAmount", "totalAmount", currency, "updatedAt")
    VALUES ($1, $2::"BillingDocumentType", 'DRAFT', $3, 'לקוח סינתטי', '2026-12-31', $4::numeric / 100, $5::numeric / 100, $6::numeric / 100, $7, now()) RETURNING id`,
    z.b, o.type ?? "QUOTE", o.customerId === undefined ? z.cust : o.customerId, sub, vat, sub + vat, o.currency ?? "ILS"))[0].id);
  let i = 0;
  for (const [desc, qn, up] of lines) {
    const ls = Math.round(Number(qn) * Number(up) * 100), lv = Math.round(ls * 0.18);
    await own(z.b, `INSERT INTO "BillingDocumentLine" ("billingDocumentId", "lineIndex", description, quantity, "unitPrice", "vatRatePercent", "lineSubtotal", "vatAmount", "lineTotal", "updatedAt")
      VALUES ($1, $2, $3, $4::numeric, $5::numeric, 18, $6::numeric / 100, $7::numeric / 100, $8::numeric / 100, now()) RETURNING id`, doc, i++, desc, qn, up, ls, lv, ls + lv);
  }
  return doc;
}
const docTotal = async (z: Biz, doc: number) => Math.round(Number((await own(z.b, `SELECT "totalAmount"::text t FROM "BillingDocument" WHERE id = $1`, doc))[0].t) * 100);

const version = async (z: Biz, id: number) => n1(z.b, `SELECT version::int AS n FROM "ServiceCase" WHERE id = $1`, id);
const events = (z: Biz, id: number) => n1(z.b, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, id);
const quotes = (z: Biz, id: number) => n1(z.b, `SELECT count(*)::int AS n FROM "ServiceQuote" WHERE "caseId" = $1`, id);
const charges = (z: Biz, id: number) => n1(z.b, `SELECT count(*)::int AS n FROM "ServiceCaseCharge" WHERE "caseId" = $1`, id);
const status = async (z: Biz, id: number) => String((await own(z.b, `SELECT status::text s FROM "ServiceCase" WHERE id = $1`, id))[0].s);
const act = async (z: Biz, id: number, action: Record<string, unknown>, k = key(), deps = {}) => runCaseAction(z.p, id, { action, expectedVersion: await version(z, id) }, { idempotencyKey: k }, deps);

/** A FIELD case at DIAGNOSING (check-in on site, the owner handles it). */
async function diagnosing(z: Biz) {
  const o = await openCase(z.p, { kind: "FIELD", customerId: z.cust, problemDescription: "תקלה סינתטית" }, { idempotencyKey: key() });
  await act(z, o.case.id, { type: "CHECK_IN" });
  await act(z, o.case.id, { type: "START_DIAGNOSIS" });
  return o.case.id;
}
const send = async (z: Biz, id: number, doc: number, k = key(), render?: QuoteRenderer) =>
  sendQuote(z.p, id, { billingDocumentId: doc, expectedVersion: await version(z, id) }, { idempotencyKey: k }, { render: render ?? stubRender, storage: store });
const decide = async (z: Biz, id: number, v: number, decision: string, method: string, k = key()) =>
  decideQuote(z.p, id, v, { decision, method, expectedVersion: await version(z, id) }, { idempotencyKey: k }, { storage: store });

async function main() {
  const A = await business("a");
  const B = await business("b");

  console.log("S — send");
  const c1 = await diagnosing(A);
  const d1 = await billingQuote(A);
  const v0 = await version(A, c1);
  const k1 = key();
  const firstRender = await renderer();
  const before = renders;
  const s1 = await send(A, c1, d1, k1, firstRender);
  const row1 = (await own(A.b, `SELECT version, "totalAgorot", "docHash", "sentPdfKey" k, "sentPdfSha256" s, state::text st, "sentByUserId" u, "billingDocumentId" d FROM "ServiceQuote" WHERE "caseId" = $1`, c1))[0];
  const docRow = (await own(A.b, `SELECT "documentType"::text t, currency, "customerId", "customerNameSnapshot", to_char("validUntil", 'YYYY-MM-DD') vu,
      "subtotalAmount"::text sa, "vatAmount"::text va, "totalAmount"::text ta FROM "BillingDocument" WHERE id = $1`, d1))[0];
  const docLines = await own(A.b, `SELECT "lineIndex", description, quantity::text q, "unitPrice"::text up, "vatRatePercent"::text vr, "lineSubtotal"::text ls, "vatAmount"::text lv, "lineTotal"::text lt
      FROM "BillingDocumentLine" WHERE "billingDocumentId" = $1`, d1);
  const expected = canonicalQuoteContent({
    id: d1, businessId: A.b, documentType: String(docRow.t), status: "DRAFT", currency: String(docRow.currency), customerId: Number(docRow.customerId),
    customerNameSnapshot: String(docRow.customerNameSnapshot), validUntil: String(docRow.vu), subtotalAmount: String(docRow.sa), vatAmount: String(docRow.va),
    totalAmount: String(docRow.ta), convertedToInvoiceId: null,
  }, docLines.map((l) => ({ lineIndex: Number(l.lineIndex), description: String(l.description), quantity: String(l.q), unitPrice: String(l.up), vatRatePercent: String(l.vr), lineSubtotal: String(l.ls), vatAmount: String(l.lv), lineTotal: String(l.lt) })));
  const storedBytes = Buffer.from((await store.getObject(String(row1.k))).body);
  ok("S1 send → QUOTE_PENDING, version 1 SENT: exact agorot, the canonical docHash, the sending user",
    s1.case.status === "QUOTE_PENDING" && s1.case.version === v0 + 1 && Number(row1.version) === 1 && row1.st === "SENT"
      && Number(row1.totalAgorot) === (await docTotal(A, d1)) && expected.ok && row1.docHash === expected.docHash && Number(row1.u) === A.u && Number(row1.d) === d1,
    JSON.stringify(row1));
  ok("S2 the frozen copy: stored under biz/<b>/service/cases/<c>/quotes/<sha>.pdf, its bytes hash to sentPdfSha256, rendered once",
    row1.k === `biz/${A.b}/service/cases/${c1}/quotes/${row1.s}.pdf` && sha(storedBytes) === row1.s && storedBytes.subarray(0, 5).toString("latin1") === "%PDF-" && renders === before + 1);
  const ev1 = (await own(A.b, `SELECT "eventType"::text e, action::text a, actor::text ac, "actorUserId" u, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = $2`, c1, s1.event.seq))[0];
  const pl1 = ev1.payload as Record<string, unknown>;
  ok("S3 ONE quote.sent event (seq = the new version) by the owner, naming version / total / document / hashes",
    (await events(A, c1)) === s1.event.seq && ev1.e === "quote.sent" && ev1.a === "SEND_QUOTE" && ev1.ac === "OWNER_USER" && Number(ev1.u) === A.u
      && pl1.quoteVersion === 1 && pl1.totalAgorot === Number(row1.totalAgorot) && pl1.billingDocumentId === d1 && pl1.docHash === row1.docHash && pl1.sentPdfSha256 === row1.s);
  const rp = await sendQuote(A.p, c1, { billingDocumentId: d1, expectedVersion: v0 }, { idempotencyKey: k1 }, { render: stubRender, storage: store });
  ok("S4 replay (same key, same request) → replayed, no render, no second row or event", rp.replayed === true && rp.quote?.version === 1 && renders === before + 1
    && (await quotes(A, c1)) === 1 && (await events(A, c1)) === s1.event.seq);
  ok("S5 same key, another request → IDEMPOTENCY_KEY_REUSED", (await code(() => sendQuote(A.p, c1, { billingDocumentId: d1, expectedVersion: v0 + 7 }, { idempotencyKey: k1 }, { render: stubRender, storage: store }))) === "IDEMPOTENCY_KEY_REUSED");

  const c2 = await diagnosing(A);
  const foreign = await billingQuote(B, { customerId: B.cust });
  const otherCustomer = await billingQuote(A, { customerId: A.cust2 });
  const invoice = await billingQuote(A, { type: "TAX_INVOICE" });
  const usd = await billingQuote(A, { currency: "USD" });
  const r0 = renders;
  const refusals = [await code(() => send(A, c2, foreign)), await code(() => send(A, c2, otherCustomer)), await code(() => send(A, c2, invoice)), await code(() => send(A, c2, usd))];
  ok("S6 a QUOTE of another business / of another customer / a tax invoice / USD → refused, nothing rendered or written",
    refusals[0].includes("QUOTE_DOCUMENT_NOT_FOUND") && refusals[1].includes("QUOTE_DOCUMENT_CUSTOMER_MISMATCH") && refusals[2].includes("QUOTE_DOCUMENT_NOT_QUOTE")
      && refusals[3].includes("QUOTE_DOCUMENT_CURRENCY") && renders === r0 && (await quotes(A, c2)) === 0 && (await status(A, c2)) === "DIAGNOSING", JSON.stringify(refusals));
  ok("S7 a stale expectedVersion → VERSION_CONFLICT, nothing rendered",
    (await code(async () => sendQuote(A.p, c2, { billingDocumentId: await billingQuote(A), expectedVersion: 1 }, { idempotencyKey: key() }, { render: stubRender, storage: store }))) === "VERSION_CONFLICT" && renders === r0);
  ok("S8 one SENT per case: a second send while QUOTE_PENDING → refused by the core (INVALID_TRANSITION)",
    (await code(async () => send(A, c1, await billingQuote(A)))).includes("INVALID_TRANSITION") && (await quotes(A, c1)) === 1);
  const dup = await rt(A.b, `INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256")
      VALUES ($1, $2, 2, $3, 100, $4, $5, $4)`, A.b, c1, d1, "c".repeat(64), `biz/${A.b}/service/cases/${c1}/quotes/x.pdf`);
  ok("S9 … and by the database, against the runtime role (UNIQUE ServiceQuote_one_sent_per_case)", /ServiceQuote_one_sent_per_case|Unique constraint failed on the fields: \(`businessId`,`caseId`\)|23505/.test(dup), dup);
  ok("S10 a billing document already sent on another case → QUOTE_DOCUMENT_OF_ANOTHER_CASE", (await code(() => send(A, c2, d1))).includes("QUOTE_DOCUMENT_OF_ANOTHER_CASE"));
  const edited = await billingQuote(A);
  renderHook = async (i) => { if (i.billingDocumentId === edited) await own(A.b, `UPDATE "BillingDocumentLine" SET description = description || ' (עודכן)' WHERE "billingDocumentId" = $1 AND "lineIndex" = 0 RETURNING id`, edited); };
  const chg = await code(() => send(A, c2, edited));
  renderHook = null;
  ok("S11 the billing document edited while it renders → QUOTE_DOCUMENT_CHANGED, no row, the case unchanged",
    chg.includes("QUOTE_DOCUMENT_CHANGED") && (await quotes(A, c2)) === 0 && (await status(A, c2)) === "DIAGNOSING", chg);
  const list = await listQuotes(A.b, c1);
  const one = await getQuote(A.b, c1, 1);
  const pdf = await readQuotePdf(A.b, c1, 1, store);
  ok("S12 the read model: the list, one version, and the stored bytes read back through the version's own row",
    list.quotes.length === 1 && list.quotes[0].state === "SENT" && one.docHash === row1.docHash && one.sentPdfSha256 === row1.s && sha(pdf.bytes) === row1.s
      && (await code(() => readQuotePdf(A.b, c1, 2, store))) === "NOT_FOUND");

  console.log("R — revise");
  const d2 = await billingQuote(A, { lines: [["החלפת מסך", "1", "380.00"], ["עבודה", "1", "50.00"]] });
  const vR = await version(A, c1);
  const wrong = await code(() => reviseQuote(A.p, c1, { billingDocumentId: d2, replacesVersion: 7, expectedVersion: vR }, { idempotencyKey: key() }, { render: stubRender, storage: store }));
  ok("R1 a wrong replacesVersion → refused (QUOTE_VERSION_MISMATCH), nothing written", wrong.includes("QUOTE_VERSION_MISMATCH") && (await quotes(A, c1)) === 1, wrong);
  const rv = await reviseQuote(A.p, c1, { billingDocumentId: d2, replacesVersion: 1, expectedVersion: vR }, { idempotencyKey: key() }, { render: stubRender, storage: store });
  const rows = await own(A.b, `SELECT version, state::text st, "decidedByActor"::text da, "decidedByUserId" du, "decidedAt" IS NOT NULL dd, "totalAgorot" FROM "ServiceQuote" WHERE "caseId" = $1 ORDER BY version`, c1);
  const evR = (await own(A.b, `SELECT "eventType"::text e, "fromStatus"::text f, "toStatus"::text tt, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = $2`, c1, rv.event.seq))[0];
  ok("R2 revise → v1 SUPERSEDED (decided once, by the owner), v2 the one SENT version at the new total; the case stays QUOTE_PENDING, one quote.revised event",
    rv.case.status === "QUOTE_PENDING" && rv.case.version === vR + 1 && rows.length === 2 && rows[0].st === "SUPERSEDED" && rows[0].da === "OWNER_USER" && Number(rows[0].du) === A.u && rows[0].dd === true
      && rows[1].st === "SENT" && Number(rows[1].totalAgorot) === (await docTotal(A, d2)) && evR.e === "quote.revised" && evR.f === "QUOTE_PENDING" && evR.tt === "QUOTE_PENDING"
      && (evR.payload as Record<string, unknown>).supersededQuoteVersion === 1 && (evR.payload as Record<string, unknown>).quoteVersion === 2 && (await events(A, c1)) === rv.event.seq,
    JSON.stringify(rows));
  ok("R3 approving the superseded v1 → QUOTE_SUPERSEDED, nothing written", (await code(() => decide(A, c1, 1, "APPROVE", "PHONE"))).includes("QUOTE_SUPERSEDED") && (await charges(A, c1)) === 0);
  ok("R4 the database keeps a decided version final (the runtime cannot reopen v1)",
    (await rt(A.b, `UPDATE "ServiceQuote" SET state = 'SENT', "decidedAt" = NULL, "decidedByActor" = NULL, "decidedByUserId" = NULL WHERE "caseId" = $1 AND version = 1`, c1)).includes("SERVICE_QUOTE"));

  console.log("A — approve");
  ok("A1 LINK (the customer's channel) is refused at the service — contract only", (await code(() => decide(A, c1, 2, "APPROVE", "LINK"))).startsWith("ACTION_NOT_IN_SCOPE"));
  const vA = await version(A, c1);
  const kA = key();
  const ap = await decideQuote(A.p, c1, 2, { decision: "APPROVE", method: "PHONE", expectedVersion: vA }, { idempotencyKey: kA }, { storage: store });
  const q2 = (await own(A.b, `SELECT state::text st, "approvalMethod"::text m, "approvedVersion" av, "approvedTotalAgorot" at, "approvedDocHash" ah, "docHash" h, "totalAgorot" t, "decidedByActor"::text da FROM "ServiceQuote" WHERE "caseId" = $1 AND version = 2`, c1))[0];
  const ch = await own(A.b, `SELECT seq, mode::text m, "amountAgorot" a, currency c, source::text s, "quoteVersion" qv, actor::text ac, "actorUserId" u, reason FROM "ServiceCaseCharge" WHERE "caseId" = $1`, c1);
  const evA = (await own(A.b, `SELECT "eventType"::text e, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = $2`, c1, ap.event.seq))[0];
  ok("A2 approve (PHONE) → IN_REPAIR; v2 APPROVED bound to its own version / total / docHash, by the owner",
    ap.case.status === "IN_REPAIR" && q2.st === "APPROVED" && q2.m === "PHONE" && Number(q2.av) === 2 && Number(q2.at) === Number(q2.t) && q2.ah === q2.h && q2.da === "OWNER_USER", JSON.stringify(q2));
  ok("A3 … and ServiceCaseCharge seq 1: CHARGEABLE, the approved amount, ILS, APPROVED_QUOTE, quoteVersion 2, OWNER_USER + the user, no reason",
    ch.length === 1 && Number(ch[0].seq) === 1 && ch[0].m === "CHARGEABLE" && Number(ch[0].a) === Number(q2.t) && ch[0].c === "ILS" && ch[0].s === "APPROVED_QUOTE"
      && Number(ch[0].qv) === 2 && ch[0].ac === "OWNER_USER" && Number(ch[0].u) === A.u && ch[0].reason === null && ap.charge?.amountAgorot === Number(q2.t), JSON.stringify(ch));
  ok("A4 ONE quote.approved event, method and chargeRecorded in the payload", evA.e === "quote.approved" && (evA.payload as Record<string, unknown>).method === "PHONE"
    && (evA.payload as Record<string, unknown>).chargeRecorded === true && (await events(A, c1)) === ap.event.seq);
  const apR = await decideQuote(A.p, c1, 2, { decision: "APPROVE", method: "PHONE", expectedVersion: vA }, { idempotencyKey: kA }, { storage: store });
  ok("A5 replay → replayed, no second charge or event", apR.replayed === true && (await charges(A, c1)) === 1 && (await events(A, c1)) === ap.event.seq);
  ok("A6 a second decision on the approved version → refused", (await code(() => decide(A, c1, 2, "REJECT", "PHONE"))).startsWith("REFUSED"));

  const c3 = await diagnosing(A);
  const d3 = await billingQuote(A);
  await send(A, c3, d3);
  await own(A.b, `UPDATE "BillingDocument" SET "totalAmount" = "totalAmount" + 1, "updatedAt" = now() WHERE id = $1 RETURNING id`, d3);
  const stale = await code(() => decide(A, c3, 1, "APPROVE", "IN_PERSON"));
  ok("A7 the billing document edited after sending → the approval is refused (QUOTE_DOCUMENT_MATCHES_HASH), nothing written",
    stale.includes("QUOTE_DOCUMENT_MATCHES_HASH") && (await status(A, c3)) === "QUOTE_PENDING" && (await charges(A, c3)) === 0, stale);

  const cz = await diagnosing(A);
  await own(A.b, `UPDATE "ServiceCase" SET "coverageSource" = 'MANUFACTURER', "coverageDecision" = 'APPROVED' WHERE id = $1 RETURNING id`, cz); // lab: a cover
  const dz = await billingQuote(A, { lines: [["בדיקה באחריות", "1", "0.00"]] });
  await send(A, cz, dz);
  const az = await decide(A, cz, 1, "APPROVE", "IN_PERSON");
  ok("A8 a ₪0 quote under an approved cover → approved, NO charge recorded (free of charge is the owner's NO_CHARGE decision)",
    az.case.status === "IN_REPAIR" && (await charges(A, cz)) === 0 && az.charge === null);

  console.log("J — reject");
  const c4 = await diagnosing(A);
  await send(A, c4, await billingQuote(A));
  const rj = await decide(A, c4, 1, "REJECT", "IN_PERSON");
  const q4 = (await own(A.b, `SELECT state::text st, "approvalMethod" m FROM "ServiceQuote" WHERE "caseId" = $1`, c4))[0];
  ok("J1 reject (IN_PERSON) → READY with outcome QUOTE_REJECTED; the version REJECTED; no charge", rj.case.status === "READY" && rj.case.outcome === "QUOTE_REJECTED"
    && q4.st === "REJECTED" && q4.m === null && (await charges(A, c4)) === 0);

  console.log("X — cancel");
  const c5 = await diagnosing(A);
  await send(A, c5, await billingQuote(A));
  const cx = await act(A, c5, { type: "CANCEL", reason: "הלקוח ויתר" });
  const q5 = (await own(A.b, `SELECT state::text st, "decidedByActor"::text da FROM "ServiceQuote" WHERE "caseId" = $1`, c5))[0];
  const ev5 = (await own(A.b, `SELECT payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = $2`, c5, cx.event.seq))[0].payload as Record<string, unknown>;
  ok("X1 cancel with a SENT quote → the case CANCELLED and the quote WITHDRAWN in the same command (one event)",
    cx.case.status === "CANCELLED" && q5.st === "WITHDRAWN" && q5.da === "OWNER_USER" && ev5.withdrawnQuoteVersion === 1 && (await events(A, c5)) === cx.event.seq);
  ok("X1b approving the withdrawn version → refused (QUOTE_WITHDRAWN)", (await code(() => decide(A, c5, 1, "APPROVE", "PHONE"))).includes("QUOTE_WITHDRAWN"));

  const c6 = await diagnosing(A);
  const pA = await addCasePart(A.p, c6, { source: "STOCK", inventoryItemId: A.item, name: "מסך", quantity: 1 }, { idempotencyKey: key() });
  const pB = await addCasePart(A.p, c6, { source: "STOCK", inventoryItemId: A.item, name: "מסך נוסף", quantity: 1 }, { idempotencyKey: key() });
  const pC = await addCasePart(A.p, c6, { source: "NON_STOCK", name: "בורג", quantity: 1 }, { idempotencyKey: key() });
  await runPartAction(A.p, pA.part.id, { action: { type: "RESERVE" }, expectedVersion: pA.part.version }, { idempotencyKey: key() });
  await runPartAction(A.p, pB.part.id, { action: { type: "RESERVE" }, expectedVersion: pB.part.version }, { idempotencyKey: key() });
  const reservedBefore = await n1(A.b, `SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1 AND state = 'RESERVED'`, c6);
  const refusedCancel = await code(() => runCaseAction(A.p, c6, { action: { type: "CANCEL", reason: "x" }, expectedVersion: 1 }, { idempotencyKey: key() }));
  ok("X2a a refused cancel (stale version) releases nothing", refusedCancel === "VERSION_CONFLICT" && reservedBefore === 2
    && (await n1(A.b, `SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1 AND state = 'RESERVED'`, c6)) === 2);
  const kX = key();
  const cx6 = await act(A, c6, { type: "CANCEL" }, kX);
  const parts6 = await own(A.b, `SELECT id, state::text st, version, "lastEventKind"::text lk FROM "ServicePart" WHERE "caseId" = $1 ORDER BY id`, c6);
  const rel = await own(A.b, `SELECT "partId", kind::text k, "stateBefore"::text sb, "stateAfter"::text sa, "idempotencyKey" ik, payload, actor::text ac, "actorUserId" u FROM "ServicePartEvent" WHERE "caseId" = $1 AND kind = 'RELEASED' ORDER BY "partId"`, c6);
  ok("X2 cancel with RESERVED parts → each released (RESERVED → NEEDED, version + 1) with ONE RELEASED event keyed by the cancel, in the cancel's transaction",
    cx6.case.status === "CANCELLED" && parts6.filter((r) => r.st === "NEEDED").length === 3 && parts6.filter((r) => r.lk === "RELEASED").length === 2
      && rel.length === 2 && rel.every((r) => r.sb === "RESERVED" && r.sa === "NEEDED" && r.ac === "OWNER_USER" && Number(r.u) === A.u && (r.payload as Record<string, unknown>).byCaseCancel === true)
      && rel[0].ik === releaseEventKey(kX, pA.part.id) && rel[1].ik === releaseEventKey(kX, pB.part.id) && !rel.some((r) => Number(r.partId) === pC.part.id),
    JSON.stringify({ parts6, rel }));
  const cx6r = await runCaseAction(A.p, c6, { action: { type: "CANCEL" }, expectedVersion: cx6.case.version - 1 }, { idempotencyKey: kX });
  ok("X3 the cancel's replay releases nothing twice", cx6r.replayed === true && (await n1(A.b, `SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "caseId" = $1 AND kind = 'RELEASED'`, c6)) === 2);

  console.log("C — close");
  ok("C1 CLOSE from IN_REPAIR (not handed over) → refused", (await code(() => act(A, c1, { type: "CLOSE" }))).includes("INVALID_TRANSITION"));
  await act(A, c1, { type: "FINISH_REPAIR", outcome: "REPAIRED" });
  const settled = { settlement: async () => ({ state: "SETTLED" as const, openBalanceAgorot: 0 as const }) };
  const dl = await act(A, c1, { type: "DELIVER", receipt: { handoverConfirmed: true } }, key(), settled);
  ok("C2 DELIVER with the settlement SETTLED / 0 → DELIVERED (no auto-close: the SYSTEM sweep's, not the handover's)", dl.case.status === "DELIVERED");
  const kC = key();
  const cl = await act(A, c1, { type: "CLOSE" }, kC);
  const cr = (await own(A.b, `SELECT "closedAt" IS NOT NULL c FROM "ServiceCase" WHERE id = $1`, c1))[0];
  const evC = (await own(A.b, `SELECT "eventType"::text e, "fromStatus"::text f FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND seq = $2`, c1, cl.event.seq))[0];
  ok("C3 CLOSE → CLOSED, closedAt stamped, ONE case.closed event from DELIVERED", cl.case.status === "CLOSED" && cr.c === true && evC.e === "case.closed" && evC.f === "DELIVERED");
  const clR = await runCaseAction(A.p, c1, { action: { type: "CLOSE" }, expectedVersion: cl.case.version - 1 }, { idempotencyKey: kC });
  ok("C4 the close's replay → replayed, nothing written", clR.replayed === true && (await events(A, c1)) === cl.event.seq);
  const c7 = await diagnosing(A);
  await own(A.b, `UPDATE "ServiceCase" SET "coverageSource" = 'STORE', "coverageDecision" = 'APPROVED' WHERE id = $1 RETURNING id`, c7);
  await addCasePart(A.p, c7, { source: "NON_STOCK", name: "חלק פתוח", quantity: 1 }, { idempotencyKey: key() });
  await act(A, c7, { type: "START_REPAIR" });
  await act(A, c7, { type: "FINISH_REPAIR", outcome: "REPAIRED" });
  await act(A, c7, { type: "DELIVER", receipt: { handoverConfirmed: true } }, key(), settled);
  const open = await code(() => act(A, c7, { type: "CLOSE" }));
  ok("C5 an open part line refuses the close (OPEN_PART_RESERVATIONS); the case stays DELIVERED", open.includes("OPEN_PART_RESERVATIONS") && (await status(A, c7)) === "DELIVERED", open);

  console.log("G — the generic action route");
  const g = await diagnosing(A);
  const gq = await code(() => act(A, g, { type: "SEND_QUOTE", quote: { version: 1, totalAgorot: 100, docHash: "h" } }));
  const ga = await code(() => act(A, g, { type: "APPROVE_QUOTE", approval: { version: 1, totalAgorot: 100, docHash: "h", method: "PHONE" } }));
  ok("G1 the quote actions on the generic route → ACTION_NOT_IN_SCOPE naming their own command (use: quotes); SCHEDULE still out of scope",
    gq.startsWith("ACTION_NOT_IN_SCOPE") && gq.includes('"use":"quotes"') && ga.includes('"use":"quotes"')
      && (await code(() => act(A, g, { type: "SCHEDULE", appointmentId: 1 }))).startsWith("ACTION_NOT_IN_SCOPE"));

  console.log("I — isolation");
  const iso = [
    await code(() => sendQuote(B.p, c4, { billingDocumentId: foreign, expectedVersion: 1 }, { idempotencyKey: key() }, { render: stubRender, storage: store })),
    await code(() => decideQuote(B.p, c3, 1, { decision: "REJECT", method: "PHONE", expectedVersion: 1 }, { idempotencyKey: key() }, { storage: store })),
    await code(() => listQuotes(B.b, c1)),
    await code(() => getQuote(B.b, c1, 2)),
    await code(() => readQuotePdf(B.b, c1, 1, store)),
  ];
  ok("I1 another business cannot send on, decide, list, read or fetch A's quotes (NOT_FOUND, nothing written)", iso.every((r) => r === "NOT_FOUND") && (await status(A, c3)) === "QUOTE_PENDING", JSON.stringify(iso));
  const seen = await runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(B.b));
    return Number(((await tx.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "ServiceQuote" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceCaseCharge" WHERE "businessId" = $1) AS n`, A.b)) as Rows)[0].n);
  });
  ok("I2 the runtime role in B's context sees none of A's quote or charge rows", seen === 0);

  console.log("P — closed payloads");
  const payloads = await own(A.b, `SELECT payload::text p FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND action::text IN ('SEND_QUOTE', 'REVISE_QUOTE', 'APPROVE_QUOTE', 'REJECT_QUOTE', 'CANCEL', 'CLOSE')`, A.b);
  ok("P1 every quote / cancel / close payload holds tokens, numbers and booleans only", payloads.length >= 10 && payloads.every((r) => !/[֐-׿]/.test(String(r.p))), String(payloads.length));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
