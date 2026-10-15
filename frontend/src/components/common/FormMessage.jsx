/**
 * Standardized DeployForge FormMessage
 * Renders status, error, warning, and success alerts with semantic ARIA roles
 */
export default function FormMessage({ message, type = "error", className = "", style = {} }) {
  if (!message) return null;

  const isError = type === "error";
  const isSuccess = type === "success";

  return (
    <div
      className={`form-message-banner ${type} ${className}`}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        fontSize: "12px",
        fontWeight: 500,
        background: isError
          ? "rgba(239, 68, 68, 0.1)"
          : isSuccess
          ? "rgba(16, 185, 129, 0.1)"
          : "rgba(255, 255, 255, 0.05)",
        border: `1px solid ${
          isError
            ? "rgba(239, 68, 68, 0.25)"
            : isSuccess
            ? "rgba(16, 185, 129, 0.25)"
            : "var(--border-subtle)"
        }`,
        color: isError
          ? "var(--color-red, #ef4444)"
          : isSuccess
          ? "var(--color-green, #10b981)"
          : "var(--text-secondary)",
        ...style,
      }}
    >
      <span style={{ flexShrink: 0 }}>
        {isError ? "✕" : isSuccess ? "✓" : "ℹ"}
      </span>
      <span>{message}</span>
    </div>
  );
}
