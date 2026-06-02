import { PlatformAdminSkeleton } from "@/components/platform-admin/platform-admin-skeleton";
import { PA } from "@/components/platform-admin/platform-admin-styles";

export default function PlatformAdminLoading() {
  return (
    <div
      style={{
        padding: "24px 16px",
        maxWidth: PA.maxWidth,
        margin: "0 auto",
      }}
    >
      <PlatformAdminSkeleton />
    </div>
  );
}
