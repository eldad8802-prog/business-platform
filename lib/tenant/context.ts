/**
 * D2 / P5-1 — Tenant Context Primitive (server-only).
 *
 * A minimal, fail-closed holder for the server-derived tenant identity
 * (`businessId`) that is isolated per execution context via Node's
 * AsyncLocalStorage. It is intentionally NOT coupled to Prisma, transactions,
 * RLS, requests, auth, or users — those are later increments (P5-2+).
 *
 * The context is populated ONLY from a trusted server-derived source
 * (e.g. `getCurrentUser(req).businessId`) by the caller; this module never reads
 * a client-supplied tenant from a request body/query/header.
 *
 * Invariants:
 *  - fail-closed: reading with no context in scope throws (no default tenant).
 *  - no silent tenant switch: entering a *different* tenant while a context is
 *    already established is rejected.
 *  - context is transient: it exists only for the duration of the callback and
 *    does not leak to sibling/parent executions, even on error.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** The minimal tenant context. Deliberately holds only the tenant boundary. */
export type TenantContext = {
  /** Server-derived tenant boundary (Business.id — a positive integer). */
  readonly businessId: number;
};

/** Thrown for any tenant-context invariant violation. Carries no sensitive data. */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextError";
  }
}

const storage = new AsyncLocalStorage<TenantContext>();

function assertValidBusinessId(businessId: unknown): asserts businessId is number {
  if (
    typeof businessId !== "number" ||
    !Number.isInteger(businessId) ||
    businessId <= 0
  ) {
    // Do not echo the offending value — keep the error non-revealing.
    throw new TenantContextError(
      "invalid tenant context: businessId must be a positive integer",
    );
  }
}

/**
 * Run `fn` with the given tenant context in scope. Returns whatever `fn`
 * returns (sync value or Promise). Validates the businessId and refuses a
 * silent tenant switch when a *different* context is already established.
 */
export function runWithTenantContext<T>(
  context: TenantContext,
  fn: () => T,
): T {
  assertValidBusinessId(context.businessId);

  const existing = storage.getStore();
  if (existing && existing.businessId !== context.businessId) {
    throw new TenantContextError(
      "refusing to switch tenant context inside an established context",
    );
  }

  // Store an immutable copy so callers cannot mutate the live context.
  const frozen: TenantContext = Object.freeze({ businessId: context.businessId });
  return storage.run(frozen, fn);
}

/** Return the current tenant context, or `undefined` when none is in scope. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** Return the current tenant context, or throw (fail-closed) when none is in scope. */
export function getTenantContextOrThrow(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new TenantContextError("no tenant context in scope");
  }
  return ctx;
}
