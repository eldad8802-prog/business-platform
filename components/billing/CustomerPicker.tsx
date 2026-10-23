"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { glassActionStyle, primaryActionStyle, TOKEN } from "@/lib/design/billing-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

export type BillingCustomerRow = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
};

type Props = {
  authToken: string;
  billingDocumentId: number;
  /** Current linked customer id from server, if any */
  linkedCustomerId: number | null;
  /** Controlled display name (snapshot / editing) */
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  /** After linking to an existing / new customer — parent reloads document */
  onPickSuccess: () => void;
  disabled?: boolean;
};

export function CustomerPicker({
  authToken,
  billingDocumentId,
  linkedCustomerId,
  displayName,
  onDisplayNameChange,
  onPickSuccess,
  disabled,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<BillingCustomerRow[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickErr, setQuickErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const fetchList = useCallback(
    async (q: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (q.trim().length > 0) params.set("q", q.trim());
        const res = await fetch(`/api/billing/customers?${params}`, {
          headers: { Authorization: `Bearer ${authToken}` },
          cache: "no-store",
        });
        if (!res.ok) {
          setResults([]);
          return;
        }
        const data = await res.json();
        const list: BillingCustomerRow[] = Array.isArray(data?.customers)
          ? data.customers
          : [];
        setResults(list);
      } finally {
        setLoading(false);
      }
    },
    [authToken]
  );

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void fetchList(displayName), 280);
    return () => window.clearTimeout(timer);
  }, [displayName, open, fetchList]);

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      const el = wrapRef.current;
      if (!el || !(e.target instanceof Node)) return;
      if (!el.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);

  async function handlePick(row: BillingCustomerRow) {
    setOpen(false);
    try {
      const res = await fetch(
        `/api/billing/documents/${billingDocumentId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ customerId: row.id }),
        }
      );
      if (!res.ok) return;
      onPickSuccess();
    } catch {
      /* ignore */
    }
  }

  async function handleQuickCreate() {
    const name = quickName.trim();
    if (!name || quickBusy) return;
    setQuickBusy(true);
    setQuickErr(null);
    try {
      const res = await fetch("/api/billing/customers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          phone: quickPhone.trim() || undefined,
        }),
      });
      if (!res.ok) {
        let msg = t("billing.customerPicker.createFailed");
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {
        }
        setQuickErr(msg);
        return;
      }
      const data = await res.json();
      const c = data?.customer;
      if (c?.id && c?.name) {
        setQuickOpen(false);
        setQuickName("");
        setQuickPhone("");
        await handlePick({
          id: c.id as number,
          name: String(c.name),
          phone: c.phone ?? null,
          email: c.email ?? null,
          city: c.city ?? null,
        });
      }
    } finally {
      setQuickBusy(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: TOKEN.ink.secondary }}>
          {t("billing.customerPicker.label")} <span style={{ color: TOKEN.semantic.urgent.ink }}>*</span>
        </span>
        <div style={{ position: "relative" }}>
          <input
            type="text"
            value={displayName}
            disabled={disabled}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            onFocus={() => {
              setOpen(true);
              void fetchList("");
            }}
            onClick={() => {
              setOpen(true);
              void fetchList(displayName.slice(0, 40));
            }}
            placeholder={t("billing.customerPicker.searchPlaceholder")}
            maxLength={200}
            dir="auto"
            autoComplete="off"
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
              color: TOKEN.ink.primary,
              width: "100%",
              boxSizing: "border-box",
            }}
          />
          {open ? (
            <div
              role="listbox"
              style={{
                position: "absolute",
                top: "100%",
                insetInlineStart: 0,
                insetInlineEnd: 0,
                zIndex: 50,
                marginTop: 4,
                maxHeight: 240,
                overflowY: "auto",
                background: TOKEN.surface.card,
                border: `1px solid ${TOKEN.border.DEFAULT}`,
                borderRadius: 10,
                boxShadow: TOKEN.shadow.floating,
              }}
            >
              {loading ? (
                <div style={{ padding: 12, fontSize: 13, color: TOKEN.ink.muted }}>
                  {t("common.loading")}
                </div>
              ) : results.length === 0 ? (
                <div style={{ padding: 12, fontSize: 13, color: TOKEN.ink.muted }}>
                  {t("billing.customerPicker.noResults")}
                </div>
              ) : (
                results.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void handlePick(row)}
                    style={{
                      width: "100%",
                      textAlign: "start",
                      padding: "10px 12px",
                      border: "none",
                      borderBottom: `1px solid ${TOKEN.surface.inset}`,
                      background:
                        linkedCustomerId === row.id ? TOKEN.semantic.success.bg : TOKEN.surface.card,
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: TOKEN.ink.primary }}>
                      {row.name}
                    </div>
                    {row.phone ? (
                      <div style={{ fontSize: 12, color: TOKEN.ink.muted }}>
                        {row.phone}
                      </div>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </label>

      {linkedCustomerId ? (
        <div style={{ fontSize: 12, color: TOKEN.semantic.success.ink, fontWeight: 600 }}>
          {t("billing.customerPicker.linked", { id: linkedCustomerId })}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: TOKEN.ink.muted }}>
          {t("billing.customerPicker.hint")}
        </div>
      )}

      <button
        type="button"
        onClick={() => setQuickOpen((v) => !v)}
        disabled={disabled}
        style={{
          ...glassActionStyle({ disabled, height: 34 }),
          alignSelf: "flex-start",
          padding: "6px 10px",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {t("billing.customerPicker.addNew")}
      </button>

      {quickOpen ? (
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            background: TOKEN.surface.inset,
            display: "grid",
            gap: 8,
          }}
        >
          <input
            type="text"
            placeholder={t("billing.customerPicker.quickNamePlaceholder")}
            value={quickName}
            onChange={(e) => setQuickName(e.target.value)}
            disabled={quickBusy}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
            }}
          />
          <input
            type="tel"
            placeholder={t("billing.customerPicker.quickPhonePlaceholder")}
            value={quickPhone}
            onChange={(e) => setQuickPhone(e.target.value)}
            disabled={quickBusy}
            dir="ltr"
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
            }}
          />
          {quickErr ? (
            <div style={{ fontSize: 12, color: TOKEN.semantic.urgent.ink }}>{quickErr}</div>
          ) : null}
          <button
            type="button"
            onClick={() => void handleQuickCreate()}
            disabled={quickBusy || !quickName.trim()}
            style={{
              ...primaryActionStyle({ disabled: quickBusy || !quickName.trim(), height: 38 }),
              padding: "8px 12px",
              fontWeight: 600,
            }}
          >
            {quickBusy ? t("billing.customerPicker.creating") : t("billing.customerPicker.createAndPick")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
