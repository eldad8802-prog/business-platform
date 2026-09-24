/**
 * SEC-E — the durable erasure job, DB-free. Run:
 *   npx tsx lib/services/account/erasure-job.test.ts
 *
 * Proves the orchestration properties with an injected store, the in-memory ledger
 * (same claim semantics as the Prisma ledger) and FAKE providers — never a real one.
 * The database-faithful proof, with real RLS and real failures, is .sec-e/battery.mjs.
 */
import assert from "node:assert/strict";
import {
  requestAccountDeletion,
  deleteOwnBusinessAccount,
  AccountErasureIncompleteError,
  type AccountDeletionStore,
  type ProviderGrant,
} from "./account-deletion.service";
import {
  classifyErasureError,
  runAccountErasure,
  sweepStrandedErasures,
  MAX_PROVIDER_REVOKE_ATTEMPTS,
  type ProviderRevokers,
} from "./erasure-job";
import { createMemoryErasureLedger } from "./erasure-memory-ledger";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n`, e);
    process.exit(1);
  }
}

type Fault = Partial<Record<string, number>>; // method -> remaining failures

function world(opts: { grants?: ProviderGrant[]; state?: "ACTIVE" | "DELETION_REQUESTED" | "PURGED"; fault?: Fault; residual?: string[][] } = {}) {
  const calls: string[] = [];
  const mem = createMemoryErasureLedger();
  const biz = { id: 7, state: opts.state ?? "ACTIVE" } as { id: number; state: "ACTIVE" | "DELETION_REQUESTED" | "PURGED" };
  let credentialsAlive = true;
  const fault = { ...(opts.fault ?? {}) };
  const residual = [...(opts.residual ?? [])];
  const maybeFail = (m: string) => {
    calls.push(m);
    if ((fault[m] ?? 0) > 0) {
      fault[m]!--;
      const e = new Error("customer@example.com 0501234567 leaked into a message");
      (e as Error & { code?: string }).code = "P2010";
      throw e;
    }
  };
  const store: AccountDeletionStore = {
    ledger: mem.ledger,
    async getBusiness(id) {
      return id === biz.id ? { ...biz } : null;
    },
    async listActiveUserIds() {
      return [3];
    },
    async quarantineAndRevokeIntegrations() {
      maybeFail("quarantine");
      if (biz.state === "ACTIVE") biz.state = "DELETION_REQUESTED";
      return true;
    },
    async revokeAccountAuthority() {
      maybeFail("authority");
    },
    async purgeOperationalData() {
      maybeFail("purge");
    },
    async eraseAccountSessions() {
      maybeFail("sessions");
    },
    async readProviderGrants() {
      maybeFail("grants");
      return credentialsAlive ? (opts.grants ?? []).map((g) => ({ ...g })) : [];
    },
    async destroyIntegrationCredentials() {
      maybeFail("destroy");
      credentialsAlive = false;
    },
    async verifyErased() {
      maybeFail("verify");
      return residual.shift() ?? [];
    },
    async finalizeAndAudit() {
      maybeFail("finalize");
      biz.state = "PURGED";
    },
    async listStrandedErasures() {
      return biz.state === "DELETION_REQUESTED" ? [biz.id] : [];
    },
  };
  return { store, calls, mem, biz, fault };
}

function fakeProviders(plan: { google?: boolean[]; meta?: boolean[] } = {}) {
  const log: string[] = [];
  const google = [...(plan.google ?? [])];
  const meta = [...(plan.meta ?? [])];
  const providers: ProviderRevokers = {
    async revokeGoogleToken(token) {
      log.push(`google:${token}`);
      const ok = google.length ? google.shift()! : true;
      return ok ? { ok: true, code: "ok" } : { ok: false, code: "http_error" };
    },
    async unsubscribeMetaWaba(input) {
      log.push(`meta:${input.wabaId}`);
      const ok = meta.length ? meta.shift()! : true;
      return ok ? { ok: true, code: "ok" } : { ok: false, code: "unsubscribe_500" };
    },
  };
  return { providers, log };
}

const GRANTS: ProviderGrant[] = [
  { provider: "google", action: "oauth_token_revoke", connectionId: 11, token: "g-refresh", wabaId: null },
  { provider: "meta", action: "waba_unsubscribe", connectionId: 21, token: "m-token", wabaId: "waba-1" },
  { provider: "ita", action: "oauth_token_revoke", connectionId: 31, token: null, wabaId: null },
  { provider: "payment", action: "credential_revoke", connectionId: 41, token: null, wabaId: null },
];
const T0 = new Date("2026-09-25T00:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

(async () => {
  console.log("[erasure-job] durable, resumable, truthful");

  await test("happy path: every stage in order, providers revoked BEFORE credentials destroyed, outcomes truthful", async () => {
    const w = world({ grants: GRANTS });
    const p = fakeProviders();
    const r = await deleteOwnBusinessAccount(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: p.providers });
    assert.equal(r.status, "deleted");
    assert.deepEqual(w.calls, ["quarantine", "authority", "purge", "sessions", "grants", "destroy", "verify", "finalize"]);
    assert.deepEqual(p.log, ["google:g-refresh", "meta:waba-1"]);
    const out = Object.fromEntries((await w.mem.ledger.readProviderOutcomes(7)).map((o) => [`${o.provider}:${o.action}`, o.outcome]));
    assert.deepEqual(out, {
      "google:oauth_token_revoke": "REVOKED",
      "meta:waba_unsubscribe": "REVOKED",
      // The token itself: no documented revoke. Said so, not implied.
      "meta:token_invalidate": "NOT_SUPPORTED",
      "ita:oauth_token_revoke": "NOT_SUPPORTED",
      "payment:credential_revoke": "NOT_SUPPORTED",
    });
  });

  await test("provider failure keeps the ciphertext and fails the attempt; retries converge without a second revoke of the one that succeeded", async () => {
    const w = world({ grants: GRANTS });
    const p = fakeProviders({ google: [false, true] });
    const first = await requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: p.providers });
    assert.equal(first.status, "accepted");
    assert.ok(!w.calls.includes("destroy"), "credentials must survive a pending provider revoke");
    const again = await runAccountErasure(w.store, 7, { trigger: "sweeper", now: later(6 * 60_000), providers: p.providers });
    assert.equal(again.status, "COMPLETED");
    // meta succeeded on attempt 1 and is NOT called again; google called twice.
    assert.deepEqual(p.log, ["google:g-refresh", "meta:waba-1", "google:g-refresh"]);
    assert.equal(w.biz.state, "PURGED");
  });

  await test(`a provider that never confirms is recorded REVOKE_FAILED_LOCAL_DELETED after ${MAX_PROVIDER_REVOKE_ATTEMPTS} attempts, then local destruction proceeds`, async () => {
    const w = world({ grants: [GRANTS[0]] });
    const p = fakeProviders({ google: [false, false, false, false] });
    let t = 0;
    let last;
    for (let i = 0; i < MAX_PROVIDER_REVOKE_ATTEMPTS + 1 && w.biz.state !== "PURGED"; i++) {
      if (i === 0) {
        await requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: p.providers });
      } else {
        t += 7 * 60 * 60_000;
        last = await runAccountErasure(w.store, 7, { trigger: "sweeper", now: later(t), providers: p.providers });
      }
    }
    assert.equal(last?.status, "COMPLETED");
    const [o] = await w.mem.ledger.readProviderOutcomes(7);
    assert.equal(o.outcome, "REVOKE_FAILED_LOCAL_DELETED");
    assert.match(String(o.reason), /^retries_exhausted:/);
    assert.equal(p.log.length, MAX_PROVIDER_REVOKE_ATTEMPTS);
  });

  await test("an undecryptable token is never reported REVOKED", async () => {
    const w = world({ grants: [{ ...GRANTS[0], token: null }] });
    const p = fakeProviders();
    await deleteOwnBusinessAccount(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: p.providers });
    const [o] = await w.mem.ledger.readProviderOutcomes(7);
    assert.equal(o.outcome, "REVOKE_FAILED_LOCAL_DELETED");
    assert.equal(p.log.length, 0);
  });

  for (const stage of ["authority", "purge", "sessions", "grants", "destroy", "verify", "finalize"]) {
    await test(`fault at ${stage}: request is ACCEPTED (202 semantics), state persists, sweeper converges`, async () => {
      const w = world({ grants: GRANTS, fault: { [stage]: 1 } });
      const p = fakeProviders();
      const r = await requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: p.providers });
      assert.equal(r.status, "accepted");
      assert.equal(w.biz.state, "DELETION_REQUESTED");
      const res = w.mem.results.get(7)?.get(1);
      assert.equal(res?.outcome, "FAILED");
      // The class is a code, never the message (which quoted an email and a phone).
      assert.ok(res?.outcome === "FAILED" && !/@|050/.test(res.errorClass), JSON.stringify(res));
      // Backoff respected: an immediate sweep is NOT_DUE.
      const early = await sweepStrandedErasures(w.store, { now: later(1000), providers: p.providers });
      assert.equal(early.results[0].status, "NOT_DUE");
      const due = await sweepStrandedErasures(w.store, { now: later(6 * 60_000), providers: p.providers });
      assert.equal(due.results[0].status, "COMPLETED");
      assert.equal(w.biz.state, "PURGED");
      // No duplicate destructive side effect: each provider revoked exactly once,
      // authority revoked exactly once.
      assert.deepEqual(p.log, ["google:g-refresh", "meta:waba-1"]);
      assert.equal(w.calls.filter((c) => c === "authority").length, stage === "authority" ? 2 : 1);
      assert.equal(w.calls.filter((c) => c === "finalize").length, stage === "finalize" ? 2 : 1);
    });
  }

  await test("VERIFY residual blocks the terminal transition", async () => {
    const w = world({ residual: [["email"]] });
    const r = await requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 });
    assert.equal(r.status, "accepted");
    assert.ok(!w.calls.includes("finalize"));
    assert.equal(w.mem.results.get(7)?.get(1)?.outcome, "FAILED");
  });

  await test("a quarantine failure is NOT accepted — nothing changed, it throws and the owner retries", async () => {
    const w = world({ fault: { quarantine: 1 } });
    await assert.rejects(() => requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 }));
    assert.equal(w.biz.state, "ACTIVE");
  });

  await test("deleteOwnBusinessAccount keeps its throwing contract for an incomplete erasure", async () => {
    const w = world({ fault: { purge: 1 } });
    await assert.rejects(
      () => deleteOwnBusinessAccount(w.store, { businessId: 7, actorUserId: 3, now: T0 }),
      (e: unknown) => e instanceof AccountErasureIncompleteError
    );
  });

  await test("the sweeper never STARTS a deletion: an ACTIVE business is NOT_QUARANTINED", async () => {
    const w = world({ state: "ACTIVE" });
    const r = await runAccountErasure(w.store, 7, { trigger: "sweeper", now: T0 });
    assert.equal(r.status, "NOT_QUARANTINED");
    assert.deepEqual(w.calls, []);
  });

  await test("a live lease makes a concurrent run BUSY; an expired lease is taken over", async () => {
    const w = world({ state: "DELETION_REQUESTED" });
    await w.mem.ledger.claimAttempt(7, { now: T0, trigger: "request", leaseMs: 60_000, respectBackoff: false });
    const busy = await runAccountErasure(w.store, 7, { trigger: "sweeper", now: later(1000) });
    assert.equal(busy.status, "BUSY");
    assert.deepEqual(w.calls, []);
    const taken = await runAccountErasure(w.store, 7, { trigger: "sweeper", now: later(120_000) });
    assert.equal(taken.status, "COMPLETED");
    assert.equal(w.mem.attempts.get(7)?.length, 2);
  });

  await test("error classes carry no values", async () => {
    const e = Object.assign(new Error("duplicate key (email)=(a@b.c)"), { code: "P2002" });
    assert.equal(classifyErasureError(e), "DB_P2002");
    const pg = Object.assign(new Error("new row violates row-level security for a@b.c"), { code: "P2010", meta: { code: "42501" } });
    assert.equal(classifyErasureError(pg), "DB_P2010_42501");
  });

  console.log(`[erasure-job] ${passed} passed`);
})();
