"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BILLING_BUSINESS_KIND_LABELS,
  type BillingBusinessKind,
} from "@/lib/billing/business-identity";
import { TOKEN } from "@/lib/design/billing-theme";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type IssuerMini = {
  billingLegalName: string | null;
  billingTaxId: string | null;
  billingLogoDataUrl: string | null;
  billingBusinessKind: string | null;
};

function getInitials(name: string | null): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2);
  return words[0][0] + words[1][0];
}

function isValidLogo(v: string | null): boolean {
  return typeof v === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v);
}

export function IssuerSummaryBadge() {
  const [data, setData] = useState<IssuerMini | null | "loading">("loading");

  useEffect(() => {
    const token = getAuthToken();
    fetch("/api/billing/invoice-profile", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) {
          setData(null);
          return;
        }
        const p = j?.profile ?? {};
        setData({
          billingLegalName: p.billingLegalName ?? null,
          billingTaxId: p.billingTaxId ?? null,
          billingLogoDataUrl: p.billingLogoDataUrl ?? null,
          billingBusinessKind: p.billingBusinessKind ?? null,
        });
      })
      .catch(() => setData(null));
  }, []);

  if (data === "loading") {
    return (
      <div
        aria-busy="true"
        style={{
          borderRadius: 10,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.inset,
          padding: "10px 14px",
          fontSize: 13,
          color: TOKEN.ink.meta,
        }}
      >
        בודקים את פרטי העסק למסמך…
      </div>
    );
  }

  const isEmpty = !data || (!data.billingLegalName && !data.billingTaxId);

  if (isEmpty) {
    return (
      <div
        style={{
          borderRadius: 10,
          border: `1px solid ${TOKEN.semantic.attention.border}`,
          background: TOKEN.semantic.attention.bg,
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, color: TOKEN.semantic.attention.ink }}>
          פרטי העסק למסמכים עדיין לא הוגדרו
        </span>
        <Link
          href="/business"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: TOKEN.semantic.attention.ink,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          הגדרות עסק ←
        </Link>
      </div>
    );
  }

  const hasLogo = isValidLogo(data.billingLogoDataUrl);
  const initials = getInitials(data.billingLegalName);
  const hasTaxId = !!data.billingTaxId;

  return (
    <div
      style={{
        borderRadius: 10,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        background: TOKEN.surface.inset,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          overflow: "hidden",
          flexShrink: 0,
          background: hasLogo ? TOKEN.surface.inset : TOKEN.ink.primary,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${TOKEN.border.DEFAULT}`,
        }}
      >
        {hasLogo ? (
          <img
            src={data.billingLogoDataUrl!}
            alt="לוגו"
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <span style={{ fontSize: 10, fontWeight: 600, color: TOKEN.ink.inverse, userSelect: "none" }}>
            {initials}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: TOKEN.ink.primary }}>
          {data.billingLegalName || "שם העסק לא הוגדר"}
        </div>
        {data.billingBusinessKind &&
        BILLING_BUSINESS_KIND_LABELS[data.billingBusinessKind as BillingBusinessKind] ? (
          <div style={{ fontSize: 11, color: TOKEN.ink.muted }}>
            {
              BILLING_BUSINESS_KIND_LABELS[
                data.billingBusinessKind as BillingBusinessKind
              ]
            }
          </div>
        ) : null}
        {hasTaxId ? (
          <div style={{ fontSize: 11, color: TOKEN.ink.muted, direction: "ltr", textAlign: "right" }}>
            ע.מ. / ח.פ. {data.billingTaxId}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: TOKEN.semantic.attention.ink, fontWeight: 600 }}>
            מספר עוסק לא הוגדר
          </div>
        )}
      </div>

      <Link
        href="/business"
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: TOKEN.ink.secondary,
          textDecoration: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        עריכת פרטי עסק ←
      </Link>
    </div>
  );
}
