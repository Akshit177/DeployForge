import { useState } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
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
} from "../components/common/TechIcons.jsx";

const buildLogs = [
  { time: "18:42:03", text: "Deployment #131 picked up by worker-1", type: "system" },
  { time: "18:42:03", text: "Cloning github.com/acme/web-app (branch main)", type: "normal" },
  { time: "18:42:06", text: "Checked out 3f9a2c1 \"feat: add health endpoint\"", type: "normal" },
  { time: "18:42:06", text: "Dockerfile detected · base image node:20-alpine", type: "normal" },
  { time: "18:42:07", text: "Step 1/8 : FROM node:20-alpine", type: "step" },
  { time: "18:42:08", text: " ---> a1b2c3d4e5f6 (cached)", type: "dim" },
  { time: "18:42:08", text: "Step 2/8 : WORKDIR /app", type: "step" },
  { time: "18:42:09", text: "Step 3/8 : COPY package*.json ./", type: "step" },
  { time: "18:42:12", text: "Step 4/8 : RUN npm ci", type: "step" },
  { time: "18:42:31", text: "npm WARN deprecated inflight@1.0.6: not supported", type: "warn" },
  { time: "18:42:38", text: "added 412 packages in 26s", type: "dim" },
  { time: "18:42:39", text: "Step 5/8 : COPY . .", type: "step" },
  { time: "18:42:41", text: "Step 6/8 : RUN npm run build", type: "step" },
  { time: "18:42:44", text: "> web-app@1.4.0 build", type: "dim" },
  { time: "18:42:51", text: "Compiled successfully in 6.8s", type: "normal" },
  { time: "18:42:52", text: "Step 7/8 : EXPOSE 3000", type: "step" },
  { time: "18:42:52", text: "Step 8/8 : CMD [\"node\", \"dist/server.js\"]", type: "step" },
  { time: "18:42:53", text: "Successfully built 9f3b21c07aa4", type: "normal" },
  { time: "18:42:53", text: "Tagged web-app:3f9a2c1", type: "normal" },
  { time: "18:42:54", text: "Starting container web-app-131", type: "normal" },
  { time: "18:42:55", text: "Container a91f3c0e2b7d running", type: "normal" },
  { time: "18:42:56", text: "Deployment #131 running · public URL routed", type: "success" },
];

export default function DeploymentDetailPage({ navigate }) {
  const [copied, setCopied] = useState(false);

  const pipelineStages = [
    { title: "Queued", duration: "0.4s", status: "completed" },
    { title: "Cloning", duration: "3s", status: "completed" },
    { title: "Building", duration: "47s", status: "completed" },
    { title: "Deploying", duration: "3s", status: "completed" },
    { title: "Running", duration: "now", status: "active" },
  ];

  const handleCopyLogs = () => {
    const text = buildLogs.map((l) => `[${l.time}] ${l.text}`).join("\n");
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadLogs = () => {
    const text = buildLogs.map((l) => `[${l.time}] ${l.text}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "web-app-deployment-131.log";
    a.click();
    URL.revokeObjectURL(url);
  };

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
          <strong className="crumb-active">#131</strong>
        </div>

        <div className="detail-title-action-row">
          <div className="title-and-meta">
            <h1 className="detail-project-title">web-app</h1>
            <p className="detail-meta-text">
              Deployment #131 · completed just now · triggered by git push · duration 53s
            </p>
          </div>

          <div className="detail-actions-cluster">
            <StatusBadge value="Running" size="md" />
            <a
              href="https://web-app.deployforge.app"
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

      {/* Pipeline 5-Stage Visualizer */}
      <section className="detail-pipeline-card" aria-label="Deployment pipeline stages">
        <div className="pipeline-stages-row">
          {pipelineStages.map((st, i) => {
            const isCompleted = st.status === "completed";
            const isActive = st.status === "active";
            return (
              <div key={st.title} className="pipeline-stage-item">
                <div className={`stage-marker-box ${st.status}`}>
                  {isCompleted ? (
                    <CheckIcon size={13} className="stage-check-svg" />
                  ) : isActive ? (
                    <span className="stage-active-pulse" />
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
          Pipeline orchestration: Redis queue → C++ worker → Docker Engine API → Nginx upstream
        </p>
      </section>

      {/* Main Split: Build Logs vs Release Details */}
      <div className="detail-split-grid">
        {/* Left: Build Logs Terminal */}
        <section className="build-logs-card" aria-label="Build logs">
          <div className="logs-header-bar">
            <div className="logs-title-group">
              <TerminalIcon size={15} className="term-icon-svg" />
              <strong>Build logs</strong>
              <span className="logs-status-pill">Complete</span>
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
            {buildLogs.map((log, index) => (
              <div key={index} className={`log-line-item log-${log.type}`}>
                <span className="log-time-cell">{log.time}</span>
                <span className="log-msg-cell">{log.text}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Right: Release Context Details */}
        <aside className="detail-context-card" aria-label="Deployment parameters">
          <h2 className="context-card-title">Release Details</h2>
          <dl className="context-list">
            <div className="context-item">
              <dt>Project</dt>
              <dd>web-app</dd>
            </div>
            <div className="context-item">
              <dt>Repository</dt>
              <dd>
                <span className="context-repo-tag">
                  <GitHubIcon size={13} className="inline-icon" />
                  <code>acme/web-app</code>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Branch</dt>
              <dd>
                <span className="context-branch-tag">
                  <GitBranchIcon size={12} className="inline-icon" />
                  <code>main</code>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Commit</dt>
              <dd>
                <span className="context-commit-tag">
                  <CommitIcon size={11} className="inline-icon" />
                  <code>3f9a2c1</code>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Environment</dt>
              <dd>Production</dd>
            </div>
            <div className="context-item">
              <dt>Runtime</dt>
              <dd>
                <span className="context-runtime-tag">
                  <NodeIcon size={13} className="inline-icon" />
                  <span>Node.js 22 (Alpine)</span>
                </span>
              </dd>
            </div>
            <div className="context-item">
              <dt>Container Port</dt>
              <dd><code>:3000</code></dd>
            </div>
            <div className="context-item">
              <dt>Container ID</dt>
              <dd><code>a91f3c0e2b7d</code></dd>
            </div>
            <div className="context-item">
              <dt>Region</dt>
              <dd>Mumbai · bom1</dd>
            </div>
            <div className="context-item">
              <dt>Serving State</dt>
              <dd><StatusBadge value="Live" size="sm" /></dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
