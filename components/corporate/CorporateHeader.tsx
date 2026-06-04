"use client";

import { useState } from "react";
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
    <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/90 backdrop-blur">
      <CorporateContainer className="flex h-16 items-center justify-between gap-3">
        <Link
          href="/home"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2 text-lg font-extrabold text-gray-900"
        >
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-[#eef7f2] text-[#1f7a5a]">
            D
          </span>
          Dubiz
        </Link>

        <div className="hidden items-center gap-2 sm:flex">
          <CorporateNav />
          <Link
            href="/login"
            className="rounded-2xl bg-[#1f7a5a] px-4 py-2.5 text-sm font-semibold text-white transition active:scale-[0.99]"
          >
            כניסה למערכת
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-2xl border border-gray-200 text-gray-700 sm:hidden"
          aria-label="תפריט"
          aria-expanded={open}
        >
          ☰
        </button>
      </CorporateContainer>

      {open ? (
        <div className="border-t border-gray-200 bg-white sm:hidden">
          <CorporateContainer className="flex flex-col gap-3 py-4">
            <CorporateNav
              orientation="vertical"
              onNavigate={() => setOpen(false)}
            />
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="rounded-2xl bg-[#1f7a5a] px-4 py-3 text-center text-sm font-semibold text-white"
            >
              כניסה למערכת
            </Link>
          </CorporateContainer>
        </div>
      ) : null}
    </header>
  );
}
