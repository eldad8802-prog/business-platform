"use client";

import dynamic from "next/dynamic";
import { card } from "@/app/(shell)/documents/ui";

function ReviewLazyChunkFallback({ minHeight = 56 }: { minHeight?: number }) {
  return (
    <div
      aria-hidden
      style={{
        ...card,
        minHeight,
        width: "100%",
        boxSizing: "border-box",
      }}
    />
  );
}

export const ReviewFieldEditorLazy = dynamic(
  () => import("./ReviewFieldEditor"),
  {
    loading: () => <ReviewLazyChunkFallback minHeight={120} />,
  }
);

export const ReviewDocumentPreviewLazy = dynamic(
  () => import("./ReviewDocumentPreview"),
  {
    ssr: false,
    loading: () => <ReviewLazyChunkFallback minHeight={200} />,
  }
);

export const ReviewDoneStateLazy = dynamic(() => import("./ReviewDoneState"), {
  loading: () => <ReviewLazyChunkFallback minHeight={280} />,
});
