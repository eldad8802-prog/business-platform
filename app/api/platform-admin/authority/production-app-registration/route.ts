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
 * mode, an outcome code and masked ids only.
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

type ParsedBody =
  | { ok: true; input: AuthorityAppRegistrationInput; confirmation: string | null }
  | { ok: false; status: number; code: RouteCode; mode: AuditMeta["mode"] };

async function parseBody(req: Request): Promise<ParsedBody> {
  const R = AUTHORITY_APP_REGISTRATION_ROUTE_CODES;
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.split(";")[0]!.trim() !== "application/json") {
    return { ok: false, status: 415, code: R.UNSUPPORTED_CONTENT_TYPE, mode: null };
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > AUTHORITY_APP_REGISTRATION_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: R.BODY_TOO_LARGE, mode: null };
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > AUTHORITY_APP_REGISTRATION_MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: R.BODY_TOO_LARGE, mode: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, code: R.INVALID_JSON, mode: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: R.INVALID_JSON, mode: null };
  }
  const body = parsed as Record<string, unknown>;
  const mode = body.mode === "dry-run" || body.mode === "apply" ? body.mode : null;

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      // Never echo the offending key — it could be anything the caller typed.
      return { ok: false, status: 400, code: R.UNKNOWN_FIELD, mode };
    }
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

  const record = async (meta: AuditMeta) => {
    try {
      await audit({
        actorUserId: admin.id,
        action: PLATFORM_AUDIT_ACTIONS.AUTHORITY_PRODUCTION_APP_REGISTRATION,
        targetType: "BILLING_AUTHORITY_APP",
        targetId: "PRODUCTION",
        metadata: { environment: "PRODUCTION", ...meta },
        req,
      });
    } catch {
      // Best-effort, like logPlatformAuditEvent itself.
    }
  };

  try {
    const stale = freshStepUp(req, admin.id);
    if (stale) {
      await record({ mode: null, outcome: R.STEP_UP_REQUIRED });
      return stale;
    }

    if (!isAuthorityAppRegistrationEnabled(env)) {
      await record({ mode: null, outcome: R.FEATURE_DISABLED });
      return refusal(503, R.FEATURE_DISABLED);
    }

    const parsed = await parseBody(req);
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

