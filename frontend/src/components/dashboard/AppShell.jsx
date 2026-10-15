import { useState, useEffect } from "react";
import BrandLogo from "../common/BrandLogo.jsx";
import CommandPalette from "../common/CommandPalette.jsx";
import { getCurrentUser, logout } from "../../services/authService.js";
import { fetchDeployments } from "../../services/deploymentService.js";
import {
  ProjectsNavIcon,
  DeploymentsNavIcon,
  LogsNavIcon,
  SettingsNavIcon,
  SearchIcon,
  PlusIcon,
  MenuIcon,
  CloseIcon,
  ExternalLinkIcon,
  SignOutIcon,
} from "../common/TechIcons.jsx";

export default function AppShell({ path, navigate, children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [deploymentCount, setDeploymentCount] = useState(null);

  // Auto-close mobile & tablet drawer on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [path]);

  // Close mobile drawer on Escape key and manage body scroll lock on small screens
  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  // Global Cmd+K / Ctrl+K keyboard shortcut to toggle Command Palette
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    let isMounted = true;
    getCurrentUser()
      .then((user) => {
        if (!isMounted) return;
        if (user) {
          setCurrentUser(user);
        } else {
          navigate("/login");
        }
      })
      .catch(() => {
        if (isMounted) {
          navigate("/login");
        }
      });

    fetchDeployments()
      .then((list) => {
        if (isMounted && Array.isArray(list)) {
          setDeploymentCount(list.length);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [path]);

  const navLinks = [
    { label: "Projects", path: "/projects", Icon: ProjectsNavIcon },
    {
      label: "Deployments",
      path: "/deployments",
      Icon: DeploymentsNavIcon,
      count: deploymentCount !== null ? String(deploymentCount) : undefined,
    },
    { label: "Logs", path: "/logs", Icon: LogsNavIcon, count: "Live" },
    { label: "Settings", path: "/settings", Icon: SettingsNavIcon },
  ];

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      console.warn("Logout error:", err);
    }
    navigate("/login");
  };

  const active = path.startsWith("/projects/new")
    ? "/projects"
    : path.startsWith("/deployments/detail")
    ? "/deployments"
    : path.startsWith("/projects")
    ? "/projects"
    : path.startsWith("/deployments")
    ? "/deployments"
    : path.startsWith("/logs")
    ? "/logs"
    : path.startsWith("/settings")
    ? "/settings"
    : "/projects";

  const handleNav = (target) => {
    setMenuOpen(false);
    navigate(target);
  };

  const getBreadcrumbTitle = () => {
    const basePath = path.split("?")[0];
    if (basePath === "/projects/new") return "Projects / New Project";
    if (basePath === "/deployments/detail") return "Deployments / Details";
    if (basePath === "/projects") return "Projects";
    if (basePath === "/deployments") return "Deployments";
    if (basePath === "/logs") return "Logs";
    if (basePath === "/settings") return "Settings";
    return "Projects";
  };

  return (
    <div className="app-shell-container df-app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      {/* Backdrop for mobile navigation */}
      {menuOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar matching Figma specifications & Vercel precision */}
      <aside className={`app-sidebar df-sidebar ${menuOpen ? "open df-sidebar--open" : ""}`} aria-label="Main sidebar navigation">
        <div className="sidebar-top">
          {/* Brand */}
          <div
            className="sidebar-brand"
            onClick={() => handleNav("/projects")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleNav("/projects")}
            aria-label="DeployForge home, go to projects"
          >
            <BrandLogo size={24} />
          </div>

          {/* Account Avatar Block */}
          <div
            className="sidebar-account-block"
            onClick={() => handleNav("/settings")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleNav("/settings")}
            aria-label="Account profile, go to settings"
          >
            <div className="avatar-chip">
              <span className="avatar-initial">
                {currentUser?.user_name ? currentUser.user_name.charAt(0).toUpperCase() : "A"}
              </span>
            </div>
            <div className="account-info">
              <strong className="account-name">
                {currentUser?.user_name || "Workspace"}
              </strong>
              <small className="account-type">
                {currentUser?.email ? currentUser.email : "Personal workspace"}
              </small>
            </div>
          </div>

          {/* Search Trigger */}
          <div
            className="sidebar-search-btn"
            onClick={() => setCmdOpen(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setCmdOpen(true)}
            aria-label="Search workspace"
          >
            <SearchIcon size={14} className="sidebar-search-svg" />
            <span className="search-placeholder">Search</span>
            <kbd className="search-shortcut">⌘K</kbd>
          </div>

          {/* Destinations */}
          <nav className="sidebar-nav" aria-label="Sidebar destinations">
            {navLinks.map((item) => {
              const isActive = active === item.path;
              const IconComponent = item.Icon;
              return (
                <button
                  key={item.path}
                  type="button"
                  className={`sidebar-nav-item ${isActive ? "active" : ""}`}
                  onClick={() => handleNav(item.path)}
                >
                  <span className="nav-item-icon">
                    <IconComponent size={16} />
                  </span>
                  <span className="nav-item-label">{item.label}</span>
                  {item.count && (
                    <span className={`nav-item-badge ${item.count === "Live" ? "live" : ""}`}>
                      {item.count === "Live" && <i className="live-dot" />}
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Bottom / Quick Actions */}
        <div className="sidebar-bottom">
          {currentUser && (
            <div
              className="sidebar-user-pill"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.5rem 0.625rem",
                marginBottom: "0.375rem",
                borderRadius: "var(--radius-sm)",
                background: "rgba(255, 255, 255, 0.03)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div
                style={{
                  width: "22px",
                  height: "22px",
                  borderRadius: "50%",
                  background: "var(--border-strong)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  flexShrink: 0,
                }}
              >
                {(currentUser.username || currentUser.user_name || currentUser.name || currentUser.email || "U")[0].toUpperCase()}
              </div>
              <div
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                {currentUser.username || currentUser.user_name || currentUser.name || currentUser.email}
              </div>
            </div>
          )}
          <button
            type="button"
            className="sidebar-bottom-link logout"
            onClick={handleLogout}
          >
            <span className="bottom-link-icon">
              <SignOutIcon size={14} />
            </span>
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="app-main-pane">
        {/* Top Navbar */}
        <header className="app-topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="mobile-menu-btn"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label="Toggle navigation menu"
              aria-expanded={menuOpen}
            >
              {menuOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
            </button>
            <div className="topbar-breadcrumb">
              <span
                className="crumb-root"
                onClick={() => handleNav("/projects")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleNav("/projects")}
                aria-label="DeployForge home, go to projects"
              >
                DeployForge
              </span>
              <span className="crumb-sep">/</span>
              <strong className="crumb-current">{getBreadcrumbTitle()}</strong>
            </div>
          </div>

          <div className="topbar-right">
            <div className="topbar-status-pill" title="DeployForge Platform Services Online">
              <span className="status-indicator status-dot green-pulse" style={{ display: "inline-block", width: "7px", height: "7px" }} />
              <span className="status-pill-text" style={{ fontSize: "12px", color: "var(--text-secondary)", fontWeight: 500 }}>System Online</span>
            </div>

            <button
              type="button"
              className="quick-search-btn"
              onClick={() => setCmdOpen(true)}
              aria-label="Open command palette"
            >
              <SearchIcon size={13} />
              <span>Search workspace...</span>
              <kbd>⌘K</kbd>
            </button>

            {path !== "/projects/new" && (
              <button
                type="button"
                className="btn-primary btn-sm header-new-btn"
                onClick={() => handleNav("/projects/new")}
              >
                <PlusIcon size={13} />
                <span>New Project</span>
              </button>
            )}
          </div>
        </header>

        {/* Content Body */}
        <main id="main-content" className="app-content-body">
          {children}
        </main>
      </div>

      {/* Command Palette Modal */}
      <CommandPalette
        isOpen={cmdOpen}
        onClose={setCmdOpen}
        navigate={handleNav}
      />
    </div>
  );
}
