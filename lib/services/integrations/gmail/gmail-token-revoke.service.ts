/**
* Best-effort revocation of a Gmail OAuth token against Google's token
* revocation endpoint, per Google's official OAuth 2.0 documentation
* (developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke):
*
*   POST https://oauth2.googleapis.com/revoke
*   Content-Type: application/x-www-form-urlencoded
*   token=<access_token_or_refresh_token>
*
* Per that doc: "The token can be an access token or a refresh token. If the
* token is an access token and it has a corresponding refresh token, the
* refresh token will also be revoked." So callers should prefer the refresh
* token when stored, falling back to the access token - there is no need to
* revoke both.
*
* This call is BEST-EFFORT only. A failure (network error, timeout, or a
* non-2xx response) must never block or fail the caller's local disconnect
* flow - the local token row remains the source of truth for whether this
* app can use Gmail again.
*/

const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const REVOKE_TIMEOUT_MS = 5000;

export type RevokeGoogleGmailTokenResult =
  | { ok: true }
| {
  ok: false;
  reason: "no_token" | "network_error" | "timeout" | "http_error";
};

export type RevokeGoogleGmailTokenDeps = {
  fetchImpl: typeof fetch;
};

function defaultDeps(): RevokeGoogleGmailTokenDeps {
  return { fetchImpl: fetch };
}

/**
* Sends a best-effort revoke request for a single Gmail OAuth token.
* Never throws - every failure path is returned as `{ ok: false, reason }`.
*/
export async function revokeGoogleGmailToken(
  token: string | null | undefined,
  depsOverride?: Partial<RevokeGoogleGmailTokenDeps>
  ): Promise<RevokeGoogleGmailTokenResult> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) {
    return { ok: false, reason: "no_token" };
  }

const deps: RevokeGoogleGmailTokenDeps = { ...defaultDeps(), ...depsOverride };

const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);

try {
  const res = await deps.fetchImpl(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(trimmed)}`,
    signal: controller.signal,
  });

  if (!res.ok) {
    return { ok: false, reason: "http_error" };
  }
  return { ok: true };
} catch (err) {
  if (err instanceof Error && err.name === "AbortError") {
    return { ok: false, reason: "timeout" };
  }
  return { ok: false, reason: "network_error" };
} finally {
  clearTimeout(timer);
}
}
