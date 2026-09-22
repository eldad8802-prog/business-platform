"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { warmInputStyle } from "@/components/ui/warm/warm-primitives";
import { collectionFetch } from "./collection-client";

const W = TOKEN.warm;

export type PickedCustomer = { id: number; name: string };

/** Search the business's active customers and pick one. Collection is never customer-less. */
export function CustomerPicker({ onPick, autoFocus = true }: { onPick: (c: PickedCustomer) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PickedCustomer[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ status: "active", limit: "20" });
        if (q.trim()) params.set("q", q.trim());
        const data = await collectionFetch<{ customers: { id: number; name: string }[] }>(`/api/customers?${params}`);
        if (!cancelled) setRows(data.customers.map((c) => ({ id: c.id, name: c.name })));
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <input
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="חיפוש לקוח לפי שם או טלפון"
        aria-label="חיפוש לקוח"
        style={warmInputStyle()}
      />
      <div role="listbox" aria-label="לקוחות" style={{ display: "grid", gap: 4, maxHeight: 320, overflowY: "auto" }}>
        {loading && rows.length === 0 ? <span style={{ color: W.muted, fontSize: 14 }}>מחפש…</span> : null}
        {!loading && rows.length === 0 ? <span style={{ color: W.muted, fontSize: 14 }}>לא נמצאו לקוחות.</span> : null}
        {rows.map((c) => (
          <button
            key={c.id}
            role="option"
            aria-selected={false}
            onClick={() => onPick(c)}
            style={{
              textAlign: "start", minHeight: 44, padding: "8px 12px", borderRadius: 10,
              border: `1px solid ${W.line}`, background: W.surface, color: W.ink, fontSize: 15, cursor: "pointer",
            }}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
