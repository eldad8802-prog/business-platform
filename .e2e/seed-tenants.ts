/**
 * E2E setup only.
 *
 * Creates two isolated tenants and mints a session token for each with the SAME
 * `signAuthToken` the login route uses, then prints them as JSON.
 *
 * Why not register over HTTP: `/api/auth/register` is rate-limited to 3 per hour
 * per IP, which is correct for a public signup route and useless as test setup.
 * Account creation is not what the supplier E2E is testing — every supplier,
 * order, receipt and read in that run still goes over real HTTP with these
 * tokens, so nothing about the assertions is weakened by seeding the accounts.
 *
 * Run: npx tsx --env-file=.env .e2e/seed-tenants.ts
 */

import { prisma } from "@/lib/prisma";
import { signAuthToken } from "@/lib/auth-token";

async function main() {
  const stamp = `${Date.now()}`;

  async function makeTenant(label: string) {
    const business = await prisma.business.create({
      data: {
        name: `E2E ${label} ${stamp}`,
        users: {
          create: {
            email: `e2e-${label}-${stamp}@example.test`,
            // Never used: this account is only reached through a minted token.
            password: "not-a-login-path",
            name: `E2E ${label}`,
          },
        },
      },
      include: { users: true },
    });

    return {
      businessId: business.id,
      userId: business.users[0].id,
      token: signAuthToken(business.users[0].id),
    };
  }

  const a = await makeTenant("A");
  const b = await makeTenant("B");

  console.log(JSON.stringify({ stamp, a, b }));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
