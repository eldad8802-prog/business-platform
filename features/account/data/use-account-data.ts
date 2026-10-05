"use client";

/**
 * Client loaders for Profile and the Settings hub.
 *
 * Each value is whatever the server returned, or a visible "not loaded" state.
 * Nothing here ever substitutes a sample value: a failed load shows no number.
 */
import { useCallback, useEffect, useState } from "react";

import { getClientAuthToken, redirectToLogin } from "@/lib/client-session";
import type { ConnectionsSummary } from "@/lib/services/connections/connections-summary.service";
import type { ProfileSummary } from "@/lib/services/profile/profile-summary.service";

export type Load<T> =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; data: T };

async function getJson<T>(url: string): Promise<T | "unauthorized" | null> {
  const token = getClientAuthToken();
  if (!token) return "unauthorized";
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function useJson<T>(url: string): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getJson<T>(url).then((result) => {
      if (cancelled) return;
      if (result === "unauthorized") {
        redirectToLogin();
        return;
      }
      setLoad(result === null ? { state: "error" } : { state: "ready", data: result });
    });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return [load, reload];
}

export function useProfileSummary() {
  return useJson<ProfileSummary>("/api/profile/summary");
}

export function useConnectionsSummary() {
  return useJson<ConnectionsSummary>("/api/settings/connections-summary");
}

/**
 * Whether the business has unread notifications — the same endpoint and
 * predicate as the bottom bar's bell. A failed request leaves the dot off: a
 * bell that cries wolf is worse than a quiet one.
 */
export function useUnreadNotifications(): boolean {
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getJson<{ unreadCount?: number }>("/api/notifications/unread-count").then((result) => {
      if (cancelled || result === null || result === "unauthorized") return;
      setHasUnread(typeof result.unreadCount === "number" && result.unreadCount > 0);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return hasUnread;
}

/**
 * Save the business logo through the existing invoice-profile endpoint — the
 * same field (`BusinessProfile.billingLogoDataUrl`) and the same server
 * validation the documents use. No parallel storage.
 */
export async function saveBusinessLogo(dataUrl: string): Promise<"ok" | "rejected" | "failed"> {
  const token = getClientAuthToken();
  if (!token) {
    redirectToLogin();
    return "failed";
  }
  try {
    const res = await fetch("/api/billing/invoice-profile", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ billingLogoDataUrl: dataUrl }),
    });
    if (res.status === 401) {
      redirectToLogin();
      return "failed";
    }
    if (res.status === 400) return "rejected";
    return res.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}
