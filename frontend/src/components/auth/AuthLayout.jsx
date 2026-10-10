import BrandMark from "./BrandMark.jsx";

export default function AuthLayout({ isRegistration = false, title, description, footer, children }) {
  return (
    <main className={`auth-wrapper${isRegistration ? " register-wrapper" : ""}`}>
      <section className="auth-card">
        <BrandMark />
        <header className="auth-header">
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {children}
        <footer className="auth-footer">
          <p>{footer}</p>
        </footer>
      </section>
    </main>
  );
}
