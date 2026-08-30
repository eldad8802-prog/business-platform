/**
 * Leads W1 — E2E fixture seeder.
 *
 * Creates TWO throwaway tenants (so cross-tenant access can be exercised for
 * real, not simulated) and writes their auth tokens to a JSON file for the
 * Playwright run to inject into localStorage — the same token-file mechanism
 * the existing `scripts/qa/ui/*.mjs` evidence scripts use.
 *
 * SYNTHETIC ONLY. Every row it creates is prefixed `QA-W1` and carries the run
 * id, and `--cleanup` removes exactly those tenants by id. Never point this at
 * production: it is a WRITE script and it is meant for a throwaway branch.
 *
 *   npx tsx scripts/qa/leads-w1-seed.ts          -> seed, write .leads-e2e/fixture.json
 *   npx tsx scripts/qa/leads-w1-seed.ts --cleanup -> delete the seeded tenants
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { signAuthToken } from "@/lib/auth-token";

const OUT_DIR = process.env.LEADS_E2E_DIR || path.join(process.cwd(), ".leads-e2e");
const FIXTURE = path.join(OUT_DIR, "fixture.json");

type Fixture = {
  runId: string;
  a: { businessId: number; userId: number; token: string };
  b: { businessId: number; userId: number; token: string };
  phone: string;
};

async function makeTenant(runId: string, label: string) {
  const business = await prisma.business.create({
    data: {
      name: `QA-W1 ${label} ${runId}`,
      users: {
        create: {
          email: `qa-w1-${label}-${runId}@example.test`,
          password: "qa-not-a-real-password",
          name: `QA W1 ${label}`,
        },
      },
    },
    include: { users: true },
  });
  const userId = business.users[0].id;
  return { businessId: business.id, userId, token: signAuthToken(userId) };
}

async function seed() {
  const runId = String(Date.now()).slice(-8);
  const a = await makeTenant(runId, "A");
  const b = await makeTenant(runId, "B");

  const fixture: Fixture = {
    runId,
    a,
    b,
    // Unique per run so a re-run never collides on Lead_open_phone_key.
    phone: `05${runId}`,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(FIXTURE, JSON.stringify(fixture, null, 2), "utf8");
  console.log(`seeded tenants A=${a.businessId} B=${b.businessId} -> ${FIXTURE}`);
}

async function cleanup() {
  let fixture: Fixture;
  try {
    fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as Fixture;
  } catch {
    console.log("no fixture file — nothing to clean up");
    return;
  }
  // Cascade from Business removes its users, customers, leads and events.
  const { count } = await prisma.business.deleteMany({
    where: { id: { in: [fixture.a.businessId, fixture.b.businessId] } },
  });
  console.log(`cleanup removed ${count} QA tenant(s)`);
}

async function main() {
  if (process.argv.includes("--cleanup")) await cleanup();
  else await seed();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
