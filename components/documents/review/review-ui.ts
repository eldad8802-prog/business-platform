export function basePageStyle() {
  return { minHeight: "100vh", background: "#f3f7ff" as const };
}

export function mainStyle() {
  return {
    maxWidth: 1120,
    margin: "0 auto",
    padding: "20px 14px 36px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 14,
  };
}

export function primaryDarkButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 50,
    borderRadius: 10,
    border: "none",
    background: disabled ? "rgba(0, 43, 107, 0.45)" : "#22c55e",
    color: "#ffffff",
    fontSize: 15,
    fontWeight: 950,
    cursor: disabled ? "not-allowed" : "pointer",
  } as const;
}

export function secondaryButton(disabled?: boolean) {
  return {
    width: "100%",
    minHeight: 50,
    borderRadius: 10,
    border: "1px solid #dfe7f3",
    background: "#ffffff",
    color: "#002b6b",
    fontSize: 14,
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  } as const;
}
