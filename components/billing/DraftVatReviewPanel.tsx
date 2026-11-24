"use client";

/**
 * 4a T3 — the VAT review of a draft created before "מעבר לעוסק מורשה" (owner decisions 2026-11-24, D5–D8).
 *
 * Renders nothing unless the server says this draft needs a review (GET /api/billing/documents/[id]/vat-review →
 * required). A business without a transition always gets required:false, so its screen is unchanged.
 * The owner opens the review ("בדיקת מע״מ במסמך"), sees every line with its VAT rate (0% lines marked) and confirms
 * explicitly. The confirmation carries the fingerprint of exactly what was shown; if the draft changed meanwhile the
 * server refuses (409) and the panel reloads. Rates, prices and amounts are changed only by the owner, in the lines
 * editor, never here. Issuance and quote finalization are refused by the server until the review is valid.
 */

import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { primaryActionStyle, TOKEN } from "@/lib/design/billing-theme";

type ReviewState =
  | { required: false }
  | { required: true; reviewed: boolean; fingerprint: string; zeroRateLineIndexes: number[]; lines?: Array<{ lineIndex: number; description: string; vatRatePercent: string }> };

export function DraftVatReviewPanel({ documentId, authToken, contentKey }: { documentId: number; authToken: string; contentKey: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<ReviewState>({ required: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/billing/documents/${documentId}/vat-review`, { headers: { Authorization: `Bearer ${authToken}` }, cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ReviewState;
      setState(data && data.required ? data : { required: false });
    } catch {
      // The next load shows it; the server still refuses an unreviewed issuance.
    }
  }, [documentId, authToken]);

  useEffect(() => {
    void load();
  }, [load, contentKey]);

  if (!state.required) return null;

  async function confirm() {
    if (!state.required) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/documents/${documentId}/vat-review`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint: state.fingerprint }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : t("billing.vatReview.error"));
        await load();
        return;
      }
      setOpen(false);
      await load();
    } catch {
      setError(t("billing.vatReview.error"));
    } finally {
      setBusy(false);
    }
  }

  if (state.reviewed) {
    return (
      <div role="status" data-testid="vat-review-done" style={{ margin: "0 0 12px", padding: "10px 14px", borderRadius: 12, background: TOKEN.semantic.success.bg, color: TOKEN.semantic.success.ink, fontSize: 14 }}>
        {t("billing.vatReview.reviewed")}
      </div>
    );
  }

  const zero = new Set(state.zeroRateLineIndexes);
  return (
    <div role="alert" data-testid="vat-review-required" style={{ margin: "0 0 12px", padding: "12px 14px", borderRadius: 12, background: TOKEN.semantic.attention.bg, color: TOKEN.semantic.attention.ink, fontSize: 14, lineHeight: 1.5 }}>
      <div>{t("billing.vatReview.message")}</div>
      {!open ? (
        <button type="button" data-testid="vat-review-open" onClick={() => { setError(null); setOpen(true); void load(); }} style={{ ...primaryActionStyle({ height: 44 }), marginTop: 10 }}>
          {t("billing.vatReview.button")}
        </button>
      ) : (
        <div data-testid="vat-review-dialog" style={{ marginTop: 10, background: TOKEN.surface.card, color: TOKEN.ink.primary, borderRadius: 10, padding: 12 }}>
          <div style={{ marginBottom: 8 }}>{t("billing.vatReview.intro")}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "start", padding: "4px 6px" }}>{t("billing.vatReview.colLine")}</th>
                <th style={{ textAlign: "start", padding: "4px 6px" }}>{t("billing.vatReview.colVat")}</th>
              </tr>
            </thead>
            <tbody>
              {(state.lines ?? []).map((l) => (
                <tr key={l.lineIndex} data-zero={zero.has(l.lineIndex) ? "1" : "0"} style={{ background: zero.has(l.lineIndex) ? TOKEN.semantic.attention.bg : "transparent" }}>
                  <td style={{ padding: "4px 6px" }}>{l.description}</td>
                  <td style={{ padding: "4px 6px", fontWeight: zero.has(l.lineIndex) ? 700 : 400 }}>{Number(l.vatRatePercent)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error ? <div role="alert" style={{ marginTop: 8, color: TOKEN.semantic.urgent.ink }}>{error}</div> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button type="button" data-testid="vat-review-confirm" disabled={busy} onClick={() => void confirm()} style={{ ...primaryActionStyle({ disabled: busy, height: 44 }) }}>
              {t("billing.vatReview.confirm")}
            </button>
            <button type="button" data-testid="vat-review-cancel" disabled={busy} onClick={() => setOpen(false)} style={{ border: "none", background: "transparent", color: TOKEN.ink.primary, cursor: "pointer", padding: "8px 12px" }}>
              {t("billing.vatReview.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
