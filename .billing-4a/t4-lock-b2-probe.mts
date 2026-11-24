/**
 * 4a T4 — focused probe of the parallel case (8 tax invoices of ONE business at once, they serialize on the counter row),
 * with and without the shared transition key (the runner swaps billing-issue.service.ts). Samples every 15 ms:
 *   - the runtime's backends (pg_stat_activity, usename app_runtime_prod): state + wait_event_type/wait_event;
 *   - waiting locks (pg_locks NOT granted): locktype, and for advisory locks whether it is the legal_identity key.
 * No timeout or issuance setting is changed.
 *   MODE=<label> ROUNDS=10 OWNER_URL=… DATABASE_URL=… OUT_JSON=<file> npx tsx .billing-4a/t4-lock-b2-probe.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
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
async function main() {
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { prisma: runtime } = await import("@/lib/prisma");
  const keyInCode = readFileSync("lib/services/billing/billing-issue.service.ts", "utf8").includes("pg_advisory_xact_lock_shared");
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  await replayRepositoryRls(process.env.OWNER_URL!);
  let n = 0;
  async function business() {
    const taxId = withCheckDigit(String(38000000 + (++n)).slice(0, 8));
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `b2p-${Date.now()}-${n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`, `b2p-${Date.now()}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,'AUTHORIZED_DEALER','דנה כהן',$2,$2,'הרצל 1','0501234567','b@lab.invalid', now(), 'SIGNUP', now())`, businessId, taxId);
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), privateId: priv.id };
  }
  const deps = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved", billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) } as never;
  const LINES = [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }];

  let sampling = true;
  const waits: Record<string, number> = {};
  const lockWaits: Record<string, number> = {};
  let maxBackends = 0, maxActive = 0, maxIdleInTx = 0, samples = 0;
  const sampler = (async () => {
    while (sampling) {
      const a = (await owner.$queryRawUnsafe(`SELECT state, coalesce(wait_event_type,'-') wt, coalesce(wait_event,'-') we FROM pg_stat_activity WHERE usename = 'app_runtime_prod'`)) as Rows;
      samples++;
      maxBackends = Math.max(maxBackends, a.length);
      maxActive = Math.max(maxActive, a.filter((r) => r.state === "active").length);
      maxIdleInTx = Math.max(maxIdleInTx, a.filter((r) => r.state === "idle in transaction").length);
      for (const r of a) if (r.state === "active" && r.wt !== "-" && r.wt !== "Client") { const k = `${r.wt}/${r.we}`; waits[k] = (waits[k] ?? 0) + 1; }
      const l = (await owner.$queryRawUnsafe(`SELECT locktype, mode FROM pg_locks WHERE NOT granted`)) as Rows;
      for (const r of l) { const k = `${r.locktype}/${r.mode}`; lockWaits[k] = (lockWaits[k] ?? 0) + 1; }
      await new Promise((res) => setTimeout(res, 15));
    }
  })();
  const rounds: Array<{ ok: number; fail: number; ms: number[]; errs: string[] }> = [];
  for (let r = 0; r < Number(process.env.ROUNDS ?? 10); r++) {
    const b = await business();
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push((await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.TAX_INVOICE, customerId: b.privateId, initialLines: LINES })).id);
    const res = await Promise.all(ids.map(async (id) => {
      const t = performance.now();
      try { await issueBillingDocument({ businessId: b.businessId, billingDocumentId: id, actorUserId: b.userId }, deps); return { ok: true, ms: performance.now() - t, err: "" }; }
      catch (e) { return { ok: false, ms: performance.now() - t, err: String((e as Error).message).replace(/\s+/g, " ").slice(0, 100) }; }
    }));
    rounds.push({ ok: res.filter((x) => x.ok).length, fail: res.filter((x) => !x.ok).length, ms: res.map((x) => Math.round(x.ms)), errs: [...new Set(res.filter((x) => !x.ok).map((x) => x.err))] });
  }
  sampling = false; await sampler;
  const out = { mode: process.env.MODE, keyInCode, rounds: rounds.map((x) => `${x.ok}/8 max${Math.max(...x.ms)}ms`), errors: [...new Set(rounds.flatMap((x) => x.errs))],
    totalOk: rounds.reduce((s, x) => s + x.ok, 0), totalAttempts: rounds.length * 8, samples, maxBackends, maxActive, maxIdleInTx, waits, lockWaits };
  console.log(JSON.stringify(out));
  if (process.env.OUT_JSON) writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
  await owner.$disconnect(); await runtime.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
