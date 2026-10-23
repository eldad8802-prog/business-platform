"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { TOKEN } from "@/lib/design/bot-theme";
import { BUILDER_SHELL_MAX_WIDTH } from "../../../bot-settings/_components/bot-builder-area-ui";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";

type ActivationApplied = {
  welcomeMessage?: boolean;
  questions?: number;
  finalAction?: boolean;
  handoffRules?: boolean;
};

type ActivationResult = {
  success?: boolean;
  activated?: boolean;
  applied?: ActivationApplied;
};

type BotResponse = {
  identity?: { displayName: string | null; avatar: string | null };
};

const STORAGE_KEY = "botSetupActivationResult";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function readActivationResult(): ActivationResult | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(STORAGE_KEY);
  try {
    const parsed = JSON.parse(raw) as ActivationResult;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export default function BotSetupSuccessPage() {
  const { t } = useI18n();
  const [activation, setActivation] = useState<ActivationResult | null>(null);
  const [ready, setReady] = useState(false);
  const [displayName, setDisplayName] = useState(() => t("content.bot.common.defaultBotName"));

  const loadIdentity = useCallback(async () => {
    try {
      const res = await fetch("/api/business/bot", {
        headers: { Authorization: "Bearer " + getAuthToken() },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as BotResponse;
      setDisplayName(data.identity?.displayName || t("content.bot.common.defaultBotName"));
    } catch {
      setDisplayName(t("content.bot.common.defaultBotName"));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActivation(readActivationResult());
      setReady(true);
      void loadIdentity();
    });
    return () => {
      cancelled = true;
    };
  }, [loadIdentity]);

  const applied = activation?.applied;
  const hasFreshActivation = ready && activation?.activated === true && applied != null;
  const rows = applied ? buildSummaryRows(applied, t) : [];

  return (
    <div style={pageStyle}>
      <main style={shellStyle}>
        <div style={bodyStyle}>
          {hasFreshActivation ? (
            <>
              <section style={heroStyle}>
                <div style={checkStyle}>
                  <CheckIcon size={42} stroke={TOKEN.semantic.success.accent} />
                </div>
                <h1 style={titleStyle}>{t("content.bot.success.title")}</h1>
                <p style={subtitleStyle}>
                  <strong style={botNameStyle}>{displayName}</strong> {t("content.bot.success.subtitleAfterName")}
                </p>
              </section>

              <section aria-label={t("content.bot.success.summaryAria")} style={summaryCardStyle}>
                {rows.map((row) => (
                  <SummaryRow key={row.key} title={row.title} sub={row.sub} value={row.value} tone={row.tone} />
                ))}
              </section>

              <HowItWorks />
              <GuardNote />
            </>
          ) : (
            <EmptyState displayName={displayName} />
          )}
        </div>

        <div style={actionsStyle}>
          <Link href="/business/bot" style={primaryButtonStyle}>{t("content.bot.success.toBotPage")}</Link>
          <Link href="/business/bot?preview=1" style={secondaryButtonStyle}>{t("content.bot.success.preview")}</Link>
          <div style={homeIndicatorStyle} />
        </div>
      </main>
    </div>
  );
}

function buildSummaryRows(applied: ActivationApplied, t: Translator) {
  const rows: Array<{ key: string; title: string; sub: string; value: string; tone: "done" | "muted" }> = [];
  if (applied.welcomeMessage === true) {
    rows.push({ key: "welcome", title: t("content.bot.success.rows.welcomeTitle"), sub: t("content.bot.success.rows.welcomeSub"), value: t("content.bot.success.configured"), tone: "done" });
  }
  const count = Number.isFinite(applied.questions) ? Math.max(0, Math.trunc(applied.questions || 0)) : 0;
  if (count > 0) {
    rows.push({ key: "questions", title: t("content.bot.success.rows.questionsTitle"), sub: t("content.bot.success.rows.questionsSub"), value: t("content.bot.success.rows.questionsValue", { count }), tone: "done" });
  }
  if (applied.finalAction === true) {
    rows.push({ key: "final", title: t("content.bot.success.rows.finalTitle"), sub: t("content.bot.success.rows.finalSub"), value: t("content.bot.success.configured"), tone: "done" });
  }
  if (applied.handoffRules === true) {
    rows.push({ key: "handoff", title: t("content.bot.success.rows.handoffTitle"), sub: t("content.bot.success.rows.handoffSub"), value: t("content.bot.success.configured"), tone: "done" });
  } else {
    rows.push({ key: "handoff-existing", title: t("content.bot.success.rows.handoffTitle"), sub: t("content.bot.success.rows.handoffExistingSub"), value: t("content.bot.success.rows.handoffExistingValue"), tone: "muted" });
  }
  return rows;
}

function SummaryRow({ title, sub, value, tone }: { title: string; sub: string; value: string; tone: "done" | "muted" }) {
  const done = tone === "done";
  return (
    <div style={summaryRowStyle}>
      <div style={{ ...summaryIconStyle, background: done ? TOKEN.semantic.success.bg : TOKEN.surface.inset }}>
        {done ? <CheckIcon size={18} stroke={TOKEN.semantic.success.accent} /> : <DashIcon />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowTitleStyle}>{title}</div>
        <div style={rowSubStyle}>{sub}</div>
      </div>
      <div style={{ ...rowValueStyle, color: done ? TOKEN.semantic.success.ink : TOKEN.ink.muted }}>{value}</div>
    </div>
  );
}

function HowItWorks() {
  const { t } = useI18n();
  return (
    <section style={howStyle}>
      <div style={howTitleStyle}><ChatIcon />{t("content.bot.success.howTitle")}</div>
      <Step number="1">{t("content.bot.success.step1")}</Step>
      <Step number="2">{t("content.bot.success.step2")}</Step>
      <Step number="3">{t("content.bot.success.step3")}</Step>
    </section>
  );
}

function Step({ number, children }: { number: string; children: ReactNode }) {
  return (
    <div style={stepStyle}>
      <span style={stepNumberStyle}>{number}</span>
      <span>{children}</span>
    </div>
  );
}

function GuardNote() {
  const { t } = useI18n();
  return (
    <div style={noteStyle}>
      <ShieldIcon />
      <span>{t("content.bot.success.guard")}</span>
    </div>
  );
}

function EmptyState({ displayName }: { displayName: string }) {
  const { t } = useI18n();
  return (
    <section style={{ ...heroStyle, paddingTop: 70 }}>
      <div style={{ ...checkStyle, background: TOKEN.surface.inset }}>
        <DashIcon size={32} />
      </div>
      <h1 style={titleStyle}>{t("content.bot.success.emptyTitle")}</h1>
      <p style={subtitleStyle}>
        {displayName} {t("content.bot.success.emptyBodyAfterName")}
      </p>
    </section>
  );
}

function CheckIcon({ size = 24, stroke = "currentColor" }: { size?: number; stroke?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><path d="M5 13l4 4L19 7" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>;
}
function DashIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><path d="M6 12h12" stroke={TOKEN.ink.muted} strokeWidth="2.4" strokeLinecap="round" /></svg>;
}
function ChatIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden><path d="M4 5h16v11H9l-5 4V5z" stroke={TOKEN.semantic.info.ink} strokeWidth="1.9" fill="none" strokeLinejoin="round" /></svg>;
}
function ShieldIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke={TOKEN.ink.meta} strokeWidth="1.8" fill="none" strokeLinejoin="round" /></svg>;
}

const pageStyle: CSSProperties = { minHeight: "100dvh", background: TOKEN.surface.page, display: "flex", justifyContent: "center" };
const shellStyle: CSSProperties = { width: "100%", maxWidth: BUILDER_SHELL_MAX_WIDTH, minHeight: "100dvh", background: TOKEN.surface.card, display: "flex", flexDirection: "column", overflowX: "hidden", boxSizing: "border-box" };
const bodyStyle: CSSProperties = { flex: 1, overflowY: "auto", padding: "0 22px 30px", display: "flex", flexDirection: "column", boxSizing: "border-box" };
const heroStyle: CSSProperties = { textAlign: "center", padding: "18px 0 4px" };
const checkStyle: CSSProperties = { width: 78, height: 78, borderRadius: TOKEN.radius.pill, background: TOKEN.semantic.success.bg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", boxShadow: "0 0 0 8px rgba(36, 105, 102, 0.14)" };
const titleStyle: CSSProperties = { margin: "0 0 8px", fontSize: TOKEN.font.hero, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary, letterSpacing: 0, lineHeight: 1.25 };
const subtitleStyle: CSSProperties = { margin: 0, color: TOKEN.ink.muted, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.semibold, lineHeight: 1.55 };
const botNameStyle: CSSProperties = { color: TOKEN.semantic.info.ink, fontWeight: TOKEN.weight.bold };
const summaryCardStyle: CSSProperties = { marginTop: 18, border: "1px solid " + TOKEN.border.DEFAULT, borderRadius: TOKEN.radius.modal + 2, overflow: "hidden", flexShrink: 0, background: TOKEN.surface.card };
const summaryRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 13, padding: "12px 16px", borderBottom: "1px solid " + TOKEN.border.DEFAULT };
const summaryIconStyle: CSSProperties = { width: 38, height: 38, borderRadius: TOKEN.radius.input, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
const rowTitleStyle: CSSProperties = { fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.ink.primary };
const rowSubStyle: CSSProperties = { fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, fontWeight: TOKEN.weight.medium, marginTop: 1 };
const rowValueStyle: CSSProperties = { fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, whiteSpace: "nowrap" };
const howStyle: CSSProperties = { marginTop: 16, background: TOKEN.semantic.info.bg, borderRadius: TOKEN.radius.modal, padding: 16 };
const howTitleStyle: CSSProperties = { fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold, color: TOKEN.semantic.info.ink, display: "flex", alignItems: "center", gap: 8, marginBottom: 11 };
const stepStyle: CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", fontSize: TOKEN.font.meta, color: TOKEN.semantic.info.ink, fontWeight: TOKEN.weight.semibold, lineHeight: 1.5, marginBottom: 10 };
const stepNumberStyle: CSSProperties = { width: 20, height: 20, borderRadius: TOKEN.radius.pill, background: TOKEN.surface.card, color: TOKEN.semantic.info.ink, display: "flex", alignItems: "center", justifyContent: "center", fontSize: TOKEN.font.caption, fontWeight: TOKEN.weight.bold, flexShrink: 0, marginTop: 1 };
const noteStyle: CSSProperties = { marginTop: 16, display: "flex", gap: 9, alignItems: "flex-start", fontSize: TOKEN.font.meta, color: TOKEN.ink.muted, fontWeight: TOKEN.weight.semibold, lineHeight: 1.55, padding: "0 4px" };
const actionsStyle: CSSProperties = { padding: "14px 22px 8px", flexShrink: 0, borderTop: "1px solid " + TOKEN.border.DEFAULT, background: TOKEN.surface.card };
const primaryButtonStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: 54, border: 0, borderRadius: TOKEN.radius.card + 1, background: TOKEN.action.primary.background, color: TOKEN.ink.inverse, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.title, textDecoration: "none", boxShadow: TOKEN.action.primary.shadow, boxSizing: "border-box" };
const secondaryButtonStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: 48, border: 0, borderRadius: TOKEN.radius.card, background: "transparent", color: TOKEN.brand.mid, fontFamily: "inherit", fontWeight: TOKEN.weight.bold, fontSize: TOKEN.font.body, textDecoration: "none", marginTop: 4 };
const homeIndicatorStyle: CSSProperties = { width: 135, height: 5, background: TOKEN.ink.primary, borderRadius: TOKEN.radius.pill, margin: "6px auto 8px", opacity: 0.25 };
