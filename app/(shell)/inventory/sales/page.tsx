"use client";

import { useEffect, useState } from "react";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  InventoryRow,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
  IconPlus,
} from "@/components/inventory/inventory-design";
import { getPendingMatches, type InventoryPendingMatchDTO } from "@/lib/api/inventory";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

export default function InventorySalesPage() {
  const [matches, setMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      try {
        setLoading(true);
        const data = await getPendingMatches();
        if (isMounted) setMatches(Array.isArray(data) ? data : []);
      } catch (err) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        if (isMounted) setMatches([]);
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    void load();
    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <InventorySubPage
      title="מכירות"
      variant="hub"
      sub="דיווח מכירה ידנית, או טיפול במכירות POS שלא זוהו"
      headerAction={{ icon: <IconPlus />, label: "מכירה חדשה", href: "/inventory/sales/create", accent: true }}
      bottomNav="sales"
    >
      <div className="inv-rows">
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>🧾</span>}
          thumbBg="#e0edff"
          title="דווח מכירה ידנית"
          meta="בחירת מוצרים וכמויות — יופחת מהמלאי"
          href="/inventory/sales/create"
        />
      </div>

      <div className="inv-hd__sub" style={{ marginTop: 6 }}>מכירות POS שלא זוהו</div>

      {loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={74} rows={2} />
        </div>
      ) : matches.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title="אין מכירות שממתינות לטיפול">
            כל המכירות מהקופה זוהו או טופלו.
          </InventoryStatePanel>
        </div>
      ) : (
        <div className="inv-rows">
          {matches.slice(0, 8).map((match) => (
            <InventoryRow
              key={match.id}
              thumb={<span style={{ fontSize: 22 }}>🧾</span>}
              thumbBg="#e0edff"
              title={match.metadata.name || match.externalSaleId}
              meta={
                <>
                  כמות <bdi>{match.metadata.quantity}</bdi> · ממתין לשיוך
                </>
              }
              href="/inventory/unmatched"
              trail={<InventoryBadge tone="info">POS</InventoryBadge>}
            />
          ))}
        </div>
      )}
    </InventorySubPage>
  );
}
