import { TOKEN } from "@/lib/design/tokens";

type IssueEmptyStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
};

export default function IssueEmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: IssueEmptyStateProps) {
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 24,
        border: "1px solid var(--dz-border)",
        padding: 24,
        textAlign: "center",
      }}
    >
      <h2
        style={{
          marginTop: 0,
          marginBottom: 12,
          fontSize: 22,
          color: "var(--dz-text-primary)",
        }}
      >
        {title}
      </h2>

      <p
        style={{
          marginTop: 0,
          marginBottom: actionLabel ? 18 : 0,
          fontSize: 15,
          color: "var(--dz-text-muted)",
          lineHeight: 1.6,
        }}
      >
        {description}
      </p>

      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={{
            padding: "12px 16px",
            borderRadius: 14,
            border: "none",
            background: TOKEN.action.primary.background,
            color: "var(--dz-text-on-brand)",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}