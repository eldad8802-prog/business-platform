/**
 * Business documents (ר1–ר3) — server-side permission and isolation battery, on a
 * throwaway PostgreSQL (ephemeral postgres:17 in CI). Synthetic data only; no
 * Production, no secrets, no network.
 *
 * ר3 reads through EXISTING routes only; this battery proves, through the real route
 * handlers and a real signed session, that:
 *   I1  an unauthenticated request is refused (401);
 *   I2  a business owner sees exactly their customer's documents;
 *   I3  another business asking for that customer id sees none of them;
 *   I4  another business cannot open that customer's card (the screen's name source);
 *   I5  paging by cursor returns every document once, newest first;
 *   I6  reading changes nothing: documents are byte-identical before and after.
 *
 * ר2 letters (stateless routes, behind business_documents):
 *   L1  no session → 401;  L2  flag off (the default) → 404, per business;
 *   L3  flag on → a preview with the business letterhead, the subject escaped, a strict CSP;
 *   L4  a customer / supplier of another business → 404 (nothing of it rendered);
 *   L5  invalid input → 400 with field problems; a non-JSON body → 400;
 *   L6  a retried request → the same bytes;  L7  rendering writes nothing;
 *   L8  (RENDER=1, needs Chromium) the PDF is a real PDF whose text carries the letter.
 *
 * Note: the lab is built with `prisma db push`, so Postgres RLS policies are not
 * installed here; I3/I4 prove the application-level scoping (session → businessId
 * in every query). RLS in Production is an additional layer on top.
 *
 * Run: DATABASE_URL=<throwaway> npx tsx .business-documents/battery.mts
 */
import { BillingDocumentType, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../lib/auth-token";
import { createBillingDraft } from "../lib/services/billing/billing-draft.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { GET as listDocuments } from "../app/api/billing/documents/route";
import { GET as getCustomer } from "../app/api/customers/[id]/route";
import { POST as letterPreview } from "../app/api/business-documents/letters/preview/route";
import { POST as letterPdf } from "../app/api/business-documents/letters/pdf/route";

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

const LINE = { description: "שירות", quantity: "1", unitPrice: "100", vatRatePercent: "18" };

async function tenant(label: string) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const business = await prisma.business.create({ data: { name: `bd-${label}-${stamp}` } });
  const user = await prisma.user.create({
    data: { email: `bd-${label}-${stamp}@example.test`, password: "synthetic", businessId: business.id, role: "USER" },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: `עסק ${label}`,
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingAddress: "רחוב 1",
      billingPhone: "0500000000",
      billingEmail: `${label}@example.test`,
    },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: `לקוח ${label}` } });
  return { business, user, customer, token: signAuthToken(user.id, user.tokenVersion) };
}

function req(url: string, token: string | null) {
  return new NextRequest(`http://localhost${url}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function main() {
  const a = await tenant("a");
  const b = await tenant("b");

  // Seven documents for A's customer (issued and drafts, three types), one for B's own customer.
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) {
    const type = i % 3 === 0 ? BillingDocumentType.QUOTE : BillingDocumentType.TAX_INVOICE;
    const d = await createBillingDraft({ businessId: a.business.id, actorUserId: a.user.id, documentType: type, customerId: a.customer.id, initialLines: [LINE] });
    ids.push(d.id);
    if (type === BillingDocumentType.TAX_INVOICE && i % 2 === 0) {
      await issueBillingDocument({ businessId: a.business.id, billingDocumentId: d.id, actorUserId: a.user.id });
    }
  }
  await createBillingDraft({ businessId: b.business.id, actorUserId: b.user.id, documentType: BillingDocumentType.TAX_INVOICE, customerId: b.customer.id, initialLines: [LINE] });

  const before = await prisma.billingDocument.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });

  const url = (customerId: number, extra = "") => `/api/billing/documents?customerId=${customerId}&limit=50${extra}`;

  const anon = await listDocuments(req(url(a.customer.id), null));
  ok("I1 no session → 401", anon.status === 401, String(anon.status));

  const own = await listDocuments(req(url(a.customer.id), a.token));
  const ownBody = (await own.json()) as { documents: { id: number; customerId: number; businessId: number }[] };
  ok("I2 owner gets 200", own.status === 200, String(own.status));
  ok("I2 owner sees exactly the 7 documents of the customer", ownBody.documents.length === 7 && ownBody.documents.every((d) => ids.includes(d.id)), String(ownBody.documents.length));
  ok("I2 every row belongs to the owner's business", ownBody.documents.every((d) => d.businessId === a.business.id));

  const cross = await listDocuments(req(url(a.customer.id), b.token));
  const crossBody = (await cross.json()) as { documents: unknown[] };
  ok("I3 another business sees none of that customer's documents", cross.status === 200 && crossBody.documents.length === 0, `${cross.status} / ${crossBody.documents.length}`);

  const crossCard = await getCustomer(req(`/api/customers/${a.customer.id}`, b.token), { params: Promise.resolve({ id: String(a.customer.id) }) });
  ok("I4 another business cannot open the customer card", crossCard.status === 404, String(crossCard.status));
  const ownCard = await getCustomer(req(`/api/customers/${a.customer.id}`, a.token), { params: Promise.resolve({ id: String(a.customer.id) }) });
  ok("I4 the owner can", ownCard.status === 200, String(ownCard.status));

  // I5 paging by 3: every id exactly once, newest first.
  const seen: number[] = [];
  let cursor: number | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const r = await listDocuments(req(`/api/billing/documents?customerId=${a.customer.id}&limit=3${cursor ? `&cursor=${cursor}` : ""}`, a.token));
    const body = (await r.json()) as { documents: { id: number }[]; nextCursor: number | null };
    seen.push(...body.documents.map((d) => d.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  ok("I5 paging returns all 7, each once", seen.length === 7 && new Set(seen).size === 7, JSON.stringify(seen));

  const after = await prisma.billingDocument.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  ok("I6 reading changed nothing", JSON.stringify(before) === JSON.stringify(after));

  await letters(a, b);
  await quoteValidity(a, b);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exitCode = 1;
  }
}

/**
 * ר1 / S08 — the Daily Tasks quote-validity source on real rows (A has business_documents ON from letters(), B OFF):
 *   Q1  B (flag off) gets no item even with an expiring quote, and S08 is not listed in B's preferences;
 *   Q2  A gets an expiring and an expired quote; not a converted one, not a far one, not a dateless one;
 *   Q3  a quote referenced by ANY ServiceQuote row (an older, superseded version too) is never an item;
 *   Q4  reading writes nothing (documents, task state, task rows unchanged).
 */
async function quoteValidity(a: Tenant, b: Tenant) {
  const { quoteValidity: adapter } = await import("../lib/services/tasks/sources");
  const { getPreferences } = await import("../lib/services/tasks/preferences.service");
  const today = "2026-11-05";
  const ctx = (businessId: number) => ({ businessId, now: new Date("2026-11-05T08:00:00.000Z"), today });
  const quote = async (t: Tenant, validUntil: string | null) => {
    const d = await createBillingDraft({ businessId: t.business.id, actorUserId: t.user.id, documentType: BillingDocumentType.QUOTE, customerId: t.customer.id, initialLines: [LINE] });
    if (validUntil) await prisma.billingDocument.update({ where: { id: d.id }, data: { validUntil: new Date(validUntil) } });
    return d.id;
  };

  const bExpiring = await quote(b, "2026-11-06T10:00:00.000Z");
  const soon = await quote(a, "2026-11-07T10:00:00.000Z");
  const expired = await quote(a, "2026-10-20T10:00:00.000Z");
  const far = await quote(a, "2026-12-20T10:00:00.000Z");
  const dateless = await quote(a, null);
  const converted = await quote(a, "2026-11-06T10:00:00.000Z");
  const convertedTo = await createBillingDraft({ businessId: a.business.id, actorUserId: a.user.id, documentType: BillingDocumentType.TAX_INVOICE, customerId: a.customer.id, initialLines: [LINE] });
  await prisma.billingDocument.update({ where: { id: converted }, data: { convertedToInvoiceId: convertedTo.id } });
  const serviceV1 = await quote(a, "2026-11-06T10:00:00.000Z");
  const serviceV2 = await quote(a, "2026-11-06T10:00:00.000Z");
  const sCase = await prisma.serviceCase.create({ data: { businessId: a.business.id, caseNumber: 1, kind: "IN_SHOP", customerId: a.customer.id } });
  for (const [version, billingDocumentId, state] of [[1, serviceV1, "SUPERSEDED"], [2, serviceV2, "SENT"]] as const) {
    await prisma.serviceQuote.create({
      data: { businessId: a.business.id, caseId: sCase.id, version, billingDocumentId, totalAgorot: 11800, docHash: `h${version}`, sentPdfKey: `biz/${a.business.id}/service/q${version}.pdf`, sentPdfSha256: `s${version}`, state },
    });
  }

  const before = await Promise.all([prisma.billingDocument.count(), prisma.taskSourceState.count(), prisma.task.count()]);
  const bOut = await adapter(ctx(b.business.id));
  ok("Q1 flag off → no item for B", bOut.items.length === 0 && !bOut.items.some((i) => i.entity?.id === bExpiring), JSON.stringify(bOut.items.map((i) => i.dedupeKey)));
  const bPrefs = await getPreferences(b.business.id);
  ok("Q1 S08 not listed in B's preferences", !bPrefs.sources.some((s) => s.kind === "quote_validity"));
  const aPrefs = await getPreferences(a.business.id);
  ok("Q1 S08 listed in A's preferences", aPrefs.sources.some((s) => s.kind === "quote_validity"));

  const aOut = await adapter(ctx(a.business.id));
  const ids = aOut.items.map((i) => i.entity?.id);
  ok("Q2 the expiring and the expired quote are items", ids.includes(soon) && ids.includes(expired), JSON.stringify(ids));
  ok("Q2 not the far, the dateless or the converted quote", !ids.includes(far) && !ids.includes(dateless) && !ids.includes(converted));
  ok("Q2 dedupe key follows the spec (quote:<id>:validity)", aOut.items.every((i) => /^quote:\d+:validity$/.test(i.dedupeKey)));
  ok("Q2 the action opens the existing quote screen", aOut.items.every((i) => i.action.href === `/billing/${i.entity?.id}`));
  ok("Q3 service-case quotes (every version) are never items", !ids.includes(serviceV1) && !ids.includes(serviceV2), JSON.stringify(ids));
  const after = await Promise.all([prisma.billingDocument.count(), prisma.taskSourceState.count(), prisma.task.count()]);
  ok("Q4 reading wrote nothing", JSON.stringify(before) === JSON.stringify(after));
}

function post(url: string, token: string | null, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function counts() {
  const [docs, customers, suppliers, overrides, audits] = await Promise.all([
    prisma.billingDocument.count(),
    prisma.customer.count(),
    prisma.supplier.count(),
    prisma.businessFeatureAccess.count(),
    prisma.billingAuditEvent.count(),
  ]);
  return { docs, customers, suppliers, overrides, audits };
}

type Tenant = Awaited<ReturnType<typeof tenant>>;

async function letters(a: Tenant, b: Tenant) {
  const letter = { recipientKind: "free", recipientName: "חברת בדיקה", subject: "<b>הודעה</b> חשובה", body: "שלום רב,\n\nתודה.", date: "2026-11-05", signerName: "בעל העסק" };
  const PREVIEW = "/api/business-documents/letters/preview";

  const anon = await letterPreview(post(PREVIEW, null, letter));
  ok("L1 no session → 401", anon.status === 401, String(anon.status));
  const off = await letterPreview(post(PREVIEW, a.token, letter));
  ok("L2 flag off (default) → 404", off.status === 404, String(off.status));

  // Lab only: open the feature for business A (definition row + business override). Never done outside a lab.
  await prisma.platformFeatureDefinition.upsert({
    where: { key: "business_documents" },
    create: { key: "business_documents", displayName: "מסמכים נוספים", category: "documents", defaultEnabled: false },
    update: {},
  });
  await prisma.businessFeatureAccess.create({ data: { businessId: a.business.id, featureKey: "business_documents", state: "ENABLED", reason: "lab" } });
  const bSupplier = await prisma.supplier.create({ data: { businessId: b.business.id, name: "ספק b" } });

  const before = await counts();
  const r1 = await letterPreview(post(PREVIEW, a.token, letter));
  const html1 = await r1.text();
  ok("L3 preview 200 as HTML", r1.status === 200 && (r1.headers.get("content-type") ?? "").startsWith("text/html"), String(r1.status));
  ok("L3 business letterhead printed", html1.includes("עסק a"));
  ok("L3 subject escaped", html1.includes("&lt;b&gt;הודעה&lt;/b&gt;") && !html1.includes("<b>הודעה</b>"));
  ok("L3 preview carries a strict CSP", (r1.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));

  const crossCustomer = await letterPreview(post(PREVIEW, a.token, { ...letter, recipientKind: "customer", customerId: b.customer.id, recipientName: "" }));
  const crossText = await crossCustomer.text();
  ok("L4 another business's customer → 404", crossCustomer.status === 404 && !crossText.includes("לקוח b"), String(crossCustomer.status));
  const ownCustomer = await letterPreview(post(PREVIEW, a.token, { ...letter, recipientKind: "customer", customerId: a.customer.id, recipientName: "" }));
  ok("L4 own customer → its name on the letter", ownCustomer.status === 200 && (await ownCustomer.text()).includes("לקוח a"));
  const crossSupplier = await letterPreview(post(PREVIEW, a.token, { ...letter, recipientKind: "supplier", supplierId: bSupplier.id, recipientName: "" }));
  ok("L4 another business's supplier → 404", crossSupplier.status === 404, String(crossSupplier.status));
  const bOff = await letterPreview(post(PREVIEW, b.token, letter));
  ok("L2 the flag is per business: B is still 404", bOff.status === 404, String(bOff.status));

  const bad = await letterPreview(post(PREVIEW, a.token, { ...letter, subject: "", date: "2026-02-30" }));
  const badBody = (await bad.json()) as { problems?: { field: string }[] };
  const fields = (badBody.problems ?? []).map((p) => p.field);
  ok("L5 invalid input → 400 with field problems", bad.status === 400 && fields.includes("subject") && fields.includes("date"), JSON.stringify(badBody));
  const notJson = await letterPreview(new NextRequest(`http://localhost${PREVIEW}`, { method: "POST", headers: { Authorization: `Bearer ${a.token}` }, body: "not json" }));
  ok("L5 a non-JSON body → 400", notJson.status === 400, String(notJson.status));

  const r2 = await letterPreview(post(PREVIEW, a.token, letter));
  ok("L6 a retried request returns the same bytes", (await r2.text()) === html1);
  const after = await counts();
  ok("L7 rendering wrote nothing", JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));

  if (process.env.RENDER === "1") {
    const { PDFParse } = await import("pdf-parse");
    const pdf = await letterPdf(post("/api/business-documents/letters/pdf", a.token, letter));
    const bytes = Buffer.from(await pdf.arrayBuffer());
    ok("L8 PDF 200 as an attachment", pdf.status === 200 && pdf.headers.get("content-type") === "application/pdf" && (pdf.headers.get("content-disposition") ?? "").includes("letter-2026-11-05.pdf"), String(pdf.status));
    ok("L8 real PDF bytes", bytes.subarray(0, 5).toString() === "%PDF-");
    const parser = new PDFParse({ data: bytes });
    const t = (await parser.getText()).text.replace(/\s+/g, "");
    await parser.destroy();
    ok("L8 PDF text carries the business, the subject and the body", t.includes("חשובה") && t.includes("תודה") && t.includes("בדיקה"), t.slice(0, 160));
    const pdfOff = await letterPdf(post("/api/business-documents/letters/pdf", b.token, letter));
    ok("L8 the PDF route is flag-gated too (B → 404)", pdfOff.status === 404, String(pdfOff.status));
    const after2 = await counts();
    ok("L8 the PDF wrote nothing", JSON.stringify(before) === JSON.stringify(after2));
  } else {
    console.log("  [SKIP] L8 PDF render (set RENDER=1 with a local Chromium)");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
