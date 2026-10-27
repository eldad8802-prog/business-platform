/**
 * העלאת דוחות וקבצים (S1-B M3) — GET /api/money/uploads under the Production RLS posture.
 *
 * The screen reads three things for "the signed-in business": the bank file import flag (where the bank card
 * routes), the import ledger's recent runs, and old-path bank uploads grouped by batch. The two ways that goes
 * wrong are (1) a read that silently returns nothing because it ran without tenant context, and (2) a run, a
 * batch or an account label of another tenant. Each is decided here by running the real route handler, with no
 * ambient tenant context, as a NOSUPERUSER / NOBYPASSRLS role, against tenant policies on every table it reads.
 *
 * It also pins what the answer must never carry: an amount, a transaction description, or more of an account
 * number than its last four digits.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx app/api/money-uploads.rls.integration.test.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../lib/auth-token";
import { tenantTx } from "../../lib/tenant/tenant-tx";
import { getTenantContext } from "../../lib/tenant/context";
import { GET as uploadsGET } from "./money/uploads/route";

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

const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
/** Every tenant table the route reads. */
const RLS_TABLES = ["ImportRun", "ExternalTransaction", "BusinessBankAccount", "BusinessFeatureAccess"];

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
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS mu_tenant ON "${table}"`);
      await admin.$executeRawUnsafe(
        `CREATE POLICY mu_tenant ON "${table}" USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
      );
    }
    // The catalogue row the bank file import flag hangs off (global, not a tenant table). OFF by default.
    await admin.platformFeatureDefinition.upsert({
      where: { key: "bank_file_import" },
      update: {},
      create: { key: "bank_file_import", displayName: "קליטת קובץ בנק", category: "payables", defaultEnabled: false },
    });
  } finally {
    await admin.$disconnect();
  }
}

async function assertGovernedIdentity() {
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

type Tenant = { businessId: number; userId: number; token: string };

async function makeUser(label: string): Promise<Tenant> {
  const business = await prisma.business.create({ data: { name: `עסק ${label} ${uniq()}` } });
  const user = await prisma.user.create({
    data: { email: `mu-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER", name: `Owner ${label}` },
  });
  return { businessId: business.id, userId: user.id, token: signAuthToken(user.id, 0) };
}

const SECRET_DESCRIPTION = "SYNTHETIC-COUNTERPARTY-DO-NOT-LEAK";
const A_LAST4 = "4821";

function run(t: Tenant, domain: string, status: "COMPLETED" | "PARTIAL" | "FAILED", counts: [number, number, number]) {
  return {
    businessId: t.businessId,
    userId: t.userId,
    domain,
    contentHash: `h-${uniq()}`,
    mappingHash: "m",
    decisionsHash: "d",
    status,
    totalRows: counts[0] + counts[1] + counts[2],
    createdCount: counts[0],
    skippedCount: counts[1],
    failedCount: counts[2],
    completedAt: new Date(),
  } as Prisma.ImportRunUncheckedCreateInput;
}

/**
 * Tenant A — a PARTIAL customers import (2 failed rows), a COMPLETED historical import, and one old-path bank
 * upload of 3 lines bound to an account ending 4821.
 */
async function seedA(t: Tenant) {
  await tenantTx(t.businessId, async (tx) => {
    await tx.importRun.create({ data: run(t, "customers", "PARTIAL", [5, 1, 2]) });
    await tx.importRun.create({ data: run(t, "historical-documents", "COMPLETED", [7, 0, 0]) });
    const account = await tx.businessBankAccount.create({
      data: {
        businessId: t.businessId,
        label: "חשבון עסקי A",
        coordinatesEncrypted: "synthetic",
        coordinatesIv: "synthetic",
        coordinatesTag: "synthetic",
        encryptionKeyId: "synthetic",
        accountLast4: A_LAST4,
        fingerprint: `fp-${uniq()}`,
      },
      select: { id: true },
    });
    const batch = `upl-${uniq()}`;
    for (let i = 0; i < 3; i++) {
      await tx.externalTransaction.create({
        data: {
          businessId: t.businessId,
          source: "OWNER_UPLOAD",
          externalId: `upl:${uniq()}-${i}`,
          direction: "DEBIT",
          amount: new Prisma.Decimal("1234.56"),
          bookedAt: new Date(`2026-09-0${i + 1}T00:00:00.000Z`),
          description: SECRET_DESCRIPTION,
          importBatchId: batch,
          sourceBankAccountId: account.id,
        },
      });
    }
  });
}

/** Tenant B — one COMPLETED suppliers import, no bank uploads, and bank file import ENABLED for it. */
async function seedB(t: Tenant) {
  await tenantTx(t.businessId, async (tx) => {
    await tx.importRun.create({ data: run(t, "suppliers", "COMPLETED", [4, 0, 0]) });
    await tx.businessFeatureAccess.create({ data: { businessId: t.businessId, featureKey: "bank_file_import", state: "ENABLED" } });
  });
}

const get = (token: string | null, url: string) =>
  new NextRequest(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} } as never);

type Entry = { domain: string; source: string; status: string; counts: { failed: number | null; created: number | null }; account: { label: string; last4: string } | null; period: { from: string; to: string } | null; sourceFileStored: boolean };

async function main() {
  await assertGovernedIdentity();
  await installRls();

  const a = await makeUser("A");
  const b = await makeUser("B");
  await seedA(a);
  await seedB(b);

  console.log("\n  posture");
  ok(
    "a context-less read of ImportRun sees nothing (RLS is really on)",
    (await prisma.importRun.count({ where: { businessId: a.businessId } })) === 0
  );

  console.log("\n  /api/money/uploads — tenant A");
  const resA = await uploadsGET(get(a.token, "http://t/api/money/uploads"));
  const A = await resA.json();
  const historyA = (A.history ?? []) as Entry[];
  const textA = JSON.stringify(A);
  ok("200, private no-store", resA.status === 200 && (resA.headers.get("cache-control") ?? "").includes("no-store"), String(resA.status));
  ok("bank card routes to the old path (flag OFF by default)", A.bank?.mode === "legacy", JSON.stringify(A.bank));
  ok("A's two runs are listed", historyA.filter((e) => e.source === "import_run").map((e) => e.domain).sort().join(",") === "customers,historical-documents", JSON.stringify(historyA.map((e) => e.domain)));
  const legacy = historyA.find((e) => e.source === "legacy_bank_upload");
  ok("the old-path bank upload is one entry of 3 lines", !!legacy && legacy.counts.created === 3, JSON.stringify(legacy));
  ok("its period is the lines' dates", legacy?.period?.from === "2026-09-01" && legacy?.period?.to === "2026-09-03", JSON.stringify(legacy?.period));
  ok("its account is label + last four only", legacy?.account?.label === "חשבון עסקי A" && legacy?.account?.last4 === A_LAST4, JSON.stringify(legacy?.account));
  ok("no entry claims a stored source file", historyA.every((e) => e.sourceFileStored === false));
  ok("no amount and no transaction description in the answer", !textA.includes("1234.56") && !textA.includes("1234") && !textA.includes(SECRET_DESCRIPTION));
  ok("the PARTIAL customers import is an action item", (A.attention ?? []).some((i: { kind: string }) => i.kind === "action"), JSON.stringify(A.attention));

  console.log("\n  /api/money/uploads — tenant B sees only B");
  const resB = await uploadsGET(get(b.token, "http://t/api/money/uploads"));
  const B = await resB.json();
  const historyB = (B.history ?? []) as Entry[];
  const textB = JSON.stringify(B);
  ok("200", resB.status === 200, String(resB.status));
  ok("B's bank card follows B's own flag (ENABLED → B1)", B.bank?.mode === "b1", JSON.stringify(B.bank));
  ok("B sees exactly its one suppliers run", historyB.length === 1 && historyB[0]?.domain === "suppliers", JSON.stringify(historyB.map((e) => e.domain)));
  ok("no A value appears in B's answer", !textB.includes(A_LAST4) && !textB.includes("חשבון עסקי A") && !textB.includes("customers") && (B.attention ?? []).length === 0);

  console.log("\n  authentication");
  ok("without a token → 401", (await uploadsGET(get(null, "http://t/api/money/uploads"))).status === 401);
  ok("a forged token → 401", (await uploadsGET(get("not-a-token", "http://t/api/money/uploads"))).status === 401);
  const withQuery = await (await uploadsGET(get(b.token, `http://t/api/money/uploads?businessId=${a.businessId}`))).json();
  ok("a businessId in the query is ignored — B still gets B", (withQuery.history ?? []).length === 1 && !JSON.stringify(withQuery).includes(A_LAST4));

  console.log("\n  read-only");
  const runsAfter = await tenantTx(a.businessId, (tx) => tx.importRun.count({ where: { businessId: a.businessId } }));
  const linesAfter = await tenantTx(a.businessId, (tx) => tx.externalTransaction.count({ where: { businessId: a.businessId } }));
  ok("the reads wrote nothing (A still has 2 runs, 3 lines)", runsAfter === 2 && linesAfter === 3, `${runsAfter} runs, ${linesAfter} lines`);
  ok("still no ambient tenant context after the requests", getTenantContext() === undefined);

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  await prisma.$disconnect();
  if (failures.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
