/**
 * sec(C) M-14(a) — WhatsAppConnection / POSApiKey / ProductUsageEvent under FORCE
 * RLS (ops/security/sec-c-phase3-rls.sql), with the pre-context lookups served by
 * the narrow SECURITY DEFINER functions — and proof that the code works in all three
 * rollout states (no sec(C) migration / migration without RLS / full phase 3).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { newLab, dropLab, psqlFile, psql, q, ROOT } from "../lab.mjs";
import { ok, section, client, asTenant, sqlError, fingerprint, makeTenant, prodLikeRuntimeGrants } from "../common";

const PHASE3 = path.join(ROOT, "ops/security/sec-c-phase3-rls.sql");

async function seed(owner: ReturnType<typeof client>) {
  const a = await makeTenant(owner, "p3A");
  const b = await makeTenant(owner, "p3B");
  const c = await makeTenant(owner, "p3C");
  const wa = (bid: number, pn: string, status: string) =>
    owner.$executeRawUnsafe(`INSERT INTO "WhatsAppConnection" ("businessId","phoneNumberId","displayPhoneNumber","wabaId","accessTokenEncrypted","accessTokenIv","accessTokenTag","status","updatedAt")
      VALUES (${bid}, '${pn}', '+000', 'waba', 'enc', 'iv', 'tag', '${status}', now())`);
  await wa(a.businessId, "pnA", "CONNECTED");
  await wa(b.businessId, "pnB", "CONNECTED");
  await wa(c.businessId, "pnC", "DISCONNECTED");
  await owner.$executeRawUnsafe(`INSERT INTO "POSApiKey" ("businessId","keyHash","source") VALUES (${a.businessId}, 'hashA', 'POS'), (${b.businessId}, 'hashB', 'POS')`);
  return { a, b, c };
}

async function appModules(rtUrl: string) {
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const wa = await import("@/lib/services/integrations/whatsapp/connection.service");
  const pos = await import("@/lib/services/inventory/pos-api-key.service");
  const pue = await import("@/lib/services/product-usage/record-product-usage-event");
  return { wa, pos, pue };
}

void section("m14-phase3", async () => {
  // One process = one Prisma singleton, so the three rollout states use three
  // databases and ONE runtime URL chosen per state via a fresh lab each — the
  // modules are imported once, against the phase-3 lab (the state that matters);
  // the pre-states are proved with raw calls to the same SQL the modules issue.
  // ── state 0: no sec(C) migration — the lookup SQL is absent, fallback needed ──
  {
    const lab0 = await newLab("p3pre", { secC: false });
    const o = client(lab0.ownerUrl);
    await prodLikeRuntimeGrants(o);
    const s0 = await seed(o);
    const r = psql(lab0.rtUrl, `SELECT public.sec_c_whatsapp_business_by_phone_number_id('pnA')`, { allowFail: true });
    ok("M14 state0: without the migration the lookup function is absent (42883)", r.status !== 0 && /does not exist/.test(r.err), r.err);
    const child = spawnSync("npx", ["tsx", ".secc/sections/fallback-probe.ts"], {
      env: { ...process.env, DATABASE_URL: lab0.rtUrl, DIRECT_URL: lab0.rtUrl }, encoding: "utf8", cwd: ROOT,
      shell: process.platform === "win32",
    });
    const line = (child.stdout.match(/PROBE (.*)/) ?? [])[1];
    ok("M14 state0: the REAL code still resolves tenants before the migration (fallback, no outage window)",
      line === JSON.stringify({ pnA: s0.a.businessId, pnC: null, hashA: s0.a.businessId }), child.stdout + child.stderr);
    await o.$disconnect(); dropLab(lab0);
  }

  const lab = await newLab("p3");
  const owner = client(lab.ownerUrl);
  await prodLikeRuntimeGrants(owner);
  const { a, b, c } = await seed(owner);

  // The definer must work even when its owner has NO BYPASSRLS: hand both functions
  // to a plain role before phase 3 resolves the owner for its policy.
  const fnOwner = `secc_fnown_${lab.db.slice(-8)}`;
  psql(lab.ownerUrl, `
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${fnOwner}') THEN CREATE ROLE ${fnOwner} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
    GRANT USAGE ON SCHEMA public TO ${fnOwner};
    GRANT SELECT ON "WhatsAppConnection", "POSApiKey" TO ${fnOwner};
    ALTER FUNCTION public.sec_c_whatsapp_business_by_phone_number_id(text) OWNER TO ${fnOwner};
    ALTER FUNCTION public.sec_c_pos_api_key_lookup(text) OWNER TO ${fnOwner};`);

  const { wa, pos, pue } = await appModules(lab.rtUrl);

  // ── state 1: migration applied, RLS not yet on — code must already work ──────
  ok("M14 state1: webhook lookup resolves via the definer function", (await wa.resolveBusinessIdByPhoneNumberId("pnA")) === a.businessId);
  ok("M14 state1: POS key lookup resolves via the definer function", (await pos.lookupPosApiKey("hashA"))?.businessId === a.businessId);

  // ── state 2: phase 3 ───────────────────────────────────────────────────────
  psqlFile(lab.ownerUrl, PHASE3);
  const rls = q(lab.ownerUrl, `SELECT string_agg(relname || '=' || relrowsecurity || '/' || relforcerowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relname IN ('WhatsAppConnection','POSApiKey','ProductUsageEvent')`);
  ok("M14 phase3: RLS enabled AND forced on all three tables", rls === "POSApiKey=true/true,ProductUsageEvent=true/true,WhatsAppConnection=true/true", rls);

  const rt = client(lab.rtUrl);
  const bWa = await fingerprint(owner, "WhatsAppConnection", b.businessId);
  const bPos = await fingerprint(owner, "POSApiKey", b.businessId);

  const bare = await asTenant(rt, null, `SELECT (SELECT count(*) FROM "WhatsAppConnection")::int AS w, (SELECT count(*) FROM "POSApiKey")::int AS p`);
  ok("M14 runtime without a tenant GUC sees 0 WhatsAppConnection and 0 POSApiKey rows", bare[0].w === 0 && bare[0].p === 0, bare);
  const scoped = await asTenant(rt, a.businessId, `SELECT (SELECT count(*) FROM "WhatsAppConnection")::int AS w, (SELECT count(*) FROM "POSApiKey")::int AS p, (SELECT count(*) FROM "WhatsAppConnection" WHERE "businessId" <> ${a.businessId})::int AS fw`);
  ok("M14 runtime inside tenant A sees only A's connection and key", scoped[0].w === 1 && scoped[0].p === 1 && scoped[0].fw === 0, scoped);

  const upd = await asTenant(rt, a.businessId, `WITH u AS (UPDATE "WhatsAppConnection" SET "lastErrorCode" = 'x' WHERE "businessId" = ${b.businessId} RETURNING 1) SELECT count(*)::int AS n FROM u`);
  ok("M14 tenant A cannot update tenant B's WhatsAppConnection (0 rows)", upd[0].n === 0, upd);
  const del = await asTenant(rt, a.businessId, `WITH d AS (DELETE FROM "POSApiKey" WHERE "businessId" = ${b.businessId} RETURNING 1) SELECT count(*)::int AS n FROM d`);
  ok("M14 tenant A cannot delete tenant B's POSApiKey (0 rows)", del[0].n === 0, del);
  const ins = await sqlError(asTenant(rt, a.businessId, `INSERT INTO "POSApiKey" ("businessId","keyHash","source") VALUES (${b.businessId}, 'forged', 'POS')`));
  ok("M14 tenant A cannot insert a POSApiKey for tenant B (42501 RLS)", ins?.code === "42501" && /row-level security/.test(ins.message), ins);

  ok("M14 webhook lookup under FORCE RLS: pnA -> A", (await wa.resolveBusinessIdByPhoneNumberId("pnA")) === a.businessId);
  ok("M14 webhook lookup under FORCE RLS: pnB -> B", (await wa.resolveBusinessIdByPhoneNumberId("pnB")) === b.businessId);
  ok("M14 webhook lookup: DISCONNECTED -> null", (await wa.resolveBusinessIdByPhoneNumberId("pnC")) === null);
  ok("M14 webhook lookup: unknown -> null", (await wa.resolveBusinessIdByPhoneNumberId("pn-unknown")) === null);
  ok("M14 tenant read path works under RLS (findPublicByBusinessId)", (await wa.findPublicByBusinessId(a.businessId))?.phoneNumberId === "pnA");
  await wa.markRevokedByMeta(a.businessId, { code: "LAB", message: "lab" });
  ok("M14 tenant write path works under RLS (markRevokedByMeta)", q(lab.ownerUrl, `SELECT status FROM "WhatsAppConnection" WHERE "businessId" = ${a.businessId}`) === "REVOKED_BY_META");
  const posA = await pos.lookupPosApiKey("hashA");
  ok("M14 POS key lookup under FORCE RLS returns only id/business/source/active", posA?.businessId === a.businessId && Object.keys(posA ?? {}).sort().join(",") === "active,businessId,id,source", posA);
  ok("M14 POS key lookup: unknown hash -> null", (await pos.lookupPosApiKey("nope")) === null);
  await pos.touchPosApiKey(a.businessId, posA!.id);
  ok("M14 POS lastUsedAt stamped inside the key's tenant", q(lab.ownerUrl, `SELECT ("lastUsedAt" IS NOT NULL)::text FROM "POSApiKey" WHERE id = ${posA!.id}`) === "true");

  const fnPublic = q(lab.ownerUrl, `SELECT string_agg(proname || ':' || prosecdef || ':' || has_function_privilege('public', oid, 'EXECUTE') || ':' || coalesce(array_to_string(proconfig, ';'), ''), ',' ORDER BY proname) FROM pg_proc WHERE proname LIKE 'sec\\_c\\_%'`);
  ok("M14 definer functions: SECURITY DEFINER, no PUBLIC execute, search_path pinned",
    fnPublic === "sec_c_pos_api_key_lookup:true:false:search_path=pg_catalog, public,sec_c_whatsapp_business_by_phone_number_id:true:false:search_path=pg_catalog, public", fnPublic);
  const outsider = await sqlError(client(lab.authUrl).$queryRawUnsafe(`SELECT public.sec_c_whatsapp_business_by_phone_number_id('pnA')`));
  ok("M14 a non-runtime identity cannot execute the lookup (42501)", outsider?.code === "42501", outsider);

  // ProductUsageEvent: append-only for the runtime, own tenant only.
  await pue.recordProductUsageEvent({ businessId: a.businessId, userId: a.userId, featureKey: "lab", action: "opened" } as never);
  await pue.recordProductUsageEvent({ featureKey: "lab", action: "anon" } as never);
  const pueCount = q(lab.ownerUrl, `SELECT count(*) FILTER (WHERE "businessId" = ${a.businessId}) || ',' || count(*) FILTER (WHERE "businessId" IS NULL) FROM "ProductUsageEvent"`);
  ok("M14 PUE: attributed + unattributed events are recorded by the real service", pueCount === "1,1", pueCount);
  const forged = await sqlError(asTenant(rt, a.businessId, `INSERT INTO "ProductUsageEvent" (id, "businessId", "featureKey", action) VALUES ('forged', ${b.businessId}, 'x', 'y')`));
  ok("M14 PUE: tenant A cannot write an event for tenant B (42501 RLS)", forged?.code === "42501" && /row-level security/.test(forged.message), forged);
  const readPue = await sqlError(asTenant(rt, a.businessId, `SELECT count(*) FROM "ProductUsageEvent"`));
  ok("M14 PUE: runtime cannot read telemetry at all (42501 permission denied)", readPue?.code === "42501" && /permission denied/.test(readPue.message), readPue);
  const adm = client(lab.admUrl);
  const admCount = await adm.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "ProductUsageEvent"`);
  ok("M14 PUE: platform admin reads across tenants via p7adm_read", admCount[0].n === 2, admCount);

  // M-14(d): the admin identity no longer reads the password hash.
  const admPw = await sqlError(adm.$queryRawUnsafe(`SELECT password FROM "User" LIMIT 1`));
  ok("M14(d) app_admin SELECT User.password -> 42501", admPw?.code === "42501", admPw);
  const admCols = await sqlError(adm.$queryRawUnsafe(`SELECT id, email, "lastLoginAt", "loginCount", "businessId" FROM "User" LIMIT 1`));
  ok("M14(d) app_admin still reads the columns the admin screens use", admCols === null, admCols);

  ok("M14 tenant B WhatsAppConnection + POSApiKey rows byte-unchanged",
    (await fingerprint(owner, "WhatsAppConnection", b.businessId)) === bWa && (await fingerprint(owner, "POSApiKey", b.businessId)) === bPos);
  void c;
  await adm.$disconnect(); await rt.$disconnect(); await owner.$disconnect();
  dropLab(lab);
  psql(process.env.SECC_PG_URL!, `DROP ROLE IF EXISTS ${fnOwner};`, { allowFail: true });
});
