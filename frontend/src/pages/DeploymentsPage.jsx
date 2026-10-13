import { useState, useMemo } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import {
  SearchIcon,
  CloseIcon,
  CheckIcon,
  GitBranchIcon,
  CommitIcon,
  ClockIcon,
  ArrowRightIcon,
  CopyIcon,
  ExternalLinkIcon,
} from "../components/common/TechIcons.jsx";

const initialDeployments = [
  {
    id: "#131",
    num: "131",
    message: "feat: add health endpoint",
    project: "web-app",
    status: "Succeeded",
    branch: "main",
    commit: "3f9a2c1",
    duration: "53s",
    time: "Just now",
    serving: true,
  },
  {
    id: "#130",
    num: "130",
    message: "fix: cors preflight handling",
    project: "api-gateway",
    status: "Succeeded",
    branch: "main",
    commit: "b81d04e",
    duration: "1m 12s",
    time: "2h ago",
    serving: true,
  },
  {
    id: "#129",
    num: "129",
    message: "chore: bump express to 4.19",
    project: "web-app",
    status: "Succeeded",
    branch: "main",
    commit: "7de20ab",
    duration: "54s",
    time: "5h ago",
    serving: false,
  },
  {
    id: "#128",
    num: "128",
    message: "feat: markdown rendering",
    project: "blog-engine",
    status: "Failed",
    branch: "develop",
    commit: "e47f190",
    duration: "2m 03s",
    time: "3h ago",
    serving: false,
  },
  {
    id: "#127",
    num: "127",
    message: "docs: update install guide",
    project: "docs-portal",
    status: "Succeeded",
    branch: "main",
    commit: "12ab9f3",
    duration: "47s",
    time: "1d ago",
    serving: true,
  },
  {
    id: "#126",
    num: "126",
    message: "feat: websocket reconnect",
    project: "chat-service",
    status: "Queued",
    branch: "main",
    commit: "a03bc55",
    duration: "—",
    time: "1d ago",
    serving: false,
  },
  {
    id: "#125",
    num: "125",
    message: "refactor: split routes",
    project: "api-gateway",
    status: "Stopped",
    branch: "main",
    commit: "90fe3c2",
    duration: "1m 05s",
    time: "2d ago",
    serving: false,
  },
  {
    id: "#124",
    num: "124",
    message: "initial commit",
    project: "portfolio-site",
    status: "Succeeded",
    branch: "main",
    commit: "c51d2e8",
    duration: "31s",
    time: "4d ago",
    serving: false,
  },
];

export default function DeploymentsPage({ navigate }) {
  const [selectedProject, setSelectedProject] = useState("All projects");
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState(null);

  const projectsList = ["All projects", "web-app", "api-gateway", "blog-engine", "docs-portal", "chat-service", "portfolio-site"];

  const filteredDeployments = useMemo(() => {
    return initialDeployments.filter((d) => {
      const matchProject = selectedProject === "All projects" || d.project === selectedProject;
      const matchFilter =
        filter === "All" ||
        d.status.toLowerCase() === filter.toLowerCase();
      const matchQuery =
        d.message.toLowerCase().includes(query.toLowerCase()) ||
        d.commit.toLowerCase().includes(query.toLowerCase()) ||
        d.id.toLowerCase().includes(query.toLowerCase()) ||
        d.project.toLowerCase().includes(query.toLowerCase());

      return matchProject && matchFilter && matchQuery;
    });
  }, [selectedProject, filter, query]);

  const handleCopyId = (e, id) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
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
          {["All", "Succeeded", "Failed", "Queued", "Stopped"].map((key) => {
            const isSelected = filter === key;
            return (
              <button
                key={key}
                type="button"
                className={`filter-chip ${isSelected ? "selected" : ""}`}
                onClick={() => setFilter(key)}
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
              aria-label="Clear search"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Deployments Table Container */}
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
          {filteredDeployments.length > 0 ? (
            filteredDeployments.map((d) => (
              <div
                key={d.id}
                className="table-row-item"
                onClick={() => navigate("/deployments/detail")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && navigate("/deployments/detail")}
              >
                <div className="cell-item cell-id">
                  <span
                    className="dep-id-pill"
                    onClick={(e) => handleCopyId(e, d.id)}
                    title="Click to copy ID"
                  >
                    <code>{d.id}</code>
                    {copiedId === d.id ? (
                      <span className="copied-tag">Copied</span>
                    ) : (
                      <CopyIcon size={11} className="copy-icon-hover" />
                    )}
                  </span>
                </div>

                <div className="cell-item cell-msg">
                  <strong className="dep-commit-msg">{d.message}</strong>
                  <div className="dep-meta-row">
                    <span className="dep-project-tag">{d.project}</span>
                    <span className="dot-sep">·</span>
                    <span className="dep-branch-tag">
                      <GitBranchIcon size={11} className="branch-svg" />
                      <span>{d.branch}</span>
                    </span>
                    <span className="dot-sep">·</span>
                    <span className="dep-commit-sha">
                      <CommitIcon size={10} className="commit-svg" />
                      <code>{d.commit}</code>
                    </span>
                  </div>
                </div>

                <div className="cell-item cell-status">
                  <StatusBadge value={d.status} size="sm" />
                </div>

                <div className="cell-item cell-duration">
                  <span className="duration-text">{d.duration}</span>
                </div>

                <div className="cell-item cell-time">
                  <span className="time-text">
                    <ClockIcon size={11} className="clock-svg" />
                    <span>{d.time}</span>
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

                <div className="cell-item cell-action">
                  <button
                    type="button"
                    className="view-detail-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate("/deployments/detail");
                    }}
                    aria-label={`View deployment ${d.id}`}
                  >
                    <span>Details</span>
                    <ArrowRightIcon size={12} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="table-empty-row">
              <p>No deployments match your criteria.</p>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
