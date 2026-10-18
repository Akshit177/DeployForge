import { useState, useMemo, useEffect, useRef, memo } from "react";
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
  CopyIcon,
} from "../components/common/TechIcons.jsx";

const MAX_LOG_BUFFER = 1000;

const LogRowItem = memo(function LogRowItem({ log, searchQuery }) {
  const level = (log.level || "INFO").toLowerCase();
  return (
    <div className={`console-log-row term-log-row log-${level} log-lvl-${level}`}>
      <time className="log-col-time log-timestamp">{log.time}</time>
      <span className={`log-col-badge log-level-badge lvl-${level}`}>[{(log.level || "INFO").toUpperCase()}]</span>
      <span className="log-col-msg log-text-content">
        {highlightMatch(log.text || log.message, searchQuery)}
      </span>
    </div>
  );
});

function highlightMatch(text, query) {
  if (!query || !query.trim() || !text) return text;
  const q = query.trim();
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = String(text).split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark
        key={i}
        className="search-highlight"
        style={{
          backgroundColor: "rgba(234, 179, 8, 0.35)",
          color: "#fef08a",
          borderRadius: "2px",
          padding: "0 2px",
        }}
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export default function LogsPage({ navigate, searchParams }) {
  const [projects, setProjects] = useState([]);
  const initialProjectId = searchParams?.get("project_id") || searchParams?.get("projectId") || "";
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [isLive, setIsLive] = useState(true);
  const [filterLevel, setFilterLevel] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streamConnected, setStreamConnected] = useState(false);
  const scrollContainerRef = useRef(null);
  const isAutoScrollPausedRef = useRef(false);

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

  // 2. Fetch historical logs and connect live SSE stream with AbortController cleanup
  useEffect(() => {
    const abortCtrl = new AbortController();
    let cleanupStream = null;
    setLoading(true);
    setStreamConnected(false);

    const loadHistorical = async () => {
      try {
        const historical = await fetchLogs(
          {
            project_id: selectedProjectId || undefined,
            limit: 150,
          },
          { signal: abortCtrl.signal }
        );
        if (!abortCtrl.signal.aborted) {
          setLogs(historical.slice(-MAX_LOG_BUFFER));
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          console.warn("Could not fetch historical logs:", err.message);
        }
      } finally {
        if (!abortCtrl.signal.aborted) {
          setLoading(false);
        }
      }
    };

    loadHistorical();

    // The stream endpoint requires a project or deployment id; without one it answers 400 and
    // EventSource never reconnects, so only open it once a project has been selected.
    if (isLive && selectedProjectId) {
      cleanupStream = connectLogStream(
        { project_id: selectedProjectId },
        {
          onInit: (initialBatch) => {
            if (abortCtrl.signal.aborted) return;
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
            if (abortCtrl.signal.aborted) return;
            setStreamConnected(true);
            setLogs((prev) => {
              if (prev.some((l) => l.id === newEntry.id)) return prev;
              return [...prev, newEntry].slice(-MAX_LOG_BUFFER);
            });
          },
          onError: () => {
            if (!abortCtrl.signal.aborted) {
              setStreamConnected(false);
            }
          },
        }
      );
    }

    return () => {
      abortCtrl.abort();
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
    if (!isAtBottom) {
      isAutoScrollPausedRef.current = true;
      if (autoScroll) setAutoScroll(false);
    } else {
      isAutoScrollPausedRef.current = false;
      if (!autoScroll) setAutoScroll(true);
    }
  };

  // Auto-scroll follow
  useEffect(() => {
    if (autoScroll && !isAutoScrollPausedRef.current && scrollContainerRef.current) {
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

  const handleCopy = () => {
    const content = filteredLogs.map((l) => `${l.time} [${(l.level || "INFO").toUpperCase()}] ${l.text || l.message}`).join("\n");
    navigator.clipboard?.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              aria-label={isLive ? "Pause live log streaming" : "Resume live log streaming"}
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
                  aria-label={`Filter by ${lvl} level logs`}
                >
                  {isSelected && <CheckIcon size={11} className="chip-check-svg" />}
                  <span>{lvl}</span>
                </button>
              );
            })}
          </div>

          <div className="search-control-wrap search-w-260">
            <SearchIcon size={14} className="search-icon" aria-hidden="true" />
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
                aria-label="Clear search query"
              >
                <CloseIcon size={12} aria-hidden="true" />
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
                aria-label="Toggle terminal auto-scroll"
                onChange={(e) => {
                  const checked = e.target.checked;
                  setAutoScroll(checked);
                  isAutoScrollPausedRef.current = !checked;
                  if (checked && scrollContainerRef.current) {
                    scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
                  }
                }}
              />
              <span>Auto-scroll</span>
            </label>

            <button
              type="button"
              className="term-action-btn"
              onClick={handleCopy}
              title="Copy filtered logs to clipboard"
              aria-label="Copy filtered logs to clipboard"
            >
              <CopyIcon size={12} aria-hidden="true" />
              <span>{copied ? "Copied!" : "Copy"}</span>
            </button>

            <button
              type="button"
              className="term-action-btn"
              onClick={handleClear}
              title="Clear visible logs"
              aria-label="Clear visible terminal logs"
            >
              Clear
            </button>

            <button
              type="button"
              className="term-action-btn"
              onClick={handleDownload}
              title="Download filtered logs"
              aria-label="Download filtered logs as text file"
            >
              <DownloadIcon size={12} aria-hidden="true" />
              <span>Download</span>
            </button>
          </div>
        </div>

        {/* Log Lines Stream Body */}
        <div
          className="console-output-scroll term-scroll-viewport"
          ref={scrollContainerRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label="Real-time build and runtime logs"
          style={{ position: "relative" }}
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
            filteredLogs.map((log) => (
              <LogRowItem key={log.id} log={log} searchQuery={searchQuery} />
            ))
          ) : (
            <div className="term-empty-row">
              <p>No log records match your current filter criteria.</p>
            </div>
          )}

          {!autoScroll && (
            <button
              type="button"
              className="term-jump-bottom-btn"
              onClick={() => {
                setAutoScroll(true);
                isAutoScrollPausedRef.current = false;
                if (scrollContainerRef.current) {
                  scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
                }
              }}
              aria-label="Jump to bottom of logs"
            >
              Jump to bottom ↓
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
