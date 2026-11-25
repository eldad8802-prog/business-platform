/**
 * Subscriptions stage C — CODE lab. Runs the REAL application code against PostgreSQL with migrations
 * 20261224090000_platform_subscriptions and 20261228090000_subscriptions_stage_c applied, connected as LOGIN roles that
 * are members of the real roles:
 *   DATABASE_URL → app_runtime · CONTROL_PLANE_DATABASE_URL → app_ctlplane · AUTH_DATABASE_URL → app_auth ·
 *   ADMIN_DATABASE_URL → app_admin.  LAB_OWNER_URL is used only to arrange time (move a trial's end) and read back.
 * Env for the run: USAGE_QUOTA_MODE=enforce, SUBSCRIPTION_ENFORCEMENT=enforce, SUBSCRIPTION_TRIALS_ENABLED=true,
 * TRIAL_CLAIM_HMAC_KEY (≥ 32 chars), SUBSCRIPTION_ADMIN_CHANGES_ENABLED=true, AUTH_PLANE_ENABLED=true — the lab proves
 * what ENFORCE does; nothing of it is a Production setting.
 *
 * Expects (code-lab-setup.sql): tester 930001 (backfilled), businesses 930020–930029 without a record, admin 930100
 * (PLATFORM_ADMIN), ordinary user 930101. Prints CODE_LAB_OK as its last line.
 *
 * Run: npx tsx .subscriptions-stage-c/code-lab.ts
 */
import { PrismaClient } from "@prisma/client";

import { authDb } from "@/lib/prisma-auth";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import {
  addQuotaAdjustment,
  loadBusinessUsageAdmin,
  loadQuotaMatrix,
  loadSubscriptionsOverview,
  previewQuotaChange,
  revokeQuotaAdjustment,
  setQuotaPolicy,
  setUsageMode,
} from "@/lib/services/platform-admin/subscriptions-admin.service";
import { updateBusinessSubscription } from "@/lib/services/platform-admin/update-business-subscription.service";
import { decidePlanGate, planGate } from "@/lib/services/subscriptions/plan-gate";
import { readSubscriptionRecord } from "@/lib/services/subscriptions/subscription-record";
import { openSignupSubscriptionInAccountTx, trialConfig } from "@/lib/services/subscriptions/trial/trial-claims";
import { reserveBusinessDocument } from "@/lib/services/subscriptions/usage/business-document-usage";
import { meteredOcr } from "@/lib/services/subscriptions/usage/metered-ocr";
import { checkUsageHeadroom, consumeUsage, QuotaExhaustedError, requireUsage, settleUsage } from "@/lib/services/subscriptions/usage/usage-meter";
import { loadSubscriptionView } from "@/lib/services/subscriptions/subscription-view.service";
import { MeteredStorageService } from "@/lib/storage/metered-storage";
import type { PutObjectInput, StorageService } from "@/lib/storage/types";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

const owner = new PrismaClient({ datasourceUrl: process.env.LAB_OWNER_URL });
const ADMIN = 930100;
const PLAIN_USER = 930101;
const TESTER = 930001;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
async function threw(p: Promise<unknown>, test: (e: unknown) => boolean = () => true): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return test(e);
  }
}
const used = async (b: number, metric: string) => {
  const rows = await owner.$queryRaw<{ used: bigint }[]>`
    SELECT k."used" FROM "BusinessUsageCounter" k CROSS JOIN LATERAL public.usage_quota_context(${b}::integer, ${metric}::text) c
     WHERE k."businessId" = ${b} AND k."metric" = ${metric} AND k."periodKey" = c.o_period_key`;
  return Number(rows[0]?.used ?? 0);
};
const signup = (b: number, identity: { taxId?: string; email?: string; googleSubject?: string; phone?: string }) =>
  authDb().$transaction((tx) => openSignupSubscriptionInAccountTx(tx, b, identity));
const adminChange = (b: number, request: Record<string, unknown>) =>
  updateBusinessSubscription({ actorUserId: ADMIN, businessId: b, request: { reason: "code lab: lifecycle step", plan: null, ...request } as never });
const enforceMetric = (metric: string) => setUsageMode(ADMIN, { metric, mode: "ENFORCE", reason: "code lab: enforce this metric" }).catch(() => undefined);

/** A storage service that only remembers keys — so the metered layer is proven without R2. */
class MemoryStorage implements StorageService {
  objects = new Map<string, number>();
  async putObject(input: PutObjectInput) {
    this.objects.set(input.key, input.body.length);
    return { key: input.key, metadata: { ...input.metadata, contentType: input.contentType, size: input.body.length, createdAt: new Date().toISOString() } };
  }
  async putObjectIfAbsent(input: PutObjectInput) {
    if (this.objects.has(input.key)) return { status: "EXISTS" as const, key: input.key };
    const r = await this.putObject(input);
    return { status: "CREATED" as const, ...r };
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async getObject(): Promise<never> { throw new Error("unused"); }
  async headObject(): Promise<never> { throw new Error("unused"); }
  async getMetadata(): Promise<never> { throw new Error("unused"); }
  async getSignedDownloadUrl(): Promise<string> { return ""; }
  getPublicUrl() { return null; }
  async listObjects() { return []; }
}
const put = (b: number, domain: "documents" | "billing", name: string, bytes: number) => ({
  key: `biz/${b}/${domain}/${name}`,
  body: Buffer.alloc(bytes),
  contentType: "application/pdf",
  metadata: { businessId: b, domain, visibility: "private" as const },
});

async function main() {
  ok("S0 trials are on for the lab", trialConfig() !== null);
  for (const m of ["business_documents", "document_uploads", "ocr_pages", "storage_customer_bytes", "accountant_packages", "accountant_emails", "ai_owner_actions", "video_renders"]) {
    await enforceMetric(m);
  }

  /* ── T. testers are never harmed ── */
  const t1 = await requireUsage({ businessId: TESTER, metric: "ocr_pages", unitKey: "t:big", amount: 999_999, source: "lab" });
  ok("T1 a tester far beyond every quota is counted, never refused", t1.allowed && t1.outcome === "COUNTED" && t1.quota === null);
  const tg = await planGate(TESTER, PLATFORM_FEATURE_KEYS.BILLING, "write", "lab");
  ok("T2 a tester's plan gate allows writes in enforce", tg.allowed && tg.access === "full");
  const tv = await loadSubscriptionView(TESTER);
  ok("T3 a tester has no subscription to manage and is told nothing", tv.visible === false && tv.attention.length === 0 && tv.status === null);
  ok("T4 a tester stays a tester (no code path changed the record)", (await readSubscriptionRecord(TESTER))?.accountType === "TESTER");

  /* ── L. lifecycle: signup trial, duplicate, phone hint, admin fix, usage, expiry, plan, renewal ── */
  const L1 = 930020, L2 = 930021, L3 = 930022, L4 = 930023;
  ok("L1 first signup opens a 30-day trial", (await signup(L1, { taxId: "514000001", email: "first@lab.invalid", phone: "0501234567" })) === "TRIAL_OPENED");
  const r1 = await readSubscriptionRecord(L1);
  ok("L1 record TRIALING with an end ~30 days ahead", r1?.status === "TRIALING" && !!r1.trialEndsAt && Math.abs(r1.trialEndsAt.getTime() - Date.now() - 30 * 86_400_000) < 120_000);
  ok("L2 same tax id (other format), other email ⇒ no trial", (await signup(L2, { taxId: "51-4000001", email: "other@lab.invalid" })) === "DUPLICATE_NO_TRIAL");
  ok("L2 record FREE_LIMITED without a trial", (await readSubscriptionRecord(L2))?.status === "FREE_LIMITED");
  ok("L3 a different identity opens its own trial", (await signup(L3, { taxId: "514000099", email: "third@lab.invalid" })) === "TRIAL_OPENED");
  await signup(930024, { taxId: "514000100", email: "first@gmail.com" });
  ok("L3 a '+tag' / dotted gmail alias is the same mailbox ⇒ no trial", (await signup(930025, { taxId: "514000101", email: "f.irst+x@gmail.com" })) === "DUPLICATE_NO_TRIAL");
  ok("L4 phone match alone is only a hint (trial opened)", (await signup(L4, { taxId: "514000002", email: "fourth@lab.invalid", phone: "+972-50-123-4567" })) === "TRIAL_OPENED_PHONE_HINT");
  ok("L5 the Google subject is a claim too", (await signup(930026, { taxId: "514000003", email: "g1@lab.invalid", googleSubject: "google-sub-1" })) === "TRIAL_OPENED"
    && (await signup(930027, { taxId: "514000004", email: "g2@lab.invalid", googleSubject: "google-sub-1" })) === "DUPLICATE_NO_TRIAL");
  // admin fixes a false positive: grants a trial to L2
  await adminChange(L2, { accountType: "CUSTOMER", status: "TRIALING", trialDays: 30 });
  ok("L6 the admin grants a trial (false positive fixed)", (await readSubscriptionRecord(L2))?.status === "TRIALING");

  // trial quota: business_documents 50 — atomic reservations
  for (let i = 0; i < 50; i++) {
    const u = await reserveBusinessDocument(L1, { kind: "billing", source: "lab", documentType: "TAX_INVOICE" });
    if (u.denied) break;
    await u.commit();
  }
  ok("L7 50 documents in the trial", (await used(L1, "business_documents")) === 50);
  const over = await reserveBusinessDocument(L1, { kind: "billing", source: "lab", documentType: "TAX_INVOICE" });
  ok("L7 the 51st new invoice is refused (403 QUOTA_EXHAUSTED)", over.denied?.status === 403);
  const receipt = await reserveBusinessDocument(L1, { kind: "billing", source: "lab", documentType: "RECEIPT" });
  ok("L8 a receipt beyond the quota is counted but NOT refused (pending the accountant)", receipt.denied === null);
  await receipt.commit();
  ok("L8 …and it IS counted against the same quota (no blanket bypass)", (await used(L1, "business_documents")) === 51);
  const failed = await reserveBusinessDocument(L4, { kind: "billing", source: "lab", documentType: "TAX_INVOICE" });
  await failed.release();
  ok("L9 a failed creation gives its unit back", (await used(L4, "business_documents")) === 0);

  // trial ends → FREE_LIMITED immediately (before the recorder), rights floor open
  await owner.$executeRaw`UPDATE "PlatformSubscription" SET "trialStartedAt" = (now() AT TIME ZONE 'UTC') - interval '31 days', "trialEndsAt" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE "businessId" = ${L1}`;
  const limited = await readSubscriptionRecord(L1);
  const g = (action: "read" | "rights_floor" | "legal" | "existing" | "write", key = PLATFORM_FEATURE_KEYS.BILLING) => decidePlanGate(key, action, limited, "enforce");
  ok("L10 an ended trial is limited at once: new billing work refused", !g("write").allowed && g("write").reasonCode === "FREE_LIMITED");
  ok("L10 …viewing, downloading/exporting and legal actions stay open", g("read").allowed && g("rights_floor").allowed && g("legal").allowed);
  ok("L10 …finishing an existing draft stays open (limited module)", g("existing").allowed);
  ok("L11 FREE_LIMITED: no new upload, OCR, AI, email", !(await consumeUsage({ businessId: L1, metric: "document_uploads", unitKey: "lim:1", source: "lab" })).allowed
    && !(await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "lim:2", source: "lab" })).allowed
    && !(await consumeUsage({ businessId: L1, metric: "ai_owner_actions", unitKey: "lim:3", source: "lab" })).allowed
    && !(await consumeUsage({ businessId: L1, metric: "accountant_emails", unitKey: "lim:4", source: "lab" })).allowed);
  ok("L11 FREE_LIMITED: one accountant package a month", (await consumeUsage({ businessId: L1, metric: "accountant_packages", unitKey: "lim:p1", source: "lab" })).allowed
    && !(await consumeUsage({ businessId: L1, metric: "accountant_packages", unitKey: "lim:p2", source: "lab" })).allowed);
  ok("L11 FREE_LIMITED: no NEW storage", !(await consumeUsage({ businessId: L1, metric: "storage_customer_bytes", unitKey: "lim:s", amount: 1, source: "lab" })).allowed);
  const expired = await owner.$queryRaw<{ n: number }[]>`SELECT public.subscription_expire_due_trials(50) AS n`;
  ok("L12 the daily recorder writes TRIALING → FREE_LIMITED", Number(expired[0]?.n) >= 1 && (await readSubscriptionRecord(L1))?.status === "FREE_LIMITED");

  // the admin assigns BASIC → BASIC quotas; a new paid period renews them
  await adminChange(L1, { accountType: "CUSTOMER", status: "ACTIVE", plan: "BASIC" });
  ok("L13 manual plan assignment: BASIC", (await readSubscriptionRecord(L1))?.plan === "BASIC");
  const basic = await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "basic:1", source: "lab" });
  ok("L13 BASIC quota applies (300 OCR pages)", basic.allowed && basic.quota === 300);
  await owner.$executeRaw`UPDATE "PlatformSubscription" SET "currentPeriodStart" = (now() AT TIME ZONE 'UTC') - interval '1 day', "currentPeriodEnd" = (now() AT TIME ZONE 'UTC') + interval '29 days' WHERE "businessId" = ${L1}`;
  const renewed = await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "basic:2", source: "lab" });
  ok("L14 a new period starts a fresh counter (renewal)", renewed.used === 1 && renewed.periodKey?.startsWith("p:") === true);
  await adminChange(L1, { accountType: "CUSTOMER", status: "ACTIVE", plan: "ADVANCED" });
  const adv = await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "adv:1", source: "lab" });
  ok("L15 plan change: ADVANCED quota at once (1000)", adv.quota === 1000);
  ok("L16 Premium cannot be assigned while closed", await threw(adminChange(L1, { accountType: "CUSTOMER", status: "ACTIVE", plan: "PREMIUM" })));

  /* ── Q. quota changes from the admin, adjustments, preview, audit ── */
  const before = await owner.platformAuditEvent.count();
  await setQuotaPolicy(ADMIN, { metric: "ocr_pages", tier: "ADVANCED", quota: 1200, reason: "code lab: raise Advanced OCR" });
  ok("Q1 a policy change applies without a deploy", (await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "adv:2", source: "lab" })).quota === 1200);
  const prev = await previewQuotaChange("ocr_pages", "ADVANCED", 1);
  ok("Q2 the preview counts customers above a proposed quota", prev.businessesAbove >= 1 && prev.businessesInTier >= 1);
  const adj = await addQuotaAdjustment(ADMIN, L1, { metric: "ocr_pages", kind: "ADD", amount: 100, reason: "code lab: goodwill pages" });
  ok("Q3 an ADD adjustment raises this business's quota", (await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "adv:3", source: "lab" })).quota === 1300);
  await revokeQuotaAdjustment(ADMIN, adj.adjustmentId, { reason: "code lab: goodwill over" });
  ok("Q3 revoked ⇒ back to the plan", (await consumeUsage({ businessId: L1, metric: "ocr_pages", unitKey: "adv:4", source: "lab" })).quota === 1200);
  ok("Q4 every admin write left an audit row", (await owner.platformAuditEvent.count()) - before >= 3);
  ok("Q5 an ordinary user cannot write a policy (checked in the database)", await threw(setQuotaPolicy(PLAIN_USER, { metric: "ocr_pages", tier: "BASIC", quota: 5, reason: "code lab: not an admin" })));
  ok("Q6 a quota above the safety ceiling is refused", await threw(setQuotaPolicy(ADMIN, { metric: "ocr_pages", tier: "BASIC", quota: 5_000_000, reason: "code lab: typing slip" })));
  const matrix = await loadQuotaMatrix();
  ok("Q7 the matrix shows 8 metrics with opening values", matrix.metrics.length === 8 && matrix.metrics.every((m) => m.quotas.BASIC.opening >= 0));
  const admView = await loadBusinessUsageAdmin(L1);
  ok("Q8 the business view shows usage, history and units (ids/amounts only)", admView.metrics.length > 0 && admView.recentUnits.length > 0 && admView.recentUnits.every((u) => !("ocrText" in u)));
  const overview = await loadSubscriptionsOverview();
  ok("Q9 the overview flags unusual usage (≥80% or over in shadow)", overview.unusual.some((r) => r.businessId === L1) || overview.rows.length > 0);

  /* ── A. atomicity: concurrency, inside a transaction, double count ── */
  const RACE = 930028;
  await adminChange(RACE, { accountType: "CUSTOMER", status: "ACTIVE", plan: "BASIC" });
  const racers = await Promise.all(Array.from({ length: 25 }, (_, i) => consumeUsage({ businessId: RACE, metric: "accountant_emails", unitKey: `race:${i}`, source: "lab" })));
  ok("A1 25 parallel requests for a quota of 5: exactly 5 pass", racers.filter((d) => d.allowed).length === 5 && (await used(RACE, "accountant_emails")) === 5);
  const retries = await Promise.all(Array.from({ length: 10 }, () => consumeUsage({ businessId: RACE, metric: "document_uploads", unitKey: "same-file", source: "lab" })));
  ok("A2 10 parallel retries of one unit count it once", retries.filter((d) => d.outcome === "COUNTED").length === 1 && (await used(RACE, "document_uploads")) === 1);
  // inside an open tenant transaction: the meter runs IN it — refused before the write, rolled back with it
  await setQuotaPolicy(ADMIN, { metric: "ai_owner_actions", tier: "BASIC", quota: 1, reason: "code lab: one AI action" });
  const inTx = await runWithTenantContext({ businessId: RACE }, () =>
    withTenantTransaction(async () => {
      const a = await consumeUsage({ businessId: RACE, metric: "ai_owner_actions", unitKey: "tx:1", source: "lab" });
      const b = await consumeUsage({ businessId: RACE, metric: "ai_owner_actions", unitKey: "tx:2", source: "lab" });
      return { a, b };
    }),
  );
  ok("A3 inside a transaction the quota is enforced at once (not after the fact)", inTx.a.allowed && !inTx.b.allowed);
  await threw(
    runWithTenantContext({ businessId: RACE }, () =>
      withTenantTransaction(async () => {
        await consumeUsage({ businessId: RACE, metric: "video_renders", unitKey: "tx:rollback", source: "lab", neverRefuse: true });
        throw new Error("caller fails after counting");
      }),
    ),
  );
  ok("A4 a caller that rolls back rolls its count back too", (await used(RACE, "video_renders")) === 0);
  const ocrRuns: number[] = [];
  const o1 = await meteredOcr({ businessId: RACE, unitKey: "ocr:doc:1", source: "lab", buffer: Buffer.from("x"), mimeType: "image/png" }, async (call) => { await call(); await call(); ocrRuns.push(1); return "text"; });
  const o2 = await meteredOcr({ businessId: RACE, unitKey: "ocr:doc:1", source: "lab", buffer: Buffer.from("x"), mimeType: "image/png" }, async (call) => { await call(); ocrRuns.push(2); return "text"; });
  ok("A5 OCR: a retry of the same pass is not charged twice to the customer", o1.ok && o2.ok && (await used(RACE, "ocr_pages")) === 1);
  ok("A5 …but every provider call is measured (3 calls)", (await used(RACE, "ocr_provider_units")) === 3);
  const o3 = await meteredOcr({ businessId: RACE, unitKey: "ocr:doc:2", source: "lab", buffer: Buffer.from("x"), mimeType: "image/png" }, async () => { throw new Error("timeout"); }).catch(() => null);
  ok("A6 OCR failed with an unknown outcome ⇒ kept counted (UNKNOWN)", o3 === null && (await used(RACE, "ocr_pages")) === 2);

  /* ── B. no bypass across sources / storage ── */
  const viaUpload = await consumeUsage({ businessId: RACE, metric: "document_uploads", unitKey: "doc:hash-A", source: "documents.ingest.file" });
  const viaGmail = await consumeUsage({ businessId: RACE, metric: "document_uploads", unitKey: "doc:hash-A", source: "gmail.import" });
  const viaWa = await consumeUsage({ businessId: RACE, metric: "document_uploads", unitKey: "doc:hash-B", source: "whatsapp.intake" });
  ok("B1 the same file through another source is the same unit; a new file through any source counts", viaUpload.outcome === "COUNTED" && viaGmail.outcome === "DUPLICATE" && viaWa.outcome === "COUNTED");
  const mem = new MemoryStorage();
  const storage = new MeteredStorageService(mem);
  await setQuotaPolicy(ADMIN, { metric: "storage_customer_bytes", tier: "BASIC", quota: 1000, reason: "code lab: 1000 bytes" });
  await storage.putObject(put(RACE, "documents", "a.pdf", 600));
  ok("B2 a customer upload is counted in storage", (await used(RACE, "storage_customer_bytes")) === 600);
  ok("B3 an upload past the storage quota is refused before it is written", (await threw(storage.putObject(put(RACE, "documents", "b.pdf", 600)), (e) => e instanceof QuotaExhaustedError)) && !mem.objects.has(`biz/${RACE}/documents/b.pdf`));
  await storage.putObject(put(RACE, "billing", "invoice.pdf", 5000));
  ok("B4 a system file (issued tax document) is never refused and measured apart", mem.objects.has(`biz/${RACE}/billing/invoice.pdf`) && (await used(RACE, "storage_system_bytes")) === 5000);
  await storage.deleteObject(`biz/${RACE}/documents/a.pdf`);
  ok("B5 deleting a file gives its bytes back", (await used(RACE, "storage_customer_bytes")) === 0);
  const inTxStorage = await threw(
    runWithTenantContext({ businessId: RACE }, () => withTenantTransaction(() => storage.putObject(put(RACE, "documents", "c.pdf", 1001)))),
    (e) => e instanceof QuotaExhaustedError,
  );
  ok("B6 inside a transaction (CRM attachments) storage is still refused atomically", inTxStorage && !mem.objects.has(`biz/${RACE}/documents/c.pdf`));

  /* ── I. isolation ── */
  const other = await settleUsage({ businessId: TESTER, metric: "accountant_emails", unitKey: "race:0", state: "RELEASED" });
  ok("I1 a business cannot release another business's unit", other === "NOOP" && (await used(RACE, "accountant_emails")) === 5);
  const rtRows = await runWithTenantContext({ businessId: TESTER }, () => withTenantTransaction((tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "BusinessUsageEvent" WHERE "businessId" <> ${TESTER}`));
  ok("I2 the runtime sees only its own usage rows", Number(rtRows[0]?.n) === 0);
  const head = await checkUsageHeadroom({ businessId: RACE, metric: "accountant_emails", amount: 1 });
  ok("I3 headroom check: refused at the quota", !head.allowed);

  /* ── V. the owner's subscription view (owner decision 2026-11-25: no counters, attention only) ── */
  const view = await loadSubscriptionView(RACE);
  const json = JSON.stringify(view);
  ok("V1 the owner view carries no counter (no used / remaining / percent)", !/"used"|"remaining"|"percent"/.test(json), json.slice(0, 300));
  ok("V2 an ENFORCED quota used up is an attention item, without numbers", view.attention.some((a) => a.kind === "quota_reached" && a.metric === "accountant_emails"));
  ok("V3 the plan terms come from the live policy (Basic: 5 accountant emails), Premium not open", view.plans.find((p) => p.plan === "BASIC")?.terms.some((t) => t.metric === "accountant_emails" && t.quota === 5) === true && view.plans.find((p) => p.plan === "PREMIUM")?.open === false);
  ok("V4 the rights-floor line is always shown", view.rightsFloor.length > 10);

  /* ── N. alerts once ── */
  const notes = await owner.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Notification" WHERE "businessId" = ${RACE} AND "semanticCategory" = 'subscription.usage'`;
  ok("N1 an ENFORCED quota nearly / fully used notified the owner (once per threshold, 90 and 100 only)", Number(notes[0]?.n) >= 1 && Number(notes[0]?.n) <= 2 * 8, String(notes[0]?.n));

  console.log(`code lab: ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`FAIL ${f}`);
  await owner.$disconnect();
  if (failures.length) process.exit(1);
  console.log("CODE_LAB_OK");
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect();
  process.exit(1);
});
