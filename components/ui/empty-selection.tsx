import type { ReactNode } from "react";

/**
 * Calm placeholder for a detail region with no selection (e.g. desktop
 * Master–Detail before a row is chosen). Structural + prop-driven; carries no
 * design tokens of its own — it inherits color from its container, using opacity
 * for the muted secondary text. Never a warning, never a KPI, never a CTA (the
 * primary action lives in the master, not here).
 */
export function EmptySelection({
  icon,
  title,
  description,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 240,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "40px 24px",
        gap: 10,
      }}
    >
      {icon ? <div style={{ opacity: 0.5, marginBottom: 2 }} aria-hidden>{icon}</div> : null}
      <div style={{ fontSize: 16, fontWeight: 600, opacity: 0.85 }}>{title}</div>
      {description ? (
        <div style={{ fontSize: 14, lineHeight: 1.55, opacity: 0.6, maxWidth: 300 }}>
          {description}
        </div>
      ) : null}
    </div>
  );
}
