"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function getInitials(name: string): string {
  const t = name.trim();
  if (!t) return "?";
  const words = t.split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function isValidLogo(v: string | null): boolean {
  return (
    typeof v === "string" && /^data:image\/(png|jpeg|webp);base64,/i.test(v)
  );
}

export function GlobalBusinessAvatar({
  displayName,
  size = 44,
}: {
  displayName: string;
  size?: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);

  const load = useCallback(async () => {
    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/invoice-profile", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      const raw = data?.profile?.billingLogoDataUrl;
      setLogoUrl(typeof raw === "string" ? raw : null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function uploadLogo(dataUrl: string | null) {
    setBusy(true);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/invoice-profile", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ billingLogoDataUrl: dataUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data?.profile?.billingLogoDataUrl;
        setLogoUrl(typeof raw === "string" ? raw : null);
      }
    } finally {
      setBusy(false);
    }
  }

  function readFile(file: File | null) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string") void uploadLogo(r);
    };
    reader.readAsDataURL(file);
  }

  const hasLogo = isValidLogo(logoUrl);
  const initials = getInitials(displayName);

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-label="החלפת לוגו עסק"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          overflow: "hidden",
          border: "2px solid var(--dz-border)",
          padding: 0,
          cursor: busy ? "wait" : "pointer",
          background: hasLogo ? "var(--dz-surface-muted)" : "var(--dz-text-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        {hasLogo ? (
          <img
            src={logoUrl!}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <span
            style={{
              fontSize: size * 0.32,
              fontWeight: 700,
              color: "var(--dz-text-on-brand)",
              userSelect: "none",
            }}
          >
            {initials}
          </span>
        )}
        {hover ? (
          <span
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(52, 60, 50, 0.26)",
              color: "var(--dz-text-on-brand)",
              fontSize: 11,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {busy ? "…" : "לוגו"}
          </span>
        ) : null}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => readFile(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}
