import { useState, useMemo, useEffect, useRef } from "react";
import {
  SearchIcon,
  CloseIcon,
  CheckIcon,
  PlayIcon,
  PauseIcon,
  DownloadIcon,
  TerminalIcon,
} from "../components/common/TechIcons.jsx";

const initialLogs = [
  { id: "1", time: "18:45:01.204", level: "INFO", text: "Server listening on port 3000" },
  { id: "2", time: "18:45:01.231", level: "INFO", text: "Connected to PostgreSQL (pool size 10)" },
  { id: "3", time: "18:45:02.018", level: "INFO", text: "GET /health 200 2ms" },
  { id: "4", time: "18:45:07.442", level: "INFO", text: "POST /api/auth/login 200 84ms" },
  { id: "5", time: "18:45:07.610", level: "INFO", text: "GET /api/projects 200 21ms" },
  { id: "6", time: "18:45:12.903", level: "WARN", text: "Slow query (412ms): SELECT * FROM deployments" },
  { id: "7", time: "18:45:13.115", level: "INFO", text: "GET /api/deployments 200 431ms" },
  { id: "8", time: "18:45:18.777", level: "INFO", text: "GET /health 200 1ms" },
  { id: "9", time: "18:45:24.350", level: "ERROR", text: "Redis connection timeout, retrying (1/5)" },
  { id: "10", time: "18:45:26.352", level: "ERROR", text: "Redis connection timeout, retrying (2/5)" },
  { id: "11", time: "18:45:28.401", level: "INFO", text: "Redis reconnected" },
  { id: "12", time: "18:45:28.455", level: "INFO", text: "Replayed 3 queued events" },
  { id: "13", time: "18:45:31.020", level: "INFO", text: "GET /api/deployments/131 200 63ms" },
  { id: "14", time: "18:45:31.044", level: "INFO", text: "Deployment #131 running · container a91f3c0e2b7d" },
  { id: "15", time: "18:45:35.912", level: "INFO", text: "GET /api/deployments/131 200 18ms" },
  { id: "16", time: "18:45:40.118", level: "WARN", text: "Deprecated header x-powered-by still enabled" },
  { id: "17", time: "18:45:44.560", level: "INFO", text: "GET /health 200 1ms" },
  { id: "18", time: "18:45:49.871", level: "INFO", text: "GET /api/projects/web-app 200 24ms" },
  { id: "19", time: "18:45:55.003", level: "INFO", text: "GET /api/logs/web-app 200 37ms" },
  { id: "20", time: "18:46:01.292", level: "INFO", text: "GET /health 200 2ms" },
  { id: "21", time: "18:46:08.730", level: "INFO", text: "POST /api/auth/refresh 200 12ms" },
  { id: "22", time: "18:46:14.116", level: "WARN", text: "Memory usage at 78% of limit" },
  { id: "23", time: "18:46:19.504", level: "INFO", text: "GET /health 200 1ms" },
  { id: "24", time: "18:46:25.887", level: "INFO", text: "GET /api/deployments 200 29ms" },
];

export default function LogsPage() {
  const [project, setProject] = useState("web-app");
  const [container, setContainer] = useState("web-app-131 (a91f3c0e2b7d)");
  const [isLive, setIsLive] = useState(true);
  const [filterLevel, setFilterLevel] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [logs, setLogs] = useState(initialLogs);
  const scrollContainerRef = useRef(null);

  // Simulated live log append when stream is live
  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
      const sampleEvents = [
        { level: "INFO", text: "GET /health 200 1ms" },
        { level: "INFO", text: "Telemetry heartbeat emitted to Redis" },
        { level: "INFO", text: "GET /api/deployments/131 200 16ms" },
        { level: "WARN", text: "Worker memory cache purge threshold at 72%" },
        { level: "INFO", text: "POST /api/metrics/ingest 204 3ms" },
      ];
      const randomEvent = sampleEvents[Math.floor(Math.random() * sampleEvents.length)];
      setLogs((prev) => [
        ...prev.slice(-120),
        { id: Date.now().toString(), time: timeStr, level: randomEvent.level, text: randomEvent.text },
      ]);
    }, 4500);

    return () => clearInterval(timer);
  }, [isLive]);

  // Auto-scroll follow
  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchesLevel =
        filterLevel === "All" || log.level.toLowerCase() === filterLevel.toLowerCase();
      const matchesSearch =
        log.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.time.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesLevel && matchesSearch;
    });
  }, [logs, filterLevel, searchQuery]);

  const handleDownload = () => {
    const content = filteredLogs.map((l) => `${l.time} [${l.level}] ${l.text}`).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project}-runtime.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="logs-page reveal">
      {/* Page Heading matching Figma */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Logs</h1>
          <p className="figma-page-subtitle">
            Stream stdout and stderr from your running container instances in real time.
          </p>
        </div>
      </div>

      {/* Stream Selectors & Actions Toolbar */}
      <div className="logs-toolbar-wrap">
        <div className="stream-selectors-row">
          <div className="selector-group">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="figma-select select-w-200"
              aria-label="Select Project"
            >
              <option value="web-app">web-app</option>
              <option value="api-gateway">api-gateway</option>
              <option value="portfolio-site">portfolio-site</option>
              <option value="blog-engine">blog-engine</option>
              <option value="docs-portal">docs-portal</option>
              <option value="chat-service">chat-service</option>
            </select>
          </div>

          <div className="selector-group">
            <select
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              className="figma-select select-w-300"
              aria-label="Select Container"
            >
              <option value="web-app-131 (a91f3c0e2b7d)">web-app-131 (a91f3c0e2b7d)</option>
              <option value="web-app-129 (b42c1d8e9a0f)">web-app-129 (b42c1d8e9a0f)</option>
              <option value="web-app-127 (c71a3e5f2b8d)">web-app-127 (c71a3e5f2b8d)</option>
            </select>
          </div>

          <div className="stream-live-actions">
            <div className="live-status-pill">
              <span className={`status-indicator status-dot ${isLive ? "green-pulse" : "gray"}`} />
              <span>{isLive ? "Live" : "Paused"}</span>
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

          <div className="search-control-wrap search-w-300">
            <SearchIcon size={14} className="search-icon" />
            <input
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter logs by keyword or timestamp..."
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

      {/* Log Console Terminal Card matching Figma */}
      <div className="log-console-card">
        {/* Terminal Header */}
        <div className="console-header-bar">
          <div className="console-id-label">
            <TerminalIcon size={14} className="term-svg" />
            <strong>web-app-131</strong>
          </div>
          <div className="console-meta-info">
            <span>stdout + stderr · {filteredLogs.length} lines</span>
          </div>
          <div className="console-scroll-toggle">
            <button
              type="button"
              className={`toggle-autoscroll-btn ${autoScroll ? "on" : ""}`}
              onClick={() => setAutoScroll(!autoScroll)}
            >
              Auto-scroll {autoScroll ? "on" : "off"}
            </button>
          </div>
        </div>

        {/* Console Log Rows */}
        <div
          ref={scrollContainerRef}
          className="console-output-scroll"
          tabIndex={0}
          aria-live="polite"
        >
          {filteredLogs.length > 0 ? (
            filteredLogs.map((log) => {
              const lvl = log.level.toUpperCase();
              return (
                <div key={log.id} className={`console-log-row log-lvl-${lvl.toLowerCase()}`}>
                  <span className="log-col-time">{log.time}</span>
                  <span className={`log-col-badge lvl-${lvl.toLowerCase()}`}>{lvl}</span>
                  <span className="log-col-msg">{log.text}</span>
                </div>
              );
            })
          ) : (
            <div className="console-empty-msg">
              No log events match filter “{filterLevel}” and query “{searchQuery}”.
            </div>
          )}
        </div>

        {/* Terminal Footer */}
        <div className="console-footer-bar">
          <span className="footer-retention-text">
            Showing last 500 lines · retained for 7 days
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleDownload}
          >
            <DownloadIcon size={12} />
            <span>Download .log</span>
          </button>
        </div>
      </div>
    </div>
  );
}
