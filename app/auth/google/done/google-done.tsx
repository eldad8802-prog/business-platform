"use client";

import { useEffect } from "react";

import { establishSessionFromCookie } from "@/components/auth/google-sign-in";

/** Exchange the refresh cookie for the stored session, then a full navigation (as login does). */
export default function GoogleDone() {
  useEffect(() => {
    let alive = true;
    (async () => {
      const ok = await establishSessionFromCookie();
      if (!alive) return;
      window.location.replace(`${window.location.origin}${ok ? "/app" : "/login?google=error"}`);
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div
      aria-busy="true"
      data-testid="google-done"
      style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dz-text-secondary)", fontSize: 15 }}
    >
      מתחברים…
    </div>
  );
}
