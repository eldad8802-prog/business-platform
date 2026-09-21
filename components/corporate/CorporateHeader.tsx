"use client";

import { useCallback, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { CorporateContainer } from "./CorporateContainer";
import { CorporateNav } from "./CorporateNav";
import { MenuIcon, CloseIcon } from "./corporate-icons";
import { GhostCta } from "@/components/ui/primary-cta";
import { useAccessibleDialog } from "@/components/ui/accessibility";

/**
 * Corporate header: sticky top bar with brand, nav, and the existing-user login.
 * On mobile the nav collapses into a toggleable drawer.
 *
 * Two deliberate properties:
 *
 * 1. The login is a `GhostCta`, NOT a `PrimaryCta`. It used to render the filled
 *    teal primary skin, which put two visually identical primary buttons in the
 *    same viewport as the page's own CTA — pointing at different destinations.
 *    Exactly one saturated action is visible per screen; this is not it.
 *
 * 2. The drawer is a real dialog. It was previously a plain conditional div: no
 *    Escape, no focus trap, no focus restore — a keyboard user who opened it kept
 *    tabbing straight into the page behind it. `useAccessibleDialog` supplies all
 *    of that from the shared accessibility primitive rather than re-deriving it.
 *
 * The login remains a one-way outbound link to the existing /login route. It does
 * not modify login or auth in any way.
 */
export function CorporateHeader() {
  const [open, setOpen] = useState(false);

  // Stable identity: useAccessibleDialog keys effects off `onClose`, so an inline
  // arrow would re-run the focus/inert effects on every render.
  const close = useCallback(() => setOpen(false), []);

  const { dialogProps } = useAccessibleDialog<HTMLDivElement>({
    open,
    onClose: close,
    ariaLabel: "תפריט ניווט",
  });

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--mkt-border)] bg-[var(--dz-surface-translucent)] backdrop-blur">
      <CorporateContainer className="flex h-16 items-center justify-between gap-3">
        <Link
          href="/home"
          onClick={close}
          className="flex min-h-[44px] items-center gap-2 text-[var(--dz-text-primary)]"
        >
          <Image
            src="/dubiz-logo.png"
            alt="Dubiz"
            width={124}
            height={40}
            priority
            className="h-9 w-auto"
          />
        </Link>

        <div className="hidden items-center gap-2 sm:flex">
          <CorporateNav />
          <GhostCta href="/login">כניסה למערכת</GhostCta>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-[var(--mkt-border)] text-[var(--mkt-ink)] sm:hidden"
          aria-label={open ? "סגירת התפריט" : "תפריט"}
          aria-expanded={open}
          aria-controls="corporate-mobile-nav"
        >
          {open ? (
            <CloseIcon className="h-5 w-5" />
          ) : (
            <MenuIcon className="h-5 w-5" />
          )}
        </button>
      </CorporateContainer>

      {open ? (
        <div
          {...dialogProps}
          id="corporate-mobile-nav"
          className="border-t border-[var(--mkt-border)] dz-mist sm:hidden"
        >
          <CorporateContainer className="flex flex-col gap-3 py-4">
            <CorporateNav orientation="vertical" onNavigate={close} />
            <GhostCta href="/login" block onClick={close}>
              כניסה למערכת
            </GhostCta>
          </CorporateContainer>
        </div>
      ) : null}
    </header>
  );
}
