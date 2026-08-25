/**
 * D2 / P7-W4A — Canonical async/provider tenant-job primitive.
 *
 * The ONLY sanctioned way for asynchronous or provider-driven work (webhooks,
 * `after()` continuations, background retries) to enter the tenant security
 * substrate. It takes an EXPLICIT, server-derived tenant identity and
 * establishes a fresh tenant context for the job body:
 *
 *   trusted server-derived businessId
 *     → runTenantJob({ businessId }, fn)
 *       → runWithTenantContext (AsyncLocalStorage)
 *         → withTenantTransaction → GUC → RLS
 *
 * Invariants:
 *  - businessId is REQUIRED and validated; missing/invalid throws (fail-closed).
 *  - The tenant identity must be resolved server-side BEFORE scheduling
 *    (session user, provider-mapping row, stored parent row). Never a
 *    payload/body/query/header value.
 *  - The job NEVER inherits a tenant implicitly: the context it runs under is
 *    the one passed here, not whatever request ALS happened to be in scope.
 *  - No silent tenant switch: scheduling an explicit tenant-B job while a
 *    tenant-A context is still established throws loudly (inherited from
 *    `runWithTenantContext`) instead of executing under either tenant.
 *  - No fallback tenant, no owner client, no queue abstraction (none exists).
 */
import { runWithTenantContext } from "@/lib/tenant/context";

/** Thrown for tenant-job contract violations. Carries no sensitive data. */
export class TenantJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantJobError";
  }
}

export type TenantJobIdentity = {
  /**
   * Server-derived tenant boundary. Must come from a trusted resolution
   * (authenticated user, provider-mapping lookup, or an owned parent row) —
   * never from a request/webhook payload.
   */
  readonly businessId: number;
};

/**
 * Run `fn` as a tenant job under an explicitly established tenant context.
 *
 * Returns whatever `fn` returns. Any DB work inside `fn` that targets
 * tenant tables must go through `withTenantTransaction` so the RLS GUC is
 * set on the same connection.
 */
export async function runTenantJob<T>(
  identity: TenantJobIdentity,
  fn: () => Promise<T>
): Promise<T> {
  const businessId = identity?.businessId;
  if (
    typeof businessId !== "number" ||
    !Number.isInteger(businessId) ||
    businessId <= 0
  ) {
    // Do not echo the offending value — keep the error non-revealing.
    throw new TenantJobError(
      "tenant job requires an explicit, server-derived positive businessId"
    );
  }
  return runWithTenantContext({ businessId }, fn);
}
