// Full scope URIs (not the OIDC "email"/"profile" shorthand) so the runtime
// request matches the Cloud Console scope declaration string-for-string, per
// Google's OAuth verification scope-alignment requirement.
export const GMAIL_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  // Required for the current Gmail import flow: message discovery, MIME
  // structure inspection, and attachment retrieval for OCR/import.
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export type GmailAuthorizeUrlInput = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export function buildGmailAuthorizeUrl(input: GmailAuthorizeUrlInput): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return url.toString();
}

