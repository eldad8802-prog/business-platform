"use client";

import { Suspense } from "react";
import { LandingPreviewScreen } from "@/components/business/landing/LandingPreviewScreen";

/**
 * P3-D — owner-only landing preview: /business/landing-preview?strategy=<server-issued strategy id>.
 * The page asks the server to (re)compose the blueprint for that strategy through the canonical P3-C
 * path and draws the server-built render model. Nothing is published; actions are never performed.
 */
export default function LandingPreviewPage() {
  return (
    <Suspense fallback={null}>
      <LandingPreviewScreen />
    </Suspense>
  );
}
