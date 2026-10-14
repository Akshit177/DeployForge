import { useState, useEffect, useRef, useMemo } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import { fetchDeployments, getDeployment, cancelDeployment } from "../services/deploymentService.js";
import { fetchLogs, connectLogStream } from "../services/logService.js";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  CheckIcon,
  TerminalIcon,
  CopyIcon,
  DownloadIcon,
  GitHubIcon,
  GitBranchIcon,
  CommitIcon,
  NodeIcon,
  PythonIcon,
  GoIcon,
  HtmlIcon,
  DockerIcon,
  SpinnerIcon,
  ContainerIcon,
  SearchIcon,
  CloseIcon,
} from "../components/common/TechIcons.jsx";

const STAGE_ORDER = ["initiated", "queued", "cloning", "building", "starting", "running"];

const STAGE_CONFIGS = [
  { id: "initiated", title: "Initiated", desc: "Outbox recorded", duration: "0.1s" },
  { id: "queued", title: "Queued", desc: "Redis stream PEL", duration: "0.3s" },
  { id: "cloning", title: "Cloning", desc: "Isolated workspace", duration: "2.8s" },
  { id: "building", title: "Building", desc: "Container image build", duration: "18.4s" },
  { id: "starting", title: "Starting", desc: "Health check probe", duration: "3.2s" },
  { id: "running", title: "Running", desc: "Nginx proxy route live", duration: "Active" },
];

export default function DeploymentDetailPage({ navigate, searchParams }) {
  const [deployment, setDeployment] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copiedContainerId, setCopiedContainerId] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Terminal log controls
  const [logFilterQuery, setLogFilterQuery] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState("ALL");
  const [autoScroll, setAutoScroll] = useState(true);

  const logsEndRef = useRef(null);
  const pollTimerRef = useRef(null);

  const targetId = searchParams?.get("id") || new URLSearchParams(window.location.search).get("id");
  const targetProjectId = searchParams?.get("project_id") || new URLSearchParams(window.location.search).get("project_id");

  const loadDeploymentData = async (isBackground = false) => {
    try {
      if (!isBackground) setLoading(true);
      setError(null);
      if (targetId) {
        const data = await getDeployment(targetId);
        setDeployment(data);
      } else if (targetProjectId) {
        const list = await fetchDeployments({ project_id: targetProjectId, limit: 1 });
        if (list.length > 0) {
          setDeployment(list[0]);
        }
      } else {
        const list = await fetchDeployments({ limit: 1 });
        if (list.length > 0) {
          setDeployment(list[0]);
        }
      }
    } catch (err) {
      console.warn("Could not load deployment detail:", err.message);
      if (!isBackground) setError(err.message);
    } finally {
      if (!isBackground) setLoading(false);
    }
  };

  useEffect(() => {
    loadDeploymentData();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [targetId, targetProjectId]);

  // Real-time polling while status is active
  useEffect(() => {
    if (!deployment) return;
    const s = (deployment.status || deployment.state || "").toLowerCase().trim();
    const isActive = ["initiated", "queued", "cloning", "building", "starting", "deploying"].includes(s);

    if (isActive) {
      if (!pollTimerRef.current) {
        pollTimerRef.current = setInterval(() => {
          loadDeploymentData(true);
        }, 2500);
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
  }, [deployment]);

  // Fetch and stream logs
  useEffect(() => {
    if (!deployment?.id) return;

    fetchLogs({ deployment_id: deployment.id })
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setLogs(data);
        }
      })
      .catch(() => {});

    const cleanup = connectLogStream(
      { deployment_id: deployment.id },
      {
        onLog: (newEntry) => {
          setLogs((prev) => [...prev, newEntry]);
        },
      }
    );

    return () => cleanup();
  }, [deployment?.id]);

  // Auto-scroll logs
  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const handleCancel = async () => {
    if (!deployment) return;
    try {
      setCancelling(true);
      const updated = await cancelDeployment(deployment.id);
      setDeployment(updated);
    } catch (err) {
      alert(`Could not cancel deployment: ${err.message}`);
    } finally {
      setCancelling(false);
    }
  };

  const status = (deployment?.status || deployment?.state || "Running").toLowerCase();
  const isRunning = status === "running" || status === "succeeded" || status === "live";
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled" || status === "stopped";

  // Compute status of all 6 granular lifecycle stages
  const pipelineStages = useMemo(() => {
    let currentIdx = STAGE_ORDER.indexOf(status);
    if (currentIdx === -1) {
      if (isRunning) currentIdx = 5;
      else if (isFailed) currentIdx = 3; // default failed at build
      else currentIdx = 0;
    }

    return STAGE_CONFIGS.map((stage, idx) => {
      let stageState = "pending";
      if (isRunning) {
        stageState = "completed";
      } else if (isFailed) {
        if (idx < currentIdx) stageState = "completed";
        else if (idx === currentIdx) stageState = "failed";
        else stageState = "pending";
      } else if (isCancelled) {
        if (idx < currentIdx) stageState = "completed";
        else if (idx === currentIdx) stageState = "failed";
        else stageState = "pending";
      } else {
        if (idx < currentIdx) stageState = "completed";
        else if (idx === currentIdx) stageState = "active";
        else stageState = "pending";
      }

      return {
        ...stage,
        state: stageState,
      };
    });
  }, [status, isRunning, isFailed, isCancelled]);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      const level = (l.level || "INFO").toUpperCase();
      if (logLevelFilter !== "ALL" && level !== logLevelFilter) return false;
      if (logFilterQuery.trim()) {
        const text = (l.text || l.message || "").toLowerCase();
        return text.includes(logFilterQuery.toLowerCase());
      }
      return true;
    });
  }, [logs, logLevelFilter, logFilterQuery]);

  const handleCopyLogs = () => {
    const text = filteredLogs.map((l) => `[${l.time}] ${l.text || l.message}`).join("\n");
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadLogs = () => {
    const text = logs.map((l) => `[${l.time}] ${l.text || l.message}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${deployment?.projectName || "deployment"}-${deployment?.display_id || "log"}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyContainerId = (cid) => {
    if (!cid) return;
    navigator.clipboard?.writeText(cid);
    setCopiedContainerId(true);
    setTimeout(() => setCopiedContainerId(false), 1800);
  };

  const renderRuntimeIcon = (type) => {
    switch (type) {
      case "node":
        return <NodeIcon size={13} className="inline-icon" />;
      case "python":
        return <PythonIcon size={13} className="inline-icon" />;
      case "go":
        return <GoIcon size={13} className="inline-icon" />;
      case "static":
        return <HtmlIcon size={13} className="inline-icon" />;
      default:
        return <DockerIcon size={13} className="inline-icon" />;
    }
  };

  const displayNum = deployment?.display_id || (deployment?.num ? `#${deployment.num}` : "#1");
  const projectName = deployment?.projectName || deployment?.project || "web-app";
  const projectDomain = deployment?.url || `${projectName}.deployforge.app`;
  const domainHref = projectDomain.startsWith("http") ? projectDomain : `https://${projectDomain}`;
  const branchName = deployment?.branch || "main";
  const commitSha = deployment?.commit || deployment?.commit_hash?.slice(0, 7) || "HEAD";
  const containerId = deployment?.container_id || (isRunning ? `df-${deployment?.id?.slice(0, 12)}` : null);
  const containerPort = deployment?.port || (deployment?.runtime === "static" ? 80 : 3000);

  return (
    <div className="deployment-detail-page reveal">
      {/* Header with Breadcrumb and Actions */}
      <div className="detail-header-block">
        <div className="figma-crumb-trail">
          <button
            type="button"
            className="back-crumb-btn"
            onClick={() => navigate("/deployments")}
          >
            <ArrowLeftIcon size={12} />
            <span>Deployments</span>
          </button>
          <span className="crumb-sep">/</span>
          <strong className="crumb-active">{displayNum}</strong>
        </div>

        <div className="detail-title-action-row">
          <div className="title-and-meta">
            <h1 className="detail-project-title">{projectName}</h1>
            <p className="detail-meta-text">
              Deployment {displayNum} · {status.toUpperCase()} · triggered by {deployment?.trigger || "manual outbox"} · duration {deployment?.duration || "—"}
            </p>
          </div>

          <div className="detail-actions-cluster">
            <StatusBadge value={deployment?.status || deployment?.state} size="md" />

            {(status === "queued" || status === "initiated" || status === "cloning" || status === "building" || status === "starting") && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={handleCancel}
                disabled={cancelling}
              >
                {cancelling ? <SpinnerIcon size={12} className="spin" /> : null}
                <span>Cancel Build</span>
              </button>
            )}

            <a
              href={domainHref}
              target="_blank"
              rel="noreferrer"
              className="btn-primary visit-btn"
              title="Open live deployment in new tab"
            >
              <span>Visit</span>
              <ExternalLinkIcon size={13} />
            </a>
          </div>
        </div>
      </div>

      {error && (
        <div className="auth-message-block error" style={{ marginBottom: "1.5rem" }}>
          <span>Failed to load deployment: {error}</span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => loadDeploymentData(false)}
            style={{ marginLeft: "1rem" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* 6-Stage Granular Lifecycle Stepper Visualizer */}
      <section className="detail-pipeline-card" aria-label="Deployment pipeline stages">
        <div className="pipeline-stages-row">
          {pipelineStages.map((st, i) => {
            const isCompleted = st.state === "completed";
            const isActive = st.state === "active";
            const isStageFailed = st.state === "failed";

            return (
              <div key={st.id} className="pipeline-stage-item">
                <div className={`stage-marker-box ${isCompleted ? "completed" : isActive ? "active" : isStageFailed ? "failed" : "pending"}`}>
                  {isCompleted ? (
                    <CheckIcon size={13} className="stage-check-svg" />
                  ) : isActive ? (
                    <span className="stage-active-pulse" />
                  ) : isStageFailed ? (
                    <span style={{ color: "#ef4444", fontSize: "11px", fontWeight: "bold" }}>✕</span>
                  ) : (
                    <span className="stage-pending-dot" />
                  )}
                </div>
                <div className="stage-info-box">
                  <strong className="stage-name">{st.title}</strong>
                  <small className="stage-duration">{st.desc}</small>
                </div>
                {i < pipelineStages.length - 1 && (
                  <div className={`stage-connector-line ${isCompleted ? "done" : ""}`} />
                )}
              </div>
            );
          })}
        </div>
        <p className="pipeline-footnote">
          Orchestration Pipeline: Transactional Outbox (Postgres) → Redis Streams → C++ Worker Engine → Docker Engine API → Nginx Dynamic Ingress
        </p>
      </section>

      {/* Main Split: Build Logs vs Release & Infrastructure Details */}
      <div className="detail-split-grid">
        {/* Left: Build Logs Terminal Console */}
        <section className="build-logs-card" aria-label="Build logs">
          <div className="logs-header-bar">
            <div className="logs-title-group">
              <TerminalIcon size={15} className="term-icon-svg" />
              <strong>Build & Container Logs</strong>
              <span className="logs-status-pill">
                {isRunning ? "Live Stream" : status.toUpperCase()}
              </span>
            </div>

            <div className="logs-actions-group">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={handleCopyLogs}
              >
                <CopyIcon size={12} />
                <span>{copied ? "Copied!" : "Copy"}</span>
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={handleDownloadLogs}
              >
                <DownloadIcon size={12} />
                <span>Download</span>
              </button>
            </div>
          </div>

          {/* Log Filter & Level Switcher Bar */}
          <div className="logs-filter-row">
            <input
              className="logs-search-input"
              value={logFilterQuery}
              onChange={(e) => setLogFilterQuery(e.target.value)}
              placeholder="Filter logs..."
              aria-label="Filter logs by keyword"
            />
            {logFilterQuery && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setLogFilterQuery("")}
                aria-label="Clear log filter"
              >
                <CloseIcon size={10} />
              </button>
            )}

            <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
              {["ALL", "INFO", "WARN", "ERROR"].map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  className={`logs-level-btn ${logLevelFilter === lvl ? "active" : ""}`}
                  onClick={() => setLogLevelFilter(lvl)}
                >
                  {lvl}
                </button>
              ))}
            </div>

            <button
              type="button"
              className={`logs-level-btn ${autoScroll ? "active" : ""}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title="Toggle auto-scroll to bottom"
              style={{ marginLeft: "6px" }}
            >
              Auto-scroll
            </button>
          </div>

          <div className="logs-console-body">
            {filteredLogs.length > 0 ? (
              filteredLogs.map((log, index) => {
                const level = (log.level || "INFO").toLowerCase();
                return (
                  <div key={log.id || index} className={`log-line-item log-${log.type || level}`}>
                    <span className="log-time-cell">{log.time || "—"}</span>
                    <span className="log-msg-cell">{log.text || log.message}</span>
                  </div>
                );
              })
            ) : (
              <div className="log-line-item log-dim">
                <span className="log-time-cell">—</span>
                <span className="log-msg-cell">
                  {logs.length === 0 ? "Connecting to build stream..." : "No logs match the filter."}
                </span>
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        </section>

        {/* Right: Release & Container Infrastructure Details */}
        <aside className="detail-context-card" aria-label="Deployment parameters">
          <h2 className="context-card-title">Release Metadata</h2>
          <dl className="context-list">
            <div className="context-item">
              <dt>Project</dt>
              <dd>{projectName}</dd>
            </div>
            <div className="context-item">
              <dt>Repository</dt>
              <dd>
                <span className="context-repo-tag">
                  <GitHubIcon size={13} className="inline-icon" />
                  <code>{deployment?.repo || deployment?.repository_url || `github.com/acme/${projectName}`}</code>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Branch</dt>
              <dd>
                <span className="context-branch-tag">
                  <GitBranchIcon size={12} className="inline-icon" />
                  <code>{branchName}</code>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Commit</dt>
              <dd>
                <span className="context-commit-tag">
                  <CommitIcon size={11} className="inline-icon" />
                  <code>{commitSha}</code>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Environment</dt>
              <dd>{deployment?.environment ? deployment.environment.charAt(0).toUpperCase() + deployment.environment.slice(1) : "Production"}</dd>
            </div>
            <div className="context-item">
              <dt>Runtime</dt>
              <dd>
                <span className="context-runtime-tag">
                  {renderRuntimeIcon(deployment?.runtime || "node")}
                  <span>{deployment?.runtime === "python" ? "Python 3.12" : deployment?.runtime === "static" ? "Static Nginx" : "Node.js 20"}</span>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Serving State</dt>
              <dd><StatusBadge value={deployment?.status || deployment?.state} size="sm" /></dd>
            </div>
            <div className="context-item">
              <dt>Ingress Domain</dt>
              <dd><code>{projectDomain}</code></dd>
            </div>
          </dl>

          {/* Container Infrastructure Card */}
          <div className="deployment-target-card" style={{ marginTop: "24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "10px" }}>
              <ContainerIcon size={14} className="text-green" />
              <strong style={{ fontSize: "12px", color: "#ffffff" }}>Container Infrastructure</strong>
            </div>

            <div className="target-card-row">
              <span className="target-card-label">Container ID</span>
              <span className="target-card-value" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                {containerId ? (
                  <>
                    <code>{containerId.slice(0, 14)}</code>
                    <button
                      type="button"
                      className="commit-hash-pill"
                      style={{ padding: "1px 5px", fontSize: "10px" }}
                      onClick={() => handleCopyContainerId(containerId)}
                      title="Copy container ID"
                    >
                      <CopyIcon size={10} />
                      <span>{copiedContainerId ? "Copied" : ""}</span>
                    </button>
                  </>
                ) : (
                  <span className="text-muted">Pending spawn</span>
                )}
              </span>
            </div>

            <div className="target-card-row">
              <span className="target-card-label">Docker Network</span>
              <span className="target-card-value">deployforge-apps</span>
            </div>

            <div className="target-card-row">
              <span className="target-card-label">Internal Port</span>
              <span className="target-card-value">:{containerPort}</span>
            </div>

            <div className="target-card-row">
              <span className="target-card-label">Health Probe</span>
              <span className="target-card-value text-green">
                {isRunning ? "Passing HTTP 200" : "Pending probe"}
              </span>
            </div>

            <div className="target-card-row">
              <span className="target-card-label">Ingress Route</span>
              <span className="target-card-value">Nginx Alpine (Active)</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
