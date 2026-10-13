import BrandMark from "./BrandMark.jsx";

export default function AuthLayout({ isRegistration = false, title, description, footer, children }) {
  return (
    <main className={`auth-wrapper${isRegistration ? " register-wrapper" : ""}`}>
      <header className="auth-topbar"><a href="/" className="auth-brand" aria-label="DeployForge home"><BrandMark /><span>DeployForge</span></a></header>
      <section className="auth-intro">
        <span className="eyebrow">DEPLOYFORGE PLATFORM</span>
        <h1>{isRegistration ? "From source code. To something live." : "Deploy in an Instant"}</h1>
        <p>{isRegistration ? "Create an account to build, deploy, and manage applications without managing servers." : "Sign in to manage your container-based deployments"}</p>
        <div className="auth-rule" />
        <span className="auth-caption">Built for developers who ship.</span>
      </section>
      <section className="auth-card">
        <header className="auth-header"><h2>{title}</h2><p>{description}</p></header>
        {children}
        <footer className="auth-footer"><p>{footer}</p></footer>
      </section>
      <footer className="auth-legal">© 2026 DeployForge. All rights reserved.</footer>
    </main>
  );
}
