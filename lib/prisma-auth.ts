/**
 * D2 / AUTH BOUNDARY STEP 2 — the SANCTIONED auth/bootstrap Prisma client.
 *
 * `User` and `Business` sit outside RLS and cannot easily be brought inside it:
 * login resolves a user by email before anyone knows which tenant they belong
 * to, session validation resolves one by id from a token, and signup creates a
 * Business before a tenant id exists. All three necessarily run before a tenant
 * GUC is set, so a `businessId = current_setting(...)` predicate would match
 * zero rows and break authentication outright.
 *
 * That leaves the tenant boundary on those two tables resting entirely on which
 * identity holds which grant — which is only meaningful if the identity serving
 * ordinary business traffic does NOT hold the auth privileges. This client is
 * the other half of that split: auth and bootstrap connect as a narrow identity
 * of their own, so `app_runtime` can later lose broad `User`/`Business` access
 * (Step 3) without taking login down with it.
 *
 * Deliberately NOT `prisma-admin`. That client authenticates as the `app_admin`
 * family, whose `p7adm_read FOR SELECT TO app_admin USING (true)` policies grant
 * cross-tenant SELECT across every RLS-protected table. Auth needs two tables,
 * not the estate — routing login through the admin plane would hand every
 * authentication request a cross-tenant read capability it has no use for, and
 * turn a boundary fix into a privilege escalation. The choice is made on the
 * grants each identity actually holds, not on which client name sounds closest.
 *
 * Boundaries (enforced by CI-2a in scripts/ci/admin-boundary-guard.sh):
 *   - importable ONLY from the auth/bootstrap modules named in that guard
 *   - tenant feature code keeps using the canonical `lib/prisma.ts`
 *   - platform-admin keeps using `lib/prisma-admin.ts`
 *
 * Fail-loud contract, matching the admin client: `AUTH_DATABASE_URL` missing
 * throws at first use. There is deliberately NO fallback to `DATABASE_URL`,
 * `DIRECT_URL` or an owner connection. A fallback would be worse than an
 * outage here: it would silently restore exactly the broad `User` access this
 * split exists to remove, and nothing downstream would report anything wrong.
 */
import { PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const globalForPrismaAuth = globalThis as unknown as {
  prismaAuth?: PrismaClient;
};

/**
 * Lazy accessor for the auth/bootstrap client. Throws when AUTH_DATABASE_URL is
 * not configured. Cached on globalThis so dev hot-reload does not accumulate
 * connection pools — the same pattern as the tenant and admin singletons.
 */
export function getPrismaAuth(): PrismaClient {
  if (globalForPrismaAuth.prismaAuth) {
    return globalForPrismaAuth.prismaAuth;
  }

  const url = process.env.AUTH_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "AUTH_DATABASE_URL is not configured — the auth/bootstrap DB path is unavailable. " +
        "Refusing to fall back to the tenant, admin or owner connection."
    );
  }

  const client = new PrismaClient({
    datasourceUrl: url,
    log: ["warn", "error"],
  });

  globalForPrismaAuth.prismaAuth = client;
  return client;
}

/**
 * Whether the auth plane is configured.
 *
 * This exists for ONE purpose: letting the codebase land before the credential
 * does, so Step 2 is a reviewable code change and Step 3 is a separate,
 * explicitly-approved privilege change. While it returns false, the auth paths
 * keep using the canonical client and behaviour is unchanged.
 *
 * It is NOT a fallback in the dangerous sense. The decision is made once, from
 * an environment variable, before any query runs — never in a catch block. A
 * client that fell back on ERROR could mask a revoked grant or a rejected
 * credential as normal operation; that is precisely how a security boundary
 * quietly stops existing. Once Step 3 revokes `app_runtime`'s access, an
 * unconfigured auth plane fails loudly at the first login instead.
 */
export function isAuthPlaneConfigured(): boolean {
  return Boolean(process.env.AUTH_DATABASE_URL?.trim());
}

/**
 * The client the auth/bootstrap paths should use.
 *
 * Returns the dedicated auth client when it is configured, and the canonical
 * tenant client otherwise. The selection is by configuration only — see above.
 */
export function authDb(): PrismaClient {
  return isAuthPlaneConfigured() ? getPrismaAuth() : prisma;
}
