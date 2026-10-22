/**
 * Run: npx tsx app/api/platform-admin/admin-a1-routes.test.ts
 *
 * Admin Control Center A1 — what an unauthenticated caller learns from the
 * admin routes: nothing beyond "401". In particular the feature-access PATCH no
 * longer discloses whether its mutation switch is on (it used to answer 503 to
 * anyone before checking identity), and every new A1 route refuses before it
 * reads anything.
 *
 * OFFLINE: a request without a bearer token is refused before any database or
 * network call (lib/auth.ts returns at the header check).
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.PLATFORM_ADMIN_EMAILS = "admin@lab.invalid";
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "a1_routes_synthetic_secret";

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const req = (path: string, method = "GET", body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  const features = await import("./businesses/[id]/features/[featureKey]/route");
  const home = await import("./home/route");
  const passkeys = await import("./passkeys/route");
  const regOptions = await import("./passkeys/register/options/route");
  const regVerify = await import("./passkeys/register/verify/route");
  const revoke = await import("./passkeys/[id]/revoke/route");
  const authOptions = await import("./passkeys/auth/options/route");
  const authVerify = await import("./passkeys/auth/verify/route");
  const replaceBegin = await import("./mfa/replace/begin/route");
  const replaceConfirm = await import("./mfa/replace/confirm/route");
  const businesses = await import("./businesses/route");

  await check("feature PATCH with the switch OFF answers 401, not 503 (no flag disclosure)", async () => {
    delete process.env.FEATURE_ACCESS_MUTATIONS_ENABLED;
    const res = await features.PATCH(req("/api/platform-admin/businesses/38/features/x", "PATCH", { state: "INHERIT", reason: "lab lab lab" }), {
      params: Promise.resolve({ id: "38", featureKey: "x" }),
    });
    assert.equal(res.status, 401);
  });

  await check("feature PATCH with the switch ON also answers 401 to an anonymous caller", async () => {
    process.env.FEATURE_ACCESS_MUTATIONS_ENABLED = "true";
    const res = await features.PATCH(req("/api/platform-admin/businesses/38/features/x", "PATCH", { state: "INHERIT", reason: "lab lab lab" }), {
      params: Promise.resolve({ id: "38", featureKey: "x" }),
    });
    assert.equal(res.status, 401);
    delete process.env.FEATURE_ACCESS_MUTATIONS_ENABLED;
  });

  const anonymous: Array<[string, () => Promise<Response>]> = [
    ["GET /home", () => home.GET(req("/api/platform-admin/home"))],
    ["GET /businesses?q=", () => businesses.GET(req("/api/platform-admin/businesses?q=a"))],
    ["GET /passkeys", () => passkeys.GET(req("/api/platform-admin/passkeys"))],
    ["POST /passkeys/register/options", () => regOptions.POST(req("/api/platform-admin/passkeys/register/options", "POST"))],
    ["POST /passkeys/register/verify", () => regVerify.POST(req("/api/platform-admin/passkeys/register/verify", "POST", { response: {} }))],
    ["POST /passkeys/1/revoke", () => revoke.POST(req("/api/platform-admin/passkeys/1/revoke", "POST"), { params: Promise.resolve({ id: "1" }) })],
    ["POST /passkeys/auth/options", () => authOptions.POST(req("/api/platform-admin/passkeys/auth/options", "POST"))],
    ["POST /passkeys/auth/verify", () => authVerify.POST(req("/api/platform-admin/passkeys/auth/verify", "POST", { response: {} }))],
    ["POST /mfa/replace/begin", () => replaceBegin.POST(req("/api/platform-admin/mfa/replace/begin", "POST"))],
    ["POST /mfa/replace/confirm", () => replaceConfirm.POST(req("/api/platform-admin/mfa/replace/confirm", "POST", { replacementToken: "x.y", code: "123456" }))],
  ];
  for (const [name, call] of anonymous) {
    await check(`${name} refuses an anonymous caller with 401`, async () => {
      const res = await call();
      assert.equal(res.status, 401);
    });
  }

  console.log(`\nAdmin Control Center A1 routes: OK — ${passed} checks passed`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
