"use client";

import { useCallback, useEffect, useState } from "react";
import { getPendingMatches, type InventoryPendingMatchDTO } from "@/lib/api/inventory";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { I2, InvButton, InvError, InvLoading, InvPage, InvPill, InvRow, InvState, ProductThumb, formatQty } from "@/components/inventory/v2/kit";
import { formatPosWhen, posSaleName } from "@/lib/inventory/pos-match";

const PAGE = 50;

/**
 * Sales hub (מכירות) — redesign. A manual sale entry and the POS sales still
 * waiting to be linked to a product (GET /api/inventory/unmatched, unchanged).
 * There is no sales history in the product; none is shown.
 */
export default function InventorySalesPage() {
  const [matches, setMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(false);
      const data = await getPendingMatches();
      setMatches(Array.isArray(data) ? data : []);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <InvPage title="מכירות" backFallback="/inventory" wide>
      <ul className="i2-list" style={{ marginTop: 8 }}>
        <InvRow
          href="/inventory/sales/create"
          thumb={
            <span className="i2-thumb" style={{ ["--s" as string]: "56px" }} aria-hidden>
              {I2.plus(24)}
            </span>
          }
          title="מכירה ידנית חדשה"
          sub="רישום מכירה שלא עברה בקופה — הכמויות יורדו מהמלאי"
          trail={I2.chevronEnd(18)}
        />
      </ul>

      <h2 className="i2-h2">מכירות מהקופה שממתינות לשיוך</h2>
      {loading ? (
        <InvLoading rows={2} />
      ) : error ? (
        <InvError message="לא הצלחנו לטעון את המכירות שממתינות לשיוך." onRetry={() => void load()} />
      ) : matches.length === 0 ? (
        <InvState title="אין מכירות שממתינות לשיוך" body="כל פריט שנמכר בקופה ולא זוהה כמוצר יופיע כאן לשיוך." />
      ) : (
        <>
          <ul className="i2-list">
            {matches.slice(0, limit).map((m) => {
              const name = posSaleName(m);
              const when = formatPosWhen(m.createdAt);
              return (
                <InvRow
                  key={m.id}
                  href={`/inventory/unmatched?match=${m.id}`}
                  thumb={<ProductThumb name={name} />}
                  kicker="קופה"
                  title={name}
                  sub={`כמות ${formatQty(m.metadata?.quantity)}${when ? ` · ${when}` : ""}`}
                  trail={<InvPill href={`/inventory/unmatched?match=${m.id}`} ariaLabel={`שיוך ${name} למוצר`}>שיוך</InvPill>}
                />
              );
            })}
          </ul>
          {matches.length > limit ? (
            <div style={{ textAlign: "center", marginTop: 8 }}>
              <InvButton kind="soft" small onClick={() => setLimit((n) => n + PAGE)}>
                הצגת עוד
              </InvButton>
            </div>
          ) : null}
        </>
      )}
    </InvPage>
  );
}
