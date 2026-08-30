/**
 * D2 / P7-W4E-B — Tax Authority signed-state adversarial matrix.
 *
 * Deterministic, offline, no DB: pure crypto + the callback's context
 * validator. Wired into the BLOCKING CI-1 guard job, because the invariant it
 * protects — an untrusted cookie can no longer nominate the tenant an ITA
 * token is persisted onto — is exactly the kind that must never regress
 * silently. (W4D's Prisma-type leak reached main precisely because its
 * verifier ran in no workflow.)
 *
 * Run: npx tsx lib/services/billing/authority/billing-authority-signed-state.verify.test.ts
 */
process.env.AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "w4eb_signed_state_synthetic_secret";

import {
  createSignedAuthorityState,
  verifySignedAuthorityState,
  AUTHORITY_STATE_TTL_SECONDS,
} from "./billing-authority-signed-state.service";
import { createSignedGmailState, verifySignedGmailState } from "@/lib/services/integrations/gmail/signed-state.service";
import { validateAuthorityOAuthCallbackContext } from "./billing-authority-oauth-callback.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function decode(state: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(state.split(".")[0], "base64url").toString("utf8")
  ) as Record<string, unknown>;
}
function reseal(payload: Record<string, unknown>, sig: string): string {
  return `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${sig}`;
}

console.log("\nTax Authority signed state — envelope");

const state = createSignedAuthorityState({
  businessId: 11,
  userId: 22,
  environment: "SANDBOX",
});
const v = verifySignedAuthorityState(state);
ok("valid state verifies", v.ok);
if (v.ok) {
  ok("binds business", v.state.businessId === 11);
  ok("binds user", v.state.userId === 22);
  ok("binds environment", v.state.environment === "SANDBOX");
  ok("carries a nonce", v.state.nonce.length > 0);
}
const p = decode(state);
ok("payload has an explicit version", p.v === 1);
ok("payload has an explicit purpose", p.purpose === "authority-oauth-state");
ok("payload carries no secret material", !JSON.stringify(p).includes(process.env.AUTH_TOKEN_SECRET!));
ok(
  "two states for the same tenant differ (fresh nonce)",
  createSignedAuthorityState({ businessId: 11, userId: 22, environment: "SANDBOX" }) !== state
);

console.log("\nTampering");
const sig = state.split(".")[1];
for (const [field, value, label] of [
  ["businessId", 12, "businessId"],
  ["userId", 23, "userId"],
  ["environment", "PRODUCTION", "environment"],
  ["nonce", "attacker", "nonce"],
  ["purpose", "gmail-oauth-state", "purpose"],
  ["v", 2, "version"],
] as const) {
  const t = { ...p, [field]: value };
  const r = verifySignedAuthorityState(reseal(t, sig));
  ok(`tampered ${label} rejected`, !r.ok && r.reason === "bad_signature", JSON.stringify(r));
}
ok(
  "expired state rejected",
  (() => {
    const r = verifySignedAuthorityState(
      state,
      (Number(p.iat) + AUTHORITY_STATE_TTL_SECONDS + 1) * 1000
    );
    return !r.ok && r.reason === "expired";
  })()
);
ok("malformed state rejected", !verifySignedAuthorityState("not-a-state").ok);
ok("empty state rejected", !verifySignedAuthorityState("").ok);
ok("null state rejected", !verifySignedAuthorityState(null).ok);

console.log("\nCryptographic separation from the Gmail envelope");
const gmailState = createSignedGmailState({ businessId: 11, userId: 22 });
const asAuthority = verifySignedAuthorityState(gmailState);
ok("a Gmail state does NOT validate as a Tax Authority state", !asAuthority.ok, JSON.stringify(asAuthority));
const asGmail = verifySignedGmailState(state);
ok("a Tax Authority state does NOT validate as a Gmail state", !asGmail.ok, JSON.stringify(asGmail));

console.log("\nCallback tenant source (cookies carry no authority)");
const ctx = (cookies: Record<string, unknown>, queryState: string) =>
  validateAuthorityOAuthCallbackContext({
    query: { code: "auth-code", state: queryState },
    cookies: {
      state: queryState,
      businessId: String(cookies.businessId ?? 11),
      environment: String(cookies.environment ?? "SANDBOX"),
      ...cookies,
    },
  } as Parameters<typeof validateAuthorityOAuthCallbackContext>[0]);

const good = ctx({}, state);
ok("valid signed state resolves the signed tenant", good.ok && good.context.businessId === 11);

// The core attack: the caller rewrites their own cookie to another business.
const spoof = ctx({ businessId: "99" }, state);
ok(
  "cookie businessId spoof does NOT change the tenant (rejected, never 99)",
  !spoof.ok,
  JSON.stringify(spoof)
);

const envSpoof = ctx({ environment: "PRODUCTION" }, state);
ok("cookie environment spoof rejected", !envSpoof.ok, JSON.stringify(envSpoof));

const unsigned = ctx({}, "opaque-random-legacy-state");
ok("a legacy UNSIGNED state is refused (no fallback)", !unsigned.ok, JSON.stringify(unsigned));

const bState = createSignedAuthorityState({ businessId: 77, userId: 5, environment: "SANDBOX" });
const bCtx = ctx({ businessId: "77" }, bState);
ok("a second tenant's signed state resolves that tenant", bCtx.ok && bCtx.context.businessId === 77);

const crossed = ctx({ businessId: "11" }, bState);
ok("A's cookie with B's signed state is refused", !crossed.ok, JSON.stringify(crossed));
console.log("\nIdentity forgery on the remaining signed fields");
for (const [field, value] of [
  ["iat", 0],
  ["exp", 4102444800],
] as const) {
  const t = { ...p, [field]: value };
  const r = verifySignedAuthorityState(reseal(t, sig));
  ok(`tampered ${field} rejected (cannot backdate or extend the window)`, !r.ok && r.reason === "bad_signature");
}
ok(
  "malformed SIGNATURE rejected",
  (() => {
    const r = verifySignedAuthorityState(state.split(".")[0] + ".AAAA");
    return !r.ok && (r.reason === "bad_signature" || r.reason === "malformed");
  })()
);

console.log("\nEnvironment binding is per-connection identity");
const sandboxState = createSignedAuthorityState({ businessId: 11, userId: 22, environment: "SANDBOX" });
const prodState = createSignedAuthorityState({ businessId: 11, userId: 22, environment: "PRODUCTION" });
ok("SANDBOX state + PRODUCTION cookie refused (cannot install as PRODUCTION)", !ctx({ environment: "PRODUCTION" }, sandboxState).ok);
ok("PRODUCTION state + SANDBOX cookie refused", !ctx({ environment: "SANDBOX" }, prodState).ok);
const prodOk = ctx({ environment: "PRODUCTION" }, prodState);
ok("a PRODUCTION state resolves the PRODUCTION environment", prodOk.ok && prodOk.context.environment === "PRODUCTION");

console.log("\nActor identity comes from the state, not the actor cookie");
ok("the verified actor is carried on the context", good.ok && good.context.actorUserId === 22, good.ok ? String(good.context.actorUserId) : "n/a");
const actorSpoof = ctx({ actorUserId: "999" }, state);
ok("actor cookie spoof cannot change who authorized the connection", actorSpoof.ok && actorSpoof.context.actorUserId === 22, actorSpoof.ok ? String(actorSpoof.context.actorUserId) : "rejected");

console.log("\nQuery/body cannot nominate a tenant");
// The validator only ever reads query.code and query.state, so a businessId
// supplied in the query or body has no reachable path to the tenant decision.
// Asserted structurally against the callback source so a future edit that
// reintroduces such a path fails here.
const cbSrc = readFileSync(
  join(__dirname, "billing-authority-oauth-callback.service.ts"),
  "utf8"
);
ok("callback source never reads a businessId out of query or body", !/(query|body)[a-zA-Z.]*\.businessId/.test(cbSrc));
ok("callback source resolves its tenant from the verified state", /verified\.state\.businessId/.test(cbSrc));


console.log(`\nTax Authority signed-state invariants\n`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("All Tax Authority signed-state invariants hold. Tenant identity is cryptographically bound. ✔");
