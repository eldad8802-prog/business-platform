"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
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
  const router = useRouter();
  const { t } = useI18n();
  const [matches, setMatches] = useState<InventoryPendingMatchDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

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
    <InventorySubPage intent="data"
      title={t("customers.inventory.sales.title")}
      variant="hub"
      sub={t("customers.inventory.sales.sub")}
      headerAction={{ icon: <IconPlus />, label: t("customers.inventory.sales.newSale"), href: "/inventory/sales/create", accent: true }}
      bottomNav="sales"
    >
      <div className="inv-rows">
        <InventoryRow
          thumb={<span style={{ fontSize: 22 }}>🧾</span>}
          thumbBg="var(--inv-info-bg)"
          title={t("customers.inventory.sales.manualTitle")}
          meta={t("customers.inventory.sales.manualMeta")}
          href="/inventory/sales/create"
        />
      </div>

      <div className="inv-hd__sub" style={{ marginTop: 6 }}>{t("customers.inventory.sales.unmatchedHeading")}</div>

      {loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={74} rows={2} />
        </div>
      ) : matches.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title={t("customers.inventory.sales.emptyTitle")}>
            {t("customers.inventory.sales.emptyBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
        <div className="inv-desk-table" aria-label={t("customers.inventory.common.unmatchedSalesAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("customers.inventory.common.sale")}</th>
                <th>{t("customers.inventory.common.quantity")}</th>
                <th>{t("customers.inventory.common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {matches.slice(0, 8).map((match) => (
                <tr
                  key={match.id}
                  className={match.id === selectedId ? "is-selected" : undefined}
                  onClick={() => setSelectedId(match.id)}
                >
                  <td>{match.metadata.name || match.externalSaleId}</td>
                  <td className="num">{match.metadata.quantity}</td>
                  <td>{t("customers.inventory.sales.awaitingLink")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="inv-ops__side">
          {(() => {
            const selected = matches.find((match) => match.id === selectedId);
            if (!selected) return <><h2>{t("customers.inventory.common.sale")}</h2><p>{t("customers.inventory.sales.selectHint")}</p></>;
            return (
              <>
                <h2>{selected.metadata.name || selected.externalSaleId}</h2>
                <p>{selected.metadata.source || "POS"} · {t("customers.inventory.sales.quantityValue", { quantity: selected.metadata.quantity })}</p>
                <button type="button" className="inv-btn-primary" onClick={() => router.push("/inventory/unmatched")}>
                  {t("customers.inventory.sales.linkInDecision")}
                </button>
              </>
            );
          })()}
        </aside>
        </div>
        <div className="inv-rows inv-cards">
          {matches.slice(0, 8).map((match) => (
            <InventoryRow
              key={match.id}
              thumb={<span style={{ fontSize: 22 }}>🧾</span>}
              thumbBg="var(--inv-info-bg)"
              title={match.metadata.name || match.externalSaleId}
              meta={
                <>
                  {t("customers.inventory.common.quantity")} <bdi>{match.metadata.quantity}</bdi> · {t("customers.inventory.sales.awaitingLink")}
                </>
              }
              href="/inventory/unmatched"
              trail={<InventoryBadge tone="info">POS</InventoryBadge>}
            />
          ))}
        </div>
        </>
      )}
    </InventorySubPage>
  );
}
