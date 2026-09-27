/**
 * sec/INT — account-deletion security events (F's recordSecurityEvent at E's erasure
 * stages). DB-free. Run:
 *   npx tsx lib/services/account/erasure-security-events.test.ts
 *
 * Proves:
 *   E1  every stage emits its event, in order: requested, quarantine_entered,
 *       erasure_started, provider_cleanup (one per recorded outcome), verified, completed;
 *   E2  a failed attempt emits attempt_failed (stage + closed error class) and the
 *       sweeper's retry emits erasure_resumed;
 *   E3  rows carry ids and closed codes only: no email, phone, token, error message;
 *       they are UNTENANTED (businessId NULL) with metadata.subjectBusinessId;
 *   E4  a writer that THROWS on every event never blocks the erasure: it converges to
 *       PURGED with the identical stage sequence and provider calls;
 *   Residual (not claimed): a writer that HANGS delays the stage, since recordSecurityEvent
 *       awaits its writer; the Prisma writer is bounded by the pool/statement timeouts.
 */
import assert from "node:assert/strict";
import {
  requestAccountDeletion,
  deleteOwnBusinessAccount,
  type AccountDeletionStore,
  type ProviderGrant,
} from "./account-deletion.service";
import { runAccountErasure, type ProviderRevokers } from "./erasure-job";
import { createMemoryErasureLedger } from "./erasure-memory-ledger";
import {
  setSecurityEventWriterForTests,
  getSecurityEventWriteFailures,
  type SecurityEventRow,
} from "@/lib/security/security-events";

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

function world(fault: Partial<Record<string, number>> = {}) {
  const calls: string[] = [];
  const mem = createMemoryErasureLedger();
  const biz = { id: 7, state: "ACTIVE" as "ACTIVE" | "DELETION_REQUESTED" | "PURGED" };
  let credentialsAlive = true;
  const f = { ...fault };
  const step = (m: string) => {
    calls.push(m);
    if ((f[m] ?? 0) > 0) {
      f[m]!--;
      const e = new Error("owner@example.com 0501234567 leaked into a message");
      (e as Error & { code?: string }).code = "P2010";
      throw e;
    }
  };
  const grants: ProviderGrant[] = [
    { provider: "google", action: "oauth_token_revoke", connectionId: 11, token: "g-refresh-SECRET", wabaId: null },
    { provider: "ita", action: "oauth_token_revoke", connectionId: 31, token: null, wabaId: null },
  ];
  const store: AccountDeletionStore = {
    ledger: mem.ledger,
    async getBusiness(id) { return id === biz.id ? { ...biz } : null; },
    async listActiveUserIds() { return [3]; },
    async quarantineAndRevokeIntegrations() { step("quarantine"); if (biz.state === "ACTIVE") biz.state = "DELETION_REQUESTED"; return true; },
    async revokeAccountAuthority() { step("authority"); },
    async purgeOperationalData() { step("purge"); },
    async eraseAccountSessions() { step("sessions"); },
    async readProviderGrants() { step("grants"); return credentialsAlive ? grants.map((g) => ({ ...g })) : []; },
    async destroyIntegrationCredentials() { step("destroy"); credentialsAlive = false; },
    async verifyErased() { step("verify"); return []; },
    async finalizeAndAudit() { step("finalize"); biz.state = "PURGED"; },
    async listStrandedErasures() { return biz.state === "DELETION_REQUESTED" ? [biz.id] : []; },
  };
  const providerLog: string[] = [];
  const providers: ProviderRevokers = {
    async revokeGoogleToken(t) { providerLog.push(`google:${t}`); return { ok: true, code: "ok" }; },
    async unsubscribeMetaWaba(i) { providerLog.push(`meta:${i.wabaId}`); return { ok: true, code: "ok" }; },
  };
  return { store, calls, biz, providers, providerLog };
}

const T0 = new Date("2026-09-27T00:00:00Z");
const reasons = (rows: SecurityEventRow[]) => rows.map((r) => r.reasonClass);

(async () => {
  console.log("[erasure-security-events] deletion telemetry is complete, PII-free and never blocking");

  await test("E1 every stage emits its event in order", async () => {
    const rows: SecurityEventRow[] = [];
    const prev = setSecurityEventWriterForTests(async (r) => { rows.push(r); });
    try {
      const w = world();
      const r = await deleteOwnBusinessAccount(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: w.providers });
      assert.equal(r.status, "deleted");
      assert.deepEqual(reasons(rows), [
        "requested", "quarantine_entered", "erasure_started",
        "provider_cleanup", "provider_cleanup", "verified", "completed",
      ]);
      assert.equal(rows[0].eventType, "ACCOUNT_DELETION_REQUESTED");
      assert.equal(rows[rows.length - 1].eventType, "ACCOUNT_DELETION_COMPLETED");
      const cleanup = rows.filter((x) => x.reasonClass === "provider_cleanup").map((x) => x.metadata);
      assert.deepEqual(cleanup, [
        { subjectBusinessId: 7, provider: "google", action: "oauth_token_revoke", outcome: "REVOKED" },
        { subjectBusinessId: 7, provider: "ita", action: "oauth_token_revoke", outcome: "NOT_SUPPORTED" },
      ]);
    } finally { setSecurityEventWriterForTests(prev); }
  });

  await test("E2 a failed attempt emits attempt_failed with a closed class, and the retry emits erasure_resumed", async () => {
    const rows: SecurityEventRow[] = [];
    const prev = setSecurityEventWriterForTests(async (r) => { rows.push(r); });
    try {
      const w = world({ purge: 1 });
      const first = await requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: w.providers });
      assert.equal(first.status, "accepted");
      const failed = rows.find((x) => x.reasonClass === "attempt_failed");
      assert.ok(failed, "attempt_failed emitted");
      assert.equal(failed!.eventType, "ACCOUNT_DELETION_STAGE");
      assert.equal(failed!.outcome, "FAILURE");
      assert.equal(failed!.metadata?.stage, "PURGE");
      assert.equal(failed!.metadata?.attempt, 1);
      const again = await runAccountErasure(w.store, 7, { trigger: "sweeper", now: new Date(T0.getTime() + 6 * 3600_000), providers: w.providers });
      assert.equal(again.status, "COMPLETED");
      const resumed = rows.find((x) => x.reasonClass === "erasure_resumed");
      assert.ok(resumed, "erasure_resumed emitted");
      assert.deepEqual(resumed!.metadata, { subjectBusinessId: 7, attempt: 2, trigger: "sweeper" });
      assert.equal(reasons(rows).at(-1), "completed");
    } finally { setSecurityEventWriterForTests(prev); }
  });

  await test("E3 rows carry ids and closed codes only; untenanted with subjectBusinessId", async () => {
    const rows: SecurityEventRow[] = [];
    const prev = setSecurityEventWriterForTests(async (r) => { rows.push(r); });
    try {
      const w = world({ verify: 1 });
      await requestAccountDeletion(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: w.providers });
      await runAccountErasure(w.store, 7, { trigger: "sweeper", now: new Date(T0.getTime() + 6 * 3600_000), providers: w.providers });
      assert.ok(rows.length >= 8);
      const blob = JSON.stringify(rows);
      for (const bad of ["@", "0501234567", "leaked", "SECRET", "g-refresh", "message"]) assert.ok(!blob.includes(bad), `row carries "${bad}"`);
      for (const r of rows) {
        assert.equal(r.businessId, null, "deletion events are untenanted (a quarantined tenant tx refuses them)");
        assert.equal(r.metadata?.subjectBusinessId, 7);
        assert.equal(r.ipHash, null);
      }
    } finally { setSecurityEventWriterForTests(prev); }
  });

  await test("E4 a writer that throws on EVERY event never blocks the erasure", async () => {
    const control = world();
    const prev0 = setSecurityEventWriterForTests(async () => {});
    await deleteOwnBusinessAccount(control.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: control.providers });
    setSecurityEventWriterForTests(prev0);

    let thrown = 0;
    const before = getSecurityEventWriteFailures();
    const prev = setSecurityEventWriterForTests(async () => { thrown++; throw new Error("telemetry database down"); });
    const origError = console.error;
    console.error = () => {};
    try {
      const w = world();
      const r = await deleteOwnBusinessAccount(w.store, { businessId: 7, actorUserId: 3, now: T0 }, { providers: w.providers });
      assert.equal(r.status, "deleted");
      assert.equal(w.biz.state, "PURGED");
      assert.deepEqual(w.calls, control.calls, "identical stage sequence with broken telemetry");
      assert.deepEqual(w.providerLog, control.providerLog, "identical provider calls with broken telemetry");
      assert.equal(thrown, 7, "every event was attempted");
      assert.equal(getSecurityEventWriteFailures() - before, 7, "each failure counted");
    } finally {
      console.error = origError;
      setSecurityEventWriterForTests(prev);
    }
  });

  console.log(`erasure-security-events: ${passed} passed, 0 failed`);
})();
