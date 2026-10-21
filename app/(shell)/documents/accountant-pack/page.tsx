"use client";
import { PageContainer } from "@/components/ui/page-container";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { fetchDocumentsHubSummary } from "@/lib/documents/fetch-inbox";
import { TOKEN, chipActionStyle } from "@/lib/design/documents-theme";
import { isPeriodKey } from "@/lib/accountant/period";
import type { PeriodView } from "@/lib/accountant/view.service";
import DocumentsBackButton from "@/components/documents/DocumentsBackButton";
import { AccountantMonthPanel } from "@/components/accountant/AccountantMonthPanel";
import { AdHocExport } from "@/components/accountant/AdHocExport";
import { fetchPeriod, fetchPeriods, type PeriodListItem } from "@/components/accountant/accountant-client";

/**
 * חבילת רו״ח — the monthly accountant workflow (when the feature is on for the business) and an
 * export for any period on demand.
 *
 * A notification links here as /documents/accountant-pack?period=YYYY-MM: the screen opens that exact
 * month of the signed-in business (the server reads the business from the session, never from the URL).
 */
export default function AccountantPackPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [periods, setPeriods] = useState<PeriodListItem[] | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<PeriodView | null>(null);
  const [pendingAllTime, setPendingAllTime] = useState(0);
  const [loadError, setLoadError] = useState("");
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    const t = window.localStorage.getItem("token");
    if (!t) {
      router.replace("/login");
      return;
    }
    setToken(t);
    const fromUrl = new URLSearchParams(window.location.search).get("period");
    void fetchPeriods(t)
      .then((list) => {
        setPeriods(list);
        if (list && list.length > 0) setSelected(fromUrl && isPeriodKey(fromUrl) ? fromUrl : list[0].periodKey);
      })
      .catch(() => {
        setPeriods(null);
        setLoadError("לא הצלחנו לטעון את החודשים. נסו לרענן.");
      });
    void fetchDocumentsHubSummary(t)
      .then((s) => setPendingAllTime(s.financialPulse.inboxDocumentCounts.pendingReview ?? 0))
      .catch(() => setPendingAllTime(0));
  }, [router]);

  const reload = useCallback(async () => {
    if (!token || !selected) return;
    try {
      setView(await fetchPeriod(token, selected));
      setLoadError("");
    } catch {
      setLoadError("לא הצלחנו לטעון את החודש. נסו לרענן.");
    }
  }, [token, selected]);

  useEffect(() => {
    setView(null);
    void reload();
    if (selected) {
      const url = new URL(window.location.href);
      url.searchParams.set("period", selected);
      window.history.replaceState(null, "", url.toString());
    }
  }, [reload, selected]);

  // While a send is on its way, follow it for a minute.
  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (view?.status !== "SENDING") return;
    let n = 0;
    pollRef.current = window.setInterval(() => {
      n += 1;
      if (n > 15) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        return;
      }
      void reload();
    }, 4000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [view?.status, reload]);

  function onChange(next: PeriodView | null) {
    if (!next) return;
    setView(next);
    setPeriods((list) =>
      list?.map((p) => (p.periodKey === next.periodKey ? { ...p, status: next.status, statusLabel: next.statusLabel } : p)) ?? list
    );
  }

  const monthly = Array.isArray(periods) && periods.length > 0;

  return (
    <div dir="rtl" style={pageStyle}>
      <PageContainer intent="standard" className="dz-pack" style={{ paddingBlock: "14px 40px" }}>
        <header style={headStyle}>
          <DocumentsBackButton />
          <h1 style={titleStyle}>{t("documents.pack.title")}</h1>
          <div aria-hidden style={{ width: 52 }} />
        </header>

        {loadError ? <div style={errorStyle} role="alert">{loadError}</div> : null}

        {monthly ? (
          <nav aria-label="חודשים" style={monthsStyle}>
            {periods!.map((p) => (
              <button
                key={p.periodKey}
                type="button"
                onClick={() => setSelected(p.periodKey)}
                aria-current={p.periodKey === selected ? "true" : undefined}
                style={{ ...chipActionStyle(p.periodKey === selected), minHeight: 52, flexDirection: "column", gap: 2, padding: "6px 12px", whiteSpace: "nowrap" }}
              >
                <span>{p.label}</span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{p.statusLabel ?? "טרם הוכן"}</span>
              </button>
            ))}
          </nav>
        ) : null}

        <div className="dz-pack-desk">
          <div>
            {monthly && view && token ? (
              <AccountantMonthPanel token={token} period={view} onChange={onChange} onReload={reload} />
            ) : monthly || periods === undefined ? (
              <div style={skeleton} aria-busy="true">טוען…</div>
            ) : null}
            {!monthly && token && periods !== undefined ? <AdHocExport token={token} pendingAllTime={pendingAllTime} /> : null}
          </div>
          {monthly && token ? (
            <aside className="dz-pack-side">
              <AdHocExport token={token} pendingAllTime={pendingAllTime} />
            </aside>
          ) : null}
        </div>
      </PageContainer>
    </div>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
  paddingBottom: 40,
} as const;

const headStyle = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 16,
} as const;

const titleStyle = {
  margin: 0,
  textAlign: "center",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.25,
} as const;

const monthsStyle = {
  display: "flex",
  gap: 8,
  overflowX: "auto",
  paddingBottom: 6,
  marginBottom: 14,
  scrollbarWidth: "thin",
} as const;

const skeleton = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  padding: 24,
  color: TOKEN.ink.muted,
  marginBottom: 14,
} as const;

const errorStyle = {
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
  padding: "12px 14px",
  fontWeight: TOKEN.weight.bold,
  marginBottom: 14,
} as const;
