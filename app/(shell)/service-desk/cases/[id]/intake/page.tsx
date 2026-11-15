import { notFound } from "next/navigation";

import { IntakeScreen } from "@/features/service-desk/intake-screen";

/** 1.3b-C — the intake of one service case (data, photos, terms, signature, slip, history). */
export default async function ServiceIntakePage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <IntakeScreen caseId={id} />;
}
