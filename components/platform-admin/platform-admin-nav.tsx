"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PA } from "./platform-admin-styles";

const LINKS = [
  { href: "/admin", label: "לוח בקרה" },
  { href: "/admin/audit", label: "יומן ביקורת" },
] as const;

export function PlatformAdminNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="ניווט Platform Admin"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: 20,
      }}
    >
      {LINKS.map((link) => {
        const active =
          link.href === "/admin"
            ? pathname === "/admin"
            : pathname?.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            style={{
              fontSize: 13,
              padding: "6px 12px",
              borderRadius: 8,
              textDecoration: "none",
              border: `1px solid ${active ? PA.inkMuted : PA.border}`,
              background: active ? PA.pageBg : PA.cardBg,
              color: active ? PA.ink : PA.inkMuted,
              fontWeight: active ? 600 : 400,
            }}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
