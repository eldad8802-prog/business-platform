/**
 * Browser-side holder for the platform-admin MFA elevation (CASA 3.3.1).
 *
 * The server mints a short-lived, HMAC-signed elevation bound to the admin's
 * user id and refuses privileged work without it once enforcement is on. This
 * module is the client half: it holds that elevation, attaches nothing durable
 * to the machine, and lets the fetch layer ask the UI for a step-up when the
 * server says one is required.
 *
 * Storage decision — IN PROCESS MEMORY ONLY, deliberately:
 *   - not `localStorage`: the session bearer token already lives there because
 *     the app is a stateless-token architecture, but an elevation is a
 *     *second factor* proof. Persisting it would make the second factor
 *     survive tab closes and be readable by any script that can already read
 *     the first factor, which collapses the two factors into one store and
 *     defeats the control CASA is asking for.
 *   - not `sessionStorage`: same reachability, only a shorter lifetime.
 *   - module memory: dies with the page. A reload costs one six-digit code —
 *     the correct trade for a 15-minute privileged window.
 *
 * The expiry mirrors the server's `ADMIN_ELEVATION_TTL_SECONDS`; the client
 * never extends it and clamps anything longer. The server remains the only
 * authority — this is a cache, never a decision point.
 */

/** Must match `ADMIN_ELEVATION_HEADER` in lib/auth/platform-admin-elevation.ts. */
export const ADMIN_ELEVATION_HEADER = "x-admin-elevation";

/** Must match `ADMIN_MFA_REQUIRED_CODE` in lib/auth/platform-admin.ts. */
export const ADMIN_MFA_REQUIRED_CODE = "ADMIN_MFA_REQUIRED";

/** Mirrors the server's ADMIN_ELEVATION_TTL_SECONDS (15 minutes). */
export const ADMIN_ELEVATION_MAX_SECONDS = 15 * 60;

/**
 * Discard the elevation slightly before the server would, so a request is not
 * sent with a token that expires in flight.
 */
const EXPIRY_SAFETY_MARGIN_MS = 5_000;

type HeldElevation = { token: string; expiresAt: number };

let held: HeldElevation | null = null;

/** The live elevation, or null when absent or expired. Expiry self-clears. */
export function getAdminElevation(now: number = Date.now()): string | null {
  if (!held) return null;
  if (now >= held.expiresAt) {
    held = null;
    return null;
  }
  return held.token;
}

/**
 * Hold an elevation the server just issued. `expiresInSeconds` is clamped to
 * the server's own maximum: a longer client lifetime would only produce
 * requests the server rejects.
 */
export function setAdminElevation(
  token: string,
  expiresInSeconds: number,
  now: number = Date.now()
): void {
  if (typeof token !== "string" || token.length === 0) return;
  const seconds =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? Math.min(Math.floor(expiresInSeconds), ADMIN_ELEVATION_MAX_SECONDS)
      : ADMIN_ELEVATION_MAX_SECONDS;
  held = { token, expiresAt: now + seconds * 1000 - EXPIRY_SAFETY_MARGIN_MS };
}

/** Forget the elevation — on rejection, on sign-out, or when it expires. */
export function clearAdminElevation(): void {
  held = null;
}

/* -------------------------------------------------------------------------- *
 * Step-up handler registry
 *
 * The fetch layer is plain TypeScript and must stay testable without React, so
 * it does not import a dialog. The UI registers a handler; the fetch layer
 * calls it when the server demands elevation. A handler resolves with an
 * elevation token, or null when the admin cancels or cannot verify.
 * -------------------------------------------------------------------------- */

export type AdminStepUpHandler = () => Promise<string | null>;

let handler: AdminStepUpHandler | null = null;

/** Register the UI's challenge handler. Returns an unregister function. */
export function registerAdminStepUpHandler(next: AdminStepUpHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

export function getAdminStepUpHandler(): AdminStepUpHandler | null {
  return handler;
}

/* -------------------------------------------------------------------------- *
 * Verification call
 * -------------------------------------------------------------------------- */

export type AdminMfaVerifyResult =
  | { ok: true; elevation: string; expiresInSeconds: number }
  | { ok: false; status: number; reason?: string };

/**
 * Exchange a six-digit code (or a recovery code) for an elevation.
 *
 * The code is passed straight to the request body and is never logged, stored,
 * echoed into a URL, or retained after this call returns.
 */
export async function verifyAdminMfaCode(
  code: string,
  bearerToken: string
): Promise<AdminMfaVerifyResult> {
  const res = await fetch("/api/platform-admin/mfa/verify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
    cache: "no-store",
  });

  type VerifyPayload = {
    elevation?: string;
    expiresInSeconds?: number;
    code?: string;
  };
  let payload: VerifyPayload | null = null;
  try {
    payload = (await res.json()) as VerifyPayload;
  } catch {
    // A non-JSON body is treated as a plain failure.
  }

  if (!res.ok || typeof payload?.elevation !== "string") {
    return { ok: false, status: res.status, reason: payload?.code };
  }

  const expiresInSeconds =
    typeof payload.expiresInSeconds === "number"
      ? payload.expiresInSeconds
      : ADMIN_ELEVATION_MAX_SECONDS;

  return { ok: true, elevation: payload.elevation, expiresInSeconds };
}

/** Test seam — resets module state between cases. Not used by application code. */
export const __testing = {
  reset() {
    held = null;
    handler = null;
  },
  peek: () => held,
};
