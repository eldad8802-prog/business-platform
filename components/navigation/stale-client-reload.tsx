"use client";

/**
 * A page that came from an older deployment reloads itself once into the current one.
 *
 * Why (2026-10-24): Vercel's skew protection (max age 12 h) keeps a running client's page requests on the
 * deployment it started on. An iOS home-screen app stays alive in the background, so after a deploy every in-app
 * navigation kept rendering the OLD screens while its API calls already reached the new deployment — a fix was
 * live and still invisible on the owner's phone.
 *
 * How: the page's own deployment is <html data-dpl-id> (Next sets it); the current one is GET /api/health/version.
 * Checked when the app comes back to the foreground and on every navigation. A mismatch reloads — once per new
 * deployment (sessionStorage), never while the owner is typing in a field.
 */
import { usePathname } from "next/navigation";
import { useCallback, useEffect } from "react";

const RELOADED_FOR = "dz-reloaded-for-deployment";

export function StaleClientReload() {
  const pathname = usePathname();

  const check = useCallback(async () => {
    const mine = document.documentElement.dataset.dplId;
    if (!mine || document.visibilityState !== "visible") return;
    let current: string | null = null;
    try {
      const r = await fetch("/api/health/version", { cache: "no-store" });
      if (!r.ok) return;
      current = ((await r.json()) as { deploymentId?: string | null }).deploymentId ?? null;
    } catch {
      return;
    }
    if (!current || current === mine) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement | null)?.isContentEditable) return;
    try {
      if (sessionStorage.getItem(RELOADED_FOR) === current) return;
      sessionStorage.setItem(RELOADED_FOR, current);
    } catch {
      return; // no storage: never risk a reload loop
    }
    window.location.reload();
  }, []);

  useEffect(() => {
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [check]);

  useEffect(() => {
    void check();
  }, [pathname, check]);

  return null;
}
