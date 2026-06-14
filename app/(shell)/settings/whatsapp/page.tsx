"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/ui/page-header";
import { TOKEN } from "@/lib/design/tokens";
import { useWhatsAppConnection } from "@/components/whatsapp/use-whatsapp-connection";
import { useEmbeddedSignup } from "@/components/whatsapp/use-embedded-signup";

/**
 * Dedicated WhatsApp screen.
 *
 * Ticket 1 — connection entry surface (intro + connected states).
 * Ticket 2 — adds the in-screen Readiness step (this file).
 *
 * Still UI-only: no Meta, no Embedded Signup, no token exchange, no backend.
 * "חבר WhatsApp" moves to the Readiness state; "אפשר להתחיל" is a placeholder
 * that only shows a note — the real secure window arrives in a later ticket.
 */
type View = "intro" | "readiness";

export default function WhatsAppSettingsPage() {
  const state = useWhatsAppConnection();
  const [view, setView] = useState<View>("intro");

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.page }}>
      <PageHeader title="המזכירה שלך" backHref="/tools" backLabel="חזרה" showBack />

      <main
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "16px 16px 96px",
          boxSizing: "border-box",
        }}
      >
        {state.phase === "loading" ? (
          <div style={{ marginTop: 24, color: TOKEN.ink.meta, fontSize: TOKEN.font.body }}>
            טוען…
          </div>
        ) : state.phase === "connected" ? (
          <ConnectedCard phone={state.connection.displayPhoneNumber} />
        ) : view === "readiness" ? (
          <ReadinessCard />
        ) : (
          <NotConnectedCard onConnect={() => setView("readiness")} />
        )}
      </main>
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function StatusPill({ label, tone }: { label: string; tone: "muted" | "success" }) {
  const palette =
    tone === "success"
      ? { bg: TOKEN.semantic.success.bg, ink: TOKEN.semantic.success.ink }
      : { bg: TOKEN.surface.inset, ink: TOKEN.ink.muted };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: palette.bg,
        color: palette.ink,
        borderRadius: TOKEN.radius.pill,
        padding: "4px 12px",
        fontSize: TOKEN.font.meta,
        fontWeight: TOKEN.weight.bold,
      }}
    >
      {label}
    </span>
  );
}

const cardStyle: React.CSSProperties = {
  marginTop: 16,
  background: TOKEN.surface.card,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 20,
};

const primaryButtonStyle: React.CSSProperties = {
  marginTop: 20,
  width: "100%",
  minHeight: 48,
  border: "none",
  borderRadius: TOKEN.radius.input,
  background: TOKEN.ink.primary,
  color: TOKEN.ink.inverse,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
  fontFamily: "inherit",
  cursor: "pointer",
};

// ─── intro (not connected) ───────────────────────────────────────────────────

function NotConnectedCard({ onConnect }: { onConnect: () => void }) {
  return (
    <section style={cardStyle}>
      <StatusPill label="לא מחובר" tone="muted" />

      <h1
        style={{
          margin: "12px 0 0",
          fontSize: TOKEN.font.hero,
          fontWeight: TOKEN.weight.bold,
          color: TOKEN.ink.primary,
          lineHeight: 1.3,
        }}
      >
        המזכירה שלך מתחילה לעבוד
      </h1>

      <p
        style={{
          margin: "10px 0 0",
          fontSize: TOKEN.font.body,
          color: TOKEN.ink.secondary,
          lineHeight: 1.6,
        }}
      >
        חבר את ה-WhatsApp העסקי שלך כדי להתחיל לקבל פניות, הצעות תשובה ותזכורות
        למעקב.
      </p>

      <button type="button" onClick={onConnect} style={primaryButtonStyle}>
        חבר WhatsApp
      </button>
    </section>
  );
}

// ─── readiness ───────────────────────────────────────────────────────────────

type Q1 = "yes" | "other" | null;
type Q2 = "yes" | "not_now" | null;

function OptionButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        flex: 1,
        minHeight: 46,
        borderRadius: TOKEN.radius.input,
        border: `1px solid ${selected ? TOKEN.border.strong : TOKEN.border.DEFAULT}`,
        background: selected ? TOKEN.ink.primary : TOKEN.surface.card,
        color: selected ? TOKEN.ink.inverse : TOKEN.ink.secondary,
        fontSize: TOKEN.font.body,
        fontWeight: TOKEN.weight.bold,
        fontFamily: "inherit",
        cursor: "pointer",
        padding: "0 12px",
      }}
    >
      {label}
    </button>
  );
}

function Question({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.semibold,
          color: TOKEN.ink.primary,
          lineHeight: 1.5,
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", gap: 10 }}>{children}</div>
    </div>
  );
}

type ConnectPhase = "idle" | "sending" | "connected" | "error";

function ReadinessCard() {
  const router = useRouter();
  const { phase, result, launch, reset } = useEmbeddedSignup();
  const [q1, setQ1] = useState<Q1>(null);
  const [q2, setQ2] = useState<Q2>(null);
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>("idle");
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const postedRef = useRef(false);

  // When Embedded Signup succeeds, hand the captured result to our backend
  // (Ticket 4). This is the first time `code` leaves the browser. It goes only
  // to our own API over HTTPS; it is never logged. The backend exchanges +
  // persists atomically and returns the sanitized connection (no token).
  useEffect(() => {
    if (phase !== "success" || !result || postedRef.current) return;
    postedRef.current = true;
    setConnectPhase("sending");
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    fetch("/api/integrations/whatsapp/embedded-signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        code: result.code,
        phoneNumberId: result.phoneNumberId,
        wabaId: result.wabaId,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          setConnectPhase("error");
          return;
        }
        const data = await res.json().catch(() => null);
        setConnectedPhone(data?.connection?.displayPhoneNumber ?? null);
        setConnectPhase("connected");
      })
      .catch(() => setConnectPhase("error"));
  }, [phase, result]);

  function retryConnect() {
    postedRef.current = false;
    setConnectPhase("idle");
    setConnectedPhone(null);
    reset();
  }

  // Connected — exchange + display + persist all succeeded on the backend.
  if (connectPhase === "connected") {
    return <ConnectedCard phone={connectedPhone ?? ""} />;
  }

  // Post-Embedded-Signup, before the connection resolves (or it failed).
  if (phase === "success") {
    if (connectPhase === "error") {
      return (
        <section style={cardStyle}>
          <StatusPill label="לא הושלם" tone="muted" />
          <h1
            style={{
              margin: "12px 0 0",
              fontSize: TOKEN.font.display,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
              lineHeight: 1.3,
            }}
          >
            לא הצלחנו להשלים את החיבור
          </h1>
          <p
            style={{
              margin: "10px 0 0",
              fontSize: TOKEN.font.body,
              color: TOKEN.ink.secondary,
              lineHeight: 1.6,
            }}
          >
            זה בדרך כלל זמני. אפשר לנסות שוב.
          </p>
          <button type="button" onClick={retryConnect} style={primaryButtonStyle}>
            נסה שוב
          </button>
        </section>
      );
    }
    // sending
    return (
      <section style={cardStyle}>
        <h1
          style={{
            margin: 0,
            fontSize: TOKEN.font.display,
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.primary,
            lineHeight: 1.3,
          }}
        >
          מחברים…
        </h1>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: TOKEN.font.body,
            color: TOKEN.ink.secondary,
            lineHeight: 1.6,
          }}
        >
          קיבלנו את האישור — מסדרים את הכל בשבילך.
        </p>
      </section>
    );
  }

  // "זה מספר אחר" → soft help state (replaces the questions).
  if (q1 === "other") {
    return (
      <section style={cardStyle}>
        <h1
          style={{
            margin: 0,
            fontSize: TOKEN.font.display,
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.primary,
            lineHeight: 1.3,
          }}
        >
          בוא נעשה סדר
        </h1>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: TOKEN.font.body,
            color: TOKEN.ink.secondary,
            lineHeight: 1.6,
          }}
        >
          אנחנו צריכים את המספר שבו הלקוחות שלך כותבים לך ביום-יום. אם יש לך כמה
          מספרים, כדאי לבחור את המספר שממנו מגיעות רוב הפניות.
        </p>
        <button
          type="button"
          onClick={() => setQ1(null)}
          style={primaryButtonStyle}
        >
          הבנתי, נמשיך
        </button>
      </section>
    );
  }

  const canStart = q1 === "yes" && q2 === "yes";

  return (
    <section style={cardStyle}>
      <h1
        style={{
          margin: 0,
          fontSize: TOKEN.font.display,
          fontWeight: TOKEN.weight.bold,
          color: TOKEN.ink.primary,
          lineHeight: 1.3,
        }}
      >
        רגע, רק נוודא שזה המספר הנכון
      </h1>

      <Question title="זה המספר שבו לקוחות פונים אליך ב-WhatsApp?">
        <OptionButton
          label="כן, זה המספר"
          selected={q1 === "yes"}
          onClick={() => setQ1("yes")}
        />
        <OptionButton
          label="זה מספר אחר"
          selected={false}
          onClick={() => setQ1("other")}
        />
      </Question>

      <Question title="הטלפון עם המספר הזה נמצא לידך עכשיו?">
        <OptionButton
          label="כן"
          selected={q2 === "yes"}
          onClick={() => setQ2("yes")}
        />
        <OptionButton
          label="לא כרגע"
          selected={q2 === "not_now"}
          onClick={() => setQ2("not_now")}
        />
      </Question>

      {q2 === "not_now" ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 14,
            background: TOKEN.surface.inset,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            borderRadius: TOKEN.radius.input,
            padding: "12px 14px",
          }}
        >
          <div
            style={{
              fontSize: TOKEN.font.body,
              color: TOKEN.ink.secondary,
              lineHeight: 1.5,
            }}
          >
            אין בעיה — נמשיך כשהטלפון לידך 🙂
          </div>
          <button
            type="button"
            onClick={() => router.back()}
            style={{
              marginTop: 8,
              border: "none",
              background: "transparent",
              color: TOKEN.ink.primary,
              fontSize: TOKEN.font.body,
              fontWeight: TOKEN.weight.bold,
              fontFamily: "inherit",
              cursor: "pointer",
              padding: 0,
            }}
          >
            אחזור לזה אחר כך
          </button>
        </div>
      ) : null}

      {(() => {
        const ready = canStart && phase !== "launching";
        return (
          <button
            type="button"
            disabled={!ready}
            onClick={() => void launch()}
            style={{
              ...primaryButtonStyle,
              background: ready ? TOKEN.ink.primary : TOKEN.ink.disabled,
              cursor: ready ? "pointer" : "not-allowed",
            }}
          >
            {phase === "launching" ? "פותחים חלון מאובטח…" : "אפשר להתחיל"}
          </button>
        );
      })()}

      {phase === "cancelled" || phase === "error" ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 12,
            background: TOKEN.semantic.info.bgSoft,
            border: `1px solid ${TOKEN.semantic.info.border}`,
            color: TOKEN.semantic.info.ink,
            borderRadius: TOKEN.radius.input,
            padding: "10px 12px",
            fontSize: TOKEN.font.body,
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          {phase === "cancelled"
            ? "לא הושלם. אפשר לנסות שוב."
            : "משהו השתבש. נסה שוב."}
        </div>
      ) : null}

      <p
        style={{
          margin: "14px 0 0",
          fontSize: TOKEN.font.meta,
          color: TOKEN.ink.muted,
          lineHeight: 1.5,
          textAlign: "center",
        }}
      >
        הטלפון שלך ממשיך לעבוד כרגיל.
      </p>
    </section>
  );
}

// ─── connected ───────────────────────────────────────────────────────────────

function ConnectedCard({ phone }: { phone: string }) {
  return (
    <section style={cardStyle}>
      <StatusPill label="מחובר" tone="success" />

      <h1
        style={{
          margin: "12px 0 0",
          fontSize: TOKEN.font.hero,
          fontWeight: TOKEN.weight.bold,
          color: TOKEN.ink.primary,
          lineHeight: 1.3,
        }}
      >
        המזכירה שלך עובדת
      </h1>

      <p
        style={{
          margin: "10px 0 0",
          fontSize: TOKEN.font.body,
          color: TOKEN.ink.secondary,
          lineHeight: 1.6,
        }}
      >
        פניות חדשות מהמספר {phone} יופיעו אצלך בשיחות. הטלפון שלך ממשיך לעבוד
        כרגיל.
      </p>
    </section>
  );
}
