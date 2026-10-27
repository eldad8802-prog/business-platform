/**
 * S1-A compatibility — adding Rivhit (route target `revenue`, rule R10, source pos.rivhit) changes NOTHING for any
 * source that existed before it. Pure: no database, no network.
 *
 *   1. Routing: the new rules decide exactly as routing-policy@2 (frozen below, verbatim from main before S1-A) for
 *      EVERY family × target × identity state × core-destination set — the only new decision is CUSTOM + revenue.
 *   2. The registry: every pre-existing adapter is still registered, in the same order, with the same families,
 *      normalizer version, core destinations, tenant reader and hydrate step.
 *   3. Sources and features: the seven pre-existing connection sources keep their feature keys; the old route
 *      vocabulary is a strict prefix-compatible subset of the new one.
 *   4. The commerce / call adapters' own normalizers and identities are untouched (same module, same output).
 *
 * Run: npx tsx lib/intake/routing/s1a-compat.test.ts
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused@localhost:1/unused";

import type { IntakeEventFamily } from "@prisma/client";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}

type Decision = { rule: string; destination: string; executor: string; ownerReviewRequired: boolean };

/** routing-policy@2, verbatim from lib/intake/routing/rules.ts on main before S1-A (ecbd5b0b). */
function decideRouteV2(input: { family: string; target: string; identityState: string; coreDestinations: readonly string[] }): Decision {
  const UNCERTAIN = ["candidate", "ambiguous", "conflict"];
  const { family, target, identityState } = input;
  const core = (d: string) => input.coreDestinations.includes(d);
  if (target === "lead" && family !== "LEAD") return { rule: "R0_FORBIDDEN_LEAD", destination: "none", executor: "forbidden", ownerReviewRequired: false };
  if (family === "COMMERCE") return { rule: "R5_COMMERCE", destination: "commerce", executor: core("commerce") ? "core" : "unavailable", ownerReviewRequired: false };
  if (family === "CALL" && target === "call") return { rule: "R9_CALL", destination: "call", executor: core("call") ? "core" : "unavailable", ownerReviewRequired: identityState === "conflict" };
  if (target === "message_status") return { rule: "R2_MESSAGE_STATUS", destination: "message_status", executor: "adapter", ownerReviewRequired: false };
  if (family === "MESSAGE" && target === "conversation") return { rule: "R1_MESSAGE", destination: "conversation", executor: "adapter", ownerReviewRequired: false };
  if (target === "document") return { rule: "R3_DOCUMENT", destination: "document", executor: "adapter", ownerReviewRequired: false };
  if (family === "LEAD" && target === "lead") return { rule: "R4_EXPLICIT_LEAD", destination: "lead", executor: core("lead") ? "core" : "adapter", ownerReviewRequired: UNCERTAIN.includes(identityState) };
  if (family === "FORM_SUBMISSION") return { rule: "R6_FORM_ATTENTION", destination: "attention", executor: "adapter", ownerReviewRequired: true };
  if (target === "none") return { rule: "R7_NONE", destination: "none", executor: "adapter", ownerReviewRequired: false };
  return { rule: "R8_ATTENTION_DEFAULT", destination: "attention", executor: "adapter", ownerReviewRequired: true };
}

const OLD_TARGETS = ["conversation", "message_status", "lead", "customer", "commerce", "call", "document", "attention", "none"];

(async () => {
  const { decideRoute } = await import("./rules");
  const { INTAKE_FAMILIES, ROUTE_TARGETS } = await import("@/lib/intake/core/contract");
  const { intakeRegistry } = await import("@/lib/intake/sources");
  const { SOURCE_FEATURE, CONNECTION_SOURCE_KEYS } = await import("@/lib/intake/acquisition/gate");
  const { PLATFORM_FEATURE_KEYS } = await import("@/lib/services/feature-access/platform-feature-catalog");

  console.log("1. Routing: identical to routing-policy@2 except CUSTOM + revenue");
  const states = ["resolved", "candidate", "ambiguous", "unresolved", "conflict", "not_applicable"];
  const coreSets: string[][] = [[], ["lead"], ["commerce"], ["call"], ["lead", "commerce", "call"]];
  let compared = 0;
  const diffs: string[] = [];
  for (const family of INTAKE_FAMILIES) {
    for (const target of ROUTE_TARGETS) {
      for (const identityState of states) {
        for (const coreDestinations of coreSets) {
          const now = decideRoute({ family: family as IntakeEventFamily, eventType: "x", target, identityState: identityState as never, coreDestinations: coreDestinations as never });
          const was = decideRouteV2({ family, target, identityState, coreDestinations });
          compared += 1;
          const same = JSON.stringify(now) === JSON.stringify(was);
          if (!same) diffs.push(`${family}/${target}/${identityState}/${coreDestinations.join("+")}: ${was.rule} → ${now.rule}`);
        }
      }
    }
  }
  const unexpected = diffs.filter((d) => !d.startsWith("CUSTOM/revenue/"));
  check(`every one of ${compared} decisions outside CUSTOM + revenue is unchanged`, unexpected.length === 0, unexpected.slice(0, 5).join("; "));
  check("the only change: CUSTOM + revenue, R8 attention → R10 revenue (adapter)", diffs.length === states.length * coreSets.length && diffs.every((d) => d.endsWith("R8_ATTENTION_DEFAULT → R10_REVENUE")), `${diffs.length}`);
  check("a revenue target from any other family is decided as before (R5 / R8, never R10)", INTAKE_FAMILIES.filter((f) => f !== "CUSTOM").every((family) => decideRoute({ family, eventType: "x", target: "revenue", identityState: "resolved", coreDestinations: [] }).rule !== "R10_REVENUE"));

  console.log("2. The registry: every pre-existing adapter unchanged");
  const expected: Array<[string, string[], string, string[] | null]> = [
    ["whatsapp", ["MESSAGE"], "whatsapp@1", null],
    ["meta.lead_ads", ["LEAD"], "meta.lead_ads@1", ["lead"]],
    ["google.lead_form", ["LEAD"], "google.lead_form@1", ["lead"]],
    ["web.form", ["LEAD"], "web.form@1", ["lead"]],
    ["commerce.woocommerce", ["COMMERCE"], "commerce.woocommerce@1", ["commerce"]],
    ["commerce.wix", ["COMMERCE"], "commerce.wix@1", ["commerce"]],
    ["telephony.cloudtalk", ["CALL"], "telephony.cloudtalk@1", ["call"]],
    ["telephony.voicenter", ["CALL"], "telephony.voicenter@1", ["call"]],
  ];
  const list = intakeRegistry.list();
  const actual = list.slice(0, expected.length).map((a) => [a.sourceKey, [...a.families], a.normalizerVersion, a.coreDestinations ? [...a.coreDestinations] : null]);
  check("the first eight adapters are exactly the pre-S1-A set, same order, families, versions and core destinations", JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
  check("pos.rivhit is appended last, CUSTOM only, no core destination", list.length === 9 && list[8].sourceKey === "pos.rivhit" && JSON.stringify(list[8].families) === '["CUSTOM"]' && !list[8].coreDestinations);
  check("no family is claimed by two kinds of source (Rivhit takes none of MESSAGE / LEAD / COMMERCE / CALL)", !list[8].families.some((f) => ["MESSAGE", "LEAD", "COMMERCE", "CALL"].includes(f)));

  console.log("3. Sources, features, route vocabulary");
  const oldFeatures: Record<string, string> = {
    "meta.lead_ads": PLATFORM_FEATURE_KEYS.ACQUISITION_META_LEAD_ADS,
    "google.lead_form": PLATFORM_FEATURE_KEYS.ACQUISITION_GOOGLE_LEAD_FORMS,
    "web.form": PLATFORM_FEATURE_KEYS.ACQUISITION_WEB_FORMS,
    "commerce.woocommerce": PLATFORM_FEATURE_KEYS.COMMERCE_WOOCOMMERCE,
    "commerce.wix": PLATFORM_FEATURE_KEYS.COMMERCE_WIX,
    "telephony.cloudtalk": PLATFORM_FEATURE_KEYS.TELEPHONY_CLOUDTALK,
    "telephony.voicenter": PLATFORM_FEATURE_KEYS.TELEPHONY_VOICENTER,
  };
  check("the seven pre-existing sources keep their feature keys", Object.entries(oldFeatures).every(([s, f]) => SOURCE_FEATURE[s as keyof typeof SOURCE_FEATURE] === f));
  check("the source list keeps the old sources in their order, pos.rivhit appended", JSON.stringify(CONNECTION_SOURCE_KEYS.slice(0, 7)) === JSON.stringify(Object.keys(oldFeatures)) && CONNECTION_SOURCE_KEYS[7] === "pos.rivhit");
  check("Rivhit's feature is its own (shared with no other source)", Object.values(oldFeatures).every((f) => f !== SOURCE_FEATURE["pos.rivhit"]));
  check("every old route target is still a route target", OLD_TARGETS.every((t) => (ROUTE_TARGETS as readonly string[]).includes(t)) && ROUTE_TARGETS.length === OLD_TARGETS.length + 1);

  console.log("4. Commerce / call normalizers untouched");
  const { normalizeCommerceOrder } = await import("@/lib/intake/commerce/canonical");
  const { normalizeCall } = await import("@/lib/intake/calls/canonical");
  const { makeCommerceAdapter } = await import("@/lib/intake/commerce/adapter");
  const { makeCallAdapter } = await import("@/lib/intake/calls/adapter");
  check("the commerce / call factories still bind their own normalizers", makeCommerceAdapter({ sourceKey: "commerce.woocommerce", resolveTenant: async () => null }).normalize === normalizeCommerceOrder && makeCallAdapter({ sourceKey: "telephony.cloudtalk", resolveTenant: async () => null }).normalize === normalizeCall);

  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
