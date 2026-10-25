"use client";

/**
 * "Continue with Google" — the button, the Hebrew notices a Google round trip can come back with, and the
 * one client step that turns the refresh cookie the server set into the stored session (the same three
 * localStorage entries password login writes). Hebrew only (owner decision, 22.10.2026: new screens may be
 * Hebrew-first; English is a later system-wide task).
 *
 * The button is rendered only when the server says the feature is ON (the page passes `enabled`), and never
 * inside the native shell: Google refuses OAuth in an embedded WebView, and the native app is out of scope.
 */

import { useSyncExternalStore } from "react";

import { GOOGLE_NOTICES } from "@/lib/auth/google-notices";
import { readToken, refreshAccessToken } from "@/lib/auth/refresh-client";
import { isNative } from "@/lib/native/native-shell";

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

const buttonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  width: "100%",
  minHeight: 48,
  padding: "0 16px",
  borderRadius: 14,
  border: "1px solid #dadce0",
  background: "#ffffff",
  color: "#1f1f1f",
  fontWeight: 600,
  fontSize: 15,
  textDecoration: "none",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export function GoogleNotice({ notice }: { notice: string | null }) {
  if (!notice || !GOOGLE_NOTICES[notice]) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="google-notice"
      data-notice={notice}
      style={{
        borderRadius: 14,
        padding: "12px 14px",
        background: "var(--dz-surface-muted)",
        border: "1px solid var(--dz-border)",
        color: "var(--dz-text-primary)",
        fontSize: 14,
        lineHeight: 1.6,
        marginBottom: 14,
      }}
    >
      {GOOGLE_NOTICES[notice]}
    </div>
  );
}

/** The button and the "or" line under it. Renders nothing when OFF or inside the native shell. */
const noSubscribe = () => () => {};
function inNativeShell(): boolean {
  try {
    return isNative();
  } catch {
    return false;
  }
}

export function GoogleSignInButton({ enabled, from }: { enabled: boolean; from: "login" | "register" }) {
  // Hidden on the server render (no shell can be detected there), then shown unless this is the native shell.
  const native = useSyncExternalStore(noSubscribe, inNativeShell, () => true);
  if (!enabled || native) return null;
  return (
    <div data-testid="google-sign-in" style={{ marginBottom: 16 }}>
      <a href={`/api/auth/google/start?from=${from}`} style={buttonStyle} data-testid="google-button">
        <GoogleMark />
        <span>המשך עם Google</span>
      </a>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 0", color: "var(--dz-text-muted)", fontSize: 13 }}>
        <span style={{ flex: 1, height: 1, background: "var(--dz-border)" }} />
        <span>או עם אימייל</span>
        <span style={{ flex: 1, height: 1, background: "var(--dz-border)" }} />
      </div>
    </div>
  );
}

/**
 * After the server set the refresh cookie (a linked sign-in, or a completed Google signup): fetch the access
 * token from /api/auth/refresh and the profile from /api/auth/me, and store them exactly as login does.
 */
export async function establishSessionFromCookie(): Promise<boolean> {
  if ((await refreshAccessToken()) !== "refreshed") return false;
  const token = readToken();
  if (!token) return false;
  try {
    const res = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { user?: unknown };
      if (body.user) window.localStorage.setItem("user", JSON.stringify(body.user));
    }
  } catch {
    // The token is stored; the profile is re-read by the shell when it loads.
  }
  return true;
}
