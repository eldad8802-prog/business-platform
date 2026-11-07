import { notFound } from "next/navigation";

import { QuoteShareScreen } from "@/features/business-documents/quote-share-screen";

export default async function QuoteSharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  return <QuoteShareScreen quoteId={Number(id)} />;
}
