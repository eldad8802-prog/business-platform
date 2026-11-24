/**
 * Platform subscriptions — CODE lab (stage B). Runs the real reader, admin service, capabilities answer and guard
 * against PostgreSQL with migration 20261224090000_platform_subscriptions applied, connected as LOGIN roles that are
 * members of the real roles (DATABASE_URL → app_runtime, CONTROL_PLANE_DATABASE_URL → app_ctlplane). LAB_OWNER_URL
 * is used only to set up rows and to read the log and audit trail back (the control plane may not).
 *
 * Expects businesses 930001 and 930002 (existed before the migration: backfilled testers), 930003 (created after: no
 * record), the platform system business 930009, and admin user 930100. Prints CODE_LAB_OK as its last line.
 *
 * Run: npx tsx .platform-subscriptions/code-lab.ts
 */
import { PrismaClient } from "@prisma/client";

import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { getBusinessCapabilities } from "@/lib/services/feature-access/business-capabilities.service";
import { __setFeatureGuardSessionForTests, guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { updateBusinessSubscription } from "@/lib/services/platform-admin/update-business-subscription.service";
import { readSubscriptionRecord } from "@/lib/services/subscriptions/subscription-record";
import { runWithTenantContext } from "@/lib/tenant/context";

const owner = new PrismaClient({ datasourceUrl: process.env.LAB_OWNER_URL });
const ADMIN = 930100;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
async function rejects(p: Promise<unknown>, cls: new (...a: never[]) => Error): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof cls;
  }
}
const events = (businessId: number) =>
  owner.platformSubscriptionEvent.findMany({ where: { businessId }, orderBy: { id: "asc" } });
const audits = () => owner.platformAuditEvent.count({ where: { action: "PLATFORM_SUBSCRIPTION_UPDATED" } });
type Caps = Awaited<ReturnType<typeof getBusinessCapabilities>>;
/** Tester / no record: every key the flags allow is full; every key they refuse stays refused (FLAG_DENIED). */
const asToday = (c: Caps) =>
  Object.entries(c.planAccess ?? {}).length === Object.keys(c.features).length &&
  Object.entries(c.planAccess ?? {}).every(([k, e]) =>
    c.features[k as keyof Caps["features"]].allowed ? e.access === "full" : e.access === "none" && e.reasonCode === "FLAG_DENIED");
const change = (businessId: number, accountType: string, plan: string | null) =>
  updateBusinessSubscription({ actorUserId: ADMIN, businessId, request: { accountType, plan, reason: "code lab: manual plan change" } });

async function main() {
  // D1–D2 the reader, as the runtime role
  const t1 = await readSubscriptionRecord(930001);
  ok("D1 backfilled business reads as a tester", t1?.accountType === "TESTER" && t1.status === "EXEMPT" && t1.plan === null, JSON.stringify(t1));
  ok("D2 business created after the migration has no record", (await readSubscriptionRecord(930003)) === null);

  // D3 capabilities + guard before any change: a tester — every plan verdict full, nothing logged
  const before = await runWithTenantContext({ businessId: 930001 }, () => getBusinessCapabilities(930001));
  ok("D3 capabilities: tester, not enforced, no `state`", before.subscription?.accountType === "TESTER" && before.subscription.enforced === false && !("state" in (before.subscription as object)));
  ok("D3 capabilities: plan verdict = today's access for every key", asToday(before));
  ok("D3 some keys are refused by flags (default OFF) and stay refused", Object.values(before.features).some((f) => !f.allowed));

  // D4 admin: tester → customer BASIC, through the control plane
  const auditsBefore = await audits();
  const res = await change(930001, "CUSTOMER", "BASIC");
  ok("D4 change answered", res.changed === true && res.from?.accountType === "TESTER" && res.to.plan === "BASIC" && res.enforced === false);
  const t4 = await readSubscriptionRecord(930001);
  ok("D4 runtime reads the new row", t4?.accountType === "CUSTOMER" && t4.status === "ACTIVE" && t4.plan === "BASIC");
  const ev4 = await events(930001);
  const last = ev4[ev4.length - 1];
  ok("D4 one ADMIN_CHANGE appended after the BACKFILL", ev4.length === 2 && ev4[0].kind === "BACKFILL" && last.kind === "ADMIN_CHANGE"
    && last.fromAccountType === "TESTER" && last.toAccountType === "CUSTOMER" && last.toPlan === "BASIC" && last.actorUserId === ADMIN);
  ok("D4 one audit row", (await audits()) === auditsBefore + 1);
  const row4 = await owner.platformSubscription.findUnique({ where: { businessId: 930001 } });
  ok("D4 row source ADMIN, actor recorded", row4?.source === "ADMIN" && row4.updatedByUserId === ADMIN);

  // D5 the plan verdict is shadow only: flags still allow, the guard passes and logs
  const after = await runWithTenantContext({ businessId: 930001 }, () => getBusinessCapabilities(930001));
  ok("D5 inbox still allowed by flags", after.features.inbox.allowed === true);
  ok("D5 plan verdict: inbox needs ADVANCED", after.planAccess?.inbox.access === "none" && after.planAccess.inbox.requiredPlan === "ADVANCED");
  ok("D5 plan verdict: billing full on BASIC", after.planAccess?.billing.access === "full");
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  __setFeatureGuardSessionForTests(async () => 930001);
  const denied = await guardFeature(new Request("https://lab.invalid/api/inbox/conversations"), PLATFORM_FEATURE_KEYS.INBOX);
  __setFeatureGuardSessionForTests(null);
  console.warn = warn;
  ok("D5 guard lets the request through", denied === null);
  ok("D5 guard logged subscription_would_deny", logs.some((l) => l.includes("subscription_would_deny") && l.includes('"requiredPlan":"ADVANCED"')));

  // D6 refusals write nothing
  const n6 = (await events(930001)).length;
  ok("D6 same change ⇒ NO_CHANGE", await rejects(change(930001, "CUSTOMER", "BASIC"), ConflictError));
  ok("D6 PREMIUM refused", await rejects(change(930001, "CUSTOMER", "PREMIUM"), ForbiddenError));
  ok("D6 system business refused", await rejects(change(930009, "TESTER", null), NotFoundError));
  ok("D6 refusals logged nothing", (await events(930001)).length === n6 && (await audits()) === auditsBefore + 1);

  // D7 a business without a record: the insert path
  await change(930003, "TESTER", null);
  const t7 = await readSubscriptionRecord(930003);
  const ev7 = await events(930003);
  ok("D7 record created", t7?.accountType === "TESTER");
  ok("D7 logged with no 'from'", ev7.length === 1 && ev7[0].fromAccountType === null && ev7[0].kind === "ADMIN_CHANGE");

  // D8 back to tester: every verdict full again; the other business never moved
  await change(930001, "TESTER", null);
  const back = await runWithTenantContext({ businessId: 930001 }, () => getBusinessCapabilities(930001));
  ok("D8 back to tester: plan verdict = today's access again", asToday(back));
  const other = await owner.platformSubscription.findUnique({ where: { businessId: 930002 } });
  ok("D8 business B untouched", other?.accountType === "TESTER" && other.source === "BACKFILL" && (await events(930002)).length === 1);

  // D9 isolation as the runtime: business A's context cannot read B's row
  const cross = await runWithTenantContext({ businessId: 930001 }, async () => {
    const { withTenantTransaction } = await import("@/lib/tenant/transaction");
    return withTenantTransaction((tx) => tx.platformSubscription.findMany({ select: { businessId: true } }));
  });
  ok("D9 runtime sees only its own row", cross.length === 1 && cross[0].businessId === 930001, JSON.stringify(cross));

  await owner.$disconnect();
  if (failures.length) {
    console.error(`code-lab: ${failures.length} FAILED, ${pass} passed`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log(`code-lab: all ${pass} checks passed`);
  console.log("CODE_LAB_OK");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect().catch(() => undefined);
  process.exit(1);
});
