"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { InventorySubPage } from "@/components/inventory/inventory-shell";
import { inventoryTheme } from "@/components/inventory/inventory-design";
import { useModalDismiss } from "@/components/inventory/use-modal-dismiss";
import { useOrderWizard } from "./order-wizard-context";
import { orderWizardCss } from "./order-wizard.css";
import {
  OrderWizardAlerts,
  OrderWizardProgress,
  orderWizardProgressLabel,
} from "./order-wizard-ui";

export function OrderWizardShell({
  title,
  backHref,
  children,
  footer,
  showProgress = true,
}: {
  title: string;
  backHref: string;
  children: ReactNode;
  footer?: ReactNode;
  showProgress?: boolean;
}) {
  const pathname = usePathname() || "";
  const {
    loading,
    error,
    success,
    hasLocalDraft,
    hasUnsavedWork,
    restoreLocalDraft,
    clearLocalDraft,
    showExitGuard,
    setShowExitGuard,
    persistDraft,
    confirmExitAndGoBack,
  } = useOrderWizard();

  useModalDismiss({
    isOpen: showExitGuard,
    onClose: () => setShowExitGuard(false),
  });

  if (loading) {
    return (
      <InventorySubPage
        title={title}
        backHref={backHref}
        progressLabel={orderWizardProgressLabel(pathname)}
        bottomNav="orders"
      >
        <style>{orderWizardCss}</style>
        <div data-order-wizard>
          <div
            className="owz-state-card"
            style={{ textAlign: "center", color: inventoryTheme.textMuted }}
          >
            טוען נתונים...
          </div>
        </div>
      </InventorySubPage>
    );
  }

  return (
    <InventorySubPage
      title={title}
      backHref={backHref}
      progressLabel={orderWizardProgressLabel(pathname)}
      bottomNav="orders"
    >
      <style>{orderWizardCss}</style>

      <div data-order-wizard>
        {showProgress ? <OrderWizardProgress pathname={pathname} /> : null}

        <OrderWizardAlerts
          error={error}
          success={success}
          hasLocalDraft={hasLocalDraft}
          hasUnsavedWork={hasUnsavedWork}
          onRestoreDraft={restoreLocalDraft}
          onClearDraft={clearLocalDraft}
        />

        {children}
      </div>

      {footer}

      {showExitGuard ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setShowExitGuard(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            // Above the global BottomBar (z-index 100) so the exit guard is not
            // covered or click-intercepted by the bottom navigation.
            zIndex: 210,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <section
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 400,
              borderRadius: 20,
              background: "#ffffff",
              boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 950 }}>
              יש הזמנה בתהליך
            </div>
            <div
              style={{
                fontSize: 14,
                color: inventoryTheme.textMuted,
                lineHeight: 1.6,
              }}
            >
              לשמור את ההזמנה להמשך לפני יציאה?
            </div>
            <button
              type="button"
              onClick={() => {
                persistDraft();
                confirmExitAndGoBack();
              }}
              className="inv-action-btn inv-action-btn--primary"
            >
              שמור וצא
            </button>
            <button
              type="button"
              onClick={() => {
                clearLocalDraft();
                setShowExitGuard(false);
                confirmExitAndGoBack();
              }}
              className="inv-action-btn inv-action-btn--secondary"
            >
              צא בלי לשמור
            </button>
            <button
              type="button"
              onClick={() => setShowExitGuard(false)}
              className="inv-action-btn inv-action-btn--ghost"
            >
              המשך עריכה
            </button>
          </section>
        </div>
      ) : null}
    </InventorySubPage>
  );
}
