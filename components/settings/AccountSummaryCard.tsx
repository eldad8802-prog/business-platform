"use client";

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";

/**
 * Read-only account summary for Settings → Team.
 *
 * Reads the current user + business from the existing route:
 *   GET /api/auth/me → { user: { name, email, businessName, ... } }
 *
 * This is a display-only summary. It does NOT manage users, invite members,
 * or define roles — no such infrastructure exists yet.
 */

type Me = {
  name: string | null;
  email: string;
  businessName: string | null;
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

export function AccountSummaryCard() {
  const { t } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch("/api/auth/me", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          cache: "no-store",
        });
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        if (cancelled) return;
        if (data?.user) {
          setMe({
            name: data.user.name ?? null,
            email: data.user.email,
            businessName: data.user.businessName ?? null,
          });
          setStatus("ok");
        } else {
          setStatus("error");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-[24px] dz-mist p-4 shadow-sm">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.accountSummary.title")}</h2>
      <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">
        {t("account.settings.accountSummary.description")}
      </p>

      {status === "loading" ? (
        <p className="mt-4 text-xs text-[var(--dz-text-muted)]">{t("common.loading")}</p>
      ) : status === "error" ? (
        <p className="mt-4 text-xs leading-5 text-[var(--dz-danger)]">
          {t("account.settings.accountSummary.loadError")}
        </p>
      ) : me ? (
        <div className="mt-3 divide-y divide-[var(--dz-border-subtle)]">
          <Row label={t("account.settings.accountSummary.name")} value={me.name?.trim() ? me.name : "—"} />
          <Row label={t("account.settings.accountSummary.email")} value={me.email} />
          <Row
            label={t("account.settings.accountSummary.business")}
            value={me.businessName?.trim() ? me.businessName : "—"}
          />
        </div>
      ) : null}
    </section>
  );
}
