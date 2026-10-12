import type { Metadata } from "next";
import type { ReactNode } from "react";

// The link's secret lives in the URL fragment; `no-referrer` keeps even the page URL out of any
// request this page makes to another origin.
export const metadata: Metadata = { title: "בחירת סיסמה חדשה", referrer: "no-referrer" };

export default function ResetPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
