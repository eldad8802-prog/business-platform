/**
 * One-off verification / bootstrap for platform admin foundation.
 * Usage: node scripts/verify-platform-admin-setup.mjs [--bootstrap]
 */
import "dotenv/config";
import { PrismaClient, UserRole } from "@prisma/client";

const PLATFORM_SYSTEM_BUSINESS_NAME = "__PLATFORM_SYSTEM__";
const prisma = new PrismaClient();
const bootstrap = process.argv.includes("--bootstrap");

async function main() {
  const allowlistRaw = process.env.PLATFORM_ADMIN_EMAILS?.trim() ?? "";
  const allowlist = allowlistRaw
    ? allowlistRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
    : [];

  console.log("=== Platform admin setup verification ===\n");
  console.log("PLATFORM_ADMIN_EMAILS:", allowlistRaw ? `${allowlist.length} email(s)` : "(not set — role-only gate)");

  let systemBusiness = await prisma.business.findFirst({
    where: { name: PLATFORM_SYSTEM_BUSINESS_NAME },
    select: { id: true, name: true, createdAt: true },
  });

  if (!systemBusiness && bootstrap) {
    systemBusiness = await prisma.business.create({
      data: { name: PLATFORM_SYSTEM_BUSINESS_NAME },
      select: { id: true, name: true, createdAt: true },
    });
    console.log("\n[System Business] CREATED id=", systemBusiness.id);
  } else if (systemBusiness) {
    console.log("\n[System Business] OK id=", systemBusiness.id);
  } else {
    console.log("\n[System Business] MISSING — run with --bootstrap or SQL from docs/platform-admin-foundation.md");
  }

  const admins = await prisma.user.findMany({
    where: { role: UserRole.PLATFORM_ADMIN },
    select: { id: true, email: true, businessId: true, business: { select: { name: true } } },
  });

  console.log("\n[PLATFORM_ADMIN users]", admins.length);
  for (const u of admins) {
    const inAllowlist =
      allowlist.length === 0 || allowlist.includes(u.email.trim().toLowerCase());
    console.log(
      `  id=${u.id} email=${u.email} business=${u.business.name} allowlistOk=${inAllowlist}`
    );
  }

  if (admins.length === 0) {
    const regularUsers = await prisma.user.findMany({
      take: 5,
      orderBy: { id: "asc" },
      select: { id: true, email: true, role: true },
    });
    console.log("\n[Hint] No admin yet. Sample users in DB:");
    for (const u of regularUsers) {
      console.log(`  id=${u.id} email=${u.email} role=${u.role}`);
    }
    if (bootstrap && systemBusiness && regularUsers[0]) {
      const target = regularUsers[0];
      if (allowlist.length > 0 && !allowlist.includes(target.email.trim().toLowerCase())) {
        console.log(
          "\n[Bootstrap] Skipped promote: first user email not in PLATFORM_ADMIN_EMAILS"
        );
      } else {
        await prisma.user.update({
          where: { id: target.id },
          data: {
            role: UserRole.PLATFORM_ADMIN,
            businessId: systemBusiness.id,
          },
        });
        console.log(`\n[Bootstrap] Promoted user id=${target.id} (${target.email}) to PLATFORM_ADMIN`);
      }
    }
  }

  const auditCount = await prisma.platformAuditEvent.count();
  console.log("\n[PlatformAuditEvent] total rows:", auditCount);

  const regularUser = await prisma.user.findFirst({
    where: { role: UserRole.USER },
    select: { id: true, email: true },
  });
  if (regularUser) {
    console.log("\n[Regular user for 403 test] id=", regularUser.id, "email=", regularUser.email);
  }

  const adminAfter = await prisma.user.findFirst({
    where: { role: UserRole.PLATFORM_ADMIN },
    select: { id: true, email: true },
  });
  if (adminAfter) {
    console.log("[Admin user for 200 test] id=", adminAfter.id, "email=", adminAfter.email);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
