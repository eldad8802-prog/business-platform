/**
 * D2 / P5-5 — Customer Card MULTI-TABLE RLS pilot · route-handler proof (CI PG17).
 *
 * Invokes the REAL Next route handler (GET /api/customers/[id]) with real Bearer
 * tokens, so the full multi-table card chain runs under one tenant transaction:
 *   Bearer -> getCurrentUser -> user.businessId (server-derived)
 *   -> runWithTenantContext -> withTenantTransaction -> getCustomerCard(tx)
 *   -> transaction-local GUC -> RLS on Customer + BillingDocument + PaymentRequest
 *   + Conversation + Appointment (runtime role is NON-BYPASS).
 *
 * Fixtures (owner-provisioned): each tenant has one customer + exactly one OWN row
 * per section. A "mixed-data poisoning" set of B-OWNED rows that REFERENCE customer A
 * (businessId=B, customerId=A_CUST) is planted — those must never surface on A's card.
 *
 * Level: ROUTE/SERVICE INTEGRATION. Requires env: DATABASE_URL (runtime role),
 * AUTH_TOKEN_SECRET, A_BIZ,B_BIZ,A_USER,B_USER,A_CUST,B_CUST.
 */
import { NextRequest } from "next/server";
import { GET } from "@/app/api/customers/[id]/route";
import { signAuthToken } from "@/lib/auth-token";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { prisma } from "@/lib/prisma";

const A_BIZ = Number(process.env.A_BIZ);
const B_BIZ = Number(process.env.B_BIZ);
const A_USER = Number(process.env.A_USER);
const B_USER = Number(process.env.B_USER);
const A_CUST = Number(process.env.A_CUST);
const B_CUST = Number(process.env.B_CUST);

const tokenA = signAuthToken(A_USER);
const tokenB = signAuthToken(B_USER);

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${extra ? " — " + extra : ""}`);
}
function cardReq(token: string): NextRequest {
  return new NextRequest("http://localhost/api/customers/x", {
    headers: { authorization: `Bearer ${token}` },
  });
}
const getCard = (token: string, id: number) =>
  GET(cardReq(token), { params: Promise.resolve({ id: String(id) }) });

// RLS-only probe: run a related-table query under a tenant context with NO app-level
// businessId filter, so ONLY RLS decides visibility. Proves isolation is enforced by
// the database, not merely by the read-model's businessId filter.
const rlsProbe = <M extends "billingDocument" | "paymentRequest" | "conversation" | "appointment">(
  biz: number,
  model: M,
  where: object,
) =>
  runWithTenantContext({ businessId: biz }, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    withTenantTransaction((tx) => (tx as any)[model].count({ where })),
  );

(async () => {
  console.log(`Customer Card Multi-Table Pilot — P5-5 (A_BIZ=${A_BIZ} B_BIZ=${B_BIZ})\n`);

  // T1 — A reads its OWN card: 200, correct root, every section = exactly 1 (own only).
  const r1 = await getCard(tokenA, A_CUST);
  const c1 = await r1.json();
  check("T1 A card 200 + root=A", r1.status === 200 && c1.customer?.id === A_CUST, `status=${r1.status} id=${c1.customer?.id}`);
  check("T1 section: billing=1", c1.billingDocuments?.total === 1, `total=${c1.billingDocuments?.total}`);
  check("T1 section: payments=1", c1.paymentRequests?.total === 1, `total=${c1.paymentRequests?.total}`);
  check("T1 section: conversations=1", c1.conversations?.total === 1, `total=${c1.conversations?.total}`);
  check("T1 section: appointments=1", c1.appointments?.total === 1, `total=${c1.appointments?.total}`);

  // T2 — B reads its OWN card: mirror isolation from the other side.
  const r2 = await getCard(tokenB, B_CUST);
  const c2 = await r2.json();
  check("T2 B card 200 + root=B", r2.status === 200 && c2.customer?.id === B_CUST, `status=${r2.status} id=${c2.customer?.id}`);
  check(
    "T2 B sections all = 1 (own only)",
    c2.billingDocuments?.total === 1 && c2.paymentRequests?.total === 1 && c2.conversations?.total === 1 && c2.appointments?.total === 1,
    `b=${c2.billingDocuments?.total} p=${c2.paymentRequests?.total} c=${c2.conversations?.total} a=${c2.appointments?.total}`,
  );

  // T3 — A requests B's customer id: root denied (Customer RLS + app filter) -> 404.
  const r3 = await getCard(tokenA, B_CUST);
  check("T3 A reads B's card -> 404 not-found", r3.status === 404, `status=${r3.status}`);

  // T4 — MIXED-DATA POISONING CONTROL. B-owned rows referencing customer A exist for
  // every section. On A's card each section must remain 1 (own only), never 2. A single
  // "2" here means the aggregate/read-model leaked a cross-tenant row sharing the id.
  check(
    "T4 poisoning: A billing stays 1 (B-owned A-ref excluded)",
    c1.billingDocuments?.total === 1 && !c1.billingDocuments.items.some((d: { amount: string }) => d.amount === "999"),
    `total=${c1.billingDocuments?.total}`,
  );
  check("T4 poisoning: A payments stays 1", c1.paymentRequests?.total === 1 && !c1.paymentRequests.items.some((p: { amount: string }) => p.amount === "999"), `total=${c1.paymentRequests?.total}`);
  check("T4 poisoning: A conversations stays 1", c1.conversations?.total === 1, `total=${c1.conversations?.total}`);
  check("T4 poisoning: A appointments stays 1", c1.appointments?.total === 1, `total=${c1.appointments?.total}`);

  // T5 — RLS-ONLY proof. Query each related table under context A filtering by A_CUST
  // but WITHOUT businessId. The B-owned poison row shares customerId=A_CUST, so only the
  // database (RLS) can exclude it. Expect 1 (A's own) — proves RLS, not the app filter.
  const [b5, p5, c5, a5] = await Promise.all([
    rlsProbe(A_BIZ, "billingDocument", { customerId: A_CUST }),
    rlsProbe(A_BIZ, "paymentRequest", { customerId: A_CUST }),
    rlsProbe(A_BIZ, "conversation", { customerId: A_CUST }),
    rlsProbe(A_BIZ, "appointment", { customerId: A_CUST }),
  ]);
  check("T5 RLS-only (no businessId filter) hides B-owned A-ref rows", b5 === 1 && p5 === 1 && c5 === 1 && a5 === 1, `b=${b5} p=${p5} c=${c5} a=${a5}`);

  // T6 — RLS blocks an explicit cross-tenant fetch: under context A, ask for B's rows by
  // businessId=B. RLS returns 0 even though the app-level query requested them.
  const crossB = await rlsProbe(A_BIZ, "billingDocument", { businessId: B_BIZ });
  check("T6 context A, where businessId=B -> RLS returns 0", crossB === 0, `count=${crossB}`);

  // T7 — no tenant context -> fail-closed (no ALS -> withTenantTransaction throws).
  let t7Closed = false;
  try {
    await withTenantTransaction((tx) => tx.billingDocument.count());
  } catch {
    t7Closed = true;
  }
  check("T7 no-context fail-closed", t7Closed);

  // T8 — concurrent A/B card reads: no ALS/GUC contamination across interleaved tx.
  const [ca, cb] = await Promise.all([
    getCard(tokenA, A_CUST).then((r) => r.json()),
    getCard(tokenB, B_CUST).then((r) => r.json()),
  ]);
  check("T8 concurrent A root=A + billing=1", ca.customer?.id === A_CUST && ca.billingDocuments?.total === 1, `id=${ca.customer?.id} b=${ca.billingDocuments?.total}`);
  check("T8 concurrent B root=B + billing=1", cb.customer?.id === B_CUST && cb.billingDocuments?.total === 1, `id=${cb.customer?.id} b=${cb.billingDocuments?.total}`);

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
