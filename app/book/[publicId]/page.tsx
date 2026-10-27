import { BookingFlow } from "@/features/public-booking/booking-flow";

/** /book/<publicId> — a business's public booking link (Milestone C, segment 3). */
export default async function PublicBookingPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <BookingFlow publicId={publicId} />;
}
