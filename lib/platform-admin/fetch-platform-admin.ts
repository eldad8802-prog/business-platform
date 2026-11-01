/**
 * Browser client for the Platform Admin API.
 *
 * Every privileged call goes through ONE request core (`adminRequest`) so that
 * authentication, MFA elevation and the step-up retry are impossible to forget
 * on a new endpoint. Before this, three separate fetch implementations lived
 * here (GET, PATCH, probe POST) and none of them carried an elevation header —
 * which meant enabling `PLATFORM_ADMIN_MFA_REQUIRED` would have made the whole
 * console unusable with no way to answer the challenge from the browser.
 *
 * Contract with the server (lib/auth/platform-admin.ts):
 *   - identity comes from the Bearer token;
 *   - a privileged route answers 403 + `code: ADMIN_MFA_REQUIRED` when a valid
 *     elevation is missing or expired;
 *   - `x-admin-elevation` carries the elevation, bound to this admin's user id.
 *
 * The step-up is attempted AT MOST ONCE per request: a second 403 is surfaced
 * to the caller rather than retried, so a persistently refusing server can
 * never produce a prompt loop.
 */
import type {
  PlatformAdminAttentionResponse,
  PlatformAdminBusinessFilter,
  PlatformAdminBusinessesResponse,
  PlatformAdminHomeResponse,
  PlatformAdminOverviewResponse,
  PlatformAdminSessionResponse,
} from "@/lib/services/platform-admin/types";
import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import type { PlatformAdminBusinessDetailResponse } from "@/lib/services/platform-admin/platform-business-detail.types";
import type { PlatformAdminAuditResponse } from "@/lib/services/platform-admin/platform-audit-list.types";
import type { AccountantOpsResponse } from "@/lib/services/platform-admin/accountant-ops.service";
import type {
  BusinessFeatureOverrideState,
  PlatformAdminBusinessFeaturesResponse,
  UpdateBusinessFeatureAccessResponse,
} from "@/lib/services/feature-access/feature-access.types";
import {
  ADMIN_ELEVATION_HEADER,
  ADMIN_MFA_REQUIRED_CODE,
  clearAdminElevation,
  getAdminElevation,
  getAdminStepUpHandler,
  setAdminElevation,
} from "./admin-elevation";

export class PlatformAdminFetchError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "PlatformAdminFetchError";
    this.status = status;
    this.code = code;
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem("token");
}

type AdminRequestInit = {
  method?: string;
  /** Already-serialised JSON body. */
  body?: string;
};

async function readError(res: Response): Promise<{ message: string; code?: string }> {
  let message = res.status === 401 ? "Unauthorized" : "Request failed";
  let code: string | undefined;
  try {
    const payload = (await res.json()) as { error?: string; code?: string };
    if (payload.error) {
      message = payload.error;
    }
    code = payload.code;
  } catch {
    // ignore parse errors
  }
  return { message, code };
}

/**
 * The single privileged-request path. Returns the parsed body together with the
 * HTTP status, because one caller (the token probe) reports the status itself.
 */
async function adminRequest<T>(
  path: string,
  init: AdminRequestInit = {}
): Promise<{ status: number; data: T }> {
  const token = getToken();
  if (!token) {
    throw new PlatformAdminFetchError("Unauthorized", 401);
  }

  // Guards the ONLY `continue` below, so this loop runs at most twice.
  let stepUpAttempted = false;

  for (;;) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const elevation = getAdminElevation();
    if (elevation) {
      headers[ADMIN_ELEVATION_HEADER] = elevation;
    }

    const res = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      cache: "no-store",
    });

    if (res.ok) {
      return { status: res.status, data: (await res.json()) as T };
    }

    const { message, code } = await readError(res);

    const needsStepUp = res.status === 403 && code === ADMIN_MFA_REQUIRED_CODE;
    if (needsStepUp && !stepUpAttempted) {
      stepUpAttempted = true;
      // Whatever we sent was refused; never retry with it.
      clearAdminElevation();

      const handler = getAdminStepUpHandler();
      if (!handler) {
        // No UI mounted to answer the challenge — surface it rather than hang.
        throw new PlatformAdminFetchError(message, res.status, code);
      }

      const fresh = await handler();
      if (!fresh) {
        // Cancelled, or verification failed. The privileged call is NOT retried.
        throw new PlatformAdminFetchError(
          "Multi-factor verification required",
          403,
          code
        );
      }
      continue;
    }

    if (needsStepUp) {
      // Still refused after a successful verification — do not prompt again.
      clearAdminElevation();
    }

    throw new PlatformAdminFetchError(message, res.status, code);
  }
}

export async function platformAdminFetch<T>(path: string): Promise<T> {
  const { data } = await adminRequest<T>(path);
  return data;
}

export function fetchPlatformAdminSession() {
  return platformAdminFetch<PlatformAdminSessionResponse>(
    "/api/platform-admin/session"
  );
}

export function fetchPlatformAdminOverview() {
  return platformAdminFetch<PlatformAdminOverviewResponse>(
    "/api/platform-admin/overview"
  );
}

export function fetchPlatformAdminAttention() {
  return platformAdminFetch<PlatformAdminAttentionResponse>(
    "/api/platform-admin/attention"
  );
}

export function fetchPlatformAdminAccountantOps() {
  return platformAdminFetch<AccountantOpsResponse>("/api/platform-admin/accountant-ops");
}

export function fetchPlatformAdminUsageOverview() {
  return platformAdminFetch<PlatformUsageOverviewResponse>(
    "/api/platform-admin/usage/overview"
  );
}

export function fetchPlatformAdminBusinessDetail(businessId: number) {
  return platformAdminFetch<PlatformAdminBusinessDetailResponse>(
    `/api/platform-admin/businesses/${businessId}`
  );
}

export function fetchPlatformAdminBusinessFeatures(businessId: number) {
  return platformAdminFetch<PlatformAdminBusinessFeaturesResponse>(
    `/api/platform-admin/businesses/${businessId}/features`
  );
}

export async function patchPlatformAdminBusinessFeature(
  businessId: number,
  featureKey: string,
  body: { state: BusinessFeatureOverrideState; reason: string }
): Promise<UpdateBusinessFeatureAccessResponse> {
  const { data } = await adminRequest<UpdateBusinessFeatureAccessResponse>(
    `/api/platform-admin/businesses/${businessId}/features/${featureKey}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
  return data;
}

export type PlatformAdminAuditKind = "all" | "changes" | "views" | "security";

export function fetchPlatformAdminAudit(
  page: number,
  limit = 30,
  filters: { kind?: PlatformAdminAuditKind; businessId?: number } = {}
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (filters.kind && filters.kind !== "all") params.set("kind", filters.kind);
  if (filters.businessId) params.set("businessId", String(filters.businessId));
  return platformAdminFetch<PlatformAdminAuditResponse>(
    `/api/platform-admin/audit?${params.toString()}`
  );
}

export function fetchPlatformAdminHome() {
  return platformAdminFetch<PlatformAdminHomeResponse>("/api/platform-admin/home");
}

export function fetchPlatformAdminBusinesses(input: {
  page: number;
  limit?: number;
  q?: string;
  filter?: PlatformAdminBusinessFilter;
}) {
  const params = new URLSearchParams({
    page: String(input.page),
    limit: String(input.limit ?? 20),
    sort: "createdAt",
    order: "desc",
  });
  const q = input.q?.trim();
  if (q) params.set("q", q);
  if (input.filter && input.filter !== "all") params.set("filter", input.filter);
  return platformAdminFetch<PlatformAdminBusinessesResponse>(
    `/api/platform-admin/businesses?${params.toString()}`
  );
}

/* ------------------------------------------------------------------------- *
 * Admin security: authenticator app (TOTP) and passkeys.
 * Enroll / confirm and the passkey assertion are identity-only on the server;
 * everything else needs a live elevation and goes through the same core.
 * ------------------------------------------------------------------------- */

export async function startAdminMfaEnrollment(): Promise<{ otpauthUri: string }> {
  const { data } = await adminRequest<{ otpauthUri: string }>("/api/platform-admin/mfa/enroll", {
    method: "POST",
  });
  return data;
}

export async function confirmAdminMfaEnrollment(code: string): Promise<{ recoveryCodes: string[] }> {
  const { data } = await adminRequest<{
    recoveryCodes: string[];
    elevation: string;
    elevationExpiresInSeconds: number;
  }>("/api/platform-admin/mfa/confirm", { method: "POST", body: JSON.stringify({ code }) });
  // Confirming proves the factor: keep the elevation the server handed back.
  setAdminElevation(data.elevation, data.elevationExpiresInSeconds);
  return { recoveryCodes: data.recoveryCodes };
}

/**
 * Replace the authenticator app atomically: begin returns the new QR and a
 * sealed envelope; the old app keeps working until confirm proves a code from
 * the new one. Both calls need a step-up from the last few minutes (the core
 * prompts for one automatically).
 */
export async function beginAdminMfaReplacement(): Promise<{ otpauthUri: string; replacementToken: string }> {
  const { data } = await adminRequest<{ otpauthUri: string; replacementToken: string }>(
    "/api/platform-admin/mfa/replace/begin",
    { method: "POST" }
  );
  return data;
}

export async function confirmAdminMfaReplacement(
  replacementToken: string,
  code: string
): Promise<{ recoveryCodes: string[] }> {
  const { data } = await adminRequest<{ recoveryCodes: string[] }>("/api/platform-admin/mfa/replace/confirm", {
    method: "POST",
    body: JSON.stringify({ replacementToken, code }),
  });
  return { recoveryCodes: data.recoveryCodes };
}

export type AdminPasskeyItem = {
  id: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
};

export function fetchAdminPasskeys() {
  return platformAdminFetch<{ available: boolean; reason?: string; passkeys: AdminPasskeyItem[] }>(
    "/api/platform-admin/passkeys"
  );
}

/** Options → the browser ceremony (Face ID / fingerprint) → verify. */
export async function registerAdminPasskey(label: string): Promise<AdminPasskeyItem> {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const { data: begin } = await adminRequest<{
    options: Parameters<typeof startRegistration>[0]["optionsJSON"];
    challengeToken: string;
  }>("/api/platform-admin/passkeys/register/options", { method: "POST" });
  const response = await startRegistration({ optionsJSON: begin.options });
  const { data } = await adminRequest<{ passkey: AdminPasskeyItem }>(
    "/api/platform-admin/passkeys/register/verify",
    { method: "POST", body: JSON.stringify({ challengeToken: begin.challengeToken, response, label }) }
  );
  return data.passkey;
}

export async function revokeAdminPasskey(id: number): Promise<void> {
  await adminRequest<{ revoked: boolean }>(`/api/platform-admin/passkeys/${id}/revoke`, {
    method: "POST",
  });
}

/**
 * Learning Center overview — a platform-admin surface that lives outside the
 * `(platform-admin)` route group. It used a bare `fetch()` that sent no
 * Authorization header at all, so it could only ever have received 401. Routing
 * it through the shared core fixes that and gives it step-up coverage.
 */
export function fetchLearningCenterOverview<T>(windowKey: string) {
  const params = new URLSearchParams({ window: windowKey });
  return platformAdminFetch<T>(`/api/dev/learning-center?${params.toString()}`);
}

/* ------------------------------------------------------------------------- *
 * TEMPORARY — Tax Authority token-endpoint network probe invoker.
 * Remove together with the probe route, service, and their tests:
 *   - app/api/platform-admin/diagnostics/tax-authority-token-probe/route.ts
 *   - lib/services/billing/authority/billing-authority-token-probe.service.ts
 *   - components/platform-admin/tax-authority-probe-*
 * Reuses the canonical request core — no new auth. The raw body is returned as
 * `unknown` and validated by the UI logic layer (no blind cast).
 * ------------------------------------------------------------------------- */

export type TokenProbeInvocation = {
  routeHttpStatus: number;
  /** Raw JSON body — validated field-by-field by the caller, never trusted. */
  result: unknown;
};

export async function postPlatformAdminTokenProbe(): Promise<TokenProbeInvocation> {
  const { status, data } = await adminRequest<unknown>(
    "/api/platform-admin/diagnostics/tax-authority-token-probe",
    { method: "POST" }
  );
  return { routeHttpStatus: status, result: data };
}

/** TEMPORARY — website-form live proof (business 9). See lib/intake/acquisition/web-form-pilot.ts. */
export async function postWebFormPilotPass(publicId: string): Promise<{ url: string; expiresInSeconds: number }> {
  const { data } = await adminRequest<{ url: string; expiresInSeconds: number }>(
    "/api/platform-admin/web-form-pilot/pass",
    { method: "POST", body: JSON.stringify({ publicId }) }
  );
  return data;
}

/** Test seam — exercises the request core directly. Not used by the console. */
export const __testing = { adminRequest };
