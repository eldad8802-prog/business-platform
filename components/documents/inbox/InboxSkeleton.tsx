"use client";

import {
  SkeletonBlock,
  documentsShellCard,
  skeletonBar,
} from "@/components/documents/skeletons/skeleton-primitives";
import { TOKEN } from "@/lib/design/documents-theme";

export default function InboxSkeleton() {
  return (
    <SkeletonBlock>
      <section style={documentsShellCard()}>
        <div style={skeletonBar("40%", 16)} />
        <div style={{ ...skeletonBar("65%", 12), marginTop: 8 }} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 10,
            marginTop: 14,
          }}
        >
          {[0, 1].map((i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${TOKEN.border.DEFAULT}`,
                borderRadius: TOKEN.radius.input,
                padding: 12,
                textAlign: "center",
              }}
            >
              <div style={{ ...skeletonBar("55%", 12), margin: "0 auto" }} />
              <div style={{ ...skeletonBar("35%", 24), margin: "8px auto 0" }} />
            </div>
          ))}
        </div>
      </section>
      <section style={documentsShellCard()}>
        <div style={{ ...skeletonBar("45%", 14), marginBottom: 12 }} />
        <div style={{ ...skeletonBar("70%", 12), marginBottom: 10 }} />
        <div style={skeletonBar("35%")} />
      </section>
      <section style={documentsShellCard()}>
        <div style={{ ...skeletonBar("55%", 14), marginBottom: 12 }} />
        <div style={skeletonBar("80%")} />
      </section>
    </SkeletonBlock>
  );
}
