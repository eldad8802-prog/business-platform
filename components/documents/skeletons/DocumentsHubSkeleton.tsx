"use client";

import {
  SkeletonBlock,
  skeletonBar,
} from "./skeleton-primitives";
import { TOKEN } from "@/lib/design/documents-theme";

/**
 * Loading placeholder for the Documents home. Mirrors the live layout —
 * Pulse card → capture Hero → three station rows — so the transition to real
 * content doesn't jump. Wired by the page in place of a misleading ₪0 render.
 */
export default function DocumentsHubSkeleton() {
  return (
    <SkeletonBlock style={{ gap: TOKEN.space.lg }}>
      {/* Pulse */}
      <section
        style={{
          background: TOKEN.surface.card,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          borderRadius: TOKEN.dsv1.radius.sheet,
          padding: TOKEN.space.xl,
          boxShadow: TOKEN.shadow.elevated,
        }}
      >
        <div style={skeletonBar("48%", 12)} />
        <div style={{ ...skeletonBar("40%", 26), marginTop: 8 }} />
        <div style={{ ...skeletonBar("100%", 9), marginTop: TOKEN.space.lg }} />
        <div style={{ display: "flex", gap: TOKEN.space.xl, marginTop: TOKEN.space.md }}>
          <div style={skeletonBar(120, 14)} />
          <div style={skeletonBar(120, 14)} />
        </div>
      </section>

      {/* Capture hero */}
      <section
        style={{
          borderRadius: TOKEN.dsv1.radius.sheet,
          padding: TOKEN.space.xl,
          background: TOKEN.surface.inset,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
        }}
      >
        <div style={skeletonBar("30%", 18)} />
        <div style={{ ...skeletonBar("55%", 20), marginTop: 12 }} />
        <div style={{ ...skeletonBar("75%", 12), marginTop: 8 }} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: TOKEN.space.md,
            marginTop: TOKEN.space.lg,
          }}
        >
          <div style={skeletonBar("100%", 50)} />
          <div style={skeletonBar("100%", 50)} />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: TOKEN.space.md,
            marginTop: TOKEN.space.md,
          }}
        >
          <div style={skeletonBar("100%", 44)} />
          <div style={skeletonBar("100%", 44)} />
        </div>
      </section>

      {/* Stations */}
      <div style={{ display: "flex", flexDirection: "column", gap: TOKEN.space.sm }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: TOKEN.space.lg,
              background: TOKEN.surface.card,
              border: `1px solid ${TOKEN.border.DEFAULT}`,
              borderRadius: TOKEN.radius.card,
              padding: `${TOKEN.space.md}px ${TOKEN.space.lg}px`,
              boxShadow: TOKEN.shadow.elevated,
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: TOKEN.radius.input,
                background: TOKEN.surface.inset,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={skeletonBar("40%", 14)} />
              <div style={{ ...skeletonBar("60%", 12), marginTop: 6 }} />
            </div>
          </div>
        ))}
      </div>
    </SkeletonBlock>
  );
}
