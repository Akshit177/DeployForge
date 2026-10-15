import { useState } from "react";
import BrandLogo from "../components/common/BrandLogo.jsx";
import FormMessage from "../components/auth/FormMessage.jsx";
import PasswordInput from "../components/auth/PasswordInput.jsx";
import useAuthForm from "../hooks/useAuthForm.js";
import { register } from "../services/authService.js";

export default function RegisterPage({ onAuthenticated, onNavigate }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { message, messageType, isSubmitting, submit } = useAuthForm();

  async function handleSubmit(event) {
    if (event) event.preventDefault();
    const succeeded = await submit(async () => {
      const result = await register({
        user_name: name.trim(),
        email: email.trim(),
        password,
      });
      return result.message || "Account created successfully";
    });
    if (succeeded) {
      setTimeout(() => onAuthenticated(), 400);
    }
  }

  return (
    <div className="auth-figma-page">
      <header className="auth-figma-header">
        <div className="auth-brand-wrap" onClick={() => onNavigate("/")} style={{ cursor: "pointer" }}>
          <BrandLogo size={28} />
        </div>
        <button type="button" className="auth-back-link" onClick={() => onNavigate("/")}>
          ← Back to overview
        </button>
      </header>

      <main className="auth-figma-main reveal">
        <div className="auth-hero-col">
          <div className="auth-hero-badge">GET STARTED</div>
          <h1 className="auth-hero-title">
            Join DeployForge
          </h1>
          <p className="auth-hero-subtitle">
            Create an account to connect GitHub repositories, build isolated Docker containers, and issue live HTTPS endpoints.
          </p>

          <div className="auth-demo-tip">
            <div className="tip-header">
              <span>Fast-track Onboarding</span>
            </div>
            <p>Deploy in seconds with free development resources and automated Nginx routing.</p>
          </div>
        </div>

        <div className="auth-form-col">
          <div className="auth-card-inner">
            <div className="auth-card-header">
              <h2>Create your account</h2>
              <p>Start deploying in under 2 minutes</p>
            </div>

            <form className="auth-actual-form" onSubmit={handleSubmit}>
              <div className="form-field-group">
                <label htmlFor="name">Full Name</label>
                <input
                  id="name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Anurag Singh"
                  autoComplete="name"
                />
              </div>

              <div className="form-field-group">
                <label htmlFor="reg-email">Email Address</label>
                <input
                  id="reg-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="anurag@deployforge.dev"
                  autoComplete="email"
                />
              </div>

              <PasswordInput
                id="reg-password"
                name="password"
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
                minLength={8}
                required
              />

              <button
                type="submit"
                className="btn-primary auth-submit-btn"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Creating account..." : "Create Account →"}
              </button>
            </form>

            <FormMessage message={message} type={messageType} />

            <div className="auth-switch-link">
              <span>Already have an account?</span>{" "}
              <button type="button" onClick={() => onNavigate("/login")}>
                Sign In
              </button>
            </div>
          </div>
        </div>
      </main>

      <footer className="auth-figma-footer">
        <p>© 2026 DeployForge. All rights reserved.</p>
      </footer>
    </div>
  );
}
