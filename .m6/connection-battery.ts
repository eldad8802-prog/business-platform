/**
 * M6 PR-A — what migration 20261009090000_m6_acquisition_connections does, measured with the real
 * tenant runtime on a Production-shaped database (lab: .m6/lab.sh <db> --with-m6).
 *
 *   1. tenant isolation: the runtime reads / writes only the business named by
 *      app.current_business_id; no context → nothing; no DELETE at all;
 *   2. ONE live mapping per provider resource: a Page bound to A cannot be bound to B until A's
 *      connection is revoked;
 *   3. the pre-tenant lookups answer only "which business owns this exact key": right key → A,
 *      wrong key / other source / paused / revoked / unknown → nothing; no other role may call them;
 *   4. the CHECK constraints refuse malformed connections;
 *   5. the three features exist OFF; Business deletion cascades.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network.
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
async function rt(guc: number | null, sql: string, ...args: unknown[]): Promise<Rows | string> {
  return runtime.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>;
  }).catch((e: Error) => e.message);
}
const n = (r: Rows | string) => (typeof r === "string" ? -1 : r.length);
const refused = (r: Rows | string, re: RegExp) => typeof r === "string" && re.test(r);
const ownerErr = (sql: string, ...args: unknown[]) => owner.$executeRawUnsafe(sql, ...args).then(() => "ok", (e: Error) => e.message);

const pid = () => randomBytes(24).toString("base64url");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const INS = `INSERT INTO "AcquisitionConnection" ("businessId","sourceKey","publicId","externalResourceId","keyHash","status","updatedAt")
             VALUES ($1,$2,$3,$4,$5,'ACTIVE',now()) RETURNING id`;

async function main() {
  const tag = `m6-${Date.now()}`;
  const A = await owner.business.create({ data: { name: `${tag}-A` } });
  const B = await owner.business.create({ data: { name: `${tag}-B` } });

  console.log("\n-- 1. tenant isolation --");
  const keyA = `wk_${randomBytes(18).toString("base64url")}`;
  const webA = pid();
  ok("GUC = A: the runtime creates A's website connection", n(await rt(A.id, INS, A.id, "web.form", webA, null, sha(keyA))) === 1);
  ok("GUC = A: creating a connection for B is refused (WITH CHECK)", refused(await rt(A.id, INS, B.id, "web.form", pid(), null, sha("x")), /row-level security/i));
  ok("no tenant context: creating anything is refused", refused(await rt(null, INS, A.id, "web.form", pid(), null, sha("y")), /row-level security/i));
  const webB = pid();
  await ownerErr(INS, B.id, "web.form", webB, null, sha("kb"));
  ok("GUC = A sees only A's connection", n(await rt(A.id, `SELECT id FROM "AcquisitionConnection"`)) === 1);
  ok("no tenant context sees nothing", n(await rt(null, `SELECT id FROM "AcquisitionConnection"`)) === 0);
  ok("GUC = A: changing B's connection touches 0 rows",
    n(await rt(A.id, `UPDATE "AcquisitionConnection" SET "label" = 'x' WHERE "publicId" = $1 RETURNING id`, webB)) === 0);
  ok("GUC = A: moving A's connection to B is refused",
    refused(await rt(A.id, `UPDATE "AcquisitionConnection" SET "businessId" = $1 WHERE "publicId" = $2 RETURNING id`, B.id, webA), /row-level security/i));
  ok("the runtime cannot DELETE a connection (revoke, never erase)",
    refused(await rt(A.id, `DELETE FROM "AcquisitionConnection" RETURNING id`), /permission denied/i));

  console.log("\n-- 2. one live mapping per provider resource --");
  const page = `page${Date.now()}`;
  ok("A connects its Page", n(await rt(A.id, INS, A.id, "meta.lead_ads", pid(), page, null)) === 1);
  ok("the same Page cannot be bound to B while A's mapping is live",
    /AcquisitionConnection_live_resource_key|23505|duplicate key/i.test(await ownerErr(INS, B.id, "meta.lead_ads", pid(), page, null)));
  await rt(A.id, `UPDATE "AcquisitionConnection" SET "status" = 'REVOKED', "revokedAt" = now() WHERE "externalResourceId" = $1 RETURNING id`, page);
  ok("after A revokes, B may connect that Page", (await ownerErr(INS, B.id, "meta.lead_ads", pid(), page, null)) === "ok");

  console.log("\n-- 3. pre-tenant lookups (no tenant context, as a webhook runs) --");
  const keyed = (src: string, p: string, h: string) => rt(null, `SELECT * FROM public.m6_acquisition_resolve_keyed($1,$2,$3)`, src, p, h);
  const r1 = await keyed("web.form", webA, sha(keyA));
  ok("exact endpoint + exact key → A", typeof r1 !== "string" && r1.length === 1 && Number(r1[0].business_id) === A.id, JSON.stringify(r1));
  ok("wrong key → nothing", n(await keyed("web.form", webA, sha("wrong"))) === 0);
  ok("right key, other source → nothing", n(await keyed("google.lead_form", webA, sha(keyA))) === 0);
  ok("A's key on B's endpoint → nothing", n(await keyed("web.form", webB, sha(keyA))) === 0);
  const r2 = await rt(null, `SELECT * FROM public.m6_acquisition_resolve_resource($1,$2)`, "meta.lead_ads", page);
  ok("the Page resolves to B only (A's mapping is revoked)", typeof r2 !== "string" && r2.length === 1 && Number(r2[0].business_id) === B.id, JSON.stringify(r2));
  ok("an unknown Page resolves to nothing", n(await rt(null, `SELECT * FROM public.m6_acquisition_resolve_resource($1,$2)`, "meta.lead_ads", "nope")) === 0);
  await rt(A.id, `UPDATE "AcquisitionConnection" SET "status" = 'PAUSED' WHERE "publicId" = $1 RETURNING id`, webA);
  ok("a PAUSED connection resolves to nothing", n(await keyed("web.form", webA, sha(keyA))) === 0);
  ok("the browser lookup also refuses a paused endpoint", n(await rt(null, `SELECT * FROM public.m6_acquisition_resolve_public($1,$2)`, "web.form", webA)) === 0);
  await rt(A.id, `UPDATE "AcquisitionConnection" SET "status" = 'ACTIVE', "allowedOrigins" = ARRAY['https://a.example'] WHERE "publicId" = $1 RETURNING id`, webA);
  const r3 = await rt(null, `SELECT * FROM public.m6_acquisition_resolve_public($1,$2)`, "web.form", webA);
  ok("the browser lookup returns A and exactly the allowed origins",
    typeof r3 !== "string" && r3.length === 1 && Number(r3[0].business_id) === A.id && JSON.stringify(r3[0].allowed_origins) === '["https://a.example"]', JSON.stringify(r3));
  const t = await rt(null, `SELECT * FROM public.m6_acquisition_tenants($1)`, "meta.lead_ads");
  ok("the sweeper lookup lists every business that ever held the source (revoked included)",
    typeof t !== "string" && t.map((x) => Number(Object.values(x)[0])).sort().join(",") === [A.id, B.id].sort().join(","), JSON.stringify(t));
  const [priv] = (await owner.$queryRawUnsafe(`
    SELECT count(*) FILTER (WHERE has_function_privilege(r.rolname, p.oid, 'EXECUTE'))::int AS n
    FROM pg_proc p CROSS JOIN (VALUES ('app_auth'), ('app_ctlplane')) r(rolname)
    WHERE p.proname LIKE 'm6\\_acquisition\\_%' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.rolname)`)) as Array<{ n: number }>;
  ok("app_auth / app_ctlplane cannot call any lookup", priv.n === 0, String(priv.n));
  const [pubx] = (await owner.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.proname LIKE 'm6\\_acquisition\\_%' AND x.grantee = 0`)) as Array<{ n: number }>;
  ok("PUBLIC cannot call any lookup", pubx.n === 0);

  console.log("\n-- 4. constraints --");
  const bad = async (cols: string, vals: string) => ownerErr(`INSERT INTO "AcquisitionConnection" ("businessId","updatedAt",${cols}) VALUES (${A.id}, now(), ${vals})`);
  ok("an unknown source is refused", /source_key/.test(await bad(`"sourceKey","publicId","keyHash"`, `'tiktok.leads','${pid()}','${sha("k")}'`)));
  ok("a Meta connection without its Page is refused", /source_shape/.test(await bad(`"sourceKey","publicId"`, `'meta.lead_ads','${pid()}'`)));
  ok("a Google connection without a key is refused", /source_shape/.test(await bad(`"sourceKey","publicId"`, `'google.lead_form','${pid()}'`)));
  ok("a raw key where a sha256 belongs is refused", /key_hash/.test(await bad(`"sourceKey","publicId","keyHash"`, `'web.form','${pid()}','plain-secret'`)));
  ok("a guessable public id is refused", /public_id/.test(await bad(`"sourceKey","publicId","keyHash"`, `'web.form','abc','${sha("k")}'`)));
  ok("a half-written credential is refused",
    /credential_shape/.test(await bad(`"sourceKey","publicId","externalResourceId","credentialCiphertext"`, `'meta.lead_ads','${pid()}','p9','c'`)));
  ok("REVOKED without revokedAt is refused", /revoked_shape/.test(await bad(`"sourceKey","publicId","keyHash","status"`, `'web.form','${pid()}','${sha("k")}','REVOKED'`)));

  console.log("\n-- 5. features off; erasure follows the business --");
  const [f] = (await owner.$queryRawUnsafe(`
    SELECT (SELECT count(*)::int FROM "PlatformFeatureDefinition" WHERE key LIKE 'acquisition\\_%' AND NOT "defaultEnabled") AS d,
           (SELECT count(*)::int FROM "PlatformFeaturePolicy" WHERE "featureKey" LIKE 'acquisition\\_%' AND NOT "globalEnabled") AS p`)) as Array<{ d: number; p: number }>;
  ok("the three acquisition features are defined OFF with OFF policies", f.d === 3 && f.p === 3, JSON.stringify(f));
  await owner.business.delete({ where: { id: B.id } });
  const [g] = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AcquisitionConnection" WHERE "businessId" = ${B.id}`)) as Array<{ n: number }>;
  ok("deleting a business removes its connections (cascade)", g.n === 0);

  console.log(`\nM6 connection battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
