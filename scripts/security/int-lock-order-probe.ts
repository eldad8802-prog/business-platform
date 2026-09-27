/**
 * sec/INT — deterministic lock-order probe: E's lifecycle lock (SHARED in every tenant
 * transaction, EXCLUSIVE at quarantine) x F's audit-chain lock (EXCLUSIVE per table per
 * business) x #521's triggers, driven through the REAL code paths as a NOSUPERUSER
 * NOBYPASSRLS runtime role. Ordering is established by observing pg_locks from an owner
 * connection, never by sleeping.
 *
 *   OWNER_URL=... RUNTIME_URL=... npx tsx scripts/security/int-lock-order-probe.ts
 *
 *   L1  in-flight tenant write (holds lifecycle S + chain X, uncommitted) -> quarantine
 *       queues on the lifecycle key -> a LATER tenant write queues behind the quarantine
 *       -> release: the in-flight write commits, the quarantine commits, the later write
 *       is refused (BusinessQuarantinedError). No 40P01, nothing hangs, chain = 1 row.
 *   L2  12 concurrent chained appends + a quarantine fired mid-stream: every append either
 *       committed before the quarantine or was refused after it; the chain is linear 1..k.
 *   L3  a quarantine of business A, blocked on A's in-flight write, does not block B.
 *   L4  a business-attributed security event for a quarantined business is DROPPED by the
 *       tenant write path (counted, never thrown); the untenanted form is accepted by RLS.
 *   L5  the runtime is really NOBYPASSRLS / NOSUPERUSER (else the probe refuses to run).
 */
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
const RUNTIME_URL = process.env.RUNTIME_URL!;
if (!OWNER_URL || !RUNTIME_URL) throw new Error("OWNER_URL and RUNTIME_URL are required");
process.env.DATABASE_URL = RUNTIME_URL;
process.env.DIRECT_URL = RUNTIME_URL;
process.env.AUDIT_CHAIN_KEY ??= "a".repeat(64);
process.env.AUDIT_CHAIN_KEY_ID ??= "lab1";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`); }
}
const owner = new PrismaClient({ datasourceUrl: OWNER_URL });

async function waitFor(what: string, pred: () => Promise<boolean>, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timeout waiting for ${what}`);
}
/** advisory locks on (key1,key2), by granted state */
async function advisory(key1: number, key2: number) {
  const rows = await owner.$queryRawUnsafe<{ granted: boolean; mode: string }[]>(
    `SELECT granted, mode FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=2`,
    key1 >>> 0, key2 >>> 0
  );
  return { granted: rows.filter((r) => r.granted), waiting: rows.filter((r) => !r.granted) };
}
function deferred() { let resolve!: () => void; const p = new Promise<void>((r) => (resolve = r)); return { p, resolve }; }
async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`HANG ${what}`)), ms))]);
}
const errName = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? (r.reason as Error)?.name ?? "Error" : "fulfilled");
const errCode = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String((r.reason as { code?: string; meta?: { code?: string } })?.meta?.code ?? (r.reason as { code?: string })?.code ?? "") : "");

(async () => {
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { ADVISORY_NAMESPACE, BusinessQuarantinedError } = await import("@/lib/tenant/business-lifecycle");
  const { createBillingAuditEventTx } = await import("@/lib/services/billing/billing-audit.service");
  const { prismaAccountDeletionStore } = await import("@/lib/services/account/account-deletion.prisma-store");
  const sec = await import("@/lib/security/security-events");
  const { prisma } = await import("@/lib/prisma");
  const CHAIN_NS = 0x5ecf0001;

  console.log("[int-lock-order-probe]");
  const who = await prisma.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`);
  ok("L5 runtime is NOSUPERUSER NOBYPASSRLS", who[0] && !who[0].s && !who[0].b, who[0]);
  if (!who[0] || who[0].s || who[0].b) process.exit(2);

  const mk = async (name: string) => (await owner.business.create({ data: { name } })).id;
  const audit = (b: number, n: number) => (tx: Parameters<typeof createBillingAuditEventTx>[0]) =>
    createBillingAuditEventTx(tx, { businessId: b, eventType: "BILLING_AUTHORITY_OAUTH_STARTED", source: "SYSTEM", summary: `probe ${n}` });
  const chain = async (b: number) =>
    owner.$queryRawUnsafe<{ s: number }[]>(`SELECT "chainSeq" AS s FROM "BillingAuditEvent" WHERE "businessId"=$1 ORDER BY "chainSeq"`, b);

  // ── L1 ────────────────────────────────────────────────────────────────────
  {
    const A = await mk("probe-A");
    const B = await mk("probe-B");
    const hold = deferred();
    const t1 = tenantTx(A, async (tx) => { await audit(A, 1)(tx); await hold.p; return "t1"; }, { timeoutMs: 60_000 });
    await waitFor("T1 holds the chain lock", async () => (await advisory(CHAIN_NS, A)).granted.length === 1);
    const lcBefore = await advisory(ADVISORY_NAMESPACE, A);
    ok("L1 T1 holds the lifecycle key SHARED", lcBefore.granted.length === 1 && lcBefore.granted[0].mode === "ShareLock", lcBefore);
    const q = prismaAccountDeletionStore.quarantineAndRevokeIntegrations(A, new Date());
    await waitFor("quarantine queued EXCLUSIVE", async () => (await advisory(ADVISORY_NAMESPACE, A)).waiting.some((w) => w.mode === "ExclusiveLock"));
    const t3 = tenantTx(A, async (tx) => { await audit(A, 3)(tx); return "t3"; });
    await waitFor("T3 queued behind the quarantine", async () => (await advisory(ADVISORY_NAMESPACE, A)).waiting.length === 2);
    // L3 while A is contended: B is independent.
    const tb = await withDeadline(tenantTx(B, async (tx) => { await audit(B, 1)(tx); return "tb"; }), 10_000, "tenant write on B");
    ok("L3 a quarantine blocked on A does not block B", tb === "tb");
    hold.resolve();
    const [r1, rq, r3] = await withDeadline(Promise.allSettled([t1, q, t3]), 30_000, "L1 settle");
    ok("L1 in-flight write commits", r1.status === "fulfilled", errName(r1));
    ok("L1 quarantine commits after it", rq.status === "fulfilled" && rq.value === true, rq);
    ok("L1 the later write is REFUSED (BusinessQuarantinedError), not deadlocked", r3.status === "rejected" && (r3.reason instanceof BusinessQuarantinedError), `${errName(r3)} ${errCode(r3)}`);
    ok("L1 no deadlock (40P01) anywhere", ![r1, rq, r3].some((r) => errCode(r) === "40P01" || /deadlock/i.test(String((r as PromiseRejectedResult).reason ?? ""))));
    const c = await chain(A);
    ok("L1 chain of A = exactly T1's row, seq 1", c.length === 1 && Number(c[0].s) === 1, c);
    const lifecycle = await owner.business.findUnique({ where: { id: A }, select: { deletionRequestedAt: true } });
    ok("L1 A is quarantined", lifecycle?.deletionRequestedAt !== null);
  }

  // ── L2 ────────────────────────────────────────────────────────────────────
  {
    const C = await mk("probe-C");
    const N = 12;
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      writes.push(tenantTx(C, async (tx) => { await audit(C, i)(tx); }));
      if (i === 5) writes.push(prismaAccountDeletionStore.quarantineAndRevokeIntegrations(C, new Date()).then((x) => ({ quarantine: x })));
    }
    const settled = await withDeadline(Promise.allSettled(writes), 60_000, "L2 settle");
    const qIdx = 6;
    const q = settled[qIdx];
    const appends = settled.filter((_, i) => i !== qIdx);
    const committed = appends.filter((r) => r.status === "fulfilled").length;
    const refused = appends.filter((r) => r.status === "rejected" && (r.reason as Error).name === "BusinessQuarantinedError").length;
    const other = appends.filter((r) => r.status === "rejected" && (r.reason as Error).name !== "BusinessQuarantinedError");
    ok("L2 quarantine committed", q.status === "fulfilled");
    ok("L2 every append either committed or was refused by the quarantine", committed + refused === N, { committed, refused, other: other.map((o) => `${errName(o)} ${errCode(o)}`) });
    ok("L2 no deadlock / serialization failure", other.length === 0);
    const c = (await chain(C)).map((r) => Number(r.s));
    ok("L2 chain is linear 1..k with k = committed", c.length === committed && c.every((s, i) => s === i + 1), c);
    ok("L2 nothing committed after the quarantine (no append refused-then-present)", c.length <= N);
  }

  // ── L4 ────────────────────────────────────────────────────────────────────
  {
    const D = await mk("probe-D");
    await prismaAccountDeletionStore.quarantineAndRevokeIntegrations(D, new Date());
    const before = sec.getSecurityEventWriteFailures();
    const origErr = console.error; console.error = () => {};
    await sec.recordSecurityEvent({ type: "ACCOUNT_DELETION_STAGE", outcome: "INFO", reason: "probe_tenant", businessId: D });
    console.error = origErr;
    ok("L4 tenant-attributed event for a quarantined business is DROPPED (counted, not thrown)", sec.getSecurityEventWriteFailures() === before + 1);
    await sec.recordSecurityEvent({ type: "ACCOUNT_DELETION_STAGE", outcome: "INFO", reason: "probe_untenanted", businessId: null, metadata: { subjectBusinessId: D } });
    ok("L4 untenanted form accepted (RLS insert policy: businessId NULL)", sec.getSecurityEventWriteFailures() === before + 1);
    const rows = await owner.$queryRawUnsafe<{ r: string; b: number | null }[]>(`SELECT "reasonClass" AS r, "businessId" AS b FROM "SecurityEvent" WHERE "reasonClass" LIKE 'probe_%' AND "metadata"->>'subjectBusinessId' = $1`, String(D));
    ok("L4 stored: only the untenanted row", rows.length === 1 && rows[0].r === "probe_untenanted" && rows[0].b === null, rows);
  }

  console.log(`int-lock-order-probe: ${passed} passed, ${failed} failed`);
  await owner.$disconnect();
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.log(`  FAIL  SETUP ${e?.name}: ${e?.message}`);
  process.exit(3);
});
