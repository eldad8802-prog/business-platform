"use client";

import { PageContainer } from "@/components/ui/page-container";

import { NotificationCenter } from "@/components/notifications/notification-center";

/**
 * The notification centre, as a route rather than a popover.
 *
 * One surface for every viewport. The authenticated shell has no top bar — its
 * chrome is a mobile bottom bar and a desktop side nav — so there is nowhere a
 * dropdown could hang from without inventing new chrome. A page costs nothing
 * on desktop, reads better on a phone than a cramped sheet, and is reachable by
 * URL, which a popover never is.
 *
 * "focused" width: this is a reading column, not a data table.
 */
export default function NotificationsPage() {
  return (
    <PageContainer intent="focused">
      <NotificationCenter />
    </PageContainer>
  );
}
