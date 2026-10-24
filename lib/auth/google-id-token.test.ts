/**
 * Google ID token verification — T23–T31 of the "Continue with Google" acceptance plan, with real RS256
 * signatures (jose) against a local key set standing in for Google's JWKS. Pure: no database, no network.
 *   npx tsx lib/auth/google-id-token.test.ts
 *
 *   T23 forged (a key that is not Google's — unknown kid, or Google's kid)   → SIGNATURE
 *   T24 altered after signing (sub / email swapped in the payload)           → SIGNATURE
 *   T25 alg none; HS256 signed with the client secret                        → refused before any key
 *   T26 expired beyond the 60 s tolerance; iat / nbf in the future; too old  → refused (tolerance honoured)
 *   T27 another client's audience (our Gmail client included); azp mismatch  → AUDIENCE / AUTHORIZED_PARTY
 *   T28 another issuer                                                       → ISSUER (both Google forms OK)
 *   T29 nonce missing or not this browser's                                  → NONCE
 *   T30 email_verified false / missing / "true"                              → EMAIL_UNVERIFIED
 *   T31 a valid token                                                        → the identity, folded address
 * Plus: input bounds, key set unavailable, and static scope (RS256 only, nothing logged, no DB).
 */
import fs from "node:fs";
import path from "node:path";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";

import { verifyGoogleIdToken, type GoogleIdTokenResult } from "./google-id-token";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` (${detail})` : ""}`);
  }
}
const why = (r: GoogleIdTokenResult) => (r.ok ? "ok" : r.reason);

const CLIENT_ID = "1234567890-signin.apps.googleusercontent.com";
const GMAIL_CLIENT_ID = "1234567890-gmail.apps.googleusercontent.com";
const CLIENT_SECRET = "lab-client-secret-not-a-real-one";
const NONCE = "n-0S6_WzA2Mj";
const NOW = new Date("2026-10-25T12:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function main() {
  const google = await generateKeyPair("RS256", { extractable: true });
  const attacker = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(google.publicKey)), kid: "google-key-1", alg: "RS256", use: "sig" };
  const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
  const expected = { clientId: CLIENT_ID, nonce: NONCE, now: NOW };
  const verify = (t: unknown, e: Partial<typeof expected> = {}, k: JWTVerifyGetKey = keys) =>
    verifyGoogleIdToken(t, { ...expected, ...e }, k);

  const base = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: "110169484474386276334",
    email: "Dana.Cohen@Example.co.il",
    email_verified: true,
    name: "דנה כהן",
    nonce: NONCE,
    iat: nowS - 10,
    exp: nowS + 3590,
  };
  type Claims = Record<string, unknown>;
  const sign = (claims: Claims, key = google.privateKey, kid = "google-key-1") =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid, typ: "JWT" }).sign(key);
  const without = (k: string): Claims => Object.fromEntries(Object.entries(base).filter(([x]) => x !== k));

  // ── T31 the valid token ─────────────────────────────────────────────────────
  const good = await verify(await sign(base));
  ok("T31 a valid token yields the identity", good.ok, why(good));
  if (good.ok) {
    ok("T31 …subject is Google's sub", good.identity.subject === base.sub);
    ok("T31 …address folded exactly as signup folds it", good.identity.email === "dana.cohen@example.co.il");
    ok("T31 …name kept for prefill", good.identity.name === "דנה כהן");
  }
  const noAzp = await verify(await sign(without("azp")));
  ok("T31 a token without azp is accepted (single audience)", noAzp.ok, why(noAzp));
  const legacyIss = await verify(await sign({ ...base, iss: "accounts.google.com" }));
  ok("T28 the short issuer form accounts.google.com is accepted", legacyIss.ok, why(legacyIss));
  const longName = await verify(await sign({ ...base, name: "א".repeat(300) }));
  ok("T31 a name longer than 200 characters is cut to 200 (the ticket's bound)", longName.ok && longName.identity.name?.length === 200);
  const blankName = await verify(await sign({ ...base, name: "   " }));
  ok("T31 a blank name becomes null", blankName.ok && blankName.identity.name === null);

  // ── T23 forged ──────────────────────────────────────────────────────────────
  const forgedUnknownKid = await verify(await sign(base, attacker.privateKey, "attacker-key"));
  ok("T23 a token signed by another key (unknown kid) is refused: SIGNATURE", why(forgedUnknownKid) === "SIGNATURE", why(forgedUnknownKid));
  const forgedGoogleKid = await verify(await sign(base, attacker.privateKey, "google-key-1"));
  ok("T23 a token signed by another key under Google's kid is refused: SIGNATURE", why(forgedGoogleKid) === "SIGNATURE", why(forgedGoogleKid));

  // ── T24 altered after signing ───────────────────────────────────────────────
  const [h, , s] = (await sign(base)).split(".");
  const swappedSub = await verify(`${h}.${b64({ ...base, sub: "999999999999999999999" })}.${s}`);
  ok("T24 a payload altered after signing (sub) is refused: SIGNATURE", why(swappedSub) === "SIGNATURE", why(swappedSub));
  const swappedEmail = await verify(`${h}.${b64({ ...base, email: "owner@victim.co.il" })}.${s}`);
  ok("T24 a payload altered after signing (email) is refused: SIGNATURE", why(swappedEmail) === "SIGNATURE", why(swappedEmail));
  const noSig = await verify(`${h}.${b64(base)}.`);
  ok("T24 a token with its signature stripped is refused", !noSig.ok, why(noSig));

  // ── T25 algorithm confusion ─────────────────────────────────────────────────
  const algNone = await verify(`${b64({ alg: "none", typ: "JWT" })}.${b64(base)}.`);
  ok("T25 alg none is refused", !algNone.ok, why(algNone));
  const hs256 = await new SignJWT(base).setProtectedHeader({ alg: "HS256", kid: "google-key-1" }).sign(new TextEncoder().encode(CLIENT_SECRET));
  const hs = await verify(hs256);
  ok("T25 HS256 signed with the client secret is refused: SIGNATURE (algorithm not allowed)", why(hs) === "SIGNATURE", why(hs));

  // ── T26 time ────────────────────────────────────────────────────────────────
  const expired = await verify(await sign({ ...base, iat: nowS - 3700, exp: nowS - 61 }));
  ok("T26 expired 61 s ago is refused: EXPIRED", why(expired) === "EXPIRED", why(expired));
  const withinTolerance = await verify(await sign({ ...base, iat: nowS - 3600, exp: nowS - 30 }));
  ok("T26 expired 30 s ago is inside the 60 s clock tolerance", withinTolerance.ok, why(withinTolerance));
  const futureIat = await verify(await sign({ ...base, iat: nowS + 300, exp: nowS + 3900 }));
  ok("T26 iat five minutes in the future is refused: NOT_YET_VALID", why(futureIat) === "NOT_YET_VALID", why(futureIat));
  const futureNbf = await verify(await sign({ ...base, nbf: nowS + 300 }));
  ok("T26 nbf five minutes in the future is refused: NOT_YET_VALID", why(futureNbf) === "NOT_YET_VALID", why(futureNbf));
  const tooOld = await verify(await sign({ ...base, iat: nowS - 7200, exp: nowS + 3600 }));
  ok("T26 issued two hours ago is refused even with a far exp: EXPIRED", why(tooOld) === "EXPIRED", why(tooOld));
  const noExp = await verify(await sign(without("exp")));
  ok("T26 a token without exp is refused", !noExp.ok, why(noExp));

  // ── T27 audience / authorized party ─────────────────────────────────────────
  const otherAud = await verify(await sign({ ...base, aud: "someone-else.apps.googleusercontent.com", azp: "someone-else.apps.googleusercontent.com" }));
  ok("T27 a token for another client is refused: AUDIENCE", why(otherAud) === "AUDIENCE", why(otherAud));
  const gmailAud = await verify(await sign({ ...base, aud: GMAIL_CLIENT_ID, azp: GMAIL_CLIENT_ID }));
  ok("T27 a token for our own Gmail client is refused: AUDIENCE", why(gmailAud) === "AUDIENCE", why(gmailAud));
  const multiAud = await verify(await sign({ ...base, aud: [CLIENT_ID, GMAIL_CLIENT_ID], azp: GMAIL_CLIENT_ID }));
  ok("T27 several audiences issued to another party (azp) are refused: AUTHORIZED_PARTY", why(multiAud) === "AUTHORIZED_PARTY", why(multiAud));
  const noAud = await verify(await sign(without("aud")));
  ok("T27 a token with no audience is refused", !noAud.ok, why(noAud));

  // ── T28 issuer ──────────────────────────────────────────────────────────────
  const otherIss = await verify(await sign({ ...base, iss: "https://accounts.evil.example" }));
  ok("T28 another issuer is refused: ISSUER", why(otherIss) === "ISSUER", why(otherIss));
  const httpIss = await verify(await sign({ ...base, iss: "http://accounts.google.com" }));
  ok("T28 the http:// form is not an accepted issuer", why(httpIss) === "ISSUER", why(httpIss));

  // ── T29 nonce ───────────────────────────────────────────────────────────────
  const noNonce = await verify(await sign(without("nonce")));
  ok("T29 a token without a nonce is refused: NONCE", why(noNonce) === "NONCE", why(noNonce));
  const otherNonce = await verify(await sign({ ...base, nonce: "someone-elses-nonce" }));
  ok("T29 another browser's nonce is refused: NONCE", why(otherNonce) === "NONCE", why(otherNonce));
  const prefixNonce = await verify(await sign({ ...base, nonce: NONCE.slice(0, -1) }));
  ok("T29 a prefix of the nonce is refused: NONCE", why(prefixNonce) === "NONCE", why(prefixNonce));

  // ── T30 email_verified ──────────────────────────────────────────────────────
  for (const [label, claims] of [
    ["false", { ...base, email_verified: false }],
    ["missing", without("email_verified")],
    ['the string "true"', { ...base, email_verified: "true" }],
    ["1", { ...base, email_verified: 1 }],
  ] as const) {
    const r = await verify(await sign(claims as Claims));
    ok(`T30 email_verified ${label} is refused: EMAIL_UNVERIFIED`, why(r) === "EMAIL_UNVERIFIED", why(r));
  }

  // ── shape and input bounds ──────────────────────────────────────────────────
  const longSub = await verify(await sign({ ...base, sub: "1".repeat(256) }));
  ok("a subject over 255 characters is refused: CLAIMS", why(longSub) === "CLAIMS", why(longSub));
  const badEmail = await verify(await sign({ ...base, email: "not-an-address" }));
  ok("an address signup would not accept is refused: CLAIMS", why(badEmail) === "CLAIMS", why(badEmail));
  ok("a non-string token is refused: MALFORMED", why(await verify(undefined)) === "MALFORMED" && why(await verify(42)) === "MALFORMED");
  ok("an oversized token is refused before parsing: MALFORMED", why(await verify("a".repeat(8193))) === "MALFORMED");
  ok("garbage is refused: MALFORMED", why(await verify("not.a.jwt")) === "MALFORMED");
  const goodToken = await sign(base);
  ok("an empty expected client id never means 'any audience'", why(await verify(goodToken, { clientId: "" })) === "MALFORMED");
  ok("an empty expected nonce never means 'any nonce'", why(await verify(goodToken, { nonce: "" })) === "MALFORMED");
  const unavailable: JWTVerifyGetKey = async () => { throw new errors.JWKSTimeout(); };
  ok("Google's key set unreachable → KEYS_UNAVAILABLE, never accepted", why(await verify(goodToken, {}, unavailable)) === "KEYS_UNAVAILABLE");

  // ── static scope ────────────────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(process.cwd(), "lib/auth/google-id-token.ts"), "utf8");
  ok("static: RS256 is the only accepted algorithm", /GOOGLE_ID_TOKEN_ALGORITHMS = \["RS256"\]/.test(src) && /algorithms: GOOGLE_ID_TOKEN_ALGORITHMS/.test(src));
  ok("static: the signature is always verified (jwtVerify, no decode-only path)", /jwtVerify\(/.test(src) && !/decodeJwt|decodeProtectedHeader|UnsecuredJWT/.test(src));
  ok("static: nothing is logged", !/console\./.test(src));
  ok("static: no database client", !/prisma|authDb|\$queryRaw/.test(src));
  ok("static: the keys come from Google's JWKS endpoint", /https:\/\/www\.googleapis\.com\/oauth2\/v3\/certs/.test(src));

  console.log(`\n[google-id-token] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
