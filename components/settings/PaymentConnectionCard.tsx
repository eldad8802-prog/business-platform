"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import {
  buildConnectionRequestBody,
  connectionFormFields,
  emptyValuesFor,
  missingRequiredFields,
  selectableProviders,
  type ProviderCatalogEntryWire,
} from "@/lib/services/payments/providers/connection-form";
import {
  WarmButton,
  WarmCard,
  WarmField,
  WarmPill,
  warmInputStyle,
} from "@/components/ui/warm/warm-primitives";

/**
 * Payment-provider connection UI — descriptor-driven.
 *
 * WHAT THIS FILE DOES NOT KNOW
 *
 * Any provider's name. It previously held its own union of provider keys, its
 * own selectable list, its own label map and a submit branch per provider, and
 * the consequence was a real defect: a provider could be enabled server-side,
 * appear in the catalogue with a complete descriptor, and still be impossible
 * to connect, because this file had never heard of it. The catalogue endpoint
 * promised that adding a provider needs no UI change; this file is what makes
 * that true.
 *
 *   GET  /api/payments/providers    → which providers may be connected, and the
 *                                     fields each one needs
 *   GET  /api/payments/connections  → what is already connected (no secrets)
 *   POST /api/payments/connections  → the one generic, descriptor-validated
 *                                     connect path
 *
 * ENABLEMENT IS THE SERVER'S DECISION, and this component cannot second-guess
 * it in either direction. It offers exactly what the catalogue returned. If the
 * catalogue cannot be read the form refuses to render options at all rather
 * than falling back to anything remembered — a stale list is how a provider
 * whose webhook is switched off gets offered to a business.
 *
 * Secret fields are write-only: masked on input, cleared after a successful
 * save, and never read back from the server.
 */

const W = TOKEN.warm;

type PublicConnection = {
  provider: string;
  merchantId: string | null;
  isActive: boolean;
  hasCredential: boolean;
};

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function PaymentConnectionCard() {
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [catalogue, setCatalogue] = useState<ProviderCatalogEntryWire[]>([]);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  // ONLY THE NEWEST LOAD MAY WRITE STATE.
  //
  // This screen loads twice in development — React invokes effects twice on
  // purpose — and a person can also save while a load is still in flight. Two
  // overlapping loads then finish in an order nobody chose, and a late failure
  // can overwrite an earlier success. That matters more here than it usually
  // would: failing closed means the older, failed answer blanks the provider
  // list, so the form goes empty for no reason the user can see.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const run = ++loadSeq.current;
    const isCurrent = () => loadSeq.current === run;

    setLoading(true);
    setError(null);
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

    // THE CATALOGUE IS THE AUTHORITY, so its failure is a hard state. Anything
    // else would mean guessing which providers exist.
    try {
      const res = await fetch("/api/payments/providers", {
        headers,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const list = selectableProviders(data?.providers);
      if (isCurrent()) {
        setCatalogue(list);
        setCatalogueFailed(false);
        setSelectedKey((current) => {
          if (current && list.some((p) => p.key === current)) return current;
          return list.length > 0 ? list[0]!.key : null;
        });
      }
    } catch {
      if (isCurrent()) {
        setCatalogue([]);
        setSelectedKey(null);
        setCatalogueFailed(true);
      }
    }

    // The connected list is informational; failing to read it must not hide the
    // form, which is the one thing a business can act on.
    try {
      const res = await fetch("/api/payments/connections", {
        headers,
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        if (isCurrent()) {
          setConnections(
            Array.isArray(data?.connections) ? data.connections : []
          );
        }
      }
    } catch {
      // Soft-fail: show the form.
    }

    if (!isCurrent()) return;

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected =
    catalogue.find((entry) => entry.key === selectedKey) ?? null;

  // Re-seed the form whenever the chosen provider changes, so no value ever
  // survives from a provider whose fields are not even the same shape.
  useEffect(() => {
    setValues(selected ? emptyValuesFor(selected) : {});
  }, [selected]);

  const activeConnections = connections.filter((c) => c.isActive);
  const anyConnected = activeConnections.length > 0;

  function labelForProvider(key: string): string {
    return catalogue.find((entry) => entry.key === key)?.label ?? key;
  }

  function clearSecrets(descriptor: ProviderCatalogEntryWire) {
    setValues((current) => {
      const next = { ...current };
      for (const field of connectionFormFields(descriptor)) {
        if (field.type === "secret") next[field.key] = "";
      }
      return next;
    });
  }

  async function handleSubmit() {
    if (submitting || !selected) return;
    setError(null);
    setNotice(null);

    const missing = missingRequiredFields(selected, values);
    if (missing.length > 0) {
      setError(`יש להזין ${missing.map((f) => f.label).join(", ")}.`);
      return;
    }

    setSubmitting(true);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/payments/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(buildConnectionRequestBody(selected, values)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          data && typeof data.error === "string"
            ? data.error
            : "לא הצלחנו לשמור את החיבור."
        );
        return;
      }
      clearSecrets(selected);
      setNotice(`${selected.label} מחובר.`);
      await load();
    } catch {
      setError("לא הצלחנו לשמור את החיבור.");
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = submitting
    ? "שומר…"
    : error
      ? "התחבר מחדש"
      : anyConnected
        ? "עדכן חיבור"
        : "חבר ספק";

  return (
    <WarmCard style={{ direction: "rtl" } as React.CSSProperties}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: TOKEN.weight.semibold, color: W.ink }}>
          גבייה
        </h2>
        {anyConnected ? (
          <WarmPill tone="verified">מחובר</WarmPill>
        ) : (
          <WarmPill tone="waiting">לא מחובר</WarmPill>
        )}
      </div>
      <p style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55, color: W.muted }}>
        חיבור ספק סליקה חיצוני. דוביז אינה שומרת פרטי כרטיס — התשלום מתבצע אצל
        הספק.
      </p>

      {error ? (
        <div
          role="alert"
          style={{
            marginTop: 12,
            borderRadius: W.radius.control,
            background: W.status.late.bg,
            color: W.status.late.ink,
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          style={{
            marginTop: 12,
            borderRadius: W.radius.control,
            background: W.status.verified.bg,
            color: W.status.verified.ink,
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {notice}
        </div>
      ) : null}

      {loading ? (
        <p style={{ marginTop: 16, fontSize: 12, color: W.muted2 }}>טוען…</p>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {anyConnected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activeConnections.map((c) => (
                <div
                  key={c.provider}
                  style={{
                    borderRadius: W.radius.control,
                    border: `1px solid ${W.line}`,
                    background: W.surface2,
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: TOKEN.weight.semibold, color: W.ink }}>
                    {labelForProvider(c.provider)} מחובר
                  </div>
                  <div style={{ marginTop: 2, fontSize: 12, color: W.muted }}>
                    מספר מסוף: {c.merchantId ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {catalogueFailed ? (
            <div
              role="alert"
              style={{
                borderRadius: W.radius.control,
                border: `1px solid ${W.line}`,
                background: W.surface2,
                padding: "12px 14px",
                fontSize: 12,
                lineHeight: 1.55,
                color: W.muted,
              }}
            >
              לא הצלחנו לטעון את רשימת ספקי הסליקה. רענן את הדף ונסה שוב.
            </div>
          ) : catalogue.length === 0 ? (
            <div
              style={{
                borderRadius: W.radius.control,
                border: `1px solid ${W.line}`,
                background: W.surface2,
                padding: "12px 14px",
                fontSize: 12,
                lineHeight: 1.55,
                color: W.muted,
              }}
            >
              אין כרגע ספק סליקה זמין לחיבור.
            </div>
          ) : (
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: TOKEN.weight.semibold,
                  color: W.muted,
                  marginBottom: 12,
                }}
              >
                {anyConnected ? "הוסף / עדכן חיבור" : "חבר ספק סליקה"}
              </div>

              <WarmField label="ספק">
                <select
                  value={selectedKey ?? ""}
                  onChange={(e) => {
                    setSelectedKey(e.target.value);
                    setError(null);
                  }}
                  style={warmInputStyle()}
                >
                  {catalogue.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </WarmField>

              {selected
                ? connectionFormFields(selected).map((field) => (
                    <WarmField
                      key={field.key}
                      label={
                        field.required ? field.label : `${field.label} (רשות)`
                      }
                    >
                      <input
                        type={field.type === "secret" ? "password" : "text"}
                        value={values[field.key] ?? ""}
                        onChange={(e) =>
                          setValues((current) => ({
                            ...current,
                            [field.key]: e.target.value,
                          }))
                        }
                        autoComplete={
                          field.type === "secret" ? "new-password" : "off"
                        }
                        style={warmInputStyle()}
                        placeholder={
                          field.type === "secret"
                            ? "לא יוצג לאחר השמירה"
                            : field.label
                        }
                      />
                    </WarmField>
                  ))
                : null}

              <WarmButton
                variant="primary"
                fullWidth
                height={48}
                onClick={() => void handleSubmit()}
                disabled={submitting || !selected}
              >
                {submitLabel}
              </WarmButton>
            </div>
          )}
        </div>
      )}
    </WarmCard>
  );
}
