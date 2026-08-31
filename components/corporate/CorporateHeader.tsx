"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { CorporateContainer } from "./CorporateContainer";
import { CorporateNav } from "./CorporateNav";
import { PrimaryCta } from "@/components/ui/primary-cta";

/**
 * Corporate header: sticky top bar with brand, nav, and a single login CTA.
 * On mobile the nav collapses into a toggleable drawer.
 *
 * Note: the "כניסה למערכת" CTA is a one-way outbound link to the existing
 * /login route. It does not modify login or auth in any way.
 */
export function CorporateHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--mkt-border)] bg-[var(--dz-surface-translucent)] backdrop-blur">
      <CorporateContainer className="flex h-16 items-center justify-between gap-3">
        <Link
          href="/home"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 text-lg font-extrabold text-[var(--dz-text-primary)]"
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
          <PrimaryCta href="/login">כניסה למערכת</PrimaryCta>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-[var(--mkt-border)] text-[var(--mkt-ink)] sm:hidden"
          aria-label="תפריט"
          aria-expanded={open}
        >
          ☰
        </button>
      </CorporateContainer>

      {open ? (
        <div className="border-t border-[var(--mkt-border)] bg-[var(--dz-surface)] sm:hidden">
          <CorporateContainer className="flex flex-col gap-3 py-4">
            <CorporateNav
              orientation="vertical"
              onNavigate={() => setOpen(false)}
            />
            <PrimaryCta href="/login" block onClick={() => setOpen(false)}>
              כניסה למערכת
            </PrimaryCta>
          </CorporateContainer>
        </div>
      ) : null}
    </header>
  );
}
