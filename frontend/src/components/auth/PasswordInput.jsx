import { useState } from "react";

export default function PasswordInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
  forgotLink = false,
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="input-group">
      {forgotLink ? (
        <div className="label-row">
          <label htmlFor={id}>{label}</label>
          <a href="#" className="forgot-link" onClick={(event) => event.preventDefault()}>
            Forgot password?
          </a>
        </div>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      <div className="input-wrapper">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          required
          autoComplete={autoComplete}
          minLength={minLength}
        />
        <button
          type="button"
          className={`eye-toggle${visible ? " active" : ""}`}
          onClick={() => setVisible((current) => !current)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              d="M1.7181 10.2908C1.64865 10.1037 1.64865 9.89792 1.7181 9.71082C2.39452 8.0707 3.5427 6.66835 5.01708 5.68157C6.49146 4.69478 8.22564 4.168 9.99977 4.168C11.7739 4.168 13.5081 4.69478 14.9825 5.68157C16.4568 6.66835 17.605 8.0707 18.2814 9.71082C18.3509 9.89792 18.3509 10.1037 18.2814 10.2908C17.605 11.9309 16.4568 13.3333 14.9825 14.3201C13.5081 15.3069 11.7739 15.8336 9.99977 15.8336C8.22564 15.8336 6.49146 15.3069 5.01708 14.3201C3.5427 13.3333 2.39452 11.9309 1.7181 10.2908ZM12.5002 10.0005C12.5002 11.3812 11.3809 12.5005 10.0002 12.5005C8.61945 12.5005 7.50016 11.3812 7.50016 10.0005C7.50016 8.61981 8.61945 7.50052 10.0002 7.50052C11.3809 7.50052 12.5002 8.61981 12.5002 10.0005Z"
              strokeWidth="1.7"
              strokeLinecap="round"
              stroke="white"
              strokeOpacity="0.75"
            />
            {visible && (
              <path
                d="M3 3L17 17"
                strokeWidth="1.7"
                strokeLinecap="round"
                stroke="white"
                strokeOpacity="0.75"
              />
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
