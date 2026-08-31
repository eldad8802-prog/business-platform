"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Read-only business summary for Settings → "העסק שלי".
 *
 * Reflects business identity from existing routes only:
 *   GET /api/auth/me           → businessName
 *   GET /api/business/profile  → category / subCategory / billingAddress
 *
 * Settings stays a Reflector + Coordinator: this card only displays and links
 * to the owner screen (/business). It does NOT edit, own, or duplicate the
 * business-profile form.
 */

type BusinessInfo = {
  name: string | null;
  category: string | null;
  address: string | null;
};

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-xs font-semibold text-[var(--dz-text-muted)]">{label}</span>
      <span className="text-sm font-medium text-[var(--dz-text-primary)]">{value}</span>
    </div>
  );
}

export function BusinessSummaryCard() {
  const [info, setInfo] = useState<BusinessInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const [meRes, profileRes] = await Promise.all([
          fetch("/api/auth/me", { headers, cache: "no-store" }),
          fetch("/api/business/profile", { headers, cache: "no-store" }),
        ]);
        if (!meRes.ok) throw new Error("me");
        const me = await meRes.json();

        let category: string | null = null;
        let address: string | null = null;
        if (profileRes.ok) {
          const data = await profileRes.json();
          const profile = data?.profile;
          if (profile) {
            const cat = [profile.category, profile.subCategory]
              .filter((v: unknown) => typeof v === "string" && v.trim())
              .join(" · ");
            category = cat || null;
            address =
              typeof profile.billingAddress === "string" && profile.billingAddress.trim()
                ? profile.billingAddress
                : null;
          }
        }

        if (cancelled) return;
        setInfo({
          name: me?.user?.businessName ?? null,
          category,
          address,
        });
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-[24px] bg-[var(--dz-surface)] p-4 shadow-sm" dir="rtl">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">פרטי העסק</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
        התקציר שמזהה את העסק שלך במערכת.
      </p>

      {status === "loading" ? (
        <p className="mt-4 text-xs text-[var(--dz-text-muted)]">טוען…</p>
      ) : status === "error" ? (
        <p className="mt-4 text-xs leading-5 text-[var(--dz-danger)]">
          לא הצלחנו לטעון את פרטי העסק כרגע.
        </p>
      ) : info ? (
        <div className="mt-3 divide-y divide-[var(--dz-border-subtle)]">
          <Row label="שם העסק" value={info.name?.trim() ? info.name : "—"} />
          {info.category ? <Row label="תחום" value={info.category} /> : null}
          {info.address ? <Row label="כתובת" value={info.address} /> : null}
        </div>
      ) : null}

      <div className="mt-4">
        <Link
          href="/business"
          className="inline-flex min-h-11 items-center rounded-2xl border border-[var(--dz-border)] px-4 text-sm font-semibold text-[var(--dz-text-secondary)]"
        >
          עריכת פרטי העסק
        </Link>
      </div>
    </section>
  );
}
