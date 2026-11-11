"use client";

/**
 * The business's billing kind, read once from the existing invoice-profile route (read only).
 * undefined = still loading · null = unknown (no kind declared, or the read failed) · otherwise the declared kind.
 * Shared by the production list and the invoices screen's tax-invoice entries.
 */
import { useEffect, useState } from "react";

import type { ProductionBusinessKind } from "./document-production-model";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

export function useBusinessKind(): ProductionBusinessKind | undefined {
  const [kind, setKind] = useState<ProductionBusinessKind | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let value: ProductionBusinessKind = null;
      try {
        const res = await fetch("/api/billing/invoice-profile", { headers: { Authorization: `Bearer ${getAuthToken()}` }, cache: "no-store" });
        if (res.ok) {
          const raw = (await res.json())?.profile?.billingBusinessKind;
          if (raw === "EXEMPT_DEALER" || raw === "AUTHORIZED_DEALER" || raw === "LTD_COMPANY") value = raw;
        }
      } catch {
        /* unknown kind */
      }
      if (!cancelled) setKind(value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return kind;
}
