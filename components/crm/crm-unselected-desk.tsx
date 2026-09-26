import type { ReactNode } from "react";
import { EmptySelection } from "@/components/ui/empty-selection";

/**
 * Desktop detail pane when nothing is selected.
 * Below the workspace tier the pane is hidden by WorkspaceLayout, so the
 * centered placeholder never competes with the list. At desktop the same
 * pane explains what the card actually contains — real sections, not metrics.
 */
export function CrmUnselectedDesk({
  icon,
  title,
  description,
  lead,
  facts,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  lead: string;
  facts: { title: string; body: string }[];
}) {
  return (
    <div className="crm-page crm-unselected" style={{ color: "var(--crm-muted)" }}>
      <EmptySelection icon={icon} title={title} description={description} />
      <aside className="crm-unselected__desk" aria-label={lead}>
        <p className="crm-unselected__lead">{lead}</p>
        <p className="crm-unselected__note">{description}</p>
        <ul className="crm-unselected__facts">
          {facts.map((fact) => (
            <li key={fact.title}>
              <strong>{fact.title}</strong>
              <span>{fact.body}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
