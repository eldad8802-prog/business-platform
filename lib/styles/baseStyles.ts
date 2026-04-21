export const baseStyles = {
  page: {
    minHeight: "100vh",
    background: "#f9fafb",
    padding: 20,
  },
  container: {
    maxWidth: 600,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column" as const,
  },
  footer: {
    position: "fixed" as const,
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    background: "#fff",
    borderTop: "1px solid #eee",
  },
  cta: {
    width: "100%",
    padding: 14,
    background: "#111",
    color: "#fff",
    borderRadius: 12,
    border: "none",
    fontSize: 16,
    cursor: "pointer",
  },
};