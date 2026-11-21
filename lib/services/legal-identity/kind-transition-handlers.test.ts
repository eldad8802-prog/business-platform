/**
 * Verify — "מעבר לעוסק מורשה" HTTP handlers (lib/services/legal-identity/kind-transition-handlers.ts): OFF → 404;
 * the session decides who; preview binds the digest; confirm needs a proof for THIS user, session and action by the
 * method the account requires; every refusal reaches no database write; the database answer is mapped.
 * Run: npx tsx lib/services/legal-identity/kind-transition-handlers.test.ts
 *
 * Pure: every dependency injected (the database half is .bkt/battery.ts).
 */
import assert from "node:assert/strict";

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "kind-transition-handlers-test-secret-0123";

import { issueReauthProof, REAUTH_ACTIONS } from "@/lib/auth/sensitive-reauth";
import { KIND_TRANSITION_ACKNOWLEDGEMENTS, kindTransitionStatementSha256, israelToday } from "@/lib/legal-identity/kind-transition";
import {
  handleKindTransitionConfirm,
  handleKindTransitionGet,
  handleKindTransitionPreview,
  handleKindTransitionReauthGoogle,
  handleKindTransitionReauthPassword,
  type KindTransitionDeps,
} from "@/lib/services/legal-identity/kind-transition-handlers";
import type { KindTransitionSnapshot } from "@/lib/services/legal-identity/kind-transition.service";

let checks = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    checks += 1;
  } catch (e) {
    console.error(`FAIL ${label}`);
    throw e;
  }
}

const TAX = "123456782";
const ACTION = "BUSINESS_KIND_TRANSITION" as const;
const USER = 41;
const BIZ = 7;
const SID = "sess-a";
const ACKS = KIND_TRANSITION_ACKNOWLEDGEMENTS.map((a) => a.id);
const DATE = israelToday();

const snapshot = (over: Partial<KindTransitionSnapshot["state"]> = {}): KindTransitionSnapshot => ({
  state: {
    billingBusinessKind: "EXEMPT_DEALER", billingLegalName: "ישראל ישראלי", billingTaxId: TAX, billingVatNumber: null,
    businessBeingDeleted: false, actorIsSoleUser: true, hasLiveIssuerDeclaration: false, ...over,
  },
  history: null,
});

type Calls = { perform: unknown[][]; compare: number };
function make(over: Partial<KindTransitionDeps> & { snap?: KindTransitionSnapshot; password?: string | null } = {}): { deps: KindTransitionDeps; calls: Calls } {
  const calls: Calls = { perform: [], compare: 0 };
  const deps: KindTransitionDeps = {
    enabled: () => true,
    context: (async () => ({ user: { id: USER, businessId: BIZ }, sessionId: SID })) as never,
    snapshot: async () => over.snap ?? snapshot(),
    credentials: async () => ({ email: "owner@lab.invalid", password: over.password === undefined ? "$2b$10$hash" : over.password }),
    perform: async (...a: unknown[]) => { calls.perform.push(a); return "TRANSITIONED"; },
    rateLimit: (async () => ({ allowed: true })) as never,
    reserve: (async () => ({ allowed: true, count: 1, retryAfterMs: 0, lock: async () => {}, clear: async () => {} })) as never,
    compare: async (plain) => { calls.compare += 1; return plain === "correct-password"; },
    googleConfig: () => ({ clientId: "c", clientSecret: "s", redirectBase: "https://app.lab.invalid", authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://t", jwksUrl: null, access: { mode: "open" } }),
    now: () => new Date(),
    ...over,
  };
  return { deps, calls };
}

const body = (over: Record<string, unknown> = {}) => ({ confirmTaxId: TAX, vatNumber: TAX, statusEffectiveDate: DATE, acknowledged: ACKS, ...over });
const sha = kindTransitionStatementSha256({ businessId: BIZ, actorUserId: USER, legalName: "ישראל ישראלי", taxId: TAX, vatNumber: TAX, statusEffectiveDate: DATE });
const post = (payload: unknown, cookie?: string) => new Request("https://app.lab.invalid/api/business/legal-identity/kind-transition", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(payload),
});
const get = () => new Request("https://app.lab.invalid/api/business/legal-identity/kind-transition", { headers: { authorization: "Bearer t" } });
const proofCookie = (claims: Partial<Parameters<typeof issueReauthProof>[0]> = {}) =>
  `${REAUTH_ACTIONS[ACTION].cookie}=${encodeURIComponent(issueReauthProof({ userId: USER, sessionId: SID, action: ACTION, method: "PASSWORD", ...claims }))}`;
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const cookiesOf = (res: Response) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];

async function main() {
  await check("H1 OFF → 404 on every handler, before reading the session", async () => {
    const { deps } = make({ enabled: () => false, context: (async () => { throw new Error("must not run"); }) as never });
    for (const h of [handleKindTransitionGet, handleKindTransitionPreview, handleKindTransitionConfirm, handleKindTransitionReauthPassword, handleKindTransitionReauthGoogle]) {
      assert.equal((await h(post({}), deps)).status, 404);
    }
  });

  await check("H2 no session → 401 everywhere", async () => {
    const { deps } = make({ context: (async () => null) as never });
    for (const h of [handleKindTransitionGet, handleKindTransitionPreview, handleKindTransitionConfirm, handleKindTransitionReauthPassword, handleKindTransitionReauthGoogle]) {
      assert.equal((await h(post({}), deps)).status, 401);
    }
  });

  await check("H3 GET: eligibility, the method the account requires, acknowledgements, effects", async () => {
    const r1 = await read(await handleKindTransitionGet(get(), make().deps));
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.eligibility, { eligible: true });
    assert.equal(r1.body.reauthMethod, "PASSWORD");
    assert.equal((r1.body.acknowledgements as unknown[]).length, KIND_TRANSITION_ACKNOWLEDGEMENTS.length);
    const r2 = await read(await handleKindTransitionGet(get(), make({ password: null }).deps));
    assert.equal(r2.body.reauthMethod, "GOOGLE");
  });

  await check("H4 preview: answers the digest bound to session business + user + stored identity + input", async () => {
    const r = await read(await handleKindTransitionPreview(post(body()), make().deps));
    assert.equal(r.status, 200);
    assert.equal(r.body.statementSha256, sha);
  });

  await check("H5 preview refuses an ineligible business (409) and invalid input (400, every problem)", async () => {
    assert.equal((await handleKindTransitionPreview(post(body()), make({ snap: snapshot({ billingBusinessKind: "AUTHORIZED_DEALER" }) }).deps)).status, 409);
    const r = await read(await handleKindTransitionPreview(post(body({ vatNumber: "000000018", acknowledged: [] })), make().deps));
    assert.equal(r.status, 400);
    assert.equal((r.body.problems as unknown[]).length, 2);
  });

  await check("H6 confirm with a valid proof: the database is called with the session's ids and the proof's method + time; 200; proof cleared", async () => {
    const { deps, calls } = make();
    const res = await handleKindTransitionConfirm(post({ ...body(), statementSha256: sha }, proofCookie()), deps);
    assert.equal(res.status, 200);
    assert.equal(calls.perform.length, 1);
    const [biz, user, args] = calls.perform[0] as [number, number, Record<string, unknown>];
    assert.equal(biz, BIZ);
    assert.equal(user, USER);
    assert.equal(args.vatNumber, TAX);
    assert.equal(args.statusEffectiveDate, DATE);
    assert.equal(args.reauthMethod, "PASSWORD");
    assert.equal(args.statementSha256, sha);
    assert.ok(args.reauthAt instanceof Date);
    assert.ok(cookiesOf(res).some((c) => c.startsWith(`${REAUTH_ACTIONS[ACTION].cookie}=`) && /Max-Age=0/i.test(c)));
  });

  await check("H7 confirm without a proof, with another user's / session's / a GOOGLE proof on a password account → 401, no database call", async () => {
    for (const cookie of [undefined, proofCookie({ userId: 99 }), proofCookie({ sessionId: "sess-b" }), proofCookie({ method: "GOOGLE" })]) {
      const { deps, calls } = make();
      const r = await read(await handleKindTransitionConfirm(post({ ...body(), statementSha256: sha }, cookie), deps));
      assert.equal(r.status, 401, String(cookie));
      assert.equal(r.body.code, "REAUTH_REQUIRED");
      assert.equal(calls.perform.length, 0);
    }
  });

  await check("H8 confirm with a digest that is not the one for what is on file now → 409 STATEMENT_STALE, no database call", async () => {
    const { deps, calls } = make();
    const r = await read(await handleKindTransitionConfirm(post({ ...body(), statementSha256: "0".repeat(64) }, proofCookie()), deps));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "STATEMENT_STALE");
    assert.equal(calls.perform.length, 0);
  });

  await check("H9 confirm on an ineligible business (several users / live declaration) → 409, no database call", async () => {
    for (const snap of [snapshot({ actorIsSoleUser: false }), snapshot({ hasLiveIssuerDeclaration: true })]) {
      const { deps, calls } = make({ snap });
      assert.equal((await handleKindTransitionConfirm(post({ ...body(), statementSha256: sha }, proofCookie()), deps)).status, 409);
      assert.equal(calls.perform.length, 0);
    }
  });

  await check("H10 the database's refusals are mapped; the proof is kept when nothing happened", async () => {
    const { deps } = make({ perform: async () => "ISSUER_DECLARATION_ACTIVE" });
    const res = await handleKindTransitionConfirm(post({ ...body(), statementSha256: sha }, proofCookie()), deps);
    assert.equal(res.status, 409);
    assert.ok(!cookiesOf(res).some((c) => c.startsWith(`${REAUTH_ACTIONS[ACTION].cookie}=`)));
  });

  await check("P1 password re-auth: wrong → 401, no proof; right → proof cookie (httpOnly, action path)", async () => {
    const bad = await handleKindTransitionReauthPassword(post({ password: "wrong" }), make().deps);
    assert.equal(bad.status, 401);
    assert.ok(!cookiesOf(bad).some((c) => c.startsWith(`${REAUTH_ACTIONS[ACTION].cookie}=`)));
    const good = await handleKindTransitionReauthPassword(post({ password: "correct-password" }), make().deps);
    assert.equal(good.status, 200);
    const c = cookiesOf(good).find((x) => x.startsWith(`${REAUTH_ACTIONS[ACTION].cookie}=`));
    assert.ok(c && /HttpOnly/i.test(c) && c.includes(`Path=${REAUTH_ACTIONS[ACTION].path}`), c);
  });

  await check("P2 password re-auth on a Google-only account → 409 USE_GOOGLE; Google start on a password account → 409 USE_PASSWORD", async () => {
    assert.equal((await read(await handleKindTransitionReauthPassword(post({ password: "x" }), make({ password: null }).deps))).body.code, "USE_GOOGLE");
    assert.equal((await read(await handleKindTransitionReauthGoogle(post({}), make().deps))).body.code, "USE_PASSWORD");
  });

  await check("P3 a token without a session id cannot re-authenticate (401 SIGN_IN_AGAIN)", async () => {
    const { deps } = make({ context: (async () => ({ user: { id: USER, businessId: BIZ }, sessionId: null })) as never });
    assert.equal((await read(await handleKindTransitionReauthPassword(post({ password: "correct-password" }), deps))).body.code, "SIGN_IN_AGAIN");
  });

  await check("P4 Google start on a Google-only account → { url } forcing a fresh login + the re-auth state cookie", async () => {
    const res = await handleKindTransitionReauthGoogle(post({}), make({ password: null }).deps);
    const r = await read(res.clone());
    const u = new URL(String(r.body.url));
    assert.equal(u.searchParams.get("prompt"), "login");
    assert.equal(u.searchParams.get("max_age"), "0");
    assert.ok(cookiesOf(res).some((c) => c.startsWith("dz_google_reauth=") && /HttpOnly/i.test(c) && c.includes("Path=/api/auth/google/callback")));
  });

  console.log(`kind-transition-handlers: ${checks} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
