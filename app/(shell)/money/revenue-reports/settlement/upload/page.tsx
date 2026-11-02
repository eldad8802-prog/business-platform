import { RevenueReportUploadScreen } from "@/features/revenue-reports/upload-screen";

/** /money/revenue-reports/settlement/upload — upload a card settlement report (behind settlement_report_upload). */
export default function SettlementReportUploadPage() {
  return <RevenueReportUploadScreen kind="settlement" />;
}
