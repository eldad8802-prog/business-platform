"use client";

import { ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { layout, topBar, backBtn, topTitle } from "./ui";

export default function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const getTitle = () => {
    if (pathname === "/documents") return "מסמכים";
    if (pathname === "/documents/upload") return "העלאת מסמך";
    if (pathname.startsWith("/documents/review/")) return "בדיקת מסמך";
    if (pathname === "/documents/dashboard") return "מצב פיננסי";
    if (pathname === "/documents/search") return "חיפוש מסמכים";
    return "מסמכים";
  };

  const getBackTarget = () => {
    if (pathname === "/documents") return "/";
    return "/documents";
  };

  return (
    <div style={layout}>
      <div style={topBar}>
        <button
          onClick={() => router.push(getBackTarget())}
          style={backBtn}
          aria-label="חזרה"
        >
          ←
        </button>

        <div style={topTitle}>{getTitle()}</div>

        <div />
      </div>

      {children}
    </div>
  );
}