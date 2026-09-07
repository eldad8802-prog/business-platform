/**
 * Account deletion — orchestrator + manifest tests (Wave 1B). Run:
 *   npx tsx lib/services/account/account-deletion.test.ts
 *
 * Pure/isolated: no DB. Proves the sole-user gate, idempotency, execution order,
 * tenant coherence, and the compliance guard that no legally-retained fiscal/evidence
 * model is ever in a purge set.
 */
import {
  deleteOwnBusinessAccount,
  AccountDeletionError,
  type AccountDeletionStore,
} from "./account-deletion.service";
import {
  assertManifestSafe,
  ERASURE_MANIFEST,
  RETAIN_MODELS,
} from "./account-erasure-manifest";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
async function catchErr(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

const NOW = new Date("2026-08-23T12:00:00Z");

type StoreState = {
  business: { id: number; state: "ACTIVE" | "DELETION_REQUESTED" | "PURGED" } | null;
  activeUserIds: number[];
};
function makeStore(state: StoreState) {
  const calls: string[] = [];
  const store: AccountDeletionStore = {
    async getBusiness(id) {
      calls.push("getBusiness");
      return state.business && state.business.id === id ? { ...state.business } : null;
    },
    async listActiveUserIds() {
      calls.push("listActiveUserIds");
      return [...state.activeUserIds];
    },
    async quarantineAndRevokeIntegrations() {
      calls.push("quarantineAndRevokeIntegrations");
      if (state.business) state.business.state = "DELETION_REQUESTED";
      return true;
    },
    async purgeOperationalData() {
      calls.push("purgeOperationalData");
    },
    async finalizeAndAudit() {
      calls.push("finalizeAndAudit");
      if (state.business) state.business.state = "PURGED";
    },
  };
  return { store, calls, state };
}

(async () => {
  // ---- manifest compliance guard ----
  {
    ok("manifest is safe (no retained model in a purge set)", (() => { try { assertManifestSafe(); return true; } catch { return false; } })());
    const purged = [
      ...ERASURE_MANIFEST.anonymize.map((a) => a.model),
      ...ERASURE_MANIFEST.delete,
      ...ERASURE_MANIFEST.revoke.map((r) => r.model),
    ];
    ok("billingDocument is RETAINED, never purged", RETAIN_MODELS.includes("billingDocument") && !purged.includes("billingDocument"));
    ok("financialRecord RETAINED, never purged", RETAIN_MODELS.includes("financialRecord") && !purged.includes("financialRecord"));
    ok("document (evidence) RETAINED, never purged", RETAIN_MODELS.includes("document") && !purged.includes("document"));
    ok("financialDocument RETAINED, never purged", RETAIN_MODELS.includes("financialDocument") && !purged.includes("financialDocument"));
    ok("user IS anonymized", ERASURE_MANIFEST.anonymize.some((a) => a.model === "user"));
    ok("businessProfile IS anonymized", ERASURE_MANIFEST.anonymize.some((a) => a.model === "businessProfile"));
    ok("customer IS anonymized (not deleted — invoice FK)", ERASURE_MANIFEST.anonymize.some((a) => a.model === "customer") && !ERASURE_MANIFEST.delete.includes("customer"));
    ok("conversation IS deleted (comms PII)", ERASURE_MANIFEST.delete.includes("conversation"));
    // a mutated manifest that purges a retained model must throw
    const bad = { ...ERASURE_MANIFEST, delete: [...ERASURE_MANIFEST.delete, "billingDocument"] };
    let threw = false;
    try { assertManifestSafe(bad); } catch { threw = true; }
    ok("guard throws if a retained model is added to purge", threw === true);
  }

  // ---- sole user → deleted, in order ----
  {
    const { store, calls } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [3] });
    const res = await deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW });
    ok("sole user → deleted", res.status === "deleted");
    ok(
      "execution order: QUARANTINE FIRST → purge → finalize+audit",
      calls
        .join(">")
        .includes("quarantineAndRevokeIntegrations>purgeOperationalData>finalizeAndAudit")
    );
  }

  // ---- second active user → denied, no destructive calls ----
  {
    const { store, calls } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [3, 9] });
    const e = await catchErr(() => deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW }));
    ok("multi-user → AccountDeletionError not_sole_user", e instanceof AccountDeletionError && (e as AccountDeletionError).code === "not_sole_user");
    ok("multi-user → no destructive calls", !calls.includes("quarantineAndRevokeIntegrations") && !calls.includes("purgeOperationalData"));
  }

  // ---- requester is not the sole user → denied ----
  {
    const { store } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [99] });
    const e = await catchErr(() => deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW }));
    ok("sole user but not requester → denied", (e as AccountDeletionError)?.code === "not_sole_user");
  }

  // ---- cross-tenant / unknown business → not_found ----
  {
    const { store } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [3] });
    const e = await catchErr(() => deleteOwnBusinessAccount(store, { businessId: 8, actorUserId: 3, now: NOW }));
    ok("unknown/cross-tenant business → business_not_found", (e as AccountDeletionError)?.code === "business_not_found");
  }

  // ---- idempotent: already deleted → no-op success, no destructive calls ----
  {
    const { store, calls } = makeStore({ business: { id: 7, state: "PURGED" }, activeUserIds: [3] });
    const res = await deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW });
    ok("already-deleted → already_deleted", res.status === "already_deleted");
    ok("already-deleted → no destructive calls, no user-gate needed", !calls.includes("quarantineAndRevokeIntegrations") && !calls.includes("listActiveUserIds"));
  }

  // ---- re-request after deletion is a no-op (idempotency across two calls) ----
  {
    const { store } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [3] });
    const first = await deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW });
    const second = await deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW });
    ok("first deletes, second is idempotent", first.status === "deleted" && second.status === "already_deleted");
  }

  // ---- invalid input ----
  {
    const { store } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [3] });
    const e = await catchErr(() => deleteOwnBusinessAccount(store, { businessId: 0, actorUserId: 3, now: NOW }));
    ok("invalid businessId → invalid_input", (e as AccountDeletionError)?.code === "invalid_input");
  }

  // ---- resume after a failed purge: already quarantined, gate not re-run ----
  {
    const { store, calls } = makeStore({ business: { id: 7, state: "DELETION_REQUESTED" }, activeUserIds: [3] });
    const res = await deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW });
    ok("quarantined business → purge resumes to deleted", res.status === "deleted");
    ok(
      "resume does NOT re-quarantine and does NOT re-run the sole-user gate",
      !calls.includes("quarantineAndRevokeIntegrations") && !calls.includes("listActiveUserIds")
    );
    ok(
      "resume still purges and finalizes",
      calls.includes("purgeOperationalData") && calls.includes("finalizeAndAudit")
    );
  }

  // ---- quarantine precedes every destructive stage ----
  {
    const { store, calls } = makeStore({ business: { id: 7, state: "ACTIVE" }, activeUserIds: [3] });
    await deleteOwnBusinessAccount(store, { businessId: 7, actorUserId: 3, now: NOW });
    const q = calls.indexOf("quarantineAndRevokeIntegrations");
    const purge = calls.indexOf("purgeOperationalData");
    const fin = calls.indexOf("finalizeAndAudit");
    ok(
      "quarantine commits BEFORE anything destructive (the whole point of AD-2A)",
      q >= 0 && q < purge && purge < fin
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll account-deletion tests passed.");
})();
