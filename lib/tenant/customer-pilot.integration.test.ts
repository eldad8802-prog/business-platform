/**
 * D2 / P5-4 — Customer pilot application integration · route-handler proof (CI PG17).
 *
 * Invokes the REAL Next route handlers (GET/POST /api/customers, PATCH
 * /api/customers/[id]) with real Bearer tokens, so the full pilot chain runs:
 *   Bearer token -> getCurrentUser -> user.businessId (server-derived)
 *   -> runWithTenantContext -> withTenantTransaction -> customerService(tx)
 *   -> transaction-local GUC -> RLS (runtime role is NON-BYPASS).
 *
 * Level: ROUTE/SERVICE INTEGRATION (handlers invoked directly, not over HTTP).
 * Fixtures/role/RLS provisioned by the workflow (as owner). Requires env:
 * DATABASE_URL (runtime role), AUTH_TOKEN_SECRET, A_BIZ,B_BIZ,A_USER,B_USER,B_CUST.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/customers/route";
import { PATCH } from "@/app/api/customers/[id]/route";
import { signAuthToken } from "@/lib/auth-token";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { customerService } from "@/lib/services/crm/customer.service";
import { prisma } from "@/lib/prisma";

const A_BIZ = Number(process.env.A_BIZ);
const B_BIZ = Number(process.env.B_BIZ);
const A_USER = Number(process.env.A_USER);
const B_USER = Number(process.env.B_USER);
const B_CUST = Number(process.env.B_CUST);

const tokenA = signAuthToken(A_USER);
const tokenB = signAuthToken(B_USER);

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${extra ? " — " + extra : ""}`);
}
function getReq(token: string, qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/customers${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
function jsonReq(method: string, token: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/customers", {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const countUnder = (biz: number, where: object) =>
  runWithTenantContext({ businessId: biz }, () => withTenantTransaction((tx) => tx.customer.count({ where })));

(async () => {
  console.log(`Customer Pilot Integration — P5-4 (A_BIZ=${A_BIZ} B_BIZ=${B_BIZ})\n`);

  // T1 / T2 — list is tenant-scoped
  const r1 = await GET(getReq(tokenA));
  const j1 = await r1.json();
  check("T1 A list sees only A (1)", r1.status === 200 && j1.customers.length === 1, `status=${r1.status} n=${j1.customers?.length}`);
  const r2 = await GET(getReq(tokenB));
  const j2 = await r2.json();
  check("T2 B list sees only B (1)", r2.status === 200 && j2.customers.length === 1, `status=${r2.status} n=${j2.customers?.length}`);

  // T5 — A creates own
  const r5 = await POST(jsonReq("POST", tokenA, { name: "p2-a-created" }));
  check("T5 A create own -> 201", r5.status === 201, `status=${r5.status}`);

  // T6 — malicious client businessId=B in body is ignored (created under A only)
  const r6 = await POST(jsonReq("POST", tokenA, { name: "p2-evil", businessId: B_BIZ }));
  check("T6 create with body businessId=B -> 201 (body businessId ignored)", r6.status === 201, `status=${r6.status}`);
  const evilA = await countUnder(A_BIZ, { name: "p2-evil" });
  const evilB = await countUnder(B_BIZ, { name: "p2-evil" });
  check("T6 malicious row created under A only", evilA === 1 && evilB === 0, `A=${evilA} B=${evilB}`);

  // T4 — A updates B by id -> not found (cross-tenant write denied)
  const r4 = await PATCH(jsonReq("PATCH", tokenA, { name: "hacked" }), { params: Promise.resolve({ id: String(B_CUST) }) });
  check("T4 A update B -> 404 not-found", r4.status === 404, `status=${r4.status}`);
  const bUnchanged = await runWithTenantContext({ businessId: B_BIZ }, () =>
    withTenantTransaction((tx) => tx.customer.findFirst({ where: { id: B_CUST }, select: { name: true } })),
  );
  check("T4 B customer not modified", bUnchanged?.name === "p2-b-customer", `name=${bUnchanged?.name}`);

  // T3 — A reads B by id (service getCustomer) -> denied (NotFound)
  let t3Denied = false;
  try {
    await runWithTenantContext({ businessId: A_BIZ }, () =>
      withTenantTransaction((tx) => customerService.getCustomer({ businessId: A_BIZ, customerId: B_CUST }, { tx })),
    );
  } catch {
    t3Denied = true;
  }
  check("T3 A read B by id -> denied", t3Denied);

  // T7 — no tenant context -> fail-closed
  let t7Closed = false;
  try {
    await withTenantTransaction((tx) => tx.customer.count());
  } catch {
    t7Closed = true;
  }
  check("T7 no-context fail-closed", t7Closed);

  // T8 — concurrent A/B route calls: no ALS/GUC contamination
  const [ca, cb] = await Promise.all([
    GET(getReq(tokenA)).then((r) => r.json()),
    GET(getReq(tokenB)).then((r) => r.json()),
  ]);
  // B is unaffected by A's two creates (isolation); A now has its own 3.
  check("T8 concurrent B sees only own (1)", cb.customers.length === 1, `B=${cb.customers.length}`);
  check("T8 concurrent A sees own only (3)", ca.customers.length === 3, `A=${ca.customers.length}`);

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
