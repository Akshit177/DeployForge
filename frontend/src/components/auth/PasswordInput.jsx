// frontend/src/components/auth/PasswordInput.jsx
import React, { useState, useId } from 'react';

export default function PasswordInput({
  id: explicitId,
  label = 'Password',
  name = 'password',
  value,
  onChange,
  placeholder = '••••••••',
  error,
  autoComplete = 'current-password',
  required = true,
  disabled = false,
  minLength,
  forgotLink = false,
}) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const inputId = explicitId || generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="df-field input-group">
      {forgotLink ? (
        <div className="label-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label htmlFor={inputId} className="df-field__label">
            {label}
          </label>
          <a href="#" className="forgot-link" onClick={(event) => event.preventDefault()}>
            Forgot password?
          </a>
        </div>
      ) : (
        <label htmlFor={inputId} className="df-field__label">
          {label}
        </label>
      )}
      <div className="df-field__input-wrap input-wrapper">
        <input
          id={inputId}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          disabled={disabled}
          minLength={minLength}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={`df-input df-input--has-suffix ${error ? 'df-input--error' : ''}`.trim()}
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          className="df-field__icon-btn eye-toggle"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          tabIndex={0}
        >
          {visible ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      {error && (
        <p id={errorId} className="df-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
