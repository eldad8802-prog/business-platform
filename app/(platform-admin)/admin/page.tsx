"use client";

import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { HomeSurface } from "@/components/platform-admin/console/home-surface";

export default function PlatformAdminPage() {
  return <AdminConsole title="סקירה">{() => <HomeSurface />}</AdminConsole>;
}
