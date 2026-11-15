"use client";

/**
 * "שמירת עותק" on the supplier order's send screen (purchase-order sheet, owner-approved 2026-11-09). Behind
 * business_documents (off by default): when the feature is off — or its state cannot be read — this renders nothing,
 * and the send screen is exactly as before.
 *
 * Saving stores a copy of the document the screen produces, in the screen's own interface language, with the number
 * printed on it; it records WHEN it was saved and never marks anything as sent. Each saved copy downloads as the stored
 * file itself. A retry of the same save reuses its server-issued key, so it can never make a second copy.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { InvButton, InvNote } from "@/components/inventory/v2/kit";
import { buildClientAuthHeaders } from "@/lib/client-session";
import { useFeatureState } from "@/lib/ui/use-feature-enabled";

/** A refusal the server explained in Hebrew; anything else (a lost connection, a 5xx) gets the generic message. */
class ServerRefusal extends Error {}

type SheetWire = { id: number; displayedNumber: string; externalNumber: string | null; displayDate: string; savedAt: string };

const savedAtLabel = (iso: string) =>
  new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export function PurchaseOrderSheetPanel({ supplierOrderId }: { supplierOrderId: number }) {
  const on = useFeatureState("business_documents");
  const { locale } = useI18n();
  const [sheets, setSheets] = useState<SheetWire[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  /** The server-issued key of the save in progress: a retry reuses it until the save succeeds. */
  const pendingKey = useRef<string | null>(null);
  /** One save at a time: a double click lands before the re-render that disables the button. */
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/business-documents/supplier-orders/${supplierOrderId}/sheets`, { headers: buildClientAuthHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { sheets?: SheetWire[] };
    return data.sheets ?? [];
  }, [supplierOrderId]);

  useEffect(() => {
    if (on !== true) return;
    let live = true;
    load().then((s) => live && setSheets(s), () => live && setSheets([]));
    return () => {
      live = false;
    };
  }, [on, load]);

  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      if (!pendingKey.current) {
        const k = await fetch("/api/business-documents/requests", { method: "POST", headers: { ...buildClientAuthHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ operation: "PURCHASE_ORDER_SHEET" }) });
        if (!k.ok) throw new Error("key");
        pendingKey.current = ((await k.json()) as { idempotencyKey: string }).idempotencyKey;
      }
      const res = await fetch(`/api/business-documents/supplier-orders/${supplierOrderId}/sheets`, {
        method: "POST",
        headers: { ...buildClientAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: pendingKey.current, locale }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw res.status < 500 && data.message ? new ServerRefusal(data.message) : new Error("save");
      pendingKey.current = null;
      setMessage({ tone: "ok", text: "העותק נשמר." });
      setSheets(await load());
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof ServerRefusal ? e.message : "שמירת העותק נכשלה. אפשר לנסות שוב — לא יישמר עותק כפול." });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const download = async (sheet: SheetWire) => {
    try {
      const res = await fetch(`/api/business-documents/po-sheets/${sheet.id}/pdf`, { headers: buildClientAuthHeaders(), cache: "no-store" });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `supplier-order-${supplierOrderId}-copy-${sheet.id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setMessage({ tone: "danger", text: "לא הצלחנו להוריד את העותק. נסו שוב." });
    }
  };

  if (on !== true) return null;

  return (
    <section aria-label="עותקים שמורים" style={{ marginTop: 18 }}>
      <h3 className="i2-h3">עותקים שמורים</h3>
      <p className="i2-muted" style={{ margin: "0 0 8px" }}>שמירת עותק של מסמך ההזמנה כפי שהוא מופק עכשיו. השמירה אינה מעידה שההזמנה נשלחה לספק.</p>
      <InvButton kind="secondary" block disabled={busy} onClick={() => void save()}>
        {busy ? "שומר…" : "שמירת עותק"}
      </InvButton>
      {message ? <InvNote tone={message.tone}>{message.text}</InvNote> : null}
      {sheets && sheets.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
          {sheets.map((s) => (
            <li key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid #e5e7eb" }}>
              <span>
                <bdi>עותק שנשמר ב־{savedAtLabel(s.savedAt)}</bdi>
                <span className="i2-muted" style={{ display: "block", fontSize: 13 }}>
                  <bdi>{s.displayedNumber}</bdi>
                  {s.externalNumber ? <> · <bdi>{s.externalNumber}</bdi></> : null} · תאריך במסמך {s.displayDate}
                </span>
              </span>
              <InvButton kind="soft" small onClick={() => void download(s)} ariaLabel={`הורדת העותק שנשמר ב־${savedAtLabel(s.savedAt)}`}>
                הורדה
              </InvButton>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
