"use client";

/**
 * "הפקת מסמך" — the list of document types behind the one production button (stage 1, behind business_documents).
 * Each option opens a flow that already works (document-production-model.ts); the billing ones are handed back to
 * the invoices screen, which runs its own create flow (identity gate, draft) exactly as before.
 */
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { IconBox, IconFileCheck, IconMail, IconReceipt } from "@/components/navigation/nav-icons";
import { TOKEN } from "@/lib/design/billing-theme";

import {
  groupedProductionOptions,
  productionOptions,
  type ProductionBusinessKind,
} from "./document-production-model";
import s from "./document-production-sheet.module.css";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

/** The business kind from the existing invoice profile route (read only); unknown → null. */
function useBusinessKind(): ProductionBusinessKind {
  const [kind, setKind] = useState<ProductionBusinessKind>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/billing/invoice-profile", { headers: { Authorization: `Bearer ${getAuthToken()}` }, cache: "no-store" });
        if (!res.ok) return;
        const raw = (await res.json())?.profile?.billingBusinessKind;
        if (!cancelled && (raw === "EXEMPT_DEALER" || raw === "AUTHORIZED_DEALER" || raw === "LTD_COMPANY")) setKind(raw);
      } catch {
        /* unknown kind: the list shows what the screen shows today */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return kind;
}

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
  const businessKind = useBusinessKind();
  const groups = groupedProductionOptions(productionOptions({ businessKind }));

  const iconFor: Record<string, ReactNode> = {
    TAX_INVOICE: <IconReceipt size={20} />,
    QUOTE: <IconFileCheck size={20} />,
    LETTER: <IconMail size={20} />,
    SUPPLIER_ORDER: <IconBox size={20} />,
  };
  const row = (key: string) => (
    <>
      <span className={s.icon} aria-hidden>
        {iconFor[key]}
      </span>
      <span className={s.text}>
        <span className={s.name}>{t(`billing.production.option.${key}.title`)}</span>
        <span className={s.help} style={{ color: TOKEN.ink.secondary }}>
          {t(`billing.production.option.${key}.help`)}
        </span>
      </span>
    </>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-production-title"
      data-testid="document-production-sheet"
      className={s.backdrop}
      onClick={onClose}
    >
      <div className={s.panel} style={{ background: TOKEN.surface.card, color: TOKEN.ink.primary }} onClick={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <div>
            <h2 id="document-production-title" className={s.title}>
              {t("billing.production.title")}
            </h2>
            <p className={s.subtitle}>
              {customerName ? <><bdi>{t("billing.production.forCustomer", { name: customerName })}</bdi> </> : null}
              {t("billing.production.chooseType")}
            </p>
          </div>
          <button type="button" className={s.close} onClick={onClose} aria-label={t("billing.production.close")} data-testid="document-production-close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden focusable="false">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {groups.map((g) => (
          <section key={g.group} className={s.group}>
            <div className={s.groupTitle}>{t(`billing.production.group.${g.group}`)}</div>
            {g.options.map((o) =>
              o.kind === "billing" ? (
                <button key={o.key} type="button" data-option={o.key} className={s.row} onClick={() => onBillingDocument(o.key)}>
                  {row(o.key)}
                </button>
              ) : (
                <Link key={o.key} href={o.href} data-option={o.key} className={s.row}>
                  {row(o.key)}
                </Link>
              )
            )}
          </section>
        ))}

        <Link href="/business-documents" className={s.foot}>
          {t("billing.production.followUp")}
        </Link>
      </div>
    </div>
  );
}
