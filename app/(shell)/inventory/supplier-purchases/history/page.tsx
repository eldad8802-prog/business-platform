"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  FilterChipRow,
  DecisionCard,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";
import { BdiTemplate } from "@/components/inventory/supplier-purchase-order/order-wizard-ui";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  decision?: string | null;
};

type Draft = {
  id: number;
  supplierName: string | null;
  status: "APPROVED" | "REJECTED" | string;
  createdAt?: string;
  lines: DraftLine[];
};

type StatusFilter = "ALL" | "APPROVED" | "REJECTED";

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function statusLabel(status: string, t: Translator) {
  if (status === "APPROVED") return t("customers.purchases.history.statusApproved");
  if (status === "REJECTED") return t("customers.purchases.history.statusRejected");
  return status;
}

function formatDate(t: Translator, locale: Locale, value?: string) {
  if (!value) return t("customers.purchases.history.noDate");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("customers.purchases.history.noDate");
  return date.toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function SupplierHistoryPage() {
  const { t, locale } = useI18n();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [visibleCount, setVisibleCount] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/inventory/supplier-purchases", {
        headers: buildHeaders(),
        cache: "no-store",
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || t("customers.purchases.history.loadFailed"));
      }

      const history = (data?.drafts || []).filter(
        (d: Draft) => d.status === "APPROVED" || d.status === "REJECTED"
      );

      setDrafts(history);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("customers.purchases.history.loadError"));
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time load, unchanged by i18n (the loader now reads `t` for its messages)
  }, []);

  const filtered = useMemo(() => {
    if (statusFilter === "ALL") return drafts;
    return drafts.filter((d) => d.status === statusFilter);
  }, [drafts, statusFilter]);

  const visible = filtered.slice(0, visibleCount);

  const summary = useMemo(() => {
    return {
      total: drafts.length,
      approved: drafts.filter((d) => d.status === "APPROVED").length,
      rejected: drafts.filter((d) => d.status === "REJECTED").length,
    };
  }, [drafts]);

  return (
    <InventorySubPage intent="data"
      title={t("customers.purchases.history.title")}
      backHref="/inventory/supplier-purchases"
      backLabel={t("customers.purchases.common.backToHub")}
      sub={
        !loading && !error
          ? summary.total > 0
            ? t("customers.purchases.history.sub", { approved: summary.approved, rejected: summary.rejected })
            : t("customers.purchases.history.subEmpty")
          : undefined
      }
      bottomNav="orders"
    >
      <FilterChipRow<StatusFilter>
        value={statusFilter}
        onChange={(value) => {
          setStatusFilter(value);
          setVisibleCount(5);
        }}
        options={[
          { value: "ALL", label: t("customers.purchases.history.filterAll") },
          { value: "APPROVED", label: t("customers.purchases.history.filterApproved") },
          { value: "REJECTED", label: t("customers.purchases.history.filterRejected") },
        ]}
      />

      {error ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.purchases.history.serverError")}
            action={
              <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void load()}>
                {t("customers.purchases.history.retry")}
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={84} rows={4} />
        </div>
      ) : visible.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={t("customers.purchases.history.emptyTitle")}
            action={
              <Link href="/inventory/supplier-purchases/new" className="inv-btn-primary inv-btn-primary--full">
                {t("customers.purchases.history.createOrder")}
              </Link>
            }
          >
            {t("customers.purchases.history.emptyBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
          <div className="inv-desk-table" aria-label={t("customers.purchases.history.title")}>
            <table>
              <thead>
                <tr>
                  <th>{t("customers.purchases.history.cols.supplier")}</th>
                  <th>{t("customers.purchases.history.cols.date")}</th>
                  <th>{t("customers.purchases.history.cols.lines")}</th>
                  <th>{t("customers.purchases.history.cols.status")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((draft) => (
                  <tr key={draft.id} className={openId === draft.id ? "is-selected" : undefined} onClick={() => setOpenId(openId === draft.id ? null : draft.id)}>
                    <td>{draft.supplierName || t("customers.purchases.common.noSupplierOrder")}</td>
                    <td>{formatDate(t, locale, draft.createdAt)}</td>
                    <td className="num">{draft.lines.length}</td>
                    <td>{statusLabel(draft.status, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="inv-ops__side">
            {visible.find((item) => item.id === openId) ? (
              <>
                <h2>{visible.find((item) => item.id === openId)?.supplierName || t("customers.purchases.common.noSupplierOrder")}</h2>
                {visible.find((item) => item.id === openId)?.lines.slice(0, 8).map((line) => (
                  <p key={line.id}>{line.rawName || t("customers.purchases.pending.unnamedProduct")} · {line.quantity}</p>
                ))}
              </>
            ) : (
              <><h2>{t("customers.purchases.hub.inspector.title")}</h2><p>{t("customers.purchases.history.sideEmpty")}</p></>
            )}
          </aside>
        </div>
        <div className="inv-rows inv-decision-mobile">
          {visible.map((draft) => {
            const isOpen = openId === draft.id;
            const totalUnits = draft.lines.reduce((s, l) => s + l.quantity, 0);
            const approved = draft.status === "APPROVED";
            return (
              <DecisionCard key={draft.id}>
                <div className="inv-dcard__top">
                  <span
                    className="inv-row__thumb"
                    style={{ background: "var(--inv-surface)", width: 46, height: 46, fontSize: 22 }}
                    aria-hidden
                  >
                    🚚
                  </span>
                  <div className="inv-row__mid">
                    <div className="inv-row__nm" dir="auto">{draft.supplierName || t("customers.purchases.common.noSupplierOrder")}</div>
                    <div className="inv-row__meta">
                      <bdi>#{draft.id}</bdi> · <bdi>{formatDate(t, locale, draft.createdAt)}</bdi> ·{" "}
                      <BdiTemplate
                        template={t(draft.lines.length === 1 ? "customers.purchases.common.productsOne" : "customers.purchases.common.productsMany")}
                        name="count"
                        value={draft.lines.length}
                      />{" "}
                      ·{" "}
                      <BdiTemplate
                        template={t(totalUnits === 1 ? "customers.purchases.common.unitsOne" : "customers.purchases.common.unitsMany")}
                        name="count"
                        value={totalUnits}
                      />
                    </div>
                  </div>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7 }}>
                    <InventoryBadge tone={approved ? "ok" : "neutral"}>{statusLabel(draft.status, t)}</InventoryBadge>
                    <button type="button" className="inv-row__action" onClick={() => setOpenId(isOpen ? null : draft.id)}>
                      {isOpen ? t("customers.purchases.history.hide") : t("customers.purchases.history.detailsArrow")}
                    </button>
                  </span>
                </div>

                {isOpen ? (
                  <div className="inv-olines" style={{ marginTop: 12 }}>
                    {draft.lines.map((line) => (
                      <div key={line.id} className="inv-oline">
                        <div className="inv-oline__mid">
                          <div className="inv-oline__nm" dir="auto">{line.rawName || t("customers.purchases.pending.unnamedProduct")}</div>
                        </div>
                        <span className="inv-oline__price">
                          <BdiTemplate
                            template={t(line.quantity === 1 ? "customers.purchases.common.unitsOne" : "customers.purchases.common.unitsMany")}
                            name="count"
                            value={line.quantity}
                          />
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </DecisionCard>
            );
          })}

          {filtered.length > visibleCount ? (
            <button
              type="button"
              onClick={() => setVisibleCount((p) => p + 5)}
              className="inv-btn-secondary"
              style={{ width: "100%", marginTop: 4 }}
            >
              {t("customers.purchases.history.showMore")}
            </button>
          ) : null}
        </div>
        </>
      )}
    </InventorySubPage>
  );
}
