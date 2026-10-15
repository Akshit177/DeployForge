import React from "react";

/**
 * Standardized DeployForge TextInput
 * Supports:
 * - monospace variant (font-mono for repo URLs, ports, env keys, commits)
 * - helper text & validation error placement
 * - prefix icons (e.g. GitHubIcon, SearchIcon, TerminalIcon)
 * - suffix controls (e.g. visibility toggles, clear buttons)
 * - consistent focus rings & surface tokens
 */
export default function TextInput({
  id,
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  autoComplete,
  required = false,
  disabled = false,
  monospace = false,
  helperText,
  error,
  prefixIcon: PrefixIcon,
  suffix,
  className = "",
  inputClassName = "",
  onPaste,
  style = {},
  ...rest
}) {
  const inputId = id || (label ? label.toLowerCase().replace(/[^a-z0-9]/g, "-") : undefined);

  return (
    <div className={`form-field-group ${className}`} style={style}>
      {label && (
        <label htmlFor={inputId} className="form-label">
          {label}
          {required && <span className="required-star" aria-hidden="true" style={{ color: "var(--color-red, #ef4444)", marginLeft: "4px" }}>*</span>}
        </label>
      )}

      <div className={`text-input-wrap ${error ? "has-error" : ""}`} style={{ position: "relative", display: "flex", alignItems: "center", width: "100%" }}>
        {PrefixIcon && (
          <span className="input-prefix-icon" style={{ position: "absolute", left: "10px", display: "flex", alignItems: "center", color: "var(--text-secondary)", pointerEvents: "none", zIndex: 1 }}>
            {React.isValidElement(PrefixIcon) ? PrefixIcon : <PrefixIcon size={14} />}
          </span>
        )}

        <input
          id={inputId}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          autoComplete={autoComplete}
          onPaste={onPaste}
          className={`figma-text-input ${monospace ? "font-mono" : ""} ${inputClassName}`}
          style={{
            width: "100%",
            paddingLeft: PrefixIcon ? "32px" : "12px",
            paddingRight: suffix ? "36px" : "12px",
            fontFamily: monospace ? "var(--font-mono)" : "inherit",
            borderColor: error ? "var(--color-red, #ef4444)" : undefined,
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-help` : undefined}
          {...rest}
        />

        {suffix && (
          <div className="input-suffix-wrap" style={{ position: "absolute", right: "8px", display: "flex", alignItems: "center", zIndex: 1 }}>
            {suffix}
          </div>
        )}
      </div>

      {error ? (
        <span id={`${inputId}-error`} className="field-error-text" role="alert" style={{ fontSize: "11px", color: "var(--color-red, #ef4444)", marginTop: "4px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <span>{error}</span>
        </span>
      ) : helperText ? (
        <span id={`${inputId}-help`} className="field-helper-text" style={{ fontSize: "11.5px", color: "var(--text-secondary)", marginTop: "4px" }}>
          {helperText}
        </span>
      ) : null}
    </div>
  );
}
