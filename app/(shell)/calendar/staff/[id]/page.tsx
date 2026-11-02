import { notFound } from "next/navigation";

import { StaffDetailScreen } from "@/features/calendar/staff-screen";

/** /calendar/staff/<id> — one staff member: details, hours, special days, services; behind the appointments flag. */
export default async function CalendarStaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  return <StaffDetailScreen id={Number(id)} />;
}
