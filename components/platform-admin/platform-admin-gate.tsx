"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PlatformAdminFetchError,
  fetchPlatformAdminSession,
} from "@/lib/platform-admin/fetch-platform-admin";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";
import { PA } from "./platform-admin-styles";
import { PlatformAdminSkeleton } from "./platform-admin-skeleton";

type GateState =
  | { kind: "loading" }
  | { kind: "forbidden"; message: string }
  | { kind: "ready"; session: PlatformAdminSessionResponse };

type PlatformAdminGateProps = {
  children: (session: PlatformAdminSessionResponse) => ReactNode;
};

export function PlatformAdminGate({ children }: PlatformAdminGateProps) {
  const router = useRouter();
  const [state, setState] = useState<GateState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem("token")
          : null;

      if (!token) {
        router.replace("/login");
        return;
      }

      try {
        const session = await fetchPlatformAdminSession();
        if (!cancelled) {
          setState({ kind: "ready", session });
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PlatformAdminFetchError) {
          if (error.status === 401) {
            window.localStorage.removeItem("token");
            router.replace("/login");
            return;
          }
          if (error.status === 403) {
            setState({
              kind: "forbidden",
              message: "אין לך הרשאת Platform Admin.",
            });
            return;
          }
        }
        setState({
          kind: "forbidden",
          message: "לא ניתן לאמת הרשאה. נסה שוב מאוחר יותר.",
        });
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state.kind === "loading") {
    return (
      <div style={{ padding: "24px 16px", maxWidth: PA.maxWidth, margin: "0 auto" }}>
        <p style={{ fontSize: 14, color: PA.inkMuted, marginBottom: 16 }}>
          בודק הרשאה…
        </p>
        <PlatformAdminSkeleton />
      </div>
    );
  }

  if (state.kind === "forbidden") {
    return (
      <div
        style={{
          minHeight: "60vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 400,
            textAlign: "center",
            padding: 24,
            borderRadius: PA.radius,
            border: `1px solid ${PA.border}`,
            background: PA.cardBg,
          }}
        >
          <h1 style={{ fontSize: 18, margin: "0 0 8px", color: PA.ink }}>
            גישה נדחתה
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: PA.inkSecondary }}>
            {state.message}
          </p>
        </div>
      </div>
    );
  }

  return <>{children(state.session)}</>;
}
