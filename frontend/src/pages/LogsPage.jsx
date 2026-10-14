import { useState, useMemo, useEffect, useRef } from "react";
import { fetchProjects } from "../services/projectService.js";
import { fetchLogs, connectLogStream } from "../services/logService.js";
import {
  SearchIcon,
  CloseIcon,
  CheckIcon,
  PlayIcon,
  PauseIcon,
  DownloadIcon,
  TerminalIcon,
  SpinnerIcon,
  PlusIcon,
} from "../components/common/TechIcons.jsx";

const MAX_LOG_BUFFER = 400;

export default function LogsPage({ navigate }) {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [isLive, setIsLive] = useState(true);
  const [filterLevel, setFilterLevel] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streamConnected, setStreamConnected] = useState(false);
  const scrollContainerRef = useRef(null);

  // 1. Fetch user projects to populate project selector
  useEffect(() => {
    fetchProjects()
      .then((data) => {
        setProjects(data);
        if (data.length > 0 && !selectedProjectId) {
          setSelectedProjectId(data[0].id);
        }
      })
      .catch((err) => console.warn("Failed to load projects for logs:", err));
  }, []);

  // 2. Fetch historical logs and connect live SSE stream
  useEffect(() => {
    let cleanupStream = null;
    setLoading(true);
    setStreamConnected(false);

    const loadHistorical = async () => {
      try {
        const historical = await fetchLogs({
          project_id: selectedProjectId || undefined,
          limit: 150,
        });
        setLogs(historical.slice(-MAX_LOG_BUFFER));
      } catch (err) {
        console.warn("Could not fetch historical logs:", err.message);
      } finally {
        setLoading(false);
      }
    };

    loadHistorical();

    if (isLive) {
      cleanupStream = connectLogStream(
        { project_id: selectedProjectId || undefined },
        {
          onInit: (initialBatch) => {
            setStreamConnected(true);
            if (Array.isArray(initialBatch) && initialBatch.length > 0) {
              setLogs((prev) => {
                const existingIds = new Set(prev.map((l) => l.id));
                const newLines = initialBatch.filter((l) => !existingIds.has(l.id));
                return [...prev, ...newLines].slice(-MAX_LOG_BUFFER);
              });
            }
          },
          onLog: (newEntry) => {
            setStreamConnected(true);
            setLogs((prev) => {
              if (prev.some((l) => l.id === newEntry.id)) return prev;
              return [...prev, newEntry].slice(-MAX_LOG_BUFFER);
            });
          },
          onError: () => {
            setStreamConnected(false);
          },
        }
      );
    }

    return () => {
      if (cleanupStream) {
        cleanupStream();
      }
    };
  }, [selectedProjectId, isLive]);

  // Handle user manual scroll up vs bottom
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    } else if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
    }
  };

  // Auto-scroll follow
  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const lvl = (log.level || "INFO").toUpperCase();
      const matchesLevel =
        filterLevel === "All" || lvl === filterLevel.toUpperCase();
      const text = log.text || log.message || "";
      const time = log.time || "";
      const cleanSearch = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !cleanSearch ||
        text.toLowerCase().includes(cleanSearch) ||
        time.toLowerCase().includes(cleanSearch);
      return matchesLevel && matchesSearch;
    });
  }, [logs, filterLevel, searchQuery]);

  const handleDownload = () => {
    const activeProject = projects.find((p) => p.id === selectedProjectId);
    const projName = activeProject ? activeProject.name : "deployforge";
    const content = filteredLogs.map((l) => `${l.time} [${(l.level || "INFO").toUpperCase()}] ${l.text || l.message}`).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projName}-observability.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    setLogs([]);
  };

  const activeProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="logs-page reveal">
      {/* Page Heading matching Figma */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Logs</h1>
          <p className="figma-page-subtitle">
            Real-time stdout and stderr streams from your container instances and deployment workers.
          </p>
        </div>
      </div>

      {/* Stream Selectors & Actions Toolbar */}
      <div className="logs-toolbar-wrap">
        <div className="stream-selectors-row">
          <div className="selector-group">
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="figma-select select-w-200"
              aria-label="Select Project"
            >
              <option value="">All workspace projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="stream-live-actions">
            <div className="live-status-pill">
              <span className={`status-indicator status-dot ${isLive && streamConnected ? "green-pulse" : isLive ? "amber" : "gray"}`} />
              <span>{isLive ? `Live SSE Stream (${logs.length} entries)` : "Stream Paused"}</span>
            </div>

            <button
              type="button"
              className={`btn-secondary btn-sm ${!isLive ? "btn-resume" : ""}`}
              onClick={() => setIsLive(!isLive)}
            >
              {isLive ? (
                <>
                  <PauseIcon size={12} />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <PlayIcon size={12} />
                  <span>Resume</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Filter Chips & Search Bar */}
        <div className="log-filters-row">
          <div className="filter-chips-list" role="tablist">
            {["All", "Info", "Warn", "Error"].map((lvl) => {
              const isSelected = filterLevel === lvl;
              return (
                <button
                  key={lvl}
                  type="button"
                  className={`filter-chip ${isSelected ? "selected" : ""}`}
                  onClick={() => setFilterLevel(lvl)}
                  role="tab"
                  aria-selected={isSelected}
                >
                  {isSelected && <CheckIcon size={11} className="chip-check-svg" />}
                  <span>{lvl}</span>
                </button>
              );
            })}
          </div>

          <div className="search-control-wrap search-w-260">
            <SearchIcon size={14} className="search-icon" />
            <input
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              maxLength={80}
              placeholder="Search log output (max 80 chars)..."
              aria-label="Search logs"
            />
            {searchQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Terminal Display Card */}
      <div className="logs-terminal-card" role="region" aria-label="Application log output">
        {/* Terminal Header Bar */}
        <div className="term-card-header">
          <div className="term-dots-cluster" aria-hidden="true">
            <span className="window-dot dot-red" />
            <span className="window-dot dot-yellow" />
            <span className="window-dot dot-green" />
            <span className="term-window-title">
              <TerminalIcon size={12} className="inline-term-svg" />
              <span>{activeProject ? `${activeProject.name} — stdout/stderr stream` : "workspace live log stream"}</span>
            </span>
          </div>

          <div className="term-actions-cluster">
            <label className="autoscroll-toggle-label">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>Auto-scroll</span>
            </label>

            <button
              type="button"
              className="term-action-btn"
              onClick={handleClear}
              title="Clear visible logs"
            >
              Clear
            </button>

            <button
              type="button"
              className="term-action-btn"
              onClick={handleDownload}
              title="Download filtered logs"
            >
              <DownloadIcon size={12} />
              <span>Download</span>
            </button>
          </div>
        </div>

        {/* Log Lines Stream Body */}
        <div
          className="term-scroll-viewport"
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          {loading ? (
            <div className="term-loading-row">
              <SpinnerIcon size={18} className="spin" />
              <span>Connecting to log stream socket...</span>
            </div>
          ) : projects.length === 0 ? (
            <div className="term-empty-row" style={{ padding: "40px 20px" }}>
              <p style={{ marginBottom: "12px", color: "var(--text-secondary)" }}>
                No applications registered in this workspace yet. Create and deploy a project to begin streaming runtime logs.
              </p>
              {navigate && (
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={() => navigate("/projects/new")}
                >
                  <PlusIcon size={12} />
                  <span>Import your first project</span>
                </button>
              )}
            </div>
          ) : filteredLogs.length > 0 ? (
            filteredLogs.map((log) => {
              const level = (log.level || "INFO").toLowerCase();
              return (
                <div key={log.id} className={`term-log-row log-${level}`}>
                  <time className="log-timestamp">{log.time}</time>
                  <span className={`log-level-badge lvl-${level}`}>[{(log.level || "INFO").toUpperCase()}]</span>
                  <span className="log-text-content">{log.text || log.message}</span>
                </div>
              );
            })
          ) : (
            <div className="term-empty-row">
              <p>No log records match your current filter criteria.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
