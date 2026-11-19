/**
 * Run: npx tsx lib/services/feature-access/feature-guard.test.ts   (from the repo root)
 *
 * The server-side feature guard (subscriptions phase 1) — pure, no database, no network:
 *   M1 mode: unset / empty / unknown ⇒ shadow; only "off" and "enforce" change it (case and spaces ignored).
 *   M2 decideGuard: allowed ⇒ allow in every mode; refused or unresolvable ⇒ shadow logs, enforce denies, off allows.
 *   S1 shadow (the default): a refused feature is LOGGED and the request goes through — no behaviour change.
 *   E1 enforce: a refused feature answers 403 { error: FEATURE_NOT_AVAILABLE, feature }, no-store.
 *   E2 enforce: an allowed feature goes through.
 *   E3 enforce: a resolver failure fails closed (403); shadow lets it through.
 *   O1 off: neither the session nor the resolver is consulted.
 *   A1 no session (unauthenticated): the guard steps aside in every mode — the route's own 401 answers, as before.
 *   B1 featureAllowedForBusiness (background steps / webhooks): shadow ⇒ true (+ log); enforce ⇒ the answer; off ⇒ true.
 *   C1 the resolution is cached per business for a short time (one resolve for repeated calls).
 *   K1 the guarded set is exactly the eleven UI-only core features named by the audit.
 */
import {
  FEATURE_ACCESS_ENFORCEMENT_ENV,
  FEATURE_NOT_AVAILABLE,
  GUARDED_FEATURE_KEYS,
  __setFeatureGuardResolverForTests,
  __setFeatureGuardSessionForTests,
  decideGuard,
  featureAllowedForBusiness,
  featureEnforcementMode,
  guardFeature,
} from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS, listPlatformFeatureKeys, type PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";
import type { FeatureAccessResult } from "@/lib/services/feature-access/feature-access.types";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function capsWith(denied: PlatformFeatureKey[]): Record<PlatformFeatureKey, FeatureAccessResult> {
  const out = {} as Record<PlatformFeatureKey, FeatureAccessResult>;
  for (const k of listPlatformFeatureKeys()) {
    const allowed = !denied.includes(k);
    out[k] = {
      featureKey: k,
      allowed,
      reasonCode: allowed ? "CATALOG_DEFAULT" : "BUSINESS_DISABLED",
      reasonLabel: "",
      source: allowed ? "catalog" : "business",
      globalEnabled: true,
      emergencyDisabled: false,
      businessOverride: allowed ? null : "DISABLED",
    };
  }
  return out;
}

const logs: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
};

function setMode(v: string | undefined) {
  if (v === undefined) delete process.env[FEATURE_ACCESS_ENFORCEMENT_ENV];
  else process.env[FEATURE_ACCESS_ENFORCEMENT_ENV] = v;
}

const req = () => new Request("https://app.invalid/api/documents/upload", { method: "POST" });

async function main() {
  // M1
  ok("M1 unset ⇒ shadow", featureEnforcementMode({}) === "shadow");
  ok("M1 empty ⇒ shadow", featureEnforcementMode({ [FEATURE_ACCESS_ENFORCEMENT_ENV]: "" }) === "shadow");
  ok("M1 unknown ⇒ shadow", featureEnforcementMode({ [FEATURE_ACCESS_ENFORCEMENT_ENV]: "yes" }) === "shadow");
  ok("M1 true ⇒ shadow (not enforce)", featureEnforcementMode({ [FEATURE_ACCESS_ENFORCEMENT_ENV]: "true" }) === "shadow");
  ok("M1 off", featureEnforcementMode({ [FEATURE_ACCESS_ENFORCEMENT_ENV]: "off" }) === "off");
  ok("M1 ' ENFORCE ' ⇒ enforce", featureEnforcementMode({ [FEATURE_ACCESS_ENFORCEMENT_ENV]: " ENFORCE " }) === "enforce");

  // M2
  for (const mode of ["off", "shadow", "enforce"] as const) ok(`M2 ${mode} allowed ⇒ allow`, decideGuard(mode, true) === "allow");
  ok("M2 off refused ⇒ allow", decideGuard("off", false) === "allow");
  ok("M2 shadow refused ⇒ log", decideGuard("shadow", false) === "log");
  ok("M2 shadow error ⇒ log", decideGuard("shadow", null) === "log");
  ok("M2 enforce refused ⇒ deny", decideGuard("enforce", false) === "deny");
  ok("M2 enforce error ⇒ deny", decideGuard("enforce", null) === "deny");

  let resolves = 0;
  let sessions = 0;
  __setFeatureGuardSessionForTests(async () => {
    sessions++;
    return 42;
  });
  __setFeatureGuardResolverForTests(async () => {
    resolves++;
    return capsWith([PLATFORM_FEATURE_KEYS.DOCUMENTS]);
  });

  // S1 — default (unset) is shadow
  setMode(undefined);
  logs.length = 0;
  const s1 = await guardFeature(req(), PLATFORM_FEATURE_KEYS.DOCUMENTS);
  ok("S1 shadow lets a refused feature through", s1 === null);
  ok("S1 shadow logs would_deny", logs.some((l) => l.includes("feature_access_would_deny") && l.includes("\"featureKey\":\"documents\"") && l.includes("/api/documents/upload")), logs.join("|"));

  // E1 / E2
  setMode("enforce");
  logs.length = 0;
  const e1 = await guardFeature(req(), PLATFORM_FEATURE_KEYS.DOCUMENTS);
  ok("E1 enforce refuses with 403", e1?.status === 403);
  const body = e1 ? await e1.json() : null;
  ok("E1 body", body?.error === FEATURE_NOT_AVAILABLE && body?.feature === "documents", JSON.stringify(body));
  ok("E1 no-store", e1?.headers.get("cache-control") === "no-store");
  ok("E1 logs denied", logs.some((l) => l.includes("feature_access_denied")));
  const e2 = await guardFeature(req(), PLATFORM_FEATURE_KEYS.BILLING);
  ok("E2 enforce lets an allowed feature through", e2 === null);

  // C1 — the three calls above for business 42 resolved once
  ok("C1 cached per business", resolves === 1, `resolves=${resolves}`);

  // E3 — resolver failure
  __setFeatureGuardResolverForTests(async () => {
    throw new Error("db down");
  });
  setMode("enforce");
  const e3 = await guardFeature(req(), PLATFORM_FEATURE_KEYS.BILLING);
  ok("E3 enforce fails closed on resolver error", e3?.status === 403);
  setMode("shadow");
  const e3s = await guardFeature(req(), PLATFORM_FEATURE_KEYS.BILLING);
  ok("E3 shadow lets it through on resolver error", e3s === null);

  // O1 — off consults nothing
  resolves = 0;
  sessions = 0;
  __setFeatureGuardResolverForTests(async () => {
    resolves++;
    return capsWith([...GUARDED_FEATURE_KEYS]);
  });
  setMode("off");
  const o1 = await guardFeature(req(), PLATFORM_FEATURE_KEYS.DOCUMENTS);
  ok("O1 off ⇒ null", o1 === null);
  ok("O1 off consults neither session nor resolver", resolves === 0 && sessions === 0, `r=${resolves} s=${sessions}`);

  // A1 — no session: steps aside in every mode, resolver never asked
  __setFeatureGuardSessionForTests(async () => null);
  for (const mode of ["shadow", "enforce"]) {
    setMode(mode);
    resolves = 0;
    const a1 = await guardFeature(req(), PLATFORM_FEATURE_KEYS.DOCUMENTS);
    ok(`A1 ${mode}: unauthenticated ⇒ null (route answers 401)`, a1 === null && resolves === 0);
  }
  // A1 — a session lookup that throws is treated as no session
  __setFeatureGuardSessionForTests(async () => {
    throw new Error("auth down");
  });
  setMode("enforce");
  ok("A1 session error ⇒ null", (await guardFeature(req(), PLATFORM_FEATURE_KEYS.DOCUMENTS)) === null);
  // The real session lookup (getCurrentUser) with no token answers null without any database work.
  __setFeatureGuardSessionForTests(null);
  ok("A1 real lookup, no token ⇒ null", (await guardFeature(req(), PLATFORM_FEATURE_KEYS.DOCUMENTS)) === null);

  // B1 — background steps
  __setFeatureGuardResolverForTests(async () => capsWith([PLATFORM_FEATURE_KEYS.STARTER_BOT]));
  setMode(undefined);
  logs.length = 0;
  ok("B1 shadow ⇒ true", (await featureAllowedForBusiness(7, PLATFORM_FEATURE_KEYS.STARTER_BOT, "test:step")) === true);
  ok("B1 shadow logs", logs.some((l) => l.includes("feature_access_would_deny") && l.includes("test:step")));
  setMode("enforce");
  ok("B1 enforce refused ⇒ false", (await featureAllowedForBusiness(7, PLATFORM_FEATURE_KEYS.STARTER_BOT, "test:step")) === false);
  ok("B1 enforce allowed ⇒ true", (await featureAllowedForBusiness(7, PLATFORM_FEATURE_KEYS.INBOX, "test:step")) === true);
  setMode("off");
  ok("B1 off ⇒ true", (await featureAllowedForBusiness(7, PLATFORM_FEATURE_KEYS.STARTER_BOT, "test:step")) === true);

  // K1
  const expected = ["documents", "billing", "inbox", "inventory", "content", "pricing", "revenue", "gmail_import", "whatsapp", "starter_bot", "reports"];
  ok("K1 exactly the eleven", JSON.stringify([...GUARDED_FEATURE_KEYS].sort()) === JSON.stringify([...expected].sort()));

  __setFeatureGuardResolverForTests(null);
  __setFeatureGuardSessionForTests(null);
  setMode(undefined);
  console.warn = realWarn;

  if (failures.length) {
    console.error(`feature-guard: ${failures.length} FAILED, ${pass} passed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log(`feature-guard: all ${pass} checks passed`);
}

main().catch((e) => {
  console.warn = realWarn;
  console.error(e);
  process.exit(1);
});
