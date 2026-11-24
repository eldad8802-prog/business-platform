/**
 * Run: npx tsx lib/services/subscriptions/subscriptions-record-admin.test.ts   (from the repo root)
 *
 * Subscriptions stage B — the record reader and the admin manual change. Pure + static: no database, no network.
 *   R1 a row maps to the snapshot; any unknown account type / status / plan is refused (never guessed).
 *   R2 a failing read (e.g. the table is not there yet) degrades to "no record" = today's access, and is logged.
 *   A1 the admin may set exactly: TESTER, INTERNAL (no plan, EXEMPT) and CUSTOMER + BASIC | ADVANCED (ACTIVE).
 *   A2 PREMIUM is refused while it is not commercially open; a customer needs a plan; a tester has none.
 *   A3 a reason of 10–500 characters is required; an identical change is NO_CHANGE.
 *   A4 no admin request can produce TRIALING, PAST_DUE or FREE_LIMITED (those belong to the lifecycle).
 *   A5 the write switch is OFF unless SUBSCRIPTION_ADMIN_CHANGES_ENABLED is exactly "true".
 *   S1 route order: platform admin → fresh second factor → switch → write; the actor is the session admin.
 *   S2 service: one control-plane transaction; affected-row assertions; log + audit appended with createMany (no
 *      RETURNING, no read-back); no DELETE; no tenant singleton; no bare $transaction.
 *   S3 reader: tenant transaction for the business itself; never the control plane.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import {
  PREMIUM_NOT_OPEN,
  SUBSCRIPTION_ADMIN_CHANGES_ENV,
  isSubscriptionAdminChangesEnabled,
  planSubscriptionChange,
  type SubscriptionSide,
} from "@/lib/services/platform-admin/update-business-subscription.service";
import { subscriptionSnapshotFromRow } from "./subscription-record";
import { __setSubscriptionSourceForTests, loadSubscriptionSnapshot } from "./subscription-shadow";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function throwsAs(fn: () => unknown, cls: new (...a: never[]) => Error, code?: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    if (!(e instanceof cls)) return false;
    if (code === undefined) return true;
    const err = e as Error & { code?: string };
    return err.code === code || err.message === code;
  }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  // R1
  const snap = subscriptionSnapshotFromRow({ accountType: "CUSTOMER", status: "ACTIVE", plan: "ADVANCED", catalogVersion: "2026-11-20" });
  ok("R1 row → snapshot", JSON.stringify(snap) === JSON.stringify({ accountType: "CUSTOMER", status: "ACTIVE", plan: "ADVANCED", catalogVersion: "2026-11-20" }));
  ok("R1 tester row", subscriptionSnapshotFromRow({ accountType: "TESTER", status: "EXEMPT", plan: null, catalogVersion: "2026-11-20" }).plan === null);
  for (const bad of [
    { accountType: "VIP", status: "ACTIVE", plan: "BASIC" },
    { accountType: "CUSTOMER", status: "LAPSED", plan: "BASIC" },
    { accountType: "CUSTOMER", status: "ACTIVE", plan: "GOLD" },
  ]) {
    let threw = false;
    try { subscriptionSnapshotFromRow({ ...bad, catalogVersion: "2026-11-20" }); } catch { threw = true; }
    ok(`R1 refuses ${JSON.stringify(bad)}`, threw);
  }

  // R2
  const warn = console.warn;
  const logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  __setSubscriptionSourceForTests(async () => { throw new Error('relation "PlatformSubscription" does not exist'); });
  ok("R2 failing read ⇒ no record", (await loadSubscriptionSnapshot(9)) === null);
  ok("R2 failing read is logged without the message", logs.some((l) => l.includes("subscription_read_failed") && l.includes('"businessId":9') && !l.includes("relation")));
  __setSubscriptionSourceForTests(null);
  console.warn = warn;

  // A1
  const r = (accountType: unknown, plan: unknown, reason: unknown = "manual change for the lab test") => ({ accountType, plan, reason });
  const t = (cur: SubscriptionSide | null, req: ReturnType<typeof r>) => planSubscriptionChange(cur, req).target;
  ok("A1 TESTER", JSON.stringify(t(null, r("TESTER", null))) === JSON.stringify({ accountType: "TESTER", status: "EXEMPT", plan: null }));
  ok("A1 INTERNAL", t(null, r("INTERNAL", undefined)).status === "EXEMPT");
  ok("A1 CUSTOMER BASIC", JSON.stringify(t(null, r("CUSTOMER", "BASIC"))) === JSON.stringify({ accountType: "CUSTOMER", status: "ACTIVE", plan: "BASIC" }));
  ok("A1 CUSTOMER ADVANCED", t({ accountType: "TESTER", status: "EXEMPT", plan: null }, r("CUSTOMER", "ADVANCED")).plan === "ADVANCED");
  ok("A1 unknown account type", throwsAs(() => t(null, r("OWNER", null)), ValidationError));

  // A2
  ok("A2 PREMIUM refused (not commercially open)", throwsAs(() => t(null, r("CUSTOMER", "PREMIUM")), ForbiddenError, PREMIUM_NOT_OPEN));
  ok("A2 customer without plan", throwsAs(() => t(null, r("CUSTOMER", null)), ValidationError));
  ok("A2 customer with unknown plan", throwsAs(() => t(null, r("CUSTOMER", "GOLD")), ValidationError));
  ok("A2 tester with a plan", throwsAs(() => t(null, r("TESTER", "BASIC")), ValidationError));

  // A3
  ok("A3 short reason", throwsAs(() => t(null, r("TESTER", null, "short")), ValidationError));
  ok("A3 long reason", throwsAs(() => t(null, r("TESTER", null, "x".repeat(501))), ValidationError));
  ok("A3 missing reason", throwsAs(() => t(null, r("TESTER", null, null)), ValidationError));
  ok("A3 reason trimmed", planSubscriptionChange(null, r("TESTER", null, "   a valid reason here   ")).reason === "a valid reason here");
  ok("A3 identical ⇒ NO_CHANGE", throwsAs(() => t({ accountType: "CUSTOMER", status: "ACTIVE", plan: "BASIC" }, r("CUSTOMER", "BASIC")), ConflictError, "NO_CHANGE"));
  ok("A3 tester → tester ⇒ NO_CHANGE", throwsAs(() => t({ accountType: "TESTER", status: "EXEMPT", plan: null }, r("TESTER", null)), ConflictError, "NO_CHANGE"));

  // A4 exhaustive: every request shape × every current shape
  const accountTypes = ["CUSTOMER", "TESTER", "INTERNAL", "OWNER", null];
  const plans = ["BASIC", "ADVANCED", "PREMIUM", "GOLD", null, undefined];
  const currents: (SubscriptionSide | null)[] = [
    null,
    { accountType: "TESTER", status: "EXEMPT", plan: null },
    { accountType: "CUSTOMER", status: "FREE_LIMITED", plan: null },
    { accountType: "CUSTOMER", status: "TRIALING", plan: null },
    { accountType: "CUSTOMER", status: "PAST_DUE", plan: "ADVANCED" },
  ];
  let produced = 0;
  let lifecycle = 0;
  for (const cur of currents) for (const a of accountTypes) for (const p of plans) {
    try {
      const out = t(cur, r(a, p));
      produced++;
      if (!["EXEMPT", "ACTIVE"].includes(out.status) || out.plan === "PREMIUM") lifecycle++;
    } catch {
      /* refused */
    }
  }
  ok("A4 some requests succeed", produced > 0);
  ok("A4 no admin request yields TRIALING / PAST_DUE / FREE_LIMITED or PREMIUM", lifecycle === 0, String(lifecycle));

  // A5
  ok("A5 unset ⇒ off", isSubscriptionAdminChangesEnabled({}) === false);
  ok("A5 '1' ⇒ off", isSubscriptionAdminChangesEnabled({ [SUBSCRIPTION_ADMIN_CHANGES_ENV]: "1" }) === false);
  ok("A5 'TRUE' ⇒ off", isSubscriptionAdminChangesEnabled({ [SUBSCRIPTION_ADMIN_CHANGES_ENV]: "TRUE" }) === false);
  ok("A5 'true' ⇒ on", isSubscriptionAdminChangesEnabled({ [SUBSCRIPTION_ADMIN_CHANGES_ENV]: "true" }) === true);

  // S1 route
  const route = code("app/api/platform-admin/businesses/[id]/subscription/route.ts");
  const at = (s: string) => route.indexOf(s);
  ok("S1 admin guard first", at("requirePlatformAdminOrResponse(req)") > 0 && at("requirePlatformAdminOrResponse(req)") < at("freshStepUpRefusal(req, auth.id)"));
  ok("S1 fresh second factor before the switch", at("freshStepUpRefusal(req, auth.id)") < at("isSubscriptionAdminChangesEnabled()"));
  ok("S1 switch before the body and the write", at("isSubscriptionAdminChangesEnabled()") < at("req.json()") && at("req.json()") < at("updateBusinessSubscription("));
  ok("S1 actor is the session admin", /actorUserId:\s*auth\.id/.test(route) && !/record\.actorUserId|body\.actorUserId/.test(route));
  ok("S1 only PATCH", /export async function PATCH/.test(route) && !/export async function (GET|POST|PUT|DELETE)/.test(route));

  // S2 service
  const svc = code("lib/services/platform-admin/update-business-subscription.service.ts");
  ok("S2 control-plane transaction", /withControlPlaneTransaction\(input\.businessId,/.test(svc));
  ok("S2 no tenant singleton, no bare $transaction", !/from "@\/lib\/prisma"/.test(svc) && !/\$transaction/.test(svc));
  ok("S2 affected-row assertions (row, log)", (svc.match(/assertAffected\(/g) ?? []).length === 3);
  ok("S2 log appended with createMany (no RETURNING)", /platformSubscriptionEvent\.createMany\(/.test(svc) && !/platformSubscriptionEvent\.(create|findMany|findFirst|findUnique|update|delete)\b/.test(svc));
  ok("S2 audit on the same transaction", /createPlatformAuditEventTx\(tx,/.test(svc) && /SUBSCRIPTION_UPDATED/.test(svc));
  ok("S2 never deletes", !/\.delete(Many)?\(/.test(svc));
  ok("S2 a manual change sets no trial or period", /trialEndsAt:\s*null/.test(svc) && /currentPeriodEnd:\s*null/.test(svc) && /source:\s*"ADMIN"/.test(svc));

  // S3 reader
  const reader = code("lib/services/subscriptions/subscription-record.ts");
  ok("S3 tenant transaction for the business itself", /runWithTenantContext\(\{ businessId \}/.test(reader) && /withTenantTransaction\(/.test(reader));
  ok("S3 never the control plane or the admin client", !/control-plane|prisma-admin|prisma-control-plane/.test(reader));
  ok("S3 the shadow layer reads the record", /const defaultSource: SubscriptionSource = readSubscriptionRecord;/.test(code("lib/services/subscriptions/subscription-shadow.ts")));

  if (failures.length) {
    console.error(`subscriptions-record-admin: ${failures.length} FAILED, ${pass} passed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log(`subscriptions-record-admin: all ${pass} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
