/**
 * Leads L1.5-a · emergency switch / migration 20261113090000_platform_feature_emergency_switch — role battery.
 *
 * Runs against a lab built by `.pfe/lab.sh <db> --with-pfe` (control-plane privileges as in Production):
 *   - only app_ctlplane may EXECUTE the switch; the runtime and an outsider may not; nobody gains a table write
 *   - the switch flips "emergencyDisabled" (+ who / when) for the seven intake sources only, and writes its audit row in
 *     the same transaction; a refused call (another feature, no actor, a short reason) changes nothing and audits nothing
 *   - the exclusive FG lock: the switch WAITS for an intake write that holds the shared form, and gives up cleanly after
 *     lock_timeout (5 s) — nothing written, nothing audited; the runtime can take the shared form with no privilege
 *
 * env: OWNER_URL (superuser), RUNTIME_URL, CTL_URL (a LOGIN member of app_ctlplane), OUTSIDER_URL. Synthetic only.
 */
import { PrismaClient } from "@prisma/client";

const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const rt = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const ctl = new PrismaClient({ datasourceUrl: process.env.CTL_URL! });
const outsider = new PrismaClient({ datasourceUrl: process.env.OUTSIDER_URL! });
const failures: string[] = [];
let passed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Flip = { was_on: boolean; is_on: boolean; audit_event_id: number };
const SWITCH = "SELECT * FROM public.platform_set_feature_emergency($1, $2, $3, $4, $5, $6)";
const codeOf = (e: unknown) => {
  const x = e as { meta?: { code?: string }; code?: string; message?: string };
  return x?.meta?.code ?? (/\b(42501|22023|55P03)\b/.exec(x?.message ?? "")?.[1]) ?? x?.code ?? "error";
};
const call = (client: PrismaClient, key: string, on: boolean, actor: number | null, reason: string) =>
  client.$queryRawUnsafe<Flip[]>(SWITCH, key, on, actor, reason, "198.51.100.7", "pfe-battery").then((r) => r[0], (e) => codeOf(e));
const GOOGLE = "acquisition_google_lead_forms";
const policy = async (key: string) => o.platformFeaturePolicy.findUnique({ where: { featureKey: key } });
const audits = () => o.platformAuditEvent.count({ where: { action: "PLATFORM_FEATURE_EMERGENCY_SET" } });

async function main() {
  const B = await o.business.create({ data: { name: "pfe-admin-home" } });
  const admin = await o.user.create({ data: { email: "platform-admin@pfe.test", password: "x", businessId: B.id, role: "USER" } });
  const REASON = "lab drill: the provider is sending broken payloads";

  console.log("\n-- who may call it --");
  ok("the tenant runtime cannot EXECUTE the switch (42501)", (await call(rt, GOOGLE, true, admin.id, REASON)) === "42501");
  ok("an outsider login cannot EXECUTE the switch (42501)", (await call(outsider, GOOGLE, true, admin.id, REASON)) === "42501");
  const direct = await ctl.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = true WHERE "featureKey" = $1`, GOOGLE)
    .then(() => "allowed", (e) => codeOf(e));
  ok("the control plane still has NO direct write on PlatformFeaturePolicy (42501) — the function is the only way", direct === "42501", String(direct));
  const rtDirect = await rt.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = true WHERE "featureKey" = $1`, GOOGLE)
    .then(() => "allowed", (e) => codeOf(e));
  ok("…and neither has the runtime (42501)", rtDirect === "42501", String(rtDirect));

  console.log("\n-- what it does --");
  const a0 = await audits();
  const on = await call(ctl, GOOGLE, true, admin.id, REASON);
  const p1 = await policy(GOOGLE);
  ok("ON: returns was_on=false / is_on=true and an audit id", typeof on === "object" && on.was_on === false && on.is_on === true && on.audit_event_id > 0, JSON.stringify(on));
  ok("ON: the policy row says so, with who changed it; globalEnabled untouched",
    p1?.emergencyDisabled === true && p1.updatedByUserId === admin.id && p1.globalEnabled === false, JSON.stringify(p1));
  const ev = typeof on === "object" ? await o.platformAuditEvent.findUnique({ where: { id: on.audit_event_id } }) : null;
  const meta = ev?.metadata as { previous?: boolean; current?: boolean; changed?: boolean; reason?: string } | null;
  ok("ON: one audit row in the same transaction — actor, feature, previous / current, the reason",
    (await audits()) === a0 + 1 && ev?.actorUserId === admin.id && ev.targetId === GOOGLE && meta?.previous === false && meta.current === true
      && meta.changed === true && meta.reason === REASON, JSON.stringify(ev));
  const again = await call(ctl, GOOGLE, true, admin.id, REASON);
  ok("ON again: audited as unchanged (an attempt is never silent)", typeof again === "object" && again.was_on === true && (await audits()) === a0 + 2);
  const off = await call(ctl, GOOGLE, false, admin.id, "lab drill over: provider fixed");
  ok("OFF: was_on=true / is_on=false; the row is off again", typeof off === "object" && off.was_on === true && off.is_on === false && (await policy(GOOGLE))?.emergencyDisabled === false);

  console.log("\n-- what it refuses (nothing written, nothing audited) --");
  const other = await o.platformFeaturePolicy.findFirst({ where: { featureKey: { notIn: [
    "acquisition_web_forms", "acquisition_google_lead_forms", "acquisition_meta_lead_ads", "commerce_woocommerce", "commerce_wix",
    "telephony_cloudtalk", "telephony_voicenter"] } } });
  const a1 = await audits();
  if (other) {
    const before = other.emergencyDisabled;
    ok(`a feature outside the seven (${other.featureKey}) → refused (22023), unchanged`,
      (await call(ctl, other.featureKey, !before, admin.id, REASON)) === "22023" && (await policy(other.featureKey))?.emergencyDisabled === before);
  } else {
    ok("a feature outside the seven → refused (22023)", (await call(ctl, "not_an_intake_feature", true, admin.id, REASON)) === "22023");
  }
  ok("no actor → refused (22023)", (await call(ctl, GOOGLE, true, null, REASON)) === "22023");
  ok("an actor that does not exist → refused (22023)", (await call(ctl, GOOGLE, true, 987654321, REASON)) === "22023");
  ok("a reason shorter than 10 characters → refused (22023)", (await call(ctl, GOOGLE, true, admin.id, "  short ")) === "22023");
  ok("…none of the refusals changed the switch or wrote an audit row", (await audits()) === a1 && (await policy(GOOGLE))?.emergencyDisabled === false);

  console.log("\n-- the FG lock (namespace 17991, key hashtext(feature)) --");
  const holdShared = (ms: number) => o.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(17991, hashtext($1))`, GOOGLE);
    await sleep(ms);
  }, { timeout: 30_000, maxWait: 5_000 });
  const rtShared = await rt.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(17991, hashtext($1))`, GOOGLE);
    return "taken";
  }).catch((e) => codeOf(e));
  ok("the runtime can take the SHARED form with no privilege (intake writers hold it while they write)", rtShared === "taken", String(rtShared));
  const holder = holdShared(1_500);
  await sleep(200);
  const t0 = Date.now();
  const waited = await call(ctl, GOOGLE, true, admin.id, REASON);
  const took = Date.now() - t0;
  await holder;
  ok("the switch WAITS for an intake write holding the shared form, then applies (≥ 1 s here)",
    typeof waited === "object" && waited.is_on === true && took >= 1_000, `${took} ms ${JSON.stringify(waited)}`);
  await call(ctl, GOOGLE, false, admin.id, "lab drill over: provider fixed");
  const a2 = await audits();
  const longHolder = holdShared(7_000);
  await sleep(200);
  const t1 = Date.now();
  const timedOut = await call(ctl, GOOGLE, true, admin.id, REASON);
  const took2 = Date.now() - t1;
  await longHolder;
  ok("…and gives up after lock_timeout (5 s) with 55P03 — never an unbounded wait",
    timedOut === "55P03" && took2 >= 4_500 && took2 < 6_900, `${took2} ms ${String(timedOut)}`);
  ok("…the timed-out switch changed nothing and audited nothing", (await audits()) === a2 && (await policy(GOOGLE))?.emergencyDisabled === false);

  console.log(failures.length ? `\nPFE BATTERY: FAILED (${failures.length})\n  ${failures.join("\n  ")}` : `\nPFE BATTERY: ALL PASS — ${passed} checks`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => Promise.all([o.$disconnect(), rt.$disconnect(), ctl.$disconnect(), outsider.$disconnect()]));
