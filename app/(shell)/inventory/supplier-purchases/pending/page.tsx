"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getInventoryItems } from "@/lib/api/inventory";
import { useI18n } from "@/components/i18n/I18nProvider";
import { BdiTemplate } from "@/components/inventory/supplier-purchase-order/order-wizard-ui";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  DecisionCard,
  DecisionChips,
  InventoryBadge,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";

type Item = {
  id: number;
  name: string;
  currentQuantity: number;
};

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  unitType: string | null;
  matchedItemId: number | null;
};

type Draft = {
  id: number;
  supplierName: string | null;
  externalOrderId?: string | null;
  status: string;
  lines: DraftLine[];
};

type LineDecision =
  | { action: "MERGE"; itemId: number | "" }
  | { action: "CREATE_NEW"; name: string; unitType: string };

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function PendingDecision({
  draft,
  items,
  decisions,
  actionLoading,
  confirmRejectId,
  onDecision,
  onApprove,
  onReject,
}: {
  draft: Draft;
  items: Item[];
  decisions: Record<number, LineDecision>;
  actionLoading: boolean;
  confirmRejectId: number | null;
  onDecision: (lineId: number, decision: LineDecision) => void;
  onApprove: (draft: Draft) => void;
  onReject: (draftId: number) => void;
}) {
  const { t } = useI18n();
  const totalUnits = draft.lines.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <>
      <h2>{draft.supplierName || t("customers.purchases.common.noSupplierOrder")}</h2>
      <p>{t("customers.purchases.pending.side.summary", { lines: draft.lines.length, units: totalUnits })}</p>
      {draft.lines.map((line) => {
        const decision = decisions[line.id];
        return (
          <div key={line.id} style={{ display: "grid", gap: 6 }}>
            <strong>{line.rawName || t("customers.purchases.pending.unnamedProduct")} · {line.quantity}</strong>
            <select
              className="inv-input"
              value={decision?.action || "CREATE_NEW"}
              onChange={(event) => {
                if (event.target.value === "MERGE") onDecision(line.id, { action: "MERGE", itemId: line.matchedItemId || "" });
                else onDecision(line.id, { action: "CREATE_NEW", name: line.rawName || "", unitType: line.unitType || "UNIT" });
              }}
            >
              <option value="MERGE">{t("customers.purchases.pending.mergeExisting")}</option>
              <option value="CREATE_NEW">{t("customers.purchases.pending.createNew")}</option>
            </select>
            {decision?.action === "MERGE" ? (
              <select
                className="inv-input"
                value={decision.itemId || ""}
                onChange={(event) => onDecision(line.id, { action: "MERGE", itemId: Number(event.target.value) })}
              >
                <option value="">{t("customers.purchases.pending.pickExisting")}</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.currentQuantity}</option>
                ))}
              </select>
            ) : (
              <input
                className="inv-input"
                value={decision?.action === "CREATE_NEW" ? decision.name : line.rawName || ""}
                onChange={(event) => onDecision(line.id, {
                  action: "CREATE_NEW",
                  name: event.target.value,
                  unitType: decision?.action === "CREATE_NEW" ? decision.unitType : line.unitType || "UNIT",
                })}
              />
            )}
          </div>
        );
      })}
      {confirmRejectId === draft.id ? <p>{t("customers.purchases.pending.side.rejectWarning")}</p> : null}
      <button type="button" className="inv-btn-primary" disabled={actionLoading} onClick={() => onApprove(draft)}>
        {actionLoading ? t("customers.purchases.pending.approving") : t("customers.purchases.pending.approve")}
      </button>
      <button type="button" className="inv-btn-secondary" disabled={actionLoading} onClick={() => onReject(draft.id)}>
        {confirmRejectId === draft.id ? t("customers.purchases.pending.confirmReject") : t("customers.purchases.pending.reject")}
      </button>
    </>
  );
}

export default function PendingSupplierPurchasesPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [decisions, setDecisions] = useState<Record<number, LineDecision>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const summary = useMemo(() => {
    return {
      totalOrders: drafts.length,
      totalLines: drafts.reduce((sum, draft) => sum + draft.lines.length, 0),
      totalUnits: drafts.reduce(
        (sum, draft) =>
          sum +
          draft.lines.reduce((lineSum, line) => lineSum + line.quantity, 0),
        0
      ),
    };
  }, [drafts]);

  async function load() {
    try {
      setLoading(true);
      setError(null);

      const draftsResponse = await fetch("/api/inventory/supplier-purchases", {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
      });

      const draftsData = await draftsResponse.json().catch(() => null);

      if (!draftsResponse.ok) {
        throw new Error(draftsData?.error || t("customers.purchases.pending.loadFailed"));
      }

      const pendingDrafts = Array.isArray(draftsData?.drafts)
        ? draftsData.drafts.filter(
            (draft: Draft) => draft.status === "PENDING_REVIEW"
          )
        : [];

      setDrafts(pendingDrafts);

      try {
        const itemsData = await getInventoryItems();
        setItems(Array.isArray(itemsData) ? itemsData : []);
      } catch (itemsError) {
        console.warn(
          "Failed loading inventory items for supplier purchases:",
          itemsError
        );
        setItems([]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("customers.purchases.pending.loadError"));
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

  function openDraft(draft: Draft) {
    setOpenId((current) => (current === draft.id ? null : draft.id));
    setConfirmRejectId(null);

    const nextDecisions: Record<number, LineDecision> = {};

    draft.lines.forEach((line) => {
      const matchedByStoredId = line.matchedItemId
        ? items.find((item) => item.id === line.matchedItemId)
        : null;

      const matchedByName = items.find(
        (item) =>
          line.rawName &&
          item.name.trim().toLowerCase() === line.rawName.trim().toLowerCase()
      );

      const matchedItem = matchedByStoredId || matchedByName;

      if (matchedItem) {
        nextDecisions[line.id] = {
          action: "MERGE",
          itemId: matchedItem.id,
        };
      } else {
        nextDecisions[line.id] = {
          action: "CREATE_NEW",
          name: line.rawName || "",
          unitType: line.unitType || "UNIT",
        };
      }
    });

    setDecisions((prev) => ({
      ...prev,
      ...nextDecisions,
    }));
  }

  function updateDecision(lineId: number, decision: LineDecision) {
    setDecisions((prev) => ({
      ...prev,
      [lineId]: decision,
    }));
  }

  async function approveDraft(draft: Draft) {
    try {
      setActionLoading(true);
      setError(null);
      setSuccess(null);

      const lines = draft.lines.map((line) => {
        const decision = decisions[line.id];

        if (!decision) {
          throw new Error(
            t("customers.purchases.pending.needAction", { name: line.rawName || t("customers.purchases.pending.lineFallback") })
          );
        }

        if (decision.action === "MERGE") {
          if (!decision.itemId) {
            throw new Error(
              t("customers.purchases.pending.needExisting", { name: line.rawName || t("customers.purchases.pending.lineFallback") })
            );
          }

          return {
            lineId: line.id,
            action: "MERGE",
            itemId: Number(decision.itemId),
          };
        }

        if (!decision.name.trim()) {
          throw new Error(
            t("customers.purchases.pending.needNewName", { name: line.rawName || t("customers.purchases.pending.lineFallback") })
          );
        }

        return {
          lineId: line.id,
          action: "CREATE_NEW",
          itemData: {
            name: decision.name.trim(),
            unitType: decision.unitType || "UNIT",
            sku: null,
            barcode: null,
          },
        };
      });

      const response = await fetch(
        `/api/inventory/supplier-purchases/${draft.id}/approve`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({ lines }),
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || t("customers.purchases.pending.approveFailed"));
      }

      setSuccess(t("customers.purchases.pending.approveSuccess"));
      setOpenId(null);
      setConfirmRejectId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("customers.purchases.pending.approveError"));
    } finally {
      setActionLoading(false);
    }
  }

  async function rejectDraft(draftId: number) {
    try {
      setActionLoading(true);
      setError(null);
      setSuccess(null);

      const response = await fetch(
        `/api/inventory/supplier-purchases/${draftId}/reject`,
        {
          method: "POST",
          headers: buildHeaders(),
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || t("customers.purchases.pending.rejectFailed"));
      }

      setSuccess(t("customers.purchases.pending.rejectSuccess"));
      setOpenId(null);
      setConfirmRejectId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("customers.purchases.pending.rejectError"));
    } finally {
      setActionLoading(false);
    }
  }

  function requestRejectDraft(draftId: number) {
    if (confirmRejectId !== draftId) {
      setConfirmRejectId(draftId);
      setError(null);
      setSuccess(null);
      return;
    }

    void rejectDraft(draftId);
  }

  return (
    <InventorySubPage intent="data"
      title={t("customers.purchases.pending.title")}
      backHref="/inventory/supplier-purchases"
      backLabel={t("customers.purchases.common.backToHub")}
      sub={
        !loading && !error
          ? summary.totalOrders > 0
            ? t(
                summary.totalOrders === 1 ? "customers.purchases.pending.subOne" : "customers.purchases.pending.subMany",
                { count: summary.totalOrders }
              )
            : t("customers.purchases.pending.subNone")
          : undefined
      }
      bottomNav="orders"
    >
      {error ? (
        <div className="inv-fwrap">
          <div className="inv-alert inv-alert--error">{error}</div>
        </div>
      ) : null}
      {success ? (
        <div className="inv-fwrap">
          <div className="inv-alert inv-alert--success">{success}</div>
        </div>
      ) : null}

      {loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={92} rows={3} />
        </div>
      ) : drafts.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            title={t("customers.purchases.pending.emptyTitle")}
            action={
              <Link href="/inventory/supplier-purchases/new" className="inv-btn-primary inv-btn-primary--full">
                {t("customers.purchases.hub.empty.create")}
              </Link>
            }
          >
            {t("customers.purchases.pending.emptyBody")}
          </InventoryStatePanel>
        </div>
      ) : (
        <>
        <div className="inv-ops">
          <div className="inv-desk-table" aria-label={t("customers.purchases.pending.tableAria")}>
            <table>
              <thead>
                <tr>
                  <th>{t("customers.purchases.pending.cols.supplier")}</th>
                  <th>{t("customers.purchases.pending.cols.lines")}</th>
                  <th>{t("customers.purchases.pending.cols.units")}</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft) => (
                  <tr key={draft.id} className={openId === draft.id ? "is-selected" : undefined} onClick={() => openDraft(draft)}>
                    <td>{draft.supplierName || t("customers.purchases.common.noSupplierOrder")}</td>
                    <td className="num">{draft.lines.length}</td>
                    <td className="num">{draft.lines.reduce((sum, line) => sum + line.quantity, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="inv-ops__side">
            {drafts.find((draft) => draft.id === openId) ? (
              <PendingDecision
                draft={drafts.find((draft) => draft.id === openId)!}
                items={items}
                decisions={decisions}
                actionLoading={actionLoading}
                confirmRejectId={confirmRejectId}
                onDecision={updateDecision}
                onApprove={(draft) => void approveDraft(draft)}
                onReject={requestRejectDraft}
              />
            ) : (
              <><h2>{t("customers.purchases.pending.side.title")}</h2><p>{t("customers.purchases.pending.side.empty")}</p></>
            )}
          </aside>
        </div>
        <div className="inv-rows inv-decision-mobile">
          {drafts.map((draft) => {
            const isOpen = openId === draft.id;
            const totalUnits = draft.lines.reduce(
              (sum, line) => sum + line.quantity,
              0
            );

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
                      <bdi>#{draft.id}</bdi> ·{" "}
                      <BdiTemplate
                        template={t(draft.lines.length === 1 ? "customers.purchases.common.itemsOne" : "customers.purchases.common.itemsMany")}
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
                    <InventoryBadge tone="low">{t("customers.purchases.pending.awaitingBadge")}</InventoryBadge>
                    <button type="button" className="inv-row__action" onClick={() => openDraft(draft)}>
                      {isOpen ? t("customers.purchases.pending.close") : t("customers.purchases.pending.reviewArrow")}
                    </button>
                  </span>
                </div>

                {isOpen ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="inv-seclabel">{t("customers.purchases.pending.whatArrived")}</div>

                    <div className="inv-olines">
                      {draft.lines.map((line) => {
                        const decision = decisions[line.id];
                        return (
                          <div key={line.id} className="inv-oline" style={{ flexWrap: "wrap" }}>
                            <div className="inv-oline__mid">
                              <div className="inv-oline__nm" dir="auto">{line.rawName || t("customers.purchases.pending.unnamedProduct")}</div>
                              <div className="inv-oline__sub">
                                <bdi>{line.quantity}</bdi> {line.unitType || "UNIT"}
                              </div>
                            </div>
                            <div style={{ width: "100%", display: "grid", gap: 8, marginTop: 8 }}>
                              <select
                                className="inv-input"
                                value={decision?.action || "CREATE_NEW"}
                                onChange={(event) => {
                                  if (event.target.value === "MERGE") {
                                    updateDecision(line.id, {
                                      action: "MERGE",
                                      itemId: line.matchedItemId || "",
                                    });
                                  } else {
                                    updateDecision(line.id, {
                                      action: "CREATE_NEW",
                                      name: line.rawName || "",
                                      unitType: line.unitType || "UNIT",
                                    });
                                  }
                                }}
                              >
                                <option value="MERGE">{t("customers.purchases.pending.mergeExisting")}</option>
                                <option value="CREATE_NEW">{t("customers.purchases.pending.createNew")}</option>
                              </select>

                              {decision?.action === "MERGE" ? (
                                <select
                                  className="inv-input"
                                  value={decision.itemId || ""}
                                  onChange={(event) =>
                                    updateDecision(line.id, {
                                      action: "MERGE",
                                      itemId: Number(event.target.value),
                                    })
                                  }
                                >
                                  <option value="">{t("customers.purchases.pending.pickExisting")}</option>
                                  {items.map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.name} · {t("customers.purchases.pending.inStockColon", { qty: item.currentQuantity })}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  className="inv-input"
                                  value={decision?.name || line.rawName || ""}
                                  onChange={(event) =>
                                    updateDecision(line.id, {
                                      action: "CREATE_NEW",
                                      name: event.target.value,
                                      unitType:
                                        decision?.action === "CREATE_NEW"
                                          ? decision.unitType
                                          : line.unitType || "UNIT",
                                    })
                                  }
                                  placeholder={t("customers.purchases.pending.newNamePlaceholder")}
                                  dir="auto"
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <p className="inv-field__help" style={{ marginTop: 10 }}>
                      <BdiTemplate template={t("customers.purchases.pending.approveNote")} name="units" value={totalUnits} />
                    </p>

                    {confirmRejectId === draft.id ? (
                      <div className="inv-alert inv-alert--error" style={{ marginTop: 10 }}>
                        {t("customers.purchases.pending.rejectWarning")}
                      </div>
                    ) : null}

                    <DecisionChips
                      choices={[
                        { label: actionLoading ? t("customers.purchases.pending.approving") : t("customers.purchases.pending.approve"), primary: true, disabled: actionLoading, onClick: () => void approveDraft(draft) },
                        { label: confirmRejectId === draft.id ? t("customers.purchases.pending.confirmReject") : t("customers.purchases.pending.reject"), disabled: actionLoading, onClick: () => requestRejectDraft(draft.id) },
                      ]}
                    />
                    <Link
                      href={`/inventory/supplier-purchases/${draft.id}/send`}
                      className="inv-btn-link"
                      style={{ display: "inline-block", marginTop: 10 }}
                    >
                      {t("customers.purchases.pending.backToSend")}
                    </Link>
                  </div>
                ) : null}
              </DecisionCard>
            );
          })}
        </div>
        </>
      )}
    </InventorySubPage>
  );
}
