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
import { assertBusinessAcceptsWrites } from "@/lib/tenant/business-lifecycle";

/** Thrown for tenant-job contract violations. Carries no sensitive data. */
export class TenantJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantJobError";
  }
}

/**
 * How a job relates to the account-deletion quarantine (D2/AD-2A).
 *
 *   "normal"  (default) — a NORMAL tenant write. Refused the moment the business
 *                         enters DELETION_REQUESTED, so a provider webhook or a
 *                         background job captured while the tenant was healthy can
 *                         never resurrect operational data after erasure begins.
 *   "erasure"           — the erasure worker itself, which must be able to act ON a
 *                         quarantined business. This value is the ONLY way past the
 *                         gate and is restricted by CI to the account-erasure module,
 *                         so it can never become a convenient bypass.
 */
export type TenantJobQuarantinePolicy = "normal" | "erasure";

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
/**
 * `checkLifecycle` exists ONLY so this primitive stays unit-testable without a
 * database. It had no Prisma dependency at all before AD-2A, and losing that
 * would have made a security primitive impossible to exercise in isolation. It
 * defaults to the real gate, and CI-AD-6 pins that the default is not swapped out.
 */
export type RunTenantJobOptions = {
  quarantinePolicy?: TenantJobQuarantinePolicy;
  checkLifecycle?: (businessId: number) => Promise<void>;
};

export async function runTenantJob<T>(
  identity: TenantJobIdentity,
  fn: () => Promise<T>,
  options?: RunTenantJobOptions
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
  const policy = options?.quarantinePolicy ?? "normal";
  if (policy === "normal") {
    // Fail-closed lifecycle gate. This is the async counterpart of the session check
    // in getCurrentUser: a webhook or a background continuation never calls
    // getCurrentUser, so without this the quarantine simply did not exist for them.
    // Checked BEFORE the context is entered, so a refused job does no tenant work at
    // all. Security-critical writes additionally re-check inside their own
    // transaction (assertBusinessAcceptsWritesTx) — a pre-check alone cannot survive
    // a quarantine that commits while the job is running.
    await (options?.checkLifecycle ?? assertBusinessAcceptsWrites)(businessId);
  }
  return runWithTenantContext({ businessId }, fn);
}
