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
  // A malformed URL must fail here, at initialization, with a message that names
  // the cause. Left to the driver it surfaces later as an opaque connection
  // error on a login request, which reads like an outage rather than a
  // misconfiguration and invites someone to "fix" it by unsetting the variable.
  if (!/^postgres(ql)?:\/\/[^\s]+$/i.test(url)) {
    throw new Error(
      "AUTH_DATABASE_URL is not a valid PostgreSQL connection string. " +
        "Refusing to start the auth plane on an unusable credential."
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
 * Which plane serves auth, as a DELIBERATE state rather than a side effect of
 * whether a variable happens to be set.
 *
 * An earlier revision selected the client by the presence of
 * `AUTH_DATABASE_URL`. That is fine while rolling out and wrong forever after:
 * once the auth plane is live, losing the variable — a bad deploy, a dropped
 * environment, a typo in a rename — would silently route login, session
 * validation and signup back through `app_runtime`, restoring exactly the broad
 * `User` access this split exists to remove, with no error anywhere. The
 * boundary would be gone and every request would still succeed.
 *
 * So the mode is stated, and the credential is then mandatory within it.
 */
export type AuthPlaneMode = "legacy" | "active";

export function authPlaneMode(): AuthPlaneMode {
  const raw = process.env.AUTH_PLANE_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "false") return "legacy";
  if (raw === "true") return "active";
  // Neither silently. An unrecognised value ("1", "yes", "True ") must not be
  // read as "legacy", because that turns a typo into a quiet downgrade of the
  // security posture — the failure mode this whole function exists to prevent.
  throw new Error(
    `AUTH_PLANE_ENABLED must be exactly "true" or "false" (received ${JSON.stringify(raw)}). ` +
      "Refusing to guess which auth plane to use."
  );
}

/** True only in the fully-separated state. */
export function isAuthPlaneActive(): boolean {
  return authPlaneMode() === "active";
}

/**
 * The client the auth/bootstrap paths use.
 *
 * `legacy`  — the canonical tenant client, exactly as Production behaves today.
 *             This exists only so the code can ship before the DB identity does.
 * `active`  — the dedicated auth client, and nothing else. If its credential is
 *             missing, blank or unusable this THROWS. There is deliberately no
 *             path from an auth-plane failure back to `prisma`: a fallback would
 *             convert a broken boundary into a working login, which is the one
 *             outcome that guarantees nobody finds out.
 *
 * The mode is resolved before any query runs and never inside a catch block.
 */
export function authDb(): PrismaClient {
  return authPlaneMode() === "active" ? getPrismaAuth() : prisma;
}
