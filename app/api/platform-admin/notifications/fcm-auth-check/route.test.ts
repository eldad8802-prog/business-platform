/**
 * FCM credential check route (run manually and by notification-engine-ci.yml):
 *   npx tsx app/api/platform-admin/notifications/fcm-auth-check/route.test.ts
 *
 * Pure, every dependency injected (no database, no network, no key):
 *  1. 401 / 403 from the canonical platform-admin guard (incl. the MFA refusal) ⇒ returned as is; the rate limit,
 *     the check and the audit never run.
 *  2. A refused rate-limit decision ⇒ 429 (or 503 when the fail-closed limiter is down); the check never runs.
 *  3. A platform admin ⇒ ONE check, rate-limited by the admin's id; 200 { result } only, no-store; one audit with
 *     the result class only — for each of configured / authentication_failed / not_configured / unavailable.
 *  4. A thrown error ⇒ 500 "Server error", no message / stack in the body or in the log.
 *  5. Static: the route uses requirePlatformAdminOrResponse and the FCM_AUTH_CHECK bucket (fail-closed, bounded),
 *     exports POST as its only HTTP method, and never reads or returns a key / token.
 */
import { readFileSync } from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import type { PlatformAdminUser } from "@/lib/auth/platform-admin";
import type { FcmAuthCheckResult } from "@/lib/notifications/push/fcm-client";
import { BUCKETS } from "@/lib/security/rate-limiter/buckets";
import type { RateLimitDecision } from "@/lib/security/rate-limiter/types";

import { handleFcmAuthCheck } from "./route";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, detail ?? "");
  }
}

const req = () => new NextRequest("https://app.test/api/platform-admin/notifications/fcm-auth-check", { method: "POST" });
const ADMIN: PlatformAdminUser = { id: 7, email: "admin@dubiz.test", name: "Admin", role: "PLATFORM_ADMIN" as PlatformAdminUser["role"] };
const decision = (over: Record<string, unknown>) =>
  ({ allowed: true, outcome: "allowed", bucket: "FCM_AUTH_CHECK", scope: "user", degraded: false, remaining: 2, resetAt: Date.now() + 600_000, retryAfterSeconds: 0, ...over }) as unknown as RateLimitDecision;
const ALLOW = decision({});
const DENY = decision({ allowed: false, outcome: "rate_limited", remaining: 0, retryAfterSeconds: 600 });
const DOWN = decision({ allowed: false, outcome: "backend_unavailable", degraded: true, remaining: 0, retryAfterSeconds: 5 });

type Over = { auth?: PlatformAdminUser | NextResponse; decision?: RateLimitDecision; result?: FcmAuthCheckResult; throwIn?: "check" | "audit" };
function harness(over: Over = {}) {
  const t = { rateCalls: [] as number[], checks: 0, audits: [] as { actorId: number; result: FcmAuthCheckResult }[] };
  const deps = {
    authorize: async () => over.auth ?? ADMIN,
    rateLimit: async (actorId: number) => {
      t.rateCalls.push(actorId);
      return over.decision ?? ALLOW;
    },
    check: async () => {
      t.checks += 1;
      if (over.throwIn === "check") throw new Error("PRIVATE KEY in a message");
      return over.result ?? "configured";
    },
    audit: async (actorId: number, result: FcmAuthCheckResult) => {
      if (over.throwIn === "audit") throw new Error("db down");
      t.audits.push({ actorId, result });
    },
  };
  return { t, deps };
}

async function main() {
  console.log("1. the canonical guard");
  const refusals: [string, NextResponse][] = [
    ["unauthenticated ⇒ 401", NextResponse.json({ error: "Unauthorized" }, { status: 401 })],
    ["not a platform admin / not allowlisted ⇒ 403", NextResponse.json({ error: "Forbidden" }, { status: 403 })],
    ["no MFA elevation ⇒ 403 ADMIN_MFA_REQUIRED", NextResponse.json({ error: "Multi-factor elevation required", code: "ADMIN_MFA_REQUIRED" }, { status: 403 })],
  ];
  for (const [label, res] of refusals) {
    const { t, deps } = harness({ auth: res });
    const out = await handleFcmAuthCheck(req(), deps);
    ok(label, out.status === res.status);
    ok(`${label}: no rate limit, no check, no audit`, t.rateCalls.length === 0 && t.checks === 0 && t.audits.length === 0, t);
  }

  console.log("2. the rate limit");
  {
    const { t, deps } = harness({ decision: DENY });
    const out = await handleFcmAuthCheck(req(), deps);
    ok("over the limit ⇒ 429 with Retry-After", out.status === 429 && out.headers.get("retry-after") === "600", out.status);
    ok("over the limit: no check, no audit", t.checks === 0 && t.audits.length === 0);
    ok("the limit is keyed by the admin's id", t.rateCalls[0] === ADMIN.id);
  }
  {
    const { t, deps } = harness({ decision: DOWN });
    const out = await handleFcmAuthCheck(req(), deps);
    ok("limiter down (fail-closed) ⇒ 503, no check", out.status === 503 && t.checks === 0, out.status);
  }

  console.log("3. a platform admin");
  for (const result of ["configured", "authentication_failed", "not_configured", "unavailable"] as const) {
    const { t, deps } = harness({ result });
    const out = await handleFcmAuthCheck(req(), deps);
    const body = (await out.json()) as Record<string, unknown>;
    ok(`${result}: 200 { result } only`, out.status === 200 && JSON.stringify(body) === JSON.stringify({ result }), body);
    ok(`${result}: no-store`, out.headers.get("cache-control") === "no-store");
    ok(`${result}: one check and one audit with the class only`, t.checks === 1 && t.audits.length === 1 && t.audits[0].actorId === ADMIN.id && t.audits[0].result === result, t);
  }

  console.log("4. errors");
  for (const where of ["check", "audit"] as const) {
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      logged.push(a);
    };
    const { deps } = harness({ throwIn: where });
    const out = await handleFcmAuthCheck(req(), deps);
    console.error = orig;
    const text = await out.text();
    ok(`a throw in ${where} ⇒ 500 "Server error"`, out.status === 500 && text === JSON.stringify({ error: "Server error" }), text);
    const log = JSON.stringify(logged);
    ok(`a throw in ${where}: only the error name is logged`, logged.length === 1 && log.includes("FCM_AUTH_CHECK_ERROR") && !log.includes("PRIVATE KEY") && !log.includes("db down"), logged);
  }

  console.log("5. static");
  const src = readFileSync("app/api/platform-admin/notifications/fcm-auth-check/route.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok("uses the canonical guard requirePlatformAdminOrResponse", /requirePlatformAdminOrResponse/.test(code));
  ok("rate-limited on the FCM_AUTH_CHECK bucket", /bucket:\s*"FCM_AUTH_CHECK"/.test(code));
  const methods = code.match(/export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g) ?? [];
  ok("the only HTTP method exported is POST", methods.join() === "export async function POST", methods);
  ok("no env read, key, assertion or access token in the route", !/process\.env|FCM_PRIVATE_KEY|privateKey|access_?token|assertion/i.test(code));
  const logs = code.match(/console\.(log|warn|error|info)\(/g) ?? [];
  ok("one log line, carrying the error name only", logs.length === 1 && /error instanceof Error \? error\.name/.test(code), logs);
  const b = BUCKETS.FCM_AUTH_CHECK;
  ok("FCM_AUTH_CHECK is fail-closed", b.failMode === "closed");
  ok(
    "FCM_AUTH_CHECK: ≤3 per admin per 10 min and a global daily cap ≤20",
    b.rules.some((r) => r.scope === "user" && r.limit <= 3 && r.windowSeconds >= 600) && b.rules.some((r) => r.scope === "global" && r.windowSeconds >= 86_400 && r.limit <= 20),
    b,
  );

  console.log(`\n[fcm-auth-check] PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
