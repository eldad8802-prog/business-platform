import type { ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { AdminStepUpDialog } from "@/components/platform-admin/admin-step-up-dialog";

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
      {/* Answers the server's ADMIN_MFA_REQUIRED challenge for every
          privileged call made from this console. */}
      <AdminStepUpDialog />
    </div>
  );
}
