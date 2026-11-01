/**
 * Tenant-context gaps under the Production posture — four reads that reached a FORCE RLS table with no
 * tenant context and therefore matched nothing under the runtime role (NOSUPERUSER, NOBYPASSRLS).
 * None of them failed loudly: each answered 200 with data missing.
 *
 * WHAT WAS BROKEN (each reproduced on main as a NOSUPERUSER / NOBYPASSRLS runtime role)
 *
 *   I1  GET /api/documents/inbox — the backlog (`totalPendingReview`, `pendingMonths`) is read by
 *       lib/documents/pending-review.ts, whose step falls back to the bare client outside a tenant
 *       context. The route called it outside one → backlog always 0, no months.
 *   D1  GET /api/documents/[id] — `resolveDocumentOutputProfile` (ExtractionSnapshot) and
 *       `findDuplicateSignals` (Document) ran after the route's tenant transaction had closed → the
 *       engine snapshot was never used and duplicate warnings were always empty.
 *   A1  The tax-authority connection (BillingAuthorityConnection) was read by `billingDbStep` with no
 *       context → `findPublicAuthorityConnection` (status route, connections center) and the issue flow's
 *       `loadConnection` always answered "no connection".
 *   V1  `getBusinessContextByBusinessId` (video generation) read Business + nested BusinessProfile on
 *       the bare client → the profile came back null, so the category never reached the generator.
 *
 * Honesty rules, as in every RLS proof here:
 *   1. POLICIES are installed from the migrations' own definitions (a `db push` lab has none), and a
 *      CONTROL proves they bite before anything else is asserted.
 *   2. IDENTITY: the test refuses to run as a role that bypasses RLS.
 *   3. AMBIENT CONTEXT: routes and services are called with NO tenant context, as in a real request.
 *   4. ISOLATION: tenant B's rows are seeded alongside and must never show up for tenant A.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * env: DATABASE_URL (runtime role), RLS_ADMIN_URL (owner — installs policies and seeds), AUTH_TOKEN_SECRET.
 * Run: npx tsx app/api/rls-context-gaps.integration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../lib/auth-token";
import { getTenantContext } from "../../lib/tenant/context";
import { getBusinessContextByBusinessId } from "../../lib/services/business-context.service";
import { findPublicAuthorityConnection } from "../../lib/services/billing/authority/billing-authority-connection.service";
import { defaultAccessTokenProviderDeps } from "../../lib/services/billing/authority/billing-authority-approval-token.provider";
import { GET as inboxGET } from "./documents/inbox/route";
import { GET as documentGET } from "./documents/[id]/route";

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
const TENANT = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
/** One ALL policy per table, as the migrations define them (p7w4d / p7w4eb2 / p7w1). */
const POLICIES: Array<[table: string, policy: string]> = [
  ["Document", "p7w4d_tenant"],
  ["ExtractionSnapshot", "p7w4d_tenant"],
  ["BillingAuthorityConnection", "p7w4eb2_tenant"],
  ["BusinessProfile", "p7w1_tenant"],
];

function adminClient(): PrismaClient {
  const url = process.env.RLS_ADMIN_URL;
  if (!url) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the posture under test");
    process.exit(1);
  }
  return new PrismaClient({ datasourceUrl: url });
}

async function assertRuntimeRole(): Promise<void> {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);
}

async function installPolicies(admin: PrismaClient): Promise<void> {
  for (const [table, policy] of POLICIES) {
    await admin.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS ${policy} ON "${table}"`);
    await admin.$executeRawUnsafe(`CREATE POLICY ${policy} ON "${table}" USING (${TENANT}) WITH CHECK (${TENANT})`);
  }
}

type Tenant = { businessId: number; token: string; category: string; docId: number; pending: number };

async function seedTenant(admin: PrismaClient, label: string, pending: number): Promise<Tenant> {
  const business = await admin.business.create({ data: { name: `rls-cg-${label}-${uniq()}` } });
  const category = `category-${label}-${uniq()}`;
  await admin.businessProfile.create({ data: { businessId: business.id, category, subCategory: `sub-${label}` } });
  const user = await admin.user.create({
    data: { email: `rls-cg-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
  });
  const hash = `rls-cg-hash-${label}-${uniq()}`;
  const docs = [];
  for (let i = 0; i < pending; i++) {
    docs.push(
      await admin.document.create({
        data: {
          businessId: business.id,
          fileUrl: `rls-cg-${label}-${i}-${uniq()}.pdf`,
          source: "upload",
          mimeType: "application/pdf",
          status: "needs_review",
          contentHashSha256: hash, // every document of the tenant is a byte-identical duplicate of the others
        },
      })
    );
  }
  await admin.extractionSnapshot.create({
    data: {
      documentId: docs[0].id,
      businessId: business.id,
      sourceChannel: "upload",
      liveEngineVersion: "rls-cg",
      ocrEngine: "rls-cg",
      ocrVersion: "1",
      documentType: "INVOICE",
      isFinancial: true,
      rawResult: {},
    },
  });
  await admin.billingAuthorityConnection.create({
    data: { businessId: business.id, environment: "SANDBOX", status: "CONNECTED" },
  });
  return { businessId: business.id, token: signAuthToken(user.id), category, docId: docs[0].id, pending };
}

function get(url: string, token: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${token}` } });
}

/** Finds a key anywhere in a JSON response (the inbox nests its counts). */
function findKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function main() {
  console.log("rls-context-gaps — tenant-context gaps under the Production posture");
  await assertRuntimeRole();
  const admin = adminClient();
  await installPolicies(admin);

  const A = await seedTenant(admin, "A", 2);
  const B = await seedTenant(admin, "B", 3);

  // CONTROL — the policies bite: a context-less runtime read of A's documents sees nothing.
  const bare = await prisma.document.count({ where: { businessId: A.businessId } });
  ok("CONTROL: a context-less runtime read of a FORCE RLS table matches nothing", bare === 0, `got ${bare}`);

  // I1 — inbox backlog
  const month = new Date().toISOString().slice(0, 7);
  for (const summary of [true, false]) {
    const res = await inboxGET(get(`http://lab.test/api/documents/inbox?month=${month}${summary ? "&summaryOnly=1" : ""}`, A.token));
    const body = await res.json();
    const total = findKey(body, "totalPendingReview");
    const months = findKey(body, "pendingMonths");
    const mode = summary ? "summary" : "full";
    ok(`I1 inbox (${mode}) answers 200`, res.status === 200, `status ${res.status}`);
    ok(`I1 inbox (${mode}) backlog = A's ${A.pending} pending documents (B's ${B.pending} not counted)`, total === A.pending, `got ${JSON.stringify(total)}`);
    ok(`I1 inbox (${mode}) lists the month that holds the backlog`, Array.isArray(months) && months.includes(month), `got ${JSON.stringify(months)}`);
  }

  // D1 — document detail: engine snapshot + duplicates
  const dres = await documentGET(get(`http://lab.test/api/documents/${A.docId}`, A.token), {
    params: Promise.resolve({ id: String(A.docId) }),
  } as never);
  const dbody = (await dres.json()) as { outputProfileSource?: string; duplicateSignals?: Array<{ documentId: number }> };
  ok("D1 document detail answers 200", dres.status === 200, `status ${dres.status}`);
  ok("D1 output profile comes from the engine snapshot", dbody.outputProfileSource === "snapshot", `got ${dbody.outputProfileSource}`);
  const dupes = dbody.duplicateSignals ?? [];
  ok("D1 duplicate warnings list A's other identical document", dupes.length === A.pending - 1, `got ${dupes.length}`);
  const bDocIds = new Set((await admin.document.findMany({ where: { businessId: B.businessId }, select: { id: true } })).map((d) => d.id));
  ok("D1 no duplicate warning points at B's documents", dupes.every((d) => !bDocIds.has(d.documentId)));

  // A1 — tax-authority connection
  const pub = await findPublicAuthorityConnection(A.businessId, "SANDBOX");
  ok("A1 status read finds A's authority connection", pub !== null && (pub as { status?: string }).status === "CONNECTED", `got ${JSON.stringify(pub)}`);
  const tok = await defaultAccessTokenProviderDeps.loadConnection(A.businessId, "SANDBOX");
  ok("A1 issue flow's loadConnection finds A's connection", tok !== null && tok.status === "CONNECTED", `got ${JSON.stringify(tok)}`);
  const none = await findPublicAuthorityConnection(A.businessId, "PRODUCTION");
  ok("A1 A has no PRODUCTION connection (B's rows never leak in)", none === null);

  // V1 — video business context
  const ctx = await getBusinessContextByBusinessId(A.businessId);
  ok("V1 video context carries A's category", ctx.category === A.category, `got ${ctx.category}`);
  ok("V1 video context carries A's sub-category", ctx.subcategory === "sub-A", `got ${ctx.subcategory}`);

  ok("no tenant context leaked out of any call", getTenantContext() === undefined);

  await admin.$disconnect();
  await prisma.$disconnect();
  console.log(`\nrls-context-gaps: ${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
