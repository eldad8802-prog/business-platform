"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/home", label: "בית" },
  { href: "/about", label: "אודות" },
  { href: "/contact", label: "צור קשר" },
];

/**
 * Corporate navigation links with active-state highlighting.
 * Used both in the desktop header row and the mobile drawer.
 */
export function CorporateNav({
  orientation = "horizontal",
  onNavigate,
}: {
  orientation?: "horizontal" | "vertical";
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav
      className={
        orientation === "vertical"
          ? "flex flex-col gap-1"
          : "flex items-center gap-1"
      }
    >
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
              active
                ? "bg-[var(--mkt-soft)] text-[var(--mkt-link)]"
                : "text-[var(--dz-text-muted)] hover:text-[var(--mkt-ink)]"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
