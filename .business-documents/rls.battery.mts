/**
 * Business documents (ר1–ר3) under the Production posture: FORCE ROW LEVEL SECURITY with the
 * migrations' own policies, and a runtime login that is NOSUPERUSER NOBYPASSRLS with the
 * Production column grant on "Business". Synthetic data only; no Production, no network.
 *
 * Honesty rules (as in app/api/rls-runtime-compat.integration.test.ts):
 *   1. POLICIES are installed from the migrations' OWN text (every ENABLE / FORCE / DROP POLICY /
 *      CREATE POLICY statement for the tables below, in migration order). Policies addressed TO a
 *      platform role (app_admin, app_ctlplane, app_auth …) are skipped: they never apply to the runtime.
 *   2. Two CONTROLS prove the posture bites before anything is asserted: the runtime reads ZERO rows
 *      without a tenant context, and the role does not bypass RLS.
 *   3. Seeds are written by the admin connection; everything asserted runs as the runtime login,
 *      through the real route handlers / services with a real signed session.
 *
 * env: DATABASE_URL (runtime login), RLS_ADMIN_URL (owner / admin), AUTH_TOKEN_SECRET; RENDER=1 for the PDF.
 * Run: npx tsx .business-documents/rls.battery.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../lib/auth-token";
import { GET as listDocuments } from "../app/api/billing/documents/route";
import { GET as getCustomer } from "../app/api/customers/[id]/route";
import { POST as letterPreview } from "../app/api/business-documents/letters/preview/route";
import { POST as letterPdf } from "../app/api/business-documents/letters/pdf/route";
import { quoteValidity } from "../lib/services/tasks/sources";
import { getPreferences } from "../lib/services/tasks/preferences.service";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const prisma = new PrismaClient();
const adminUrl = process.env.RLS_ADMIN_URL;
if (!adminUrl) {
  console.log("  [FAIL] RLS_ADMIN_URL is not set");
  process.exit(1);
}
const admin = new PrismaClient({ datasourceUrl: adminUrl });

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

/** The tables the new routes and the S08 source read or write (directly or through the services they call). */
const TABLES = [
  "Business", "BusinessProfile", "BillingDocument", "BillingDocumentLine", "Customer", "Supplier",
  "BusinessFeatureAccess", "ServiceQuote", "TaskPreferences", "TaskSourceState",
];
const BUSINESS_RUNTIME_COLUMNS = `"id", "name", "createdAt", "deletionRequestedAt", "deletedAt"`;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Every RLS statement for TABLES, in migration order, from the migrations' own text. */
export function extractPosture(root: string): { statements: string[]; skipped: string[]; perTable: Record<string, number> } {
  const dir = path.join(root, "prisma", "migrations");
  const statements: string[] = [];
  const skipped: string[] = [];
  const perTable: Record<string, number> = Object.fromEntries(TABLES.map((t) => [t, 0]));
  for (const m of readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort()) {
    let sql: string;
    try {
      sql = stripComments(readFileSync(path.join(dir, m, "migration.sql"), "utf8"));
    } catch {
      continue;
    }
    for (const raw of sql.split(/;\s*(?:\r?\n|$)/)) {
      const st = raw.trim().replace(/\s+/g, " ");
      if (!st) continue;
      const t = TABLES.find((name) => new RegExp(`ON "${name}"(\\s|$)`).test(st) || new RegExp(`^ALTER TABLE "${name}" (ENABLE|FORCE) ROW LEVEL SECURITY$`).test(st));
      if (!t) continue;
      const isRls = /^ALTER TABLE "[A-Za-z]+" (ENABLE|FORCE) ROW LEVEL SECURITY$/.test(st) || /^(CREATE|DROP) POLICY /.test(st);
      if (!isRls) continue;
      const to = st.match(/ TO ([a-z_][a-z0-9_]*)/i);
      if (/^CREATE POLICY /.test(st) && to && to[1].toLowerCase() !== "public") {
        skipped.push(`${m}: ${st.slice(0, 90)}`);
        continue;
      }
      statements.push(st.replace(/^DROP POLICY (?!IF EXISTS)/, "DROP POLICY IF EXISTS "));
      perTable[t]++;
    }
  }
  return { statements, skipped, perTable };
}

const LINE = { description: "שירות", quantity: "1", unitPrice: "100", vatRatePercent: "18" };

async function seed(label: string, docsOn: boolean) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const business = await admin.business.create({ data: { name: `rls-bd-${label}-${stamp}` } });
  const user = await admin.user.create({ data: { email: `rls-bd-${label}-${stamp}@example.test`, password: "synthetic", businessId: business.id, role: "USER" } });
  await admin.businessProfile.create({
    data: {
      businessId: business.id, billingLegalName: `עסק ${label} בע"מ`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998",
      billingAddress: `רחוב ${label} 1`, billingPhone: "0500000000", billingEmail: `${label}@example.test`,
    },
  });
  const customer = await admin.customer.create({ data: { businessId: business.id, name: `לקוח ${label}` } });
  const supplier = await admin.supplier.create({ data: { businessId: business.id, name: `ספק ${label}` } });
  const docs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await admin.billingDocument.create({
      data: {
        businessId: business.id, documentType: i === 0 ? "QUOTE" : "TAX_INVOICE", status: "DRAFT", customerId: customer.id,
        customerNameSnapshot: customer.name, subtotalAmount: "100", vatAmount: "18", totalAmount: "118",
        validUntil: i === 0 ? new Date("2026-11-06T10:00:00.000Z") : null,
        lines: { create: [{ lineIndex: 1, ...LINE, lineSubtotal: "100", vatAmount: "18", lineTotal: "118" }] },
      },
    });
    docs.push(d.id);
  }
  if (docsOn) {
    await admin.platformFeatureDefinition.upsert({ where: { key: "business_documents" }, create: { key: "business_documents", displayName: "מסמכים נוספים", category: "documents", defaultEnabled: false }, update: {} });
    await admin.businessFeatureAccess.create({ data: { businessId: business.id, featureKey: "business_documents", state: "ENABLED", reason: "lab" } });
  }
  return { business, user, customer, supplier, docs, quoteId: docs[0], token: signAuthToken(user.id, user.tokenVersion) };
}

const get = (url: string, token: string | null) => new NextRequest(`http://localhost${url}`, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post = (url: string, token: string | null, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function main() {
  // ---- identity: the runtime must not bypass RLS ----
  const [who] = (await prisma.$queryRawUnsafe(`SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  runtime: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  ok("C1 the runtime role is NOSUPERUSER NOBYPASSRLS", !!who && !who.rolsuper && !who.rolbypassrls);
  if (!who || who.rolsuper || who.rolbypassrls) process.exit(1);

  // ---- install the posture from the migrations' own text ----
  const posture = extractPosture(path.join(here, ".."));
  console.log(`  installing ${posture.statements.length} RLS statements; skipped ${posture.skipped.length} platform-role policies`);
  console.log(`  per table: ${JSON.stringify(posture.perTable)}`);
  ok("posture covers every table touched", TABLES.every((t) => posture.perTable[t] > 0), JSON.stringify(posture.perTable));
  for (const st of posture.statements) await admin.$executeRawUnsafe(st);
  await admin.$executeRawUnsafe(`REVOKE SELECT ON "Business" FROM "${who.who}"`);
  await admin.$executeRawUnsafe(`GRANT SELECT (${BUSINESS_RUNTIME_COLUMNS}) ON "Business" TO "${who.who}"`);

  const a = await seed("a", true);
  const b = await seed("b", false);

  // ---- control: without a tenant context the runtime sees nothing ----
  const unscoped = await prisma.billingDocument.count({ where: { id: { in: [...a.docs, ...b.docs] } } });
  const unscopedProfiles = await prisma.businessProfile.count({ where: { businessId: { in: [a.business.id, b.business.id] } } });
  ok("C2 posture bites: no tenant context → 0 documents, 0 profiles", unscoped === 0 && unscopedProfiles === 0, `${unscoped} / ${unscopedProfiles}`);

  // ---- ר3 ----
  const own = await listDocuments(get(`/api/billing/documents?customerId=${a.customer.id}&limit=50`, a.token));
  const ownBody = (await own.json()) as { documents: { id: number; businessId: number }[] };
  ok("R3 owner sees exactly the customer's documents under RLS", own.status === 200 && ownBody.documents.length === 3 && ownBody.documents.every((d) => a.docs.includes(d.id)), `${own.status} ${ownBody.documents?.length}`);
  const cross = await listDocuments(get(`/api/billing/documents?customerId=${a.customer.id}&limit=50`, b.token));
  const crossBody = (await cross.json()) as { documents: unknown[] };
  ok("R3 another business sees none of them under RLS", cross.status === 200 && crossBody.documents.length === 0);
  const crossCard = await getCustomer(get(`/api/customers/${a.customer.id}`, b.token), { params: Promise.resolve({ id: String(a.customer.id) }) });
  ok("R3 another business cannot open the customer card under RLS", crossCard.status === 404, String(crossCard.status));
  const ownCard = await getCustomer(get(`/api/customers/${a.customer.id}`, a.token), { params: Promise.resolve({ id: String(a.customer.id) }) });
  ok("R3 the owner can", ownCard.status === 200, String(ownCard.status));

  // ---- ר2 ----
  const PREVIEW = "/api/business-documents/letters/preview";
  const letter = { recipientKind: "customer", customerId: a.customer.id, recipientName: "", subject: "נושא", body: "גוף המכתב", date: "2026-11-05" };
  const r = await letterPreview(post(PREVIEW, a.token, letter));
  const html = await r.text();
  ok("R2 preview 200 under RLS (flag read through FORCE RLS)", r.status === 200, String(r.status));
  ok("R2 the letterhead carries the legal name from BusinessProfile (FORCE RLS read in the tenant tx)", html.includes('עסק a בע&quot;מ'), html.slice(0, 0));
  ok("R2 the recipient is the business's own customer", html.includes("לקוח a"));
  const crossCustomer = await letterPreview(post(PREVIEW, a.token, { ...letter, customerId: b.customer.id }));
  ok("R2 another business's customer → 404 under RLS", crossCustomer.status === 404, String(crossCustomer.status));
  const crossSupplier = await letterPreview(post(PREVIEW, a.token, { ...letter, recipientKind: "supplier", customerId: null, supplierId: b.supplier.id }));
  ok("R2 another business's supplier → 404 under RLS", crossSupplier.status === 404, String(crossSupplier.status));
  const ownSupplier = await letterPreview(post(PREVIEW, a.token, { ...letter, recipientKind: "supplier", customerId: null, supplierId: a.supplier.id }));
  ok("R2 own supplier → 200 under RLS", ownSupplier.status === 200 && (await ownSupplier.text()).includes("ספק a"));
  const bOff = await letterPreview(post(PREVIEW, b.token, { ...letter, customerId: b.customer.id }));
  ok("R2 B (flag off) → 404 under RLS", bOff.status === 404, String(bOff.status));
  if (process.env.RENDER === "1") {
    const pdf = await letterPdf(post("/api/business-documents/letters/pdf", a.token, letter));
    const bytes = Buffer.from(await pdf.arrayBuffer());
    ok("R2 PDF 200 + real PDF under RLS", pdf.status === 200 && bytes.subarray(0, 5).toString() === "%PDF-", String(pdf.status));
  } else {
    console.log("  [SKIP] R2 PDF (RENDER=1)");
  }

  // ---- ר1 / S08 ----
  const ctx = (businessId: number) => ({ businessId, now: new Date("2026-11-05T08:00:00.000Z"), today: "2026-11-05" });
  const aOut = await quoteValidity(ctx(a.business.id));
  ok("R1 S08 item for A's expiring quote under RLS", aOut.items.some((i) => i.entity?.id === a.quoteId), JSON.stringify(aOut.items.map((i) => i.dedupeKey)));
  ok("R1 S08 never shows B's quote to A", !aOut.items.some((i) => i.entity?.id === b.quoteId));
  const bOut = await quoteValidity(ctx(b.business.id));
  ok("R1 S08 nothing for B (flag off)", bOut.items.length === 0);
  // A service quote of A's: excluded under RLS too (the ServiceQuote read is tenant-scoped).
  const sCase = await admin.serviceCase.create({ data: { businessId: a.business.id, caseNumber: 1, kind: "IN_SHOP", customerId: a.customer.id } });
  await admin.serviceQuote.create({ data: { businessId: a.business.id, caseId: sCase.id, version: 1, billingDocumentId: a.quoteId, totalAgorot: 11800, docHash: "h", sentPdfKey: `biz/${a.business.id}/service/q.pdf`, sentPdfSha256: "s" } });
  const aOut2 = await quoteValidity(ctx(a.business.id));
  ok("R1 S08 excludes a service-case quote under RLS", !aOut2.items.some((i) => i.entity?.id === a.quoteId));
  const prefsA = await getPreferences(a.business.id);
  const prefsB = await getPreferences(b.business.id);
  ok("R1 S08 in A's preferences, not in B's (under RLS)", prefsA.sources.some((s) => s.kind === "quote_validity") && !prefsB.sources.some((s) => s.kind === "quote_validity"));

  await admin.$executeRawUnsafe(`GRANT SELECT ON "Business" TO "${who.who}"`);
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
  .finally(async () => {
    await prisma.$disconnect();
    await admin.$disconnect();
  });
