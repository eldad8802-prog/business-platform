"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  DecisionCard,
  KeyValueGrid,
  BottomSheet,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";
import {
  buildSupplierOrderText,
  downloadSupplierPurchaseOrderPdf,
  formatSupplierDraftDisplayDate,
  openSupplierOrderMailto,
  openWhatsAppWithSupplierOrderText,
} from "@/lib/services/inventory/supplier-purchase-document.service";
import { useI18n } from "@/components/i18n/I18nProvider";

type DraftLine = {
  id: number;
  rawName: string | null;
  quantity: number;
  unitType: string | null;
};

type ApiDraft = {
  id: number;
  supplierName: string | null;
  externalOrderId: string | null;
  orderDate: string | null;
  createdAt: string;
  status: string;
  lines: DraftLine[];
};

function buildHeaders() {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;

  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function SupplierPurchaseSendPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
  const rawId = params?.id;
  const draftIdFromRoute = Number(
    Array.isArray(rawId) ? rawId[0] : rawId ?? NaN
  );

  const [draft, setDraft] = useState<ApiDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState<string | null>(null);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);

  const loadDraft = useCallback(async () => {
    if (!draftIdFromRoute || Number.isNaN(draftIdFromRoute)) {
      setError(t("customers.purchases.send.invalidId"));
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const res = await fetch("/api/inventory/supplier-purchases", {
        method: "GET",
        headers: buildHeaders(),
        cache: "no-store",
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || t("customers.purchases.send.loadFailed"));
      }

      const list: ApiDraft[] = Array.isArray(data?.drafts)
        ? data.drafts
        : [];
      const found = list.find((d) => d.id === draftIdFromRoute) ?? null;

      if (!found) {
        setDraft(null);
        setError(t("customers.purchases.send.notFound"));
        return;
      }

      setDraft(found);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("customers.purchases.send.loadError"));
      setDraft(null);
    } finally {
      setLoading(false);
    }
  }, [draftIdFromRoute, t]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadDraft();
    });
  }, [loadDraft]);

  const orderText = useMemo(() => {
    if (!draft) return "";
    return buildSupplierOrderText({
      id: draft.id,
      supplierName: draft.supplierName,
      externalOrderId: draft.externalOrderId,
      orderDate: draft.orderDate,
      createdAt: draft.createdAt,
      lines: draft.lines.map((l) => ({
        rawName: l.rawName,
        quantity: l.quantity,
        unitType: l.unitType,
      })),
    });
  }, [draft]);

  const canDispatch =
    draft?.status === "PENDING_REVIEW" && draft.lines.length > 0;

  async function copyOrderText() {
    if (!orderText) return;
    try {
      await navigator.clipboard.writeText(orderText);
      setCopyOk(t("customers.purchases.send.copied"));
      setTimeout(() => setCopyOk(null), 2500);
    } catch {
      setError(t("customers.purchases.send.copyFailed"));
    }
  }

  function handleWhatsApp() {
    if (!orderText) return;
    openWhatsAppWithSupplierOrderText(orderText);
  }

  function handlePdf() {
    if (!draft) return;
    downloadSupplierPurchaseOrderPdf({
      id: draft.id,
      supplierName: draft.supplierName,
      externalOrderId: draft.externalOrderId,
      orderDate: draft.orderDate,
      createdAt: draft.createdAt,
      lines: draft.lines.map((l) => ({
        rawName: l.rawName,
        quantity: l.quantity,
        unitType: l.unitType,
      })),
    });
  }

  function handleMailto() {
    if (!draft || !orderText) return;
    const subject = `הזמנה #${draft.id} - ${
      draft.supplierName?.trim() || "ספק"
    }`;
    openSupplierOrderMailto(subject, orderText);
  }

  async function handleShareClick() {
    if (!canDispatch || !orderText) return;
    setError(null);

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share({
          title: "הזמנה לספק",
          text: orderText,
        });
      } catch (e: unknown) {
        const name =
          e &&
          typeof e === "object" &&
          "name" in e &&
          typeof (e as { name?: unknown }).name === "string"
            ? (e as { name: string }).name
            : "";
        if (name === "AbortError") return;
        setShareMenuOpen(true);
      }
      return;
    }

    setShareMenuOpen(true);
  }

  const displayDateLabel = draft
    ? formatSupplierDraftDisplayDate({
        id: draft.id,
        supplierName: draft.supplierName,
        externalOrderId: draft.externalOrderId,
        orderDate: draft.orderDate,
        createdAt: draft.createdAt,
        lines: draft.lines.map((l) => ({
          rawName: l.rawName,
          quantity: l.quantity,
          unitType: l.unitType,
        })),
      })
    : "";

  const totalUnits =
    draft?.lines.reduce((s, l) => s + Number(l.quantity || 0), 0) ?? 0;

  return (
    <InventorySubPage intent="standard"
      title={t("customers.purchases.send.title")}
      backHref="/inventory/supplier-purchases"
      backLabel={t("customers.purchases.common.backToHub")}
      sub={
        draft
          ? draft.supplierName?.trim()
            ? t("customers.purchases.send.subTo", { name: draft.supplierName.trim() })
            : t("customers.purchases.send.sub")
          : undefined
      }
      bottomNav="orders"
    >
      {loading ? (
        <div className="inv-rows">
          <InventorySkeletonBlock height={92} rows={3} />
        </div>
      ) : error && !draft ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.purchases.send.openFailed")}
            action={
              <button
                type="button"
                className="inv-btn-primary inv-btn-primary--full"
                onClick={() => router.push("/inventory/supplier-purchases")}
              >
                {t("customers.purchases.send.backToHub")}
              </button>
            }
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : draft ? (
        <>
          {error ? (
            <div className="inv-fwrap"><div className="inv-alert inv-alert--error">{error}</div></div>
          ) : null}
          {copyOk ? (
            <div className="inv-fwrap"><div className="inv-alert inv-alert--success">{copyOk}</div></div>
          ) : null}

          <div className="inv-rows">
            <DecisionCard>
              <div className="inv-dcard__top">
                <span
                  className="inv-row__thumb"
                  style={{ background: "var(--inv-surface)", width: 46, height: 46, fontSize: 22 }}
                  aria-hidden
                >
                  🚚
                </span>
                <div className="inv-row__mid">
                  <div className="inv-row__nm" dir="auto">
                    {draft.supplierName?.trim() || t("customers.purchases.common.noSupplierOrder")}
                  </div>
                  <div className="inv-row__meta">
                    <bdi>#{draft.id}</bdi>
                    {displayDateLabel ? <> · <bdi>{displayDateLabel}</bdi></> : null}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <KeyValueGrid
                  pairs={[
                    { k: t("customers.purchases.send.items"), v: <bdi>{draft.lines.length}</bdi> },
                    { k: t("customers.purchases.send.units"), v: <bdi>{totalUnits}</bdi> },
                    { k: t("customers.purchases.send.status"), v: draft.status === "PENDING_REVIEW" ? t("customers.purchases.pending.awaitingBadge") : draft.status },
                  ]}
                />
              </div>
            </DecisionCard>
          </div>

          <div className="inv-desk-workspace inv-send-desk">
          <div>
          <div className="inv-seclabel">{t("customers.purchases.confirm.itemsInOrder")}</div>
          <div className="inv-olines">
            {draft.lines.map((line) => (
              <div key={line.id} className="inv-oline">
                <div className="inv-oline__mid">
                  <div className="inv-oline__nm" dir="auto">{line.rawName || t("customers.purchases.pending.unnamedProduct")}</div>
                </div>
                <span className="inv-oline__price">
                  <bdi>{line.quantity}</bdi> {line.unitType || t("customers.purchases.send.unitsFallback")}
                </span>
              </div>
            ))}
          </div>
          </div>

          <div className="inv-fwrap" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="inv-btn-primary inv-btn-primary--full"
              disabled={!canDispatch}
              onClick={() => void handleShareClick()}
            >
              {t("customers.purchases.send.share")}
            </button>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <button type="button" className="inv-btn-secondary" disabled={!canDispatch} onClick={handlePdf}>
                {t("customers.purchases.send.downloadPdf")}
              </button>
              <button
                type="button"
                className="inv-btn-secondary"
                onClick={() => router.push("/inventory/supplier-purchases/pending")}
              >
                {t("customers.purchases.send.goToReceive")}
              </button>
            </div>
          </div>
          </div>

          {shareMenuOpen ? (
            <BottomSheet title={t("customers.purchases.send.howToSend")} onClose={() => setShareMenuOpen(false)}>
              <div style={{ display: "grid", gap: 8 }}>
                <button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={handleWhatsApp}>
                  WhatsApp
                </button>
                <button type="button" className="inv-btn-secondary" onClick={handleMailto}>
                  {t("customers.purchases.send.openEmail")}
                </button>
                <button type="button" className="inv-btn-secondary" onClick={() => void copyOrderText()}>
                  {t("customers.purchases.send.copyText")}
                </button>
              </div>
            </BottomSheet>
          ) : null}
        </>
      ) : null}
    </InventorySubPage>
  );
}
