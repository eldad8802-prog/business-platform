"use client";

import DocumentsHeader from "@/components/documents/DocumentsHeader";
import { card } from "@/app/(shell)/documents/ui";
import {
  SkeletonBlock,
  skeletonBar,
} from "./skeleton-primitives";

const mainStyle = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "14px 14px 40px",
  boxSizing: "border-box" as const,
};

const basePageStyle = {
  minHeight: "100vh",
  background: "#f3f7ff",
};

export default function DocumentsReviewSkeleton() {
  return (
    <div dir="rtl" style={basePageStyle}>
      <DocumentsHeader title="בדיקת מסמך" />
      <main style={mainStyle}>
        <SkeletonBlock>
          <div style={card}>
            <div style={{ ...skeletonBar("50%", 20), margin: "0 auto" }} />
            <div style={{ ...skeletonBar("75%", 14), margin: "12px auto 0" }} />
          </div>
          <div style={card}>
            <div style={skeletonBar("40%", 16)} />
            <div style={{ ...skeletonBar("100%", 12), marginTop: 14 }} />
            <div style={{ ...skeletonBar("90%", 12), marginTop: 8 }} />
            <div
              style={{
                ...skeletonBar("100%", 44),
                marginTop: 16,
                borderRadius: 14,
              }}
            />
            <div
              style={{
                ...skeletonBar("100%", 44),
                marginTop: 10,
                borderRadius: 14,
              }}
            />
          </div>
        </SkeletonBlock>
      </main>
    </div>
  );
}
