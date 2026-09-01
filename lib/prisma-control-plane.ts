/**
 * D2 / PRIVILEGED-WRITE-2 — the SANCTIONED control-plane Prisma client.
 *
 * NARROW PRIVILEGED WRITER. This client authenticates as the dedicated
 * control-plane role (`app_ctlplane` family: a NOLOGIN group created by the
 * canonical migration, with one LOGIN role per environment — Preview:
 * `app_ctlplane_preview`). The role is NOSUPERUSER, NOBYPASSRLS, non-owner,
 * and its ONLY write privileges are:
 *
 *   - SELECT / INSERT / UPDATE on "BusinessFeatureAccess"  (never DELETE)
 *   - SELECT / INSERT on "PlatformAuditEvent"              (append-only audit)
 *
 * plus SELECT on "Business" and "PlatformFeaturePolicy" so one transaction can
 * validate its target and compute the resulting effective state. It holds no
 * privilege on any other tenant table, no DDL, no ownership, no BYPASSRLS.
 *
 * Even inside that surface it is NOT a cross-tenant writer: the
 * `p7pw2_ctl_insert` / `p7pw2_ctl_update` policies confine every write to the
 * business named by the transaction-local `app.current_business_id` GUC. A
 * caller must therefore hold BOTH the credential AND an explicitly established
 * target context — see `lib/services/control-plane/control-plane-transaction.ts`,
 * which is the only sanctioned way to use this client.
 *
 * Boundaries (mechanically enforced by the CI-PRIVWRITE guard):
 *   - May be imported ONLY from `lib/services/control-plane/**`.
 *   - No tenant route, business service, provider callback, background job,
 *     billing/documents/payments/WhatsApp/Gmail path or feature-access tenant
 *     resolver may import it, directly or transitively.
 *
 * Fail-loud contract: `CONTROL_PLANE_DATABASE_URL` missing => throw at first
 * use. There is deliberately NO fallback to DATABASE_URL, ADMIN_DATABASE_URL or
 * DIRECT_URL — a misconfigured environment must surface as an error, never as a
 * tenant connection, an admin connection, an owner connection, or a silently
 * zeroed write.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrismaControlPlane = globalThis as unknown as {
  prismaControlPlane?: PrismaClient;
};

/**
 * Lazy accessor for the control-plane client. Throws loudly when
 * CONTROL_PLANE_DATABASE_URL is not configured. Cached on globalThis so dev
 * hot-reload does not accumulate connection pools (same pattern as the
 * canonical tenant singleton and the admin client).
 */
export function getPrismaControlPlane(): PrismaClient {
  if (globalForPrismaControlPlane.prismaControlPlane) {
    return globalForPrismaControlPlane.prismaControlPlane;
  }

  const url = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "CONTROL_PLANE_DATABASE_URL is not configured — the control-plane DB path is unavailable. " +
        "Refusing to fall back to the tenant, admin or owner connection."
    );
  }

  const client = new PrismaClient({
    datasourceUrl: url,
    log: ["warn", "error"],
  });

  globalForPrismaControlPlane.prismaControlPlane = client;
  return client;
}
