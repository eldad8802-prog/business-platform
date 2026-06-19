"use client";

import { basePageStyle, mainStyle, reviewCard } from "@/components/documents/review/review-ui";
import { SkeletonBlock, skeletonBar } from "./skeleton-primitives";

export default function DocumentsReviewSkeleton() {
  return (
    <div dir="rtl" style={basePageStyle()}>
      <main style={mainStyle()}>
        <SkeletonBlock>
          <div style={{ textAlign: "center", padding: "34px 0 8px" }}>
            <div style={{ ...skeletonBar(58, 58), margin: "0 auto 18px", borderRadius: 18 }} />
            <div style={{ ...skeletonBar("42%", 34), margin: "0 auto" }} />
            <div style={{ ...skeletonBar("58%", 16), margin: "14px auto 0" }} />
          </div>
          <div style={reviewCard}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
              <div style={{ ...skeletonBar("100%", 360), borderRadius: 20 }} />
              <div>
                <div style={skeletonBar("40%", 18)} />
                <div style={{ ...skeletonBar("100%", 54), marginTop: 16, borderRadius: 16 }} />
                <div style={{ ...skeletonBar("100%", 54), marginTop: 10, borderRadius: 16 }} />
                <div style={{ ...skeletonBar("100%", 54), marginTop: 10, borderRadius: 16 }} />
              </div>
            </div>
          </div>
        </SkeletonBlock>
      </main>
    </div>
  );
}
