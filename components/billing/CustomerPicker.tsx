"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
        let msg = "לא ניתן ליצור לקוח";
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
        <span style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>
          לקוח <span style={{ color: "#ef4444" }}>*</span>
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
            placeholder="שם לקוח או חיפוש מהרשימה"
            maxLength={200}
            dir="auto"
            autoComplete="off"
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              fontSize: 14,
              color: "#0f172a",
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
                left: 0,
                right: 0,
                zIndex: 50,
                marginTop: 4,
                maxHeight: 240,
                overflowY: "auto",
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                boxShadow: "0 10px 28px rgba(15,23,42,0.12)",
              }}
            >
              {loading ? (
                <div style={{ padding: 12, fontSize: 13, color: "#64748b" }}>
                  טוען…
                </div>
              ) : results.length === 0 ? (
                <div style={{ padding: 12, fontSize: 13, color: "#64748b" }}>
                  לא נמצאו לקוחות. השתמש בשם חופשי או צור לקוח חדש.
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
                      textAlign: "right",
                      padding: "10px 12px",
                      border: "none",
                      borderBottom: "1px solid #f1f5f9",
                      background:
                        linkedCustomerId === row.id ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: "#0f172a" }}>
                      {row.name}
                    </div>
                    {row.phone ? (
                      <div style={{ fontSize: 12, color: "#64748b" }}>
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
        <div style={{ fontSize: 12, color: "#166534", fontWeight: 600 }}>
          מקושר ללקוח במערכת (#{linkedCustomerId})
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "#64748b" }}>
          ניתן לחפש לקוח קיים או להזין שם חופשי — השם יופיע על החשבונית.
        </div>
      )}

      <button
        type="button"
        onClick={() => setQuickOpen((v) => !v)}
        disabled={disabled}
        style={{
          alignSelf: "flex-start",
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px dashed #94a3b8",
          background: "#f8fafc",
          fontSize: 12,
          fontWeight: 600,
          color: "#475569",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        + לקוח חדש מהיר
      </button>

      {quickOpen ? (
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            border: "1px solid #e2e8f0",
            background: "#fafafa",
            display: "grid",
            gap: 8,
          }}
        >
          <input
            type="text"
            placeholder="שם לקוח *"
            value={quickName}
            onChange={(e) => setQuickName(e.target.value)}
            disabled={quickBusy}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              fontSize: 14,
            }}
          />
          <input
            type="tel"
            placeholder="טלפון (אופציונלי)"
            value={quickPhone}
            onChange={(e) => setQuickPhone(e.target.value)}
            disabled={quickBusy}
            dir="ltr"
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              fontSize: 14,
            }}
          />
          {quickErr ? (
            <div style={{ fontSize: 12, color: "#b91c1c" }}>{quickErr}</div>
          ) : null}
          <button
            type="button"
            onClick={() => void handleQuickCreate()}
            disabled={quickBusy || !quickName.trim()}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: "none",
              background: "#0f172a",
              color: "#fff",
              fontWeight: 600,
              cursor:
                quickBusy || !quickName.trim() ? "not-allowed" : "pointer",
            }}
          >
            {quickBusy ? "יוצר…" : "צור ובחר"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
