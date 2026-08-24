import type { Metadata } from "next";
import type { ReactNode } from "react";

// The login page is a client component and cannot export metadata; this server
// layout carries the tab title ("התחברות · Dubiz") and passes children through.
export const metadata: Metadata = { title: "התחברות" };

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
