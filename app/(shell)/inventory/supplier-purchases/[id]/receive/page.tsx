"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import {
  InventoryOrderLine,
  MiniStepper,
  DecisionChips,
  BottomActionBar,
  ConfirmModal,
  InventoryStatePanel,
  InventorySkeletonBlock,
} from "@/components/inventory/inventory-design";
import {
  getPurchaseOrder,
  createReceivingSession,
  postReceivingSession,
  setLineRemainingDecision,
  type PurchaseOrderDTO,
} from "@/lib/api/inventory";
import { getProductEmoji } from "@/lib/inventory/product-emoji";
import { BdiTemplate } from "@/components/inventory/supplier-purchase-order/order-wizard-ui";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

type Decision = "KEEP_OPEN" | "BACKORDER" | "CLOSED_SHORT";

const UNIT_SHORT: Record<string, MessageKey> = {
  UNIT: "customers.purchases.receive.unitShort.UNIT",
  BOX: "customers.purchases.receive.unitShort.BOX",
  KG: "customers.purchases.receive.unitShort.KG",
  GRAM: "customers.purchases.receive.unitShort.GRAM",
  LITER: "customers.purchases.receive.unitShort.LITER",
  ML: "customers.purchases.receive.unitShort.ML",
};

export default function ReceivingPage() {
  const router = useRouter();
  const { t } = useI18n();
  const params = useParams();
  const poId = Number(params?.id);

  const [po, setPo] = useState<PurchaseOrderDTO | null>(null);
  const [received, setReceived] = useState<Record<number, number>>({});
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    if (!poId || Number.isNaN(poId)) {
      setError(t("customers.purchases.receive.invalidId"));
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await getPurchaseOrder(poId);
      setPo(data);
      const defaults: Record<number, number> = {};
      for (const line of data.lines) {
        defaults[line.id] = line.openQty ?? line.orderedQty;
      }
      setReceived(defaults);
    } catch (err) {
      setError(err instanceof Error && err.message === "UNAUTHORIZED" ? t("customers.purchases.receive.unauthorized") : err instanceof Error ? err.message : t("customers.purchases.receive.loadError"));
    } finally {
      setLoading(false);
    }
  }, [poId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const lines = po?.lines ?? [];

  const stats = useMemo(() => {
    let full = 0;
    let partial = 0;
    let totalReceived = 0;
    for (const line of lines) {
      const rec = received[line.id] ?? 0;
      totalReceived += rec;
      if (rec >= line.orderedQty) full += 1;
      else if (rec > 0) partial += 1;
    }
    return { full, partial, totalReceived };
  }, [lines, received]);

  async function handlePost() {
    if (posting || !po) return;
    const sessionLines = lines
      .map((line) => ({ purchaseOrderLineId: line.id, receivedQty: received[line.id] ?? 0 }))
      .filter((l) => l.receivedQty > 0);
    if (sessionLines.length === 0) {
      setError(t("customers.purchases.receive.needQuantity"));
      setConfirming(false);
      return;
    }
    try {
      setPosting(true);
      setError(null);
      // Apply remaining decisions on short lines first.
      for (const line of lines) {
        const rec = received[line.id] ?? 0;
        const decision = decisions[line.id];
        if (rec < line.orderedQty && decision) {
          await setLineRemainingDecision(po.id, line.id, { remainingDecision: decision });
        }
      }
      const session = await createReceivingSession(po.id, { lines: sessionLines, note: note.trim() || null });
      await postReceivingSession(session.id);
      router.push("/inventory/supplier-purchases");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("customers.purchases.receive.postError"));
    } finally {
      setPosting(false);
      setConfirming(false);
    }
  }

  return (
    <InventorySubPage intent="standard"
      title={t("customers.purchases.receive.title")}
      backHref="/inventory/supplier-purchases"
      sub={
        po
          ? (
            <>
              {t("customers.purchases.receive.orderLabel")} <b style={{ color: "var(--inv-text)" }}>#{po.externalOrderId || po.id}</b> · {po.supplierName || t("customers.purchases.confirm.noSupplier")} · {t("customers.purchases.receive.recordActual")}
            </>
          )
          : undefined
      }
      bottomNav="orders"
    >
      {error && !po ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel
            tone="error"
            title={t("customers.purchases.receive.loadFailedTitle")}
            action={<button type="button" className="inv-btn-primary inv-btn-primary--full" onClick={() => void load()}>{t("customers.purchases.receive.retry")}</button>}
          >
            {error}
          </InventoryStatePanel>
        </div>
      ) : loading ? (
        <div className="inv-olines">
          <InventorySkeletonBlock height={74} rows={3} />
        </div>
      ) : lines.length === 0 ? (
        <div className="inv-page-content" style={{ padding: "0 clamp(16px,3.5vw,28px)" }}>
          <InventoryStatePanel title={t("customers.purchases.receive.emptyTitle")}>{t("customers.purchases.receive.emptyBody")}</InventoryStatePanel>
        </div>
      ) : (
        <>
          <div className="inv-desk-workspace inv-receive-desk">
          <div className="inv-olines">
            {lines.map((line) => {
              const rec = received[line.id] ?? 0;
              const unitKey = line.unitType ? UNIT_SHORT[line.unitType] : undefined;
              const unit = unitKey ? t(unitKey) : "";
              const short = rec < line.orderedQty;
              const shortBy = line.orderedQty - rec;
              return (
                <InventoryOrderLine
                  key={line.id}
                  thumb={<span style={{ fontSize: 22 }}>{getProductEmoji(line.rawName || "")}</span>}
                  name={line.rawName || t("customers.purchases.receive.itemFallback", { id: line.id })}
                  sub={
                    short && rec > 0 ? (
                      <span style={{ color: "var(--inv-warning-ink)" }}>
                        {t("customers.purchases.receive.ordered")} <bdi>{line.orderedQty}</bdi> · {t("customers.purchases.receive.received")} <bdi>{rec}</bdi> — {t("customers.purchases.receive.shortBy")} <bdi>{shortBy}</bdi>
                      </span>
                    ) : (
                      <>{t("customers.purchases.receive.ordered")} <bdi>{line.orderedQty}{unit ? ` ${unit}` : ""}</bdi></>
                    )
                  }
                  trailing={
                    <MiniStepper
                      value={rec}
                      min={0}
                      onDecrement={() => setReceived((r) => ({ ...r, [line.id]: Math.max(0, rec - 1) }))}
                      onIncrement={() => setReceived((r) => ({ ...r, [line.id]: rec + 1 }))}
                    />
                  }
                  extra={
                    short ? (
                      <div style={{ width: "100%" }}>
                        <DecisionChips
                          choices={[
                            { label: t("customers.purchases.receive.keepOpen"), primary: decisions[line.id] === "KEEP_OPEN", onClick: () => setDecisions((d) => ({ ...d, [line.id]: "KEEP_OPEN" })) },
                            { label: t("customers.purchases.receive.backorder"), primary: decisions[line.id] === "BACKORDER", onClick: () => setDecisions((d) => ({ ...d, [line.id]: "BACKORDER" })) },
                            { label: t("customers.purchases.receive.closeShort"), primary: decisions[line.id] === "CLOSED_SHORT", onClick: () => setDecisions((d) => ({ ...d, [line.id]: "CLOSED_SHORT" })) },
                          ]}
                        />
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </div>

          <aside className="inv-ops__side">
            <h2>{t("customers.purchases.pending.side.title")}</h2>
            <p>{t("customers.purchases.receive.statsLine", { full: stats.full, partial: stats.partial })}</p>
            <p>{t("customers.purchases.receive.sideNote", { count: stats.totalReceived })}</p>
            <input className="inv-input" placeholder={t("customers.purchases.receive.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
            {error ? <div className="inv-alert inv-alert--error">{error}</div> : null}
          </aside>
          </div>

          <div className="inv-fwrap inv-receive-note">
            <input className="inv-input" placeholder={t("customers.purchases.receive.notePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} />
            {error ? <div className="inv-alert inv-alert--error" style={{ marginTop: 12 }}>{error}</div> : null}
          </div>

          <BottomActionBar
            label={t("customers.purchases.receive.statsLine", { full: stats.full, partial: stats.partial })}
            value={<BdiTemplate template={t("customers.purchases.receive.willEnter")} name="count" value={stats.totalReceived} />}
            cta={posting ? t("customers.purchases.receive.posting") : t("customers.purchases.receive.confirmCta")}
            ctaDisabled={posting}
            onCta={() => setConfirming(true)}
          />
        </>
      )}

      {confirming ? (
        <ConfirmModal
          title={t("customers.purchases.receive.modalTitle")}
          body={t("customers.purchases.receive.modalBody")}
          confirmLabel={posting ? t("customers.purchases.receive.posting") : t("customers.purchases.pending.approve")}
          onConfirm={() => void handlePost()}
          onCancel={() => setConfirming(false)}
          confirmDisabled={posting}
        />
      ) : null}
    </InventorySubPage>
  );
}
