/**
 * Run: npx tsx lib/services/subscriptions/subscriptions-entitlement.test.ts   (from the repo root)
 *
 * Subscriptions stage A — the plan catalog and the plan entitlement layer. Pure: no database, no network.
 *   C1 the catalog covers every platform feature key, exactly once, with a valid plan and FREE_LIMITED answer.
 *   C2 the owner's approved decisions (2026-11-20) are encoded as approved — a change here must be deliberate.
 *   C3 rights floor: billing, documents and reports never close fully in FREE_LIMITED.
 *   C4 Premium is not commercially open; the catalog version is the approved matrix date.
 *   C5 the matrix-to-key judgements are listed for the owner, and only those.
 *   R1 a flag refusal is final: no subscription ever opens what feature access closed.
 *   R2 no record / TESTER / INTERNAL ⇒ full for every key (today's access), whatever the other columns hold.
 *   R3 FREE_LIMITED ⇒ the catalog's freeLimited answer — even over an admin ENABLE (plan doc order, step 5 before 6).
 *   R4 admin ENABLED ⇒ full for a paying customer on a lower plan (pilot / gift).
 *   R5 TRIALING ⇒ full (Premium depth; the flags keep unreleased capabilities closed).
 *   R6 ACTIVE / PAST_DUE ⇒ by plan: included ⇒ full, otherwise none with the plan that would include it.
 *   R7 the full matrix: every key × every flag answer × every subscription shape matches the expected table.
 *   N1 no behaviour change: with the stage-A source (no record) every key the flags allow is "full" — nothing to log.
 *   N2 capabilities: the Home's `subscription.state` is never written (static check of the service source).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { listPlatformFeatureKeys, PLATFORM_FEATURE_KEYS as K, type PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";
import type { FeatureAccessReasonCode } from "@/lib/services/feature-access/feature-access.types";
import {
  PLAN_CATALOG,
  PLAN_CATALOG_VERSION,
  PREMIUM_COMMERCIALLY_OPEN,
  SUBSCRIPTION_PLANS,
  planIncludes,
  type SubscriptionPlan,
} from "./plan-catalog";
import { resolvePlanEntitlement, resolvePlanEntitlements } from "./resolve-entitlement";
import type { SubscriptionSnapshot } from "./subscription.types";
import { SUBSCRIPTION_ENFORCEMENT_ENV, subscriptionMode } from "./subscription-shadow";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const KEYS = listPlatformFeatureKeys();
const sub = (s: Partial<SubscriptionSnapshot>): SubscriptionSnapshot => ({
  accountType: "CUSTOMER",
  status: "ACTIVE",
  plan: null,
  catalogVersion: PLAN_CATALOG_VERSION,
  ...s,
});

// ── C1 ──
const catalogKeys = Object.keys(PLAN_CATALOG).sort();
ok("C1 catalog keys = feature keys", JSON.stringify(catalogKeys) === JSON.stringify([...KEYS].sort()), `${catalogKeys.length} vs ${KEYS.length}`);
for (const k of KEYS) {
  const r = PLAN_CATALOG[k];
  ok(`C1 ${k} plan valid`, (SUBSCRIPTION_PLANS as readonly string[]).includes(r?.minPlan));
  ok(`C1 ${k} freeLimited valid`, ["full", "limited", "none"].includes(r?.freeLimited));
  ok(`C1 ${k} names its matrix row`, typeof r?.matrixRow === "string" && r.matrixRow.length > 3);
}

// ── C2 approved decisions ──
const min = (k: PlatformFeatureKey) => PLAN_CATALOG[k].minPlan;
ok("C2 online booking only in Advanced and Premium", min(K.PUBLIC_BOOKING) === "ADVANCED");
ok("C2 appointments diary in Basic", min(K.APPOINTMENTS) === "BASIC");
ok("C2 tax documents + payment link in Basic", min(K.BILLING) === "BASIC");
ok("C2 quotes / business documents in Basic", min(K.BUSINESS_DOCUMENTS) === "BASIC");
ok("C2 WhatsApp conversations in Advanced", min(K.INBOX) === "ADVANCED" && min(K.WHATSAPP) === "ADVANCED" && min(K.STARTER_BOT) === "ADVANCED");
ok("C2 Gmail import in Advanced", min(K.GMAIL_IMPORT) === "ADVANCED");
ok("C2 content studio in Premium", min(K.CONTENT) === "PREMIUM");
ok("C2 AI recommendations in Premium", min(K.OWNER_RECOMMENDATIONS) === "PREMIUM");
ok("C2 service desk, inventory, tasks, pricing, coupons, reports, documents in Basic",
  [K.SERVICE_DESK, K.INVENTORY, K.DAILY_TASKS, K.PRICING, K.REVENUE, K.REPORTS, K.DOCUMENTS].every((k) => min(k) === "BASIC"));
ok("C2 activity packs free: Basic, and fully open in FREE_LIMITED", min(K.ACTIVITY_PACKS) === "BASIC" && PLAN_CATALOG[K.ACTIVITY_PACKS].freeLimited === "full");
ok("C2 pricing calculator fully open in FREE_LIMITED", PLAN_CATALOG[K.PRICING].freeLimited === "full");
ok("C2 AI, content and online booking closed in FREE_LIMITED",
  [K.CONTENT, K.OWNER_RECOMMENDATIONS, K.KNOWLEDGE_DERIVATION, K.PUBLIC_BOOKING].every((k) => PLAN_CATALOG[k].freeLimited === "none"));

// ── C3 rights floor ──
for (const k of [K.BILLING, K.DOCUMENTS, K.REPORTS]) ok(`C3 ${k} never closes fully in FREE_LIMITED`, PLAN_CATALOG[k].freeLimited !== "none");

// ── C4 ──
ok("C4 Premium not commercially open", PREMIUM_COMMERCIALLY_OPEN === false);
ok("C4 catalog version = approved matrix date", PLAN_CATALOG_VERSION === "2026-11-20");
ok("C4 plans include everything below", planIncludes("PREMIUM", "BASIC") && planIncludes("ADVANCED", "ADVANCED") && !planIncludes("BASIC", "ADVANCED") && !planIncludes("ADVANCED", "PREMIUM"));

// ── C5 judgements listed for the owner ──
const confirmKeys = KEYS.filter((k) => PLAN_CATALOG[k].confirm).sort();
ok("C5 exactly the judged mappings carry `confirm`",
  JSON.stringify(confirmKeys) === JSON.stringify([K.ACCOUNTANT_DELIVERY, K.DOCUMENT_SUPPLIER_LINKING, K.INTAKE_STATUS_VISIBILITY, K.KNOWLEDGE_DERIVATION, K.NOTIFICATIONS_ENGINE].sort()),
  confirmKeys.join(","));

// ── R: flag answers and subscription shapes ──
const FLAG_ALLOWED: { allowed: true; reasonCode: FeatureAccessReasonCode }[] = [
  { allowed: true, reasonCode: "CATALOG_DEFAULT" },
  { allowed: true, reasonCode: "BUSINESS_ENABLED" },
];
const FLAG_DENIED: { allowed: false; reasonCode: FeatureAccessReasonCode }[] = [
  { allowed: false, reasonCode: "EMERGENCY_DISABLED" },
  { allowed: false, reasonCode: "BUSINESS_DISABLED" },
  { allowed: false, reasonCode: "GLOBAL_DEFAULT" },
  { allowed: false, reasonCode: "CATALOG_DEFAULT" },
];
const SHAPES: { name: string; s: SubscriptionSnapshot | null }[] = [
  { name: "no record", s: null },
  { name: "tester", s: sub({ accountType: "TESTER", status: "EXEMPT" }) },
  { name: "tester (odd columns)", s: sub({ accountType: "TESTER", status: "FREE_LIMITED", plan: "BASIC" }) },
  { name: "internal", s: sub({ accountType: "INTERNAL", status: "EXEMPT" }) },
  { name: "trial", s: sub({ status: "TRIALING" }) },
  { name: "basic", s: sub({ plan: "BASIC" }) },
  { name: "advanced", s: sub({ plan: "ADVANCED" }) },
  { name: "premium", s: sub({ plan: "PREMIUM" }) },
  { name: "past due advanced", s: sub({ status: "PAST_DUE", plan: "ADVANCED" }) },
  { name: "free limited", s: sub({ status: "FREE_LIMITED", plan: "ADVANCED" }) },
  { name: "active without plan", s: sub({ plan: null }) },
];

// R1
for (const k of KEYS) for (const f of FLAG_DENIED) for (const sh of SHAPES) {
  const e = resolvePlanEntitlement(k, f, sh.s);
  if (e.access !== "none" || e.reasonCode !== "FLAG_DENIED") ok(`R1 ${k} ${f.reasonCode} ${sh.name}`, false, `${e.access}/${e.reasonCode}`);
  else pass++;
}

/** The expected verdict, written as the plan document's table rather than as the resolver's branches. */
function expected(k: PlatformFeatureKey, flagReason: FeatureAccessReasonCode, name: string): [string, string, SubscriptionPlan | null] {
  const row = PLAN_CATALOG[k];
  switch (name) {
    case "no record": return ["full", "TESTER_DEFAULT", null];
    case "tester": case "tester (odd columns)": return ["full", "ACCOUNT_TESTER", null];
    case "internal": return ["full", "ACCOUNT_INTERNAL", null];
    case "free limited": return [row.freeLimited, "FREE_LIMITED", null];
  }
  if (flagReason === "BUSINESS_ENABLED") return ["full", "ADMIN_ENABLED", null];
  if (name === "trial") return ["full", "TRIAL", null];
  if (name === "active without plan") return ["none", "PLAN_MISSING", row.minPlan];
  const plan = ({ basic: "BASIC", advanced: "ADVANCED", premium: "PREMIUM", "past due advanced": "ADVANCED" } as const)[name as "basic"];
  return planIncludes(plan, row.minPlan) ? ["full", "PLAN_INCLUDES", null] : ["none", "PLAN_REQUIRED", row.minPlan];
}

// R2–R7
let cells = 0;
for (const k of KEYS) for (const f of FLAG_ALLOWED) for (const sh of SHAPES) {
  cells++;
  const e = resolvePlanEntitlement(k, f, sh.s);
  const [access, reason, required] = expected(k, f.reasonCode, sh.name);
  if (e.access === access && e.reasonCode === reason && e.requiredPlan === required) pass++;
  else ok(`R7 ${k} ${f.reasonCode} ${sh.name}`, false, `got ${e.access}/${e.reasonCode}/${e.requiredPlan}, want ${access}/${reason}/${required}`);
}
ok("R7 matrix size", cells === KEYS.length * FLAG_ALLOWED.length * SHAPES.length);

// Spot checks a reader can verify against the matrix by eye.
const allowed = { allowed: true, reasonCode: "CATALOG_DEFAULT" as const };
const basic = sub({ plan: "BASIC" });
ok("R6 Basic + online booking ⇒ none, needs Advanced", JSON.stringify(resolvePlanEntitlement(K.PUBLIC_BOOKING, allowed, basic)) === JSON.stringify({ featureKey: "public_booking", access: "none", reasonCode: "PLAN_REQUIRED", requiredPlan: "ADVANCED" }));
ok("R6 Basic + invoices ⇒ full", resolvePlanEntitlement(K.BILLING, allowed, basic).access === "full");
ok("R6 Advanced + content studio ⇒ none, needs Premium", resolvePlanEntitlement(K.CONTENT, allowed, sub({ plan: "ADVANCED" })).requiredPlan === "PREMIUM");
ok("R4 Basic + admin-enabled content ⇒ full", resolvePlanEntitlement(K.CONTENT, { allowed: true, reasonCode: "BUSINESS_ENABLED" }, basic).reasonCode === "ADMIN_ENABLED");
ok("R3 FREE_LIMITED + admin-enabled WhatsApp ⇒ limited (FREE_LIMITED first)", resolvePlanEntitlement(K.WHATSAPP, { allowed: true, reasonCode: "BUSINESS_ENABLED" }, sub({ status: "FREE_LIMITED" })).access === "limited");
ok("R3 FREE_LIMITED + pricing ⇒ full", resolvePlanEntitlement(K.PRICING, allowed, sub({ status: "FREE_LIMITED" })).access === "full");
ok("R3 FREE_LIMITED + content ⇒ none", resolvePlanEntitlement(K.CONTENT, allowed, sub({ status: "FREE_LIMITED" })).access === "none");

// ── N1 no behaviour change for existing businesses ──
const allAllowed = Object.fromEntries(KEYS.map((k) => [k, allowed])) as Record<PlatformFeatureKey, typeof allowed>;
const stageA = resolvePlanEntitlements(allAllowed, null);
ok("N1 stage-A source: every allowed key is full", KEYS.every((k) => stageA[k].access === "full" && stageA[k].reasonCode === "TESTER_DEFAULT"));
const tester = resolvePlanEntitlements(allAllowed, sub({ accountType: "TESTER", status: "EXEMPT" }));
ok("N1 backfilled tester: every allowed key is full", KEYS.every((k) => tester[k].access === "full"));
ok("N1 a plan verdict never says more than the flag", KEYS.every((k) => FLAG_DENIED.every((f) => SHAPES.every((sh) => resolvePlanEntitlement(k, f, sh.s).access === "none"))));

// Mode: only "off" turns the layer off; there is no enforce mode.
ok("M1 unset ⇒ shadow", subscriptionMode({}) === "shadow");
ok("M1 off", subscriptionMode({ [SUBSCRIPTION_ENFORCEMENT_ENV]: " OFF " }) === "off");
ok("M1 enforce ⇒ still shadow (no enforce mode exists)", subscriptionMode({ [SUBSCRIPTION_ENFORCEMENT_ENV]: "enforce" }) === "shadow");

// ── N2 the Home's FREE_LIMITED switch is never fed ──
const caps = readFileSync(path.join(process.cwd(), "lib/services/feature-access/business-capabilities.service.ts"), "utf8");
const block = caps.slice(caps.indexOf("response.subscription = {"), caps.indexOf("};", caps.indexOf("response.subscription = {")));
ok("N2 capabilities writes a subscription block", block.length > 0 && block.includes("status:"));
ok("N2 capabilities never writes subscription.state", !/\bstate\s*:/.test(block));
ok("N2 capabilities marks the block not enforced", /enforced:\s*false/.test(block));

if (failures.length) {
  console.error(`subscriptions-entitlement: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures.slice(0, 40)) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`subscriptions-entitlement: all ${pass} checks passed (matrix ${cells} cells + ${KEYS.length * FLAG_DENIED.length * SHAPES.length} refusals)`);
