/**
 * Tests for the FCM credential check button logic (Platform Admin → בדיקות מערכת).
 *   npx tsx components/platform-admin/fcm-auth-check-logic.test.ts
 *
 * Every request is mocked: the real route / Google is never called, so no network happens in test/build/CI.
 * Static checks pin the section to the canonical privileged fetch and the existing guarded route.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PlatformAdminFetchError } from "@/lib/platform-admin/fetch-platform-admin";
import type { TokenProbeInvocation } from "@/lib/platform-admin/fetch-platform-admin";
import {
  FCM_AUTH_CHECK_RESULTS,
  createFcmAuthCheckRunner,
  executeFcmAuthCheck,
  fcmAuthCheckView,
  parseFcmAuthCheckResult,
  sanitizeFcmAuthCheckErrorMessage,
  type FcmAuthCheckState,
} from "./fcm-auth-check-logic";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SECRET = "-----BEGIN PRIVATE KEY-----SHOULD-NOT-APPEAR";

function counting(impl: () => Promise<TokenProbeInvocation>) {
  let calls = 0;
  return {
    fn: async () => {
      calls += 1;
      return impl();
    },
    calls: () => calls,
  };
}

async function main() {
  // ── parse: exactly the four classes ──────────────────────────────────────────
  ok("exactly four result classes", FCM_AUTH_CHECK_RESULTS.length === 4);
  for (const r of ["configured", "authentication_failed", "not_configured", "unavailable"] as const) {
    ok(`parse accepts ${r}`, parseFcmAuthCheckResult({ result: r }) === r);
  }
  for (const [label, raw] of [
    ["null", null],
    ["string body", "configured"],
    ["array", ["configured"]],
    ["missing result", {}],
    ["unknown class", { result: "ok" }],
    ["number", { result: 1 }],
    ["upper-case", { result: "CONFIGURED" }],
    ["token-shaped", { result: "ya29.a0AfH6SMB" }],
  ] as Array<[string, unknown]>) {
    ok(`parse rejects ${label}`, parseFcmAuthCheckResult(raw) === null);
  }

  // ── view: Hebrew copy, tone, no extra fields ─────────────────────────────────
  for (const r of FCM_AUTH_CHECK_RESULTS) {
    const v = fcmAuthCheckView(r);
    ok(`view ${r}: Hebrew title + detail`, /[֐-׿]/.test(v.title) && /[֐-׿]/.test(v.detail));
    ok(`view ${r}: only result/title/detail/tone`, JSON.stringify(Object.keys(v).sort()) === JSON.stringify(["detail", "result", "title", "tone"]));
  }
  ok("configured → success tone", fcmAuthCheckView("configured").tone === "success");
  ok("authentication_failed → urgent tone", fcmAuthCheckView("authentication_failed").tone === "urgent");
  ok("configured copy says no push was sent", fcmAuthCheckView("configured").detail.includes("לא נשלחה התראה"));

  // ── execute: success never leaks extra body fields ───────────────────────────
  {
    const s = await executeFcmAuthCheck(async () => ({
      routeHttpStatus: 200,
      result: { result: "configured", accessToken: SECRET, privateKey: SECRET },
    }));
    ok("execute: configured → succeeded", s.phase === "succeeded" && s.view.result === "configured");
    ok("execute: extra body fields never reach the state", !JSON.stringify(s).includes("SHOULD-NOT-APPEAR"));
  }
  {
    const s = await executeFcmAuthCheck(async () => ({ routeHttpStatus: 200, result: { result: SECRET } }));
    ok("execute: unknown class → failed, raw value not shown", s.phase === "failed" && !JSON.stringify(s).includes("SHOULD-NOT-APPEAR"));
  }

  // ── execute: errors → status-only Hebrew messages ────────────────────────────
  for (const status of [401, 403, 429, 503, 500, 418]) {
    const s = await executeFcmAuthCheck(async () => {
      throw new PlatformAdminFetchError(SECRET, status, "SOME_CODE");
    });
    ok(
      `execute: HTTP ${status} → failed with sanitized message`,
      s.phase === "failed" && s.routeHttpStatus === status && s.message === sanitizeFcmAuthCheckErrorMessage(status) && !s.message.includes("SHOULD-NOT-APPEAR")
    );
  }
  {
    const s = await executeFcmAuthCheck(async () => {
      throw new TypeError(SECRET);
    });
    ok("execute: network failure → null status, no raw error text", s.phase === "failed" && s.routeHttpStatus === null && !JSON.stringify(s).includes("SHOULD-NOT-APPEAR"));
  }
  ok("429 message mentions the 3-per-10-minutes limit", sanitizeFcmAuthCheckErrorMessage(429).includes("3") && sanitizeFcmAuthCheckErrorMessage(429).includes("10"));
  ok("403 message mentions two-step verification", sanitizeFcmAuthCheckErrorMessage(403).includes("אימות דו-שלבי"));

  // ── runner: one request in flight ────────────────────────────────────────────
  {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const req = counting(async () => {
      await gate;
      return { routeHttpStatus: 200, result: { result: "configured" } };
    });
    const states: FcmAuthCheckState[] = [];
    const runner = createFcmAuthCheckRunner({ request: req.fn, onState: (s) => states.push(s) });
    const a = runner.run();
    const b = runner.run(); // double-click while running
    ok("runner: running while in flight", runner.isRunning());
    release();
    await Promise.all([a, b]);
    ok("runner: double-click → exactly ONE request", req.calls() === 1);
    ok("runner: states running → succeeded", states.map((s) => s.phase).join(",") === "running,succeeded");
    ok("runner: idle again after finishing", !runner.isRunning());
    await runner.run();
    ok("runner: a later click sends one more request (server rate limit caps repeats)", req.calls() === 2);
  }
  {
    const req = counting(async () => {
      throw new PlatformAdminFetchError("x", 429);
    });
    const states: FcmAuthCheckState[] = [];
    const runner = createFcmAuthCheckRunner({ request: req.fn, onState: (s) => states.push(s) });
    await runner.run();
    ok("runner: failure ends in failed state and unlocks", states.at(-1)?.phase === "failed" && !runner.isRunning());
  }

  // ── static: section + fetch helper + page ────────────────────────────────────
  const section = read("components/platform-admin/fcm-auth-check-section.tsx");
  const fetcher = read("lib/platform-admin/fetch-platform-admin.ts");
  const page = read("app/(platform-admin)/admin/diagnostics/page.tsx");
  const logic = read("components/platform-admin/fcm-auth-check-logic.ts");
  ok("section uses the canonical postPlatformAdminFcmAuthCheck", section.includes("postPlatformAdminFcmAuthCheck"));
  for (const [label, src] of [["section", section], ["logic", logic]] as Array<[string, string]>) {
    ok(`${label}: no direct fetch()`, !/\bfetch\s*\(/.test(src));
    ok(`${label}: no browser storage`, !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src));
    ok(`${label}: no console output`, !/console\./.test(src));
    ok(`${label}: no env / key / token handling`, !/process\.env|FCM_PRIVATE_KEY|private_key|accessToken|access_token/.test(src));
  }
  const fn = fetcher.slice(fetcher.indexOf("export async function postPlatformAdminFcmAuthCheck"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  ok("fetch helper: POST to the existing route", body.includes('"/api/platform-admin/notifications/fcm-auth-check"') && body.includes('method: "POST"'));
  ok("fetch helper: goes through adminRequest (Bearer + MFA elevation + step-up)", body.includes("adminRequest<unknown>("));
  ok("diagnostics page renders the section inside the admin console", page.includes("<FcmAuthCheckSection />") && page.includes("AdminConsole"));

  // ── route guard stays in place (the button relies on it) ─────────────────────
  const route = read("app/api/platform-admin/notifications/fcm-auth-check/route.ts");
  ok("route still uses the canonical platform-admin guard", route.includes("requirePlatformAdminOrResponse"));
  ok("route still rate-limits with FCM_AUTH_CHECK", route.includes('bucket: "FCM_AUTH_CHECK"'));
  ok("route still exports POST only", /export async function POST\(/.test(route) && !/export async function (GET|PUT|PATCH|DELETE)\(/.test(route));

  console.log(failed === 0 ? `\nALL PASS (${passed})` : `\n${failed} FAILED, ${passed} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
