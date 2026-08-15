/**
 * Regression test for Slice B — opportunistic, fail-safe upgrade of a legacy
 * plaintext (`enc_v0:`) Gmail refresh token to strong `gcm_v1` encryption during
 * a successful token refresh.
 *
 * Proves the invariant the user asked for:
 *   - a refresh with an `enc_v0` refresh token succeeds,
 *   - the SAME refresh token is preserved (logically identical),
 *   - the at-rest format becomes `gcm_v1`,
 *   - a subsequent refresh still works (no regression),
 *   - an already-strong (`gcm_v1`) refresh token is left untouched (no-op),
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
  const { decryptToken, legacyRefreshTokenUpgrade } = await import(
    "@/lib/services/integrations/gmail/token-crypto.placeholder"
  );

  // ===================== Helper unit assertions (hermetic) =====================
  const rt = `refresh-plain-${runId}`;
  const up = legacyRefreshTokenUpgrade(enc0(rt), rt);
  assert.ok(
    up.refreshTokenEncrypted?.startsWith("gcm_v1:"),
    "enc_v0 -> gcm_v1 upgrade is produced"
  );
  assert.equal(
    decryptToken(up.refreshTokenEncrypted),
    rt,
    "upgraded blob round-trips to the SAME token"
  );
  assert.deepEqual(
    legacyRefreshTokenUpgrade("gcm_v1:already-strong", rt),
    {},
    "already gcm_v1 -> no upgrade"
  );
  assert.deepEqual(legacyRefreshTokenUpgrade(null, rt), {}, "null -> no upgrade");
  // Fail-safe: missing key -> {} and NEVER throws.
  const savedKey = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  assert.deepEqual(
    legacyRefreshTokenUpgrade(enc0(rt), rt),
    {},
    "missing key -> fail-safe no-op (no throw)"
  );
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = savedKey;
  console.log("OK helper: enc_v0->gcm_v1 round-trip, no-op on strong, fail-safe on missing key.");

  const businessIds: number[] = [];
  try {
    // ============ Behavioral: enc_v0 refresh token upgraded on refresh ============
    const b = await prisma.business.create({ data: { name: `GmailIso ${runId}` } });
    businessIds.push(b.id);
    const conn = await prisma.emailConnection.create({
      data: {
        businessId: b.id,
        provider: "gmail",
        status: "connected",
        emailAddress: `iso-${runId}@example.test`,
        providerAccountId: `acct-${runId}`,
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
      },
    });
    await prisma.oAuthToken.create({
      data: {
        connectionId: conn.id,
        accessTokenEncrypted: enc0("old-access"),
        refreshTokenEncrypted: enc0(rt), // legacy plaintext refresh token
        expiresAt: new Date(Date.now() - 60_000), // expired -> needsRefresh
        tokenType: "Bearer",
        encryptionKeyId: "enc_v0",
      },
    });

    const res1 = await getGmailAccessTokenForBusiness({
      businessId: b.id,
      connectionId: conn.id,
    });
    assert.equal(res1.accessToken, `new-access-${runId}`, "refresh returned the new access token");
    assert.equal(
      lastRefreshTokenSent,
      rt,
      "service decrypted the enc_v0 refresh token and used it for the Google call"
    );

    const row1 = await prisma.oAuthToken.findUniqueOrThrow({
      where: { connectionId: conn.id },
    });
    assert.ok(
      row1.refreshTokenEncrypted?.startsWith("gcm_v1:"),
      "refresh token upgraded to gcm_v1 at rest"
    );
    assert.equal(
      decryptToken(row1.refreshTokenEncrypted),
      rt,
      "upgraded refresh token decrypts to the SAME token (logically identical)"
    );
    assert.ok(
      row1.accessTokenEncrypted.startsWith("gcm_v1:"),
      "new access token stored as gcm_v1"
    );
    console.log("OK behavioral: enc_v0 refresh token -> gcm_v1, same token, refresh succeeded.");

    // ================= No regression: subsequent refresh still works =================
    await prisma.oAuthToken.update({
      where: { connectionId: conn.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res2 = await getGmailAccessTokenForBusiness({
      businessId: b.id,
      connectionId: conn.id,
    });
    assert.equal(res2.accessToken, `new-access-${runId}`, "second refresh still succeeds");
    assert.equal(lastRefreshTokenSent, rt, "second refresh used the same (now gcm_v1) refresh token");
    console.log("OK no-regression: subsequent refresh works with the upgraded token.");

    // ==================== No-op: a gcm_v1 refresh token is untouched ====================
    const conn2 = await prisma.emailConnection.create({
      data: {
        businessId: b.id,
        provider: "gmail",
        status: "connected",
        emailAddress: `iso2-${runId}@example.test`,
        providerAccountId: `acct2-${runId}`,
        scopes: "https://www.googleapis.com/auth/gmail.readonly",
      },
    });
    const rt2 = `refresh2-${runId}`;
    const gcmRefresh = legacyRefreshTokenUpgrade(enc0(rt2), rt2).refreshTokenEncrypted!;
    assert.ok(gcmRefresh.startsWith("gcm_v1:"), "prepared a gcm_v1 refresh token");
    await prisma.oAuthToken.create({
      data: {
        connectionId: conn2.id,
        accessTokenEncrypted: enc0("old2"),
        refreshTokenEncrypted: gcmRefresh,
        expiresAt: new Date(Date.now() - 60_000),
        tokenType: "Bearer",
        encryptionKeyId: "gcm_v1",
      },
    });
    await getGmailAccessTokenForBusiness({ businessId: b.id, connectionId: conn2.id });
    const row2 = await prisma.oAuthToken.findUniqueOrThrow({
      where: { connectionId: conn2.id },
    });
    assert.equal(
      row2.refreshTokenEncrypted,
      gcmRefresh,
      "already-gcm_v1 refresh token left byte-for-byte unchanged (no-op)"
    );
    console.log("OK no-op: already-strong refresh token untouched.");

    console.log("PASS — gmail refresh-token opportunistic upgrade (enc_v0 -> gcm_v1), fail-safe.");
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
