/**
 * TEMPORARY ITA PRODUCTION app registration — route. Run manually:
 *   npx tsx app/api/platform-admin/authority/production-app-registration/route.test.ts
 *
 * Pure: injected admin guard / service / audit doubles, plus the REAL canonical
 * guard for the anonymous case (refuses at the header check, before any DB) and
 * the REAL fresh step-up check with synthetic elevations. No DB, no network.
 *
 * Proves the guard order — admin → fresh step-up → switch → request shape →
 * service — that the switch is exactly "true" and answers 503 only after auth,
 * that malformed / oversize / unknown-field bodies never reach the service, that
 * apply needs the confirmation word, and that every post-auth outcome is audited
 * with masked metadata only (never the secret).
 */
process.env.DATABASE_URL = "postgresql://registration-route-test@127.0.0.1:1/none";
process.env.PLATFORM_ADMIN_EMAILS = "admin@lab.invalid";
process.env.AUTH_TOKEN_SECRET = "registration-route-test-secret-0123456789abcdef0123";

import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import type { LogPlatformAuditEventInput } from "@/lib/services/platform-admin/platform-audit.service";
import type {
  AuthorityAppRegistrationInput,
  AuthorityAppRegistrationResult,
} from "@/lib/services/billing/authority/billing-authority-production-app-registration.service";

const SECRET = "Route-Secret-Value-0042-zz";
const CLIENT_ID = "client-id-route-5566";
const ADMIN_ID = 21;
const URL_PATH = "https://app.test/api/platform-admin/authority/production-app-registration";

let failures = 0;
function ok(name: string, cond: unknown) {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

const logged: string[] = [];
const origError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map((a) => String(a)).join(" "));
  origError(...args);
};

async function main() {
  const { handleAuthorityAppRegistration, POST, AUTHORITY_APP_REGISTRATION_ENV_VAR } = await import("./route");
  const { ADMIN_ELEVATION_HEADER, issueAdminElevation } = await import("@/lib/auth/platform-admin-elevation");

  const admin = { id: ADMIN_ID, email: "admin@lab.invalid", name: null, role: UserRole.PLATFORM_ADMIN };
  const goodBody = {
    mode: "dry-run",
    itaClientId: CLIENT_ID,
    clientSecret: SECRET,
    accountingSoftwareNumber: "270901",
    portalApplicationId: "16650",
  };

  function makeReq(
    body: unknown,
    opts: { elevation?: string | null; contentType?: string | null; raw?: string } = {}
  ) {
    const headers: Record<string, string> = {};
    const ct = opts.contentType === undefined ? "application/json" : opts.contentType;
    if (ct) headers["content-type"] = ct;
    const elevation = opts.elevation === undefined ? issueAdminElevation(ADMIN_ID) : opts.elevation;
    if (elevation) headers[ADMIN_ELEVATION_HEADER] = elevation;
    return new NextRequest(URL_PATH, {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(body),
    });
  }

  const allAudits: LogPlatformAuditEventInput[] = [];
  const auditDumpExtra: string[] = [];
  type Harness = {
    calls: AuthorityAppRegistrationInput[];
    audits: LogPlatformAuditEventInput[];
    deps: Parameters<typeof handleAuthorityAppRegistration>[1];
  };
  function harness(
    opts: {
      flag?: string | undefined;
      authorize?: (req: Request) => Promise<typeof admin | NextResponse>;
      result?: AuthorityAppRegistrationResult;
    } = {}
  ): Harness {
    const h: Harness = { calls: [], audits: [], deps: {} };
    h.deps = {
      authorize: opts.authorize ?? (async () => admin),
      env: { [AUTHORITY_APP_REGISTRATION_ENV_VAR]: "flag" in opts ? opts.flag : "true" },
      register: async (input) => {
        h.calls.push(input);
        return (
          opts.result ?? {
            ok: true,
            summary: {
              mode: input.mode,
              environment: "PRODUCTION",
              itaClientId: "***5566",
              accountingSoftwareNumber: "***0901",
              portalApplicationId: "16650",
              keyCheck: "OK",
              created: input.mode === "apply",
            },
          }
        );
      },
      audit: async (input) => {
        h.audits.push(input);
        allAudits.push(input);
      },
    };
    return h;
  }
  const responses: string[] = [];
  const read = async (res: Response) => {
    const text = await res.clone().text();
    responses.push(text);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  // 1. unauthenticated — the REAL canonical guard, no bearer.
  {
    const h = harness();
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), { ...h.deps, authorize: undefined });
    ok("unauthenticated → 401", res.status === 401);
    ok("unauthenticated: service and audit never run", h.calls.length === 0 && h.audits.length === 0);
    const viaPost = await POST(makeReq(goodBody));
    ok("exported POST without bearer → 401", viaPost.status === 401);
  }

  // 2. non-admin — guard answers 403.
  {
    const h = harness({ authorize: async () => NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    ok("non-admin → 403", res.status === 403);
    ok("non-admin: service and audit never run", h.calls.length === 0 && h.audits.length === 0);
  }
  {
    const h = harness({ flag: undefined, authorize: async () => NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    ok("non-admin with switch OFF still 403 (no flag disclosure)", res.status === 403);
  }

  // 3. admin without a fresh step-up (real freshStepUpRefusal).
  {
    const h = harness();
    const res = await handleAuthorityAppRegistration(makeReq(goodBody, { elevation: null }), h.deps);
    const body = await read(res);
    ok("admin without elevation → 403 ADMIN_MFA_REQUIRED", res.status === 403 && body.code === "ADMIN_MFA_REQUIRED");
    ok("no elevation: service never runs, refusal audited", h.calls.length === 0 && h.audits.length === 1 && (h.audits[0]!.metadata as { outcome: string }).outcome === "STEP_UP_REQUIRED");
  }
  {
    const h = harness();
    const stale = issueAdminElevation(ADMIN_ID, Date.now() - 6 * 60 * 1000);
    const res = await handleAuthorityAppRegistration(makeReq(goodBody, { elevation: stale }), h.deps);
    ok("admin with a 6-minute-old elevation → 403", res.status === 403 && h.calls.length === 0);
  }
  {
    const h = harness();
    const other = issueAdminElevation(99);
    const res = await handleAuthorityAppRegistration(makeReq(goodBody, { elevation: other }), h.deps);
    ok("another admin's elevation → 403", res.status === 403 && h.calls.length === 0);
  }
  {
    const h = harness({ flag: undefined });
    const res = await handleAuthorityAppRegistration(makeReq(goodBody, { elevation: null }), h.deps);
    ok("switch OFF + no step-up → 403 first (step-up precedes switch)", res.status === 403);
  }

  // 4. switch: exactly "true", 503 after auth.
  for (const value of [undefined, "", "TRUE", "1", " true", "true ", "yes"]) {
    const h = harness({ flag: value });
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    const body = await read(res);
    ok(`switch ${JSON.stringify(value)} → 503 FEATURE_DISABLED`, res.status === 503 && body.code === "FEATURE_DISABLED");
    ok(`switch ${JSON.stringify(value)}: service never runs`, h.calls.length === 0);
  }

  // 5. request shape.
  const shapeCases: Array<[string, NextRequest, number, string]> = [
    ["non-JSON content type", makeReq(goodBody, { contentType: "text/plain" }), 415, "UNSUPPORTED_CONTENT_TYPE"],
    ["missing content type", makeReq(goodBody, { contentType: null }), 415, "UNSUPPORTED_CONTENT_TYPE"],
    ["oversize body", makeReq({ ...goodBody, clientSecret: "x".repeat(5000) }), 413, "BODY_TOO_LARGE"],
    ["invalid JSON", makeReq(null, { raw: "{not json" }), 400, "INVALID_JSON"],
    ["JSON array", makeReq([goodBody]), 400, "INVALID_JSON"],
    ["unknown field", makeReq({ ...goodBody, environment: "SANDBOX" }), 400, "UNKNOWN_FIELD"],
    ["non-string secret", makeReq({ ...goodBody, clientSecret: 12345 }), 400, "INVALID_FIELD_TYPE"],
    ["missing client id", makeReq({ ...goodBody, itaClientId: undefined }), 400, "INVALID_FIELD_TYPE"],
    ["apply without confirmation", makeReq({ ...goodBody, mode: "apply" }), 400, "CONFIRMATION_REQUIRED"],
    ["apply with wrong confirmation", makeReq({ ...goodBody, mode: "apply", confirmation: "register" }), 400, "CONFIRMATION_REQUIRED"],
  ];
  for (const [name, req, status, code] of shapeCases) {
    const h = harness();
    const res = await handleAuthorityAppRegistration(req, h.deps);
    const body = await read(res);
    ok(`${name} → ${status} ${code}`, res.status === status && body.code === code);
    ok(`${name}: service never runs, refusal audited`, h.calls.length === 0 && h.audits.length === 1 && (h.audits[0]!.metadata as { outcome: string }).outcome === code);
  }

  // 6. success paths.
  {
    const h = harness();
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    const body = await read(res);
    ok("dry-run → 200 with masked summary", res.status === 200 && body.mode === "dry-run" && body.itaClientId === "***5566" && body.created === false);
    ok("response is no-store", (res.headers.get("cache-control") ?? "").includes("no-store"));
    ok("service received the exact secret (untrimmed) and mode", h.calls.length === 1 && h.calls[0]!.clientSecret === SECRET && h.calls[0]!.mode === "dry-run");
    const a = h.audits[0]!;
    ok("dry-run audited with the registration action", h.audits.length === 1 && a.action === "PLATFORM_AUTHORITY_PRODUCTION_APP_REGISTRATION" && a.actorUserId === ADMIN_ID);
    const meta = a.metadata as Record<string, unknown>;
    ok("dry-run audit metadata: mode, outcome, masked ids only",
      meta.mode === "dry-run" && meta.outcome === "DRY_RUN_OK" && meta.itaClientId === "***5566" && meta.accountingSoftwareNumber === "***0901" && meta.environment === "PRODUCTION");
  }
  {
    const h = harness();
    const res = await handleAuthorityAppRegistration(makeReq({ ...goodBody, mode: "apply", confirmation: "REGISTER" }), h.deps);
    const body = await read(res);
    ok("apply with confirmation → 201 created", res.status === 201 && body.created === true);
    ok("apply audited CREATED", (h.audits[0]!.metadata as { outcome: string }).outcome === "CREATED");
    ok("confirmation is not passed to the service", !("confirmation" in h.calls[0]!));
  }
  {
    const h = harness({ result: { ok: false, code: "APP_ALREADY_REGISTERED" } });
    const res = await handleAuthorityAppRegistration(makeReq({ ...goodBody, mode: "apply", confirmation: "REGISTER" }), h.deps);
    const body = await read(res);
    ok("already registered → 409 APP_ALREADY_REGISTERED", res.status === 409 && body.code === "APP_ALREADY_REGISTERED");
    ok("already registered audited with mode apply", (h.audits[0]!.metadata as { mode: string; outcome: string }).outcome === "APP_ALREADY_REGISTERED" && (h.audits[0]!.metadata as { mode: string }).mode === "apply");
  }
  {
    const h = harness({ result: { ok: false, code: "ENCRYPTION_KEY_UNAVAILABLE" } });
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    ok("key unavailable → 503", res.status === 503);
  }
  {
    const h = harness();
    h.deps!.register = async () => {
      throw new Error(`exploded ${SECRET}`);
    };
    const res = await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    const body = await read(res);
    ok("service throw → 500 SERVER_ERROR (no detail)", res.status === 500 && body.code === "SERVER_ERROR");
  }

  // 6b. attemptId: one id links a step-up refusal and the retried result.
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  {
    const ATTEMPT = "3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c";
    const body = { ...goodBody, attemptId: ATTEMPT };
    const h1 = harness();
    const r1 = await handleAuthorityAppRegistration(makeReq(body, { elevation: null }), h1.deps);
    const h2 = harness();
    const r2 = await handleAuthorityAppRegistration(makeReq(body), h2.deps);
    ok("same attemptId: first refused for step-up (403), retry succeeds (200)", r1.status === 403 && r2.status === 200);
    const m1 = h1.audits[0]?.metadata as Record<string, unknown> | undefined;
    const m2 = h2.audits[0]?.metadata as Record<string, unknown> | undefined;
    ok("same attemptId: two audit rows", h1.audits.length === 1 && h2.audits.length === 1);
    ok("same attemptId: both rows carry the client's attemptId", m1?.attemptId === ATTEMPT && m2?.attemptId === ATTEMPT);
    ok("same attemptId: outcomes differ (STEP_UP_REQUIRED, DRY_RUN_OK)", m1?.outcome === "STEP_UP_REQUIRED" && m2?.outcome === "DRY_RUN_OK");
    ok("same attemptId: service ran only on the retry", h1.calls.length === 0 && h2.calls.length === 1);
    ok("attemptId is not passed to the service", !("attemptId" in h2.calls[0]!));
  }
  for (const bad of [
    "not-a-uuid",
    "3F2B8C1E-9A4D-4E6F-B1C2-7D8E9F0A1B2C",
    "3f2b8c1e-9a4d-1e6f-b1c2-7d8e9f0a1b2c",
    "3f2b8c1e-9a4d-4e6f-c1c2-7d8e9f0a1b2c",
    "",
    12345,
    null,
  ]) {
    const h = harness();
    const res = await handleAuthorityAppRegistration(makeReq({ ...goodBody, attemptId: bad }), h.deps);
    const body = await read(res);
    const meta = h.audits[0]?.metadata as Record<string, unknown> | undefined;
    ok(`invalid attemptId ${JSON.stringify(bad)} → 400 INVALID_ATTEMPT_ID, service never runs`,
      res.status === 400 && body.code === "INVALID_ATTEMPT_ID" && h.calls.length === 0);
    ok(`invalid attemptId ${JSON.stringify(bad)}: one audit row with a server-generated id, not the bad value`,
      h.audits.length === 1 && typeof meta?.attemptId === "string" && meta.attemptId !== bad && UUID_V4.test(meta.attemptId));
  }
  {
    const h = harness();
    await handleAuthorityAppRegistration(makeReq(goodBody), h.deps);
    const meta = h.audits[0]!.metadata as Record<string, unknown>;
    ok("absent attemptId: the audit row gets a server-generated UUID v4",
      typeof meta.attemptId === "string" && UUID_V4.test(meta.attemptId));
  }
  {
    const h = harness({ flag: undefined });
    const ATTEMPT = "11111111-2222-4333-8444-555555555555";
    await handleAuthorityAppRegistration(makeReq({ ...goodBody, attemptId: ATTEMPT }), h.deps);
    ok("switch-off refusal also carries the attemptId", (h.audits[0]!.metadata as Record<string, unknown>).attemptId === ATTEMPT);
  }
  ok("EVERY audit row in this suite carries an attemptId",
    allAudits.length > 0 && allAudits.every((a) => typeof (a.metadata as Record<string, unknown>)?.attemptId === "string"));
  auditDumpExtra.push(JSON.stringify(allAudits.map((x) => ({ ...x, req: undefined }))));

  // 7. no leaks: responses, audit metadata, logs.
  const auditDump: string[] = [];
  {
    // Representative success / apply / refusal runs; capture their audit payloads.
    for (const body of [goodBody, { ...goodBody, mode: "apply", confirmation: "REGISTER" }, { ...goodBody, environment: "X" }]) {
      const h = harness();
      await read(await handleAuthorityAppRegistration(makeReq(body), h.deps));
      auditDump.push(JSON.stringify(h.audits.map((x) => ({ ...x, req: undefined }))));
    }
  }
  const everything =
    responses.join("\n") + auditDump.join("\n") + auditDumpExtra.join("\n") + logged.join("\n");
  ok("secret never appears in responses, audit metadata or logs", !everything.includes(SECRET));
  ok("full client id never appears in responses, audit metadata or logs", !everything.includes(CLIENT_ID));

  console.error = origError;
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

void main().catch((e) => {
  console.error = origError;
  console.error(e);
  process.exit(1);
});
