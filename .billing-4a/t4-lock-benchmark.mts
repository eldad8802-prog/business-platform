/**
 * 4a T4 — controlled comparison of issuance WITH and WITHOUT the shared transition key, for businesses that never
 * transitioned. The runner swaps lib/services/billing/billing-issue.service.ts between main's version (no key) and the
 * T4 version (key) and runs this file on a fresh clone of the same lab database each time, alternating modes.
 * Nothing here changes a timeout or the issuance path: the application's own issueBillingDocument, default settings.
 *
 *   B1  sequential: 30 tax invoices of one business, one after the other → per-issuance latency
 *   B2  same business, 8 at once (they serialize on the counter row), 5 rounds → success, latency, numbering
 *   B3  8 different businesses, 1 each at once, 5 rounds → success, latency
 *   LW  a sampler reads pg_locks every 10 ms during B1–B3: advisory locks NOT granted (= someone waiting on the key)
 *   LK  the key itself: 16 transactions take it shared at once → time per acquisition
 *
 *   MODE=<label> OWNER_URL=… DATABASE_URL=… OUT_JSON=<file> npx tsx .billing-4a/t4-lock-benchmark.mts
 */
import { writeFileSync } from "node:fs";
import { BillingDocumentType, PrismaClient } from "@prisma/client";

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
globalThis.fetch = (async () => { throw new Error("network disabled in this lab"); }) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, z) => a - z); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
const stats = (xs: number[]) => ({ n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(0, ...xs)), mean: Math.round(xs.reduce((a, b) => a + b, 0) / (xs.length || 1)) });

async function main() {
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { prisma: runtime } = await import("@/lib/prisma");
  const src = (await import("node:fs")).readFileSync("lib/services/billing/billing-issue.service.ts", "utf8");
  const keyInCode = src.includes("pg_advisory_xact_lock_shared");
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  await replayRepositoryRls(process.env.OWNER_URL!);

  let n = 0;
  const stamp = Date.now();
  async function business() {
    const taxId = withCheckDigit(String(35000000 + (++n)).slice(0, 8));
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `bench-${stamp}-${n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`, `bench-${stamp}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,'AUTHORIZED_DEALER','דנה כהן',$2,$2,'הרצל 1','0501234567','b@lab.invalid', now(), 'SIGNUP', now())`, businessId, taxId);
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), privateId: priv.id };
  }
  type Biz = Awaited<ReturnType<typeof business>>;
  const deps = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved", billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) } as never;
  const LINES = [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }];
  const draft = async (b: Biz) => (await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.TAX_INVOICE, customerId: b.privateId, initialLines: LINES })).id;
  const timed = async (b: Biz, id: number) => {
    const t = performance.now();
    try { await issueBillingDocument({ businessId: b.businessId, billingDocumentId: id, actorUserId: b.userId }, deps); return { ok: true, ms: performance.now() - t, err: "" }; }
    catch (e) { return { ok: false, ms: performance.now() - t, err: String((e as Error).message).replace(/\s+/g, " ").slice(0, 120) }; }
  };
  const contiguous = async (b: Biz) => {
    const nums = ((await owner.$queryRawUnsafe(`SELECT "documentNumber" n FROM "BillingDocument" WHERE "businessId"=$1 AND "documentType"='TAX_INVOICE' AND status='ISSUED' ORDER BY 1`, b.businessId)) as Rows).map((r) => Number(r.n));
    const seq = ((await owner.$queryRawUnsafe(`SELECT "nextNumber" x FROM "BillingDocumentNumberSequence" WHERE "businessId"=$1 AND "documentType"='TAX_INVOICE'`, b.businessId)) as Rows)[0]?.x;
    return { issued: nums.length, contiguous: nums.every((v, i) => v === i + 1), counterOk: nums.length === 0 ? true : Number(seq) === nums.length + 1 };
  };

  // Lock-wait sampler: advisory locks that are requested but not granted.
  let sampling = true;
  let samples = 0; let waitingSamples = 0; let maxWaiting = 0;
  const sampler = (async () => {
    while (sampling) {
      const r = (await owner.$queryRawUnsafe(`SELECT count(*)::int w FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)) as Rows;
      samples++; const w = Number(r[0].w); if (w > 0) waitingSamples++; if (w > maxWaiting) maxWaiting = w;
      await new Promise((res) => setTimeout(res, 10));
    }
  })();

  // B1
  const b1 = await business();
  const b1d: number[] = []; for (let i = 0; i < 30; i++) b1d.push(await draft(b1));
  const b1r = []; for (const id of b1d) b1r.push(await timed(b1, id));
  // B2
  const b2r: Array<{ ok: boolean; ms: number; err: string }> = []; const b2biz: Biz[] = [];
  for (let round = 0; round < 5; round++) {
    const b = await business(); b2biz.push(b);
    const ids: number[] = []; for (let i = 0; i < 8; i++) ids.push(await draft(b));
    b2r.push(...(await Promise.all(ids.map((id) => timed(b, id)))));
  }
  // B3
  const b3r: Array<{ ok: boolean; ms: number; err: string }> = [];
  for (let round = 0; round < 5; round++) {
    const bs: Biz[] = []; for (let i = 0; i < 8; i++) bs.push(await business());
    const ids: number[] = []; for (const b of bs) ids.push(await draft(b));
    b3r.push(...(await Promise.all(bs.map((b, i) => timed(b, ids[i])))));
  }
  sampling = false; await sampler;

  // LK: the key alone, 16 shared acquisitions at once (runtime connection, tenant-free key).
  const lk = await Promise.all(Array.from({ length: 16 }, () => runtime.$transaction(async (tx) => {
    const t = performance.now();
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtextextended('legal_identity:' || $1::int, 0))::text`, b1.businessId);
    return performance.now() - t;
  }, { maxWait: 30_000, timeout: 30_000 })));

  const cont = { b1: await contiguous(b1), b2: await Promise.all(b2biz.map(contiguous)) };
  const out = {
    mode: process.env.MODE, keyInCode,
    B1: { ...stats(b1r.map((r) => r.ms)), success: b1r.filter((r) => r.ok).length, contiguity: cont.b1 },
    B2: { ...stats(b2r.filter((r) => r.ok).map((r) => r.ms)), attempts: b2r.length, success: b2r.filter((r) => r.ok).length,
      failures: b2r.filter((r) => !r.ok).map((r) => r.err), contiguityAllRounds: cont.b2.every((c) => c.contiguous && c.counterOk), issuedPerRound: cont.b2.map((c) => c.issued) },
    B3: { ...stats(b3r.filter((r) => r.ok).map((r) => r.ms)), attempts: b3r.length, success: b3r.filter((r) => r.ok).length, failures: b3r.filter((r) => !r.ok).map((r) => r.err) },
    LW: { samples, samplesWithWaitingAdvisoryLock: waitingSamples, maxWaiting },
    LK: stats(lk),
  };
  console.log(JSON.stringify(out));
  if (process.env.OUT_JSON) writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
  await owner.$disconnect(); await runtime.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
