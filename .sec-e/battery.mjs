/**
 * SEC-E — durable, resumable, authority-revoking account erasure: the fault-injection
 * battery. Run ONLY through the fresh-lab harness:
 *
 *   node .ad2a/fresh-lab.mjs <label> -- npx tsx .sec-e/battery.mjs [--only <group>]
 *
 * groups: fault | provider | sweeper | m12a | m12c | content | audit | wrapper   (default: all)
 *
 * Every proof gets a NEW database, a NEW NOSUPERUSER/NOBYPASSRLS runtime role and a NEW
 * auth-plane role (fresh-lab.mjs); the substrate is the AD-2A Production RLS contract
 * applied verbatim, the runtime's grants are MEASURED equal to the declared set, and the
 * auth role receives exactly app_auth's migration grants (.sec-e/auth-plane.mjs).
 *
 * Faults are REAL: a PostgreSQL trigger raising mid-transaction, a privilege revoked
 * from the role that runs the stage, a storage adapter whose delete/list genuinely
 * fails, a provider endpoint answering 500. Providers are never called: `fetch` is
 * replaced by a recorder that answers only the two documented revoke endpoints and
 * throws on anything else.
 *
 * Every check prints a stable LABEL; negative proofs in sec-e-erasure-ci.yml assert
 * the specific label goes red.
 *
 * Synthetic fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { applyProductionContract } from "../.ad2a/production-contract.mjs";
import {
  freshLabIdentity,
  measureCleanPrecondition,
  readLiveState,
  expectedState,
  diffExactSet,
} from "../.ad2a/lab-state.mjs";
import { applyAuthPlane } from "./auth-plane.mjs";

const LAB = freshLabIdentity();
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i > 0 ? process.argv[i + 1] : null;
})();
const want = (g) => ONLY === null || ONLY === g;
const MARK = "SECE_7d20b1-";
/** A real 1x1 PNG: public uploads are content-verified (workstream D), so fixtures must be genuine. */
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let pass = 0;
let fail = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  [FAIL] ${label}${detail ? " — " + detail : ""}`);
  }
  return Boolean(cond);
}
function roleUrl(base, user, pw) {
  const u = new URL(base);
  u.username = user;
  u.password = pw;
  return u.toString();
}
async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const noPII = (s) => typeof s === "string" && !/@|SECE_|\+972|050/.test(s);

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(OWNER_URL)) throw new Error("DENY: local lab only");
  if (!LAB) {
    console.log("[sec-e] FAIL: not a fresh lab — run through .ad2a/fresh-lab.mjs");
    process.exit(1);
  }
  const RT = LAB.role;
  const AUTH = process.env.AD2A_AUTH_ROLE;
  if (!AUTH) throw new Error("fresh-lab did not provide an auth-plane role");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  console.log(`[sec-e] fresh lab ${LAB.db} · runtime ${RT} · auth ${AUTH} · only=${ONLY ?? "all"}`);

  // ── Substrate ──────────────────────────────────────────────────────────────
  console.log("--- substrate ---");
  const pre = await measureCleanPrecondition(owner, LAB);
  for (const c of pre) ok(`PRE · ${c.name}`, c.ok, c.detail);
  if (pre.some((c) => !c.ok)) process.exit(1);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT}`);
  await applyProductionContract(owner);
  // The same lab grants as .ad2a/battery.mjs, and MEASURED equal to the declared set
  // (EXPECTED_RUNTIME_TABLE_PRIVILEGES) by the exact-set check below — a grant missing or
  // extra here fails the substrate, so this list cannot quietly diverge.
  const sql = (s) => owner.$executeRawUnsafe(s);
  await sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON "Conversation","Message","MessageAnalysis","ReplySuggestion","Customer","CrmNote","CrmAttachment","BusinessProfile","User","Business","Lead","POSApiKey","OAuthToken","EmailConnection","WhatsAppConnection","BusinessPaymentConnection","BillingAuthorityConnection","LearningEvent","Appointment" TO ${RT}`);
  await sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON "InboundEmailAuthorizedSender","InboundEmailSenderChallenge" TO ${RT}`);
  await sql(`GRANT SELECT, INSERT ON "HistoricalFiscalDocument" TO ${RT}`);
  await sql(`GRANT SELECT, INSERT, UPDATE ON "Notification","NotificationDelivery" TO ${RT}`);
  await sql(`GRANT SELECT, INSERT, UPDATE ON "ReceivingSession","PurchaseOrderLine","PurchaseOrder" TO ${RT}`);
  await sql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT}`);
  const live = await readLiveState(owner, RT);
  const exact = diffExactSet(live, await expectedState(owner, live.sequences));
  for (const d of exact) {
    ok(`SUBSTRATE · exact-set ${d.dimension}`, d.missing.length === 0 && d.extra.length === 0,
      `missing=[${d.missing.join(" | ")}] extra=[${d.extra.join(" | ")}]`);
  }
  await sql(`GRANT USAGE ON SCHEMA public TO ${AUTH}`);
  const nAuth = await applyAuthPlane(owner, AUTH);
  ok(`SUBSTRATE · auth plane: ${nAuth} app_auth migration grants replayed`, nAuth >= 10);
  const posture = (await owner.$queryRawUnsafe(
    `SELECT rolname::text AS r, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname IN ('${RT}','${AUTH}')`
  ));
  ok("SUBSTRATE · both lab roles are NOSUPERUSER NOBYPASSRLS", posture.length === 2 && posture.every((p) => !p.s && !p.b), JSON.stringify(posture));

  // COMPATIBILITY MODE (workstream F, #521): layer another migration on top of the
  // measured substrate — AFTER the exact-set check, so the base stays proven — and run
  // the whole erasure against it. Used to prove the erasure never UPDATEs/DELETEs the
  // append-only audit tables, never deletes a User they point at, and never touches an
  // ISSUED fiscal row (those triggers raise DZ001/DZ010 even for the owner).
  const EXTRA = process.env.SEC_E_EXTRA_MIGRATION;
  if (EXTRA) {
    const fsx = await import("node:fs");
    await owner.$executeRawUnsafe(fsx.readFileSync(EXTRA, "utf8"));
    ok(`SUBSTRATE · extra migration applied: ${EXTRA}`, true);
  }

  process.env.DATABASE_URL = roleUrl(OWNER_URL, RT, LAB.pw);
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.AUTH_DATABASE_URL = roleUrl(OWNER_URL, AUTH, process.env.AD2A_AUTH_PW);
  process.env.CRON_SECRET = crypto.randomBytes(24).toString("hex");
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  process.env.R2_PUBLIC_BASE_URL = "https://lab-assets.invalid";
  process.env.AUTH_TOKEN_SECRET ??= crypto.randomBytes(24).toString("hex");

  // ── Providers: a recorder, never the network ──────────────────────────────
  const net = { calls: [], googleFail: 0, metaFail: 0, other: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method ?? "GET").toUpperCase();
    if (u === "https://oauth2.googleapis.com/revoke" && method === "POST") {
      const token = new URLSearchParams(String(init.body)).get("token");
      net.calls.push({ p: "google", token });
      if (net.googleFail > 0) {
        net.googleFail--;
        return new Response("{}", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }
    const m = /^https:\/\/graph\.facebook\.com\/v[\d.]+\/([^/]+)\/subscribed_apps$/.exec(u);
    if (m && method === "DELETE") {
      net.calls.push({ p: "meta", waba: decodeURIComponent(m[1]) });
      if (net.metaFail > 0) {
        net.metaFail--;
        return new Response(JSON.stringify({ error: { code: 1 } }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    net.other.push(`${method} ${u}`);
    throw new Error(`SEC-E lab: network forbidden (${method} ${u})`);
  };

  // ── Real modules, after the environment points at the lab roles ────────────
  const { prismaAccountDeletionStore: store } = await import("@/lib/services/account/account-deletion.prisma-store");
  const { sweepStrandedErasures } = await import("@/lib/services/account/erasure-job");
  const { requestAccountDeletion } = await import("@/lib/services/account/account-deletion.service");
  const accountRoute = await import("@/app/api/account/route");
  const sweepRoute = await import("@/app/api/account/erasure-sweep/route");
  const { getAuthContext, signAuthToken } = await import("@/lib/auth");
  const { authDb } = await import("@/lib/prisma-auth");
  const { issueRefreshSession, refreshSession } = await import("@/lib/auth/refresh-session");
  const { encryptToken } = await import("@/lib/services/integrations/gmail/token-crypto.placeholder");
  const { encryptAccessToken } = await import("@/lib/services/integrations/whatsapp/token-crypto.service");
  const { putPublicAsset } = await import("@/lib/services/storage/public-asset-storage.service");
  const { buildAttachmentStorageKey, putAttachmentObject } = await import("@/lib/services/crm/crm-attachment-storage");
  const { getStorageService, setStorageServiceForTests } = await import("@/lib/storage");
  const { runTenantJob } = await import("@/lib/tenant/job");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { BusinessQuarantinedError, lifecycleOf } = await import("@/lib/tenant/business-lifecycle");

  // ── Storage: the real local adapter, wrapped so faults are real and deletes counted ──
  const realStorage = getStorageService();
  // Faults: fail ONE prefix delete part-way (one object gone, then an error — the
  // realistic partial failure), and fail the VERIFY listing (the second limit-1 listing of
  // an attempt: the first is the purge's own post-delete emptiness check).
  const storageFault = { failPrefixDelete: false, failVerifyList: 0 };
  let limit1Seen = 0;
  const effectiveDeletes = new Map(); // key -> successful deletes of an EXISTING object
  const count = (k) => effectiveDeletes.set(k, (effectiveDeletes.get(k) ?? 0) + 1);
  const storage = {
    ...Object.fromEntries(
      ["putObject", "getObject", "headObject", "getMetadata", "getSignedDownloadUrl", "getPublicUrl"].map((m) => [
        m,
        (...a) => realStorage[m](...a),
      ])
    ),
    async listByPrefix(prefix, opts) {
      if (opts?.limit === 1 && storageFault.failVerifyList > 0) {
        limit1Seen++;
        if (limit1Seen % 2 === 0) {
          storageFault.failVerifyList--;
          const e = new Error("lab: listing refused");
          e.name = "StorageListError";
          throw e;
        }
      }
      return realStorage.listByPrefix(prefix, opts);
    },
    async deleteByPrefix(prefix) {
      const before = (await realStorage.listByPrefix(prefix)).keys;
      if (storageFault.failPrefixDelete && before.length > 1) {
        storageFault.failPrefixDelete = false;
        await realStorage.deleteObject(before[0]);
        count(before[0]);
        const e = new Error("lab: prefix delete failed part-way");
        e.name = "StorageDeleteError";
        throw e;
      }
      const r = await realStorage.deleteByPrefix(prefix);
      const after = new Set((await realStorage.listByPrefix(prefix)).keys);
      for (const k of before) if (!after.has(k)) count(k);
      return r;
    },
    async deleteObject(key) {
      const existed = (await realStorage.headObject(key)).exists;
      await realStorage.deleteObject(key);
      if (existed) count(key);
    },
  };
  setStorageServiceForTests(storage);

  // ── Fixtures ──────────────────────────────────────────────────────────────
  let seq = 0;
  const mk = async (tag) => {
    seq++;
    const b = await owner.business.create({ data: { name: `${MARK}${tag}` } });
    const u = await owner.user.create({ data: { email: `${tag}-${seq}@sec-e.test`, name: `${MARK}name`, password: "x", businessId: b.id } });
    const c = await owner.customer.create({ data: { businessId: b.id, name: `${MARK}cust`, phone: `${MARK}phone`, email: `${MARK}c@x.test` } });
    const conv = await owner.conversation.create({ data: { businessId: b.id, customerId: c.id, channel: "WHATSAPP" } });
    await owner.message.create({
      data: { businessId: b.id, conversationId: conv.id, customerId: c.id, channel: "WHATSAPP", direction: "INBOUND", senderType: "CUSTOMER", contentText: `${MARK}body`, providerMessageId: `${MARK}wamid-${seq}` },
    });
    await owner.lead.create({ data: { businessId: b.id, customerName: `${MARK}lead`, phone: `${MARK}lp`, email: `${MARK}l@x.test`, sourceChannel: "whatsapp", currentStage: "DISCOVERY" } });
    await owner.crmNote.create({ data: { businessId: b.id, subjectType: "CUSTOMER", subjectId: c.id, body: `${MARK}note`, createdByUserId: u.id } });
    const attachmentKey = buildAttachmentStorageKey({ businessId: b.id, subjectType: "CUSTOMER", subjectId: c.id, storageExt: "txt" });
    await putAttachmentObject({ businessId: b.id, key: attachmentKey, body: Buffer.from(`${MARK}att`), contentType: "text/plain" });
    await owner.crmAttachment.create({
      data: { businessId: b.id, subjectType: "CUSTOMER", subjectId: c.id, storageKey: attachmentKey, originalFileName: `${MARK}a.txt`, mimeType: "text/plain", sizeBytes: 3, uploadedByUserId: u.id },
    });
    // Content uploads — NO row points at these. Written through the product's own path.
    const content = [];
    for (let i = 0; i < 2; i++) {
      content.push((await putPublicAsset({ businessId: b.id, domain: "content", body: PNG_1PX, contentType: "image/png", fileName: `c${i}.png` })).key);
    }
    const gmailRefresh = `${MARK}gmail-refresh-${seq}`;
    const emailConn = await owner.emailConnection.create({
      data: { businessId: b.id, provider: "gmail", emailAddress: `${tag}-${seq}-mailbox@sec-e.test`, providerAccountId: `${MARK}acct`, scopes: "gmail.readonly", lastSyncCursor: `${MARK}cursor`, lastError: `${MARK}err` },
    });
    await owner.oAuthToken.create({
      data: { connectionId: emailConn.id, accessTokenEncrypted: encryptToken(`${MARK}gmail-access`, { businessId: b.id, connectionId: emailConn.id, field: "access" }).encrypted, refreshTokenEncrypted: encryptToken(gmailRefresh, { businessId: b.id, connectionId: emailConn.id, field: "refresh" }).encrypted, expiresAt: new Date(Date.now() + 3600_000), encryptionKeyId: "gcm_v2:k0" },
    });
    const wa = encryptAccessToken(`${MARK}wa-token-${seq}`, b.id);
    const waba = `${MARK}waba-${seq}`;
    const phoneNumberId = `${MARK}pnid-${seq}`;
    await owner.whatsAppConnection.create({
      data: { businessId: b.id, phoneNumberId, displayPhoneNumber: "+972500000001", wabaId: waba, accessTokenEncrypted: wa.encrypted, accessTokenIv: wa.iv, accessTokenTag: wa.tag, lastErrorMessage: `${MARK}wa-err` },
    });
    await owner.billingAuthorityConnection.create({
      data: { businessId: b.id, environment: "SANDBOX", accessTokenEncrypted: `${MARK}ita`, accessTokenIv: "iv", accessTokenTag: "tag", refreshTokenEncrypted: `${MARK}ita-r`, refreshTokenIv: "iv", refreshTokenTag: "tag", encryptionKeyId: "k" },
    });
    await owner.businessPaymentConnection.create({
      data: { businessId: b.id, provider: "CARDCOM", merchantId: "lab-merchant-terminal", credentialEncrypted: `${MARK}pay`, credentialIv: "iv", credentialTag: "tag", encryptionKeyId: "k", isActive: true },
    });
    await owner.pOSApiKey.create({ data: { businessId: b.id, keyHash: `${MARK}pos-${seq}`, label: "x" } });
    // Authority minted BEFORE the deletion: a refresh session (with a device User-Agent)
    // and two bearer tokens — one naming the session, one from before sessions existed.
    const sess = await issueRefreshSession(authDb(), { userId: u.id, tokenVersion: 0, now: new Date(), userAgent: `${MARK}UA` });
    const sidToken = signAuthToken(u.id, 0, sess.sessionId);
    const legacyToken = signAuthToken(u.id, 0);
    return { biz: b, user: u, content, attachmentKey, gmailRefresh, waba, phoneNumberId, sess, sidToken, legacyToken, emailConnId: emailConn.id };
  };

  const bearer = (t) => new Request("http://lab.invalid/api/account", { method: "DELETE", headers: { authorization: `Bearer ${t}` } });
  const lifecycle = async (id) => lifecycleOf(await owner.business.findUnique({ where: { id } }));
  const ledgerRows = (id) =>
    owner.learningEvent.findMany({ where: { businessId: id, eventType: { startsWith: "ACCOUNT_ERASURE" } }, orderBy: { id: "asc" } });
  const FUTURE = () => new Date(Date.now() + 7 * 60 * 60_000);

  /** The erasure's post-conditions, read back as the OWNER (bypassing RLS). */
  const assertErased = async (label, fx) => {
    const id = fx.biz.id;
    const leak = [];
    const scan = async (table, where) => {
      const rows = await owner.$queryRawUnsafe(`SELECT row_to_json(t)::text AS j FROM "${table}" t WHERE ${where}`);
      for (const r of rows) if (r.j.includes(MARK) || r.j.includes("sec-e.test")) leak.push(`${table}`);
    };
    for (const t of ["User", "Customer", "Lead", "Message", "EmailConnection", "WhatsAppConnection", "BillingAuthorityConnection", "BusinessPaymentConnection", "POSApiKey", "CrmNote", "CrmAttachment"]) {
      await scan(t, `"businessId" = ${id}`);
    }
    await scan("OAuthToken", `"connectionId" = ${fx.emailConnId}`);
    const sessions = await owner.authSession.count({ where: { userId: fx.user.id } });
    const objects = [...fx.content, fx.attachmentKey];
    const alive = [];
    for (const k of objects) if ((await realStorage.headObject(k)).exists) alive.push(k);
    const evidence = await owner.learningEvent.count({ where: { businessId: id, eventType: "ACCOUNT_DELETED" } });
    const wa = await owner.whatsAppConnection.findFirst({ where: { businessId: id }, select: { phoneNumberId: true } });
    const lc = await lifecycle(id);
    return ok(
      label,
      lc === "PURGED" && leak.length === 0 && sessions === 0 && alive.length === 0 && evidence === 1 && wa?.phoneNumberId === `erased-${id}`,
      `lifecycle=${lc} leaks=[${[...new Set(leak)]}] sessions=${sessions} objects=${alive.length} evidence=${evidence} pnid=${wa?.phoneNumberId}`
    );
  };

  /** Each object deleted exactly once, and each provider grant called exactly the expected number of times. */
  const assertNoDuplicateEffects = (label, fx, { google = 1, meta = 1 } = {}) => {
    const objects = [...fx.content, fx.attachmentKey];
    const dup = objects.filter((k) => (effectiveDeletes.get(k) ?? 0) !== 1);
    const g = net.calls.filter((c) => c.p === "google" && c.token === fx.gmailRefresh).length;
    const m = net.calls.filter((c) => c.p === "meta" && c.waba === fx.waba).length;
    return ok(label, dup.length === 0 && g === google && m === meta, `objectsNotDeletedExactlyOnce=${dup.length} googleCalls=${g}/${google} metaCalls=${m}/${meta}`);
  };

  // A control tenant that must be untouched by everything below.
  const CONTROL = await mk("control");

  // ═════════════════════════════════════════════════════════════════════════
  // H-5 — FAULT INJECTION at every stage: persist → sweep → converge, no duplicate effect
  // ═════════════════════════════════════════════════════════════════════════
  if (want("fault")) {
    console.log("--- H-5 fault matrix ---");
    const STAGES = [
      {
        stage: "CLAIM",
        inject: () => sql(`REVOKE INSERT ON "LearningEvent" FROM ${RT}`),
        heal: () => sql(`GRANT INSERT ON "LearningEvent" TO ${RT}`),
      },
      {
        stage: "AUTHORITY_REVOKE",
        inject: () => sql(`REVOKE UPDATE ON "AuthSession" FROM ${AUTH}`),
        heal: () => sql(`GRANT UPDATE ("secretHash", "lastUsedAt", "idleExpiresAt", "revokedAt", "revokedReason") ON "AuthSession" TO ${AUTH}`),
      },
      {
        stage: "PURGE",
        kind: "db",
        inject: async () => {
          await sql(`CREATE OR REPLACE FUNCTION sece_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'lab: fault' USING ERRCODE = 'XX001'; END $f$`);
          await sql(`CREATE TRIGGER sece_fault BEFORE UPDATE ON "Message" FOR EACH ROW EXECUTE FUNCTION sece_fault()`);
        },
        heal: () => sql(`DROP TRIGGER sece_fault ON "Message"`),
      },
      {
        stage: "PURGE",
        kind: "storage",
        inject: async () => { storageFault.failPrefixDelete = true; },
        heal: async () => { storageFault.failPrefixDelete = false; },
      },
      {
        stage: "SESSION_ERASE",
        inject: () => sql(`REVOKE DELETE ON "AuthSessionSecret" FROM ${AUTH}`),
        heal: () => sql(`GRANT DELETE ON "AuthSessionSecret" TO ${AUTH}`),
      },
      {
        stage: "PROVIDER_REVOKE",
        inject: async () => { net.googleFail = 1; },
        heal: async () => { net.googleFail = 0; },
        google: 2,
      },
      {
        stage: "CREDENTIAL_DESTROY",
        inject: async () => {
          await sql(`CREATE OR REPLACE FUNCTION sece_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'lab: fault' USING ERRCODE = 'XX001'; END $f$`);
          await sql(`CREATE TRIGGER sece_fault BEFORE UPDATE ON "WhatsAppConnection" FOR EACH ROW EXECUTE FUNCTION sece_fault()`);
        },
        heal: () => sql(`DROP TRIGGER sece_fault ON "WhatsAppConnection"`),
      },
      {
        stage: "VERIFY",
        inject: async () => { storageFault.failVerifyList = 1; limit1Seen = 0; },
        heal: async () => { storageFault.failVerifyList = 0; },
      },
      {
        stage: "FINALIZE",
        inject: async () => {
          await sql(`CREATE OR REPLACE FUNCTION sece_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW."eventType" = 'ACCOUNT_DELETED' THEN RAISE EXCEPTION 'lab: fault' USING ERRCODE = '42501'; END IF; RETURN NEW; END $f$`);
          await sql(`CREATE TRIGGER sece_fault BEFORE INSERT ON "LearningEvent" FOR EACH ROW EXECUTE FUNCTION sece_fault()`);
        },
        heal: () => sql(`DROP TRIGGER sece_fault ON "LearningEvent"`),
      },
    ];
    for (const s of STAGES) {
      const L = `H5-FAULT-${s.stage}${s.kind ? `-${s.kind.toUpperCase()}` : ""}`;
      const fx = await mk(L.toLowerCase());
      await s.inject(fx);
      const res = await accountRoute.DELETE(bearer(fx.sidToken));
      const body = await res.json().catch(() => ({}));
      await s.heal(fx);
      ok(`${L} · the request is ACCEPTED (202), not a 500 the owner cannot retry`, res.status === 202 && body.status === "accepted", `http=${res.status} body=${JSON.stringify(body)}`);
      ok(`${L} · state persists: DELETION_REQUESTED`, (await lifecycle(fx.biz.id)) === "DELETION_REQUESTED");
      const rows = await ledgerRows(fx.biz.id);
      const result = rows.find((r) => r.eventType === "ACCOUNT_ERASURE_RESULT");
      if (s.stage === "CLAIM") {
        ok(`${L} · no attempt could be claimed, so nothing ran (no ledger row, no purge)`, rows.length === 0 &&
          (await owner.message.count({ where: { businessId: fx.biz.id, contentText: { not: null } } })) === 1);
      } else {
        ok(`${L} · the ledger records the failed stage and a PII-free error class`,
          result?.payload?.outcome === "FAILED" && result.payload.stage === s.stage && noPII(result.payload.errorClass) && typeof result.payload.nextAttemptAt === "string",
          JSON.stringify(result?.payload));
      }
      if (s.stage === "PROVIDER_REVOKE") {
        const tokenRows = await owner.oAuthToken.count({ where: { connectionId: fx.emailConnId } });
        ok(`${L} · the ciphertext SURVIVES a pending revoke (the retry still needs it)`, tokenRows === 1, `oauthRows=${tokenRows}`);
      }
      // Backoff honoured, then the sweeper converges.
      if (s.stage !== "CLAIM") {
        const early = await sweepStrandedErasures(store, { batch: 50 });
        const mine = early.results.find((r) => r.businessId === fx.biz.id);
        ok(`${L} · an immediate sweep respects the backoff (NOT_DUE)`, mine?.status === "NOT_DUE", JSON.stringify(mine));
      }
      const swept = await sweepStrandedErasures(store, { batch: 50, now: FUTURE() });
      ok(`${L} · the sweeper converges`, swept.results.find((r) => r.businessId === fx.biz.id)?.status === "COMPLETED", JSON.stringify(swept.results));
      await assertErased(`${L} · converged: PURGED, nothing personal left, sessions gone, objects gone, one evidence row`, fx);
      assertNoDuplicateEffects(`${L} · no duplicate destructive side effect`, fx, { google: s.google ?? 1 });
      const again = await sweepStrandedErasures(store, { batch: 50, now: FUTURE() });
      ok(`${L} · a PURGED business is never swept again`, !again.results.some((r) => r.businessId === fx.biz.id));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // H-5 — the sweeper route, and a stranded business
  // ═════════════════════════════════════════════════════════════════════════
  if (want("sweeper")) {
    console.log("--- H-5 sweeper ---");
    const req = (auth) => new Request("http://lab.invalid/api/account/erasure-sweep", { headers: auth ? { authorization: auth } : {} });
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "";
    ok("H5-SWEEP-ROUTE · fail-closed without CRON_SECRET (503)", (await sweepRoute.GET(req(`Bearer ${saved}`))).status === 503);
    process.env.CRON_SECRET = "short";
    ok("H5-SWEEP-ROUTE · a placeholder secret is not configured (503)", (await sweepRoute.GET(req("Bearer short"))).status === 503);
    process.env.CRON_SECRET = saved;
    ok("H5-SWEEP-ROUTE · wrong bearer is refused (401)", (await sweepRoute.GET(req("Bearer nope"))).status === 401);
    ok("H5-SWEEP-ROUTE · no bearer is refused (401)", (await sweepRoute.GET(req(null))).status === 401);

    // An ACTIVE business is never erased by the sweeper.
    const active = await mk("sweep-active");
    const r0 = await sweepRoute.GET(req(`Bearer ${saved}`));
    ok("H5-SWEEP-NEVER-STARTS · the sweeper does not touch an ACTIVE business",
      r0.status === 200 && (await lifecycle(active.biz.id)) === "ACTIVE" && (await owner.message.count({ where: { businessId: active.biz.id, contentText: { not: null } } })) === 1);

    // A business stranded the way H-5 described: quarantined, erasure never finished,
    // nothing in the ledger (e.g. a deletion requested before this code shipped).
    const stranded = await mk("stranded");
    await store.quarantineAndRevokeIntegrations(stranded.biz.id, new Date());
    ok("H5-SWEEP-STRANDED · precondition: quarantined, not purged", (await lifecycle(stranded.biz.id)) === "DELETION_REQUESTED");
    const viaRoute = await sweepRoute.GET(req(`Bearer ${saved}`));
    const rb = await viaRoute.json();
    ok("H5-SWEEP-ROUTE · the authorised sweep runs (200)", viaRoute.status === 200 && rb.ok === true, JSON.stringify(rb).slice(0, 200));
    const lc = await lifecycle(stranded.biz.id);
    ok("H5-SWEEP-CONVERGES · a stranded business is completed by the sweeper", lc === "PURGED", `stranded lifecycle=${lc} after sweep`);
    if (lc === "PURGED") await assertErased("H5-SWEEP-CONVERGES · and it is fully erased", stranded);
    ok("H5-SWEEP-RESPONSE · the response carries no personal data", noPII(JSON.stringify(rb)));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // M-12(b) — provider revoke: before destruction, truthful, bounded
  // ═════════════════════════════════════════════════════════════════════════
  if (want("provider")) {
    console.log("--- M-12(b) provider revoke ---");
    const fx = await mk("provider-ok");
    const res = await requestAccountDeletion(store, { businessId: fx.biz.id, actorUserId: fx.user.id });
    ok("M12B-REVOKED · completes", res.status === "deleted", JSON.stringify(res));
    const outs = (await ledgerRows(fx.biz.id)).filter((r) => r.eventType === "ACCOUNT_ERASURE_PROVIDER_REVOKE").map((r) => `${r.payload.provider}:${r.payload.action}=${r.payload.outcome}`).sort();
    ok("M12B-TRUTHFUL · Google REVOKED, Meta unsubscribed REVOKED, Meta token / ITA / payment NOT_SUPPORTED",
      JSON.stringify(outs) === JSON.stringify([
        "google:oauth_token_revoke=REVOKED",
        "ita:oauth_token_revoke=NOT_SUPPORTED",
        "meta:token_invalidate=NOT_SUPPORTED",
        "meta:waba_unsubscribe=REVOKED",
        "payment:credential_revoke=NOT_SUPPORTED",
      ]), JSON.stringify(outs));
    ok("M12B-PLAINTEXT · Google received the REFRESH token (decrypted before destruction)",
      net.calls.some((c) => c.p === "google" && c.token === fx.gmailRefresh));
    ok("M12B-PLAINTEXT · Meta was asked to unsubscribe THIS WABA", net.calls.some((c) => c.p === "meta" && c.waba === fx.waba));

    const fx2 = await mk("provider-down");
    net.googleFail = 99;
    await requestAccountDeletion(store, { businessId: fx2.biz.id, actorUserId: fx2.user.id });
    let t = Date.now();
    for (let i = 0; i < 4 && (await lifecycle(fx2.biz.id)) !== "PURGED"; i++) {
      t += 7 * 60 * 60_000;
      await sweepStrandedErasures(store, { batch: 50, now: new Date(t) });
    }
    net.googleFail = 0;
    const g = (await ledgerRows(fx2.biz.id)).find((r) => r.eventType === "ACCOUNT_ERASURE_PROVIDER_REVOKE" && r.payload.provider === "google");
    ok("M12B-TRUTHFUL · a provider that never confirms is REVOKE_FAILED_LOCAL_DELETED — never REVOKED",
      g?.payload?.outcome === "REVOKE_FAILED_LOCAL_DELETED" && /^retries_exhausted:/.test(g.payload.reason), JSON.stringify(g?.payload));
    ok("M12B-BOUNDED · exactly 3 attempts at Google, then local destruction",
      net.calls.filter((c) => c.p === "google" && c.token === fx2.gmailRefresh).length === 3 &&
        (await owner.oAuthToken.count({ where: { connectionId: fx2.emailConnId } })) === 0);
    await assertErased("M12B-CONVERGES · the erasure still completes", fx2);
    ok("M12B-NO-NETWORK · nothing but the two documented revoke endpoints was ever called", net.other.length === 0, net.other.join(","));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // M-12(a) — authority minted before the deletion is dead
  // ═════════════════════════════════════════════════════════════════════════
  if (want("m12a")) {
    console.log("--- M-12(a) authority revocation ---");
    const fx = await mk("authority");
    const who = (t) => getAuthContext(new Request("http://lab.invalid/x", { headers: { authorization: `Bearer ${t}` } }));
    ok("M12A-PRE · the pre-deletion tokens are valid before the deletion", (await who(fx.sidToken)) !== null && (await who(fx.legacyToken)) !== null);
    const res = await requestAccountDeletion(store, { businessId: fx.biz.id, actorUserId: fx.user.id });
    ok("M12A · deletion completes", res.status === "deleted");
    const u = await owner.user.findUnique({ where: { id: fx.user.id }, select: { tokenVersion: true } });
    ok("M12A-GENERATION · the user's token generation moved", u.tokenVersion >= 1, `tokenVersion=${u.tokenVersion}`);
    ok("M12A-TOKEN-REJECTED · a session-bound token minted before the deletion is rejected", (await who(fx.sidToken)) === null);
    ok("M12A-TOKEN-REJECTED · a sid-less token minted before the deletion is rejected", (await who(fx.legacyToken)) === null);
    const rs = await refreshSession(authDb(), { credential: fx.sess.credential, now: new Date() });
    ok("M12A-REFRESH-REJECTED · the refresh cookie minted before the deletion mints nothing", rs.kind !== "rotated", JSON.stringify(rs));
    ok("M12A-SESSIONS-ERASED · no session row (and no User-Agent) survives", (await owner.authSession.count({ where: { userId: fx.user.id } })) === 0);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // M-12(c) — an in-flight writer cannot commit into a quarantined business
  // ═════════════════════════════════════════════════════════════════════════
  if (want("m12c")) {
    console.log("--- M-12(c) in-flight writers ---");
    // (1) The Gmail-callback shape: tenant context from verified state, then a
    //     withTenantTransaction that persists a connection + tokens. The business is
    //     quarantined AFTER the callback's checks and BEFORE its transaction.
    const g = await mk("inflight-gmail");
    await store.quarantineAndRevokeIntegrations(g.biz.id, new Date());
    const cb = await throws(() =>
      runWithTenantContext({ businessId: g.biz.id }, () =>
        withTenantTransaction(async (tx) => {
          const conn = await tx.emailConnection.create({
            data: { businessId: g.biz.id, provider: "gmail", emailAddress: `${MARK}late@sec-e.test`, providerAccountId: "late", scopes: "x" },
            select: { id: true },
          });
          await tx.oAuthToken.create({ data: { connectionId: conn.id, accessTokenEncrypted: `${MARK}late`, expiresAt: new Date(), encryptionKeyId: "k" }, select: { id: true } });
        })
      )
    );
    const late = await owner.emailConnection.count({ where: { businessId: g.biz.id, providerAccountId: "late" } });
    ok("M12C-INFLIGHT-REFUSED · OAuth-callback persistence after quarantine is refused by the tenant transaction",
      cb instanceof BusinessQuarantinedError && late === 0, `threw=${cb?.name} lateRows=${late}`);

    // (2) A background job (webhook intake / import / OCR) that passed runTenantJob's
    //     pre-check while ACTIVE, then opens its transaction after the quarantine.
    const j = await mk("inflight-job");
    let release;
    const gate = new Promise((r) => (release = r));
    const job = runTenantJob({ businessId: j.biz.id }, async () => {
      await gate; // the pre-check has passed; now the quarantine commits
      return withTenantTransaction((tx) =>
        tx.crmNote.create({ data: { businessId: j.biz.id, subjectType: "CUSTOMER", subjectId: 1, body: `${MARK}late-note`, createdByUserId: j.user.id }, select: { id: true } })
      );
    });
    await store.quarantineAndRevokeIntegrations(j.biz.id, new Date());
    release();
    const jobErr = await throws(() => job);
    const lateNotes = await owner.crmNote.count({ where: { businessId: j.biz.id, body: `${MARK}late-note` } });
    ok("M12C-INFLIGHT-REFUSED · a job that passed its pre-check cannot commit after the quarantine",
      jobErr instanceof BusinessQuarantinedError && lateNotes === 0, `threw=${jobErr?.name} lateRows=${lateNotes}`);

    // (3) A writer that is ALREADY inside its transaction when the deletion arrives
    //     holds the shared lifecycle lock: it commits first, the quarantine waits.
    const w = await mk("inflight-race");
    const order = [];
    const writer = runWithTenantContext({ businessId: w.biz.id }, () =>
      withTenantTransaction(async (tx) => {
        order.push("writer-in");
        await new Promise((r) => setTimeout(r, 400));
        await tx.crmNote.create({ data: { businessId: w.biz.id, subjectType: "CUSTOMER", subjectId: 1, body: "race", createdByUserId: w.user.id }, select: { id: true } });
        order.push("writer-committed");
      })
    );
    await new Promise((r) => setTimeout(r, 100));
    await store.quarantineAndRevokeIntegrations(w.biz.id, new Date());
    order.push("quarantined");
    await writer;
    ok("M12C-SERIALISED · an open writer finishes before the quarantine commits (no interleaving)",
      order.join(">") === "writer-in>writer-committed>quarantined", order.join(">"));

    // (4) The erasure authority itself is NOT refused, and does not leak to other tenants.
    const er = await throws(() =>
      runTenantJob({ businessId: w.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.count({ where: { businessId: w.biz.id } })), { quarantinePolicy: "erasure" })
    );
    ok("M12C-ERASURE-AUTHORITY · the erasure can still act on the quarantined business", er === null, String(er));
    const ctrl = await throws(() =>
      runWithTenantContext({ businessId: CONTROL.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.count({ where: { businessId: CONTROL.biz.id } })))
    );
    ok("M12C-CONTROL · an ACTIVE business is unaffected by the gate", ctrl === null, String(ctrl));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // M-13 — pointer-less content uploads, erased by prefix
  // ═════════════════════════════════════════════════════════════════════════
  if (want("content")) {
    console.log("--- M-13 content prefix ---");
    const fx = await mk("content");
    const before = (await realStorage.listByPrefix(`biz/${fx.biz.id}/content/`)).keys.length;
    ok("M13-CONTENT-PRE · two content uploads exist and NO row points at them", before === 2);
    await requestAccountDeletion(store, { businessId: fx.biz.id, actorUserId: fx.user.id });
    const after = (await realStorage.listByPrefix(`biz/${fx.biz.id}/content/`)).keys.length;
    ok("M13-CONTENT-ERASED · every content object of the deleted business is gone", after === 0, `remaining=${after}`);
    const refused = await throws(() => realStorage.listByPrefix("biz/"));
    ok("M13-PREFIX-BOUNDED · a listing wider than one tenant domain is refused", refused?.name === "StorageKeyError", String(refused?.name));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // The tenant transaction wrapper — eight properties, each with its own label
  // ═════════════════════════════════════════════════════════════════════════
  if (want("wrapper")) {
    console.log("--- wrapper properties (NOBYPASSRLS runtime role) ---");
    const { prisma: rtPrisma } = await import("@/lib/prisma");
    const { getTenantContext, TenantContextError } = await import("@/lib/tenant/context");
    const { tenantTx } = await import("@/lib/tenant/tenant-tx");
    const { runWithErasureAuthority } = await import("@/lib/tenant/erasure-authority");
    const { TenantTransactionNestingError } = await import("@/lib/tenant/transaction");
    const A = await mk("wrap-a");
    const B = await mk("wrap-b");
    const guc = (db) => db.$queryRaw`SELECT NULLIF(current_setting('app.current_business_id', true), '') AS g, pg_backend_pid() AS pid, txid_current_if_assigned()::text AS tx`;
    const noteData = (fx, body) => ({ businessId: fx.biz.id, subjectType: "CUSTOMER", subjectId: 1, body, createdByUserId: fx.user.id });

    // W1 — the GUC is transaction-local: it never survives onto the pooled connection.
    for (let i = 0; i < 5; i++) {
      await runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.count({ where: { businessId: A.biz.id } })));
    }
    const leaks = [];
    for (let i = 0; i < 30; i++) {
      const [r] = await guc(rtPrisma);
      if (r.g !== null) leaks.push(`${r.pid}:${r.g}`);
    }
    ok("W1-GUC-TX-LOCAL · no pooled connection carries a tenant GUC after the transaction", leaks.length === 0, leaks.join(","));

    // W2 — the GUC set is exactly the context's tenant.
    const seen = await runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction(async (tx) => (await guc(tx))[0].g));
    ok("W2-GUC-MATCHES-CONTEXT · the transaction's GUC equals the ALS tenant", seen === String(A.biz.id), `guc=${seen} ctx=${A.biz.id}`);

    // W3 — no context: refused before any transaction is opened.
    ok("W3-NO-CONTEXT-FAILS-CLOSED · precondition: no ambient context", getTenantContext() === undefined);
    let opened = false;
    const w3 = await throws(() => withTenantTransaction(async () => { opened = true; }));
    ok("W3-NO-CONTEXT-FAILS-CLOSED · withTenantTransaction without a context throws and runs nothing",
      w3 instanceof TenantContextError && opened === false, `threw=${w3?.name} ran=${opened}`);

    // W4 — cross-tenant: a switch is refused, and RLS refuses B's row under A's GUC.
    const sw = await throws(() =>
      runWithTenantContext({ businessId: A.biz.id }, () => runWithTenantContext({ businessId: B.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.create({ data: noteData(B, `${MARK}xswitch`), select: { id: true } }))))
    );
    const xw = await throws(() =>
      runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.create({ data: noteData(B, `${MARK}xwrite`), select: { id: true } })))
    );
    const xr = await runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.count({ where: { businessId: B.biz.id } })));
    const bLeak = await owner.crmNote.count({ where: { businessId: B.biz.id, body: { in: [`${MARK}xswitch`, `${MARK}xwrite`] } } });
    ok("W4-CROSS-TENANT-REFUSED · a nested tenant switch throws; A's GUC cannot write or read B's rows (RLS 42501 / zero rows)",
      sw instanceof TenantContextError && /42501|row-level security/i.test(String(xw?.message) + JSON.stringify(xw?.meta ?? {})) && xr === 0 && bLeak === 0,
      `switch=${sw?.name} write=${String(xw?.message).split("\n").slice(-1)[0]} readB=${xr} leaked=${bLeak}`);

    // W5 — rollback: a throw inside commits nothing, and leaves no GUC behind.
    const w5 = await throws(() =>
      runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction(async (tx) => {
        await tx.crmNote.create({ data: noteData(A, `${MARK}rolled-back`), select: { id: true } });
        throw new Error("lab: abort");
      }))
    );
    const survived = await owner.crmNote.count({ where: { body: `${MARK}rolled-back` } });
    const [after5] = await guc(rtPrisma);
    ok("W5-ROLLBACK · a throw inside the callback propagates and commits nothing (row and GUC)",
      w5?.message === "lab: abort" && survived === 0 && after5.g === null, `threw=${w5?.message} rows=${survived} guc=${after5.g}`);

    // W6 — nesting never opens a second transaction silently.
    let innerRan = false;
    const w6 = await throws(() =>
      runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction(async () => {
        await tenantTx(A.biz.id, async () => { innerRan = true; });
      }))
    );
    ok("W6-NO-SILENT-NESTING · a tenant transaction opened inside another is refused, loudly",
      w6 instanceof TenantTransactionNestingError && innerRan === false, `threw=${w6?.name} innerRan=${innerRan}`);
    // ...and work that merely STARTED inside a transaction but runs after it closed is not nesting.
    let later;
    await runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction(async () => {
      // Scheduled INSIDE (it inherits both the tenant context and the open-transaction marker), run AFTER.
      later = new Promise((r) => setTimeout(r, 200)).then(() => withTenantTransaction((tx) => tx.crmNote.count({ where: { businessId: A.biz.id } })));
      later.catch(() => {});
    }));
    const w6b = await throws(() => later);
    ok("W6-NO-SILENT-NESTING · a continuation after the outer transaction ended runs normally", w6b === null, String(w6b));

    // W7 — no bare-Prisma fallback: the callback's client IS the transaction, under the GUC.
    const w7 = await runWithTenantContext({ businessId: A.biz.id }, () => withTenantTransaction(async (tx) => {
      const [r] = await guc(tx);
      const n = await tx.crmNote.count({ where: { businessId: A.biz.id } });
      return { g: r.g, n, notBare: tx !== rtPrisma };
    }));
    const bare = await rtPrisma.crmNote.count({ where: { businessId: A.biz.id } });
    ok("W7-NO-BARE-FALLBACK · the callback runs inside a real transaction with the GUC, reaching rows a bare client cannot",
      w7.notBare && w7.g === String(A.biz.id) && w7.n >= 1 && bare === 0, JSON.stringify({ ...w7, bare }));

    // W8 — the erasure bypass is narrow.
    await store.quarantineAndRevokeIntegrations(B.biz.id, new Date());
    const w8a = await throws(() =>
      runWithTenantContext({ businessId: B.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.create({ data: noteData(B, `${MARK}w8a`), select: { id: true } })))
    );
    const w8b = await throws(() =>
      runWithErasureAuthority(A.biz.id, () => runWithTenantContext({ businessId: B.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.create({ data: noteData(B, `${MARK}w8b`), select: { id: true } }))))
    );
    const w8c = await throws(() => runTenantJob({ businessId: B.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.count())));
    const w8rows = await owner.crmNote.count({ where: { body: { in: [`${MARK}w8a`, `${MARK}w8b`] } } });
    const w8d = await throws(() => runTenantJob({ businessId: B.biz.id }, () => withTenantTransaction((tx) => tx.crmNote.count({ where: { businessId: B.biz.id } })), { quarantinePolicy: "erasure" }));
    ok("W8-BYPASS-NARROW · a normal writer, a normal job, and an authority held for ANOTHER business are refused on a quarantined tenant; only the erasure policy passes",
      w8a instanceof BusinessQuarantinedError && w8b instanceof BusinessQuarantinedError && w8c instanceof BusinessQuarantinedError && w8rows === 0 && w8d === null,
      `normal=${w8a?.name} foreignAuthority=${w8b?.name} job=${w8c?.name} rows=${w8rows} erasure=${w8d}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Workstream F compatibility — append-only audit rows survive the erasure untouched
  // ═════════════════════════════════════════════════════════════════════════
  if (want("audit")) {
    console.log("--- F: append-only audit compatibility ---");
    const fx = await mk("audit");
    let seeded = true;
    try {
      await owner.$executeRawUnsafe(
        `INSERT INTO "BillingAuditEvent" ("businessId","actorUserId","eventType","summary","eventHash") VALUES (${fx.biz.id}, ${fx.user.id}, 'LAB_EVENT', 'lab', 'lab-hash-${fx.biz.id}')`
      );
    } catch (e) {
      seeded = false;
      console.log(`  [info] audit row could not be seeded under this schema: ${String(e.message).split("\n")[0]}`);
    }
    const res = await requestAccountDeletion(store, { businessId: fx.biz.id, actorUserId: fx.user.id });
    ok("F-AUDIT · the erasure completes with an audit row pointing at the user", res.status === "deleted", JSON.stringify(res));
    if (seeded) {
      const rows = await owner.$queryRawUnsafe(`SELECT "actorUserId", "summary" FROM "BillingAuditEvent" WHERE "businessId" = ${fx.biz.id}`);
      ok("F-AUDIT · the audit row is intact (never updated, never deleted; its User was anonymised, not deleted)",
        rows.length === 1 && rows[0].actorUserId === fx.user.id && rows[0].summary === "lab", JSON.stringify(rows));
    }
    ok("F-AUDIT · the User row still exists (anonymised in place)", (await owner.user.count({ where: { id: fx.user.id } })) === 1);
  }

  // ── The control tenant, untouched by everything ──────────────────────────
  console.log("--- control ---");
  const ctrlContent = (await realStorage.listByPrefix(`biz/${CONTROL.biz.id}/content/`)).keys.length;
  ok("CONTROL · the control tenant is ACTIVE, its content, messages, tokens and sessions intact",
    (await lifecycle(CONTROL.biz.id)) === "ACTIVE" && ctrlContent === 2 &&
      (await owner.message.count({ where: { businessId: CONTROL.biz.id, contentText: { not: null } } })) === 1 &&
      (await owner.oAuthToken.count({ where: { connectionId: CONTROL.emailConnId } })) === 1 &&
      (await owner.authSession.count({ where: { userId: CONTROL.user.id, revokedAt: null } })) === 1 &&
      (await getAuthContext(new Request("http://lab.invalid/x", { headers: { authorization: `Bearer ${CONTROL.sidToken}` } }))) !== null,
    `content=${ctrlContent}`);

  console.log(`\n[sec-e] PASS=${pass} FAIL=${fail}`);
  console.log(fail === 0 ? "SEC-E BATTERY = PASS" : `SEC-E BATTERY = FAIL (${failures.join(" ; ")})`);
  await owner.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[sec-e] SETUP CRASH — this is a FAILURE, not a pass:", e);
  process.exit(2);
});
