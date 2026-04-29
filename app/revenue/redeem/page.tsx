import { Suspense } from "react";
import RedeemScreen from "@/components/revenue/redeem/redeem-screen";

export default function RevenueRedeemPage() {
  return (
    <Suspense fallback={null}>
      <RedeemScreen />
    </Suspense>
  );
}