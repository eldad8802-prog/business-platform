/**
 * Leads L1.5-a · decision 3 / migration 20261110100000_acquisition_resolve_paused_hold — role battery.
 *
 * Runs against a lab built by `.lrp/lab.sh <db> --with-lrp`, as the Production runtime role (NOSUPERUSER
 * NOBYPASSRLS), with connections made by the REAL connection service:
 *   - keyed / public v2 resolve ACTIVE and PAUSED (with the status), never ERROR, REVOKED, a wrong key or another source
 *   - resource v2 resolves ACTIVE, ERROR and PAUSED, never REVOKED
 *   - v1 is unchanged: a PAUSED connection still resolves to nothing there (the running code is not affected)
 *   - each answer names the connection's OWN business (two businesses, no cross-tenant answer)
 *   - the runtime cannot read the table outside a tenant (FORCE RLS) — the resolvers stay the only bootstrap
 *   - a login without EXECUTE cannot call v2
 *
 * env: OWNER_URL (superuser), DATABASE_URL / DIRECT_URL = runtime, OUTSIDER_URL, ACQUISITION_CREDENTIAL_ENCRYPTION_KEY.
 * Synthetic data only.
 */
import { PrismaClient } from "@prisma/client";
import { runWithTenantContext } from "../lib/tenant/context";
import { bindMetaPage, createKeyedConnection, revokeConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { hashKey } from "../lib/intake/acquisition/keys";

const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const rt = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
const outsider = new PrismaClient({ datasourceUrl: process.env.OUTSIDER_URL! });
const failures: string[] = [];
let passed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name} ${detail}`); }
}
type Row = { connection_id: number; business_id: number; status?: string; allowed_origins?: string[] };
const keyed = (v: "" | "_v2", source: string, publicId: string, key: string) =>
  rt.$queryRawUnsafe<Row[]>(`SELECT * FROM public.m6_acquisition_resolve_keyed${v}($1, $2, $3)`, source, publicId, hashKey(key));
const pub = (v: "" | "_v2", source: string, publicId: string) =>
  rt.$queryRawUnsafe<Row[]>(`SELECT * FROM public.m6_acquisition_resolve_public${v}($1, $2)`, source, publicId);
const res = (v: "" | "_v2", source: string, resourceId: string) =>
  rt.$queryRawUnsafe<Row[]>(`SELECT * FROM public.m6_acquisition_resolve_resource${v}($1, $2)`, source, resourceId);

async function main() {
  const A = await o.business.create({ data: { name: "lrp-A" } });
  const B = await o.business.create({ data: { name: "lrp-B" } });
  const mk = (businessId: number, sourceKey: "google.lead_form" | "web.form") =>
    runWithTenantContext({ businessId }, () => createKeyedConnection({ businessId, userId: null, sourceKey, allowedOrigins: ["https://a.example"] }));
  const page = (businessId: number, pageId: string) =>
    runWithTenantContext({ businessId }, () => bindMetaPage({ businessId, userId: null, pageId, pageName: pageId, pageAccessToken: `TOKEN-${pageId}` }));

  const gActive = await mk(A.id, "google.lead_form");
  const gPaused = await mk(A.id, "google.lead_form");
  const gError = await mk(A.id, "google.lead_form");
  const gRevoked = await mk(A.id, "google.lead_form");
  const gPausedB = await mk(B.id, "google.lead_form");
  const wPaused = await mk(A.id, "web.form");
  await runWithTenantContext({ businessId: A.id }, () => setPaused(gPaused.connection.id, true));
  await runWithTenantContext({ businessId: B.id }, () => setPaused(gPausedB.connection.id, true));
  await runWithTenantContext({ businessId: A.id }, () => setPaused(wPaused.connection.id, true));
  await runWithTenantContext({ businessId: A.id }, () => revokeConnection(gRevoked.connection.id));
  await o.acquisitionConnection.update({ where: { id: gError.connection.id }, data: { status: "ERROR", lastErrorCode: "LAB" } });
  const pActive = await page(A.id, "5100000001");
  const pPaused = await page(A.id, "5100000002");
  const pError = await page(A.id, "5100000003");
  const pRevoked = await page(A.id, "5100000004");
  await runWithTenantContext({ businessId: A.id }, () => setPaused(pPaused.id, true));
  await o.acquisitionConnection.update({ where: { id: pError.id }, data: { status: "ERROR", lastErrorCode: "META_TOKEN_INVALID" } });
  await runWithTenantContext({ businessId: A.id }, () => revokeConnection(pRevoked.id));
  const statuses = await o.acquisitionConnection.groupBy({ by: ["status"], where: { businessId: { in: [A.id, B.id] } }, _count: true });
  console.log("  lab connections:", JSON.stringify(statuses.map((s) => [s.status, s._count])));

  console.log("\n-- keyed v2 (Google / website server / Voicenter) --");
  const one = (rows: Row[], id: number, biz: number, status: string) =>
    rows.length === 1 && rows[0].connection_id === id && rows[0].business_id === biz && rows[0].status === status;
  ok("ACTIVE → the connection, its business, status ACTIVE", one(await keyed("_v2", "google.lead_form", gActive.connection.publicId, gActive.key), gActive.connection.id, A.id, "ACTIVE"));
  ok("PAUSED → the connection, its business, status PAUSED (the route can hold it)", one(await keyed("_v2", "google.lead_form", gPaused.connection.publicId, gPaused.key), gPaused.connection.id, A.id, "PAUSED"));
  ok("PAUSED in B → B's connection and B (never A)", one(await keyed("_v2", "google.lead_form", gPausedB.connection.publicId, gPausedB.key), gPausedB.connection.id, B.id, "PAUSED"));
  ok("ERROR → nothing (not part of decision 3)", (await keyed("_v2", "google.lead_form", gError.connection.publicId, gError.key)).length === 0);
  ok("REVOKED → nothing", (await keyed("_v2", "google.lead_form", gRevoked.connection.publicId, gRevoked.key)).length === 0);
  ok("a wrong key → nothing", (await keyed("_v2", "google.lead_form", gPaused.connection.publicId, "wrong-key-0123456789")).length === 0);
  ok("the right key under another source → nothing", (await keyed("_v2", "web.form", gPaused.connection.publicId, gPaused.key)).length === 0);

  console.log("\n-- public v2 (website browser / CloudTalk / WooCommerce) --");
  const wp = await pub("_v2", "web.form", wPaused.connection.publicId);
  ok("PAUSED → the connection, its allowed origins, status PAUSED",
    wp.length === 1 && wp[0].business_id === A.id && wp[0].status === "PAUSED" && JSON.stringify(wp[0].allowed_origins) === JSON.stringify(["https://a.example"]), JSON.stringify(wp));
  ok("ACTIVE → status ACTIVE", (await pub("_v2", "google.lead_form", gActive.connection.publicId))[0]?.status === "ACTIVE");
  ok("ERROR / REVOKED → nothing",
    (await pub("_v2", "google.lead_form", gError.connection.publicId)).length === 0 && (await pub("_v2", "google.lead_form", gRevoked.connection.publicId)).length === 0);

  console.log("\n-- resource v2 (Meta Page / Wix installation) --");
  ok("ACTIVE / ERROR / PAUSED → the connection with its status",
    one(await res("_v2", "meta.lead_ads", "5100000001"), pActive.id, A.id, "ACTIVE")
      && one(await res("_v2", "meta.lead_ads", "5100000003"), pError.id, A.id, "ERROR")
      && one(await res("_v2", "meta.lead_ads", "5100000002"), pPaused.id, A.id, "PAUSED"));
  ok("REVOKED → nothing", (await res("_v2", "meta.lead_ads", "5100000004")).length === 0);

  console.log("\n-- v1 unchanged (the running code) --");
  ok("v1 keyed: ACTIVE resolves, PAUSED still does not",
    (await keyed("", "google.lead_form", gActive.connection.publicId, gActive.key)).length === 1 && (await keyed("", "google.lead_form", gPaused.connection.publicId, gPaused.key)).length === 0);
  ok("v1 public: PAUSED still does not", (await pub("", "web.form", wPaused.connection.publicId)).length === 0);
  ok("v1 resource: ACTIVE + ERROR resolve, PAUSED still does not",
    (await res("", "meta.lead_ads", "5100000001")).length === 1 && (await res("", "meta.lead_ads", "5100000003")).length === 1
      && (await res("", "meta.lead_ads", "5100000002")).length === 0);

  console.log("\n-- boundaries --");
  ok("the runtime reads NO connection row outside a tenant (FORCE RLS) — the resolvers are the only bootstrap",
    (await rt.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "AcquisitionConnection"`))[0].n === BigInt(0));
  const denied = await outsider.$queryRawUnsafe(`SELECT * FROM public.m6_acquisition_resolve_keyed_v2('google.lead_form', 'x', 'y')`)
    .then(() => "allowed", (e: { code?: string; meta?: { code?: string } }) => e?.meta?.code ?? e?.code ?? "error");
  ok("a login without EXECUTE cannot call v2 (permission denied)", denied === "42501", String(denied));

  console.log(failures.length ? `\nLRP BATTERY: FAILED (${failures.length})\n  ${failures.join("\n  ")}` : `\nLRP BATTERY: ALL PASS — ${passed} checks`);
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all([o.$disconnect(), rt.$disconnect(), outsider.$disconnect()]));
