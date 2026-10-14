import { useState, useEffect } from "react";
import { createProject } from "../services/projectService.js";
import {
  GitHubIcon,
  GitBranchIcon,
  NodeIcon,
  PythonIcon,
  HtmlIcon,
  DockerIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeOffIcon,
  CheckIcon,
  SpinnerIcon,
  ExternalLinkIcon,
  CopyIcon,
  ContainerIcon,
  NginxIcon,
} from "../components/common/TechIcons.jsx";

const STARTER_TEMPLATES = [
  {
    id: "node",
    name: "Node.js Express",
    desc: "REST API with Express, internal port :3000, and health probes",
    defaultRepo: "https://github.com/expressjs/express-starter",
    defaultBranch: "main",
    defaultName: "node-express-app",
    runtime: "node",
    defaultPort: "3000",
    status: "ready",
    Icon: NodeIcon,
  },
  {
    id: "static",
    name: "Static Web Site",
    desc: "Static HTML/CSS/JS bundle served with Nginx Alpine on port :80",
    defaultRepo: "https://github.com/deployforge/static-site-template",
    defaultBranch: "main",
    defaultName: "static-web-app",
    runtime: "static",
    defaultPort: "80",
    status: "ready",
    Icon: HtmlIcon,
  },
  {
    id: "python",
    name: "Python FastAPI",
    desc: "FastAPI with Uvicorn. Container runtime arriving in Phase D",
    defaultRepo: "https://github.com/tiangolo/fastapi",
    defaultBranch: "master",
    defaultName: "fastapi-service",
    runtime: "python",
    defaultPort: "8000",
    status: "coming-soon",
    Icon: PythonIcon,
  },
  {
    id: "docker",
    name: "Custom Dockerfile",
    desc: "Build using the repository's root Dockerfile on any port",
    defaultRepo: "",
    defaultBranch: "main",
    defaultName: "custom-container-app",
    runtime: "docker",
    defaultPort: "3000",
    status: "ready",
    Icon: DockerIcon,
  },
];

const RUNTIME_OPTIONS = [
  { id: "node", label: "Node.js", defaultPort: "3000", Icon: NodeIcon, desc: "Express, Fastify, Next.js, or Nest" },
  { id: "static", label: "Static Site", defaultPort: "80", Icon: HtmlIcon, desc: "HTML/CSS/JS served via Nginx" },
  { id: "docker", label: "Dockerfile", defaultPort: "3000", Icon: DockerIcon, desc: "Custom container build" },
  { id: "python", label: "Python (Coming Soon)", defaultPort: "8000", Icon: PythonIcon, desc: "Container engine arrives in Phase D", disabled: true },
];

function parseEnvString(rawText) {
  const lines = rawText.split("\n");
  const parsed = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim().toUpperCase();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const isSecret = /SECRET|KEY|PASSWORD|PASS|TOKEN|CREDENTIAL|PRIVATE/i.test(key);
    parsed.push({
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      key,
      value: val,
      isSecret,
      show: !isSecret,
    });
  }
  return parsed;
}

function serializeEnvVars(vars) {
  return vars.map((v) => `${v.key}=${v.value}`).join("\n");
}

export default function NewProjectPage({ navigate, searchParams }) {
  const [repoUrl, setRepoUrl] = useState("https://github.com/acme/web-app");
  const [projectName, setProjectName] = useState("web-app");
  const [branch, setBranch] = useState("main");
  const [selectedRuntime, setSelectedRuntime] = useState("node");
  const [port, setPort] = useState("3000");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Starter template selected id
  const [activeTemplate, setActiveTemplate] = useState(null);

  // Env vars state
  const [envMode, setEnvMode] = useState("form"); // "form" | "bulk"
  const [envVars, setEnvVars] = useState([
    { id: "1", key: "NODE_ENV", value: "production", isSecret: false, show: true },
    { id: "2", key: "DATABASE_URL", value: "postgres://user:secret@db.deployforge.internal:5432/app", isSecret: true, show: false },
  ]);
  const [bulkEnvText, setBulkEnvText] = useState(
    "NODE_ENV=production\nDATABASE_URL=postgres://user:secret@db.deployforge.internal:5432/app"
  );
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  // Check searchParams on mount for preselected template
  useEffect(() => {
    if (!searchParams) return;
    const templateQuery = searchParams.get("template");
    if (templateQuery) {
      applyTemplate(templateQuery);
    }
  }, [searchParams]);

  const applyTemplate = (templateId) => {
    const tmpl = STARTER_TEMPLATES.find((t) => t.id === templateId);
    if (!tmpl || tmpl.status === "coming-soon") return;
    setActiveTemplate(tmpl.id);
    setSelectedRuntime(tmpl.runtime);
    setPort(tmpl.defaultPort);
    if (tmpl.defaultRepo) setRepoUrl(tmpl.defaultRepo);
    if (tmpl.defaultName) setProjectName(tmpl.defaultName);
    if (tmpl.defaultBranch) setBranch(tmpl.defaultBranch);
  };

  const handleRuntimeSelect = (rt) => {
    if (rt.disabled) return;
    setSelectedRuntime(rt.id);
    setPort(rt.defaultPort);
    setActiveTemplate(null);
  };

  const handleAddEnv = (e) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    const isSecret = /SECRET|KEY|PASSWORD|PASS|TOKEN|CREDENTIAL|PRIVATE/i.test(newKey.trim());
    const updated = [
      ...envVars,
      {
        id: Date.now().toString(),
        key: newKey.trim().toUpperCase(),
        value: newVal.trim(),
        isSecret,
        show: !isSecret,
      },
    ];
    setEnvVars(updated);
    setBulkEnvText(serializeEnvVars(updated));
    setNewKey("");
    setNewVal("");
  };

  const handleToggleSecret = (id) => {
    setEnvVars(
      envVars.map((v) => (v.id === id ? { ...v, show: !v.show } : v))
    );
  };

  const handleRemoveEnv = (id) => {
    const updated = envVars.filter((v) => v.id !== id);
    setEnvVars(updated);
    setBulkEnvText(serializeEnvVars(updated));
  };

  const handleBulkEnvChange = (text) => {
    setBulkEnvText(text);
    const parsed = parseEnvString(text);
    setEnvVars(parsed);
  };

  const handleDeploy = async (e) => {
    e.preventDefault();
    if (selectedRuntime === "python") {
      setErrorMessage("Python container runtime is arriving in Phase D and is currently disabled.");
      return;
    }
    setIsDeploying(true);
    setErrorMessage("");
    try {
      await createProject({
        name: projectName,
        repository_url: repoUrl,
        branch,
        runtime: selectedRuntime,
        port: Number.parseInt(port, 10) || 3000,
        auto_deploy: autoDeploy,
        env_vars: envVars.map(({ key, value, isSecret }) => ({ key, value, isSecret })),
      });
      setDeploySuccess(true);
      setTimeout(() => {
        navigate("/projects");
      }, 900);
    } catch (err) {
      setErrorMessage(err.message || "Failed to create project.");
      setIsDeploying(false);
    }
  };

  const cleanSlug = projectName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || "my-app";
  const publicUrl = `https://${cleanSlug}.deployforge.app`;

  const handleCopyUrl = () => {
    navigator.clipboard?.writeText(publicUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1800);
  };

  return (
    <div className="new-project-page reveal">
      {/* Breadcrumb + Title */}
      <div className="new-project-header">
        <div className="figma-crumb-trail">
          <span className="crumb-clickable" onClick={() => navigate("/projects")}>Projects</span>
          <span className="crumb-sep">/</span>
          <strong className="crumb-active">New Project</strong>
        </div>

        <h1 className="figma-page-title">Import a repository</h1>
        <p className="figma-page-subtitle">
          Connect your Git repository or choose a verified template. DeployForge builds, health-checks, and exposes it through zero-downtime Nginx ingress.
        </p>
      </div>

      {/* Quick Starter Templates Selection Strip */}
      <div className="new-project-templates-strip">
        <div className="templates-strip-header">
          <span className="templates-strip-title">One-Click Starter Templates</span>
          <span className="env-sub-note">Pre-configured repositories & container ports</span>
        </div>
        <div className="template-pill-selector">
          {STARTER_TEMPLATES.map((tmpl) => {
            const isSelected = activeTemplate === tmpl.id;
            const isSoon = tmpl.status === "coming-soon";
            const IconComp = tmpl.Icon;
            return (
              <div
                key={tmpl.id}
                className={`template-pill-card ${isSelected ? "selected" : ""} ${isSoon ? "disabled" : ""}`}
                onClick={() => !isSoon && applyTemplate(tmpl.id)}
                title={isSoon ? "Python container runtime is scheduled for Phase D" : `Use ${tmpl.name} template`}
                role="button"
                tabIndex={isSoon ? -1 : 0}
              >
                <div className="template-pill-top">
                  <IconComp size={18} className={isSelected ? "text-green" : "text-secondary"} />
                  {isSoon ? (
                    <span className="starter-badge soon">Coming Soon</span>
                  ) : isSelected ? (
                    <CheckIcon size={13} className="text-green" />
                  ) : (
                    <span className="starter-badge ready">Ready</span>
                  )}
                </div>
                <strong className="template-pill-name">{tmpl.name}</strong>
                <span className="template-pill-desc">{tmpl.desc}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="new-project-split-layout">
        {/* Left Form: Configuration */}
        <div className="new-project-form-card">
          {/* Stepper Header */}
          <div className="setup-steps-strip">
            <div className="step-badge completed">
              <span className="step-num-box"><CheckIcon size={12} /></span>
              <span className="step-title-txt">Repository</span>
            </div>
            <div className="step-badge active">
              <span className="step-num-box">2</span>
              <span className="step-title-txt">Configure</span>
            </div>
            <div className="step-badge">
              <span className="step-num-box">3</span>
              <span className="step-title-txt">Deploy</span>
            </div>
          </div>

          {errorMessage && (
            <div className="auth-message-block error" style={{ margin: "1rem 0" }}>
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleDeploy} className="setup-main-form">
            {/* Repo Field */}
            <div className="form-field-block">
              <label htmlFor="repo-url">GitHub repository URL</label>
              <div className="input-with-icon">
                <GitHubIcon size={16} className="field-icon-svg" />
                <input
                  id="repo-url"
                  required
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/organization/repository"
                />
              </div>
              <span className="field-hint">Public repository. Cloned securely into isolated deployment workspace.</span>
            </div>

            {/* Two-Column: Project Name & Branch */}
            <div className="form-two-col">
              <div className="form-field-block">
                <label htmlFor="project-name">Project name</label>
                <input
                  id="project-name"
                  required
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="my-app"
                />
              </div>

              <div className="form-field-block">
                <label htmlFor="branch">Production branch</label>
                <div className="input-with-icon">
                  <GitBranchIcon size={13} className="field-icon-svg" />
                  <input
                    id="branch"
                    required
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                  />
                </div>
              </div>
            </div>

            {/* Runtime Selection Cards */}
            <div className="form-field-block">
              <label>Application Runtime & Framework</label>
              <div className="runtime-cards-grid">
                {RUNTIME_OPTIONS.map((rt) => {
                  const isSelected = selectedRuntime === rt.id;
                  const IconComp = rt.Icon;
                  return (
                    <div
                      key={rt.id}
                      className={`runtime-card-option ${isSelected ? "selected" : ""} ${rt.disabled ? "disabled" : ""}`}
                      onClick={() => handleRuntimeSelect(rt)}
                      role="button"
                      tabIndex={rt.disabled ? -1 : 0}
                      title={rt.disabled ? "Python container runtime is scheduled for Phase D" : rt.label}
                      style={rt.disabled ? { opacity: 0.5, cursor: "not-allowed" } : {}}
                    >
                      <div className="runtime-card-top">
                        <IconComp size={20} className="runtime-card-icon" />
                        {isSelected && <CheckIcon size={14} className="runtime-selected-check" />}
                        {rt.disabled && <span className="starter-badge soon">Coming Soon</span>}
                      </div>
                      <strong className="runtime-card-name">{rt.label}</strong>
                      <small className="runtime-card-desc">{rt.desc}</small>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Container Port */}
            <div className="form-field-block">
              <label htmlFor="port">Internal Container Port</label>
              <input
                id="port"
                required
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="3000"
                style={{ width: "160px" }}
              />
              <span className="field-hint">The port your application server listens on inside the Docker container.</span>
            </div>

            {/* Environment Variables Editor: Form vs Bulk */}
            <div className="form-field-block">
              <div className="env-header-row">
                <label>Environment Variables</label>
                <div className="env-mode-switch">
                  <button
                    type="button"
                    className={`env-mode-btn ${envMode === "form" ? "active" : ""}`}
                    onClick={() => setEnvMode("form")}
                  >
                    Table View
                  </button>
                  <button
                    type="button"
                    className={`env-mode-btn ${envMode === "bulk" ? "active" : ""}`}
                    onClick={() => {
                      setBulkEnvText(serializeEnvVars(envVars));
                      setEnvMode("bulk");
                    }}
                  >
                    Bulk .env Editor
                  </button>
                </div>
              </div>

              {envMode === "form" ? (
                <div className="env-editor-card">
                  {envVars.length > 0 && (
                    <div className="env-editor-list">
                      {envVars.map((item) => (
                        <div key={item.id} className="env-editor-row">
                          <code className="env-key-cell">{item.key}</code>
                          <span className="env-equal-sign">=</span>
                          <div className="env-val-cell">
                            <span>{item.isSecret && !item.show ? "••••••••••••••••" : item.value}</span>
                            {item.isSecret && (
                              <button
                                type="button"
                                className="env-mask-btn"
                                onClick={() => handleToggleSecret(item.id)}
                                aria-label={item.show ? "Hide value" : "Reveal value"}
                              >
                                {item.show ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            className="env-del-btn"
                            onClick={() => handleRemoveEnv(item.id)}
                            aria-label={`Remove variable ${item.key}`}
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="env-add-inline">
                    <input
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      placeholder="KEY (e.g. API_KEY)"
                      className="env-inline-input key"
                    />
                    <input
                      value={newVal}
                      onChange={(e) => setNewVal(e.target.value)}
                      placeholder="VALUE"
                      className="env-inline-input val"
                    />
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={handleAddEnv}
                    >
                      <PlusIcon size={12} />
                      <span>Add</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="env-editor-card" style={{ padding: "12px" }}>
                  <textarea
                    className="env-bulk-textarea"
                    value={bulkEnvText}
                    onChange={(e) => handleBulkEnvChange(e.target.value)}
                    placeholder="PASTE .ENV HERE (e.g. PORT=3000&#10;API_KEY=sk_12345)"
                  />
                  <span className="field-hint" style={{ marginTop: "6px", display: "block" }}>
                    Lines are parsed automatically into encrypted deployment variables.
                  </span>
                </div>
              )}
            </div>

            {/* Continuous Deployment Toggle */}
            <div className="toggle-setting-row">
              <div className="toggle-text">
                <strong>Continuous deployment</strong>
                <p>Automatically rebuild and deploy when changes are pushed to <code>{branch}</code>.</p>
              </div>
              <label className="switch-toggle" aria-label="Toggle continuous deployment">
                <input
                  type="checkbox"
                  checked={autoDeploy}
                  onChange={(e) => setAutoDeploy(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>

            {/* Live Domain Preview Box */}
            <div className="domain-preview-box">
              <span className="preview-label">Public Ingress Route:</span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <strong className="preview-url">{publicUrl}</strong>
                <button
                  type="button"
                  className="commit-hash-pill"
                  onClick={handleCopyUrl}
                  title="Copy preview URL"
                >
                  <CopyIcon size={11} />
                  <span>{copiedUrl ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="form-action-buttons">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigate("/projects")}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={isDeploying || selectedRuntime === "python"}
              >
                {isDeploying ? (
                  <>
                    <SpinnerIcon size={14} className="spin" />
                    <span>Dispatching deployment...</span>
                  </>
                ) : deploySuccess ? (
                  <>
                    <CheckIcon size={14} />
                    <span>Project Created! Redirecting...</span>
                  </>
                ) : (
                  <span>Deploy Project →</span>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Right Guidance Sidebar & Infrastructure Topology */}
        <aside className="new-project-guide-card">
          <h2 className="guide-title">Deployment Pipeline</h2>
          <p className="guide-subtitle">
            DeployForge’s automated lifecycle handles build orchestration, container isolation, and reverse proxy routing:
          </p>

          <ol className="guide-steps-list">
            <li className="guide-step-item">
              <span className="step-bullet">1</span>
              <div>
                <strong>Clone repository</strong>
                <p>Dedicated workspace created at <code>/var/lib/deployforge/workspaces/&lt;id&gt;</code>.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">2</span>
              <div>
                <strong>Runtime detection & build</strong>
                <p>Detects Dockerfile or manages build using verified container template.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">3</span>
              <div>
                <strong>Isolated container launch</strong>
                <p>Spawns non-root container attached to <code>deployforge-apps</code> network.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">4</span>
              <div>
                <strong>Health verification on :{port}</strong>
                <p>Strict HTTP probe verifies app readiness before promoting traffic.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">5</span>
              <div>
                <strong>Zero-downtime Nginx reload</strong>
                <p>Validates upstream configuration and hot-reloads Nginx proxy routes.</p>
              </div>
            </li>
          </ol>

          {/* Infrastructure Topology Card */}
          <div className="deployment-target-card">
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
              <ContainerIcon size={14} className="text-green" />
              <strong style={{ fontSize: "12px", color: "#ffffff" }}>Target Infrastructure Specs</strong>
            </div>
            <div className="target-card-row">
              <span className="target-card-label">Docker Network</span>
              <span className="target-card-value">deployforge-apps</span>
            </div>
            <div className="target-card-row">
              <span className="target-card-label">Internal Port</span>
              <span className="target-card-value">:{port}</span>
            </div>
            <div className="target-card-row">
              <span className="target-card-label">Ingress Proxy</span>
              <span className="target-card-value">Nginx Alpine (SSL/HTTP2)</span>
            </div>
            <div className="target-card-row">
              <span className="target-card-label">Worker Engine</span>
              <span className="target-card-value">C++ High-Performance / Node</span>
            </div>
          </div>

          <div className="guide-tip-box" style={{ marginTop: "16px" }}>
            <strong>Transactional Outbox Guarantee</strong>
            <p>
              Your deployment request is recorded atomically in PostgreSQL and dispatched through Redis Streams
              with at-least-once delivery semantics.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
