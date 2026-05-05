import { prisma } from "@/lib/prisma";
import { decryptToken, encryptToken } from "./token-crypto.placeholder";
import { refreshGoogleAccessToken } from "./oauth-refresh.service";

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
  const connection = await prisma.emailConnection.findFirst({
    where: {
      businessId: params.businessId,
      provider: "gmail",
      status: "connected",
      ...(params.connectionId ? { id: params.connectionId } : {}),
    },
    include: { token: true },
  });

  if (!connection || !connection.token) {
    throw new Error("No connected Gmail integration found");
  }

  const accessToken = decryptToken(connection.token.accessTokenEncrypted);
  const refreshToken = decryptToken(connection.token.refreshTokenEncrypted);
  if (!accessToken) throw new Error("Missing/decrypt failed: access token");
  if (!refreshToken) throw new Error("Missing/decrypt failed: refresh token");

  const now = Date.now();
  const expiresMs = new Date(connection.token.expiresAt).getTime();
  const needsRefresh = !Number.isFinite(expiresMs) || expiresMs <= now + 60_000;

  if (!needsRefresh) {
    return { connectionId: connection.id, accessToken };
  }

  const refreshed = await refreshGoogleAccessToken({
    clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    refreshToken,
  });

  const enc = encryptToken(refreshed.access_token);
  if (!enc) throw new Error("Failed to encrypt refreshed access token");

  const newExpiresAt = new Date(Date.now() + Math.max(0, refreshed.expires_in) * 1000);

  await prisma.oAuthToken.update({
    where: { connectionId: connection.id },
    data: {
      accessTokenEncrypted: enc.encrypted,
      expiresAt: newExpiresAt,
      tokenType: refreshed.token_type ?? connection.token.tokenType,
      encryptionKeyId: enc.keyId,
    },
  });

  return { connectionId: connection.id, accessToken: refreshed.access_token };
}

