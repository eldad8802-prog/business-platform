"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Read-only status cards for existing integrations (Settings → Connections).
 *
 * These cards ONLY read connection status from routes that already exist:
 *   GET /api/integrations/gmail/status               → { connected, emailAddress? }
 *   GET /api/integrations/whatsapp/connection        → { connection: {...} | null }
 *
 * They do NOT connect, disconnect, or mutate anything. Each card links to the
 * feature screen that already owns that integration's connect flow.
 */

type CardStatus = "loading" | "connected" | "disconnected" | "error";

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

const STATUS_LABEL: Record<Exclude<CardStatus, "loading">, string> = {
  connected: "מחובר",
  disconnected: "לא מחובר",
  error: "שגיאה",
};

function StatusBadge({ status }: { status: CardStatus }) {
  if (status === "loading") {
    return (
      <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-400">
        טוען…
      </span>
    );
  }
  const tone =
    status === "connected"
      ? "bg-emerald-50 text-emerald-700"
      : status === "error"
        ? "bg-red-50 text-red-700"
        : "bg-gray-100 text-gray-500";
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-bold ${tone}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

type CardProps = {
  title: string;
  description: string;
  status: CardStatus;
  detail?: string | null;
  manageHref: string;
};

function IntegrationCard({
  title,
  description,
  status,
  detail,
  manageHref,
}: CardProps) {
  return (
    <section className="rounded-[24px] bg-white p-4 shadow-sm" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        <StatusBadge status={status} />
      </div>
      <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>

      {status === "connected" && detail ? (
        <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
          {detail}
        </div>
      ) : null}

      {status === "error" ? (
        <p className="mt-3 text-xs leading-5 text-red-600">
          לא הצלחנו לבדוק את מצב החיבור כרגע.
        </p>
      ) : null}

      <div className="mt-3">
        <Link
          href={manageHref}
          className="inline-flex min-h-11 items-center rounded-2xl border border-gray-200 px-4 text-sm font-semibold text-gray-700"
        >
          נהל חיבור
        </Link>
      </div>
    </section>
  );
}

export function IntegrationStatusCards() {
  const [whatsapp, setWhatsapp] = useState<CardStatus>("loading");
  const [whatsappDetail, setWhatsappDetail] = useState<string | null>(null);
  const [gmail, setGmail] = useState<CardStatus>("loading");
  const [gmailDetail, setGmailDetail] = useState<string | null>(null);

  useEffect(() => {
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    let cancelled = false;

    async function loadGmail() {
      try {
        const res = await fetch("/api/integrations/gmail/status", {
          headers,
          cache: "no-store",
        });
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        if (cancelled) return;
        if (data?.connected) {
          setGmail("connected");
          setGmailDetail(
            data.emailAddress ? `חשבון מקושר: ${data.emailAddress}` : null
          );
        } else {
          setGmail("disconnected");
        }
      } catch {
        if (!cancelled) setGmail("error");
      }
    }

    async function loadWhatsapp() {
      try {
        const res = await fetch("/api/integrations/whatsapp/connection", {
          headers,
          cache: "no-store",
        });
        if (!res.ok) throw new Error("bad status");
        const data = await res.json();
        if (cancelled) return;
        const conn = data?.connection;
        if (conn && conn.status === "CONNECTED") {
          setWhatsapp("connected");
          setWhatsappDetail(
            conn.displayPhoneNumber ? `מספר מקושר: ${conn.displayPhoneNumber}` : null
          );
        } else if (conn && conn.status === "ERROR") {
          setWhatsapp("error");
        } else {
          setWhatsapp("disconnected");
        }
      } catch {
        if (!cancelled) setWhatsapp("error");
      }
    }

    void loadGmail();
    void loadWhatsapp();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <IntegrationCard
        title="וואטסאפ"
        description="חיבור חשבון WhatsApp Business לקבלת הודעות ופעולות בוט."
        status={whatsapp}
        detail={whatsappDetail}
        manageHref="/settings/whatsapp"
      />
      <IntegrationCard
        title="Gmail"
        description="חיבור תיבת Gmail לייבוא מסמכים ומיילים נכנסים."
        status={gmail}
        detail={gmailDetail}
        manageHref="/documents/email"
      />
    </div>
  );
}
