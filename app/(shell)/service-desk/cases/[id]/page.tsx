import { notFound } from "next/navigation";

import { CaseScreen } from "@/features/service-desk/case-screen";

/** UI 1.3 — one service case: status and next action first, collapsible sections, history. */
export default async function ServiceCasePage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return <CaseScreen caseId={id} />;
}
