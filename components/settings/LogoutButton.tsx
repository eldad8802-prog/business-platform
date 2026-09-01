"use client";

/**
 * Logout control for Settings → Security.
 *
 * Reuses the exact client-side logout mechanism already used across the app
 * (clear the auth token + cached user from localStorage, then redirect to
 * /login). No server session table exists — auth is JWT held in localStorage.
 */

export function LogoutButton() {
  function handleLogout() {
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      localStorage.removeItem("sessionId");
    } catch {
      /* ignore */
    }
    window.location.href = `${window.location.origin}/login`;
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className="min-h-11 rounded-2xl bg-[var(--dz-app-chrome)] px-4 text-sm font-bold text-[var(--dz-text-on-brand)]"
    >
      התנתקות
    </button>
  );
}
