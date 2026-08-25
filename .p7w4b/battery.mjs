/**
 * D2 / P7-W4B — WhatsApp tenant-isolation battery.
 *
 * Targets (BATTERY_TARGET): pg (ephemeral PG17: full provision, matrix,
 * rollback proof, re-apply) | neon (Preview branch: drift gates, W4A
 * Message-unique catch-up, W4B apply, matrix on the real substrate).
 *
 * Proves under FORCE RLS on the 5 W4B tables (+ pilot-mirror lab policies for
 * Customer/Conversation on pg):
 *  - real webhook handler: A→A, B→B, forged payload businessId ignored,
 *    unknown + DISCONNECTED mapping denied, replay + concurrent duplicates,
 *    cross-tenant wamid independence, bad signature 401
 *  - DB-failure (revoked bootstrap grant) → loud, no env fallback
 *  - media path with injected external deps: attachment import + document
 *    linkage stay tenant-bound; foreign import id not a mutation handle
 *  - bot/reply path: settings/suggestions/analysis never drift cross-tenant
 *  - MessageAnalysis parent-join composes with the RLS'd Message parent
 *  - real /api/message + /api/reply-suggestion/action handlers
 *  - fail-closed GUC, raw SQL backstop, concurrency, rollback+re-apply
 *
 * W4B verify_only (W4B_VERIFY_ONLY=1): READ-ONLY substrate verification.
 * Synthetic p7w4b-* fixtures only; secrets never printed; ZERO real Meta/OCR.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";
const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "wave1_runtime";
const RT_PW = "p7w1_ci_synthetic_pw";
const RUNTIME_URL_IN = process.env.RUNTIME_URL;
const MARK = "p7w4b-";
const W4B = ["Message", "MessageAnalysis", "BusinessBotSettings", "ReplySuggestion", "WhatsAppAttachmentImport"];
const VERIFY_ONLY = process.env.W4B_VERIFY_ONLY === "1";

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
  return sql
    .split(/;\s*\r?\n/)
    .map((x) => x.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
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
    `SELECT tablename, policyname FROM pg_policies WHERE tablename IN (${W4B.map((t) => `'${t}'`).join(",")}) AND policyname <> 'p7w4b_tenant'`
  );
  if (foreign.length > 0) throw new Error(`DRIFT: unexpected policies on W4B tables: ${JSON.stringify(foreign)} — STOP`);

  if (TARGET === "neon") {
    const gates = [
      ["p4b_tenant", 5, "pilot"],
      ["p7w1_tenant", 14, "wave1"],
      ["p7w2_tenant", 24, "wave2"],
      ["p7w3_tenant", 15, "wave3"],
      ["p7adm_read", 3, "admin"],
    ];
    for (const [pol, want, label] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'${pol === "p7adm_read" ? " AND tablename IN ('Conversation','BillingDocument','ContentRun')" : ""}`))[0].c);
      if (c !== want) throw new Error(`DRIFT: ${label}=${c}, expected ${want} — STOP`);
    }
    const rt0 = (await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0];
    if (!rt0 || rt0.rolsuper || rt0.rolbypassrls) throw new Error("DRIFT: runtime posture — STOP");
    const wcRls = (await owner.$queryRawUnsafe(
      `SELECT relrowsecurity AS r FROM pg_class WHERE relname='WhatsAppConnection'`))[0];
    if (wcRls?.r !== false) throw new Error("DRIFT: WhatsAppConnection has RLS — STOP");
    console.log("[pre-state] pilot=5, w1=14, w2=24, w3=15, adm=3, posture OK, WhatsAppConnection non-RLS");

    // ── STEP-1 catch-up: pending W4A Message unique (guarded, additive) ──
    const idx = await owner.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename='Message' AND indexdef ILIKE '%businessId%providerMessageId%'`);
    if (idx.length === 0 && !VERIFY_ONLY) {
      const dups = await owner.$queryRawUnsafe(
        `SELECT "businessId", count(*)::int AS n FROM "Message" WHERE "providerMessageId" IS NOT NULL GROUP BY "businessId", "providerMessageId" HAVING count(*) > 1 LIMIT 3`);
      if (dups.length > 0) throw new Error(`CATCH-UP BLOCKED: duplicate (businessId, providerMessageId) groups exist: ${dups.length} — STOP`);
      const nullable = (await owner.$queryRawUnsafe(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name='Message' AND column_name='providerMessageId'`))[0];
      if (nullable?.is_nullable !== "YES") throw new Error("CATCH-UP BLOCKED: providerMessageId not nullable — STOP");
      await applySqlFile("prisma/migrations/20260826090000_d2_p7_w4a_message_provider_unique/migration.sql");
      const after = await owner.$queryRawUnsafe(
        `SELECT indexname FROM pg_indexes WHERE tablename='Message' AND indexdef ILIKE '%businessId%providerMessageId%'`);
      if (after.length === 0) throw new Error("CATCH-UP FAILED: unique index missing after apply");
      console.log("[catch-up] W4A Message unique APPLIED (duplicates=0, nullable preserved)");
    } else {
      console.log(`[catch-up] W4A Message unique: ${idx.length > 0 ? "already present" : "pending (verify-only, untouched)"}`);
    }
  }

  if (VERIFY_ONLY) {
    const w4b = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4b_tenant'`))[0].c);
    ok("verify-only: 5 W4B policies present", w4b === 5, `found ${w4b}`);
    const forced = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4B.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
    ok("verify-only: 5 tables ENABLE+FORCE", forced === 5, `found ${forced}`);
    const wc = (await owner.$queryRawUnsafe(
      `SELECT relrowsecurity AS r FROM pg_class WHERE relname='WhatsAppConnection'`))[0];
    ok("verify-only: WhatsAppConnection stays non-RLS (bootstrap)", wc?.r === false);
    const g = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"Message"', 'SELECT') AS a, has_table_privilege('${RT_ROLE}', '"Message"', 'DELETE') AS b`))[0];
    ok("verify-only: grant posture (Message SELECT=yes, DELETE=no)", g.a === true && g.b === false, JSON.stringify(g));
    const res = await owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz`);
    ok("verify-only: synthetic residue = 0", Number(res[0].biz) === 0);
    await owner.$disconnect();
    console.log(`\n[battery] target=${TARGET} mode=verify-only PASS=${pass} FAIL=${fail}`);
    if (fail > 0) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    console.log("ALL CHECKS PASS");
    return;
  }

  // ── Phase 2 (pg only): lab substrate ────────────────────────────────────
  if (TARGET === "pg") {
    const rtExists = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`))[0].c) > 0;
    if (!rtExists) {
      await owner.$executeRawUnsafe(
        `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    }
    await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
    // Pilot-mirror lab policies + grants (Customer/Conversation are FORCE-RLS'd
    // on Preview) so the intake path is proven under the real constraint shape.
    const GUC = `NULLIF(current_setting('app.current_business_id', true), '')::int`;
    for (const t of ["Customer", "Conversation"]) {
      await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "${t}" TO ${RT_ROLE}`);
      await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE "${t}_id_seq" TO ${RT_ROLE}`);
      await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS w4b_lab ON "${t}"`);
      await owner.$executeRawUnsafe(
        `CREATE POLICY w4b_lab ON "${t}" USING ("businessId" = ${GUC}) WITH CHECK ("businessId" = ${GUC})`);
    }
    // Document: FK target for markImported (not RLS'd in this wave).
    await owner.$executeRawUnsafe(`GRANT SELECT ON "Document" TO ${RT_ROLE}`);
  }

  // ── Phase 3: apply W4B migration + grants ───────────────────────────────
  await applySqlFile("prisma/migrations/20260826150000_d2_p7_w4b_whatsapp_tenant_rls/migration.sql");
  await applySqlFile("scripts/security/d2-p7-w4b-grants.sql", { ":ROLE": RT_ROLE });
  const w4bPol = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4b_tenant'`))[0].c);
  ok("5 p7w4b_tenant policies installed", w4bPol === 5, `found ${w4bPol}`);
  const forced = Number((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM pg_class WHERE relname IN (${W4B.map((t) => `'${t}'`).join(",")}) AND relrowsecurity AND relforcerowsecurity`))[0].c);
  ok("5 tables ENABLE+FORCE RLS", forced === 5, `found ${forced}`);
  const wcAfter = (await owner.$queryRawUnsafe(
    `SELECT relrowsecurity AS r FROM pg_class WHERE relname='WhatsAppConnection'`))[0];
  ok("WhatsAppConnection deliberately non-RLS (bootstrap)", wcAfter?.r === false);

  // ── Phase 4: fixtures ───────────────────────────────────────────────────
  const cleanup = async () => {
    const bids = `SELECT id FROM "Business" WHERE name LIKE '${MARK}%'`;
    await owner.$executeRawUnsafe(`DELETE FROM "MessageAnalysis" WHERE "messageId" IN (SELECT id FROM "Message" WHERE "businessId" IN (${bids}))`);
    for (const t of ["ReplySuggestion", "Message", "Conversation", "Customer", "WhatsAppAttachmentImport", "BusinessBotSettings", "WhatsAppConnection", "Document"]) {
      await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" IN (${bids})`);
    }
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@p7w4b.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({ data: { email: "a@p7w4b.test", password: "x", businessId: bizA.id } });
  const PN_A = `${MARK}pn-A`, PN_B = `${MARK}pn-B`, PN_C = `${MARK}pn-C`;
  const connRow = (biz, pn, status = "CONNECTED") => ({
    businessId: biz, phoneNumberId: pn, displayPhoneNumber: pn,
    wabaId: `${MARK}waba`, accessTokenEncrypted: "x", accessTokenIv: "x",
    accessTokenTag: "x", status,
  });
  await owner.whatsAppConnection.create({ data: connRow(bizA.id, PN_A) });
  await owner.whatsAppConnection.create({ data: connRow(bizB.id, PN_B) });
  // Third business with a DISCONNECTED mapping.
  const bizC = await owner.business.create({ data: { name: `${MARK}C` } });
  await owner.whatsAppConnection.create({ data: connRow(bizC.id, PN_C, "DISCONNECTED") });
  // Bot settings: enabled starter bot for A; distinct settings for B.
  await owner.businessBotSettings.create({
    data: {
      businessId: bizA.id, enabled: true, showDraftSuggestionsInInbox: true,
      welcomeMessage: "שלום! איך אפשר לעזור?",
      questions: { items: ["מה השם?", "מה השירות המבוקש?"] },
    },
  });
  await owner.businessBotSettings.create({
    data: { businessId: bizB.id, enabled: false, welcomeMessage: `${MARK}B-secret` },
  });
  console.log(`[fixtures] A=${bizA.id} B=${bizB.id} C=${bizC.id}`);

  // ── Phase 5: app import under the RUNTIME role ──────────────────────────
  let RUNTIME_URL = RUNTIME_URL_IN;
  if (TARGET === "pg") {
    const u = new URL(OWNER_URL);
    u.username = RT_ROLE; u.password = RT_PW;
    RUNTIME_URL = u.toString();
  }
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.WHATSAPP_APP_SECRET = "p7w4b_synthetic_app_secret";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "p7w4b_verify_token";
  process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "p7w4b_auth_secret_synthetic";
  delete process.env.WHATSAPP_ALLOW_ENV_FALLBACK;
  delete process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP;

  const { NextRequest } = await import("next/server");
  const waRoute = await import("@/app/api/integrations/whatsapp/webhook/route");
  const rt = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const rt2 = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const who = (await rt.$queryRawUnsafe("SELECT current_user::text AS u"))[0].u;
  ok(`runtime current_user = ${RT_ROLE}`, who === RT_ROLE, `got ${who}`);

  const rtx = (client, businessId, fn) =>
    client.$transaction(async (t) => {
      if (businessId != null) await t.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(t);
    });
  const inIds = { in: [bizA.id, bizB.id, bizC.id] };

  const sign = (body) =>
    "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(body, "utf8").digest("hex");
  const waPayload = (pn, wamid, text, extra = {}) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "e1", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: pn },
        messages: [{ id: wamid, from: "972501234567", type: "text", text: { body: text }, ...extra }],
      } }] }],
    });
  const postWa = (body, sig) =>
    waRoute.POST(new NextRequest("http://p7w4b.local/api/integrations/whatsapp/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig ?? sign(body) },
      body,
    }));

  // ── Phase 6: real webhook matrix under FORCE RLS ────────────────────────
  console.log("--- real webhook under FORCE RLS ---");
  let res = await waRoute.GET(new NextRequest(
    `http://p7w4b.local/x?hub.mode=subscribe&hub.verify_token=${process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN}&hub.challenge=c1`));
  ok("GET verify handshake", res.status === 200 && (await res.text()) === "c1");
  res = await postWa(waPayload(PN_A, `${MARK}w1`, "x"), "sha256=" + "0".repeat(64));
  ok("bad signature -> 401", res.status === 401);

  res = await postWa(waPayload(PN_A, `${MARK}w1`, "מתי אתם פתוחים?", { businessId: bizB.id }));
  const msgA = await owner.message.findFirst({ where: { businessId: bizA.id, providerMessageId: `${MARK}w1` } });
  ok("A intake persisted under A (forged payload businessId ignored)", res.status === 200 && !!msgA);
  const anaA = msgA ? await owner.messageAnalysis.findUnique({ where: { messageId: msgA.id } }) : null;
  ok("MessageAnalysis written for A's message (indirect WITH CHECK ok)", !!anaA);
  const sugA = await owner.replySuggestion.count({ where: { businessId: bizA.id } });
  ok("starter-bot ReplySuggestion drafted under A (webhook pipeline write under RLS)", sugA >= 1, `count=${sugA}`);
  const sugForeign = await owner.replySuggestion.count({ where: { businessId: { not: bizA.id } } });
  ok("zero foreign suggestions after A intake", sugForeign === 0, `count=${sugForeign}`);

  res = await postWa(waPayload(PN_B, `${MARK}w2`, "שלום B"));
  const msgB = await owner.message.findFirst({ where: { businessId: bizB.id, providerMessageId: `${MARK}w2` } });
  ok("B intake persisted under B", res.status === 200 && !!msgB);

  const pre = await owner.message.count();
  res = await postWa(waPayload(`${MARK}pn-unknown`, `${MARK}w3`, "ghost"));
  ok("unknown phone_number_id -> 200 + zero rows", res.status === 200 && (await owner.message.count()) === pre);
  res = await postWa(waPayload(PN_C, `${MARK}w4`, "disconnected"));
  ok("DISCONNECTED mapping -> 200 + zero rows", res.status === 200 && (await owner.message.count()) === pre);

  res = await postWa(waPayload(PN_A, `${MARK}w1`, "replay"));
  ok("replayed wamid -> one logical message",
    (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: `${MARK}w1` } })) === 1);
  const rawConc = waPayload(PN_A, `${MARK}wconc`, "race");
  await Promise.all([postWa(rawConc), postWa(rawConc)]);
  ok("concurrent duplicate deliveries -> exactly 1 message",
    (await owner.message.count({ where: { businessId: bizA.id, providerMessageId: `${MARK}wconc` } })) === 1);
  const shared = `${MARK}wshared`;
  await postWa(waPayload(PN_A, shared, "sA"));
  await postWa(waPayload(PN_B, shared, "sB"));
  const sharedRows = await owner.message.findMany({ where: { providerMessageId: shared } });
  ok("same wamid A+B -> independent tenant rows", sharedRows.length === 2 &&
    new Set(sharedRows.map((r) => r.businessId)).size === 2);

  // Concurrent A/B isolation.
  await Promise.all([
    postWa(waPayload(PN_A, `${MARK}wpa`, "parallel A")),
    postWa(waPayload(PN_B, `${MARK}wpb`, "parallel B")),
  ]);
  const pa = await owner.message.findFirst({ where: { providerMessageId: `${MARK}wpa` } });
  const pb = await owner.message.findFirst({ where: { providerMessageId: `${MARK}wpb` } });
  ok("parallel A/B webhooks isolated", pa?.businessId === bizA.id && pb?.businessId === bizB.id);

  // DB failure => loud, no fallback (flag+map armed).
  process.env.WHATSAPP_ALLOW_ENV_FALLBACK = "1";
  process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP = JSON.stringify({ [PN_A]: bizB.id });
  const { resetBusinessResolveCacheForTests } = await import("@/lib/services/integrations/whatsapp/business-resolve.service");
  resetBusinessResolveCacheForTests();
  await owner.$executeRawUnsafe(`REVOKE SELECT ON "WhatsAppConnection" FROM ${RT_ROLE}`);
  const preFail = await owner.message.count();
  res = await postWa(waPayload(PN_A, `${MARK}wdb`, "outage"));
  ok("bootstrap DB failure: 200 + zero rows + no env-fallback tenant",
    res.status === 200 && (await owner.message.count()) === preFail);
  await owner.$executeRawUnsafe(`GRANT SELECT ON "WhatsAppConnection" TO ${RT_ROLE}`);
  delete process.env.WHATSAPP_ALLOW_ENV_FALLBACK;
  delete process.env.WHATSAPP_PHONE_NUMBER_BUSINESS_MAP;
  resetBusinessResolveCacheForTests();

  // ── Phase 7: direct + indirect RLS (rtx) ────────────────────────────────
  console.log("--- direct + indirect RLS ---");
  const aMsgs = await rtx(rt, bizA.id, (t) => t.message.findMany({ where: { businessId: inIds } }));
  ok("A sees only A messages", aMsgs.length > 0 && aMsgs.every((m) => m.businessId === bizA.id));
  const bSett = await rtx(rt, bizA.id, (t) => t.businessBotSettings.findMany({ where: { businessId: inIds } }));
  ok("A cannot read B's bot settings", bSett.every((s) => s.businessId === bizA.id));
  const bSugg = await rtx(rt, bizA.id, (t) => t.replySuggestion.findMany({ where: { businessId: bizB.id } }));
  ok("A cannot read B's suggestions", bSugg.length === 0);
  const anaFromA = await rtx(rt, bizA.id, (t) => t.messageAnalysis.findMany({}));
  const anaFromB = await rtx(rt, bizB.id, (t) => t.messageAnalysis.findMany({}));
  ok("MessageAnalysis visible only via own parent Message",
    anaFromA.every((a) => a.messageId !== msgB?.id) && anaFromB.every((a) => a.messageId !== msgA?.id));
  let wrongInsert = false;
  try {
    await rtx(rt, bizA.id, (t) => t.message.create({
      data: { conversationId: msgB.conversationId, businessId: bizB.id, channel: "WHATSAPP", direction: "INBOUND", senderType: "CUSTOMER" },
    }));
  } catch { wrongInsert = true; }
  ok("wrong-tenant Message INSERT rejected (WITH CHECK)", wrongInsert);
  let foreignAna = false;
  try {
    await rtx(rt, bizA.id, (t) => t.messageAnalysis.create({
      data: { messageId: msgB.id, intent: "x", stage: "early" },
    }));
  } catch { foreignAna = true; }
  ok("MessageAnalysis for foreign parent rejected", foreignAna);
  const updX = await rtx(rt, bizA.id, (t) => t.businessBotSettings.updateMany({
    where: { businessId: bizB.id }, data: { welcomeMessage: "evil" } }));
  ok("cross-tenant settings UPDATE = 0 rows", updX.count === 0);
  ok("B settings untouched (owner verify)",
    (await owner.businessBotSettings.findUnique({ where: { businessId: bizB.id } }))?.welcomeMessage === `${MARK}B-secret`);

  // ── Phase 8: media/attachment path (injected external deps) ─────────────
  console.log("--- media path (stubbed externals) ---");
  const { processWhatsAppDocumentsIntake, defaultWhatsAppIntakeDeps } = await import("@/lib/services/integrations/whatsapp/documents-intake.service");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const docA = await owner.document.create({
    data: { businessId: bizA.id, fileUrl: `${MARK}a.jpg`, source: "whatsapp", status: "needs_review", mimeType: "image/jpeg" },
  });
  const stubDeps = {
    ...defaultWhatsAppIntakeDeps,
    fetchMedia: async () => ({ ok: true, buffer: Buffer.from("p7w4b-bytes"), mimeType: "image/jpeg", sizeBytes: 10, filename: "a.jpg" }),
    writeTempOcrFile: async () => ({ tempPath: "unused", cleanup: async () => {} }),
    runOcr: async () => "synthetic ocr text",
    putDocument: async () => {},
    deleteDocument: async () => {},
    createDocument: async () => ({ documentId: docA.id }),
    getBusinessAccessToken: async () => "synthetic-token",
  };
  const mediaOut = await runTenantJob({ businessId: bizA.id }, () =>
    processWhatsAppDocumentsIntake({
      businessId: bizA.id, phoneNumberId: PN_A, sender: "972501234567",
      wamid: `${MARK}media-1`, mediaType: "image", mediaId: "m1",
    }, stubDeps)
  );
  const impA = await owner.whatsAppAttachmentImport.findFirst({ where: { businessId: bizA.id, wamid: `${MARK}media-1` } });
  ok("A media import: row under A, linked to A's document",
    mediaOut.status === "imported" && impA?.status === "imported" && impA?.documentId === docA.id,
    JSON.stringify({ out: mediaOut.status, imp: impA?.status }));
  // Replay of the media wamid → dedup.
  const mediaReplay = await runTenantJob({ businessId: bizA.id }, () =>
    processWhatsAppDocumentsIntake({
      businessId: bizA.id, phoneNumberId: PN_A, sender: "972501234567",
      wamid: `${MARK}media-1`, mediaType: "image", mediaId: "m1",
    }, stubDeps)
  );
  ok("media wamid replay -> skipped_duplicate", mediaReplay.status === "skipped_duplicate");
  // Foreign import id is not a mutation handle.
  const { markWhatsAppImportFailed } = await import("@/lib/services/integrations/whatsapp/whatsapp-import-row.service");
  await runTenantJob({ businessId: bizB.id }, async () => {
    const { withTenantTransaction } = await import("@/lib/tenant/transaction");
    await withTenantTransaction((tx) =>
      markWhatsAppImportFailed({ importId: impA.id, businessId: bizB.id, error: "evil" }, { tx })
    );
  });
  ok("foreign importId not a mutation handle",
    (await owner.whatsAppAttachmentImport.findUnique({ where: { id: impA.id } }))?.status === "imported");

  // ── Phase 9: real authed routes ─────────────────────────────────────────
  console.log("--- real /api/message + /api/reply-suggestion/action ---");
  const { signAuthToken } = await import("@/lib/auth-token");
  const tokA = signAuthToken(userA.id);
  const msgRoute = await import("@/app/api/message/route");
  const convA = await owner.conversation.findFirst({ where: { businessId: bizA.id } });
  const convB = await owner.conversation.findFirst({ where: { businessId: bizB.id } });
  res = await msgRoute.GET(new NextRequest(
    `http://p7w4b.local/api/message?conversationId=${convA.id}`,
    { headers: { authorization: `Bearer ${tokA}` } }));
  const got = await res.json();
  ok("GET /api/message (A) returns A conversation data", res.status === 200 && got.messages.length > 0);
  res = await msgRoute.GET(new NextRequest(
    `http://p7w4b.local/api/message?conversationId=${convB.id}`,
    { headers: { authorization: `Bearer ${tokA}` } }));
  const gotB = await res.json();
  ok("GET /api/message cross-tenant -> empty", res.status === 200 && gotB.messages.length === 0);
  res = await msgRoute.POST(new NextRequest("http://p7w4b.local/api/message", {
    method: "POST",
    headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convA.id, contentText: "מה המחיר?", direction: "INBOUND", senderType: "CUSTOMER" }),
  }));
  ok("POST /api/message (A inbound) 201 under RLS", res.status === 201, `status=${res.status}`);
  res = await msgRoute.POST(new NextRequest("http://p7w4b.local/api/message", {
    method: "POST",
    headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convB.id, contentText: "evil" }),
  }));
  ok("POST /api/message to B's conversation -> 404", res.status === 404, `status=${res.status}`);

  const actionRoute = await import("@/app/api/reply-suggestion/action/route");
  const sugOfB = await owner.replySuggestion.create({
    data: { businessId: bizB.id, conversationId: convB.id, messageId: msgB.id, suggestionType: "AUTO", strategyType: "x", variantType: "default", variantIndex: 0, text: "b", status: "GENERATED" },
  });
  res = await actionRoute.POST(new NextRequest("http://p7w4b.local/api/reply-suggestion/action", {
    method: "POST",
    headers: { authorization: `Bearer ${tokA}`, "content-type": "application/json" },
    body: JSON.stringify({ suggestionId: sugOfB.id, action: "shown" }),
  }));
  ok("action on B's suggestion as A -> 404", res.status === 404, `status=${res.status}`);
  ok("B suggestion untouched", (await owner.replySuggestion.findUnique({ where: { id: sugOfB.id } }))?.status === "GENERATED");

  // ── Phase 10: fail-closed + raw SQL ─────────────────────────────────────
  console.log("--- fail-closed + raw SQL ---");
  ok("no context -> 0 messages", (await rt.message.findMany({ where: { businessId: inIds } })).length === 0);
  const emptyCtx = await rt.$transaction(async (t) => {
    await t.$queryRaw`SELECT set_config('app.current_business_id', '', true)`;
    return t.replySuggestion.findMany({ where: { businessId: inIds } });
  });
  ok("empty context -> 0 suggestions", emptyCtx.length === 0);
  let malformed = false;
  try {
    await rt.$transaction(async (t) => {
      await t.$queryRaw`SELECT set_config('app.current_business_id', 'evil', true)`;
      return t.message.findMany({});
    });
  } catch { malformed = true; }
  ok("malformed context errors", malformed);
  const rawMsg = await rtx(rt, bizA.id, (t) => t.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "Message"`));
  const ownerMsgA = await owner.message.count({ where: { businessId: bizA.id } });
  ok("raw SELECT Message = tenant-only", Number(rawMsg[0].c) === ownerMsgA, `raw=${rawMsg[0].c} owner=${ownerMsgA}`);
  const rawAna = await rtx(rt, bizB.id, (t) => t.$queryRawUnsafe(
    `SELECT count(*)::int AS c FROM "MessageAnalysis"`));
  const ownerAnaB = await owner.messageAnalysis.count({ where: { message: { businessId: bizB.id } } });
  ok("raw MessageAnalysis = own-parent only", Number(rawAna[0].c) === ownerAnaB, `raw=${rawAna[0].c} owner=${ownerAnaB}`);
  let rawInsertDenied = false;
  try {
    await rtx(rt, bizA.id, (t) => t.$executeRawUnsafe(
      `INSERT INTO "Message" ("conversationId","businessId","channel","direction","senderType") VALUES (${convB.id}, ${bizB.id}, 'WHATSAPP', 'INBOUND', 'CUSTOMER')`));
  } catch { rawInsertDenied = true; }
  ok("raw wrong-tenant INSERT WITH CHECK denied", rawInsertDenied);
  let ddl = false;
  try { await rt.$executeRawUnsafe(`CREATE TABLE p7w4b_evil (id int)`); } catch { ddl = true; }
  ok("runtime DDL denied", ddl);
  let mig = false;
  try { await rt.$queryRawUnsafe(`SELECT count(*) FROM _prisma_migrations`); } catch { mig = true; }
  ok("runtime _prisma_migrations denied", mig);
  let del = false;
  try { await rtx(rt, bizA.id, (t) => t.message.deleteMany({ where: { businessId: bizA.id } })); } catch { del = true; }
  ok("runtime DELETE on Message denied (verb never granted)", del);

  // Sequential + concurrent tenant switching on separate clients.
  const [ca, cb] = await Promise.all([
    rtx(rt, bizA.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.04)"); return t.message.count({}); }),
    rtx(rt2, bizB.id, async (t) => { await t.$executeRawUnsafe("SELECT pg_sleep(0.02)"); return t.message.count({}); }),
  ]);
  ok("concurrent GUC isolation (A/B counts differ per tenant)",
    ca === ownerMsgA && cb === (await owner.message.count({ where: { businessId: bizB.id } })), `a=${ca} b=${cb}`);
  // Rollback cleanup.
  let rolled = false;
  try {
    await rtx(rt, bizA.id, async (t) => {
      await t.replySuggestion.create({ data: { businessId: bizA.id, conversationId: convA.id, messageId: msgA.id, suggestionType: "AUTO", strategyType: "x", variantType: "default", variantIndex: 9, text: `${MARK}rb`, status: "GENERATED" } });
      throw new Error("forced rollback");
    });
  } catch { rolled = true; }
  ok("rollback discards tenant write", rolled &&
    (await owner.replySuggestion.count({ where: { text: `${MARK}rb` } })) === 0);

  await rt.$disconnect(); await rt2.$disconnect();

  // ── Phase 11 (pg only): rollback proof + re-apply ───────────────────────
  if (TARGET === "pg") {
    console.log("--- rollback proof ---");
    await applySqlFile("scripts/security/d2-p7-w4b-rollback.sql", { ":ROLE": RT_ROLE });
    const polAfter = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4b_tenant'`))[0].c);
    ok("rollback: 0 p7w4b policies remain", polAfter === 0, `found ${polAfter}`);
    const labStill = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='w4b_lab'`))[0].c);
    ok("rollback: pilot-mirror policies intact", labStill === 2, `found ${labStill}`);
    const canSel = (await owner.$queryRawUnsafe(
      `SELECT has_table_privilege('${RT_ROLE}', '"Message"', 'SELECT') AS p`))[0].p;
    ok("rollback: runtime grants revoked", canSel === false);
    const uniqStill = await owner.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename='Message' AND indexdef ILIKE '%businessId%providerMessageId%'`);
    ok("rollback: W4A Message unique NOT rolled back (separate lifecycle)", uniqStill.length === 1);
    await applySqlFile("prisma/migrations/20260826150000_d2_p7_w4b_whatsapp_tenant_rls/migration.sql");
    await applySqlFile("scripts/security/d2-p7-w4b-grants.sql", { ":ROLE": RT_ROLE });
    const polRe = Number((await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='p7w4b_tenant'`))[0].c);
    ok("re-apply after rollback (idempotency)", polRe === 5, `found ${polRe}`);
  }

  // ── Phase 12: cleanup + prior-substrate integrity ───────────────────────
  await cleanup();
  const residue = await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%') AS biz, (SELECT count(*)::int FROM "User" WHERE email LIKE '%@p7w4b.test') AS usr`);
  ok("synthetic residue = 0", Number(residue[0].biz) === 0 && Number(residue[0].usr) === 0, JSON.stringify(residue[0]));
  if (TARGET === "neon") {
    const gates = [["p4b_tenant", 5], ["p7w1_tenant", 14], ["p7w2_tenant", 24], ["p7w3_tenant", 15], ["p7adm_read", 3]];
    let intact = true;
    for (const [pol, want] of gates) {
      const c = Number((await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM pg_policies WHERE policyname='${pol}'${pol === "p7adm_read" ? " AND tablename IN ('Conversation','BillingDocument','ContentRun')" : ""}`))[0].c);
      if (c !== want) intact = false;
    }
    ok("pilot+W1+W2+W3+admin substrate intact after W4B", intact);
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
