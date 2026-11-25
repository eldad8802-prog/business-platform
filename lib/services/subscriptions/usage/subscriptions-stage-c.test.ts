/**
 * Subscriptions stage C — pure and static checks (no database). Run: npx tsx lib/services/subscriptions/usage/subscriptions-stage-c.test.ts
 *
 * 1. The code's opening matrix equals the migration's seed and its evidence, cell for cell (owner decision 2026-11-24).
 * 2. Metric contract: *_bytes ⇔ cumulative; every quota metric has a row for every tier; measured metrics have none.
 * 3. Modes: the LOWER of server ceiling and metric mode; a measured metric is never enforced; unknown ⇒ shadow.
 * 4. The plan gate matrix: testers / no record always allowed; FREE_LIMITED keeps read / rights floor / legal open;
 *    enforce refuses only what shadow logs; the route overrides keep accountant-pending and legal routes open.
 * 5. Trial claims: normalisation (tax id formats, gmail aliases, Israeli phone forms), keyed digests, switch.
 * 6. Wiring, read from the source: no Vision call outside the metered wrapper; every intake source counts uploads
 *    with the same unit; storage is metered at the factory; receipts are never refused but counted; credit notes and
 *    the payment-settlement receipt never call the meter; internal AI is measured AND rate-limited; the legacy video
 *    counter is no longer called; the trial opens only in the auth-plane signup and only behind its switch.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { decidePlanGate, planActionForRequest, planActionAllowed } from "@/lib/services/subscriptions/plan-gate";
import type { SubscriptionSnapshot } from "@/lib/services/subscriptions/subscription.types";
import { normalizeTrialValue, trialClaimDigest, trialClaimsFor, trialConfig } from "@/lib/services/subscriptions/trial/trial-claims";
import { RECEIPT_LIKE_TYPES } from "./business-document-usage";
import { MEASURED_METRICS, METRIC_DEFINITIONS, OPENING_MATRIX, QUOTA_METRICS, SUBSCRIPTION_TIERS } from "./usage-metrics";
import { effectiveUsageMode, usageModeCeiling } from "./usage-mode";
import { thresholdReached } from "./usage-meter";
import { attentionFor } from "../subscription-view.service";
import { estimateUsageCostUsd } from "./usage-cost";

let pass = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass += 1;
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, detail ?? "");
  }
}
const read = (p: string) => readFileSync(p, "utf8");

/* 1. matrix = migration seed = evidence */
const migration = read("prisma/migrations/20261228090000_subscriptions_stage_c/migration.sql");
const evidence = read("ops/evidence/subscriptions-stage-c-production-evidence.sql");
const seedRe = /\('([a-z_]+)',\s*'(TRIAL|BASIC|ADVANCED|PREMIUM|FREE_LIMITED)',\s*(\d+)\)/g;
function cells(sql: string, from: string): Map<string, number> {
  const out = new Map<string, number>();
  const section = sql.slice(sql.indexOf(from));
  for (const m of section.matchAll(seedRe)) if (!out.has(`${m[1]}:${m[2]}`)) out.set(`${m[1]}:${m[2]}`, Number(m[3]));
  return out;
}
const seeded = cells(migration, 'INSERT INTO "PlatformQuotaPolicy"');
const wanted = cells(evidence, "want(metric, tier, quota)");
ok("1 migration seeds 40 cells", seeded.size === 40, seeded.size);
ok("1 evidence expects 40 cells", wanted.size === 40, wanted.size);
for (const metric of QUOTA_METRICS) {
  for (const tier of SUBSCRIPTION_TIERS) {
    const k = `${metric}:${tier}`;
    ok(`1 ${k}: code = migration = evidence`, OPENING_MATRIX[metric][tier] === seeded.get(k) && seeded.get(k) === wanted.get(k), [OPENING_MATRIX[metric][tier], seeded.get(k), wanted.get(k)]);
  }
}
ok("1 owner FREE_LIMITED: 0 everywhere except one accountant package", QUOTA_METRICS.every((m) => OPENING_MATRIX[m].FREE_LIMITED === (m === "accountant_packages" ? 1 : 0)));
ok("1 video 0 on every tier (decision 23)", SUBSCRIPTION_TIERS.every((t) => OPENING_MATRIX.video_renders[t] === 0));
ok("1 owner AI: Premium only", OPENING_MATRIX.ai_owner_actions.PREMIUM === 300 && ["TRIAL", "BASIC", "ADVANCED"].every((t) => OPENING_MATRIX.ai_owner_actions[t as "TRIAL"] === 0));
ok("1 every quota metric is seeded SHADOW", QUOTA_METRICS.every((m) => new RegExp(`\\('${m}', 'SHADOW'\\)`).test(migration)));

/* 2. metric contract */
for (const def of Object.values(METRIC_DEFINITIONS)) ok(`2 ${def.metric}: _bytes ⇔ cumulative`, def.metric.endsWith("_bytes") === def.cumulative);
ok("2 measured metrics have no policy row", MEASURED_METRICS.every((m) => !seeded.has(`${m}:BASIC`)));

/* 3. modes */
ok("3 default ceiling is SHADOW", usageModeCeiling({}) === "SHADOW" && usageModeCeiling({ USAGE_QUOTA_MODE: "yes" }) === "SHADOW");
ok("3 ceiling enforce/off only on the exact words", usageModeCeiling({ USAGE_QUOTA_MODE: "enforce" }) === "ENFORCE" && usageModeCeiling({ USAGE_QUOTA_MODE: " OFF " }) === "OFF");
ok("3 the database alone cannot enforce (ceiling shadow)", effectiveUsageMode("ocr_pages", "ENFORCE", "SHADOW") === "SHADOW");
ok("3 the env alone cannot enforce (metric shadow)", effectiveUsageMode("ocr_pages", "SHADOW", "ENFORCE") === "SHADOW");
ok("3 both ⇒ enforce", effectiveUsageMode("ocr_pages", "ENFORCE", "ENFORCE") === "ENFORCE");
ok("3 a measured metric is never enforced", effectiveUsageMode("ai_internal_calls", "ENFORCE", "ENFORCE") === "SHADOW");
ok("3 a missing metric mode reads as shadow", effectiveUsageMode("ocr_pages", null, "ENFORCE") === "SHADOW");
ok("3 thresholds", thresholdReached(79, 100) === 0 && thresholdReached(80, 100) === 80 && thresholdReached(95, 100) === 90 && thresholdReached(100, 100) === 100 && thresholdReached(5, null) === 0);
ok("3 cost estimate excludes customer OCR (provider units are the bill)", estimateUsageCostUsd({ ocr_pages: 1000 }) === 0 && estimateUsageCostUsd({ ocr_provider_units: 1000 }) > 0);

/* 4. plan gate */
const snap = (s: Partial<SubscriptionSnapshot>): SubscriptionSnapshot => ({ accountType: "CUSTOMER", status: "ACTIVE", plan: "BASIC", catalogVersion: "2026-11-20", ...s });
const actions = ["read", "rights_floor", "legal", "existing", "write"] as const;
for (const key of Object.values(PLATFORM_FEATURE_KEYS)) {
  for (const a of actions) {
    ok(`4 tester ${key} ${a}`, decidePlanGate(key, a, snap({ accountType: "TESTER", status: "EXEMPT", plan: null }), "enforce").allowed);
    ok(`4 no record ${key} ${a}`, decidePlanGate(key, a, null, "enforce").allowed);
    const lim = decidePlanGate(key, a, snap({ status: "FREE_LIMITED", plan: null }), "enforce");
    if (a === "read" || a === "rights_floor" || a === "legal") ok(`4 FREE_LIMITED ${key} ${a} stays open`, lim.allowed);
    ok(`4 shadow never refuses ${key} ${a}`, decidePlanGate(key, a, snap({ status: "FREE_LIMITED", plan: null }), "shadow").allowed);
  }
}
const ended = snap({ status: "TRIALING", plan: null, trialEndsAt: new Date(Date.now() - 1000) });
ok("4 an ended trial is limited at once", !decidePlanGate(PLATFORM_FEATURE_KEYS.BILLING, "write", ended, "enforce").allowed);
ok("4 a running trial is full", decidePlanGate(PLATFORM_FEATURE_KEYS.BILLING, "write", snap({ status: "TRIALING", plan: null, trialEndsAt: new Date(Date.now() + 86_400_000) }), "enforce").allowed);
ok("4 action depth", planActionAllowed("limited", "existing") && !planActionAllowed("limited", "write") && !planActionAllowed("none", "existing") && planActionAllowed("none", "rights_floor"));
ok("4 issuing / crediting is legal", planActionForRequest("POST", "/api/billing/documents/12/issue") === "legal" && planActionForRequest("POST", "/api/billing/documents/12/credit-note") === "legal");
ok("4 editing an existing draft stays open (decision 11)", planActionForRequest("PUT", "/api/billing/documents/12/lines") === "existing");
ok("4 exports are the rights floor", planActionForRequest("POST", "/api/reports/export-zip") === "rights_floor" && planActionForRequest("GET", "/api/reports/uniform") === "rights_floor");
ok("4 cancelling a booked appointment is 'existing' (decision 6)", planActionForRequest("POST", "/api/appointments/7/status") === "existing");
ok("4 booking a NEW appointment is a write", planActionForRequest("POST", "/api/appointments") === "write" && planActionForRequest("POST", "/api/appointments/booking") === "write");

/* 5. trial claims */
ok("5 tax id formats", normalizeTrialValue("TAX_ID", "51-4000001") === "514000001" && normalizeTrialValue("TAX_ID", "12345") === "000012345");
ok("5 gmail aliases are one mailbox", normalizeTrialValue("EMAIL", "F.i.r.s.t+x@Gmail.com") === "first@gmail.com" && normalizeTrialValue("EMAIL", "a+b@corp.co.il") === "a@corp.co.il");
ok("5 phone forms", normalizeTrialValue("PHONE", "+972-50-123-4567") === normalizeTrialValue("PHONE", "050-1234567"));
const key = "k".repeat(40);
ok("5 digests are keyed and stable", trialClaimDigest(key, "TAX_ID", "514000001") === trialClaimDigest(key, "TAX_ID", "514000001") && trialClaimDigest(key, "TAX_ID", "514000001") !== trialClaimDigest("x".repeat(40), "TAX_ID", "514000001"));
ok("5 no identity value is in a claim", trialClaimsFor({ taxId: "514000001", email: "a@b.c" }, key).every((c) => /^[0-9a-f]{64}$/.test(c.digest) && !c.digest.includes("514000001")));
ok("5 trials OFF unless the exact switch and a long key", trialConfig({}) === null && trialConfig({ SUBSCRIPTION_TRIALS_ENABLED: "true", TRIAL_CLAIM_HMAC_KEY: "short" }) === null && trialConfig({ SUBSCRIPTION_TRIALS_ENABLED: "true", TRIAL_CLAIM_HMAC_KEY: key }) !== null);

/* 6. wiring */
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}
const src = [...files("app"), ...files("lib")];
const visionCallers = src.filter((p) => /runGoogleVisionOCR(WithGeometry)?\(/.test(read(p)) && !p.endsWith("google-vision-ocr.service.ts"));
ok("6 every Vision call site goes through meteredOcr", visionCallers.every((p) => /meteredOcr\(/.test(read(p)) || /deps\.runOcr|runOcr: runGoogleVisionOCR/.test(read(p))), visionCallers);
ok("6 the WhatsApp OCR dependency is called only inside meteredOcr", /meteredOcr\([\s\S]*deps\.runOcr\(/.test(read("lib/services/integrations/whatsapp/documents-intake.service.ts")));
for (const p of ["lib/services/documents/document-ingestion.service.ts", "app/api/integrations/gmail/import/route.ts", "lib/services/integrations/whatsapp/documents-intake.service.ts"]) {
  ok(`6 ${p} counts document_uploads with the shared unit doc:<hash>`, /metric: "document_uploads"/.test(read(p)) && /doc:\$\{contentHashSha256\}/.test(read(p)));
}
ok("6 storage is metered at the factory (one choke point)", /new MeteredStorageService\(/.test(read("lib/storage/storage.factory.ts")));
ok("6 receipts are counted but never refused", RECEIPT_LIKE_TYPES.includes("RECEIPT") && RECEIPT_LIKE_TYPES.includes("TAX_INVOICE_RECEIPT") && /neverRefuse/.test(read("lib/services/subscriptions/usage/business-document-usage.ts")));
ok("6 a tax invoice is not receipt-like (it can be refused)", !RECEIPT_LIKE_TYPES.includes("TAX_INVOICE") && !RECEIPT_LIKE_TYPES.includes("QUOTE"));
ok("6 credit notes never call the meter", !/usage-meter|business-document-usage/.test(read("app/api/billing/documents/[id]/credit-note/route.ts")));
const settlement = src.filter((p) => /payment-accounting-settlement/.test(p));
ok("6 the settlement receipt never calls the meter", settlement.length > 0 && settlement.every((p) => !/usage-meter|business-document-usage/.test(read(p))), settlement);
ok("6 new drafts / conversions / letters / PO sheets reserve before they create", ["app/api/billing/documents/route.ts", "app/api/billing/documents/[id]/convert-to-invoice/route.ts", "app/api/business-documents/letters/route.ts", "app/api/business-documents/supplier-orders/[id]/sheets/route.ts"].every((p) => /reserveBusinessDocument\(/.test(read(p))));
ok("6 issuing is never metered", !/usage-meter|business-document-usage/.test(read("app/api/billing/documents/[id]/issue/route.ts")));
ok("6 owner AI (content) is ai_owner_actions", /metric: "ai_owner_actions"/.test(read("app/api/content/generate/route.ts")));
for (const p of ["app/api/business/landing-blueprint/route.ts", "app/api/business/landing/versions/route.ts"]) {
  ok(`6 internal AI ${p}: measured AND rate-limited (LANDING_COMPOSE)`, /measuredInternalAi\(/.test(read(p)) && /bucket: "LANDING_COMPOSE"/.test(read(p)));
}
ok("6 the knowledge Brain: measured, secret-gated, cooldown", /measuredInternalAi\(/.test(read("app/api/knowledge/derive/route.ts")) && /KNOWLEDGE_DERIVE_SECRET/.test(read("app/api/knowledge/derive/route.ts")));
// The bot-draft LLM IS reachable (inbound message pipeline → runner). It is protected by its flag (default off), the
// sample rate and a fail-closed daily cap (default 0 = no call), and every model call is measured as internal AI.
const llmDraftImporters = src.filter((p) => !/[\\/]llm-draft[\\/]/.test(p) && /conversation\/llm-draft"/.test(read(p)));
ok("6 the bot-draft LLM is reached only through its runner", llmDraftImporters.length === 1 && /bot-llm-draft-runner\.service\.ts$/.test(llmDraftImporters[0]), llmDraftImporters);
const runner = read("lib/services/conversation/bot-llm-draft-runner.service.ts");
ok("6 the bot-draft LLM calls are measured as internal AI", /measuredInternalAi\(\{ complete: deps\.complete \}, input\.businessId, "bot_llm_draft"\)/.test(runner));
ok("6 the bot-draft LLM keeps its fail-closed daily cap (default 0 = no call)", /deps\.getDailyUsage\(\) >= dailyCap/.test(runner) && /if \(raw == null \|\| raw\.trim\(\) === ""\) return 0;/.test(read("lib/features/conversation/llm-draft/flags.ts")));
ok("6 the legacy weekly video counter is no longer called (decision 29)", !/usage\.service/.test(read("app/api/content/render/route.ts")) && /metric: "video_renders"/.test(read("app/api/content/render/route.ts")));
const signup = read("lib/auth/signup.ts");
ok("6 the trial opens in both signup paths, inside the account transaction", (signup.match(/openSignupSubscriptionInAccountTx\(tx,/g) ?? []).length === 2);
ok("6 the email signup opens a trial only on the auth plane", /if \(isAuthPlaneActive\(\)\) await openSignupSubscriptionInAccountTx/.test(signup));
ok("6 the signup form is untouched (no new field read)", !/trial|subscription/i.test(read("app/register/register-form.tsx")));
ok("6 the meter never opens a second transaction inside an open one", /currentTenantTransaction\(\)/.test(read("lib/services/subscriptions/usage/usage-meter.ts")) && /SAVEPOINT/.test(read("lib/services/subscriptions/usage/usage-meter.ts")));
ok("6 admin writes: fresh second factor → kill switch, after the route's admin guard", /freshStepUpRefusal[\s\S]*isSubscriptionAdminChangesEnabled/.test(read("lib/services/platform-admin/subscriptions-admin-http.ts")));
const adminRoutes = src.filter((p) => /app[\\/]api[\\/]platform-admin[\\/](subscriptions|businesses[\\/]\[id\][\\/]usage)[\\/]/.test(p));
ok("6 every subscriptions admin handler awaits the platform-admin guard first", adminRoutes.length === 8 && adminRoutes.every((p) => {
  const handlers = read(p).split(/export async function (?:GET|POST|PATCH)\(/).slice(1);
  return handlers.length > 0 && handlers.every((h) => /^[^\n]*\)\s*\{\n\s*const auth = await requirePlatformAdminOrResponse\(req\);\s*if \(auth instanceof NextResponse\) return auth;/.test(h));
}), adminRoutes);
ok("6 the admin service writes only through definer functions", !/INSERT INTO|UPDATE "|DELETE FROM/.test(read("lib/services/platform-admin/subscriptions-admin.service.ts")));

/* ── 7. The owner's view (owner decision 2026-11-25: display only — no counters, attention only) ── */
{
  const now = new Date("2026-12-01T10:00:00Z");
  const day = 86_400_000;
  const q = (used: number, quota: number | null, enforced = true) => ({ metric: "document_uploads" as const, quota, used, enforced, renewsAt: new Date("2027-01-01T00:00:00Z") });
  const base = { status: "ACTIVE", trialEndsAt: null, subscriptionEnforced: true, quotas: [], now };
  ok("7 nothing to say → no attention item", attentionFor(base).length === 0);
  ok("7 a quota below 90% is not mentioned", attentionFor({ ...base, quotas: [q(80, 100)] }).length === 0);
  ok("7 an ENFORCED quota at 90% → quota_near (no numbers in the item)", JSON.stringify(attentionFor({ ...base, quotas: [q(90, 100)] })) === JSON.stringify([{ kind: "quota_near", metric: "document_uploads", label: "העלאת מסמכים", renewsAt: "2027-01-01T00:00:00.000Z" }]));
  ok("7 an ENFORCED quota used up → quota_reached", attentionFor({ ...base, quotas: [q(100, 100)] })[0]?.kind === "quota_reached");
  ok("7 a quota in SHADOW is never mentioned, even far over", attentionFor({ ...base, quotas: [q(500, 100, false)] }).length === 0);
  ok("7 no quota (tester) / quota 0 is never mentioned", attentionFor({ ...base, quotas: [q(5, null), q(5, 0)] }).length === 0);
  ok("7 trial ending: only within 7 days", attentionFor({ ...base, status: "TRIALING", trialEndsAt: new Date(now.getTime() + 8 * day) }).length === 0
    && attentionFor({ ...base, status: "TRIALING", trialEndsAt: new Date(now.getTime() + 7 * day) })[0]?.kind === "trial_ending");
  ok("7 limited: said only when the subscription is enforced, and without per-quota noise", attentionFor({ ...base, status: "FREE_LIMITED", quotas: [q(1, 1)] }).map((a) => a.kind).join() === "limited"
    && attentionFor({ ...base, status: "FREE_LIMITED", subscriptionEnforced: false }).length === 0);
  const meter = read("lib/services/subscriptions/usage/usage-meter.ts");
  ok("7 the owner notification: enforced metrics only, at 90 / 100 only, no percentage in the text", /if \(d\.mode !== "ENFORCE" \|\| pct < 90\) return;/.test(meter) && !/ניצלת \$\{pct\}%/.test(meter));
  ok("7 the refusal body carries no counters", !/used: d\.used|quota: d\.quota/.test(meter.slice(meter.indexOf("export function quotaExhaustedBody"))));
  ok("7 the owner-facing API has no counters route any more", !existsSync("app/api/business/usage/route.ts"));
  for (const p of ["components/settings/subscription/subscription-screen.tsx", "components/settings/subscription/subscription-attention-banner.tsx"]) {
    const ui = read(p).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""); // code only, not the comments that state the rule
    ok(`7 ${p}: no counter, bar or percentage on the owner's screen`, !/\.used\b|remaining|percent|<progress|role="progressbar"|%\s*\}/.test(ui));
  }
  ok("7 the Home banner renders nothing unless there is an attention item", /if \(!item\) return null;/.test(read("components/settings/subscription/subscription-attention-banner.tsx")));
  ok("7 the settings row links to the screen only for a real customer subscription", /row\.key === "subscription" && subscriptionVisible \? "\/settings\/subscription" : row\.href/.test(read("features/account/settings/SettingsHubScreen.tsx")));
  ok("7 a refusal shows a readable message (error = message), the code stays machine-readable", /error: message,\s*code: "QUOTA_EXHAUSTED"/.test(meter) && /error: message,\s*code: inactive/.test(read("lib/services/subscriptions/plan-gate.ts")));
}

console.log(`subscriptions stage C: ${pass} passed, ${failed} failed`);
if (failed) process.exit(1);
