/**
 * Website-form live proof — the TEMPORARY pilot page (business 9). No database: the resolver and the
 * admin guard are injected.
 *
 *   pass    signed, 15 minutes, bound to one publicId; forged / expired / foreign passes refused
 *   API     canonical guard first; only a live business-9 website connection gets a pass + cookie
 *   page    404 (one identical body) for every failure; 200 = the stock snippet, posting to the public
 *           intake endpoint on the same origin; noindex + no-store; no secret in the HTML
 *
 * Run: npx tsx lib/intake/acquisition/web-form-pilot.test.ts
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { webFormSnippet } from "./web-form-snippet";
import {
  handlePilotPage,
  handlePilotPass,
  mintPilotPass,
  PILOT_BUSINESS_ID,
  PILOT_COOKIE,
  PILOT_PASS_TTL_SECONDS,
  PILOT_PATH,
  renderPilotPage,
  verifyPilotPass,
} from "./web-form-pilot";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const SECRET = "test-auth-token-secret-for-the-pilot-suite";
process.env.AUTH_TOKEN_SECRET = SECRET;

const ORIGIN = "https://promaxgroup.co.il";
const PID = "AbCdEfGhIjKlMnOpQrStUvWx12"; // 26 chars, PUBLIC_ID_PATTERN
const OTHER_PID = "ZyXwVuTsRqPoNmLkJiHgFeDc98";
const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ADMIN = { id: 9, email: "admin@example.com", name: "Admin", role: "PLATFORM_ADMIN" } as never;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

type Conn = { businessId: number } | null;
function resolver(table: Record<string, Conn>, calls: string[] = []) {
  return async (publicId: string) => {
    calls.push(publicId);
    return table[publicId] ?? null;
  };
}
const throwing = async () => {
  throw new Error("db down");
};

function passReq(body: unknown, raw = false): Request {
  return new Request(`${ORIGIN}/api/platform-admin/web-form-pilot/pass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}
function pageReq(query: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${PILOT_PATH}${query}`, { headers: cookie ? { cookie: `${PILOT_COOKIE}=${cookie}` } : {} });
}

async function main() {
  console.log("\n— pass —");
  const p = mintPilotPass(9, PID, T0)!;
  check("mint returns a signed pass", typeof p === "string" && p.split(".").length === 2);
  check("verify → the publicId it was issued for", verifyPilotPass(p, T0) === PID);
  check("valid just before expiry", verifyPilotPass(p, T0 + (PILOT_PASS_TTL_SECONDS - 1) * 1000) === PID);
  check("expired at 15 minutes", verifyPilotPass(p, T0 + PILOT_PASS_TTL_SECONDS * 1000) === null);
  const [body, sig] = p.split(".");
  const flipped = sig.slice(0, -2) + (sig.slice(-2) === "AA" ? "BB" : "AA");
  check("tampered signature refused", verifyPilotPass(`${body}.${flipped}`, T0) === null);
  const forgedBody = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), pid: OTHER_PID }),
    "utf8"
  ).toString("base64url");
  check("payload swapped to another publicId refused", verifyPilotPass(`${forgedBody}.${sig}`, T0) === null);
  const key = createHmac("sha256", SECRET).update("dubiz-platform-admin-elevation-v1").digest();
  const otherPurpose = Buffer.from(JSON.stringify({ v: 1, purpose: "platform-admin-elevation", sub: 9, pid: PID, nonce: "x", iat: T0 / 1000, exp: T0 / 1000 + 900 })).toString("base64url");
  check(
    "a token signed with another purpose's key refused",
    verifyPilotPass(`${otherPurpose}.${createHmac("sha256", key).update(otherPurpose).digest("base64url")}`, T0) === null
  );
  check("garbage refused", [null, undefined, "", "a.b.c", ".x", "x.", "x".repeat(2000)].every((g) => verifyPilotPass(g as never, T0) === null));
  check("mint refuses a malformed publicId", mintPilotPass(9, "short", T0) === null);
  delete process.env.AUTH_TOKEN_SECRET;
  check("no AUTH_TOKEN_SECRET → no pass minted (fail closed)", mintPilotPass(9, PID, T0) === null);
  check("no AUTH_TOKEN_SECRET → nothing verifies (fail closed)", verifyPilotPass(p, T0) === null);
  process.env.AUTH_TOKEN_SECRET = SECRET;

  console.log("\n— API: POST /api/platform-admin/web-form-pilot/pass —");
  const live = { [PID]: { businessId: PILOT_BUSINESS_ID }, [OTHER_PID]: { businessId: 38 } };
  check("the pilot business is 9", PILOT_BUSINESS_ID === 9);
  {
    const r = await handlePilotPass(passReq({ publicId: PID }), ADMIN, { resolve: resolver(live), now: () => T0 });
    const json = (await r.json()) as { url: string; expiresInSeconds: number };
    const cookie = r.headers.get("set-cookie") ?? "";
    check("admin + live business-9 connection → 200", r.status === 200);
    check("url = pilot path + this publicId + a UUID sid", new RegExp(`^${PILOT_PATH}\\?id=${PID}&sid=[0-9a-f-]{36}$`).test(json.url), json.url);
    check("cookie is httpOnly", /HttpOnly/i.test(cookie));
    check("cookie is SameSite=Strict", /SameSite=Strict/i.test(cookie));
    check("cookie is scoped to the pilot path only", cookie.includes(`Path=${PILOT_PATH}`));
    check("cookie lives 15 minutes", cookie.includes(`Max-Age=${PILOT_PASS_TTL_SECONDS}`));
    const value = decodeURIComponent(/dubiz_wfp=([^;]+)/.exec(cookie)?.[1] ?? "");
    check("cookie value verifies for this publicId", verifyPilotPass(value, T0) === PID);
    check("response is no-store", r.headers.get("cache-control") === "no-store");
  }
  {
    const statusFor = async (body: unknown, resolve = resolver(live), raw = false) =>
      (await handlePilotPass(passReq(body, raw), ADMIN, { resolve })).status;
    check("a business-38 connection → 404", (await statusFor({ publicId: OTHER_PID })) === 404);
    check("another business (12) → 404", (await statusFor({ publicId: PID }, resolver({ [PID]: { businessId: 12 } }))) === 404);
    check("unknown / paused / revoked connection (resolver: none) → 404", (await statusFor({ publicId: PID }, resolver({}))) === 404);
    const calls: string[] = [];
    check("malformed publicId → 404 without touching the resolver", (await statusFor({ publicId: "../../x" }, resolver(live, calls))) === 404 && calls.length === 0);
    check("missing publicId → 400", (await statusFor({})) === 400);
    check("non-JSON body → 400", (await statusFor("not json", resolver(live), true)) === 400);
    check("resolver error → 503 (never a pass)", (await statusFor({ publicId: PID }, throwing)) === 503);
    delete process.env.AUTH_TOKEN_SECRET;
    check("no signing secret → 503 (never an unsigned pass)", (await statusFor({ publicId: PID })) === 503);
    process.env.AUTH_TOKEN_SECRET = SECRET;
  }

  console.log("\n— page: GET /lab/web-form-pilot —");
  const good = mintPilotPass(9, PID, T0)!;
  const deps = { resolve: resolver(live), now: () => T0 };
  const ok = await handlePilotPage(pageReq(`?id=${PID}&sid=${SID}`, good), deps);
  const html = await ok.text();
  check("valid pass + live business-9 connection → 200 HTML", ok.status === 200 && (ok.headers.get("content-type") ?? "").startsWith("text/html"));

  const failures: Array<[string, Request, Parameters<typeof handlePilotPage>[1]]> = [
    ["no pass at all (anonymous visitor)", pageReq(`?id=${PID}&sid=${SID}`), deps],
    ["a forged pass", pageReq(`?id=${PID}&sid=${SID}`, "eyJ2IjoxfQ.AAAA"), deps],
    ["an expired pass", pageReq(`?id=${PID}&sid=${SID}`, good), { ...deps, now: () => T0 + PILOT_PASS_TTL_SECONDS * 1000 }],
    ["a pass for another publicId", pageReq(`?id=${OTHER_PID}&sid=${SID}`, good), deps],
    ["a business-38 connection (even with its own valid pass)", pageReq(`?id=${OTHER_PID}&sid=${SID}`, mintPilotPass(9, OTHER_PID, T0)!), deps],
    ["a revoked / paused connection", pageReq(`?id=${PID}&sid=${SID}`, good), { ...deps, resolve: resolver({}) }],
    ["a resolver error", pageReq(`?id=${PID}&sid=${SID}`, good), { ...deps, resolve: throwing }],
    ["no sid", pageReq(`?id=${PID}`, good), deps],
    ["an upper-case / non-UUID sid", pageReq(`?id=${PID}&sid=${SID.toUpperCase()}`, good), deps],
    ["an injection attempt in sid", pageReq(`?id=${PID}&sid=${encodeURIComponent(`${SID}"><script>alert(1)</script>`)}`, good), deps],
    ["no id", pageReq(`?sid=${SID}`, good), deps],
  ];
  const bodies = new Set<string>();
  for (const [name, req, d] of failures) {
    const r = await handlePilotPage(req, d);
    const b = await r.text();
    bodies.add(b);
    check(`404: ${name}`, r.status === 404 && r.headers.get("cache-control") === "no-store", String(r.status));
  }
  check("every refusal is the same body (no oracle)", bodies.size === 1 && [...bodies][0] === "Not Found");

  console.log("\n— page HTML —");
  const endpoint = `${ORIGIN}/api/intake/acquisition/web/${PID}`;
  const stock = webFormSnippet(endpoint);
  const expectedForm = stock.replace(`<input type="hidden" name="submission_id">`, `<input type="hidden" name="submission_id" value="${SID}">`);
  check("contains the stock webFormSnippet (only the sid value added)", html.includes(expectedForm));
  check("the snippet itself still has exactly one empty submission_id input", stock.split(`<input type="hidden" name="submission_id">`).length === 2);
  const actions = [...html.matchAll(/action="([^"]*)"/g)].map((m) => m[1]);
  check("exactly one form, posting to the PUBLIC intake endpoint on the same origin", actions.length === 1 && actions[0] === endpoint, actions.join(","));
  check("method is POST", /<form[^>]*method="post"/.test(html));
  check("no internal API in the page (only /api/intake/acquisition/web/)", (html.match(/\/api\//g) ?? []).length === 1);
  check("no fetch / XHR in the page", !/fetch\(|XMLHttpRequest/.test(html));
  check("exactly one script, and it is the stock one", (html.match(/<script>/g) ?? []).length === 1);
  check("meta robots noindex", html.includes(`<meta name="robots" content="noindex,nofollow">`));
  check("x-robots-tag noindex", ok.headers.get("x-robots-tag") === "noindex, nofollow");
  check("cache-control no-store", ok.headers.get("cache-control") === "no-store");
  const csp = ok.headers.get("content-security-policy") ?? "";
  check("CSP: only the stock script by hash", /script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !csp.includes("unsafe-eval") && !/script-src[^;]*unsafe-inline/.test(csp));
  check("CSP: the form may post only to this origin", csp.includes("form-action 'self'"));
  check("CSP: never framed", csp.includes("frame-ancestors 'none'"));

  console.log("\n— no secret in the HTML —");
  check("the pass is not in the page", !html.includes(good) && !html.includes(good.split(".")[1]));
  check("the signing secret is not in the page", !html.includes(SECRET));
  check("no Bearer / authorization / connection key in the page", !/bearer|authorization|api[_-]?key|secret|token/i.test(html));
  check("no business id other than the heading's 9", !/\b38\b/.test(html));
  check("renderPilotPage refuses a non-UUID sid", (() => { try { renderPilotPage(endpoint, `x" onfocus="alert(1)`); return false; } catch { return true; } })());

  console.log("\n— the REAL pass route, through the REAL canonical guard (no database) —");
  // If the guard let a request through, the route would reach the resolver, which has no database
  // here and would answer 503 — so a 401 proves the guard refused BEFORE any lookup or cookie.
  const { POST } = await import("@/app/api/platform-admin/web-form-pilot/pass/route");
  const env = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const forged = `Bearer ${Buffer.from(JSON.stringify({ sub: 9 })).toString("base64url")}.AAAA`;
  for (const mfa of ["true", undefined]) {
    env({ PLATFORM_ADMIN_MFA_REQUIRED: mfa, PLATFORM_ADMIN_EMAILS: "admin@example.com" });
    const tag = mfa ? "MFA enforcement ON" : "MFA enforcement OFF";
    const noToken = await POST(passReq({ publicId: PID }));
    check(`route (${tag}): no session → 401`, noToken.status === 401, String(noToken.status));
    check(`route (${tag}): no session → no pass cookie`, !noToken.headers.get("set-cookie"));
    const bad = await POST(
      new Request(`${ORIGIN}/api/platform-admin/web-form-pilot/pass`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: forged },
        body: JSON.stringify({ publicId: PID }),
      })
    );
    check(`route (${tag}): forged Bearer token → 401`, bad.status === 401, String(bad.status));
    check(`route (${tag}): forged Bearer token → no pass cookie`, !bad.headers.get("set-cookie"));
    const elevationOnly = await POST(
      new Request(`${ORIGIN}/api/platform-admin/web-form-pilot/pass`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-elevation": "x.y" },
        body: JSON.stringify({ publicId: PID }),
      })
    );
    check(`route (${tag}): an elevation header without a session → 401`, elevationOnly.status === 401, String(elevationOnly.status));
  }
  env({ PLATFORM_ADMIN_MFA_REQUIRED: undefined, PLATFORM_ADMIN_EMAILS: undefined });

  console.log("\n— wiring (static) —");
  const pageRoute = readFileSync("app/lab/web-form-pilot/route.ts", "utf8");
  const passRoute = readFileSync("app/api/platform-admin/web-form-pilot/pass/route.ts", "utf8");
  const lib = readFileSync("lib/intake/acquisition/web-form-pilot.ts", "utf8");
  check("page route exports GET only", /export async function GET\(/.test(pageRoute) && !/export async function (POST|PUT|PATCH|DELETE)\(/.test(pageRoute));
  check("pass route exports POST only", /export async function POST\(/.test(passRoute) && !/export async function (GET|PUT|PATCH|DELETE)\(/.test(passRoute));
  check(
    "pass route awaits the canonical admin guard (Bearer + allowlist + MFA) FIRST and returns a refusal before anything else",
    /export async function POST\(req: Request\) \{\n  const admin = await requirePlatformAdminOrResponse\(req\);\n  if \(admin instanceof NextResponse\) return admin;\n  return handlePilotPass\(req, admin,/.test(passRoute.replace(/\r\n/g, "\n"))
  );
  check("both routes resolve ONLY via the read-only public resolver", [pageRoute, passRoute].every((s) => s.includes("resolvePublicConnection(WEB_FORM_SOURCE") && !s.includes("@/lib/prisma")));
  check("the pilot module writes nothing (no prisma, no ingest)", !/@\/lib\/prisma|ingestAcquisition|acceptIntake|\$queryRaw|\$executeRaw|\.(create|createMany|upsert|delete|deleteMany|updateMany)\(/.test(lib));
  check("the pilot module never reads a businessId from the request", !/searchParams\.get\("business/.test(lib));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
