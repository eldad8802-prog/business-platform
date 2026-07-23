import type { ReactNode } from "react";

export type QuickActionTone = "teal" | "blue" | "amber" | "violet";

export type QuickAction = {
  key: string;
  label: string;
  icon: ReactNode;
  tone: QuickActionTone;
  onClick: () => void;
};

/** 2×2 grid of quick actions, each with its own tone-tinted icon chip. */
export function QuickActionsGrid({ actions }: { actions: QuickAction[] }) {
  return (
    <div className="inv-hm-qa inv-hm-rise" style={{ animationDelay: "0.18s" }}>
      {actions.map((action) => (
        <button key={action.key} type="button" className="inv-hm-qtile" onClick={action.onClick}>
          <span className="lab">{action.label}</span>
          <span className={`ci inv-hm-ci--${action.tone}`} aria-hidden>
            {action.icon}
          </span>
        </button>
      ))}
    </div>
  );
}
