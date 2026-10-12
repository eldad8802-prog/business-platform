/**
 * Daily Tasks — the row and control glyphs of the task screens (mockups Version 1): one tinted square per
 * source kind, and the few line icons the controls use. Decorative: every control carries its own label.
 */
import type { ReactNode } from "react";

import s from "./tasks.module.css";

function Svg({ size = 17, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  wallet: <><path d="M3 7h18v12H3z" /><path d="M16 13h2" /><path d="M3 7l13-3v3" /></>,
  coin: <><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9.5 10h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" /></>,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  chat: <path d="M4 5h16v11H8l-4 4z" />,
  box: <><path d="M3 7l9-4 9 4v10l-9 4-9-4z" /><path d="M3 7l9 4 9-4M12 11v10" /></>,
};

const KIND: Record<string, { icon: string; tone: string; label: string }> = {
  supplier_payment: { icon: "wallet", tone: s.domPay, label: "תשלום לספק" },
  customer_debt: { icon: "coin", tone: s.domCol, label: "גבייה" },
  invoice_review: { icon: "doc", tone: s.domDoc, label: "חשבונית לבדיקה" },
  lead: { icon: "user", tone: s.domLead, label: "ליד" },
  conversation: { icon: "chat", tone: s.domChat, label: "שיחה" },
  documents_queue: { icon: "doc", tone: s.domDoc, label: "מסמכים לבדיקה" },
  stock: { icon: "box", tone: s.domStock, label: "מלאי" },
};

export function DomainIcon({ kind }: { kind: string }) {
  const k = KIND[kind] ?? KIND.documents_queue;
  return (
    <span className={`${s.dom} ${k.tone}`} title={k.label}>
      <Svg>{PATHS[k.icon]}</Svg>
    </span>
  );
}

export const IconPlus = () => <Svg size={15}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconDots = () => (
  <Svg size={18}>
    <circle cx="12" cy="5" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="12" cy="19" r="1.4" />
  </Svg>
);
export const IconCheck = ({ size = 15 }: { size?: number }) => <Svg size={size}><path d="M5 12l5 5 9-10" /></Svg>;
export const IconAlert = () => (
  <Svg size={18}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);
