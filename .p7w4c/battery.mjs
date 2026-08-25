/**
 * D2 / P7-W4C — Gmail tenant-isolation battery.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17: full provision incl. admin
 * foundation, matrix, rollback proof, re-apply) | neon (Preview: drift gates,
 * W4C apply, matrix on the real substrate as the real runtime+admin roles).
 *
 * Proves under FORCE RLS on EmailConnection/OAuthToken/EmailAttachmentImport:
 *  - real connect/callback (Google fully stubbed via a local fetch override):
 *    signed-state tenant binding, forged/expired/mismatch rejection, forged
 *    legacy cookie ignored, exchange-failure => zero partial persistence
 *  - status / disconnect (revoke stubbed; phased tx; B untouched)
 *  - token refresh: A refresh mutates only A's token
 *  - import E2E (pg only — Document grants are W4D scope on Preview):
 *    dedup, attachment fetch stubbed, OCR fail-safe path, import row under A
 *  - direct + parent-join RLS matrix, admin A+B read via app_admin (only
 *    EmailConnection), fail-closed, raw SQL backstop, concurrency,
 *    rollback + idempotent re-apply
 *
 * verify_only (W4C_VERIFY_ONLY=1): READ-ONLY substrate verification.
 * Synthetic p7w4c-* fixtures; token plaintext/ciphertext NEVER logged;
 * ZERO real Google calls.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const RT_PW = "p7w1_ci_synthetic_pw";
const ADMIN_LOGIN = process.env.ADMIN_LOGIN_ROLE || (TARGET === "neon" ? "app_admin_preview" : "app_admin_lab");
const ADMIN_PW = process.env.W2G_ADMIN_PW || "p7w2g_ci_synthetic_admin_pw";
const RUNTIME_URL_IN = process.env.RUNTIME_URL;
const MARK = "p7w4c-";
const W4C = ["EmailConnection", "OAuthToken", "EmailAttachmentImport"];
const VERIFY_ONLY = process.env.W4C_VERIFY_ONLY === "1";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

function assertEndpointSafety(url, label) {
  for (const bad of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (url.includes(bad)) throw new Error(`DENY: ${label} forbidden endpoint`);
  }
  if (TARGET === "neon" && !url.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error(`DENY: ${label} not the approved Preview endpoint`);
  }
}

function splitSql(sql) {
  return sql.split(/;\s*\r?\n/).map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  assertEndpointSafety(OWNER_URL, "DIRECT_URL");
  if (RUNTIME_URL_IN) assertEndpointSafety(RUNTIME_URL_IN, "RUNTIME_URL");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;
  console.log(`[battery] target=${TARGET} runtime=${RT_ROLE} verify_only=${VERIFY_ONLY}`);

  const applySqlFile = async (path, repl = {}) => {
    let sql = readFileSync(path, "utf8");
    for (const [k, v] of Object.entries(repl)) sql = sql.replaceAll(k, v);
    for (const stmt of splitSql(sql)) await owner.$executeRawUnsafe(stmt);
  };

  // ── Phase 1: pre-state + drift gates ────────────────────────────────────
  const foreign = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${W4C.map((t) => `'${t}'`).join(",")}) AND policyname NOT IN ('p7w4c_tenant','p7adm_read')`);
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on W4C tables: ${JSON.stringify(foreign)} — STOP`);

  if (TARGET === "neon") {
    const gates = [
      ["p4b_tenant", 5, ""],
      ["p7w1_tenant", 14, ""],
      ["p7w2_tenant", 24, ""],
      ["p7w3_tenant", 15, ""],
      ["p7w4b_tenant", 5, ""],
      ["p7adm_read", 3, " AND tablename IN ('Conversation','BillingDocument','ContentRun')"],
    ];
    for (const [pol, want, scope] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'${scope}`))[0].c);
      if (c !== want) throw new Error(`DRIFT: ${pol}=${c}, expected ${want} — STOP`);
    }
    for (const role of [RT_ROLE, "app_admin", ADMIN_LOGIN]) {
      const r = (await owner.$queryRawUnsafe(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${role}'`))[0];
      if (!r || r.rolsuper || r.rolbypassrls) throw new Error(`DRIFT: ${role} posture — STOP`);
    }
    console.log("[pre-state] pilot=5, w1=14, w2=24, w3=15, w4b=5, adm(scoped)=3, postures OK");
  }

  if (VERIFY_ONLY) {
    const w4c = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4c_tenant'`))[0].c);
    ok("verify-only: 3 W4C policies present", w4c === 3, `found ${w4c}`);
    const adm = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename='EmailConnection'`))[0].c);
    ok("verify-only: EmailConnection admin read policy present", adm === 1, `found ${adm}`);
    const forced = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4C.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
    ok("verify-only: 3 tables ENABLE+FORCE", forced === 3, `found ${forced}`);
    const g = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"EmailConnection"', 'SELECT') AS a, has_table_privilege('${RT_ROLE}', '"EmailConnection"', 'DELETE') AS b, has_table_privilege('${RT_ROLE}', '"OAuthToken"', 'DELETE') AS c2, has_table_privilege('app_admin', '"EmailConnection"', 'SELECT') AS d`))[0];
    ok("verify-only: grant posture (EC S=yes/D=no, token D=yes, admin S=yes)",
      g.a === true && g.b === false && g.c2 === true && g.d === true, JSON.stringify(g));
    const res = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz`);
    ok("verify-only: synthetic residue = 0", Number(res[0].biz) === 0);
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ── Phase 2 (pg only): lab substrate incl. admin foundation ─────────────
  if (TARGET === "pg") {
    const mk = async (sqlRole, create) => {
      const exists = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${sqlRole}'`))[0].c) > 0;
      if (!exists) await owner.$executeRawUnsafe(create);
    };
    await mk(RT_ROLE, `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    await mk(ADMIN_LOGIN, `CREATE ROLE ${ADMIN_LOGIN} LOGIN PASSWORD '${ADMIN_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
    // app_admin group + its canonical policies come from the W2-GATE migration.
    await applySqlFile("prisma/migrations/20260825090000_d2_p7_w2gate_admin_read/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w2gate-admin-grants.sql", { ":LOGIN_ROLE": ADMIN_LOGIN });
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    // LAB-ONLY: Document-side grants so the import E2E works (W4D scope on
    // Preview; canonical W4C artifacts do NOT include these).
    for (const t of ["Document", "ExtractedData", "ExtractionSnapshot", "SliceDecision", "ProductUsageEvent"]) {
      await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "${t}" TO ${RT_ROLE}`);
      await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE "${t}_id_seq" TO ${RT_ROLE}`);
    }
  }

  // ── Phase 3: apply W4C migration + grants ───────────────────────────────
  await applySqlFile("prisma/migrations/20260826200000_d2_p7_w4c_gmail_tenant_rls/migration.sql");
  await applySqlFile("scripts/security/d2-p7-w4c-grants.sql", { ":ROLE": RT_ROLE });
  const w4cPol = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4c_tenant'`))[0].c);
  ok("3 p7w4c_tenant policies installed", w4cPol === 3, `found ${w4cPol}`);
  const admPol = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename='EmailConnection'`))[0].c);
  ok("EmailConnection admin read policy installed", admPol === 1);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4C.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
  ok("3 tables ENABLE+FORCE RLS", forced === 3, `found ${forced}`);

  // ── Phase 4: env + app import under the RUNTIME role ────────────────────
  let RUNTIME_URL = RUNTIME_URL_IN;
  if (TARGET === "pg") {
    const u = new URL(OWNER_URL);
    u.username = RT_ROLE; u.password = RT_PW;
    RUNTIME_URL = u.toString();
  }
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "p7w4c_auth_secret_synthetic";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "p7w4c-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "p7w4c-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL = "http://p7w4c.local";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = createHash("sha256").update("p7w4c-synthetic").digest("hex");

  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const { encryptToken } = await import("@/lib/services/integrations/gmail/token-crypto.placeholder");
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const adminUrl = new URL(OWNER_URL.includes("pooler") ? OWNER_URL : RUNTIME_URL);
  {
    const u = new URL(RUNTIME_URL);
    u.username = ADMIN_LOGIN; u.password = ADMIN_PW;
    var ADMIN_URL = u.toString();
  }
  const adm = new PrismaClient({ datasourceUrl: ADMIN_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`runtime current_user = ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);
  const whoA = (await adm.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`admin current_user = ${ADMIN_LOGIN}`, whoA === ADMIN_LOGIN, `got ${whoA}`);

  // ── Phase 5: fixtures ───────────────────────────────────────────────────
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "OAuthToken" WHERE "connectionId" IN (SELECT id FROM "EmailConnection" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "ExtractedData" WHERE "documentId" IN (SELECT id FROM "Document" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "ExtractionEvidence" WHERE "extractionSnapshotId" IN (SELECT id FROM "ExtractionSnapshot" WHERE "businessId" IN (${bids}))`);
    for (const t of ["EmailAttachmentImport", "EmailConnection", "ExtractionSnapshot", "SliceDecision", "Document", "ProductUsageEvent"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w4c.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w4c.test", password: "x", businessId: bizA.id } });
  const encA = encryptToken("synthetic-access-A");
  const refA = encryptToken("synthetic-refresh-A");
  const encB = encryptToken("synthetic-access-B");
  const refB = encryptToken("synthetic-refresh-B");
  const mkConn = async (biz, email, acc, ref, expiresMs) => {
    const c = await owner.emailConnection.create({
      data: { businessId: biz, provider: "gmail", status: "connected", emailAddress: email, providerAccountId: email, scopes: "gmail.readonly" },
    });
    await owner.oAuthToken.create({
      data: { connectionId: c.id, accessTokenEncrypted: acc.encrypted, refreshTokenEncrypted: ref.encrypted, expiresAt: new Date(Date.now() + expiresMs), encryptionKeyId: acc.keyId },
    });
    return c;
  };
  const connA = await mkConn(bizA.id, "a@p7w4c.test", encA, refA, 3600_000);
  const connB = await mkConn(bizB.id, "b@p7w4c.test", encB, refB, 3600_000);
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id] };

  // ── Phase 6: direct + indirect RLS matrix ───────────────────────────────
  console.log("--- direct + indirect RLS ---");
  const aConns = await rtx(rt, bizA.id, (t) => t.emailConnection.findMany({ where: { businessId: inIds } }));
  ok("A sees only A connections", aConns.length === 1 && aConns[0].id === connA.id);
  const aTokens = await rtx(rt, bizA.id, (t) => t.oAuthToken.findMany({}));
  ok("A sees only A token (parent-join)", aTokens.length === 1 && aTokens[0].connectionId === connA.id);
  const updX = await rtx(rt, bizA.id, (t) => t.emailConnection.updateMany({ where: { id: connB.id }, data: { status: "revoked" } }));
  ok("cross-tenant connection UPDATE = 0 rows", updX.count === 0);
  const tokX = await rtx(rt, bizA.id, (t) => t.oAuthToken.updateMany({ where: { connectionId: connB.id }, data: { tokenType: "evil" } }));
  ok("cross-tenant token UPDATE = 0 rows", tokX.count === 0);
  const delX = await rtx(rt, bizA.id, (t) => t.oAuthToken.deleteMany({ where: { connectionId: connB.id } }));
  ok("cross-tenant token DELETE = 0 rows", delX.count === 0);
  let wrongTok = false;
  try {
    await rtx(rt, bizA.id, (t) => t.oAuthToken.create({
      data: { connectionId: connB.id, accessTokenEncrypted: "x", expiresAt: new Date(), encryptionKeyId: "k" } }));
  } catch { wrongTok = true; }
  ok("wrong-parent OAuthToken INSERT rejected", wrongTok);
  let wrongConn = false;
  try {
    await rtx(rt, bizA.id, (t) => t.emailConnection.create({
      data: { businessId: bizB.id, provider: "gmail", status: "connected", emailAddress: "e@x", providerAccountId: "e", scopes: "s" } }));
  } catch { wrongConn = true; }
  ok("wrong-tenant EmailConnection INSERT rejected", wrongConn);

  // ── Phase 7: Google-stubbed fetch ───────────────────────────────────────
  const realFetch = globalThis.fetch;
  let exchangeMode = "ok";
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.includes("oauth2.googleapis.com/token")) {
      if (exchangeMode === "fail") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({
        access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, token_type: "Bearer",
        scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("openidconnect.googleapis.com")) {
      return new Response(JSON.stringify({ sub: "sub-new", email: "new@p7w4c.test" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("oauth2.googleapis.com/revoke")) {
      return new Response("{}", { status: 200 });
    }
    if (s.includes("gmail/v1/users/me/messages/") && s.includes("/attachments/")) {
      return new Response(JSON.stringify({ size: 8, data: Buffer.from("w4cbytes").toString("base64url") }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };

  // ── Phase 8: connect + callback real handlers ───────────────────────────
  console.log("--- connect/callback (real handlers, Google stubbed) ---");
  const gmailConnect = await import("@/app/api/integrations/gmail/connect/route");
  const gmailCallback = await import("@/app/api/integrations/gmail/callback/route");
  const { verifySignedGmailState } = await import("@/lib/services/integrations/gmail/signed-state.service");
  const tokA = signAuthToken(userA.id);
  let res = await gmailConnect.GET(new NextRequest("http://p7w4c.local/api/integrations/gmail/connect", {
    headers: { authorization: `Bearer ${tokA}` } }));
  ok("connect 200", res.status === 200);
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookieVal = (name) => {
    const c = setCookies.find((x) => x.startsWith(`${name}=`));
    return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
  };
  const stA = cookieVal("gmail_oauth_state");
  const verA = cookieVal("gmail_oauth_code_verifier");
  const stCheck = verifySignedGmailState(stA);
  ok("connect state binds tenant A", stCheck.ok && stCheck.state.businessId === bizA.id);
  const cbReq = (state, cookies) =>
    new NextRequest(`http://p7w4c.local/api/integrations/gmail/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookies } });
  const baseCookies = (state) =>
    `gmail_oauth_state=${encodeURIComponent(state)}; gmail_oauth_code_verifier=${encodeURIComponent(verA)}`;

  // Forged businessId inside state → rejected.
  const [pB64] = stA.split(".");
  const tampered = JSON.parse(Buffer.from(pB64, "base64url").toString());
  tampered.businessId = bizB.id;
  const forgedState = Buffer.from(JSON.stringify(tampered)).toString("base64url") + "." + stA.split(".")[1];
  res = await gmailCallback.GET(cbReq(forgedState, baseCookies(forgedState)));
  ok("tampered-businessId state rejected", (res.headers.get("location") || "").includes("gmail_state_invalid"));
  // Forged nonce → rejected.
  const t2 = JSON.parse(Buffer.from(pB64, "base64url").toString());
  t2.nonce = "attacker";
  const forgedNonce = Buffer.from(JSON.stringify(t2)).toString("base64url") + "." + stA.split(".")[1];
  res = await gmailCallback.GET(cbReq(forgedNonce, baseCookies(forgedNonce)));
  ok("tampered-nonce state rejected", (res.headers.get("location") || "").includes("gmail_state_invalid"));
  // Mismatch → rejected.
  res = await gmailCallback.GET(cbReq(stA, baseCookies("other")));
  ok("state/cookie mismatch rejected", (res.headers.get("location") || "").includes("gmail_state_invalid"));
  // Expired → rejected (verify-fn shifted clock; route path identical).
  ok("expired state rejected", verifySignedGmailState(stA, Date.now() + 11 * 60 * 1000).ok === false);
  // Exchange failure → NO partial persistence.
  exchangeMode = "fail";
  const preConnCount = await owner.emailConnection.count({ where: { businessId: bizA.id } });
  res = await gmailCallback.GET(cbReq(stA, baseCookies(stA)));
  ok("exchange failure -> error redirect + zero partial rows",
    (res.headers.get("location") || "").includes("gmail_token_exchange_failed") &&
    (await owner.emailConnection.count({ where: { businessId: bizA.id } })) === preConnCount);
  exchangeMode = "ok";
  // Valid callback + forged legacy cookie=B → lands under A.
  res = await gmailCallback.GET(cbReq(stA, baseCookies(stA) + `; gmail_oauth_business_id=${bizB.id}`));
  ok("valid callback connected", (res.headers.get("location") || "").includes("connected=1"), res.headers.get("location") || "");
  const newConn = await owner.emailConnection.findFirst({ where: { emailAddress: "new@p7w4c.test" } });
  ok("callback persisted under STATE tenant A (forged cookie ignored)", newConn?.businessId === bizA.id);
  ok("token persisted atomically", !!newConn && !!(await owner.oAuthToken.findUnique({ where: { connectionId: newConn.id } })));

  // ── Phase 9: status / disconnect / refresh / import ─────────────────────
  console.log("--- status / disconnect / refresh / import ---");
  const statusRoute = await import("@/app/api/integrations/gmail/status/route");
  res = await statusRoute.GET(new NextRequest("http://p7w4c.local/api/integrations/gmail/status", {
    headers: { authorization: `Bearer ${tokA}` } }));
  const stBody = await res.json();
  ok("status: A sees only A connections", res.status === 200 &&
    stBody.connections.length === 2 && stBody.connections.every((c) => [connA.id, newConn.id].includes(c.id)));

  const discRoute = await import("@/app/api/integrations/gmail/disconnect/route");
  res = await discRoute.POST(new NextRequest("http://p7w4c.local/api/integrations/gmail/disconnect", {
    method: "POST", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
    body: JSON.stringify({ connectionId: connB.id }) }));
  ok("disconnect of B's connection as A -> 404", res.status === 404);
  ok("B token intact", !!(await owner.oAuthToken.findUnique({ where: { connectionId: connB.id } })));
  res = await discRoute.POST(new NextRequest("http://p7w4c.local/api/integrations/gmail/disconnect", {
    method: "POST", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
    body: JSON.stringify({ connectionId: newConn.id }) }));
  ok("disconnect own connection works (revoke stubbed)", res.status === 200 &&
    (await owner.emailConnection.findUnique({ where: { id: newConn.id } }))?.status === "revoked" &&
    (await owner.oAuthToken.findUnique({ where: { connectionId: newConn.id } })) === null);

  // Refresh: expire A's token → auth service refreshes only A's.
  await owner.oAuthToken.update({ where: { connectionId: connA.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const bTokBefore = await owner.oAuthToken.findUnique({ where: { connectionId: connB.id } });
  const { getGmailAccessTokenForBusiness } = await import("@/lib/services/integrations/gmail/gmail-auth.service");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const refreshed = await runWithTenantContext({ businessId: bizA.id }, () =>
    getGmailAccessTokenForBusiness({ businessId: bizA.id }));
  const aTokAfter = await owner.oAuthToken.findUnique({ where: { connectionId: connA.id } });
  const bTokAfter = await owner.oAuthToken.findUnique({ where: { connectionId: connB.id } });
  ok("refresh mutates only A token", refreshed.connectionId === connA.id &&
    aTokAfter.expiresAt.getTime() > Date.now() &&
    bTokAfter.accessTokenEncrypted === bTokBefore.accessTokenEncrypted);

  if (TARGET === "pg") {
    const importRoute = await import("@/app/api/integrations/gmail/import/route");
    const impReq = (body) => new NextRequest("http://p7w4c.local/api/integrations/gmail/import", {
      method: "POST", headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
      body: JSON.stringify(body) });
    res = await importRoute.POST(impReq({ messageId: "m1", attachmentId: "a1", mimeType: "application/pdf", filename: "f.pdf" }));
    const impBody = await res.json();
    ok("import E2E under A (Gmail stubbed, OCR fail-safe)", res.status === 200 && impBody.imported === true,
      `status=${res.status} ${JSON.stringify(impBody).slice(0, 120)}`);
    const impRow = await owner.emailAttachmentImport.findFirst({ where: { businessId: bizA.id, messageId: "m1" } });
    ok("import row under A, linked to A document", impRow?.businessId === bizA.id && !!impRow?.documentId &&
      (await owner.document.findUnique({ where: { id: impRow.documentId } }))?.businessId === bizA.id);
    // Replay → duplicate skip.
    res = await importRoute.POST(impReq({ messageId: "m1", attachmentId: "a1", mimeType: "application/pdf" }));
    const rep = await res.json();
    ok("import replay -> duplicate skip", rep.skipped === "duplicate");
    // Foreign connectionId nomination → 404.
    res = await importRoute.POST(impReq({ messageId: "m2", attachmentId: "a2", mimeType: "application/pdf", connectionId: connB.id }));
    ok("foreign connectionId nomination -> 404", res.status === 404);
  } else {
    console.log("[note] import E2E is PG-only (Document grants are W4D scope on Preview) — EmailAttachmentImport isolation proven via direct matrix");
    const { withTenantTransaction } = await import("@/lib/tenant/transaction");
    const created = await runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction((tx) => tx.emailAttachmentImport.create({
        data: { businessId: bizA.id, connectionId: connA.id, provider: "gmail", messageId: "m1", attachmentId: "a1", mimeType: "application/pdf", contentHashSha256: "h1", status: "imported" } })));
    ok("EmailAttachmentImport create under ctx works", created.businessId === bizA.id);
  }
  const eaiX = await rtx(rt, bizB.id, (t) => t.emailAttachmentImport.findMany({ where: { businessId: bizA.id } }));
  ok("B cannot read A's import rows", eaiX.length === 0);

  // ── Phase 10: admin read ────────────────────────────────────────────────
  console.log("--- admin read ---");
  const admConns = await adm.emailConnection.findMany({ where: { businessId: inIds } });
  ok("admin sees A+B EmailConnection", admConns.length >= 2 &&
    new Set(admConns.map((c) => c.businessId)).size === 2);
  let admTokDenied = false;
  try { await adm.oAuthToken.findMany({}); } catch { admTokDenied = true; }
  ok("admin OAuthToken read denied (no grant/policy)", admTokDenied);
  let admWrite = false;
  try { await adm.emailConnection.updateMany({ where: {}, data: { lastError: "x" } }); } catch { admWrite = true; }
  ok("admin EmailConnection write denied", admWrite);

  // ── Phase 11: fail-closed + raw SQL + concurrency ───────────────────────
  console.log("--- fail-closed + raw + concurrency ---");
  ok("no context -> 0 connections", (await rt.emailConnection.findMany({ where: { businessId: inIds } })).length === 0);
  const emptyCtx = await rt.$transaction(async (t) => {
    await t.$queryRaw`SELECT set_config('app.current_business_id', '', true)`;
    return t.oAuthToken.findMany({});
  });
  ok("empty context -> 0 tokens", emptyCtx.length === 0);
  let malformed = false;
  try {
    await rt.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'evil', true)`;
      return t.emailConnection.findMany({});
    });
  } catch { malformed = true; }
  ok("malformed context errors", malformed);
  const rawEC = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "EmailConnection"`));
  ok("raw EmailConnection = tenant-only", Number(rawEC[0].c) === (await owner.emailConnection.count({ where: { businessId: bizA.id } })));
  const rawTok = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "OAuthToken"`));
  ok("raw OAuthToken = own-parent only", Number(rawTok[0].c) === 1);
  let rawIns = false;
  try {
    await rtx(rt, bizA.id, (t) => t.$executeRawUnsafe(
      `INSERT INTO "EmailConnection" ("businessId","provider","status","emailAddress","providerAccountId","scopes","updatedAt") VALUES (${bizB.id}, 'gmail', 'connected', 'x@x', 'x', 's', now())`));
  } catch { rawIns = true; }
  ok("raw wrong-tenant INSERT WITH CHECK denied", rawIns);
  let ddl = false;
  try { await rt.$executeRawUnsafe(`CREATE TABLE p7w4c_evil (id int)`); } catch { ddl = true; }
  ok("runtime DDL denied", ddl);
  let mig = false;
  try { await rt.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`); } catch { mig = true; }
  ok("runtime _prisma_migrations denied", mig);
  let ecDel = false;
  try { await rtx(rt, bizA.id, (t) => t.emailConnection.deleteMany({ where: { businessId: bizA.id } })); } catch { ecDel = true; }
  ok("runtime DELETE on EmailConnection denied (never granted)", ecDel);

  const [ca, cb] = await Promise.all([
    rtx(rt, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.04)"); return t.emailConnection.count({}); }),
    rtx(rt2, bizB.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return t.emailConnection.count({}); }),
  ]);
  ok("concurrent A/B isolation", ca === (await owner.emailConnection.count({ where: { businessId: bizA.id } })) && cb === 1, `a=${ca} b=${cb}`);
  let rolled = false;
  try {
    const { withTenantTransaction } = await import("@/lib/tenant/transaction");
    await runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction(async (tx) => {
        await tx.emailConnection.create({ data: { businessId: bizA.id, provider: "gmail", status: "connected", emailAddress: "rb@x", providerAccountId: "rb", scopes: "s" } });
        throw new Error("forced rollback");
      }));
  } catch { rolled = true; }
  ok("rollback discards tenant write", rolled && (await owner.emailConnection.count({ where: { emailAddress: "rb@x" } })) === 0);

  globalThis.fetch = realFetch;
  await rt.$disconnect(); await rt2.$disconnect(); await adm.$disconnect();

  // ── Phase 12 (pg only): rollback proof + re-apply ───────────────────────
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-w4c-rollback.sql", { ":ROLE": RT_ROLE });
    const polAfter = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4c_tenant'`))[0].c);
    ok("rollback: 0 p7w4c policies remain", polAfter === 0, `found ${polAfter}`);
    const admScoped = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7adm_read' AND tablename IN ('Conversation','BillingDocument')`))[0].c);
    ok("rollback: W2-GATE admin policies intact", admScoped === 2, `found ${admScoped}`);
    const canSel = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"EmailConnection"', 'SELECT') AS p`))[0].p;
    ok("rollback: runtime grants revoked", canSel === false);
    await applySqlFile("prisma/migrations/20260826200000_d2_p7_w4c_gmail_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w4c-grants.sql", { ":ROLE": RT_ROLE });
    const polRe = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4c_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", polRe === 3, `found ${polRe}`);
  }

  // ── Phase 13: cleanup + prior-substrate integrity ───────────────────────
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz, (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w4c.test') AS usr`);
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));
  if (TARGET === "neon") {
    const gates = [["p4b_tenant", 5], ["p7w1_tenant", 14], ["p7w2_tenant", 24], ["p7w3_tenant", 15], ["p7w4b_tenant", 5]];
    let intact = true;
    for (const [pol, want] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'`))[0].c);
      if (c !== want) intact = false;
    }
    ok("pilot+W1+W2+W3+W4B substrate intact after W4C", intact);
  }

  await owner.$disconnect();
  console.log(`\n[battery] target=${TARGET} PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch(async (e) => {
  const { inspect } = await import("node:util");
  console.error("[battery] FATAL:", inspect(e, { depth: 4 }).slice(0, 2500));
  process.exit(1);
});
