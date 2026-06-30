"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import {
  completeObligation,
  createObligation,
  fetchBriefing,
  markOriented,
  releaseObligation,
  snoozeObligation,
  type AttentionReason,
  type BriefingApi,
  type ObligationApi,
  type RecurrenceCadence,
} from "@/lib/obligations/secretary-client";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; briefing: BriefingApi };

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("he-IL")} ${currency}`;
  }
}

function formatDueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", {
    day: "numeric",
    month: "long",
    weekday: "long",
  });
}

function reasonLabel(reason: AttentionReason): { text: string; tier: "urgent" | "attention" } {
  switch (reason) {
    case "OVERDUE":
      return { text: "באיחור", tier: "urgent" };
    case "DUE_TODAY":
      return { text: "להיום", tier: "urgent" };
    case "DUE_SOON":
    default:
      return { text: "מתקרב", tier: "attention" };
  }
}

const RECURRENCE_LABEL: Record<RecurrenceCadence, string> = {
  NONE: "חד-פעמי",
  WEEKLY: "שבועי",
  MONTHLY: "חודשי",
  YEARLY: "שנתי",
};

export default function SecretaryPage() {
  const router = useRouter();
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [showCapture, setShowCapture] = useState(false);
  const [showWatching, setShowWatching] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load(tok: string) {
    setState({ status: "loading" });
    try {
      const briefing = await fetchBriefing(tok);
      setState({ status: "ready", briefing });
    } catch (e) {
      setState({ status: "error", message: errorMessage(e, "שגיאה בטעינה") });
    }
  }

  useEffect(() => {
    const tok =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!tok) {
      router.replace("/login");
      return;
    }
    tokenRef.current = tok;
    // Initial load. setState happens only after the await, so it does not run
    // synchronously within the effect body.
    let cancelled = false;
    (async () => {
      try {
        const briefing = await fetchBriefing(tok);
        if (!cancelled) setState({ status: "ready", briefing });
      } catch (e) {
        if (!cancelled) {
          setState({ status: "error", message: errorMessage(e, "שגיאה בטעינה") });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flashMessage(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 3200);
  }

  async function onComplete(o: ObligationApi) {
    const token = tokenRef.current;
    if (!token) return;
    setBusyId(o.id);
    try {
      const res = await completeObligation(token, o.id);
      flashMessage(
        res.nextInstance
          ? `סגרתי את "${o.obligeeName}". כבר זוכרת את הפעם הבאה.`
          : `סגרתי את "${o.obligeeName}". זה טופל.`
      );
      await load(token);
    } catch (e) {
      flashMessage(errorMessage(e, "לא הצלחתי לסגור"));
    } finally {
      setBusyId(null);
    }
  }

  async function onSnooze(o: ObligationApi, days: number) {
    const token = tokenRef.current;
    if (!token) return;
    setBusyId(o.id);
    try {
      const target = new Date();
      target.setDate(target.getDate() + days);
      await snoozeObligation(token, o.id, target.toISOString());
      flashMessage(`בסדר. אזכיר לך שוב כש"${o.obligeeName}" יתקרב.`);
      await load(token);
    } catch (e) {
      flashMessage(errorMessage(e, "לא הצלחתי לדחות"));
    } finally {
      setBusyId(null);
    }
  }

  async function onRelease(o: ObligationApi) {
    const token = tokenRef.current;
    if (!token) return;
    setBusyId(o.id);
    try {
      await releaseObligation(token, o.id);
      flashMessage(`הסרתי את "${o.obligeeName}". כבר לא במעקב.`);
      await load(token);
    } catch (e) {
      flashMessage(errorMessage(e, "לא הצלחתי להסיר"));
    } finally {
      setBusyId(null);
    }
  }

  async function onCapture(input: {
    obligeeName: string;
    amount: string;
    dueAt: string;
    recurrence: RecurrenceCadence;
    note: string;
  }) {
    const token = tokenRef.current;
    if (!token) return;
    await createObligation(token, {
      obligeeName: input.obligeeName,
      amount: input.amount,
      dueAt: new Date(input.dueAt).toISOString(),
      recurrence: input.recurrence,
      note: input.note || null,
    });
    flashMessage(`מעכשיו אני זוכרת את "${input.obligeeName}" בשבילך.`);
    setShowCapture(false);
    await load(token);
  }

  async function onAffirmOriented() {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await markOriented(token);
      flashMessage("מצוין. אני שומרת על הכול מכאן.");
      await load(token);
    } catch (e) {
      flashMessage(errorMessage(e, "לא הצלחתי לעדכן"));
    }
  }

  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100%",
        background: TOKEN.surface.page,
        padding: `${TOKEN.space.xl}px ${TOKEN.space.lg}px 120px`,
        boxSizing: "border-box",
        color: TOKEN.ink.primary,
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      <header style={{ marginBottom: TOKEN.space.lg }}>
        <div
          style={{
            fontSize: TOKEN.font.meta,
            color: TOKEN.ink.meta,
            fontWeight: TOKEN.weight.semibold,
            letterSpacing: "0.02em",
          }}
        >
          המזכירה
        </div>
      </header>

      {flash && (
        <div
          role="status"
          style={{
            marginBottom: TOKEN.space.md,
            padding: `${TOKEN.space.sm}px ${TOKEN.space.md}px`,
            borderRadius: TOKEN.radius.card,
            background: TOKEN.semantic.success.bgSoft,
            border: `1px solid ${TOKEN.semantic.success.border}`,
            color: TOKEN.semantic.success.ink,
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.medium,
          }}
        >
          {flash}
        </div>
      )}

      {state.status === "loading" && (
        <div style={{ color: TOKEN.ink.muted, fontSize: TOKEN.font.body }}>
          רגע, בודקת את היום שלך…
        </div>
      )}

      {state.status === "error" && (
        <div
          style={{
            padding: TOKEN.space.lg,
            borderRadius: TOKEN.radius.card,
            background: TOKEN.surface.card,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
          }}
        >
          <p style={{ margin: 0, color: TOKEN.ink.secondary }}>{state.message}</p>
          <button
            type="button"
            onClick={() => {
              if (tokenRef.current) void load(tokenRef.current);
            }}
            style={secondaryBtnStyle()}
          >
            לנסות שוב
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <BriefingView
          briefing={state.briefing}
          busyId={busyId}
          showCapture={showCapture}
          showWatching={showWatching}
          onToggleCapture={() => setShowCapture((v) => !v)}
          onToggleWatching={() => setShowWatching((v) => !v)}
          onComplete={onComplete}
          onSnooze={onSnooze}
          onRelease={onRelease}
          onCapture={onCapture}
          onAffirmOriented={onAffirmOriented}
        />
      )}
    </div>
  );
}

function BriefingView({
  briefing,
  busyId,
  showCapture,
  showWatching,
  onToggleCapture,
  onToggleWatching,
  onComplete,
  onSnooze,
  onRelease,
  onCapture,
  onAffirmOriented,
}: {
  briefing: BriefingApi;
  busyId: number | null;
  showCapture: boolean;
  showWatching: boolean;
  onToggleCapture: () => void;
  onToggleWatching: () => void;
  onComplete: (o: ObligationApi) => void;
  onSnooze: (o: ObligationApi, days: number) => void;
  onRelease: (o: ObligationApi) => void;
  onCapture: (input: {
    obligeeName: string;
    amount: string;
    dueAt: string;
    recurrence: RecurrenceCadence;
    note: string;
  }) => Promise<void>;
  onAffirmOriented: () => void;
}) {
  const { state, attention, watching, counts } = briefing;
  const focus = attention[0] ?? null;
  const remaining = Math.max(0, attention.length - 1);
  const firstLaunch = counts.open === 0 && !briefing.oriented;

  return (
    <>
      <Hero state={state} firstLaunch={firstLaunch} focus={focus} />

      {/* The single act of attention — one focus at a time. */}
      {focus && (
        <FocusCard
          item={focus}
          busy={busyId === focus.obligation.id}
          onComplete={() => onComplete(focus.obligation)}
          onSnooze={(days) => onSnooze(focus.obligation, days)}
          onRelease={() => onRelease(focus.obligation)}
        />
      )}

      {remaining > 0 && (
        <p style={{ color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, margin: `${TOKEN.space.sm}px 2px ${TOKEN.space.lg}px` }}>
          ועוד {remaining} {remaining === 1 ? "דבר" : "דברים"} השבוע — אביא אותם
          אחד-אחד.
        </p>
      )}

      {/* Onboarding affirmation: unlock global calm once the backbone is in. */}
      {!briefing.oriented && counts.open > 0 && (
        <div style={cardStyle()}>
          <p style={{ margin: `0 0 ${TOKEN.space.sm}px`, color: TOKEN.ink.secondary, fontSize: TOKEN.font.body, lineHeight: 1.5 }}>
            עדיין מכירה את העסק שלך. סיפרת לי על העיקריות?
          </p>
          <button type="button" onClick={onAffirmOriented} style={secondaryBtnStyle()}>
            אלה ההתחייבויות העיקריות שלי
          </button>
        </div>
      )}

      {/* Tell-the-secretary (capture / handoff). */}
      <div style={{ marginTop: TOKEN.space.lg }}>
        {!showCapture ? (
          <button type="button" onClick={onToggleCapture} style={primaryBtnStyle()}>
            + למסור לי עוד התחייבות
          </button>
        ) : (
          <CaptureForm onSubmit={onCapture} onCancel={onToggleCapture} />
        )}
      </div>

      {/* What I'm watching — on demand only. */}
      {counts.watching > 0 && (
        <div style={{ marginTop: TOKEN.space.lg }}>
          <button
            type="button"
            onClick={onToggleWatching}
            style={linkBtnStyle()}
          >
            {showWatching
              ? "להסתיר את מה שאני שומרת"
              : `מה אני שומרת (${counts.watching})`}
          </button>
          {showWatching && <WatchingList items={watching} />}
        </div>
      )}
    </>
  );
}

function Hero({
  state,
  firstLaunch,
  focus,
}: {
  state: BriefingApi["state"];
  firstLaunch: boolean;
  focus: BriefingApi["attention"][number] | null;
}) {
  let title: string;
  let sub: string | null = null;

  if (firstLaunch) {
    title = "שלום, אני המזכירה שלך.";
    sub =
      "התפקיד שלי לזכור כל תשלום שאתה צריך לשלם — כדי שלא תצטרך. בוא נתחיל עם אלה שאתה הכי לא רוצה לשכוח.";
  } else {
    switch (state) {
      case "CRITICAL":
        title = "בוקר טוב. דבר אחד דורש אותך היום — והנה למה.";
        break;
      case "BUSY":
        title = "בוקר טוב. כמה דברים מגיעים השבוע — הכול מוכן. נתחיל בראשון.";
        break;
      case "STILL_SETTLING_IN":
        title = "בוקר טוב.";
        sub = "שום דבר ממה שסיפרת לי לא דורש אותך היום.";
        break;
      case "CALM":
      default:
        title = "בוקר טוב. אתה בשליטה היום — שום דבר לא דורש אותך.";
        break;
    }
  }

  return (
    <section
      style={{
        marginBottom: TOKEN.space.lg,
        padding: focus ? 0 : TOKEN.space.xs,
      }}
    >
      <h1
        style={{
          margin: 0,
          fontSize: TOKEN.font.hero,
          lineHeight: 1.3,
          fontWeight: TOKEN.weight.bold,
          letterSpacing: "-0.02em",
          color: TOKEN.ink.primary,
        }}
      >
        {title}
      </h1>
      {sub && (
        <p
          style={{
            margin: `${TOKEN.space.sm}px 0 0`,
            fontSize: TOKEN.font.body,
            lineHeight: 1.55,
            color: TOKEN.ink.secondary,
          }}
        >
          {sub}
        </p>
      )}
    </section>
  );
}

function FocusCard({
  item,
  busy,
  onComplete,
  onSnooze,
  onRelease,
}: {
  item: BriefingApi["attention"][number];
  busy: boolean;
  onComplete: () => void;
  onSnooze: (days: number) => void;
  onRelease: () => void;
}) {
  const o = item.obligation;
  const reason = reasonLabel(item.reason);
  const tier = TOKEN.semantic[reason.tier];

  return (
    <section
      style={{
        ...cardStyle(),
        borderInlineStart: `3px solid ${tier.accent}`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: TOKEN.space.sm,
          marginBottom: TOKEN.space.sm,
        }}
      >
        <span
          style={{
            fontSize: TOKEN.font.caption,
            fontWeight: TOKEN.weight.bold,
            color: tier.ink,
            background: tier.bg,
            border: `1px solid ${tier.border}`,
            borderRadius: TOKEN.radius.chip,
            padding: "2px 8px",
          }}
        >
          {reason.text}
        </span>
        {o.recurrence !== "NONE" && (
          <span style={{ fontSize: TOKEN.font.caption, color: TOKEN.ink.meta }}>
            {RECURRENCE_LABEL[o.recurrence]}
          </span>
        )}
      </div>

      <div
        style={{
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.semibold,
          color: TOKEN.ink.primary,
        }}
      >
        {o.obligeeName}
      </div>
      <div
        style={{
          fontSize: TOKEN.font.display,
          fontWeight: TOKEN.weight.bold,
          margin: `${TOKEN.space.xs}px 0`,
        }}
      >
        {formatMoney(o.amount, o.currency)}
      </div>
      <div style={{ fontSize: TOKEN.font.body, color: TOKEN.ink.secondary }}>
        {formatDueDate(o.dueAt)}
      </div>
      {o.note && (
        <div
          style={{
            marginTop: TOKEN.space.sm,
            fontSize: TOKEN.font.meta,
            color: TOKEN.ink.muted,
          }}
        >
          {o.note}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: TOKEN.space.sm,
          marginTop: TOKEN.space.lg,
        }}
      >
        <button type="button" onClick={onComplete} disabled={busy} style={primaryBtnStyle()}>
          זה טופל
        </button>
        <button type="button" onClick={() => onSnooze(3)} disabled={busy} style={secondaryBtnStyle()}>
          להזכיר לי אחר כך
        </button>
        <button type="button" onClick={onRelease} disabled={busy} style={dangerBtnStyle()}>
          כבר לא רלוונטי
        </button>
      </div>
    </section>
  );
}

function CaptureForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: {
    obligeeName: string;
    amount: string;
    dueAt: string;
    recurrence: RecurrenceCadence;
    note: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [obligeeName, setObligeeName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceCadence>("NONE");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = obligeeName.trim() !== "" && amount.trim() !== "" && dueAt !== "";

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ obligeeName, amount, dueAt, recurrence, note });
    } catch (e) {
      setError(errorMessage(e, "לא הצלחתי לשמור"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section style={cardStyle()}>
      <div
        style={{
          fontSize: TOKEN.font.title,
          fontWeight: TOKEN.weight.semibold,
          marginBottom: TOKEN.space.md,
        }}
      >
        מה שאזכור בשבילך?
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: TOKEN.space.md }}>
        <Field label="למי משלמים">
          <input
            value={obligeeName}
            onChange={(e) => setObligeeName(e.target.value)}
            placeholder="לדוגמה: בעל הבית, ספק, רשות המסים"
            style={inputStyle()}
          />
        </Field>
        <Field label="כמה">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="₪"
            style={inputStyle()}
          />
        </Field>
        <Field label="מתי">
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            style={inputStyle()}
          />
        </Field>
        <Field label="חוזר?">
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as RecurrenceCadence)}
            style={inputStyle()}
          >
            <option value="NONE">חד-פעמי</option>
            <option value="WEEKLY">כל שבוע</option>
            <option value="MONTHLY">כל חודש</option>
            <option value="YEARLY">כל שנה</option>
          </select>
        </Field>
        <Field label="הערה (לא חובה)">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={inputStyle()}
          />
        </Field>
      </div>

      {error && (
        <p style={{ color: TOKEN.semantic.urgent.ink, fontSize: TOKEN.font.meta, marginTop: TOKEN.space.sm }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: TOKEN.space.sm, marginTop: TOKEN.space.lg }}>
        <button type="button" onClick={submit} disabled={!canSubmit || submitting} style={primaryBtnStyle()}>
          {submitting ? "שומרת…" : "מסור לי"}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} style={secondaryBtnStyle()}>
          ביטול
        </button>
      </div>
    </section>
  );
}

function WatchingList({ items }: { items: ObligationApi[] }) {
  return (
    <div
      style={{
        marginTop: TOKEN.space.sm,
        display: "flex",
        flexDirection: "column",
        gap: TOKEN.space.xs,
      }}
    >
      {items.map((o) => (
        <div
          key={o.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: `${TOKEN.space.sm}px ${TOKEN.space.md}px`,
            background: TOKEN.surface.card,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            borderRadius: TOKEN.radius.card,
          }}
        >
          <div>
            <div style={{ fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.medium }}>
              {o.obligeeName}
            </div>
            <div style={{ fontSize: TOKEN.font.meta, color: TOKEN.ink.muted }}>
              {formatDueDate(o.dueAt)}
            </div>
          </div>
          <div style={{ fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.semibold }}>
            {formatMoney(o.amount, o.currency)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span
        style={{
          display: "block",
          fontSize: TOKEN.font.meta,
          color: TOKEN.ink.secondary,
          fontWeight: TOKEN.weight.medium,
          marginBottom: TOKEN.space.xs,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

// --- shared inline styles --------------------------------------------------

function cardStyle(): React.CSSProperties {
  return {
    background: TOKEN.surface.card,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.card,
    boxShadow: TOKEN.shadow.elevated,
    padding: TOKEN.space.lg,
    marginBottom: TOKEN.space.md,
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: `${TOKEN.space.sm}px ${TOKEN.space.md}px`,
    fontSize: TOKEN.font.body,
    color: TOKEN.ink.primary,
    background: TOKEN.surface.inset,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.input,
    fontFamily: "inherit",
  };
}

function primaryBtnStyle(): React.CSSProperties {
  return {
    appearance: "none",
    border: TOKEN.action.primary.border,
    background: TOKEN.action.primary.background,
    color: TOKEN.action.primary.color,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.semibold,
    padding: `${TOKEN.space.sm}px ${TOKEN.space.lg}px`,
    borderRadius: TOKEN.radius.button,
    boxShadow: TOKEN.action.primary.shadowSoft,
    cursor: "pointer",
  };
}

function secondaryBtnStyle(): React.CSSProperties {
  return {
    appearance: "none",
    border: TOKEN.action.glass.border,
    background: TOKEN.action.glass.background,
    color: TOKEN.action.glass.color,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.medium,
    padding: `${TOKEN.space.sm}px ${TOKEN.space.lg}px`,
    borderRadius: TOKEN.radius.button,
    cursor: "pointer",
  };
}

function dangerBtnStyle(): React.CSSProperties {
  return {
    appearance: "none",
    border: TOKEN.action.danger.border,
    background: TOKEN.action.danger.background,
    color: TOKEN.action.danger.color,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.medium,
    padding: `${TOKEN.space.sm}px ${TOKEN.space.lg}px`,
    borderRadius: TOKEN.radius.button,
    cursor: "pointer",
  };
}

function linkBtnStyle(): React.CSSProperties {
  return {
    appearance: "none",
    border: "none",
    background: "transparent",
    color: TOKEN.brand.mid,
    fontSize: TOKEN.font.body,
    fontWeight: TOKEN.weight.medium,
    padding: 0,
    cursor: "pointer",
    textDecoration: "underline",
  };
}
