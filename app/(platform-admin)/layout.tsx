import type { ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";

export const metadata = {
  title: "Platform Admin",
  description: "Operational control surface for platform operators",
};

export default function PlatformAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      dir="rtl"
      lang="he"
      style={{
        minHeight: "100vh",
        background: TOKEN.surface.page,
        color: TOKEN.ink.primary,
      }}
    >
      {children}
    </div>
  );
}
