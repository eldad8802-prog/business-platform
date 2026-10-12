import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "אימות כתובת האימייל", referrer: "no-referrer" };

export default function VerifyEmailLayout({ children }: { children: ReactNode }) {
  return children;
}
