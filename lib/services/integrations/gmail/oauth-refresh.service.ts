import { GmailReauthRequiredError } from "./gmail-errors";

export type GoogleRefreshTokenResponse = {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

export async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleRefreshTokenResponse> {
  const body = new URLSearchParams();
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", input.refreshToken);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Google returns 400 (invalid_grant) when the refresh token is revoked or
    // expired — unrecoverable without the user reconnecting. 5xx and other
    // failures are treated as transient (generic error -> 500 upstream).
    if (res.status === 400) {
      throw new GmailReauthRequiredError(
        "refresh_rejected",
        `Google refresh rejected (400): ${text || res.statusText}`
      );
    }
    throw new Error(
      `Google refresh failed (${res.status}): ${text || res.statusText}`
    );
  }

  return (await res.json()) as GoogleRefreshTokenResponse;
}

