"use client";

import {
  SkeletonBlock,
  documentsShellCard,
  skeletonBar,
} from "./skeleton-primitives";
import { TOKEN } from "@/lib/design/documents-theme";

export default function DocumentsHubSkeleton() {
  return (
    <SkeletonBlock>
      <section style={documentsShellCard()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={skeletonBar("55%", 16)} />
            <div style={{ ...skeletonBar("70%", 12), marginTop: 10 }} />
          </div>
          <div
            style={{
              width: 74,
              height: 74,
              borderRadius: TOKEN.radius.pill,
              background: TOKEN.surface.inset,
              flexShrink: 0,
              animation: "documentsSkeletonPulse 1.2s ease-in-out infinite",
            }}
          />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 10,
            marginTop: 14,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${TOKEN.border.DEFAULT}`,
                borderRadius: TOKEN.radius.input,
                padding: 12,
                textAlign: "center",
              }}
            >
              <div style={{ ...skeletonBar("60%", 12), margin: "0 auto" }} />
              <div style={{ ...skeletonBar("40%", 22), margin: "8px auto 0" }} />
              <div style={{ ...skeletonBar("50%", 10), margin: "6px auto 0" }} />
            </div>
          ))}
        </div>
      </section>

      <section style={{ ...documentsShellCard(), textAlign: "center" }}>
        <div style={{ ...skeletonBar("70%", 18), margin: "0 auto" }} />
        <div style={{ ...skeletonBar("85%", 12), margin: "10px auto 0" }} />
        <div
          style={{
            ...skeletonBar("100%", 48),
            marginTop: 16,
            borderRadius: 9,
          }}
        />
      </section>

      <section style={documentsShellCard()}>
        <div style={skeletonBar("35%", 16)} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 10,
            marginTop: 12,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                border: `1px solid ${TOKEN.border.DEFAULT}`,
                borderRadius: TOKEN.radius.input,
                minHeight: 94,
                background: TOKEN.surface.inset,
              }}
            />
          ))}
        </div>
      </section>
    </SkeletonBlock>
  );
}
