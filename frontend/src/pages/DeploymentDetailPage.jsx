import { useState, useEffect } from "react";
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
  DockerIcon,
  SpinnerIcon,
} from "../components/common/TechIcons.jsx";

const sampleLogs = [
  { time: "18:42:03", text: "Deployment picked up by worker-1", type: "system" },
  { time: "18:42:03", text: "Cloning repository branch...", type: "normal" },
  { time: "18:42:06", text: "Checked out target commit", type: "normal" },
  { time: "18:42:06", text: "Container engine initializing build layer...", type: "normal" },
  { time: "18:42:07", text: "Step 1/8 : Setting base image layer", type: "step" },
  { time: "18:42:08", text: " ---> resolving dependencies", type: "dim" },
  { time: "18:42:08", text: "Step 2/8 : WORKDIR /app", type: "step" },
  { time: "18:42:09", text: "Step 3/8 : Installing production dependencies", type: "step" },
  { time: "18:42:25", text: "added production packages successfully", type: "dim" },
  { time: "18:42:28", text: "Step 4/8 : Compiling application assets", type: "step" },
  { time: "18:42:35", text: "Compiled bundle successfully", type: "normal" },
  { time: "18:42:36", text: "Step 5/8 : Health probe on internal port :3000", type: "step" },
  { time: "18:42:38", text: "Container spawned and healthy", type: "normal" },
  { time: "18:42:39", text: "Upstream route synchronized with reverse proxy", type: "success" },
];

export default function DeploymentDetailPage({ navigate }) {
  const [deployment, setDeployment] = useState(null);
  const [logs, setLogs] = useState(sampleLogs);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const targetId = searchParams.get("id");

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        if (targetId) {
          const data = await getDeployment(targetId);
          setDeployment(data);
        } else {
          const list = await fetchDeployments({ limit: 1 });
          if (list.length > 0) {
            setDeployment(list[0]);
          }
        }
      } catch (err) {
        console.warn("Could not load deployment detail:", err.message);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  useEffect(() => {
    if (!deployment?.id) return;
    fetchLogs({ deployment_id: deployment.id })
      .then((data) => {
        if (data.length > 0) {
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

  const status = deployment?.status || deployment?.state || "Running";
  const isRunning = status === "Running" || status === "Succeeded";
  const isFailed = status === "Failed" || status === "Cancelled";
  const isBuilding = status === "Building";
  const isDeploying = status === "Deploying";

  const pipelineStages = [
    { title: "Queued", duration: "0.4s", status: "completed" },
    {
      title: "Cloning",
      duration: isBuilding || isDeploying || isRunning ? "3s" : "pending",
      status: isBuilding || isDeploying || isRunning ? "completed" : status === "Queued" ? "active" : "pending",
    },
    {
      title: "Building",
      duration: isBuilding ? "running" : isDeploying || isRunning ? "45s" : "pending",
      status: isBuilding ? "active" : isDeploying || isRunning ? "completed" : "pending",
    },
    {
      title: "Deploying",
      duration: isDeploying ? "routing" : isRunning ? "3s" : "pending",
      status: isDeploying ? "active" : isRunning ? "completed" : "pending",
    },
    {
      title: "Running",
      duration: isRunning ? "live" : "pending",
      status: isRunning ? "completed" : isFailed ? "failed" : "pending",
    },
  ];

  const handleCopyLogs = () => {
    const text = logs.map((l) => `[${l.time}] ${l.text || l.message}`).join("\n");
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

  const renderRuntimeIcon = (type) => {
    switch (type) {
      case "node":
        return <NodeIcon size={13} className="inline-icon" />;
      case "python":
        return <PythonIcon size={13} className="inline-icon" />;
      case "go":
        return <GoIcon size={13} className="inline-icon" />;
      default:
        return <DockerIcon size={13} className="inline-icon" />;
    }
  };

  const displayNum = deployment?.display_id || (deployment?.num ? `#${deployment.num}` : "#131");
  const projectName = deployment?.projectName || deployment?.project || "web-app";
  const projectDomain = deployment?.url || `${projectName}.deployforge.app`;
  const branchName = deployment?.branch || "main";
  const commitSha = deployment?.commit || deployment?.commit_hash?.slice(0, 7) || "3f9a2c1";

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
              Deployment {displayNum} · {status} · triggered by {deployment?.trigger || "git commit"} · duration {deployment?.duration || "53s"}
            </p>
          </div>

          <div className="detail-actions-cluster">
            <StatusBadge value={status} size="md" />

            {(status === "Queued" || status === "Building") && (
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
              href={`https://${projectDomain}`}
              target="_blank"
              rel="noreferrer"
              className="btn-primary visit-btn"
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
        </div>
      )}

      {/* Pipeline 5-Stage Visualizer */}
      <section className="detail-pipeline-card" aria-label="Deployment pipeline stages">
        <div className="pipeline-stages-row">
          {pipelineStages.map((st, i) => {
            const isCompleted = st.status === "completed";
            const isActive = st.status === "active";
            const isStageFailed = st.status === "failed";
            return (
              <div key={st.title} className="pipeline-stage-item">
                <div className={`stage-marker-box ${st.status}`}>
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
                  <small className="stage-duration">{st.duration}</small>
                </div>
                {i < pipelineStages.length - 1 && (
                  <div className={`stage-connector-line ${isCompleted ? "done" : ""}`} />
                )}
              </div>
            );
          })}
        </div>
        <p className="pipeline-footnote">
          Pipeline orchestration: Redis Stream → C++ worker → Docker Engine API → Nginx upstream proxy
        </p>
      </section>

      {/* Main Split: Build Logs vs Release Details */}
      <div className="detail-split-grid">
        {/* Left: Build Logs Terminal */}
        <section className="build-logs-card" aria-label="Build logs">
          <div className="logs-header-bar">
            <div className="logs-title-group">
              <TerminalIcon size={15} className="term-icon-svg" />
              <strong>Build & Container logs</strong>
              <span className="logs-status-pill">{isRunning ? "Live Stream" : status}</span>
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

          <div className="logs-console-body">
            {logs.map((log, index) => {
              const level = (log.level || "INFO").toLowerCase();
              return (
                <div key={log.id || index} className={`log-line-item log-${log.type || level}`}>
                  <span className="log-time-cell">{log.time}</span>
                  <span className="log-msg-cell">{log.text || log.message}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Right: Release Context Details */}
        <aside className="detail-context-card" aria-label="Deployment parameters">
          <h2 className="context-card-title">Release Details</h2>
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
                  <code>{deployment?.repo || `github.com/acme/${projectName}`}</code>
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
                  <span>{deployment?.runtime === "python" ? "Python 3.12" : deployment?.runtime === "go" ? "Go 1.22" : "Node.js 20"}</span>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Serving State</dt>
              <dd><StatusBadge value={isRunning ? "Live" : status} size="sm" /></dd>
            </div>
            <div className="context-item">
              <dt>Internal URL</dt>
              <dd><code>https://{projectDomain}</code></dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
