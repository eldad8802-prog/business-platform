/**
 * `GET /api/home` → `leadsAttention.count` under the Production RLS posture (#658).
 *
 * WHY THIS EXISTS
 *
 * `features/home/services/home.service.ts` called
 * `leadService.countNeedingAttention({ businessId })` WITHOUT a transaction, so
 * the service fell back to the global client and ran with no
 * `app.current_business_id`. `Lead` is FORCE ROW LEVEL SECURITY and the runtime
 * role cannot bypass it, so the count came back 0 for EVERY tenant — a green 200
 * with a confident zero, which is what Production served.
 *
 * The three things that make every RLS proof in this repository honest:
 *   1. POLICIES. `prisma db push` creates tables, not policies. The policy under
 *      test is installed here exactly as migration
 *      20260824210000_d2_p7_wave1_tenant_rls defines it for "Lead".
 *   2. IDENTITY. The test asserts it runs as a NOSUPERUSER / NOBYPASSRLS role.
 *   3. AMBIENT CONTEXT. The route handler is called with NO tenant context, the
 *      way a request arrives — a harness that wrapped it would hide the defect.
 *
 * It also pins the count's MEANING, which #658 deliberately did not change: the
 * narrow "needs action" predicate shared with /leads?view=needsAction (open lead
 * AND (follow-up due by today OR an untouched NEW lead from before today)).
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx app/api/home/route.rls.integration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../../lib/auth-token";
import { leadService } from "../../../lib/services/crm/lead.service";
import { getTenantContext } from "../../../lib/tenant/context";
import { tenantTx } from "../../../lib/tenant/tenant-tx";
import { GET as homeGET } from "./route";

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
const DAY = 86_400_000;

/** The "Lead" policy exactly as 20260824210000_d2_p7_wave1_tenant_rls installs it. */
const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;

async function installRls() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policy under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe(`ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`ALTER TABLE "Lead" FORCE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w1_tenant ON "Lead"`);
    await admin.$executeRawUnsafe(
      `CREATE POLICY p7w1_tenant ON "Lead" USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
    );
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

type LeadSeed = {
  status: "NEW" | "OPEN" | "QUOTED" | "WON";
  createdAt: Date;
  nextFollowUpAt?: Date | null;
  lastActivityAt?: Date | null;
};

type Tenant = { businessId: number; token: string };

async function makeTenant(label: string, leads: LeadSeed[]): Promise<Tenant> {
  const business = await prisma.business.create({ data: { name: `rls-home-${label}-${uniq()}` } });
  const user = await prisma.user.create({
    data: {
      email: `rls-home-${label}-${uniq()}@example.test`,
      password: "x",
      businessId: business.id,
      role: "USER",
    },
  });
  // Seeded with the GUC set: the policy's WITH CHECK applies to seeding too.
  await tenantTx(business.id, async (tx) => {
    for (const [i, l] of leads.entries()) {
      await tx.lead.create({
        data: {
          businessId: business.id,
          customerName: `${label}-lead-${i}`,
          status: l.status,
          createdAt: l.createdAt,
          nextFollowUpAt: l.nextFollowUpAt ?? null,
          lastActivityAt: l.lastActivityAt ?? null,
        },
      });
    }
  });
  return { businessId: business.id, token: signAuthToken(user.id, user.tokenVersion) };
}

async function homeCount(token: string, url = "http://localhost/api/home"): Promise<{ status: number; count: number | null; href: string | null }> {
  const res = await homeGET(
    new NextRequest(url, { headers: { Authorization: `Bearer ${token}` } } as never)
  );
  const body = (await res.json()) as { leadsAttention?: { count?: number; href?: string } };
  return {
    status: res.status,
    count: typeof body.leadsAttention?.count === "number" ? body.leadsAttention.count : null,
    href: body.leadsAttention?.href ?? null,
  };
}

async function main() {
  await assertGovernedIdentity();
  await installRls();

  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * DAY);
  const yesterday = new Date(now - DAY);
  const nextWeek = new Date(now + 7 * DAY);
  const longAgo = new Date(now - 40 * DAY);

  // A: exactly 3 leads that need action under the narrow predicate.
  const a = await makeTenant("a", [
    { status: "NEW", createdAt: threeDaysAgo },                                   // untouched new, before today → counts
    { status: "NEW", createdAt: threeDaysAgo },                                   // counts
    { status: "OPEN", createdAt: longAgo, nextFollowUpAt: yesterday },            // follow-up overdue → counts
    { status: "NEW", createdAt: new Date(now) },                                  // new TODAY → not yet
    { status: "OPEN", createdAt: longAgo, nextFollowUpAt: nextWeek },             // follow-up in the future → no
    { status: "WON", createdAt: longAgo, nextFollowUpAt: yesterday },             // closed → never
    // Canonical-only reason (STALLED: open, no follow-up, idle 40 days). The
    // narrow count must NOT include it — #658 keeps the meaning unchanged.
    { status: "OPEN", createdAt: longAgo, lastActivityAt: longAgo },
  ]);
  // B: 5 that need action — if any leaked into A, A would read 8.
  const b = await makeTenant("b", [
    { status: "NEW", createdAt: threeDaysAgo },
    { status: "NEW", createdAt: threeDaysAgo },
    { status: "NEW", createdAt: threeDaysAgo },
    { status: "OPEN", createdAt: longAgo, nextFollowUpAt: yesterday },
    { status: "QUOTED", createdAt: longAgo, nextFollowUpAt: yesterday },
  ]);
  const c = await makeTenant("c", []);

  // ------------------------------------------------------------ the posture ---
  const unscoped = await prisma.lead.count({ where: { businessId: a.businessId } });
  ok("G1 an unscoped Lead read returns nothing (RLS is in force)", unscoped === 0, `got ${unscoped}`);
  const legacy = await leadService.countNeedingAttention({ businessId: a.businessId });
  ok("G2 the pre-fix call shape (no tx) reads 0 — the Production defect, reproduced", legacy === 0, `got ${legacy}`);

  // ---------------------------------------------------------- the fixed route ---
  const ra = await homeCount(a.token);
  ok("H1 A: GET /api/home answers 200", ra.status === 200, `status ${ra.status}`);
  ok("H1 A: leadsAttention.count is A's 3 leads that need action", ra.count === 3, `got ${ra.count}`);
  const rb = await homeCount(b.token);
  ok("H2 B: leadsAttention.count is B's own 5", rb.count === 5, `got ${rb.count}`);
  ok("H3 A never counts B's leads (A ≠ 3 + 5)", ra.count !== 8);

  const rc = await homeCount(c.token);
  const cScoped = await tenantTx(c.businessId, (tx) => tx.lead.count());
  ok("H4 an empty tenant answers 200 with 0", rc.status === 200 && rc.count === 0, `got ${rc.count}`);
  ok("H4 and that 0 is the truth (scoped count 0)", cScoped === 0, `scoped ${cScoped}`);

  // A hostile request naming another tenant: the business comes from the
  // session, never from the request.
  const hostile = await homeCount(a.token, `http://localhost/api/home?businessId=${b.businessId}&business_id=${b.businessId}`);
  ok("H5 a businessId planted in the query is ignored (still A's 3)", hostile.count === 3, `got ${hostile.count}`);

  // ------------------------------------------------------------ the meaning ---
  ok("M1 the count still lands on /leads?view=needsAction", ra.href === "/leads?view=needsAction", `href ${ra.href}`);
  const aNeedsActionRows = await tenantTx(a.businessId, (tx) =>
    leadService.listLeads({ businessId: a.businessId, status: "open", needsAction: true, limit: 100 }, { tx })
  );
  ok(
    "M2 the count equals the rows /leads?view=needsAction lists for A (same predicate)",
    aNeedsActionRows.length === ra.count,
    `list ${aNeedsActionRows.length} vs count ${ra.count}`
  );
  ok(
    "M3 a canonical-only (STALLED) lead is NOT in the narrow count",
    !aNeedsActionRows.some((l) => l.status === "OPEN" && l.nextFollowUpAt === null)
  );

  console.log(`\nhome leadsAttention RLS: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
