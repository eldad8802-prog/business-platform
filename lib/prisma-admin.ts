/**
 * D2 / P7-W2-GATE — the SANCTIONED platform-admin Prisma client.
 *
 * ADMIN-ONLY, SELECT-ORIENTED. This client authenticates as the dedicated
 * least-privilege admin read role (`app_admin` family: LOGIN role per
 * environment, NOSUPERUSER, NOBYPASSRLS, non-owner, no neon_superuser). Its
 * only write privilege is the PlatformAuditEvent append. Cross-tenant reads
 * work through ADDITIVE `p7adm_read FOR SELECT TO app_admin USING (true)`
 * policies — tenant policies and FORCE RLS stay untouched.
 *
 * Boundaries (mechanically enforced by the CI admin-boundary guard):
 *   - May be imported ONLY from platform-admin/dev admin modules.
 *   - Tenant feature code must keep using the canonical `lib/prisma.ts`.
 *
 * Fail-loud contract: `ADMIN_DATABASE_URL` missing => throw at first use, as a
 * typed 503 (ADMIN_DATA_PLANE_UNAVAILABLE) so the console can say so plainly
 * instead of a bare 500 — and never as a zero.
 * There is deliberately NO fallback to DATABASE_URL or DIRECT_URL — a
 * misconfigured environment must surface as an error, never as an owner
 * connection or as silently-empty tenant-scoped reads.
 */
import { PrismaClient } from "@prisma/client";
import { AdminDataPlaneUnavailableError } from "@/lib/errors";

const globalForPrismaAdmin = globalThis as unknown as {
  prismaAdmin?: PrismaClient;
};

/**
 * Lazy accessor for the admin client. Throws loudly when ADMIN_DATABASE_URL
 * is not configured. Cached on globalThis so dev hot-reload does not
 * accumulate connection pools and one serverless instance keeps one pool.
 */
export function getPrismaAdmin(): PrismaClient {
  if (globalForPrismaAdmin.prismaAdmin) {
    return globalForPrismaAdmin.prismaAdmin;
  }

  const url = process.env.ADMIN_DATABASE_URL?.trim();
  if (!url) {
    throw new AdminDataPlaneUnavailableError(
      "ADMIN_DATABASE_URL is not configured — the platform-admin DB path is unavailable. " +
        "Refusing to fall back to the tenant or owner connection."
    );
  }

  const client = new PrismaClient({
    datasourceUrl: url,
    log: ["warn", "error"],
  });

  globalForPrismaAdmin.prismaAdmin = client;
  return client;
}
