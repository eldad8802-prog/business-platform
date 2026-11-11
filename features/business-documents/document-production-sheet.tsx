"use client";

/**
 * "הפקת מסמך" — the list of document types behind the one production button (stage 1, behind business_documents).
 * Each option opens a flow that already works (document-production-model.ts); the billing ones are handed back to
 * the invoices screen, which runs its own create flow (identity gate, draft) exactly as before.
 */
import Link from "next/link";

import { useI18n } from "@/components/i18n/I18nProvider";
import { TOKEN } from "@/lib/design/billing-theme";

import { groupedProductionOptions, productionOptions } from "./document-production-model";
import { useBusinessKind } from "./use-business-kind";

export function DocumentProductionSheet({
  customerName,
  onClose,
  onBillingDocument,
}: {
  customerName: string | null;
  onClose: () => void;
  onBillingDocument: (type: "TAX_INVOICE" | "QUOTE") => void;
}) {
  const { t } = useI18n();
  // undefined (still loading) lists what the screen shows today; the server still refuses an exempt tax invoice
  const businessKind = useBusinessKind() ?? null;
  const groups = groupedProductionOptions(productionOptions({ businessKind }));

  const rowStyle = {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-start",
    gap: 2,
    width: "100%",
    textAlign: "start" as const,
    padding: "12px 14px",
    borderRadius: 14,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    background: TOKEN.surface.card,
    color: TOKEN.ink.primary,
    textDecoration: "none",
    cursor: "pointer",
    font: "inherit",
    boxSizing: "border-box" as const,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("billing.production.title")}
      data-testid="document-production-sheet"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(35, 48, 43, 0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 130, padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 480, maxHeight: "calc(100dvh - 32px)", overflowY: "auto", background: TOKEN.surface.card, borderRadius: 18, padding: 20, display: "flex", flexDirection: "column", gap: 14, boxShadow: TOKEN.shadow.floating }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: TOKEN.ink.primary }}>{t("billing.production.title")}</h2>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: TOKEN.ink.muted }}>
            {customerName ? <><bdi>{t("billing.production.forCustomer", { name: customerName })}</bdi> </> : null}
            {t("billing.production.chooseType")}
          </p>
        </div>

        {groups.map((g) => (
          <section key={g.group} style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted }}>{t(`billing.production.group.${g.group}`)}</div>
            {g.options.map((o) =>
              o.kind === "billing" ? (
                <button key={o.key} type="button" data-option={o.key} style={rowStyle} onClick={() => onBillingDocument(o.key)}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{t(`billing.production.option.${o.key}.title`)}</span>
                  <span style={{ fontSize: 12, color: TOKEN.ink.secondary }}>{t(`billing.production.option.${o.key}.help`)}</span>
                </button>
              ) : (
                <Link key={o.key} href={o.href} data-option={o.key} style={rowStyle}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{t(`billing.production.option.${o.key}.title`)}</span>
                  <span style={{ fontSize: 12, color: TOKEN.ink.secondary }}>{t(`billing.production.option.${o.key}.help`)}</span>
                </Link>
              )
            )}
          </section>
        ))}

        <Link href="/business-documents" style={{ fontSize: 13, color: TOKEN.ink.secondary, textAlign: "center" }}>
          {t("billing.production.followUp")}
        </Link>
        <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", color: TOKEN.ink.muted, fontSize: 13, cursor: "pointer", padding: 6 }}>
          {t("billing.production.close")}
        </button>
      </div>
    </div>
  );
}
