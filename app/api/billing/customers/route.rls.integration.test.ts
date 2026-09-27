/**
 * The Billing customer picker under the Production RLS posture.
 *
 * WHY THIS EXISTS
 *
 * `GET|POST /api/billing/customers` is what the invoice draft editor and the
 * new-invoice flow use to find and quick-create the customer an invoice is for.
 * It called `customerService` WITHOUT a transaction, so the service fell back to
 * the global client and ran with no `app.current_business_id`. `Customer` has
 * been FORCE RLS in Production since 2026-09-02 and the runtime role cannot
 * bypass it, so the list came back empty for EVERY tenant — a green 200 with
 * nothing in it — and quick-create was refused by the INSERT policy. The picker
 * treats both as "no customers", which is exactly what an owner saw.
 *
 * The same three things that make every RLS proof in this repository honest:
 *
 *   1. POLICIES. `prisma db push` creates tables, not policies. The policies
 *      under test are installed here, per command, exactly as migration
 *      20260902120000_d2_cutover2b_pilot_tenant_rls defines them for Customer
 *      and BillingDocument (SELECT / INSERT / UPDATE, no DELETE).
 *   2. IDENTITY. The test asserts it runs as a NOSUPERUSER / NOBYPASSRLS role.
 *   3. AMBIENT CONTEXT. Route handlers are called with NO tenant context, the
 *      way a request arrives — a harness that wrapped them would hide the defect.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Also covers the legacy `GET /api/customer`, which had the identical defect.
 *
 * Run: npx tsx app/api/billing/customers/route.rls.integration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../../../lib/auth-token";
import { tenantTx } from "../../../../lib/tenant/tenant-tx";
import { getTenantContext } from "../../../../lib/tenant/context";
import { GET as billingCustomersGET, POST as billingCustomersPOST } from "./route";
import { GET as billingCustomerByIdGET } from "./[id]/route";
import { POST as billingDocumentsPOST } from "../../billing/documents/route";
import { GET as customersGET } from "../../customers/route";
import { GET as legacyCustomerGET } from "../../customer/route";

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

/** Per-command tenant policies, as 20260902120000_d2_cutover2b_pilot_tenant_rls installs them. */
const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
const RLS_TABLES = ["Customer", "BillingDocument"];

async function installRls() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policies under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    for (const table of RLS_TABLES) {
      await admin.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7pilot_tenant_read ON "${table}"`);
      await admin.$executeRawUnsafe(
        `CREATE POLICY p7pilot_tenant_read ON "${table}" FOR SELECT USING (${TENANT_PREDICATE})`
      );
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7pilot_tenant_insert ON "${table}"`);
      await admin.$executeRawUnsafe(
        `CREATE POLICY p7pilot_tenant_insert ON "${table}" FOR INSERT WITH CHECK (${TENANT_PREDICATE})`
      );
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7pilot_tenant_update ON "${table}"`);
      await admin.$executeRawUnsafe(
        `CREATE POLICY p7pilot_tenant_update ON "${table}" FOR UPDATE
           USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
      );
    }
  } finally {
    await admin.$disconnect();
  }
}

async function assertGovernedIdentity() {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);
}

type Tenant = { businessId: number; token: string; customerIds: number[]; names: string[] };

async function makeTenant(label: string, customerNames: string[]): Promise<Tenant> {
  const business = await prisma.business.create({ data: { name: `rls-bc-${label}-${uniq()}` } });
  const user = await prisma.user.create({
    data: {
      email: `rls-bc-${label}-${uniq()}@example.test`,
      password: "x",
      businessId: business.id,
      role: "USER",
    },
  });
  // Seeded with the GUC set: the INSERT policy's WITH CHECK applies to seeding too.
  const customerIds = await tenantTx(business.id, async (tx) => {
    const ids: number[] = [];
    for (const name of customerNames) {
      const c = await tx.customer.create({ data: { businessId: business.id, name }, select: { id: true } });
      ids.push(c.id);
    }
    return ids;
  });
  return {
    businessId: business.id,
    token: signAuthToken(user.id, user.tokenVersion),
    customerIds,
    names: customerNames,
  };
}

const authed = (token: string, url: string, init: { method?: string; body?: string } = {}) =>
  new NextRequest(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  } as never);

type PickerRow = { id: number; name: string };

async function list(token: string, q = ""): Promise<{ status: number; rows: PickerRow[] }> {
  const qs = new URLSearchParams({ limit: "50" });
  if (q) qs.set("q", q);
  const res = await billingCustomersGET(authed(token, `http://localhost/api/billing/customers?${qs}`));
  const body = (await res.json()) as { customers?: PickerRow[] };
  return { status: res.status, rows: Array.isArray(body.customers) ? body.customers : [] };
}

async function main() {
  await assertGovernedIdentity();
  await installRls();

  const tag = uniq();
  const a = await makeTenant("a", [`Alpha One ${tag}`, `Alpha Two ${tag}`]);
  const b = await makeTenant("b", [`Bravo Secret ${tag}`]);
  const c = await makeTenant("c", []);

  // ------------------------------------------------------------ the posture ---
  // If the unscoped read is NOT empty, RLS is not in force and nothing below proves anything.
  const unscoped = await prisma.customer.findMany({ where: { businessId: a.businessId } });
  ok("G1 an unscoped Customer read returns nothing (RLS is in force)", unscoped.length === 0, `got ${unscoped.length}`);

  // ------------------------------------------------------------------ list ---
  const la = await list(a.token);
  const aIds = new Set(la.rows.map((r) => r.id));
  ok("L1 tenant A's picker list answers 200", la.status === 200, `status ${la.status}`);
  ok(
    "L1 it lists tenant A's existing customers",
    a.customerIds.every((id) => aIds.has(id)),
    `listed ${JSON.stringify([...aIds])}, expected ${JSON.stringify(a.customerIds)}`
  );
  ok("L2 it lists nothing of tenant B's", !b.customerIds.some((id) => aIds.has(id)));

  const search = await list(a.token, `Alpha One ${tag}`);
  ok(
    "L3 search finds A's customer by name",
    search.status === 200 && search.rows.some((r) => r.id === a.customerIds[0])
  );
  const crossSearch = await list(a.token, `Bravo Secret ${tag}`);
  ok("L4 search cannot reach B's customer", crossSearch.status === 200 && crossSearch.rows.length === 0,
    `got ${crossSearch.rows.length}`);

  // ----------------------------------------------------------- empty tenant ---
  // A genuinely empty tenant must answer 200 [] — and be distinguishable from a
  // context failure: the SAME route returns A's rows, and a scoped count agrees.
  const lc = await list(c.token);
  const cScoped = await tenantTx(c.businessId, (tx) => tx.customer.count());
  const aScoped = await tenantTx(a.businessId, (tx) => tx.customer.count());
  ok("E1 an empty tenant answers 200 with an empty list", lc.status === 200 && lc.rows.length === 0);
  ok("E1 and that empty list is the truth (scoped count 0)", cScoped === 0, `scoped count ${cScoped}`);
  ok("E2 A's list length matches A's scoped count", la.rows.length === aScoped, `${la.rows.length} vs ${aScoped}`);

  // ---------------------------------------------------------------- create ---
  const createdName = `Alpha Quick ${tag}`;
  const cr = await billingCustomersPOST(
    authed(a.token, "http://localhost/api/billing/customers", {
      method: "POST",
      // A hostile body naming another tenant. The route must never read it.
      body: JSON.stringify({ name: createdName, phone: "050-555-0101", businessId: b.businessId }),
    })
  );
  const crBody = (await cr.json()) as { customer?: PickerRow; error?: string };
  ok("W1 quick-create through Billing answers 201", cr.status === 201, `status ${cr.status}: ${JSON.stringify(crBody).slice(0, 160)}`);
  const createdId = crBody.customer?.id;
  const createdInA = createdId
    ? await tenantTx(a.businessId, (tx) =>
        tx.customer.findFirst({ where: { id: createdId }, select: { businessId: true, name: true } })
      )
    : null;
  ok("W1 the new customer belongs to tenant A", createdInA?.businessId === a.businessId, JSON.stringify(createdInA));
  const createdSeenByB = createdId
    ? await tenantTx(b.businessId, (tx) => tx.customer.findFirst({ where: { id: createdId } }))
    : null;
  ok("W2 a body businessId cannot place it in tenant B", createdSeenByB === null);
  const afterCreate = await list(a.token);
  ok("W3 the new customer appears in A's picker", afterCreate.rows.some((r) => r.id === createdId));

  // -------------------------------------------------------- read by id (B) ---
  const byId = await billingCustomerByIdGET(
    authed(a.token, `http://localhost/api/billing/customers/${b.customerIds[0]}`) as never,
    { params: Promise.resolve({ id: String(b.customerIds[0]) }) } as never
  );
  ok("X1 tenant A cannot read B's customer by id", byId.status === 404, `status ${byId.status}`);

  // ------------------------------------------------- select for an invoice ---
  // Selecting a picker row sets customerId on the draft. A QUOTE draft needs no
  // issuer identity, so this isolates the customer selection itself.
  const draftA = await billingDocumentsPOST(
    authed(a.token, "http://localhost/api/billing/documents", {
      method: "POST",
      body: JSON.stringify({ documentType: "QUOTE", customerId: a.customerIds[0] }),
    }) as never
  );
  const draftABody = (await draftA.json()) as { document?: { customerId?: number | null; customerNameSnapshot?: string | null } };
  ok("S1 A can select its own customer on a draft", draftA.status === 201, `status ${draftA.status}: ${JSON.stringify(draftABody).slice(0, 160)}`);
  ok("S1 the draft carries that customer", draftABody.document?.customerId === a.customerIds[0],
    String(draftABody.document?.customerId));

  const draftCross = await billingDocumentsPOST(
    authed(a.token, "http://localhost/api/billing/documents", {
      method: "POST",
      body: JSON.stringify({ documentType: "QUOTE", customerId: b.customerIds[0] }),
    }) as never
  );
  ok("S2 A cannot select B's customer on a draft", draftCross.status >= 400 && draftCross.status < 500,
    `status ${draftCross.status}`);
  const bDocs = await tenantTx(b.businessId, (tx) => tx.billingDocument.count());
  ok("S2 and nothing was written into tenant B", bDocs === 0, `B has ${bDocs} documents`);

  // ------------------------------------------------ /customers regression ---
  const canon = await customersGET(authed(a.token, "http://localhost/api/customers?limit=50") as never);
  const canonBody = (await canon.json()) as { customers?: PickerRow[] };
  const canonIds = new Set((canonBody.customers ?? []).map((r) => r.id));
  ok("R1 /api/customers still answers 200", canon.status === 200, `status ${canon.status}`);
  ok("R1 and lists A's customers", a.customerIds.every((id) => canonIds.has(id)));
  ok("R2 and none of B's", !b.customerIds.some((id) => canonIds.has(id)));

  // ------------------------------------------ legacy GET /api/customer ---
  // The singular legacy route had the identical defect (service called with no
  // tenant transaction) and answered 200 [] for every tenant. Contract: the
  // full customer array, ordered by id ascending.
  const legacy = await legacyCustomerGET(authed(a.token, "http://localhost/api/customer") as never);
  const legacyBody = (await legacy.json()) as unknown;
  const legacyRows = Array.isArray(legacyBody) ? (legacyBody as { id: number; businessId: number }[]) : [];
  const legacyIds = legacyRows.map((r) => r.id);
  ok("LG1 legacy /api/customer answers 200", legacy.status === 200, `status ${legacy.status}`);
  ok(
    "LG1 it lists tenant A's customers",
    a.customerIds.every((id) => legacyIds.includes(id)),
    `listed ${JSON.stringify(legacyIds)}, expected ${JSON.stringify(a.customerIds)}`
  );
  ok("LG2 it lists nothing of tenant B's", !b.customerIds.some((id) => legacyIds.includes(id)));
  ok("LG2 every row it returns is tenant A's", legacyRows.every((r) => r.businessId === a.businessId));
  ok("LG3 the list length matches A's scoped count", legacyRows.length === aScoped + 1, // + the W1 quick-create
    `${legacyRows.length} vs ${aScoped + 1}`);
  ok("LG4 ordered by id ascending (contract kept)", legacyIds.every((id, i) => i === 0 || legacyIds[i - 1] < id));
  const legacyB = await legacyCustomerGET(authed(b.token, "http://localhost/api/customer") as never);
  const legacyBIds = ((await legacyB.json()) as { id: number }[]).map((r) => r.id);
  ok("LG5 tenant B sees exactly its own customer and none of A's",
    legacyB.status === 200 && legacyBIds.length === b.customerIds.length && b.customerIds.every((id) => legacyBIds.includes(id)),
    JSON.stringify(legacyBIds));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("BILLING CUSTOMER PICKER UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("BILLING CUSTOMER PICKER UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
