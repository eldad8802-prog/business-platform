import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4C: run a single DB step on a short tenant transaction when a tenant
// context is established (all Gmail routes set one); outside a context the
// step runs directly (pure unit tests). Under an established context there is
// NO fallback to the global client. External Google calls NEVER run inside.
async function dbStep<T>(
  fn: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma);
}
import {
  decryptToken,
  encryptToken,
  refreshTokenUpgrade,
} from "./token-crypto.placeholder";
import { refreshGoogleAccessToken } from "./oauth-refresh.service";
import { GmailReauthRequiredError } from "./gmail-errors";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function getGmailAccessTokenForBusiness(params: {
  businessId: number;
  connectionId?: number;
}): Promise<{
  connectionId: number;
  accessToken: string;
}> {
  const connection = await dbStep((db) => db.emailConnection.findFirst({
    where: {
      businessId: params.businessId,
      provider: "gmail",
      status: "connected",
      ...(params.connectionId ? { id: params.connectionId } : {}),
    },
    include: { token: true },
  }));

  if (!connection || !connection.token) {
    throw new GmailReauthRequiredError("no_connection");
  }
  const tokenRow = connection.token;

  // L-17: v2 blobs are bound to (business, connection, field); enc_v0 is
  // quarantined and decrypts to null → reconnect required.
  const tokenCtx = { businessId: connection.businessId, connectionId: connection.id };
  const accessToken = decryptToken(tokenRow.accessTokenEncrypted, { ...tokenCtx, field: "access" });
  const refreshToken = decryptToken(tokenRow.refreshTokenEncrypted, { ...tokenCtx, field: "refresh" });
  if (!accessToken) {
    throw new GmailReauthRequiredError(
      "token_undecryptable",
      "Missing/decrypt failed: access token"
    );
  }
  if (!refreshToken) {
    throw new GmailReauthRequiredError(
      "token_undecryptable",
      "Missing/decrypt failed: refresh token"
    );
  }

  const now = Date.now();
  const expiresMs = new Date(tokenRow.expiresAt).getTime();
  const needsRefresh = !Number.isFinite(expiresMs) || expiresMs <= now + 60_000;

  if (!needsRefresh) {
    return { connectionId: connection.id, accessToken };
  }

  const refreshed = await refreshGoogleAccessToken({
    clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    refreshToken,
  });

  const enc = encryptToken(refreshed.access_token, { ...tokenCtx, field: "access" });
  if (!enc) throw new Error("Failed to encrypt refreshed access token");

  const newExpiresAt = new Date(Date.now() + Math.max(0, refreshed.expires_in) * 1000);

  // Write on its own short tenant tx AFTER the external refresh; tenant-
  // scoped via the RLS parent-join (connection.id came from the tenant read).
  await dbStep((db) => db.oAuthToken.update({
    where: { connectionId: connection.id },
    data: {
      accessTokenEncrypted: enc.encrypted,
      expiresAt: newExpiresAt,
      tokenType: refreshed.token_type ?? tokenRow.tokenType,
      encryptionKeyId: enc.keyId,
      // Best-effort, fail-safe: re-encrypt a gcm_v1 (unbound) refresh token to
      // row-bound gcm_v2. Absent field => no upgrade; never blocks the refresh.
      ...refreshTokenUpgrade(
        tokenRow.refreshTokenEncrypted,
        refreshToken,
        tokenCtx
      ),
    },
  }));

  return { connectionId: connection.id, accessToken: refreshed.access_token };
}

