/**
 * A local stand-in for Google's OAuth endpoints, for the browser lab only (never deployed).
 *
 *   GET  /authorize   checks client_id, redirect_uri, scope, PKCE S256, state and nonce, then sends the browser
 *                     back to the redirect URI with a one-time code — or with error=access_denied when the
 *                     next sign-in was set to "cancel";
 *   POST /token       one-time code + the PKCE verifier (+ the client secret) → an RS256 ID token for the
 *                     chosen identity, signed with a key published at /jwks (iss https://accounts.google.com);
 *   GET  /jwks        the public key;
 *   POST /__next      the browser lab picks who the next sign-in is ({ sub, email, name } or { cancel: true }).
 *
 * The app reaches these only with GOOGLE_LOGIN_TEST_ENDPOINTS=1 outside any Vercel deployment
 * (lib/auth/google-oauth.ts). env: MOCK_GOOGLE_PORT, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_REDIRECT_URI.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

const PORT = Number(process.env.MOCK_GOOGLE_PORT ?? 3901);
const CLIENT_ID = process.env.MOCK_CLIENT_ID ?? "lab-client.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET ?? "lab-secret";
const REDIRECT_URI = process.env.MOCK_REDIRECT_URI ?? "http://localhost:3611/api/auth/google/callback";

type Next = { sub: string; email: string; name: string } | { cancel: true };
let next: Next | null = null;
const codes = new Map<string, { nonce: string; challenge: string; who: { sub: string; email: string; name: string } }>();

async function main() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "mock-google-1", alg: "RS256", use: "sig" };
  const key = privateKey;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const readBody = () => new Promise<string>((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });

    if (req.method === "POST" && url.pathname === "/__next") {
      next = JSON.parse(await readBody()) as Next;
      return send(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/authorize") {
      const p = url.searchParams;
      const problems = [
        p.get("client_id") !== CLIENT_ID && "client_id",
        p.get("redirect_uri") !== REDIRECT_URI && "redirect_uri",
        p.get("response_type") !== "code" && "response_type",
        p.get("scope") !== "openid email profile" && "scope",
        p.get("code_challenge_method") !== "S256" && "pkce",
        !p.get("state") && "state",
        !p.get("nonce") && "nonce",
        p.get("prompt") !== "select_account" && "prompt",
      ].filter(Boolean);
      if (problems.length) return send(400, { error: "bad_request", problems });
      const back = new URL(REDIRECT_URI);
      back.searchParams.set("state", p.get("state")!);
      if (!next || "cancel" in next) {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(16).toString("hex");
        codes.set(code, { nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, who: next });
        back.searchParams.set("code", code);
      }
      next = null;
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const f = new URLSearchParams(await readBody());
      const entry = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? ""); // one-time
      if (!entry || f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET || f.get("redirect_uri") !== REDIRECT_URI) {
        return send(400, { error: "invalid_grant" });
      }
      const challenge = createHash("sha256").update(f.get("code_verifier") ?? "", "ascii").digest("base64url");
      if (challenge !== entry.challenge) return send(400, { error: "invalid_grant", problem: "pkce" });
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        email: entry.who.email, email_verified: true, name: entry.who.name, nonce: entry.nonce, azp: CLIENT_ID,
      })
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid!, typ: "JWT" })
        .setIssuer("https://accounts.google.com").setAudience(CLIENT_ID).setSubject(entry.who.sub)
        .setIssuedAt(now).setExpirationTime(now + 3600)
        .sign(key);
      return send(200, { id_token: idToken, access_token: "never-used", token_type: "Bearer", expires_in: 3600 });
    }
    send(404, { error: "not_found" });
  });
  server.listen(PORT, () => console.log(`[mock-google] listening on ${PORT}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
