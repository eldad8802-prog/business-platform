"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { CorporateContainer } from "./CorporateContainer";
import { CorporateNav } from "./CorporateNav";

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
    <header className="sticky top-0 z-50 border-b border-[#E6ECF5] bg-white/90 backdrop-blur">
      <CorporateContainer className="flex h-16 items-center justify-between gap-3">
        <Link
          href="/home"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 text-lg font-extrabold text-gray-900"
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
          <Link
            href="/login"
            className="rounded-2xl bg-[#1E6BFF] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1557D9] active:scale-[0.99]"
          >
            כניסה למערכת
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-[#E6ECF5] text-[#0C2138] sm:hidden"
          aria-label="תפריט"
          aria-expanded={open}
        >
          ☰
        </button>
      </CorporateContainer>

      {open ? (
        <div className="border-t border-[#E6ECF5] bg-white sm:hidden">
          <CorporateContainer className="flex flex-col gap-3 py-4">
            <CorporateNav
              orientation="vertical"
              onNavigate={() => setOpen(false)}
            />
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-2xl bg-[#1E6BFF] px-4 py-3 text-center text-sm font-semibold text-white transition hover:bg-[#1557D9]"
            >
              כניסה למערכת
            </Link>
          </CorporateContainer>
        </div>
      ) : null}
    </header>
  );
}
