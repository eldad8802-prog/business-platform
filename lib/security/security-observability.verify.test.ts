/**
 * SEC-F — security events, error seam and cost limits (no DB, no network):
 *   npx tsx lib/security/security-observability.verify.test.ts
 *
 * The cost-limit section drives the REAL limiter (checkRateLimit) through the
 * memory backend, and — for the fail-mode proof — through the REAL Upstash
 * backend pointed at a closed loopback port, so the backend genuinely fails.
 */
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.SECURITY_EVENT_IP_KEY = "k".repeat(40); // synthetic

import {
  buildSecurityEventRow,
  getSecurityEventWriteFailures,
  recordSecurityEvent,
  sanitizeSecurityMetadata,
  setSecurityEventWriterForTests,
  truncateIp,
  type SecurityEventRow,
} from "@/lib/security/security-events";
import { reportError, scrubText, setErrorReporterAdapter, type ScrubbedError } from "@/lib/observability/report-error";
import { COST_LIMIT_EXCEEDED, COST_LIMIT_UNAVAILABLE, enforceCostLimit } from "@/lib/security/cost-limits";
import { resetMemoryBackendForTests } from "@/lib/security/rate-limiter/memory-backend";
import { BUCKETS } from "@/lib/security/rate-limiter/buckets";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const EMAIL = "victim.owner@example.co.il";
const PASSWORD = "Sup3r-Secret-Pa55!";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.c2lnbmF0dXJlLXZhbHVl";

async function securityEvents() {
  console.log("== security events: PII minimisation ==");
  const req = new Request("https://app.example/api/auth/login?token=abc&email=x@y.z", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.77, 10.0.0.1", cookie: `dz_refresh=${JWT}`, authorization: `Bearer ${JWT}` },
  });
  const row = buildSecurityEventRow({
    type: "AUTH_LOGIN_FAILURE",
    outcome: "FAILURE",
    reason: "invalid_credentials",
    businessId: 12,
    userId: 34,
    req,
    metadata: { email: EMAIL, password: PASSWORD, accessToken: JWT, note: EMAIL, attempt: 3, bucket: "COST_LLM_GENERATION", ok: true, phone: "0521234567" },
  });
  const keys = Object.keys(row).sort();
  ok("row keys are exactly the PII-minimised shape",
    JSON.stringify(keys) === JSON.stringify(["actorKind", "businessId", "eventType", "ipHash", "metadata", "occurredAt", "outcome", "reasonClass", "route", "userId"]),
    keys.join(","));
  const flat = JSON.stringify(row);
  ok("no email anywhere in the row", !flat.includes("@") && !flat.includes("victim"), flat);
  ok("no password anywhere in the row", !flat.includes(PASSWORD));
  ok("no token anywhere in the row", !flat.includes("eyJ") && !flat.includes("abc"));
  ok("no raw IP anywhere in the row", !flat.includes("203.0.113") && /^[0-9a-f]{32}$/.test(row.ipHash ?? ""));
  ok("metadata keeps only safe scalars", JSON.stringify(row.metadata) === JSON.stringify({ attempt: 3, bucket: "COST_LLM_GENERATION", ok: true }), JSON.stringify(row.metadata));
  ok("route is the path only (no query string)", row.route === "/api/auth/login");
  ok("same /24 hashes the same (correlatable) and a different /24 does not",
    buildSecurityEventRow({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", req: new Request("https://a/x", { headers: { "x-forwarded-for": "203.0.113.5" } }) }).ipHash === row.ipHash &&
    buildSecurityEventRow({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", req: new Request("https://a/x", { headers: { "x-forwarded-for": "198.51.100.5" } }) }).ipHash !== row.ipHash);
  ok("IPv6 is truncated to /48", truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348") === "2001:db8:85a3::/48");
  ok("free-text reason is dropped", buildSecurityEventRow({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", reason: `bad password for ${EMAIL}` }).reasonClass === null);
  ok("sanitiser drops a token-shaped value under an innocent key", sanitizeSecurityMetadata({ detail: JWT.slice(0, 40) + "/" }) === null || !JSON.stringify(sanitizeSecurityMetadata({ detail: "Bearer abc" })).includes("Bearer"));
  const noKey = (() => {
    const prev = process.env.SECURITY_EVENT_IP_KEY;
    delete process.env.SECURITY_EVENT_IP_KEY;
    const r = buildSecurityEventRow({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", req });
    process.env.SECURITY_EVENT_IP_KEY = prev;
    return r.ipHash;
  })();
  ok("without SECURITY_EVENT_IP_KEY nothing about the address is kept", noKey === null);

  console.log("== security events: best effort ==");
  const written: SecurityEventRow[] = [];
  const prev = setSecurityEventWriterForTests(async (r) => { written.push(r); });
  await recordSecurityEvent({ type: "DATA_EXPORT", outcome: "SUCCESS", businessId: 1, userId: 2 });
  ok("event reaches the writer", written.length === 1 && written[0].eventType === "DATA_EXPORT");
  setSecurityEventWriterForTests(async () => { throw new Error("db down"); });
  const before = getSecurityEventWriteFailures();
  const origErr = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let threw = false;
  try { await recordSecurityEvent({ type: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", metadata: { email: EMAIL } }); } catch { threw = true; }
  console.error = origErr;
  ok("a failing write never throws into the auth flow", !threw);
  ok("a failing write increments the failure counter", getSecurityEventWriteFailures() === before + 1);
  ok("a failing write falls back to one structured console line without PII",
    lines.length === 1 && lines[0].includes("SECURITY_EVENT_WRITE_FAILED") && !lines[0].includes("@"), lines.join("|"));
  setSecurityEventWriterForTests(prev);
}

function errorSeam() {
  console.log("== error seam: scrubber ==");
  const msg =
    `Request failed: Authorization: Bearer ${JWT} cookie: dz_refresh=${JWT}; owner ${EMAIL} phone +972-52-123-4567 or 052-123-4567 ` +
    `IBAN IL62 0108 0000 0009 9999 999 card 4580 1234 5678 9012 id 123456782 password=${PASSWORD} ` +
    `postgresql://app_runtime_prod:hunter2@db.example/neondb api_key: sk_live_abcdef`;
  const s = scrubText(msg);
  for (const [label, needle] of [
    ["jwt", "eyJ"], ["email", EMAIL], ["phone intl", "123-4567"], ["iban", "0108"], ["card", "4580"],
    ["israeli id", "123456782"], ["password", PASSWORD], ["db credential", "hunter2"], ["api key", "sk_live"],
  ] as const) {
    ok(`scrubber removes ${label}`, !s.includes(needle), s);
  }
  const reports: ScrubbedError[] = [];
  const prev = setErrorReporterAdapter({ name: "test", report: (e) => { reports.push(e); } });
  reportError(new Error(msg), { userEmail: EMAIL, requestBody: { password: PASSWORD }, route: "/api/x", headers: { authorization: JWT } });
  setErrorReporterAdapter(prev);
  const flat = JSON.stringify(reports);
  ok("reportError routes through the adapter", reports.length === 1 && reports[0].name === "Error");
  ok("reportError output carries no email/password/token", !flat.includes(EMAIL) && !flat.includes(PASSWORD) && !flat.includes("eyJ"), flat);
  ok("non-sensitive context survives", reports[0].context.route === "/api/x");
  const bad = setErrorReporterAdapter({ name: "boom", report: () => { throw new Error("vendor down"); } });
  let threw = false;
  const origErr = console.error;
  console.error = () => {};
  try { reportError(new Error("x")); } catch { threw = true; }
  console.error = origErr;
  setErrorReporterAdapter(bad);
  ok("a failing vendor adapter never throws", !threw);
}

async function costLimits() {
  console.log("== cost limits ==");
  const prevWriter = setSecurityEventWriterForTests(async () => {});
  resetMemoryBackendForTests();
  // The contract, stated independently of the config it checks: 20 LLM calls per
  // business per minute.
  const rule = { limit: 20 };
  // Spread across enough users that the PER-BUSINESS rule is the one that trips.
  let allowed = 0;
  for (let i = 0; i < rule.limit; i++) {
    const r = await enforceCostLimit("COST_LLM_GENERATION", { id: 1000 + i, businessId: 77 }, null);
    if (r === null) allowed++;
  }
  ok(`first ${rule.limit} LLM calls for one business are allowed`, allowed === rule.limit, `allowed=${allowed}`);
  const denied = await enforceCostLimit("COST_LLM_GENERATION", { id: 5000, businessId: 77 }, null);
  const body = denied ? await denied.json() : null;
  ok(`call ${rule.limit + 1} for that business → 429 ${COST_LIMIT_EXCEEDED} (scope=business)`,
    denied?.status === 429 && body?.code === COST_LIMIT_EXCEEDED && body?.scope === "business" && body?.bucket === "COST_LLM_GENERATION",
    JSON.stringify({ status: denied?.status, body }));
  ok("the denial carries Retry-After", Number(denied?.headers.get("Retry-After")) > 0);
  ok("ANOTHER business is unaffected", (await enforceCostLimit("COST_LLM_GENERATION", { id: 5001, businessId: 78 }, null)) === null);
  ok("unauthenticated callers are not counted (the route's own 401 applies)", (await enforceCostLimit("COST_LLM_GENERATION", null, null)) === null);

  console.log("== cost limits: backend failure (real Upstash client → closed loopback port) ==");
  process.env.RATE_LIMIT_BACKEND = "redis";
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9";
  process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic";
  const origErr = console.error;
  console.error = () => {};
  const llm = await enforceCostLimit("COST_LLM_GENERATION", { id: 1, businessId: 1 }, null);
  const ocr = await enforceCostLimit("COST_OCR_IMPORT", { id: 1, businessId: 1 }, null);
  const pdf = await enforceCostLimit("COST_PDF_RENDER", { id: 1, businessId: 1 }, null);
  console.error = origErr;
  const llmBody = llm ? await llm.json() : null;
  ok(`LLM bucket FAILS CLOSED → 503 ${COST_LIMIT_UNAVAILABLE}`, llm?.status === 503 && llmBody?.code === COST_LIMIT_UNAVAILABLE, JSON.stringify({ s: llm?.status, llmBody }));
  ok("OCR bucket FAILS CLOSED → 503", ocr?.status === 503);
  ok("PDF bucket fails OPEN (documented) → allowed", pdf === null);
  for (const [name, cfg] of Object.entries(BUCKETS)) {
    if (/^COST_(LLM|OCR)/.test(name)) ok(`${name} is declared fail-closed`, cfg.failMode === "closed");
  }
  process.env.RATE_LIMIT_BACKEND = "memory";
  setSecurityEventWriterForTests(prevWriter);
}

(async () => {
  await securityEvents();
  errorSeam();
  await costLimits();
  console.log(failed === 0 ? "SECURITY OBSERVABILITY VERIFY: ALL PASS" : `SECURITY OBSERVABILITY VERIFY: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`[SETUP-ERROR] ${e?.stack ?? e}`);
  process.exit(2);
});
