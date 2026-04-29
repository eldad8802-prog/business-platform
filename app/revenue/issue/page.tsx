import { Suspense } from "react";
import IssueScreen from "@/components/revenue/issue/issue-screen";

export default function RevenueIssuePage() {
  return (
    <Suspense fallback={null}>
      <IssueScreen />
    </Suspense>
  );
}