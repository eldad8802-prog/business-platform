"use client";

/**
 * Logout control for Settings → Security.
 *
 * Signing out revokes the session on the server and then clears the local copy.
 * It used to only do the second half: the browser forgot the token and the
 * server kept honouring it until it expired, so a copy taken from a shared or
 * synced machine still worked after the owner had "logged out".
 *
 * The button is disabled while the request is in flight so a double click cannot
 * fire two revocations, and the copy says what is happening.
 */

import { useState } from "react";

import { signOutAndRedirect } from "@/lib/client-session";

export function LogoutButton() {
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    // Always redirects, including when revocation could not be reached — the
    // person asked to leave, so they leave. `signOutAndRedirect` logs the
    // failure rather than hiding it.
    await signOutAndRedirect();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={signingOut}
      aria-busy={signingOut}
      className="min-h-11 rounded-2xl bg-[var(--dz-app-chrome)] px-4 text-sm font-bold text-[var(--dz-text-on-brand)] disabled:opacity-70"
    >
      {signingOut ? "מתנתק…" : "התנתקות"}
    </button>
  );
}
