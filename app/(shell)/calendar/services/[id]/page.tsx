import { notFound } from "next/navigation";

import { ServiceDetailScreen } from "@/features/calendar/services-screen";

/** /calendar/services/<id> — one service: name, length, who performs it, booking rules; behind the appointments flag. */
export default async function CalendarServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  return <ServiceDetailScreen id={Number(id)} />;
}
