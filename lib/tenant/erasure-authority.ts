/**
 * SEC-E / M-12(c) — the ERASURE AUTHORITY, as an explicit, scoped capability.
 *
 * `withTenantTransaction` now refuses to open a tenant transaction for a business that
 * is being or has been erased (see `assertTenantTxAcceptsWrites` in
 * business-lifecycle.ts). That closes the window the entry-point gates could not: a
 * webhook, an OAuth callback or an import that passed `runTenantJob`'s pre-check while
 * the business was ACTIVE, and then opened its transaction after the quarantine
 * committed.
 *
 * The erasure itself must still be able to act on the quarantined business — that is
 * its entire job. It does so by holding THIS capability, and nothing else grants it:
 *
 *   - it is set ONLY by `runTenantJob with the erasure quarantine policy`
 *     (lib/tenant/job.ts), and the erasure-policy literal is already
 *     confined to the account module by CI-AD-5;
 *   - `runWithErasureAuthority` itself may be called only from lib/tenant/job.ts, which
 *     `lib/tenant/erasure-authority.guard.test.ts` pins statically;
 *   - it is SCOPED to one businessId. Holding it for business A says nothing about B,
 *     so a stray tenant switch cannot carry the bypass with it (and
 *     `runWithTenantContext` refuses the switch anyway).
 *
 * It is a separate AsyncLocalStorage rather than a field on TenantContext on purpose:
 * `runWithTenantContext` is called from dozens of places with an object literal, and a
 * field there would be one keystroke away from any of them.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type ErasureAuthority = { readonly businessId: number };

const storage = new AsyncLocalStorage<ErasureAuthority>();

/**
 * Run `fn` holding the erasure authority for exactly `businessId`.
 * RESTRICTED: lib/tenant/job.ts is the only permitted caller.
 */
export function runWithErasureAuthority<T>(businessId: number, fn: () => T): T {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("erasure authority requires a positive, server-derived businessId");
  }
  return storage.run(Object.freeze({ businessId }), fn);
}

/** True only inside `runWithErasureAuthority` for this very business. */
export function holdsErasureAuthority(businessId: number): boolean {
  const held = storage.getStore();
  return held !== undefined && held.businessId === businessId;
}
