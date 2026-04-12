"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const run = async () => {
      const token = localStorage.getItem("token");

      if (!token) {
        router.replace("/login");
        return;
      }

      try {
        const res = await fetch("/api/business/profile", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        });

        const data = await res.json();

        if (res.status === 401) {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          router.replace("/login");
          return;
        }

        if (!res.ok) {
          throw new Error(data?.error || "Failed to check business profile");
        }

        if (!data?.hasProfile) {
          router.replace("/onboarding");
          return;
        }

        router.replace("/pricing");
      } catch (err) {
        console.error("HOME_ENTRY_FLOW_ERROR:", err);
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        router.replace("/login");
      }
    };

    run();
  }, [router]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f8fafc",
        direction: "rtl",
        color: "#111827",
        fontSize: 18,
        fontWeight: 600,
      }}
    >
      טוען...
    </div>
  );
}