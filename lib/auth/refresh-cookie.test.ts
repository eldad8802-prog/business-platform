/**
 * Refresh cookie + CSRF adapter (run manually):
 *   npx tsx lib/auth/refresh-cookie.test.ts
 *
 * The browser-facing half. SameSite=Strict is the structural defence; these
 * checks are the independent second layer, and the reason they are tested apart
 * from the engine is that the engine must never depend on them.
 */

import { NextResponse } from "next/server";
import {
  REFRESH_COOKIE,
  REFRESH_PATH,
  checkBrowserCsrf,
  clearRefreshCookie,

  readRefreshCookie,
  refreshCookieMaxAge,
  setRefreshCookie,
} from "@/lib/auth/refresh-cookie";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const req = (headers: Record<string, string>) =>
  new Request("https://app.test/api/auth/refresh", { method: "POST", headers });

function main() {
  // ---- cookie attributes --------------------------------------------------
  {
    const res = NextResponse.json({});
    const now = new Date("2026-01-01T00:00:00.000Z");
    setRefreshCookie(res, "sid.secret", {
      now,
      absoluteExpiresAt: new Date(now.getTime() + 90 * 86_400_000),
    });
    const c = res.cookies.get(REFRESH_COOKIE);
    const raw = res.headers.get("set-cookie") ?? "";
    ok("the cookie is set", c?.value === "sid.secret");
    ok("HttpOnly", /HttpOnly/i.test(raw));
    ok("SameSite=Strict", /SameSite=strict/i.test(raw));
    ok("Path is the refresh endpoint only", raw.includes(`Path=${REFRESH_PATH}`));
    ok("Max-Age is capped at the 30-day idle window", /Max-Age=2592000/.test(raw));
  }

  // Max-Age never outlives the 90-day ceiling.
  {
    const now = new Date("2026-01-01T00:00:00.000Z");
    ok(
      "Max-Age shrinks as the absolute ceiling approaches",
      refreshCookieMaxAge(now, new Date(now.getTime() + 3600_000)) === 3600
    );
    ok(
      "Max-Age is never negative",
      refreshCookieMaxAge(now, new Date(now.getTime() - 5000)) === 0
    );
  }

  // ---- clearing -----------------------------------------------------------
  {
    const res = NextResponse.json({});
    clearRefreshCookie(res);
    const raw = res.headers.get("set-cookie") ?? "";
    ok("clearing expires the cookie", /Max-Age=0/.test(raw));
    ok("clearing uses the same Path, or it would expire nothing", raw.includes(`Path=${REFRESH_PATH}`));
  }

  // ---- reading ------------------------------------------------------------
  {
    ok(
      "reads its own cookie out of a crowded header",
      readRefreshCookie(req({ cookie: `a=1; ${REFRESH_COOKIE}=sid.secret; b=2` })) === "sid.secret"
    );
    ok("absent cookie reads as null", readRefreshCookie(req({ cookie: "a=1" })) === null);
    ok("no cookie header reads as null", readRefreshCookie(req({})) === null);
    ok(
      "a cookie whose name merely contains ours is not mistaken for it",
      readRefreshCookie(req({ cookie: `not_${REFRESH_COOKIE}=x` })) === null
    );
  }

  // ---- CSRF ---------------------------------------------------------------
  {
    ok(
      "same-origin POST is accepted",
      checkBrowserCsrf(
        req({ origin: "https://app.test", host: "app.test", "sec-fetch-site": "same-origin" })
      ).ok
    );
    ok(
      "a missing Origin is REFUSED, not waved through",
      !checkBrowserCsrf(req({ host: "app.test" })).ok
    );
    ok(
      "a foreign Origin is refused",
      !checkBrowserCsrf(req({ origin: "https://evil.test", host: "app.test" })).ok
    );
    ok(
      "Sec-Fetch-Site cross-site is refused even when the Origin matches",
      !checkBrowserCsrf(
        req({ origin: "https://app.test", host: "app.test", "sec-fetch-site": "cross-site" })
      ).ok
    );
    ok(
      "the proxy's forwarded host is what the Origin is compared against",
      checkBrowserCsrf(
        req({ origin: "https://public.test", host: "internal.local", "x-forwarded-host": "public.test" })
      ).ok
    );
    ok(
      "a garbage Origin cannot throw its way past the check",
      !checkBrowserCsrf(req({ origin: "not a url", host: "app.test" })).ok
    );
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main();
