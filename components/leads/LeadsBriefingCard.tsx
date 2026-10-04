"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getLeadBriefing, type LeadBriefing } from "@/lib/api/leads";
import { TOKEN } from "@/lib/design/tokens";

const DS = TOKEN.dsv1;

/**
 * M5 — the Secretary's lead line: what in the sales pipeline needs you today.
 *
 * One canonical source (GET /api/leads/briefing → the lead attention contract),
 * counts first, then the few leads that matter most, each saying whether its
 * reason is a FACT or an INFERENCE and — separately — what Dubiz proposes.
 * Read-only: it links to the lead; it never changes a stage, sends a message
 * or contacts anyone. Silent when there is nothing to say.
 */
export function LeadsBriefingCard() {
  const [briefing, setBriefing] = useState<LeadBriefing | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLeadBriefing()
      .then((b) => {
        if (!cancelled) setBriefing(b);
      })
      .catch(() => {
        // The payment Secretary must keep working if this section cannot load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const arrivals = briefing?.arrivals;
  if (!briefing || (briefing.counts.needsAttention === 0 && !arrivals?.today)) return null;
  const c = briefing.counts;
  const lines: string[] = [];
  // M6 — today's arrivals with their sources ("3 מפייסבוק/אינסטגרם, 2 מגוגל"): context, not a separate inbox.
  if (arrivals && arrivals.today > 0) {
    const sources = arrivals.bySource.length > 1 || (arrivals.bySource[0] && arrivals.bySource[0].group !== "manual")
      ? " · " + arrivals.bySource.map((s) => (s.group === "manual" ? `${s.count} ${s.label}` : `${s.count} מ${s.label}`)).join(", ")
      : "";
    lines.push(`נכנסו היום ${arrivals.today === 1 ? "ליד חדש אחד" : `${arrivals.today} לידים חדשים`}${sources}`);
  }
  if (c.CUSTOMER_WROTE) lines.push(`${c.CUSTOMER_WROTE} לקוחות כתבו ומחכים לכם`);
  if (c.FOLLOWUP_OVERDUE) lines.push(`${c.FOLLOWUP_OVERDUE} מעקבים באיחור`);
  if (c.FOLLOWUP_DUE_TODAY) lines.push(`${c.FOLLOWUP_DUE_TODAY} מעקבים להיום`);
  if (c.NEW_UNHANDLED) lines.push(`${c.NEW_UNHANDLED} לידים חדשים שלא טופלו`);
  if (c.AWAITING_OWNER_DECISION) lines.push(`${c.AWAITING_OWNER_DECISION} מחכים להחלטה שלכם`);
  if (c.QUOTE_NO_ACTIVITY) lines.push(`${c.QUOTE_NO_ACTIVITY} הצעות בלי המשך`);
  if (c.STALLED) lines.push(`${c.STALLED} לידים תקועים`);

  return (
    <section
      dir="rtl"
      aria-label="לידים שמחכים לכם"
      style={{
        margin: "16px auto",
        width: "min(100% - 32px, 720px)",
        boxSizing: "border-box",
        background: DS.card,
        border: `1px solid ${DS.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 17, color: DS.ink }}>לידים היום</h2>
      <ul style={{ margin: "8px 0 12px", paddingInlineStart: 18, color: DS.ink, lineHeight: 1.7 }}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div style={{ display: "grid", gap: 8 }}>
        {briefing.items.map((item) => (
          <Link
            key={item.leadId}
            href={item.href}
            style={{
              display: "block",
              textDecoration: "none",
              color: DS.ink,
              background: DS.surface2,
              borderRadius: 12,
              padding: "10px 12px",
            }}
          >
            <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
              <bdi>{item.name}</bdi> — {item.label}
            </div>
            <div style={{ color: DS.muted, fontSize: 14 }}>
              {item.evidenceClass === "fact" ? "עובדה" : "מסקנה מהנתונים"}
              {item.summary ? ` · ${item.summary}` : ""}
            </div>
            {item.suggestion ? (
              <div style={{ color: DS.accent, fontSize: 14 }}>דוביז מציע: {item.suggestion.label}</div>
            ) : null}
          </Link>
        ))}
      </div>
      {!briefing.complete ? (
        <p style={{ margin: "8px 0 0", color: DS.tertiary, fontSize: 13 }}>
          יש יותר לידים פתוחים ממה שנסקר — המספרים הם לפחות.
        </p>
      ) : null}
      <Link href="/attention" style={{ display: "inline-block", marginTop: 12, color: DS.accent }}>
        לתור הטיפול ›
      </Link>
    </section>
  );
}
