"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { InvButton, InvError, InvLoading, InvNote, InvPage, InvSteps } from "@/components/inventory/v2/kit";
import { useOrderWizard } from "./order-wizard-context";

export const ORDER_WIZARD_STEPS = ["בחירה", "עגלה", "אישור"];

export function orderWizardStepIndex(pathname: string): number {
  if (pathname.endsWith("/confirm")) return 2;
  if (pathname.endsWith("/cart")) return 1;
  return 0;
}

/**
 * The order wizard frame on the inventory v2 kit: header with back, the three
 * steps, the saved-draft prompt and the wizard's error. The wizard's data and
 * logic stay in OrderWizardProvider (order-wizard-context.tsx), unchanged.
 */
export function OrderWizardShell({
  title,
  backFallback,
  children,
  footer,
  wide,
}: {
  title: string;
  backFallback: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const pathname = usePathname() || "";
  const {
    loading,
    items,
    error,
    success,
    setSuccess,
    hasLocalDraft,
    hasUnsavedWork,
    restoreLocalDraft,
    clearLocalDraft,
    reload,
  } = useOrderWizard();

  // A success line belongs to the step it happened on — never carried to the next step.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      setSuccess(null);
    }
  }, [pathname, setSuccess]);

  const step = orderWizardStepIndex(pathname);
  const failedToLoad = !loading && !!error && items.length === 0;

  return (
    <InvPage title={title} backFallback={backFallback} wide={wide} footer={loading || failedToLoad ? undefined : footer}>
      <InvSteps steps={ORDER_WIZARD_STEPS} current={step} />
      {loading ? (
        <InvLoading rows={4} />
      ) : failedToLoad ? (
        <InvError message={error} onRetry={reload} />
      ) : (
        <>
          {hasLocalDraft && !hasUnsavedWork ? (
            <InvNote>
              <div>יש טיוטת הזמנה שמורה במכשיר הזה.</div>
              <div className="i2-actions" style={{ marginTop: 8 }}>
                <InvButton small onClick={restoreLocalDraft}>
                  המשך מהטיוטה
                </InvButton>
                <InvButton small kind="secondary" onClick={clearLocalDraft}>
                  מחיקת הטיוטה
                </InvButton>
              </div>
            </InvNote>
          ) : null}
          {error ? <InvNote tone="danger">{error}</InvNote> : null}
          {success ? <InvNote tone="ok">{success}</InvNote> : null}
          {children}
        </>
      )}
    </InvPage>
  );
}
