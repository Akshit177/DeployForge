import { useState } from "react";
import BrandLogo from "../components/common/BrandLogo.jsx";
import FormMessage from "../components/auth/FormMessage.jsx";
import useAuthForm from "../hooks/useAuthForm.js";
import { login } from "../services/authService.js";

export default function LoginPage({ onAuthenticated, onNavigate }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { message, messageType, isSubmitting, submit } = useAuthForm();

  async function handleSubmit(event) {
    if (event) event.preventDefault();
    const succeeded = await submit(async () => {
      const result = await login({ email: email.trim(), password });
      return result.message || "Logged in successfully";
    });
    if (succeeded) {
      setTimeout(() => onAuthenticated(), 400);
    }
  }

  const fillDemoAccount = () => {
    setEmail("anurag@deployforge.dev");
    setPassword("password123");
  };

  return (
    <div className="auth-figma-page">
      {/* Brand Header */}
      <header className="auth-figma-header">
        <div className="auth-brand-wrap" onClick={() => onNavigate("/")} style={{ cursor: "pointer" }}>
          <BrandLogo size={28} />
        </div>
        <button type="button" className="auth-back-link" onClick={() => onNavigate("/")}>
          ← Back to overview
        </button>
      </header>

      {/* Main Authentication Body */}
      <main className="auth-figma-main reveal">
        {/* Left Column: Hero Intro */}
        <div className="auth-hero-col">
          <div className="auth-hero-badge">AUTHENTICATION</div>
          <h1 className="auth-hero-title">
            Deploy in an Instant
          </h1>
          <p className="auth-hero-subtitle">
            Sign in to manage your container-based deployments, observe runtime logs, and configure production pipelines.
          </p>

          <div className="auth-demo-tip">
            <div className="tip-header">
              <span>Quick Demo Access</span>
              <button type="button" className="tip-fill-btn" onClick={fillDemoAccount}>
                Prefill Demo
              </button>
            </div>
            <p>Or launch right into the console anytime.</p>
          </div>
        </div>

        {/* Right Column: Login Card */}
        <div className="auth-form-col">
          <div className="auth-card-inner">
            <div className="auth-card-header">
              <h2>Sign in to DeployForge</h2>
              <p>Enter your workspace credentials</p>
            </div>

            <form className="auth-actual-form" onSubmit={handleSubmit}>
              <div className="form-field-group">
                <label htmlFor="email">Email Address</label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="email@company.com"
                  autoComplete="email"
                />
              </div>

              <div className="form-field-group">
                <div className="label-with-link">
                  <label htmlFor="password">Password</label>
                  <button
                    type="button"
                    className="toggle-pw-btn"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="password-input-wrap">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="btn-primary auth-submit-btn"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Authenticating..." : "Log In →"}
              </button>

              <button
                type="button"
                className="btn-secondary auth-guest-btn"
                onClick={() => onAuthenticated()}
              >
                Continue as Guest / Preview Console
              </button>
            </form>

            <FormMessage message={message} type={messageType} />

            <div className="auth-switch-link">
              <span>Don’t have an account?</span>{" "}
              <button type="button" onClick={() => onNavigate("/register")}>
                Sign Up
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="auth-figma-footer">
        <p>© 2026 DeployForge. All rights reserved.</p>
      </footer>
    </div>
  );
}
