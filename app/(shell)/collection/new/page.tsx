import { Suspense } from "react";
import { CollectionCreateScreen } from "@/components/collection/new/collection-create-screen";

export const metadata = { title: "גבייה חדשה" };

export default function CollectionNewPage() {
  return (
    <Suspense fallback={null}>
      <CollectionCreateScreen />
    </Suspense>
  );
}
