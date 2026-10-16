import { useState, useMemo, useEffect, useRef } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import FormMessage from "../components/common/FormMessage.jsx";
import { fetchDeployments, triggerDeployment, cancelDeployment, stopDeployment } from "../services/deploymentService.js";
import {
  SearchIcon,
  CloseIcon,
  CheckIcon,
  GitBranchIcon,
  CommitIcon,
  ClockIcon,
  ArrowRightIcon,
  CopyIcon,
  SpinnerIcon,
  PlayIcon,
  PauseIcon,
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

const FILTER_OPTIONS = ["All", "Succeeded", "Building", "Queued", "Failed", "Stopped"];

function getFilterFromParam(params) {
  const p = params?.get("status");
  if (!p) return "All";
  const match = FILTER_OPTIONS.find((opt) => opt.toLowerCase() === p.toLowerCase());
  return match || "All";
}

export default function DeploymentsPage({ navigate, searchParams }) {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedProject, setSelectedProject] = useState("All projects");
  const [filter, setFilter] = useState(() => getFilterFromParam(searchParams));
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState(null);
  const [actioningId, setActioningId] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const nextFilter = getFilterFromParam(searchParams);
    setFilter(nextFilter);
  }, [searchParams]);

  const pollTimerRef = useRef(null);
  const pollAbortRef = useRef(null);
  const isMountedRef = useRef(true);

  const loadData = async (isBackground = false, signal = null) => {
    try {
      if (!isBackground) setLoading(true);
      setError(null);
      const data = await fetchDeployments({}, { signal });
      if (isMountedRef.current && !signal?.aborted) {
        setDeployments(data);
      }
    } catch (err) {
      if (err.name !== "AbortError" && isMountedRef.current) {
        console.warn("Could not load deployments:", err.message);
        if (!isBackground) setError(err.message);
      }
    } finally {
      if (!isBackground && isMountedRef.current && !signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    const initialAbort = new AbortController();
    loadData(false, initialAbort.signal);

    return () => {
      isMountedRef.current = false;
      initialAbort.abort();
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (pollAbortRef.current) {
        pollAbortRef.current.abort();
        pollAbortRef.current = null;
      }
    };
  }, []);

  // Poll while any deployment is in active build/deploy pipeline, pausing when tab is hidden
  useEffect(() => {
    const hasActive = deployments.some((d) => {
      const s = (d.status || d.state || "").toLowerCase().trim();
      return ["initiated", "queued", "cloning", "building", "starting", "deploying"].includes(s);
    });

    if (!hasActive) {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (pollAbortRef.current) {
        pollAbortRef.current.abort();
        pollAbortRef.current = null;
      }
      return;
    }

    let isPolling = true;

    const schedulePoll = () => {
      if (!isPolling || !isMountedRef.current) return;
      pollTimerRef.current = setTimeout(async () => {
        if (!isPolling || !isMountedRef.current) return;
        // Pause if document is hidden (background tab)
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          schedulePoll();
          return;
        }

        if (pollAbortRef.current) {
          pollAbortRef.current.abort();
        }
        pollAbortRef.current = new AbortController();

        try {
          await loadData(true, pollAbortRef.current.signal);
        } finally {
          if (isPolling && isMountedRef.current) {
            schedulePoll();
          }
        }
      }, 3500);
    };

    schedulePoll();

    return () => {
      isPolling = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (pollAbortRef.current) {
        pollAbortRef.current.abort();
        pollAbortRef.current = null;
      }
    };
  }, [deployments]);

  const projectsList = useMemo(() => {
    const names = Array.from(new Set(deployments.map((d) => d.project || d.projectName).filter(Boolean)));
    return ["All projects", ...names];
  }, [deployments]);

  const filteredDeployments = useMemo(() => {
    return deployments.filter((d) => {
      const pName = d.project || d.projectName || "";
      const matchProject = selectedProject === "All projects" || pName === selectedProject;
      const statusStr = (d.state || d.status || "Queued").toLowerCase();

      let matchFilter = filter === "All";
      if (filter === "Succeeded") matchFilter = statusStr === "succeeded" || statusStr === "running" || statusStr === "live";
      if (filter === "Building") matchFilter = statusStr === "building" || statusStr === "cloning" || statusStr === "starting" || statusStr === "deploying";
      if (filter === "Queued") matchFilter = statusStr === "queued" || statusStr === "initiated";
      if (filter === "Failed") matchFilter = statusStr === "failed";
      if (filter === "Stopped") matchFilter = statusStr === "stopped" || statusStr === "cancelled";

      const matchQuery =
        (d.message || "").toLowerCase().includes(query.toLowerCase()) ||
        (d.commit || "").toLowerCase().includes(query.toLowerCase()) ||
        (d.display_id || d.id || "").toLowerCase().includes(query.toLowerCase()) ||
        pName.toLowerCase().includes(query.toLowerCase());

      return matchProject && matchFilter && matchQuery;
    });
  }, [deployments, selectedProject, filter, query]);

  const handleFilterChange = (key) => {
    setFilter(key);
    if (navigate) {
      const sp = new URLSearchParams(searchParams ? searchParams.toString() : "");
      if (key === "All") {
        sp.delete("status");
      } else {
        sp.set("status", key.toLowerCase());
      }
      const qs = sp.toString();
      navigate(qs ? `/deployments?${qs}` : "/deployments");
    }
  };

  const handleCopyId = (e, id) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleRedeploy = async (e, d) => {
    e.stopPropagation();
    if (actioningId === d.id) return;
    try {
      setActioningId(d.id);
      await triggerDeployment({
        project_id: d.project_id,
        branch: d.branch || "main",
        commit_message: `Redeploy: ${d.message || "Manual trigger"}`,
        environment: d.environment || "production",
      });
      setNotice(`Redeployment dispatched for ${d.project || d.projectName}.`);
      setTimeout(() => setNotice(null), 3500);
      loadData(true);
    } catch (err) {
      alert(`Could not redeploy: ${err.message}`);
    } finally {
      setActioningId(null);
    }
  };

  const handleCancel = async (e, d) => {
    e.stopPropagation();
    if (actioningId === d.id) return;
    try {
      setActioningId(d.id);
      await cancelDeployment(d.id);
      setNotice(`Deployment #${d.num || d.id.slice(0, 7)} has been cancelled.`);
      setTimeout(() => setNotice(null), 3500);
      loadData(true);
    } catch (err) {
      alert(`Could not cancel deployment: ${err.message}`);
    } finally {
      setActioningId(null);
    }
  };

  const handleStop = async (e, d) => {
    e.stopPropagation();
    if (actioningId === d.id) return;
    if (!window.confirm(`Are you sure you want to shut down deployment #${d.num || d.id.slice(0, 7)}? The container will be stopped and removed.`)) {
      return;
    }
    try {
      setActioningId(d.id);
      await stopDeployment(d.id);
      setNotice(`Deployment #${d.num || d.id.slice(0, 7)} has been shut down.`);
      setTimeout(() => setNotice(null), 3500);
      loadData(true);
    } catch (err) {
      alert(`Could not shut down deployment: ${err.message}`);
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="deployments-page reveal">
      {/* Page Header */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Deployments</h1>
          <p className="figma-page-subtitle">
            Every build and release across your projects, with duration and serving state.
          </p>
        </div>
      </div>

      {/* Action Notice Toast */}
      {notice && (
        <div className="auth-message-block success" style={{ marginBottom: "1.25rem" }}>
          <CheckIcon size={14} />
          <span>{notice}</span>
        </div>
      )}

      {/* Control Toolbar */}
      <div className="deployments-toolbar">
        {/* Project Dropdown */}
        <div className="project-select-wrapper">
          <select
            className="figma-select"
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            aria-label="Filter by project"
          >
            {projectsList.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {/* Status Filter Chips */}
        <div className="filter-chips-list" role="tablist">
          {["All", "Succeeded", "Building", "Queued", "Failed", "Stopped"].map((key) => {
            const isSelected = filter === key;
            return (
              <button
                key={key}
                type="button"
                className={`filter-chip ${isSelected ? "selected" : ""}`}
                onClick={() => handleFilterChange(key)}
                role="tab"
                aria-selected={isSelected}
              >
                {isSelected && <CheckIcon size={11} className="chip-check-svg" />}
                <span>{key}</span>
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="search-control-wrap search-w-260">
          <SearchIcon size={14} className="search-icon" />
          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commits, IDs..."
            aria-label="Search deployments"
          />
          {query && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setQuery("")}
              aria-label="Clear deployment search query"
            >
              <CloseIcon size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: "1.5rem", display: "flex", alignItems: "center", gap: "1rem" }}>
          <FormMessage message={`Failed to load deployments: ${error}`} type="error" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => loadData(false)}
          >
            Retry
          </button>
        </div>
      )}

      {/* Deployments Table Container */}
      <div className="table-responsive-wrapper df-table-scroll">
        <div className="deployments-table-card">
          <div className="table-header-row">
          <div className="th-cell th-id">Deployment</div>
          <div className="th-cell th-msg">Commit & Project</div>
          <div className="th-cell th-status">Status</div>
          <div className="th-cell th-duration">Duration</div>
          <div className="th-cell th-time">Age</div>
          <div className="th-cell th-serving">Serving</div>
          <div className="th-cell th-action">Action</div>
        </div>

        <div className="table-body">
          {loading ? (
            <div className="table-empty-row">
              <SpinnerIcon size={20} className="spin" />
              <p style={{ marginTop: "0.5rem" }}>Loading deployments pipeline...</p>
            </div>
          ) : filteredDeployments.length > 0 ? (
            filteredDeployments.map((d) => {
              const displayId = d.display_id || `#${d.num || 1}`;
              const timeDisplay = timeAgo(d.created_at);
              const rawStatus = (d.status || d.state || "Queued").toLowerCase();
              const isActive = ["initiated", "queued", "cloning", "building", "starting", "deploying"].includes(rawStatus);
              const isRunning = ["running", "succeeded", "live"].includes(rawStatus);
              const isActioning = actioningId === d.id;

              return (
                <div
                  key={d.id}
                  className="table-row-item"
                  onClick={() => navigate(`/deployments/detail?id=${d.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) =>
                    (e.key === "Enter" || e.key === " ") && navigate(`/deployments/detail?id=${d.id}`)
                  }
                >
                  <div className="cell-item cell-id">
                    <button
                      type="button"
                      className="dep-id-pill"
                      onClick={(e) => handleCopyId(e, displayId)}
                      title="Click to copy ID"
                      aria-label={copiedId === displayId ? `Copied deployment ID ${displayId}` : `Copy deployment ID ${displayId}`}
                    >
                      <code className="truncate-mono">{displayId}</code>
                      {copiedId === displayId ? (
                        <span className="copied-tag">Copied</span>
                      ) : (
                        <CopyIcon size={11} className="copy-icon-hover" aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  <div className="cell-item cell-msg">
                    <strong className="dep-commit-msg truncate-mono">{d.message}</strong>
                    <div className="dep-meta-row">
                      <span className="dep-project-tag">{d.project || d.projectName}</span>
                      <span className="dot-sep">·</span>
                      <span className="dep-branch-tag">
                        <GitBranchIcon size={11} className="branch-svg" aria-hidden="true" />
                        <span>{d.branch}</span>
                      </span>
                      <span className="dot-sep">·</span>
                      <span className="dep-commit-sha">
                        <CommitIcon size={10} className="commit-svg" aria-hidden="true" />
                        <code className="truncate-mono">{d.commit}</code>
                      </span>
                    </div>
                  </div>

                  <div className="cell-item cell-status">
                    <StatusBadge value={d.status || d.state} size="sm" />
                  </div>

                  <div className="cell-item cell-duration">
                    <span className="duration-text">{d.duration || "—"}</span>
                  </div>

                  <div className="cell-item cell-time">
                    <span className="time-text">
                      <ClockIcon size={11} className="clock-svg" aria-hidden="true" />
                      <span>{timeDisplay}</span>
                    </span>
                  </div>

                  <div className="cell-item cell-serving">
                    {d.serving ? (
                      <span className="serving-pill active">
                        <span className="live-dot" />
                        <span>Live</span>
                      </span>
                    ) : (
                      <span className="serving-pill inactive">—</span>
                    )}
                  </div>

                  <div className="cell-item cell-action" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    {isActive ? (
                      <button
                        type="button"
                        className="btn-card-redeploy"
                        onClick={(e) => handleCancel(e, d)}
                        disabled={isActioning}
                        title="Cancel ongoing deployment"
                        aria-label={`Cancel deployment ${displayId}`}
                      >
                        {isActioning ? <SpinnerIcon size={11} className="spin" aria-hidden="true" /> : <PauseIcon size={11} aria-hidden="true" />}
                        <span>Cancel</span>
                      </button>
                    ) : isRunning ? (
                      <button
                        type="button"
                        className="btn-card-redeploy"
                        onClick={(e) => handleStop(e, d)}
                        disabled={isActioning}
                        title="Stop container and shut down live deployment"
                        aria-label={`Shut down deployment ${displayId}`}
                      >
                        {isActioning ? <SpinnerIcon size={11} className="spin" aria-hidden="true" /> : <PauseIcon size={11} aria-hidden="true" />}
                        <span>Shut Down</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-card-redeploy"
                        onClick={(e) => handleRedeploy(e, d)}
                        disabled={isActioning}
                        title="Redeploy this release"
                        aria-label={`Redeploy release ${displayId}`}
                      >
                        {isActioning ? <SpinnerIcon size={11} className="spin" aria-hidden="true" /> : <PlayIcon size={11} aria-hidden="true" />}
                        <span>Redeploy</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="view-detail-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/deployments/detail?id=${d.id}`);
                      }}
                      aria-label={`View deployment ${displayId}`}
                    >
                      <span>Details</span>
                      <ArrowRightIcon size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="table-empty-row">
              <p>
                {query || filter !== "All" || selectedProject !== "All projects"
                  ? "No deployments match your criteria."
                  : "No deployments recorded yet in this workspace."}
              </p>
              {query || filter !== "All" || selectedProject !== "All projects" ? (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setSelectedProject("All projects");
                    setFilter("All");
                    setQuery("");
                  }}
                >
                  Reset filters
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => navigate("/projects/new")}
                >
                  Create & deploy a project
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);
}
