"use client";

/** Subscriptions & quotas (subscriptions stage C) — businesses, quota matrix and modes, plan / quota requests. */
import { AdminConsole } from "@/components/platform-admin/console/admin-console";
import { SubscriptionsSurface } from "@/components/platform-admin/console/subscriptions-surface";

export default function PlatformAdminSubscriptionsPage() {
  return <AdminConsole title="מנויים ומכסות" backHref="/admin">{() => <SubscriptionsSurface />}</AdminConsole>;
}
