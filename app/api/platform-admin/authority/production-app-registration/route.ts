/**
 * TEMPORARY Platform-Admin tool: register the ITA PRODUCTION BillingAuthorityApp.
 *
 * Path: POST /api/platform-admin/authority/production-app-registration
 *
 * The client secret is encrypted INSIDE this runtime with the
 * BILLING_AUTHORITY_ENCRYPTION_KEY already present in its environment, so the
 * key is never extracted, printed or replaced. The owner types the client id /
 * secret into /admin/authority-app-registration; the secret travels once over
 * HTTPS in this POST body and is never stored by the browser or echoed back.
 *
 * CLOSED BY DEFAULT: answers 503 unless BILLING_AUTHORITY_APP_REGISTRATION_ENABLED
 * is exactly "true" — checked only AFTER the admin guard, so an outsider cannot
 * learn the switch's state.
 *
 * Guard order (each step refuses before the next runs):
 *   1. requirePlatformAdminOrResponse — Bearer + PLATFORM_ADMIN + allowlist (+ MFA)
 *   2. freshStepUpRefusal             — an elevation minted in the last 5 minutes
 *   3. the switch                     — 503 FEATURE_DISABLED
 *   4. request shape                  — JSON content type, ≤ 4 KB, known fields only,
 *                                       apply needs confirmation "REGISTER"
 *   5. registerProductionAuthorityApp — PRODUCTION only, create-only, key check
 * Every outcome from step 2 on is written to the platform audit log with the
 * mode, an outcome code, masked ids and the submission's attemptId (optional
 * body field, strict lowercase UUID v4, else 400 INVALID_ATTEMPT_ID; generated
 * server-side when absent). The body is read and size-bounded right after step 1
 * only so a step-up refusal can carry the same attemptId as the retried request.
 *
 * REMOVAL (follow-up PR, right after the PRODUCTION row exists):
 *   delete app/api/platform-admin/authority/production-app-registration/route.ts
 *   delete app/api/platform-admin/authority/production-app-registration/route.test.ts
 *   delete lib/services/billing/authority/billing-authority-production-app-registration.service.ts
 *   delete lib/services/billing/authority/billing-authority-production-app-registration.verify.test.ts
 *   delete app/(platform-admin)/admin/authority-app-registration/page.tsx
 *   delete components/platform-admin/authority-app-registration-form.tsx
 *   delete postPlatformAdminAuthorityAppRegistration from lib/platform-admin/fetch-platform-admin.ts
 *   delete scripts/ci/test-coverage/ita-production-app-registration.json
 *   delete the Vercel env var BILLING_AUTHORITY_APP_REGISTRATION_ENABLED
 *   add a static guard so this path / service name can never return.
 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  freshStepUpRefusal,
  requirePlatformAdminOrResponse,
  type PlatformAdminUser,
} from "@/lib/auth/platform-admin";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import {
  logPlatformAuditEvent,
  type LogPlatformAuditEventInput,
} from "@/lib/services/platform-admin/platform-audit.service";
import {
  registerProductionAuthorityApp,
  type AuthorityAppRegistrationCode,
  type AuthorityAppRegistrationInput,
  type AuthorityAppRegistrationResult,
} from "@/lib/services/billing/authority/billing-authority-production-app-registration.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const AUTHORITY_APP_REGISTRATION_ENV_VAR = "BILLING_AUTHORITY_APP_REGISTRATION_ENABLED";
export const AUTHORITY_APP_REGISTRATION_MAX_BODY_BYTES = 4096;
export const AUTHORITY_APP_REGISTRATION_CONFIRMATION = "REGISTER";

const ALLOWED_FIELDS = new Set([
  "mode",
  "itaClientId",
  "clientSecret",
  "accountingSoftwareNumber",
  "portalApplicationId",
  "confirmation",
  "attemptId",
]);

const NO_STORE = { "Cache-Control": "no-store" };

/** Route-level refusal codes (the service has its own). */
export const AUTHORITY_APP_REGISTRATION_ROUTE_CODES = {
  STEP_UP_REQUIRED: "STEP_UP_REQUIRED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  UNSUPPORTED_CONTENT_TYPE: "UNSUPPORTED_CONTENT_TYPE",
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
  INVALID_JSON: "INVALID_JSON",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  INVALID_FIELD_TYPE: "INVALID_FIELD_TYPE",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  INVALID_ATTEMPT_ID: "INVALID_ATTEMPT_ID",
  SERVER_ERROR: "SERVER_ERROR",
} as const;

type RouteCode =
  (typeof AUTHORITY_APP_REGISTRATION_ROUTE_CODES)[keyof typeof AUTHORITY_APP_REGISTRATION_ROUTE_CODES];

export function isAuthorityAppRegistrationEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  // Exactly "true" — not "TRUE", "1" or " true".
  return env[AUTHORITY_APP_REGISTRATION_ENV_VAR] === "true";
}

const SERVICE_STATUS: Record<AuthorityAppRegistrationCode, number> = {
  INVALID_CLIENT_ID: 400,
  INVALID_CLIENT_SECRET: 400,
  CLIENT_SECRET_SURROUNDING_WHITESPACE: 400,
  INVALID_ACCOUNTING_SOFTWARE_NUMBER: 400,
  INVALID_PORTAL_APPLICATION_ID: 400,
  INVALID_MODE: 400,
  ENCRYPTION_KEY_UNAVAILABLE: 503,
  KEY_CHECK_FAILED: 500,
  APP_ALREADY_REGISTERED: 409,
  READ_FAILED: 500,
  WRITE_FAILED: 500,
};

export type AuthorityAppRegistrationHandlerDeps = {
  authorize?: (req: Request) => Promise<PlatformAdminUser | NextResponse>;
  freshStepUp?: (req: Request, userId: number) => NextResponse | null;
  env?: Record<string, string | undefined>;
  register?: (input: AuthorityAppRegistrationInput) => Promise<AuthorityAppRegistrationResult>;
  audit?: (input: LogPlatformAuditEventInput) => Promise<void>;
};

type AuditMeta = {
  mode: "dry-run" | "apply" | null;
  outcome: string;
  itaClientId?: string;
  accountingSoftwareNumber?: string;
  portalApplicationId?: string | null;
  created?: boolean;
};

function auditMode(mode: unknown): AuditMeta["mode"] {
  return mode === "dry-run" || mode === "apply" ? mode : null;
}

function refusal(status: number, code: RouteCode | AuthorityAppRegistrationCode): NextResponse {
  return NextResponse.json({ error: code, code }, { status, headers: NO_STORE });
}

/** Strict lowercase UUID v4 — the shape crypto.randomUUID() produces. */
const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidAttemptId(value: unknown): value is string {
  return typeof value === "string" && ATTEMPT_ID_RE.test(value);
}

type RawBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: RouteCode };

/**
 * Reads and bounds the body ONCE, right after the admin guard, so the attempt id
 * is known for every audited outcome (including a step-up refusal). Nothing in it
 * is acted on before the step-up and the switch have passed.
 */
async function readRawBody(req: Request): Promise<RawBody> {
  const R = AUTHORITY_APP_REGISTRATION_ROUTE_CODES;
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.split(";")[0]!.trim() !== "application/json") {
    return { ok: false, status: 415, code: R.UNSUPPORTED_CONTENT_TYPE };
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > AUTHORITY_APP_REGISTRATION_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: R.BODY_TOO_LARGE };
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > AUTHORITY_APP_REGISTRATION_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: R.BODY_TOO_LARGE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, code: R.INVALID_JSON };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: R.INVALID_JSON };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

type ParsedBody =
  | { ok: true; input: AuthorityAppRegistrationInput; confirmation: string | null }
  | { ok: false; status: number; code: RouteCode; mode: AuditMeta["mode"] };

function validateBody(body: Record<string, unknown>): ParsedBody {
  const R = AUTHORITY_APP_REGISTRATION_ROUTE_CODES;
  const mode = auditMode(body.mode);

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      // Never echo the offending key — it could be anything the caller typed.
      return { ok: false, status: 400, code: R.UNKNOWN_FIELD, mode };
    }
  }

  if (body.attemptId !== undefined && !isValidAttemptId(body.attemptId)) {
    return { ok: false, status: 400, code: R.INVALID_ATTEMPT_ID, mode };
  }

  const stringOrAbsent = (v: unknown) => v === undefined || v === null || typeof v === "string";
  if (
    typeof body.mode !== "string" ||
    typeof body.itaClientId !== "string" ||
    typeof body.clientSecret !== "string" ||
    typeof body.accountingSoftwareNumber !== "string" ||
    !stringOrAbsent(body.portalApplicationId) ||
    !stringOrAbsent(body.confirmation)
  ) {
    return { ok: false, status: 400, code: R.INVALID_FIELD_TYPE, mode };
  }

  return {
    ok: true,
    input: {
      mode: body.mode as AuthorityAppRegistrationInput["mode"],
      itaClientId: body.itaClientId,
      clientSecret: body.clientSecret,
      accountingSoftwareNumber: body.accountingSoftwareNumber,
      portalApplicationId: (body.portalApplicationId as string | null | undefined) ?? null,
    },
    confirmation: (body.confirmation as string | null | undefined) ?? null,
  };
}

/**
 * Testable handler. Non-admins never reach the switch, the body or the service;
 * the secret is read from the body, handed to the service, and goes nowhere else.
 */
export async function handleAuthorityAppRegistration(
  req: NextRequest,
  deps: AuthorityAppRegistrationHandlerDeps = {}
): Promise<NextResponse> {
  const R = AUTHORITY_APP_REGISTRATION_ROUTE_CODES;
  const authorize = deps.authorize ?? requirePlatformAdminOrResponse;
  const freshStepUp = deps.freshStepUp ?? ((r: Request, id: number) => freshStepUpRefusal(r, id));
  const env = deps.env ?? process.env;
  const register = deps.register ?? ((input) => registerProductionAuthorityApp(input));
  const audit = deps.audit ?? ((input) => logPlatformAuditEvent(input));

  let admin: PlatformAdminUser;
  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) return auth; // 401 / 403 — nothing else runs
    admin = auth;
  } catch (error) {
    console.error(
      "AUTHORITY_APP_REGISTRATION_AUTH_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return refusal(500, R.SERVER_ERROR);
  }

  // One id per user submission: the form sends it, and the client's automatic
  // re-send after a step-up carries the identical body, so a step-up refusal and
  // the eventual result share it. A missing or malformed id gets a server one so
  // every audit row still has an id (a malformed one is then refused below).
  let attemptId: string = randomUUID();

  const record = async (meta: AuditMeta) => {
    try {
      await audit({
        actorUserId: admin.id,
        action: PLATFORM_AUDIT_ACTIONS.AUTHORITY_PRODUCTION_APP_REGISTRATION,
        targetType: "BILLING_AUTHORITY_APP",
        targetId: "PRODUCTION",
        metadata: { environment: "PRODUCTION", attemptId, ...meta },
        req,
      });
    } catch {
      // Best-effort, like logPlatformAuditEvent itself.
    }
  };

  try {
    const raw = await readRawBody(req);
    if (raw.ok && isValidAttemptId(raw.body.attemptId)) {
      attemptId = raw.body.attemptId;
    }

    const stale = freshStepUp(req, admin.id);
    if (stale) {
      await record({ mode: null, outcome: R.STEP_UP_REQUIRED });
      return stale;
    }

    if (!isAuthorityAppRegistrationEnabled(env)) {
      await record({ mode: null, outcome: R.FEATURE_DISABLED });
      return refusal(503, R.FEATURE_DISABLED);
    }

    if (!raw.ok) {
      await record({ mode: null, outcome: raw.code });
      return refusal(raw.status, raw.code);
    }

    const parsed = validateBody(raw.body);
    if (!parsed.ok) {
      await record({ mode: parsed.mode, outcome: parsed.code });
      return refusal(parsed.status, parsed.code);
    }

    if (
      parsed.input.mode === "apply" &&
      parsed.confirmation !== AUTHORITY_APP_REGISTRATION_CONFIRMATION
    ) {
      await record({ mode: "apply", outcome: R.CONFIRMATION_REQUIRED });
      return refusal(400, R.CONFIRMATION_REQUIRED);
    }

    const result = await register(parsed.input);
    if (!result.ok) {
      await record({
        mode: auditMode(parsed.input.mode),
        outcome: result.code,
      });
      return refusal(SERVICE_STATUS[result.code] ?? 500, result.code);
    }

    const s = result.summary;
    await record({
      mode: s.mode,
      outcome: s.created ? "CREATED" : "DRY_RUN_OK",
      itaClientId: s.itaClientId,
      accountingSoftwareNumber: s.accountingSoftwareNumber,
      portalApplicationId: s.portalApplicationId,
      created: s.created,
    });
    return NextResponse.json(s, { status: s.created ? 201 : 200, headers: NO_STORE });
  } catch (error) {
    // Name only — a message could carry request values.
    console.error(
      "AUTHORITY_APP_REGISTRATION_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    await record({ mode: null, outcome: R.SERVER_ERROR });
    return refusal(500, R.SERVER_ERROR);
  }
}

export async function POST(req: NextRequest) {
  return handleAuthorityAppRegistration(req);
}

