/**
 * Gmail token crypto at rest (L-17, supersedes Slice B's enc_v0 upgrade).
 *
 * Proves against a real database, through getGmailAccessTokenForBusiness:
 *   - an `enc_v0` (plaintext) row is QUARANTINED: reconnect required, the
 *     plaintext is never sent to Google;
 *   - an existing `gcm_v1` row keeps working and is re-encrypted to row-bound
 *     `gcm_v2` on refresh (same token);
 *   - a subsequent refresh works and leaves the v2 blob untouched;
 *   - a v2 blob copied onto another connection row does not decrypt;
 *   - the upgrade is fail-safe (missing key => no upgrade, never throws).
 *
 * DB-backed integration test (pattern: crm-notes / billing-issue guards), gated
 * by a fail-closed Database Safety Guard, hermetic via a `globalThis.fetch` stub
 * for the Google token endpoint (no network, no production DI change). Manual /
 * local (CI runs no DB).
 *
 * Run:
 *   TEST_DATABASE_URL="postgres://…<approved dev/test DB>…" \
 *     npx tsx lib/services/integrations/gmail/gmail-refresh-token-upgrade.test.ts
 */

// ---------------------------------------------------------------------------
// Database Safety Guard (fail-closed) — before any DB import/connect.
// ---------------------------------------------------------------------------
const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test/dev Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL."
  );
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
process.env.GMAIL_TOKEN_ENCRYPTION_KEY =
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32-byte hex (test)
process.env.GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID || "test-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET || "test-client-secret";

import assert from "node:assert/strict";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const enc0 = (s: string) => "enc_v0:" + Buffer.from(s, "utf8").toString("base64");

// Hermetic Google token endpoint: intercept the refresh call, pass everything
// else through. Records the refresh_token the service actually sent.
const realFetch = globalThis.fetch;
let lastRefreshTokenSent: string | null = null;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  if (url.includes("oauth2.googleapis.com/token")) {
    try {
      lastRefreshTokenSent = init?.body?.get?.("refresh_token") ?? null;
    } catch {
      lastRefreshTokenSent = null;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: `new-access-${runId}`,
        expires_in: 3600,
        token_type: "Bearer",
      }),
      text: async () => "",
    };
  }
  return realFetch(input, init);
}) as typeof globalThis.fetch;

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { getGmailAccessTokenForBusiness } = await import(
    "@/lib/services/integrations/gmail/gmail-auth.service"
  );
  const { decryptToken, refreshTokenUpgrade } = await import(
    "@/lib/services/integrations/gmail/token-crypto.placeholder"
  );
  const { GmailReauthRequiredError } = await import(
    "@/lib/services/integrations/gmail/gmail-errors"
  );
  const { createCipheriv, randomBytes } = await import("node:crypto");

  // A gcm_v1 blob exactly as the pre-L-17 code wrote it (no AAD, key "k0").
  const V1_KEY_HEX = process.env.GMAIL_TOKEN_ENCRYPTION_KEY!;
  const gcmV1 = (plain: string) => {
    const key = Buffer.from(V1_KEY_HEX, "hex");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `gcm_v1:${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
  };

  // ===================== Helper unit assertions (hermetic) =====================
  const rt = `refresh-plain-${runId}`;
  assert.deepEqual(
    refreshTokenUpgrade(enc0(rt), rt, { businessId: 1, connectionId: 1 }),
    {},
    "enc_v0 is quarantined: never re-armed as a credential"
  );
  const up = refreshTokenUpgrade(gcmV1(rt), rt, { businessId: 1, connectionId: 1 });
  assert.ok(up.refreshTokenEncrypted?.startsWith("gcm_v2:k0:"), "gcm_v1 -> gcm_v2 upgrade is produced");
  assert.equal(
    decryptToken(up.refreshTokenEncrypted, { businessId: 1, connectionId: 1, field: "refresh" }),
    rt,
    "upgraded blob round-trips to the SAME token under its own row"
  );
  const savedKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  assert.deepEqual(
    refreshTokenUpgrade(gcmV1("x"), "x", { businessId: 1, connectionId: 1 }),
    {},
    "missing key -> fail-safe no-op (no throw)"
  );
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = savedKey;
  console.log("OK helper: enc_v0 quarantined, gcm_v1->gcm_v2 round-trip, fail-safe on missing key.");

  const businessIds: number[] = [];
  try {
    const b = await prisma.business.create({ data: { name: `GmailIso ${runId}` } });
    businessIds.push(b.id);
    const mkConn = (suffix: string) =>
      prisma.emailConnection.create({
        data: {
          businessId: b.id,
          provider: "gmail",
          status: "connected",
          emailAddress: `iso-${suffix}-${runId}@example.test`,
          providerAccountId: `acct-${suffix}-${runId}`,
          scopes: "https://www.googleapis.com/auth/gmail.readonly",
        },
      });

    // ============ enc_v0 (plaintext at rest) => reconnect required ============
    const conn0 = await mkConn("v0");
    await prisma.oAuthToken.create({
      data: {
        connectionId: conn0.id,
        accessTokenEncrypted: enc0("old-access"),
        refreshTokenEncrypted: enc0(rt),
        expiresAt: new Date(Date.now() - 60_000),
        tokenType: "Bearer",
        encryptionKeyId: "enc_v0",
      },
    });
    lastRefreshTokenSent = null;
    let reauth: unknown = null;
    try {
      await getGmailAccessTokenForBusiness({ businessId: b.id, connectionId: conn0.id });
    } catch (e) {
      reauth = e;
    }
    assert.ok(
      reauth instanceof GmailReauthRequiredError && reauth.reason === "token_undecryptable",
      "enc_v0 row => GmailReauthRequiredError(token_undecryptable)"
    );
    assert.equal(lastRefreshTokenSent, null, "the plaintext token was never sent to Google");
    console.log("OK quarantine: enc_v0 connection requires reconnect; no Google call.");

    // ============ gcm_v1 (existing ciphertext) keeps working, upgraded to v2 ============
    const conn1 = await mkConn("v1");
    await prisma.oAuthToken.create({
      data: {
        connectionId: conn1.id,
        accessTokenEncrypted: gcmV1("old-access"),
        refreshTokenEncrypted: gcmV1(rt),
        expiresAt: new Date(Date.now() - 60_000),
        tokenType: "Bearer",
        encryptionKeyId: "gcm_v1",
      },
    });
    const res1 = await getGmailAccessTokenForBusiness({ businessId: b.id, connectionId: conn1.id });
    assert.equal(res1.accessToken, `new-access-${runId}`, "refresh returned the new access token");
    assert.equal(lastRefreshTokenSent, rt, "gcm_v1 refresh token decrypted and used");
    const row1 = await prisma.oAuthToken.findUniqueOrThrow({ where: { connectionId: conn1.id } });
    const ctx1 = { businessId: b.id, connectionId: conn1.id };
    assert.ok(row1.refreshTokenEncrypted?.startsWith("gcm_v2:k0:"), "refresh token re-encrypted to gcm_v2");
    assert.equal(decryptToken(row1.refreshTokenEncrypted, { ...ctx1, field: "refresh" }), rt, "same token");
    assert.ok(row1.accessTokenEncrypted.startsWith("gcm_v2:k0:"), "new access token stored as gcm_v2");
    assert.equal(row1.encryptionKeyId, "gcm_v2:k0", "encryptionKeyId records format + key id");
    console.log("OK behavioral: gcm_v1 -> gcm_v2 on refresh, same token.");

    // ============ subsequent refresh: works, v2 refresh blob untouched ============
    await prisma.oAuthToken.update({
      where: { connectionId: conn1.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res2 = await getGmailAccessTokenForBusiness({ businessId: b.id, connectionId: conn1.id });
    assert.equal(res2.accessToken, `new-access-${runId}`, "second refresh still succeeds");
    const row2 = await prisma.oAuthToken.findUniqueOrThrow({ where: { connectionId: conn1.id } });
    assert.equal(row2.refreshTokenEncrypted, row1.refreshTokenEncrypted, "v2 refresh blob left unchanged (no-op)");
    console.log("OK no-regression: subsequent refresh works; v2 untouched.");

    // ============ a v2 blob copied onto another row is useless ============
    const conn2 = await mkConn("copy");
    await prisma.oAuthToken.create({
      data: {
        connectionId: conn2.id,
        accessTokenEncrypted: row2.accessTokenEncrypted,
        refreshTokenEncrypted: row2.refreshTokenEncrypted,
        expiresAt: new Date(Date.now() + 3_600_000),
        tokenType: "Bearer",
        encryptionKeyId: row2.encryptionKeyId,
      },
    });
    let copied: unknown = null;
    try {
      await getGmailAccessTokenForBusiness({ businessId: b.id, connectionId: conn2.id });
    } catch (e) {
      copied = e;
    }
    assert.ok(
      copied instanceof GmailReauthRequiredError && copied.reason === "token_undecryptable",
      "v2 blobs copied to another connection row do not decrypt (AAD binding)"
    );
    console.log("OK binding: copied v2 ciphertext refused on another row.");

    console.log("PASS — gmail token crypto: v1 readable+upgraded, v2 row-bound, enc_v0 quarantined.");
  } finally {
    if (businessIds.length > 0) {
      const where = { businessId: { in: businessIds } };
      const conns = await prisma.emailConnection
        .findMany({ where, select: { id: true } })
        .catch(() => [] as { id: number }[]);
      const connIds = conns.map((c) => c.id);
      if (connIds.length > 0) {
        await prisma.oAuthToken
          .deleteMany({ where: { connectionId: { in: connIds } } })
          .catch(() => {});
      }
      await prisma.emailConnection.deleteMany({ where }).catch(() => {});
      await prisma.business.deleteMany({ where: { id: { in: businessIds } } }).catch(() => {});
    }
    globalThis.fetch = realFetch;
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((e) => {
  console.error("FAIL —", e);
  process.exit(1);
});
