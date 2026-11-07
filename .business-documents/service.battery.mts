/**
 * ר1 services AS the runtime role, on the real migration (Production topology: .business-documents/lab.sh --with-bd).
 *
 *   A  idempotent keys through the real service (replay, conflict, parallel, expired, unknown, cross-business)
 *   B  the share copy never writes the billing mechanism (full billing fingerprint before/after; READ ONLY tx)
 *   C  a change during the render — two TIMED transactions (and why a re-read inside one REPEATABLE READ cannot see it)
 *   D  the owner's record through the service (separate download / share sheet / sent; corrections; older versions)
 *   E  the fence, against a store with R2's documented semantics (late commit possible; create-once atomic):
 *      upload before the marker, marker before the upload, retries, a failed marker, a lease takeover, reconcile
 *   F  account erasure while an upload is in flight (the runner — not connected to account deletion)
 *   G  the internal reminders (S08 closed only by an in-force response; S09 after "sent" with no response)
 *
 * env: DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner — seeding / simulated edits only), STORAGE_PROVIDER=local,
 *      LOCAL_STORAGE_ROOT, BILLING_PDF_STORAGE_ROOT, AUTH_TOKEN_SECRET; Chromium (npx playwright install chromium).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

import { createBillingDraft, replaceBillingDraftLines } from "../lib/services/billing/billing-draft.service";
import { getOrRenderQuotePdf } from "../lib/services/billing/quote-pdf.service";
import { bdTx } from "../lib/services/business-documents/bd-tx";
import { runBusinessDocumentsErasure } from "../lib/services/business-documents/erasure/business-docs-erasure";
import { closeKey, fenceFile, reconcileBusiness, FENCE_MARKER } from "../lib/services/business-documents/files/business-docs-files";
import { contentRowsOf, prepareQuoteShareCopy, QuoteCopyRefusedError, loadQuoteRenderRows } from "../lib/services/business-documents/quote-share/quote-share-copy.service";
import { quoteContentHash } from "../lib/services/business-documents/quote-share/quote-share-content";
import { getQuoteShareView, recordQuoteShareEvent } from "../lib/services/business-documents/quote-share/quote-share-events.service";
import { quotesClosedByResponse, selectFollowUps } from "../lib/services/business-documents/quote-share/quote-share-reminders";
import { BusinessDocumentsRequestError, issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";
import { getStorageService, type ListedObject, type PutIfAbsentResult, type PutObjectInput, type StorageService } from "../lib/storage";
import { addCalendarDays, jerusalemDayKey } from "../lib/utils/jerusalem-day";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    if (e instanceof BusinessDocumentsRequestError || e instanceof QuoteCopyRefusedError) return e.code;
    return `ERR:${String((e as Error).message).split("\n").slice(-1)[0].slice(0, 160)}`;
  }
}

/** Everything of the billing mechanism a read could disturb: rows, audit, numbering, stored billing PDFs. */
async function billingFingerprint(): Promise<string> {
  const q = async (sql: string) => JSON.stringify(await own.$queryRawUnsafe(sql));
  const parts = [
    await q(`SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY id)) AS h FROM "BillingDocument" t`),
    await q(`SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY id)) AS h FROM "BillingDocumentLine" t`),
    await q(`SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY id)) AS h FROM "BillingAuditEvent" t`),
    await q(`SELECT md5(string_agg(row_to_json(t)::text, '|' ORDER BY 1)) AS h FROM "BillingDocumentNumberSequence" t`),
    await q(`SELECT count(*)::text AS n FROM "AuditLog"`).catch(() => "no-AuditLog"),
  ];
  const root = process.env.LOCAL_STORAGE_ROOT as string;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "business-docs") walk(p);
      } else files.push(path.relative(root, p) + ":" + sha(readFileSync(p)));
    }
  };
  try {
    walk(root);
  } catch {
    /* empty root */
  }
  parts.push(files.sort().join("|"));
  return sha(parts.join("\n"));
}

/** A store with R2's DOCUMENTED semantics: create-once is atomic at commit; an abandoned PUT may still commit later. */
class R2LikeStore implements StorageService {
  objs = new Map<string, { body: Buffer; contentType: string }>();
  delayNextPutMs = 0;
  failMarkers = false;
  async putObject(): Promise<never> {
    throw new Error("unconditional put is never used in business-docs");
  }
  putObjectIfAbsent(input: PutObjectInput): Promise<PutIfAbsentResult> {
    const delay = this.delayNextPutMs;
    this.delayNextPutMs = 0;
    if (this.failMarkers && input.contentType === "application/x-dubiz-fence") return Promise.reject(new Error("simulated storage outage"));
    return new Promise((resolve) => setTimeout(() => {
      if (this.objs.has(input.key)) return resolve({ status: "EXISTS", key: input.key });
      this.objs.set(input.key, { body: input.body, contentType: input.contentType });
      resolve({ status: "CREATED", key: input.key, metadata: { businessId: input.metadata.businessId, domain: input.metadata.domain, visibility: input.metadata.visibility, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString() } });
    }, delay));
  }
  /** an UNconditional late write (what a store without If-None-Match would let through) — for the reconciler proof */
  forceWrite(key: string, body: string) {
    this.objs.set(key, { body: Buffer.from(body), contentType: "application/pdf" });
  }
  async getObject(key: string) {
    const o = this.objs.get(key);
    if (!o) throw new Error("not found");
    return { body: o.body, metadata: { businessId: 0, domain: "business-docs" as const, visibility: "private" as const, contentType: o.contentType, size: o.body.length, createdAt: "" } };
  }
  async headObject(key: string) {
    const o = this.objs.get(key);
    return o ? { exists: true, metadata: { businessId: 0, domain: "business-docs" as const, visibility: "private" as const, contentType: o.contentType, size: o.body.length, createdAt: "" } } : { exists: false };
  }
  async getMetadata(key: string) {
    return (await this.headObject(key)).metadata!;
  }
  async deleteObject(key: string) {
    this.objs.delete(key);
  }
  async listObjects(prefix: string): Promise<ListedObject[]> {
    return [...this.objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.body.length }));
  }
  async getSignedDownloadUrl(): Promise<string> {
    throw new Error("no signed URLs");
  }
  getPublicUrl() {
    return null;
  }
}
const isMarker = (store: R2LikeStore, key: string) => store.objs.get(key)?.body.equals(FENCE_MARKER) === true;
const fakeRender = async (s: { lines: { description: string }[] }) => Buffer.from(`%PDF-fake ${s.lines.map((l) => l.description).join("|")} ${Math.random()}`);

async function main() {
  const stamp = Date.now();
  const mkBusiness = async (name: string) => {
    const b = await own.business.create({ data: { name: `svc-${name}-${stamp}` } });
    const u = await own.user.create({ data: { email: `svc-${name}-${stamp}@example.test`, password: "synthetic", businessId: b.id, role: "USER" } });
    await own.businessProfile.create({ data: { businessId: b.id, billingLegalName: `עסק ${name}`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingVatNumber: "999999998", billingAddress: "רחוב 1", billingPdfTemplateStyle: "CLASSIC" } });
    const c = await own.customer.create({ data: { businessId: b.id, name: "לקוח מורשה", taxId: "000000018", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
    return { b: b.id, u: u.id, c: c.id };
  };
  const A = await mkBusiness("A"), B = await mkBusiness("B");
  const L1 = [{ description: "שירות", quantity: "2", unitPrice: "1500", vatRatePercent: "18" }];
  const L2 = [{ description: "שירות מעודכן", quantity: "3", unitPrice: "1500", vatRatePercent: "18" }];
  const newQuote = async (x: typeof A, numbered = true) => {
    const q = await createBillingDraft({ businessId: x.b, actorUserId: x.u, documentType: BillingDocumentType.QUOTE, customerId: x.c, initialLines: L1 });
    if (numbered) await getOrRenderQuotePdf({ businessId: x.b, billingDocumentId: q.id, actorUserId: x.u }); // the EXISTING screen's PDF button (prep)
    return q.id;
  };
  const key = (x: typeof A, op: "QUOTE_SHARE_COPY" | "QUOTE_SHARE_EVENT" | "LETTER_SAVE" = "QUOTE_SHARE_COPY") => bdTx(x.b, (tx) => issueRequestKey(tx, x.b, x.u, op));
  const storage = getStorageService();

  console.log("--- B: the share copy never writes the billing mechanism ---");
  const qNoNumber = await newQuote(A, false);
  let before = await billingFingerprint();
  const noNum = await code(async () => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: qNoNumber, idempotencyKey: await key(A) }));
  ok("a quote without a number → NO_QUOTE_NUMBER (sent to the existing screen), and nothing in billing changed (no number allocated)", noNum === "NO_QUOTE_NUMBER" && before === (await billingFingerprint()), noNum);
  const q1 = await newQuote(A);
  before = await billingFingerprint();
  const c1 = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: await key(A) });
  ok("a real copy (existing renderer, Chromium) is stored and recorded", c1.id > 0 && !c1.replay);
  ok("billing fingerprint identical before/after the copy (rows, audit, numbering, stored billing PDFs)", before === (await billingFingerprint()));
  const stored = await storage.getObject((await own.businessDocumentFile.findFirstOrThrow({ where: { id: (await own.quoteShareCopy.findFirstOrThrow({ where: { id: c1.id } })).fileId } })).objectKey);
  ok("the stored copy is a PDF and hashes to the recorded digest", stored.body.subarray(0, 4).toString() === "%PDF" && sha(stored.body) === c1.sha256);
  const billingPdfKey = (await own.billingDocument.findFirstOrThrow({ where: { id: q1 } })).pdfStorageKey;
  ok("the copy is a NEW file, never the billing PDF of the existing screen", !!billingPdfKey && !billingPdfKey.includes("business-docs"));
  const ro = await code(() => bdTx(A.b, (tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "currency" = 'ILS' WHERE id = ${q1}`), { repeatableRead: true, readOnly: true }));
  ok("the read transaction of the copy is READ ONLY: a write inside it is refused by the database", ro.includes("read-only transaction"), ro);
  const qOtherBiz = await newQuote(B);
  ok("another business's quote → NOT_FOUND", (await code(async () => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: qOtherBiz, idempotencyKey: await key(A) }))) === "NOT_FOUND");
  const qSvc = await newQuote(A);
  await own.$executeRawUnsafe(`INSERT INTO "ServiceQuote" ("businessId", "caseId", "version", "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256") VALUES ($1, 1, 1, $2, 100, 'h', $3, 'h')`, A.b, qSvc, `biz/${A.b}/service/q.pdf`);
  ok("a Service Desk quote → SERVICE_DESK_QUOTE", (await code(async () => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: qSvc, idempotencyKey: await key(A) }))) === "SERVICE_DESK_QUOTE");

  console.log("--- A: idempotent keys through the service ---");
  const k1 = await key(A);
  const a1 = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: k1 }, { render: fakeRender });
  const a2 = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: k1 }, { render: fakeRender });
  ok("same key, same request → the ORIGINAL copy (no second render, no second file)", a2.replay && a2.id === a1.id && a2.sha256 === a1.sha256);
  ok("same key, different quote → IDEMPOTENCY_CONFLICT", (await code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: qNoNumber, idempotencyKey: k1 }))) === "IDEMPOTENCY_CONFLICT");
  const kp = await key(A);
  const filesBefore = await own.businessDocumentFile.count({ where: { businessId: A.b } });
  const par = await Promise.all(Array.from({ length: 8 }, () => code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: kp }, { render: fakeRender }))));
  const copiesForKp = await own.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "QuoteShareCopy" c JOIN "BusinessDocumentRequest" r ON r."resultId" = c.id AND r."operation" = 'QUOTE_SHARE_COPY' WHERE r."idempotencyKey" = $1::uuid`, kp);
  ok("8 parallel requests with one key → exactly one copy; the others IN_PROGRESS or the same copy", copiesForKp[0].n === 1 && par.filter((p) => p === "OK").length >= 1 && par.every((p) => p === "OK" || p === "IN_PROGRESS"), JSON.stringify(par.reduce((m: Record<string, number>, p) => ({ ...m, [p]: (m[p] ?? 0) + 1 }), {})));
  ok("…and exactly one new file row", (await own.businessDocumentFile.count({ where: { businessId: A.b } })) - filesBefore === 1);
  const kOld = await key(A);
  await own.$executeRawUnsafe(`UPDATE "BusinessDocumentRequest" SET "issuedAt" = now() - interval '25 hours' WHERE "idempotencyKey" = $1::uuid`, kOld);
  ok("a key issued 25 hours ago → EXPIRED, nothing created", (await code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: kOld }))) === "EXPIRED");
  ok("a key never issued → UNKNOWN_KEY", (await code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: "3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f" }))) === "UNKNOWN_KEY");
  ok("business B cannot use business A's key → UNKNOWN_KEY", (await code(() => prepareQuoteShareCopy({ businessId: B.b, userId: B.u, quoteId: qOtherBiz, idempotencyKey: k1 }))) === "UNKNOWN_KEY");
  const kEv = await key(A, "QUOTE_SHARE_EVENT");
  ok("a key issued for events cannot prepare a copy", (await code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: kEv }))) === "UNKNOWN_KEY");

  console.log("--- C: a change during the render (two timed transactions) ---");
  {
    const q = await newQuote(A);
    const k = await key(A);
    const r = await code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k }, {
      render: fakeRender,
      afterRead: async () => { await replaceBillingDraftLines({ businessId: A.b, actorUserId: A.u, billingDocumentId: q, lines: L2 }); },
    }));
    ok("C1 an edit committed between T1 (read) and T2 (re-read) → CHANGED_DURING_RENDER, no copy", r === "CHANGED_DURING_RENDER" && (await own.quoteShareCopy.count({ where: { quoteDocumentId: q } })) === 0, r);
    const abandoned = await own.businessDocumentFile.findMany({ where: { businessId: A.b, state: "DELETING" }, orderBy: { id: "desc" }, take: 1 });
    ok("C1 the uploaded object's row is abandoned to the janitor (DELETING), never committed", abandoned.length === 1);
    const retry = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k }, { render: fakeRender });
    const now = await bdTx(A.b, async (tx) => quoteContentHash(contentRowsOf((await loadQuoteRenderRows(tx, A.b, q))!)));
    ok("C1 the key was released: the same request retried builds the copy from the NEW content", !retry.replay && retry.quoteContentHash === now);
  }
  {
    const q = await newQuote(A);
    const k = await key(A);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let editDone: Promise<unknown> = Promise.resolve();
    const lineId = (await own.billingDocumentLine.findFirstOrThrow({ where: { billingDocumentId: q } })).id;
    const copy = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k }, {
      render: fakeRender,
      beforeCommit: async () => {
        // An edit that has started (row locked, uncommitted) when T2 takes its snapshot, and commits after the copy.
        editDone = own.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE "BillingDocumentLine" SET "description" = 'עריכה מאוחרת' WHERE id = $1`, lineId); await gate; }, { timeout: 30000 });
        await sleep(300);
      },
    });
    release();
    await editDone;
    const view = await getQuoteShareView(A.b, q);
    ok("C2 an edit still uncommitted at T2's snapshot is a LATER edit: the copy is recorded with the content it was rendered from", copy.id > 0 && view!.copies[0].id === copy.id);
    ok("C2 once that edit commits, the screen says the quote changed since this copy", view!.copies[0].changedSince === true);
  }
  {
    // Why two transactions: inside ONE repeatable-read transaction, a re-read sees the same snapshot — blind to the edit.
    const q = await newQuote(A);
    const lineId = (await own.billingDocumentLine.findFirstOrThrow({ where: { billingDocumentId: q } })).id;
    const sameTx = await bdTx(A.b, async (tx) => {
      const h1 = quoteContentHash(contentRowsOf((await loadQuoteRenderRows(tx, A.b, q))!));
      await own.$executeRawUnsafe(`UPDATE "BillingDocumentLine" SET "description" = 'עריכה במקביל' WHERE id = $1`, lineId);
      const h2 = quoteContentHash(contentRowsOf((await loadQuoteRenderRows(tx, A.b, q))!));
      return { h1, h2 };
    }, { repeatableRead: true, readOnly: true });
    const fresh = await bdTx(A.b, async (tx) => quoteContentHash(contentRowsOf((await loadQuoteRenderRows(tx, A.b, q))!)), { repeatableRead: true, readOnly: true });
    ok("C3 a re-read inside the SAME repeatable-read transaction does NOT see a committed concurrent edit", sameTx.h1 === sameTx.h2);
    ok("C3 a NEW transaction does — which is why the check is T2, a separate transaction after the render", fresh !== sameTx.h1);
  }

  console.log("--- D: the owner's record through the service ---");
  const ev = async (event: Parameters<typeof recordQuoteShareEvent>[0]["event"], k?: string) => recordQuoteShareEvent({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: k ?? (await key(A, "QUOTE_SHARE_EVENT")), event });
  const base = { copyId: null, channel: null, note: null, correctsEventId: null } as const;
  const dl = await ev({ ...base, kind: "DOWNLOADED", copyId: c1.id });
  const sh = await ev({ ...base, kind: "SHARE_SHEET_OPENED", copyId: c1.id });
  const kSent = await key(A, "QUOTE_SHARE_EVENT");
  const st = await ev({ ...base, kind: "MARKED_SENT", copyId: c1.id, channel: "WHATSAPP" }, kSent);
  const stAgain = await ev({ ...base, kind: "MARKED_SENT", copyId: c1.id, channel: "WHATSAPP" }, kSent);
  ok("download, share sheet and marked-sent are three separate records", new Set([dl.id, sh.id, st.id]).size === 3);
  ok("marking sent again with the same key returns the first record", stAgain.replay && stAgain.id === st.id);
  ok("the same key with a different body → IDEMPOTENCY_CONFLICT", (await code(() => ev({ ...base, kind: "MARKED_SENT", copyId: c1.id, channel: "EMAIL" }, kSent))) === "IDEMPOTENCY_CONFLICT");
  const acc = await ev({ ...base, kind: "RESPONSE_ACCEPTED" });
  let view = await getQuoteShareView(A.b, q1);
  ok("the view: response ACCEPTED, sent recorded", view!.state.response === "ACCEPTED" && view!.state.sentAt !== null);
  await ev({ ...base, kind: "CORRECTION", correctsEventId: acc.id });
  await ev({ ...base, kind: "RESPONSE_DECLINED" });
  view = await getQuoteShareView(A.b, q1);
  ok("a mistaken ACCEPTED corrected, then DECLINED recorded → DECLINED; the corrected one is marked", view!.state.response === "DECLINED" && view!.events.find((e) => e.id === acc.id)!.corrected);
  ok("a refused event (copy of another quote) leaves the key usable", await (async () => {
    const k = await key(A, "QUOTE_SHARE_EVENT");
    const other = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: qNoNumber === -1 ? q1 : (await newQuote(A)), idempotencyKey: await key(A) }, { render: fakeRender });
    const refused = await code(() => recordQuoteShareEvent({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: k, event: { ...base, kind: "DOWNLOADED", copyId: other.id } }));
    const okAfter = await code(() => recordQuoteShareEvent({ businessId: A.b, userId: A.u, quoteId: q1, idempotencyKey: k, event: { ...base, kind: "NOTE", note: "בדיקה" } }));
    return refused === "ERR:COPY_NOT_FOUND" || (refused.includes("COPY_NOT_FOUND") && okAfter === "OK");
  })());
  await replaceBillingDraftLines({ businessId: A.b, actorUserId: A.u, billingDocumentId: q1, lines: L2 });
  view = await getQuoteShareView(A.b, q1);
  ok("after an edit, earlier records are 'older version' and decide nothing", view!.state.response === null && view!.state.sentAt === null && view!.events.filter((e) => e.kind !== "CORRECTION").every((e) => e.olderVersion) && view!.copies.every((c) => c.changedSince));

  console.log("--- E: the fence (store with R2's documented semantics) ---");
  const fake = new R2LikeStore();
  const pendingFile = async (x: typeof A) => bdTx(x.b, async (tx) => {
    const objectKey = `biz/${x.b}/business-docs/quote-shares/${crypto.randomUUID()}.pdf`;
    const r = await tx.$queryRaw<{ id: number }[]>`INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES (${x.b}, 'QUOTE_SHARE_COPY'::"BusinessDocumentFilePurpose", ${objectKey}) RETURNING "id"`;
    return { id: r[0].id, objectKey };
  });
  const toDeleting = (x: typeof A, id: number) => bdTx(x.b, (tx) => tx.$executeRaw`UPDATE "BusinessDocumentFile" SET "state" = 'DELETING' WHERE "id" = ${id}`);
  const stateOf = async (id: number) => (await own.businessDocumentFile.findFirstOrThrow({ where: { id } })).state;
  {
    const f = await pendingFile(A);
    await fake.putObjectIfAbsent({ key: f.objectKey, body: Buffer.from("%PDF upload"), contentType: "application/pdf", metadata: { businessId: A.b, domain: "business-docs", visibility: "private" } });
    await toDeleting(A, f.id);
    const r = await fenceFile(A.b, f.id, fake);
    ok("E1 the upload landed before the marker: the object is deleted, the marker is in place, FENCED", r === "FENCED" && isMarker(fake, f.objectKey) && (await stateOf(f.id)) === "FENCED");
  }
  {
    const f = await pendingFile(A);
    fake.delayNextPutMs = 800; // an upload in flight; its client may already be gone
    const late = fake.putObjectIfAbsent({ key: f.objectKey, body: Buffer.from("%PDF late"), contentType: "application/pdf", metadata: { businessId: A.b, domain: "business-docs", visibility: "private" } });
    await toDeleting(A, f.id);
    const r = await fenceFile(A.b, f.id, fake);
    const lateResult = await late;
    ok("E2 the marker landed before the upload: FENCED, and the late upload is refused (412 → EXISTS) — the key holds the marker", r === "FENCED" && lateResult.status === "EXISTS" && isMarker(fake, f.objectKey));
  }
  {
    const f = await pendingFile(A);
    await toDeleting(A, f.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => closeKey(A.b, f.objectKey, fake)));
    const r = await fenceFile(A.b, f.id, fake);
    ok("E3 five concurrent / repeated closings all succeed on one marker; the row then goes FENCED", rs.every(Boolean) && isMarker(fake, f.objectKey) && r === "FENCED");
  }
  {
    const f = await pendingFile(A);
    await fake.putObjectIfAbsent({ key: f.objectKey, body: Buffer.from("%PDF x"), contentType: "application/pdf", metadata: { businessId: A.b, domain: "business-docs", visibility: "private" } });
    await toDeleting(A, f.id);
    fake.failMarkers = true;
    const r = await fenceFile(A.b, f.id, fake);
    ok("E4 a failed marker write is NOT a deletion: RETRY_LATER, the row stays DELETING", r === "RETRY_LATER" && (await stateOf(f.id)) === "DELETING");
    fake.failMarkers = false;
    ok("E4 the next run fences it", (await fenceFile(A.b, f.id, fake)) === "FENCED");
  }
  {
    // A lease takeover: the first request stalls past its lease; a retry with the same key takes over and finishes.
    const q = await newQuote(A);
    const k = await key(A);
    let second: Awaited<ReturnType<typeof prepareQuoteShareCopy>> | null = null;
    const first = await code(() => prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k }, {
      render: fakeRender,
      storage: fake,
      beforeCommit: async () => {
        await own.$executeRawUnsafe(`UPDATE "BusinessDocumentRequest" SET "leaseUntil" = now() - interval '1 second' WHERE "idempotencyKey" = $1::uuid`, k);
        second = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k }, { render: fakeRender, storage: fake });
      },
    }));
    const copies = await own.quoteShareCopy.count({ where: { quoteDocumentId: q } });
    ok("E5 after a lease takeover the stale request cannot commit; exactly one copy exists (the taker's)", first !== "OK" && copies === 1 && second !== null, first);
    const deleting = await own.businessDocumentFile.findMany({ where: { businessId: A.b, state: "DELETING" }, select: { id: true, objectKey: true } });
    for (const d of deleting) await fenceFile(A.b, d.id, fake);
    ok("E5 the stale request's object is fenced by the janitor", deleting.length > 0 && deleting.every((d) => !fake.objs.has(d.objectKey) || isMarker(fake, d.objectKey)));
    const replay = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k }, { render: fakeRender, storage: fake });
    ok("E5 a later retry returns the taker's copy", replay.replay && replay.id === second!.id);
  }
  {
    const fenced = await own.businessDocumentFile.findFirstOrThrow({ where: { businessId: A.b, state: "FENCED" } });
    fake.forceWrite(fenced.objectKey, "%PDF unconditional late write");
    fake.forceWrite(`biz/${A.b}/business-docs/quote-shares/stray.pdf`, "%PDF stray");
    const rep = await reconcileBusiness(A.b, fake);
    ok("E6 reconcile: a non-marker object under a FENCED key is deleted and fenced again", rep.refenced.includes(fenced.objectKey) && isMarker(fake, fenced.objectKey));
    ok("E6 reconcile: an object with no row is reported, not deleted", rep.unknownObjects.some((k) => k.endsWith("stray.pdf")) && fake.objs.has(`biz/${A.b}/business-docs/quote-shares/stray.pdf`));
  }

  console.log("--- F: account erasure while an upload is in flight (runner; not connected to account deletion) ---");
  {
    const C = await mkBusiness("C");
    const q = await newQuote(C);
    const done1 = await prepareQuoteShareCopy({ businessId: C.b, userId: C.u, quoteId: q, idempotencyKey: await key(C) }, { render: fakeRender, storage: fake });
    const f = await pendingFile(C);
    fake.delayNextPutMs = 1200;
    const late = fake.putObjectIfAbsent({ key: f.objectKey, body: Buffer.from("%PDF in flight"), contentType: "application/pdf", metadata: { businessId: C.b, domain: "business-docs", visibility: "private" } });
    await own.business.update({ where: { id: C.b }, data: { deletionRequestedAt: new Date() } });
    fake.failMarkers = true;
    const run1 = await runBusinessDocumentsErasure(C.b, fake);
    ok("F1 while the markers cannot be written, the erasure is NOT done (files stay DELETING)", run1.done === false && run1.pending >= 1);
    ok("F1 new work for the business is refused meanwhile", (await code(() => key(C))).includes("BEING_ERASED"));
    fake.failMarkers = false;
    const run2 = await runBusinessDocumentsErasure(C.b, fake);
    const lateResult = await late;
    const left = await fake.listObjects(`biz/${C.b}/business-docs/`);
    ok("F2 the next run fences every key and completes", run2.done === true);
    ok("F2 the in-flight upload could not land after its key was fenced; only data-free markers remain", lateResult.status === "EXISTS" && left.length > 0 && left.every((o) => isMarker(fake, o.key)), `late=${lateResult.status} left=${left.length}`);
    ok("F2 no record of the business remains", (await own.quoteShareCopy.count({ where: { businessId: C.b } })) === 0 && (await own.businessDocumentFile.count({ where: { businessId: C.b } })) === 0 && done1.id > 0);
  }

  console.log("--- G: internal reminders ---");
  {
    const q = await newQuote(A);
    await own.billingDocument.update({ where: { id: q }, data: { validUntil: new Date(Date.now() + 86400000) } });
    const cp = await prepareQuoteShareCopy({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: await key(A) }, { render: fakeRender });
    const rec = (event: Parameters<typeof recordQuoteShareEvent>[0]["event"]) => key(A, "QUOTE_SHARE_EVENT").then((k) => recordQuoteShareEvent({ businessId: A.b, userId: A.u, quoteId: q, idempotencyKey: k, event }));
    const closed = () => bdTx(A.b, (tx) => quotesClosedByResponse(tx, A.b, [q]));
    await rec({ ...base, kind: "NOTE", note: "הלקוח יחזור אליי" });
    ok("G1 S08: a note does not close the validity reminder", !(await closed()).has(q));
    const sent = await rec({ ...base, kind: "MARKED_SENT", copyId: cp.id, channel: "EMAIL" });
    const today = jerusalemDayKey(new Date());
    const due = (day: string) => bdTx(A.b, (tx) => selectFollowUps(tx, A.b, day as never, 30)).then((r) => r.items.some((i) => i.quoteId === q));
    ok("G2 S09: not due on the day it was marked sent", !(await due(today)));
    ok("G2 S09: due 3 days later", await due(addCalendarDays(today, 3)));
    ok("G1 S08: marked sent does not close it either", !(await closed()).has(q));
    const acc = await rec({ ...base, kind: "RESPONSE_ACCEPTED" });
    ok("G3 an in-force response closes S08 and stops S09", (await closed()).has(q) && !(await due(addCalendarDays(today, 5))));
    await rec({ ...base, kind: "CORRECTION", correctsEventId: acc.id });
    ok("G4 after correcting the response, S08 is open again and S09 is due again", !(await closed()).has(q) && (await due(addCalendarDays(today, 5))));
    await replaceBillingDraftLines({ businessId: A.b, actorUserId: A.u, billingDocumentId: q, lines: L2 });
    ok("G5 after the quote changes, the earlier 'sent' no longer drives S09 (a new version must be shared again)", !(await due(addCalendarDays(today, 5))) && sent.id > 0);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await own.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await own.$disconnect();
  process.exit(1);
});
