"use client";

/**
 * The identity screen's data layer. One read — GET /api/business/identity-context, the canonical
 * BusinessIdentityContext — and the EXISTING owner actions, unchanged. No new write path: every
 * call below is an endpoint the P2 / P3-A screens already used, with the same authority rules
 * enforced server-side (statements are owner-confirmed, public use is a separate explicit act,
 * suggestions are re-validated before adoption, trust claims start internal).
 */
import { useCallback, useEffect, useState } from "react";

import { getClientAuthToken, redirectToLogin } from "@/lib/client-session";
import type { BusinessIdentityContext } from "@/lib/services/identity/business-identity-context";

function headers(json = true): Record<string, string> {
  const token = getClientAuthToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { "Content-Type": "application/json" } : {}) };
}

export type ContextLoad = { state: "loading" } | { state: "error" } | { state: "ready"; ctx: BusinessIdentityContext };

async function fetchContext(): Promise<BusinessIdentityContext | "unauthorized" | null> {
  if (!getClientAuthToken()) return "unauthorized";
  try {
    const res = await fetch("/api/business/identity-context", { headers: headers(), cache: "no-store" });
    if (res.status === 401) return "unauthorized";
    if (!res.ok) return null;
    return ((await res.json()) as { context: BusinessIdentityContext }).context;
  } catch {
    return null;
  }
}

/** Server error text is technical English; the owner sees a plain Hebrew line instead. */
const ERROR_TEXT: Array<[RegExp, string]> = [
  [/At most/i, "הגעתם למספר המרבי בתחום הזה. הסירו פריט כדי להוסיף אחר."],
  [/claim/i, "הטקסט נשמע כמו טענת אמון — כדאי להוסיף אותו כטענת אמון עם הוכחה."],
  [/email|phone|url/i, "אי אפשר לשמור כאן פרטי קשר או קישורים — הם מגיעים מפרטי העסק."],
];
function ownerError(raw: string | undefined): string {
  if (!raw) return "הפעולה לא הצליחה. נסו שוב.";
  return ERROR_TEXT.find(([re]) => re.test(raw))?.[1] ?? "הפעולה לא הצליחה. נסו שוב.";
}

export function useIdentityContext() {
  const [load, setLoad] = useState<ContextLoad>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await fetchContext();
    if (result === "unauthorized") return redirectToLogin();
    setLoad(result ? { state: "ready", ctx: result } : { state: "error" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchContext().then((result) => {
      if (cancelled) return;
      if (result === "unauthorized") return redirectToLogin();
      setLoad(result ? { state: "ready", ctx: result } : { state: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (request: () => Promise<Response>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await request();
        if (res.status === 401) {
          redirectToLogin();
          return false;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(ownerError(body.error));
        }
        await refresh();
        return res.ok;
      } catch {
        setError(ownerError(undefined));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const actions = {
    addStatement: (body: { dimension: string; code?: string; text?: string; channel?: string | null }) =>
      run(() => fetch("/api/business/identity", { method: "POST", headers: headers(), body: JSON.stringify(body) })),
    retireStatement: (id: number) => run(() => fetch(`/api/business/identity/${id}`, { method: "DELETE", headers: headers() })),
    setStatementPublic: (id: number, publicUseApproved: boolean) =>
      run(() => fetch(`/api/business/identity/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ publicUseApproved }) })),
    decideFact: (fact: string, action: "CONFIRM" | "APPROVE_PUBLIC" | "WITHDRAW_PUBLIC") =>
      run(() => fetch("/api/business/identity/facts", { method: "POST", headers: headers(), body: JSON.stringify({ fact, action }) })),
    adoptSuggestion: (signalKey: string, dimension: string, code: string) =>
      run(() => fetch("/api/business/identity/suggestions", { method: "POST", headers: headers(), body: JSON.stringify({ signalKey, dimension, code }) })),
    addTrustClaim: (kind: string, params: Record<string, unknown>) =>
      run(() => fetch("/api/business/trust-claims", { method: "POST", headers: headers(), body: JSON.stringify({ kind, params }) })),
    setTrustClaimPublic: (id: number, publicUseApproved: boolean) =>
      run(() => fetch(`/api/business/trust-claims/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ publicUseApproved }) })),
    retireTrustClaim: (id: number) => run(() => fetch(`/api/business/trust-claims/${id}`, { method: "DELETE", headers: headers() })),
    attachTrustDocument: (id: number, file: File) => {
      const form = new FormData();
      form.append("file", file);
      return run(() => fetch(`/api/business/trust-claims/${id}/document`, { method: "POST", headers: headers(false), body: form }));
    },
  };

  return { load, busy, error, clearError: () => setError(null), actions };
}

export type IdentityActions = ReturnType<typeof useIdentityContext>["actions"];
