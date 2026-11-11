"use client";

/**
 * "הפקת מסמך" — the list of document types behind the one production button (stage 1, behind business_documents).
 * Each option opens a flow that already works (document-production-model.ts); the billing ones are handed back to
 * the invoices screen, which runs its own create flow (identity gate, draft) exactly as before.
 */
import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { IconBox, IconFileCheck, IconMail, IconReceipt } from "@/components/navigation/nav-icons";
import { TOKEN } from "@/lib/design/billing-theme";

import { productionOptions, type ProductionBusinessKind, type ProductionOption } from "./document-production-model";
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
  const options = productionOptions({ businessKind });
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // While open: the page behind does not scroll, focus starts on the close button and stays inside the panel
  // (Tab / Shift+Tab wrap, Escape closes); on close, focus goes back to the button that opened the panel.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const html = document.documentElement;
    const prev = { body: document.body.style.overflow, html: html.style.overflow };
    document.body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panelRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev.body;
      html.style.overflow = prev.html;
      const back = opener && document.contains(opener) ? opener : document.querySelector<HTMLElement>('[data-testid="document-production-button"]');
      back?.focus();
    };
  }, []);

  const iconFor: Record<ProductionOption["key"], ReactNode> = {
    TAX_INVOICE: <IconReceipt size={20} />,
    QUOTE: <IconFileCheck size={20} />,
    LETTER: <IconMail size={20} />,
    SUPPLIER_ORDER: <IconBox size={20} />,
  };
  const row = (key: ProductionOption["key"]) => (
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

  // rendered into <body>: the page content is its own stacking context (shell-content, z-index 1), under the fixed
  // bottom bar — inside it the backdrop could not cover the bar
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-production-title"
      data-testid="document-production-sheet"
      className={s.backdrop}
      onClick={onClose}
    >
      <div ref={panelRef} className={s.panel} style={{ background: TOKEN.surface.card, color: TOKEN.ink.primary }} onClick={(e) => e.stopPropagation()}>
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
          <button ref={closeRef} type="button" className={s.close} onClick={onClose} aria-label={t("billing.production.close")} data-testid="document-production-close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden focusable="false">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className={s.list}>
          {options.map((o) =>
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
        </div>

        <Link href="/business-documents" className={s.foot}>
          {t("billing.production.followUp")}
        </Link>
      </div>
    </div>,
    document.body
  );
}
