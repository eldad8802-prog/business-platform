"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import BackButton from "@/components/ui/back-button";
import {
  HOME_ROUTES,
  TOOL_GROUPS,
  toolsInGroup,
  type ToolGroupKey,
} from "@/lib/navigation/home-routes";
import { TOOL_TINT_CSS } from "@/features/home/lib/tool-tints";
import { groupStatus, type GroupStatus } from "@/features/home/lib/home-model";
import type { BusinessStatusItem } from "@/lib/business-status/types";

/**
 * "כל הכלים" — the full tool directory, grouped.
 *
 * It renders the same three groups the home screen shows as tiles, in the same
 * order, from the SAME map (`lib/navigation/home-routes.ts`). A home group tile
 * links to `/tools#group-<key>`, and each section below carries that id, so the
 * tile lands the owner on its own group rather than at the top of a list.
 *
 * Every tool here is a live route, proven by `npm run verify:home-routes`. Two
 * concepts that used to have a tile do NOT appear, because pointing them
 * somewhere would have meant pointing them somewhere they do not mean:
 *   - "הוצאות" has no route; expenses exist only as approved expense documents.
 *   - "יומן" has no route; `Appointment` has no list endpoint and no screen,
 *     and the old tile with that label opened the payment secretary.
 *
 * The per-group status line is a LABEL, never a count: `/api/business-status`
 * caps every domain, so a number from it could only ever under-report — and a
 * tile that under-reports says "handled" about work that is not.
 */

const GROUP_TINT: Record<ToolGroupKey, string> = {
  money: "c-teal",
  customers: "c-sage",
  operations: "c-slate",
};

function IconInvoice() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 13h6M9 17h4" /></svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.6L3 21l1.9-5.8A8.5 8.5 0 1 1 21 11.5z" /></svg>
  );
}

function IconBox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
  );
}

const GROUP_ICON: Record<ToolGroupKey, () => ReactNode> = {
  money: IconInvoice,
  customers: IconChat,
  operations: IconBox,
};

/**
 * Tool glyphs. Every one of these is the glyph the concept already carried in
 * the product (the home tool strip, or the nav source); nothing is drawn new.
 */
const TOOL_ICON: Record<string, () => ReactNode> = {
  invoices: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 13h6M9 17h4" /></svg>
  ),
  collection: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.5" /><circle cx="12" cy="12.5" r="2.6" /><path d="M6 9.5h.01M18 15.5h.01" /></svg>
  ),
  "payment-request": () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="13" rx="2.5" /><path d="M12 9.5v6M9 12.5h6" /></svg>
  ),
  documents: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4z" /></svg>
  ),
  "documents-email": () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></svg>
  ),
  customers: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.9M17.5 19a5.5 5.5 0 0 0-2.7-4.7" /></svg>
  ),
  leads: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
  ),
  conversations: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.6L3 21l1.9-5.8A8.5 8.5 0 1 1 21 11.5z" /></svg>
  ),
  bots: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M8.5 13h.01M15.5 13h.01M2 12v3M22 12v3" /></svg>
  ),
  coupons: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3a2 2 0 0 1 0 6v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3a2 2 0 0 1 0-6z" /><path d="M9 9v6" strokeDasharray="1.5 2.5" /></svg>
  ),
  inventory: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>
  ),
  suppliers: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5h11v10H2zM13 8h4l4 3v4h-8z" /><circle cx="6" cy="18" r="1.8" /><circle cx="17.5" cy="18" r="1.8" /></svg>
  ),
  // The nav's secretary glyph verbatim (bubble + star). The star is what keeps
  // it from reading as a second "שיחות" tile.
  secretary: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-4 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5z" /><path d="M12 6.4l.9 1.9 2.1.3-1.5 1.5.35 2.1-1.85-1-1.85 1 .35-2.1-1.5-1.5 2.1-.3z" fill="currentColor" stroke="none" /></svg>
  ),
  connections: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 14.5 14.5 9.5" /><path d="M13 6.5 14.6 5a4 4 0 0 1 5.7 5.7l-1.6 1.5" /><path d="M11 17.5 9.4 19a4 4 0 0 1-5.7-5.7l1.6-1.5" /></svg>
  ),
};

function ToolGlyph({ toolKey }: { toolKey: string }) {
  const Icon = TOOL_ICON[toolKey];
  return Icon ? <Icon /> : null;
}

export default function ToolsPage() {
  const [items, setItems] = useState<BusinessStatusItem[] | null>(null);

  // Read-only, best effort. A failed snapshot leaves the status lines blank —
  // it never turns into "הכול מטופל", which would be a claim we cannot make.
  useEffect(() => {
    let cancelled = false;
    let token: string | null = null;
    try {
      token = localStorage.getItem("token");
    } catch {
      token = null;
    }
    if (!token) return;

    fetch("/api/business-status", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { items?: BusinessStatusItem[] } | null) => {
        if (!cancelled && json?.items) setItems(json.items);
      })
      .catch(() => {
        /* status lines stay blank */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Land on the requested group.
   *
   * The browser's own hash scroll fires before this client-rendered markup
   * exists, and the router settles scroll to the top after hydration — so the
   * home group tile would otherwise always arrive at the top of the list. This
   * re-runs it after paint, and once more when the status lines land (they
   * change the height above the target).
   */
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const id = requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(id);
  }, [items]);

  return (
    <main
      dir="rtl"
      data-page-intent="content"
      className="min-h-screen bg-[var(--dz-background)] text-[var(--dz-text-primary)]"
    >
      <style>{TOOL_TINT_CSS}</style>
      <style>{TOOLS_CSS}</style>

      <div className="dztools">
        <header className="thead">
          <BackButton href={HOME_ROUTES.home} label="לבית" />
          <div className="thead-tx">
            <h1>כל הכלים</h1>
            <p>כל היכולות, לפי תחום</p>
          </div>
          {/* Balances the back button so the title stays optically centred. */}
          <span className="thead-spacer" aria-hidden />
        </header>

        {TOOL_GROUPS.map((group) => {
          const status: GroupStatus | null = items
            ? groupStatus(items, group.domains)
            : null;
          const Icon = GROUP_ICON[group.key];
          const tools = toolsInGroup(group.key);

          return (
            <section key={group.key} id={group.anchorId} className="tgroup">
              <div className="tgroup-head">
                <span className={`tgroup-icon dz-tint ${GROUP_TINT[group.key]}`}>
                  <Icon />
                </span>
                <div className="tgroup-tx">
                  <h2>{group.label}</h2>
                  {status ? (
                    <span className={`tgroup-stat tgroup-stat-${status.tone}`}>
                      {status.label}
                    </span>
                  ) : (
                    <span className="tgroup-stat tgroup-stat-loading">&nbsp;</span>
                  )}
                </div>
              </div>

              <div className="tgrid">
                {tools.map((tool) => (
                  <Link key={tool.key} href={tool.href} className="tcell">
                    <span className={`tcell-icon dz-tint c-${tool.color}`}>
                      <ToolGlyph toolKey={tool.key} />
                    </span>
                    <span className="tcell-label">{tool.label}</span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

/**
 * Scoped styles. Colour comes only from the Mist tokens and from the five
 * shared tool tints — this file declares no colour of its own.
 */
const TOOLS_CSS = `
.dztools{
  width:100%;max-width:960px;margin-inline:auto;
  padding-inline:clamp(16px,3vw,32px);
  padding-block:calc(12px + var(--dz-safe-top,0px)) 28px;
  box-sizing:border-box;
}
.dztools a{text-decoration:none;color:inherit;-webkit-tap-highlight-color:transparent}

.dztools .thead{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.dztools .thead-tx{flex:1;min-width:0;text-align:center}
.dztools .thead-tx h1{margin:0;font-size:17px;font-weight:700;color:var(--dz-text-primary)}
.dztools .thead-tx p{margin:3px 0 0;font-size:12.5px;color:var(--dz-text-muted)}
.dztools .thead-spacer{width:76px;height:40px;flex-shrink:0}

.dztools .tgroup{
  margin-bottom:16px;padding:16px 14px 10px;border-radius:24px;
  background:var(--dz-surface);border:1px solid var(--dz-border);
  box-shadow:var(--dz-shadow-card);
  /* the home group tile lands here; keep the heading clear of the top edge */
  scroll-margin-top:16px;
}
.dztools .tgroup-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.dztools .tgroup-icon{width:44px;height:44px;min-width:44px;border-radius:50%;flex:0 0 auto}
.dztools .tgroup-icon svg{width:22px;height:22px}
.dztools .tgroup-tx{min-width:0}
.dztools .tgroup-tx h2{margin:0;font-size:15px;font-weight:700;color:var(--dz-text-primary)}
.dztools .tgroup-stat{display:block;margin-top:3px;font-size:12px;font-weight:600;line-height:1.35}
.dztools .tgroup-stat-clear{color:var(--dz-text-muted)}
.dztools .tgroup-stat-review{color:var(--dz-warning)}
.dztools .tgroup-stat-urgent{color:var(--dz-danger)}
.dztools .tgroup-stat-loading{color:transparent}

.dztools .tgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.dztools .tcell{
  display:flex;flex-direction:column;align-items:center;gap:8px;
  min-height:88px;padding:8px 2px 12px;border-radius:16px;
  transition:background .14s ease;
}
.dztools .tcell:active{background:var(--dz-control-hover)}
.dztools .tcell-icon{
  width:52px;height:52px;border-radius:50%;flex:0 0 auto;
  box-shadow:0 8px 18px -12px rgba(52,60,50,.4),inset 0 1px 0 rgba(255,255,255,.7);
}
.dztools .tcell-icon svg{width:24px;height:24px}
.dztools .tcell-label{
  font-size:11px;font-weight:600;line-height:1.3;text-align:center;
  color:var(--dz-text-secondary);
}

@media (min-width:768px){
  .dztools .tgroup{padding:20px 18px 14px}
  .dztools .tgrid{grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
  .dztools .tcell-label{font-size:12px}
}
@media (min-width:1024px){
  .dztools .tgrid{grid-template-columns:repeat(8,minmax(0,1fr))}
}
`;
