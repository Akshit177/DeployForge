import { useState, useMemo, useEffect, useRef } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import { fetchProjects, deleteProject } from "../services/projectService.js";
import { triggerDeployment } from "../services/deploymentService.js";
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
  TrashIcon,
  SpinnerIcon,
  PlayIcon,
} from "../components/common/TechIcons.jsx";

function timeAgo(dateString) {
  if (!dateString) return "just now";
  const past = new Date(dateString);
  if (Number.isNaN(past.getTime())) return "just now";
  const diffSec = Math.max(0, Math.floor((Date.now() - past.getTime()) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function getStageProgress(rawStatus) {
  const s = (rawStatus || "").toLowerCase().trim();
  switch (s) {
    case "initiated":
      return { percent: 15, label: "Initiating pipeline...", color: "amber", active: true };
    case "queued":
      return { percent: 30, label: "Queued in Redis stream", color: "amber", active: true };
    case "cloning":
      return { percent: 50, label: "Cloning Git repository...", color: "amber", active: true };
    case "building":
      return { percent: 75, label: "Compiling container image...", color: "amber", active: true };
    case "starting":
      return { percent: 90, label: "Spawning & health checking...", color: "emerald", active: true };
    case "running":
    case "succeeded":
    case "live":
      return { percent: 100, label: "Healthy & active", color: "emerald", active: false };
    case "failed":
      return { percent: 100, label: "Deployment failed", color: "red", active: false };
    default:
      return { percent: 0, label: "Stopped", color: "muted", active: false };
  }
}

export default function ProjectsPage({ navigate }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");
  const [copiedCommit, setCopiedCommit] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [redeployingId, setRedeployingId] = useState(null);
  const [redeployNotice, setRedeployNotice] = useState(null);

  const pollTimerRef = useRef(null);

  const loadProjects = async (isBackground = false) => {
    try {
      if (!isBackground) setLoading(true);
      setError(null);
      const data = await fetchProjects();
      setProjects(data);
    } catch (err) {
      console.warn("Could not load backend projects:", err.message);
      if (!isBackground) setError(err.message);
    } finally {
      if (!isBackground) setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // Poll when any project is in an active build/start stage
  useEffect(() => {
    const hasActiveProjects = projects.some((p) => {
      const s = (p.state || p.status || "").toLowerCase().trim();
      return ["initiated", "queued", "cloning", "building", "starting"].includes(s);
    });

    if (hasActiveProjects) {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(() => {
          loadProjects(true);
        }, 3500);
      }
    } else {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [projects]);

  const handleDelete = async (e, id, name) => {
    e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete project "${name}"? This action cannot be undone.`)) {
      return;
    }
    try {
      setDeletingId(id);
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      alert(`Failed to delete project: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleRedeploy = async (e, p) => {
    e.stopPropagation();
    if (redeployingId === p.id) return;
    try {
      setRedeployingId(p.id);
      await triggerDeployment({
        project_id: p.id,
        branch: p.branch || "main",
        commit_message: "Manual redeploy trigger",
        environment: "production",
      });

      // Optimistically update status to QUEUED in local state
      setProjects((prev) =>
        prev.map((proj) => (proj.id === p.id ? { ...proj, status: "QUEUED", state: "QUEUED" } : proj))
      );

      setRedeployNotice(`Redeployment triggered for "${p.name}". Pipeline dispatched to worker.`);
      setTimeout(() => setRedeployNotice(null), 4000);
    } catch (err) {
      alert(`Could not trigger deployment: ${err.message}`);
    } finally {
      setRedeployingId(null);
    }
  };

  const filterCounts = useMemo(() => {
    return {
      All: projects.length,
      Running: projects.filter((p) => {
        const s = (p.state || p.status || "").toLowerCase();
        return s === "running" || s === "succeeded" || s === "live";
      }).length,
      Building: projects.filter((p) => {
        const s = (p.state || p.status || "").toLowerCase();
        return s === "building" || s === "cloning" || s === "starting";
      }).length,
      Failed: projects.filter((p) => (p.state || p.status || "").toLowerCase() === "failed").length,
      Queued: projects.filter((p) => {
        const s = (p.state || p.status || "").toLowerCase();
        return s === "queued" || s === "initiated";
      }).length,
    };
  }, [projects]);

  const visibleProjects = useMemo(() => {
    return projects.filter((p) => {
      const pName = p.name || "";
      const pRepo = p.repo || p.repository_url || "";
      const pCommit = p.commit || p.latest_commit || "";
      const pRuntime = p.runtime || "";
      const pStatus = (p.state || p.status || "Queued").toLowerCase();

      const matchesSearch =
        pName.toLowerCase().includes(query.toLowerCase()) ||
        pRepo.toLowerCase().includes(query.toLowerCase()) ||
        pCommit.toLowerCase().includes(query.toLowerCase()) ||
        pRuntime.toLowerCase().includes(query.toLowerCase());

      if (!matchesSearch) return false;
      if (activeFilter === "All") return true;
      if (activeFilter === "Running") return pStatus === "running" || pStatus === "succeeded" || pStatus === "live";
      if (activeFilter === "Building") return pStatus === "building" || pStatus === "cloning" || pStatus === "starting";
      if (activeFilter === "Failed") return pStatus === "failed";
      if (activeFilter === "Queued") return pStatus === "queued" || pStatus === "initiated";
      return true;
    });
  }, [projects, query, activeFilter]);

  const handleCopyCommit = (e, commit) => {
    e.stopPropagation();
    if (!commit) return;
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

      {/* Redeploy Notification Toast */}
      {redeployNotice && (
        <div className="auth-message-block success" style={{ marginBottom: "1.25rem" }}>
          <CheckIcon size={14} />
          <span>{redeployNotice}</span>
        </div>
      )}

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

      {/* Error notification banner if any */}
      {error && (
        <div className="auth-message-block error" style={{ marginBottom: "1.5rem" }}>
          <span>Failed to sync with backend: {error}</span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => loadProjects(false)}
            style={{ marginLeft: "1rem" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Project Directory Grid */}
      <div className="figma-projects-grid">
        {loading ? (
          <div className="figma-empty-state">
            <div className="empty-glyph-box">
              <SpinnerIcon size={24} className="spin" />
            </div>
            <h3>Loading workspace projects...</h3>
            <p>Fetching project repositories and deployment states.</p>
          </div>
        ) : visibleProjects.length > 0 ? (
          visibleProjects.map((p) => {
            const state = p.state || p.status || "Queued";
            const ageDisplay = timeAgo(p.created_at);
            const isDeleting = deletingId === p.id;
            const isRedeploying = redeployingId === p.id;
            const stageProgress = getStageProgress(state);
            const rawDomain = p.url || p.domain || `${p.name}.deployforge.app`;
            const domainHref = rawDomain.startsWith("http") ? rawDomain : `https://${rawDomain}`;

            return (
              <article
                key={p.id || p.name}
                className="figma-project-card"
                tabIndex={0}
                onClick={() => navigate(`/deployments/detail?project_id=${p.id}&project_name=${encodeURIComponent(p.name)}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    navigate(`/deployments/detail?project_id=${p.id}&project_name=${encodeURIComponent(p.name)}`);
                  }
                }}
                role="button"
                aria-label={`View deployment details for ${p.name}`}
                style={{ opacity: isDeleting ? 0.4 : 1 }}
              >
                <div className="card-top-row">
                  <h3 className="card-project-name">{p.name}</h3>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <StatusBadge value={state} size="sm" />
                    <button
                      type="button"
                      className="btn-card-redeploy"
                      disabled={isRedeploying || stageProgress.active}
                      onClick={(e) => handleRedeploy(e, p)}
                      title={stageProgress.active ? "Pipeline currently in progress" : "Trigger new deployment"}
                      aria-label={`Redeploy ${p.name}`}
                    >
                      {isRedeploying ? (
                        <SpinnerIcon size={11} className="spin" />
                      ) : (
                        <PlayIcon size={10} />
                      )}
                      <span>{isRedeploying ? "Triggering..." : "Redeploy"}</span>
                    </button>
                    <button
                      type="button"
                      className="env-del-btn"
                      onClick={(e) => handleDelete(e, p.id, p.name)}
                      aria-label={`Delete project ${p.name}`}
                      title="Delete project"
                      style={{ opacity: 0.7, padding: "2px" }}
                    >
                      <TrashIcon size={13} />
                    </button>
                  </div>
                </div>

                <div className="card-repo-row">
                  <GitHubIcon size={13} className="repo-octo-icon" />
                  <span className="card-repo-mono">{p.repo || p.repository_url}</span>
                </div>

                <div className="card-commit-tag">
                  <span className="commit-branch-item">
                    <GitBranchIcon size={12} className="branch-icon-svg" />
                    <span>{p.branch || "main"}</span>
                  </span>
                  <span className="dot-sep">·</span>
                  <span
                    className="commit-hash-pill"
                    onClick={(e) => handleCopyCommit(e, p.commit || p.latest_commit)}
                    title="Click to copy commit SHA"
                  >
                    <CommitIcon size={11} className="commit-icon-svg" />
                    <code>{(p.commit || p.latest_commit || "HEAD").slice(0, 7)}</code>
                    {copiedCommit === (p.commit || p.latest_commit) ? (
                      <span className="copied-tag">Copied</span>
                    ) : (
                      <CopyIcon size={10} className="copy-icon-hover" />
                    )}
                  </span>
                </div>

                {/* Stage Progress Bar for active or failed deployments */}
                {stageProgress.active && (
                  <div className="card-stage-progress" onClick={(e) => e.stopPropagation()}>
                    <div className="stage-progress-track">
                      <div
                        className={`stage-progress-fill ${stageProgress.color}`}
                        style={{ width: `${stageProgress.percent}%` }}
                      />
                    </div>
                    <div className="stage-progress-meta">
                      <span className="stage-progress-step">
                        <SpinnerIcon size={11} className="spin text-amber" />
                        <span>{stageProgress.label}</span>
                      </span>
                      <span className="stage-progress-percent">{stageProgress.percent}%</span>
                    </div>
                  </div>
                )}

                <div className="card-url-row">
                  <a
                    className="card-domain-link"
                    href={domainHref}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    title="Open live production domain in new tab"
                  >
                    <span>{rawDomain}</span>
                    <ExternalLinkIcon size={12} className="ext-arrow-svg" />
                  </a>
                </div>

                <footer className="card-footer-meta">
                  <span className="footer-age">
                    <ClockIcon size={12} className="clock-icon-svg" />
                    <span>
                      {state === "Building"
                        ? `Building · ${ageDisplay}`
                        : state === "Queued"
                        ? `Queued · ${ageDisplay}`
                        : state === "Failed"
                        ? `Failed ${ageDisplay}`
                        : `Deployed ${ageDisplay}`}
                    </span>
                  </span>

                  <span className="footer-runtime-badge">
                    {renderRuntimeIcon(p.runtimeType || "node")}
                    <span>{p.runtime}</span>
                  </span>
                </footer>
              </article>
            );
          })
        ) : (
          <div className="figma-empty-state">
            <div className="empty-glyph-box">
              <SearchIcon size={24} className="empty-icon-svg" />
            </div>
            <h3>{query || activeFilter !== "All" ? "No matching projects" : "No projects yet"}</h3>
            <p>
              {query || activeFilter !== "All"
                ? "No applications matched your search or status filter."
                : "You haven't imported any applications yet. Connect a GitHub repository containing a root Dockerfile to launch your first service."}
            </p>
            {query || activeFilter !== "All" ? (
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
            ) : (
              <button
                type="button"
                className="btn-primary"
                onClick={() => navigate("/projects/new")}
              >
                <PlusIcon size={14} />
                <span>Create your first project</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Recent Activity List */}
      <section className="figma-recent-activity">
        <h2 className="recent-activity-heading">Recent activity</h2>
        <div className="activity-list">
          {projects.length > 0 ? (
            projects.slice(0, 3).map((p) => (
              <div
                key={p.id}
                className="activity-row"
                onClick={() => navigate(`/deployments/detail?project_id=${p.id}&project_name=${encodeURIComponent(p.name)}`)}
                style={{ cursor: "pointer" }}
              >
                <span className="activity-icon text-green">
                  <CheckIcon size={13} />
                </span>
                <p className="activity-text">
                  Project <strong>{p.name}</strong> was registered and queued for deployment
                </p>
                <time className="activity-time">{timeAgo(p.created_at)}</time>
              </div>
            ))
          ) : (
            <div className="activity-row">
              <span className="activity-icon text-muted">
                <ClockIcon size={13} />
              </span>
              <p className="activity-text">No recent deployment activity to report.</p>
              <time className="activity-time">—</time>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
