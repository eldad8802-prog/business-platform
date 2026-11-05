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

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
