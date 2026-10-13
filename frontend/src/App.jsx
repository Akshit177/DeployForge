import { useEffect, useState } from "react";
import AppShell from "./components/dashboard/AppShell.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname.replace(/\/+$/, "") || "/");

  function navigate(destination) {
    const nextPath = destination.replace(/\/+$/, "") || "/";
    if (nextPath !== window.location.pathname) {
      window.history.pushState({}, "", nextPath);
    }
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    const titles = {
      "/": "Code. Deploy. Done.",
      "/login": "Sign in",
      "/register": "Create account",
      "/projects": "Projects",
      "/projects/new": "New project",
      "/settings": "Settings",
      "/deployments": "Deployments",
      "/deployments/detail": "Deployment #131",
      "/logs": "Observability logs",
    };
    document.title = `DeployForge — ${titles[path] || "Platform"}`;
  }, [path]);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname.replace(/\/+$/, "") || "/");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Landing / Marketing page
  if (path === "/") {
    return <LandingPage navigate={navigate} />;
  }

  // Authentication pages
  if (path === "/login") {
    return <LoginPage onAuthenticated={() => navigate("/projects")} onNavigate={navigate} />;
  }

  if (path === "/register") {
    return <RegisterPage onAuthenticated={() => navigate("/projects")} onNavigate={navigate} />;
  }

  // Authenticated Console / Workspace
  return (
    <AppShell path={path} navigate={navigate}>
      <DashboardPage path={path} navigate={navigate} />
    </AppShell>
  );
}
