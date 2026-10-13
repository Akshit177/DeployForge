import { useState, useMemo } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import {
  PlusIcon,
  SearchIcon,
  CloseIcon,
  CheckIcon,
  GitHubIcon,
  GitBranchIcon,
  CommitIcon,
  ExternalLinkIcon,
  ClockIcon,
  NodeIcon,
  GoIcon,
  PythonIcon,
  HtmlIcon,
  DockerIcon,
  CopyIcon,
} from "../components/common/TechIcons.jsx";

const initialProjects = [
  {
    id: "p1",
    name: "web-app",
    repo: "github.com/acme/web-app",
    state: "Running",
    url: "web-app.deployforge.app",
    age: "just now",
    runtimeType: "node",
    runtime: "Node 20 · :3000",
    commit: "3f9a2c1",
    branch: "main",
    deployId: "131",
  },
  {
    id: "p2",
    name: "api-gateway",
    repo: "github.com/acme/api-gateway",
    state: "Running",
    url: "api-gateway.deployforge.app",
    age: "1d ago",
    runtimeType: "go",
    runtime: "Go 1.22 · :8080",
    commit: "b81d04e",
    branch: "main",
    deployId: "130",
  },
  {
    id: "p3",
    name: "portfolio-site",
    repo: "github.com/jane/portfolio",
    state: "Building",
    url: "portfolio-site.deployforge.app",
    age: "38s",
    runtimeType: "static",
    runtime: "Static · :80",
    commit: "9c2e7aa",
    branch: "main",
    deployId: "124",
  },
  {
    id: "p4",
    name: "blog-engine",
    repo: "github.com/acme/blog-engine",
    state: "Failed",
    url: "blog-engine.deployforge.app",
    age: "3h ago",
    runtimeType: "python",
    runtime: "Python 3.12 · :8000",
    commit: "e47f190",
    branch: "develop",
    deployId: "128",
  },
  {
    id: "p5",
    name: "docs-portal",
    repo: "github.com/acme/docs",
    state: "Running",
    url: "docs-portal.deployforge.app",
    age: "5d ago",
    runtimeType: "node",
    runtime: "Node 20 · :3000",
    commit: "12ab9f3",
    branch: "main",
    deployId: "127",
  },
  {
    id: "p6",
    name: "chat-service",
    repo: "github.com/acme/chat-service",
    state: "Queued",
    url: "chat-service.deployforge.app",
    age: "position 1",
    runtimeType: "node",
    runtime: "Node 20 · :4000",
    commit: "a03bc55",
    branch: "main",
    deployId: "126",
  },
];

export default function ProjectsPage({ navigate }) {
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [copiedCommit, setCopiedCommit] = useState(null);

  const filterCounts = useMemo(() => {
    return {
      All: initialProjects.length,
      Running: initialProjects.filter((p) => p.state === "Running").length,
      Building: initialProjects.filter((p) => p.state === "Building").length,
      Failed: initialProjects.filter((p) => p.state === "Failed").length,
      Queued: initialProjects.filter((p) => p.state === "Queued").length,
    };
  }, []);

  const visibleProjects = useMemo(() => {
    return initialProjects.filter((p) => {
      const matchesSearch =
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.repo.toLowerCase().includes(query.toLowerCase()) ||
        p.commit.toLowerCase().includes(query.toLowerCase()) ||
        p.runtime.toLowerCase().includes(query.toLowerCase());

      const matchesStatus =
        activeFilter === "All" || p.state.toLowerCase() === activeFilter.toLowerCase();

      return matchesSearch && matchesStatus;
    });
  }, [query, activeFilter]);

  const handleCopyCommit = (e, commit) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(commit);
    setCopiedCommit(commit);
    setTimeout(() => setCopiedCommit(null), 1800);
  };

  const renderRuntimeIcon = (type) => {
    switch (type) {
      case "node":
        return <NodeIcon size={14} className="runtime-icon-svg" />;
      case "go":
        return <GoIcon size={14} className="runtime-icon-svg" />;
      case "python":
        return <PythonIcon size={14} className="runtime-icon-svg" />;
      case "static":
        return <HtmlIcon size={14} className="runtime-icon-svg" />;
      default:
        return <DockerIcon size={14} className="runtime-icon-svg" />;
    }
  };

  return (
    <div className="projects-page reveal">
      {/* Page Heading matching Figma */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Projects</h1>
          <p className="figma-page-subtitle">
            Deploy and manage applications from your GitHub repositories.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => navigate("/projects/new")}
        >
          <PlusIcon size={14} />
          <span>New Project</span>
        </button>
      </div>

      {/* Project Summary Metrics Strip */}
      <section className="figma-metrics-strip" aria-label="Project metrics summary">
        <div className="metric-box">
          <span className="metric-lbl">Total projects</span>
          <strong className="metric-val">{filterCounts.All}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-lbl">Running</span>
          <strong className="metric-val text-green">{filterCounts.Running}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-lbl">In progress</span>
          <strong className="metric-val text-amber">{filterCounts.Building + filterCounts.Queued}</strong>
        </div>
        <div className="metric-box">
          <span className="metric-lbl">Failed</span>
          <strong className="metric-val text-red">{filterCounts.Failed}</strong>
        </div>
      </section>

      {/* Project Controls: Filter Chips + Search */}
      <div className="figma-controls-bar">
        <div className="filter-chips-list" role="tablist" aria-label="Filter projects by status">
          {[
            { key: "All", label: `All  ${filterCounts.All}` },
            { key: "Running", label: `Running  ${filterCounts.Running}` },
            { key: "Building", label: `Building  ${filterCounts.Building}` },
            { key: "Failed", label: `Failed  ${filterCounts.Failed}` },
            { key: "Queued", label: `Queued  ${filterCounts.Queued}` },
          ].map((chip) => {
            const isSelected = activeFilter === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                className={`filter-chip ${isSelected ? "selected" : ""}`}
                onClick={() => setActiveFilter(chip.key)}
                role="tab"
                aria-selected={isSelected}
              >
                {isSelected && <CheckIcon size={11} className="chip-check-svg" />}
                <span>{chip.label}</span>
              </button>
            );
          })}
        </div>

        <div className="search-control-wrap">
          <SearchIcon size={14} className="search-icon" />
          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects by name, repo, runtime..."
            aria-label="Search projects by name, repo, or runtime"
          />
          {query && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Project Directory Grid */}
      <div className="figma-projects-grid">
        {visibleProjects.length > 0 ? (
          visibleProjects.map((p) => (
            <article
              key={p.name}
              className="figma-project-card"
              tabIndex={0}
              onClick={() => navigate("/deployments/detail")}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && navigate("/deployments/detail")}
              role="button"
              aria-label={`View deployment details for ${p.name}`}
            >
              <div className="card-top-row">
                <h3 className="card-project-name">{p.name}</h3>
                <StatusBadge value={p.state} size="sm" />
              </div>

              <div className="card-repo-row">
                <GitHubIcon size={13} className="repo-octo-icon" />
                <span className="card-repo-mono">{p.repo}</span>
              </div>

              <div className="card-commit-tag">
                <span className="commit-branch-item">
                  <GitBranchIcon size={12} className="branch-icon-svg" />
                  <span>{p.branch}</span>
                </span>
                <span className="dot-sep">·</span>
                <span
                  className="commit-hash-pill"
                  onClick={(e) => handleCopyCommit(e, p.commit)}
                  title="Click to copy commit SHA"
                >
                  <CommitIcon size={11} className="commit-icon-svg" />
                  <code>{p.commit}</code>
                  {copiedCommit === p.commit ? (
                    <span className="copied-tag">Copied</span>
                  ) : (
                    <CopyIcon size={10} className="copy-icon-hover" />
                  )}
                </span>
              </div>

              <div className="card-url-row">
                <a
                  className="card-domain-link"
                  href={`https://${p.url}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>{p.url}</span>
                  <ExternalLinkIcon size={12} className="ext-arrow-svg" />
                </a>
              </div>

              <footer className="card-footer-meta">
                <span className="footer-age">
                  <ClockIcon size={12} className="clock-icon-svg" />
                  <span>
                    {p.state === "Building"
                      ? `Building · ${p.age}`
                      : p.state === "Queued"
                      ? `Queued · ${p.age}`
                      : p.state === "Failed"
                      ? `Failed ${p.age}`
                      : `Deployed ${p.age}`}
                  </span>
                </span>

                <span className="footer-runtime-badge">
                  {renderRuntimeIcon(p.runtimeType)}
                  <span>{p.runtime}</span>
                </span>
              </footer>
            </article>
          ))
        ) : (
          <div className="figma-empty-state">
            <div className="empty-glyph-box">
              <SearchIcon size={24} className="empty-icon-svg" />
            </div>
            <h3>No projects found</h3>
            <p>No applications matched your search or status filter.</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setQuery("");
                setActiveFilter("All");
              }}
            >
              Reset filters
            </button>
          </div>
        )}
      </div>

      {/* Recent Activity List */}
      <section className="figma-recent-activity">
        <h2 className="recent-activity-heading">Recent activity</h2>
        <div className="activity-list">
          <div className="activity-row" onClick={() => navigate("/deployments/detail")} style={{ cursor: "pointer" }}>
            <span className="activity-icon text-green">
              <CheckIcon size={13} />
            </span>
            <p className="activity-text">Deployment #131 for <strong>web-app</strong> is now running</p>
            <time className="activity-time">Just now</time>
          </div>

          <div className="activity-row" onClick={() => navigate("/deployments/detail")} style={{ cursor: "pointer" }}>
            <span className="activity-icon text-green">
              <CheckIcon size={13} />
            </span>
            <p className="activity-text">Deployment #130 for <strong>api-gateway</strong> is now running</p>
            <time className="activity-time">2h ago</time>
          </div>

          <div className="activity-row" onClick={() => navigate("/deployments/detail")} style={{ cursor: "pointer" }}>
            <span className="activity-icon text-red">
              <CloseIcon size={12} />
            </span>
            <p className="activity-text">Deployment #128 for <strong>blog-engine</strong> failed during build</p>
            <time className="activity-time">3h ago</time>
          </div>
        </div>
      </section>
    </div>
  );
}
