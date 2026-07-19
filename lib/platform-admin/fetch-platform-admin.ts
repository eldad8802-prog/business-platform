import type {
  PlatformAdminAttentionResponse,
  PlatformAdminBusinessesResponse,
  PlatformAdminOverviewResponse,
  PlatformAdminSessionResponse,
} from "@/lib/services/platform-admin/types";
import type { PlatformUsageOverviewResponse } from "@/lib/services/platform-admin/platform-usage-overview.service";
import type { PlatformAdminBusinessDetailResponse } from "@/lib/services/platform-admin/platform-business-detail.types";
import type { PlatformAdminAuditResponse } from "@/lib/services/platform-admin/platform-audit-list.types";
import type {
  BusinessFeatureOverrideState,
  PlatformAdminBusinessFeaturesResponse,
  UpdateBusinessFeatureAccessResponse,
} from "@/lib/services/feature-access/feature-access.types";

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

export async function platformAdminFetch<T>(path: string): Promise<T> {
  const token = getToken();
  if (!token) {
    throw new PlatformAdminFetchError("Unauthorized", 401);
  }

  const res = await fetch(path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    let message = res.status === 401 ? "Unauthorized" : "Request failed";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore parse errors
    }
    throw new PlatformAdminFetchError(message, res.status);
  }

  return (await res.json()) as T;
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
  const token = getToken();
  if (!token) {
    throw new PlatformAdminFetchError("Unauthorized", 401);
  }

  const res = await fetch(
    `/api/platform-admin/businesses/${businessId}/features/${featureKey}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    }
  );

  if (!res.ok) {
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
    throw new PlatformAdminFetchError(message, res.status, code);
  }

  return (await res.json()) as UpdateBusinessFeatureAccessResponse;
}

export function fetchPlatformAdminAudit(page: number, limit = 30) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  return platformAdminFetch<PlatformAdminAuditResponse>(
    `/api/platform-admin/audit?${params.toString()}`
  );
}

export function fetchPlatformAdminBusinesses(page: number, limit = 20) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    sort: "createdAt",
    order: "desc",
  });
  return platformAdminFetch<PlatformAdminBusinessesResponse>(
    `/api/platform-admin/businesses?${params.toString()}`
  );
}

/* ------------------------------------------------------------------------- *
 * TEMPORARY — Tax Authority token-endpoint network probe invoker.
 * Remove together with the probe route, service, and their tests:
 *   - app/api/platform-admin/diagnostics/tax-authority-token-probe/route.ts
 *   - lib/services/billing/authority/billing-authority-token-probe.service.ts
 *   - components/platform-admin/tax-authority-probe-*
 * Reuses the canonical getToken()/Bearer/PlatformAdminFetchError mechanism —
 * no new auth. The raw body is returned as `unknown` and validated by the UI
 * logic layer (no blind cast).
 * ------------------------------------------------------------------------- */

export type TokenProbeInvocation = {
  routeHttpStatus: number;
  /** Raw JSON body — validated field-by-field by the caller, never trusted. */
  result: unknown;
};

export async function postPlatformAdminTokenProbe(): Promise<TokenProbeInvocation> {
  const token = getToken();
  if (!token) {
    throw new PlatformAdminFetchError("Unauthorized", 401);
  }

  const res = await fetch(
    "/api/platform-admin/diagnostics/tax-authority-token-probe",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    let message = res.status === 401 ? "Unauthorized" : "Request failed";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore parse errors
    }
    throw new PlatformAdminFetchError(message, res.status);
  }

  return { routeHttpStatus: res.status, result: await res.json() };
}
