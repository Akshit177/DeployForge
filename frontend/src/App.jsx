import { useEffect, useState } from "react";
import AppShell from "./components/dashboard/AppShell.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import NewProjectPage from "./pages/NewProjectPage.jsx";
import DeploymentsPage from "./pages/DeploymentsPage.jsx";
import DeploymentDetailPage from "./pages/DeploymentDetailPage.jsx";
import LogsPage from "./pages/LogsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

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

  // Canonicalize /dashboard to /projects
  useEffect(() => {
    const [pathname, search] = path.split("?");
    if (pathname === "/dashboard") {
      const canonicalTarget = `/projects${search ? `?${search}` : ""}`;
      window.history.replaceState({}, "", canonicalTarget);
      setPath(canonicalTarget);
    }
  }, [path]);

  // Centralized 401 session expiration handling
  useEffect(() => {
    const handleUnauthorized = () => {
      const currentBase = window.location.pathname.replace(/\/+$/, "") || "/";
      if (currentBase !== "/login" && currentBase !== "/register" && currentBase !== "/") {
        navigate("/login");
      }
    };

    window.addEventListener("auth:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
  }, []);

  useEffect(() => {
    const titles = {
      "/": "Code. Deploy. Done.",
      "/login": "Sign in",
      "/register": "Create account",
      "/projects": "Projects",
      "/dashboard": "Projects",
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

  // Determine active view inside authenticated workspace
  const [pathname, search] = path.split("?");
  const searchParams = new URLSearchParams(search || "");

  let workspaceContent;
  if (pathname === "/projects/new") {
    workspaceContent = <NewProjectPage navigate={navigate} searchParams={searchParams} />;
  } else if (pathname === "/deployments/detail") {
    workspaceContent = <DeploymentDetailPage navigate={navigate} searchParams={searchParams} />;
  } else if (pathname === "/deployments") {
    workspaceContent = <DeploymentsPage navigate={navigate} searchParams={searchParams} />;
  } else if (pathname === "/logs") {
    workspaceContent = <LogsPage navigate={navigate} searchParams={searchParams} />;
  } else if (pathname === "/settings") {
    workspaceContent = <SettingsPage navigate={navigate} searchParams={searchParams} />;
  } else {
    // Canonical default for /projects and /dashboard
    workspaceContent = <ProjectsPage navigate={navigate} searchParams={searchParams} />;
  }

  // Authenticated Console / Workspace
  return (
    <AppShell path={path} navigate={navigate}>
      {workspaceContent}
    </AppShell>
  );
}
