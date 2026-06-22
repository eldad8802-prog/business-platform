"use client";

import type { ReactNode } from "react";
import { OrderWizardProvider } from "@/components/inventory/supplier-purchase-order/order-wizard-context";

export default function NewSupplierPurchaseLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <OrderWizardProvider>{children}</OrderWizardProvider>;
}
