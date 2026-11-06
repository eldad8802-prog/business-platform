import { notFound } from "next/navigation";

import { CustomerDocumentsScreen } from "@/features/business-documents/customer-documents-screen";

export default async function CustomerDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  return <CustomerDocumentsScreen customerId={Number(id)} />;
}
