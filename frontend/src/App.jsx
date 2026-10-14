import { useEffect, useState } from "react";
import AppShell from "./components/dashboard/AppShell.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";

export default function App() {
  const [path, setPath] = useState(() => {
    const p = window.location.pathname.replace(/\/+$/, "") || "/";
    return window.location.search ? `${p}${window.location.search}` : p;
  });

  function navigate(destination) {
    const nextPath = destination.replace(/\/+$/, "") || "/";
    const currentFull = window.location.pathname + window.location.search;
    if (nextPath !== currentFull) {
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
      "/deployments/detail": "Deployment Details",
      "/logs": "Observability logs",
    };
    const currentBase = path.split("?")[0];
    document.title = `DeployForge — ${titles[currentBase] || "Platform"}`;
  }, [path]);

  useEffect(() => {
    const onPopState = () => {
      const p = window.location.pathname.replace(/\/+$/, "") || "/";
      setPath(window.location.search ? `${p}${window.location.search}` : p);
    };
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
