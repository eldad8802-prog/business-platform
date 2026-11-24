// 4a T3 — browser harness: the REAL DraftVatReviewPanel with the REAL Hebrew messages. Its /vat-review requests are
// answered by Playwright with the REAL services against the lab database (.billing-4a/t3-ui-harness.mts).
import { createRoot } from "react-dom/client";

import { DraftVatReviewPanel } from "@/components/billing/DraftVatReviewPanel";
import { I18nProvider } from "@/components/i18n/I18nProvider";

const w = window as unknown as { __DOC_ID: number };
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale="he">
    <div dir="rtl" style={{ maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "system-ui, Arial" }}>
      <h2 style={{ margin: "0 0 12px" }}>חשבונית מס — טיוטה</h2>
      <DraftVatReviewPanel documentId={w.__DOC_ID} authToken="lab" contentKey="1" />
      <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, color: "#555" }}>…שורות המסמך ופעולות ההפקה (מסך המסמך הקיים)…</div>
    </div>
  </I18nProvider>,
);
