"use client";

import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import { PA } from "./platform-admin-styles";

type HealthStatus = "ok" | "partial" | "error" | "unknown";

type PlatformAdminHeaderProps = {
  session: PlatformAdminSessionResponse;
  generatedAt: string | null;
  healthStatus: HealthStatus;
  onRefresh: () => void;
  refreshing: boolean;
};

function formatGeneratedAt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("he-IL", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function healthColor(status: HealthStatus): string {
  switch (status) {
    case "ok":
      return PA.success.accent;
    case "partial":
      return PA.attention.accent;
    case "error":
      return PA.urgent.accent;
    default:
      return PA.inkMeta;
  }
}

export function PlatformAdminHeader({
  session,
  generatedAt,
  healthStatus,
  onRefresh,
  refreshing,
}: PlatformAdminHeaderProps) {
  return (
    <header
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        paddingBottom: 8,
        borderBottom: `1px solid ${PA.border}`,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            title="מצב טעינת נתונים"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: healthColor(healthStatus),
              flexShrink: 0,
            }}
          />
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 700,
              color: PA.ink,
              letterSpacing: "-0.02em",
            }}
          >
            Platform Admin
          </h1>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: PA.inkMuted }}>
          {session.admin.email}
          <span style={{ margin: "0 8px", color: PA.inkMeta }}>·</span>
          <span
            style={{
              textTransform: "lowercase",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
            }}
          >
            {session.environment}
          </span>
        </p>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: PA.inkMeta }}>
          עודכן: {formatGeneratedAt(generatedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        style={{
          border: `1px solid ${PA.border}`,
          background: PA.cardBg,
          borderRadius: 8,
          padding: "8px 14px",
          fontSize: 13,
          color: PA.ink,
          cursor: refreshing ? "wait" : "pointer",
          opacity: refreshing ? 0.7 : 1,
        }}
      >
        {refreshing ? "מרענן…" : "רענן"}
      </button>
    </header>
  );
}
