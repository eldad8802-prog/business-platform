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
        background: "#ffffff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        padding: 24,
        textAlign: "center",
      }}
    >
      <h2
        style={{
          marginTop: 0,
          marginBottom: 12,
          fontSize: 22,
          color: "#111827",
        }}
      >
        {title}
      </h2>

      <p
        style={{
          marginTop: 0,
          marginBottom: actionLabel ? 18 : 0,
          fontSize: 15,
          color: "#6b7280",
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
            background: "#111827",
            color: "#ffffff",
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