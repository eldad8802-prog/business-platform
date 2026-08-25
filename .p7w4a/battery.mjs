/**
 * D2 / P7-W4A — async + provider tenant-context foundation battery (PG17).
 *
 * Proves, against a real PG17 with a non-bypass runtime role and LAB-ONLY
 * FORCE-RLS policies (Customer/Conversation mirroring the Preview pilot, plus
 * Message/Document to exercise the new W4A wiring):
 *
 *  - runTenantJob explicit context (A→A, B→B, no inherited ALS)
 *  - real WhatsApp webhook handler: trusted phone_number_id→tenant mapping,
 *    forged payload businessId ignored, unknown mapping denied, replay +
 *    concurrent duplicates collapse via the tenant-scoped Message unique,
 *    same wamid in A and B does NOT cross-dedup
 *  - DB resolution failure CANNOT activate the env fallback (flag+map set,
 *    grant revoked → loud failure, no fallback tenant)
 *  - production block: env fallback inert under NODE_ENV=production
 *  - documents pipeline after()-style continuation reconstructs context and
 *    its tenant transaction cannot touch a foreign document
 *  - real Gmail connect/callback: signed state binds the tenant; a forged
 *    legacy businessId cookie is ignored (connection lands under the state's
 *    tenant, with Google mocked via a local fetch stub)
 *  - fail-closed GUC, rollback cleanup, DDL denied
 *  - structural no-network-in-tx ordering assertions for the W4A files
 *
 * LAB-ONLY: all policies/roles here are battery-local. NO canonical RLS is
 * added by W4A. Synthetic p7w4a-* fixtures only; ZERO Neon; ZERO secrets.
 */
import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";

const RT_ROLE = "wave1_runtime";
const RT_PW = "p7w1_ci_synthetic_pw";
const MARK = "p7w4a-";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;

  // ── Phase 1: lab substrate (owner) ──────────────────────────────────────
  const rtExists = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
  if (!rtExists) {
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
  }
  const DML = ["Customer","Conversation","Message","MessageAnalysis","ReplySuggestion","Document","ExtractedData","EmailConnection","OAuthToken","ExtractionSnapshot","SliceDecision","ExtractionEvidence","ProductUsageEvent","WhatsAppAttachmentImport"];
  for (const t of DML) {
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "${t}" TO ${RT_ROLE}`);
    await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE "${t}_id_seq" TO ${RT_ROLE}`).catch?.(() => {});
  }
  await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business", "WhatsAppConnection", "BusinessBot", "BusinessBotSettings" TO ${RT_ROLE}`);

  // LAB-ONLY policies: pilot mirror (Customer/Conversation) + W4A exercise
  // targets (Message/Document). NOT canonical artifacts.
  const GUC = `NULLIF(current_setting('app.current_business_id', true), '')::int`;
  for (const t of ["Customer","Conversation","Message","Document"]) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS w4a_lab ON "${t}"`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY w4a_lab ON "${t}" USING ("businessId" = ${GUC}) WITH CHECK ("businessId" = ${GUC})`);
  }
  console.log("[lab] runtime role + grants + LAB-ONLY policies ready");

  // ── Phase 2: fixtures (owner) ───────────────────────────────────────────
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    for (const t of ["MessageAnalysis"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "messageId" IN (SELECT id FROM "Message" WHERE "businessId" IN (${bids}))`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "OAuthToken" WHERE "connectionId" IN (SELECT id FROM "EmailConnection" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "ExtractionEvidence" WHERE "extractionSnapshotId" IN (SELECT id FROM "ExtractionSnapshot" WHERE "businessId" IN (${bids}))`);
    await owner.$executeRawUnsafe(`DELETE FROM "ExtractedData" WHERE "documentId" IN (SELECT id FROM "Document" WHERE "businessId" IN (${bids}))`);
    for (const t of ["ReplySuggestion","Message","Conversation","Customer","Document","EmailConnection","ExtractionSnapshot","SliceDecision","ProductUsageEvent","WhatsAppAttachmentImport","WhatsAppConnection"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w4a.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w4a.test", password: "x", businessId: bizA.id } });
  const PN_A = `${MARK}pn-A`;
  const PN_B = `${MARK}pn-B`;
  const connRow = (biz, pn) => ({
    businessId: biz, phoneNumberId: pn, displayPhoneNumber: pn,
    wabaId: `${MARK}waba`, accessTokenEncrypted: "x", accessTokenIv: "x",
    accessTokenTag: "x", status: "CONNECTED",
  });
  await owner.whatsAppConnection.create({ data: connRow(bizA.id, PN_A) });
  await owner.whatsAppConnection.create({ data: connRow(bizB.id, PN_B) });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id}`);

  // ── Phase 3: app import under the RUNTIME role ──────────────────────────
  const u = new URL(OWNER_URL);
  u.username = RT_ROLE; u.password = RT_PW;
  const RUNTIME_URL = u.toString();
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.WHATSAPP_APP_SECRET = "p7w4a_synthetic_app_secret";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "p7w4a_verify_token";
  process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "p7w4a_auth_secret_synthetic";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "p7w4a-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "p7w4a-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL = "http://p7w4a.local";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = createHash("sha256").update("p7w4a-synthetic").digest("hex");
  delete process.env.WHATSAPP_ALLOW_ENV_FALLBACK;
  delete process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP;

  const { NextRequest } = await import("next/server");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const { getTenantContext } = await import("@/lib/tenant/context");
  const waRoute = await import("@/app/api/integrations/whatsapp/webhook/route");
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`runtime current_user = ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);

  const sign = (body) =>
    "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(body, "utf8").digest("hex");
  const waPayload = (pn, wamid, text, extra = {}) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "e1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: pn },
        messages: [{ id: wamid, from: "972501234567", type: "text", text: { body: text }, ...extra }],
        ...extra.valueExtra ?? {},
      } }] }],
    });
  const postWa = (body, sig) =>
    waRoute.POST(new NextRequest("http://p7w4a.local/api/integrations/whatsapp/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig ?? sign(body) },
      body,
    }));

  // ── Phase 4: runTenantJob core on real DB ───────────────────────────────
  console.log("--- runTenantJob + explicit async context ---");
  const jobA = await runTenantJob({ businessId: bizA.id }, async () => getTenantContext()?.businessId);
  const jobB = await runTenantJob({ businessId: bizB.id }, async () => getTenantContext()?.businessId);
  ok("explicit async context A / B", jobA === bizA.id && jobB === bizB.id);
  ok("no ambient context outside jobs", getTenantContext() === undefined);

  // ── Phase 5: WhatsApp real-route matrix ─────────────────────────────────
  console.log("--- WhatsApp webhook (real handler) ---");
  let res = await waRoute.GET(new NextRequest(
    `http://p7w4a.local/x?hub.mode=subscribe&hub.verify_token=${process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN}&hub.challenge=c123`));
  ok("GET verify handshake", res.status === 200 && (await res.text()) === "c123");
  res = await postWa(waPayload(PN_A, `${MARK}wam-1`, "hello"), "sha256=" + "0".repeat(64));
  ok("bad signature -> 401", res.status === 401, `status=${res.status}`);

  res = await postWa(waPayload(PN_A, `${MARK}wam-1`, "hello A"));
  ok("A text intake -> 200", res.status === 200);
  const msgA = await owner.message.findFirst({ where: { businessId: bizA.id, providerMessageId: `${MARK}wam-1` } });
  ok("A message persisted under tenant A (FORCE RLS lab)", !!msgA, "no row");
  ok("A conversation + customer created", !!msgA && (await owner.conversation.count({ where: { businessId: bizA.id } })) === 1);

  res = await postWa(waPayload(PN_B, `${MARK}wam-2`, "hello B"));
  const msgB = await owner.message.findFirst({ where: { businessId: bizB.id, providerMessageId: `${MARK}wam-2` } });
  ok("B text intake lands under tenant B", res.status === 200 && !!msgB);

  // Forged tenant hint: attacker adds businessId fields to the payload.
  res = await postWa(waPayload(PN_A, `${MARK}wam-forged`, "forged", { businessId: bizB.id, valueExtra: { businessId: bizB.id } }));
  const forged = await owner.message.findFirst({ where: { providerMessageId: `${MARK}wam-forged` } });
  ok("forged payload businessId ignored (lands under key's tenant A)", !!forged && forged.businessId === bizA.id, JSON.stringify(forged?.businessId));

  // Unknown mapping: fail-closed ignore, no context, no rows.
  const beforeCnt = await owner.message.count();
  res = await postWa(waPayload(`${MARK}pn-unknown`, `${MARK}wam-3`, "ghost"));
  ok("unknown phone_number_id -> 200 + zero rows", res.status === 200 && (await owner.message.count()) === beforeCnt);

  // Replay: same wamid again → still exactly one message.
  res = await postWa(waPayload(PN_A, `${MARK}wam-1`, "hello A again"));
  const dupCount = await owner.message.count({ where: { businessId: bizA.id, providerMessageId: `${MARK}wam-1` } });
  ok("replayed wamid stays a single logical message", res.status === 200 && dupCount === 1, `count=${dupCount}`);

  // Concurrency: two simultaneous deliveries of a fresh wamid → exactly 1 row.
  const rawConc = waPayload(PN_A, `${MARK}wam-conc`, "race");
  await Promise.all([postWa(rawConc), postWa(rawConc)]);
  const concCount = await owner.message.count({ where: { businessId: bizA.id, providerMessageId: `${MARK}wam-conc` } });
  ok("concurrent duplicate deliveries -> exactly 1 message", concCount === 1, `count=${concCount}`);

  // Cross-tenant NON-dedup: same provider id in A and B must both exist.
  const sharedWamid = `${MARK}wam-shared`;
  await postWa(waPayload(PN_A, sharedWamid, "shared A"));
  await postWa(waPayload(PN_B, sharedWamid, "shared B"));
  const sharedRows = await owner.message.findMany({ where: { providerMessageId: sharedWamid } });
  ok("same wamid in A and B does not cross-dedup", sharedRows.length === 2 &&
    new Set(sharedRows.map((r) => r.businessId)).size === 2, `rows=${sharedRows.length}`);

  // ── Phase 6: env fallback safety ────────────────────────────────────────
  console.log("--- env fallback safety ---");
  const { resolveBusinessFromPhoneNumberId } = await import("@/lib/services/integrations/whatsapp/business-resolve.service");
  const { resetBusinessResolveCacheForTests } = await import("@/lib/services/integrations/whatsapp/business-resolve.service");

  // Production block: flag + map set, NODE_ENV=production → fallback inert.
  const realNodeEnv = process.env.NODE_ENV;
  process.env.WHATSAPP_ALLOW_ENV_FALLBACK = "1";
  process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP = JSON.stringify({ [`${MARK}pn-env`]: bizB.id });
  resetBusinessResolveCacheForTests();
  process.env.NODE_ENV = "production";
  const prodRes = await resolveBusinessFromPhoneNumberId(`${MARK}pn-env`);
  ok("production: env fallback CANNOT resolve a tenant", prodRes.ok === false && prodRes.reason === "unknown_phone_number_id", JSON.stringify(prodRes));
  process.env.NODE_ENV = realNodeEnv;

  // Dev compat: same inputs outside production → fallback works (explicit).
  resetBusinessResolveCacheForTests();
  const devRes = await resolveBusinessFromPhoneNumberId(`${MARK}pn-env`);
  ok("non-production: explicit env fallback still works for tests", devRes.ok === true && devRes.businessId === bizB.id, JSON.stringify(devRes));

  // DB FAILURE must NOT fall through to the env map: revoke the runtime's
  // SELECT on WhatsAppConnection and add the DB-known pn to the env map with
  // a DIFFERENT tenant — the lookup must throw, never resolve to the env tenant.
  process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP = JSON.stringify({ [PN_A]: bizB.id });
  resetBusinessResolveCacheForTests();
  await owner.$executeRawUnsafe(`REVOKE SELECT ON "WhatsAppConnection" FROM ${RT_ROLE}`);
  let dbFailOutcome = "resolved";
  try {
    const r = await resolveBusinessFromPhoneNumberId(PN_A);
    dbFailOutcome = JSON.stringify(r);
  } catch {
    dbFailOutcome = "threw";
  }
  ok("DB resolution failure throws loudly (no env fallback tenant)", dbFailOutcome === "threw", dbFailOutcome);
  // Whole-webhook behavior under DB failure: 200 (per-message catch), zero rows.
  const preFailCnt = await owner.message.count();
  res = await postWa(waPayload(PN_A, `${MARK}wam-dbfail`, "during outage"));
  ok("webhook during DB failure: 200 + no rows + no fallback context", res.status === 200 && (await owner.message.count()) === preFailCnt);
  await owner.$executeRawUnsafe(`GRANT SELECT ON "WhatsAppConnection" TO ${RT_ROLE}`);
  delete process.env.WHATSAPP_ALLOW_ENV_FALLBACK;
  delete process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP;
  resetBusinessResolveCacheForTests();

  // ── Phase 7: documents after()-style continuation ───────────────────────
  console.log("--- documents pipeline continuation ---");
  const { processDocumentPipeline } = await import("@/lib/services/documents/process-document-pipeline.service");
  const docA = await owner.document.create({
    data: { businessId: bizA.id, fileUrl: `${MARK}a.png`, source: "upload", status: "processing", mimeType: "image/png" },
  });
  const tinyPng = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await runTenantJob({ businessId: bizA.id }, () =>
    processDocumentPipeline({
      documentId: docA.id, businessId: bizA.id, userId: userA.id,
      sessionId: null, buffer: tinyPng, mimeType: "image/png", sourceChannel: "upload",
    })
  );
  const docAAfter = await owner.document.findUnique({ where: { id: docA.id } });
  ok("A continuation advanced A's document under FORCE RLS",
    !!docAAfter && docAAfter.status !== "processing", `status=${docAAfter?.status}`);

  const docA2 = await owner.document.create({
    data: { businessId: bizA.id, fileUrl: `${MARK}a2.png`, source: "upload", status: "processing", mimeType: "image/png" },
  });
  // Adversarial: a B-context job pointed at A's document must NOT mutate it.
  await runTenantJob({ businessId: bizB.id }, () =>
    processDocumentPipeline({
      documentId: docA2.id, businessId: bizB.id, userId: userA.id,
      sessionId: null, buffer: tinyPng, mimeType: "image/png", sourceChannel: "upload",
    })
  );
  const docA2After = await owner.document.findUnique({ where: { id: docA2.id } });
  ok("B-context continuation cannot touch A's document",
    docA2After?.status === "processing", `status=${docA2After?.status}`);

  // ── Phase 8: Gmail signed-state + callback (Google mocked locally) ──────
  console.log("--- gmail connect/callback (fetch stubbed) ---");
  const { signAuthToken } = await import("@/lib/auth-token");
  const gmailConnect = await import("@/app/api/integrations/gmail/connect/route");
  const gmailCallback = await import("@/app/api/integrations/gmail/callback/route");

  const tokA = signAuthToken(userA.id);
  res = await gmailConnect.GET(new NextRequest("http://p7w4a.local/api/integrations/gmail/connect", {
    headers: { authorization: `Bearer ${tokA}` },
  }));
  ok("gmail connect 200", res.status === 200, `status=${res.status}`);
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookieVal = (name) => {
    const c = setCookies.find((x) => x.startsWith(`${name}=`));
    return c ? decodeURIComponent(c.split(";")[0].slice(name.length + 1)) : null;
  };
  const issuedState = cookieVal("gmail_oauth_state");
  const issuedVerifier = cookieVal("gmail_oauth_code_verifier");
  ok("state + verifier cookies issued; NO standalone businessId cookie",
    !!issuedState && !!issuedVerifier && !setCookies.some((c) => c.startsWith("gmail_oauth_business_id=")),
    setCookies.map((c) => c.split("=")[0]).join(","));
  const { verifySignedGmailState } = await import("@/lib/services/integrations/gmail/signed-state.service");
  const issuedVerify = verifySignedGmailState(issuedState);
  ok("issued state binds tenant A", issuedVerify.ok && issuedVerify.state.businessId === bizA.id);

  // Local Google stub — no real network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({
        access_token: "at-synthetic", refresh_token: "rt-synthetic",
        expires_in: 3600, token_type: "Bearer",
        scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (s.includes("openidconnect.googleapis.com")) {
      return new Response(JSON.stringify({ sub: "google-sub-1", email: "owner@p7w4a.test" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return realFetch(url, init);
  };

  const cbReq = (state, cookies) =>
    new NextRequest(`http://p7w4a.local/api/integrations/gmail/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookies },
    });
  const baseCookies = (state) =>
    `gmail_oauth_state=${encodeURIComponent(state)}; gmail_oauth_code_verifier=${encodeURIComponent(issuedVerifier)}`;

  // Tampered businessId inside the state → rejected before any external call.
  const [pB64] = issuedState.split(".");
  const tamperedPayload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf8"));
  tamperedPayload.businessId = bizB.id;
  const tamperedState = Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url") + "." + issuedState.split(".")[1];
  res = await gmailCallback.GET(cbReq(tamperedState, baseCookies(tamperedState)));
  ok("tampered-businessId state rejected",
    (res.headers.get("location") || "").includes("gmail_state_invalid"),
    `status=${res.status} loc=${res.headers.get("location")}`);

  // Cookie/state mismatch → rejected.
  res = await gmailCallback.GET(cbReq(issuedState, baseCookies("different-state")));
  ok("state/cookie mismatch rejected", (res.headers.get("location") || "").includes("gmail_state_invalid"));

  // Valid state + FORGED legacy businessId cookie=B → connection lands under A.
  res = await gmailCallback.GET(cbReq(issuedState,
    baseCookies(issuedState) + `; gmail_oauth_business_id=${bizB.id}`));
  const loc = res.headers.get("location") || "";
  ok("valid callback succeeds (Google stubbed)", loc.includes("connected=1"), `loc=${loc}`);
  const conn = await owner.emailConnection.findFirst({ where: { emailAddress: "owner@p7w4a.test" } });
  ok("connection bound to STATE tenant A (forged cookie ignored)",
    conn?.businessId === bizA.id, `businessId=${conn?.businessId}`);
  ok("OAuthToken persisted atomically with connection",
    !!conn && !!(await owner.oAuthToken.findUnique({ where: { connectionId: conn.id } })));

  // Expired state → rejected (fresh flow, shifted clock via direct verify —
  // route-level expiry uses the same code path).
  const expiredCheck = verifySignedGmailState(issuedState, Date.now() + 11 * 60 * 1000);
  ok("expired state rejected", !expiredCheck.ok && expiredCheck.reason === "expired");
  globalThis.fetch = realFetch;

  // ── Phase 9: fail-closed / rollback / DDL ───────────────────────────────
  console.log("--- substrate invariants ---");
  ok("no context -> 0 messages", (await rt.message.findMany({ where: { businessId: { in: [bizA.id, bizB.id] } } })).length === 0);
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  let rolledBack = false;
  try {
    await runWithTenantContext({ businessId: bizA.id }, () =>
      withTenantTransaction(async (tx) => {
        await tx.customer.create({ data: { businessId: bizA.id, name: `${MARK}rb`, phone: `${MARK}rb` } });
        throw new Error("forced rollback");
      })
    );
  } catch { rolledBack = true; }
  ok("rollback discards tenant write", rolledBack &&
    (await owner.customer.count({ where: { name: `${MARK}rb` } })) === 0);
  let ddlDenied = false;
  try { await rt.$executeRawUnsafe(`CREATE TABLE p7w4a_evil (id int)`); } catch { ddlDenied = true; }
  ok("runtime DDL denied", ddlDenied);

  // ── Phase 10: structural no-network-in-tx ordering ──────────────────────
  console.log("--- structural tx-boundary assertions ---");
  const intakeSrc = readFileSync("lib/services/integrations/whatsapp/conversation-intake.service.ts", "utf8");
  ok("intake: pipeline (LLM-capable) runs OUTSIDE the tenant tx",
    intakeSrc.indexOf("runInboundMessagePipeline({") > intakeSrc.indexOf("if (persisted.kind === \"duplicate\")"));
  const cbSrc = readFileSync("app/api/integrations/gmail/callback/route.ts", "utf8");
  ok("gmail callback: token exchange happens BEFORE tenant context/tx",
    cbSrc.indexOf("exchangeCodeForTokens") < cbSrc.indexOf("runWithTenantContext"));
  const pipeSrc = readFileSync("lib/services/documents/process-document-pipeline.service.ts", "utf8");
  ok("documents pipeline: OCR happens BEFORE the tenant tx",
    pipeSrc.indexOf("runGoogleVisionOCR") < pipeSrc.indexOf("withTenantTransaction(async (tx)"));

  // ── Phase 11: cleanup ───────────────────────────────────────────────────
  await rt.$disconnect();
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz, (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w4a.test') AS usr`);
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));
  await owner.$disconnect();

  console.log(`\n[battery] w4a PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
}

main().catch(async (e) => {
  const { inspect } = await import("node:util");
  console.error("[battery] FATAL:", inspect(e, { depth: 4 }).slice(0, 2500));
  process.exit(1);
});
