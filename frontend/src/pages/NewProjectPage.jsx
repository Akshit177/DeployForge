import { useState, useEffect } from "react";
import { createProject } from "../services/projectService.js";
import {
  GitHubIcon,
  GitBranchIcon,
  DockerIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeOffIcon,
  CheckIcon,
  CloseIcon,
  SpinnerIcon,
  ExternalLinkIcon,
  CopyIcon,
  ContainerIcon,
  NginxIcon,
} from "../components/common/TechIcons.jsx";

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

function extractGitHubRepoMetadata(url) {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "GitHub repository URL is required." };
  }
  let clean = url.trim();
  if (!clean) {
    return { valid: false, error: "GitHub repository URL is required." };
  }

  // Handle SSH format git@github.com:owner/repo.git
  if (clean.startsWith("git@github.com:")) {
    clean = clean.replace("git@github.com:", "https://github.com/");
  } else if (!/^https?:\/\//i.test(clean) && clean.startsWith("github.com")) {
    clean = `https://${clean}`;
  }

  // Detect and extract branch from /tree/branch-name URLs if present
  let detectedBranch = null;
  const treeMatch = clean.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/?#]+)/i);
  if (treeMatch) {
    detectedBranch = treeMatch[3];
    clean = `https://github.com/${treeMatch[1]}/${treeMatch[2]}`;
  }

  // Strip query parameters, hashes, trailing slashes, and .git
  clean = clean.split(/[?#]/)[0].replace(/\/+$/, "").replace(/\.git$/i, "");

  const match = clean.match(/^https?:\/\/github\.com\/([a-zA-Z0-9_\-\.]+)\/([a-zA-Z0-9_\-\.]+)$/i);
  if (!match) {
    if (!clean.toLowerCase().includes("github.com")) {
      return {
        valid: false,
        error: "Invalid repository provider. Only GitHub repositories (https://github.com/owner/repository) are supported.",
      };
    }
    return {
      valid: false,
      error: "Invalid GitHub repository link format. Must be in the format: https://github.com/organization/repository",
    };
  }

  const owner = match[1];
  const repo = match[2];
  const sanitizedProjectName = repo
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");

  return {
    valid: true,
    owner,
    repo,
    projectName: sanitizedProjectName || "my-app",
    branch: detectedBranch,
    normalizedUrl: clean,
  };
}

export default function NewProjectPage({ navigate, searchParams }) {
  const [repoUrl, setRepoUrl] = useState("https://github.com/acme/web-app");
  const [repoUrlError, setRepoUrlError] = useState("");
  const [projectName, setProjectName] = useState("web-app");
  const [isCustomName, setIsCustomName] = useState(false);
  const [nameError, setNameError] = useState("");
  const [branch, setBranch] = useState("main");
  const [selectedRuntime, setSelectedRuntime] = useState("docker");
  const [port, setPort] = useState("3000");
  const [portError, setPortError] = useState("");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(null);

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

    // Validate GitHub Repo URL
    const repoValidation = extractGitHubRepoMetadata(repoUrl);
    if (!repoValidation.valid) {
      setRepoUrlError(repoValidation.error);
      setErrorMessage(repoValidation.error);
      return;
    }
    setRepoUrlError("");

    // Validate Project Name
    const cleanName = projectName.trim();
    if (cleanName.length < 2 || cleanName.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
      const err = "Project name must be 2-64 characters long and contain only letters, numbers, hyphens, and underscores.";
      setNameError(err);
      setErrorMessage(err);
      return;
    }
    setNameError("");

    // Validate Port
    const parsedPort = Number.parseInt(port, 10);
    if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      const err = "Internal container port must be a valid port number between 1 and 65535.";
      setPortError(err);
      setErrorMessage(err);
      return;
    }
    setPortError("");

    setIsDeploying(true);
    setErrorMessage("");
    try {
      await createProject({
        name: cleanName,
        repository_url: repoValidation.normalizedUrl || repoUrl.trim(),
        branch: branch.trim() || repoValidation.branch || "main",
        runtime: selectedRuntime,
        port: parsedPort,
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

  const handleRepoUrlChange = (val) => {
    setRepoUrl(val);
    if (repoUrlError) setRepoUrlError("");
    const meta = extractGitHubRepoMetadata(val);
    if (meta.valid) {
      if (!isCustomName || projectName === "web-app") {
        setProjectName(meta.projectName);
        if (nameError) setNameError("");
      }
      if (meta.branch) {
        setBranch(meta.branch);
      }
    }
  };

  const handleRepoUrlBlur = () => {
    if (repoUrl.trim()) {
      const meta = extractGitHubRepoMetadata(repoUrl);
      if (!meta.valid) {
        setRepoUrlError(meta.error);
      } else {
        setRepoUrlError("");
        if (!isCustomName || projectName === "web-app") {
          setProjectName(meta.projectName);
        }
        if (meta.branch) {
          setBranch(meta.branch);
        }
      }
    }
  };

  const handleProjectNameChange = (val) => {
    setProjectName(val);
    setIsCustomName(true);
    if (nameError) setNameError("");
  };

  const cleanSlug = projectName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "my-app";
  const publicUrl = `https://${cleanSlug}.deployforge.app`;
  const localUrl = `http://${cleanSlug}.localhost`;
  const nipIoUrl = `http://${cleanSlug}.127.0.0.1.nip.io`;

  const handleCopyUrl = (urlToCopy, type = "prod") => {
    navigator.clipboard?.writeText(urlToCopy);
    setCopiedUrl(type);
    setTimeout(() => setCopiedUrl(null), 1800);
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
          Connect your Git repository containing a root Dockerfile. DeployForge builds, health-checks, and exposes it through zero-downtime Nginx ingress.
        </p>
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
                  type="text"
                  value={repoUrl}
                  onChange={(e) => handleRepoUrlChange(e.target.value)}
                  onBlur={handleRepoUrlBlur}
                  placeholder="https://github.com/organization/repository"
                  style={repoUrlError ? { borderColor: "#ef4444" } : {}}
                />
              </div>
              {repoUrlError ? (
                <span className="field-error-text">
                  <CloseIcon size={11} />
                  <span>{repoUrlError}</span>
                </span>
              ) : (
                <span className="field-hint">Public repository. Cloned securely into isolated deployment workspace.</span>
              )}
            </div>

            {/* Two-Column: Project Name & Branch */}
            <div className="form-two-col">
              <div className="form-field-block">
                <label htmlFor="project-name">Project name</label>
                <input
                  id="project-name"
                  required
                  value={projectName}
                  onChange={(e) => handleProjectNameChange(e.target.value)}
                  placeholder="my-app"
                  style={nameError ? { borderColor: "#ef4444" } : {}}
                />
                {nameError && (
                  <span className="field-error-text">
                    <CloseIcon size={11} />
                    <span>{nameError}</span>
                  </span>
                )}
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

            {/* Build Engine: Strict Dockerfile */}
            <div className="form-field-block">
              <label>Build Engine & Runtime</label>
              <div
                className="runtime-docker-badge-card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.875rem 1rem",
                  borderRadius: "8px",
                  border: "1px solid #27272a",
                  background: "#09090b",
                  gap: "1rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <div
                    style={{
                      width: "36px",
                      height: "36px",
                      borderRadius: "6px",
                      background: "rgba(16, 185, 129, 0.1)",
                      border: "1px solid rgba(16, 185, 129, 0.2)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <DockerIcon size={20} className="text-green" />
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <strong style={{ fontSize: "0.875rem", color: "#f4f4f5" }}>Root Dockerfile Engine</strong>
                      <span className="starter-badge ready" style={{ fontSize: "0.65rem" }}>Strict Dockerfile</span>
                    </div>
                    <small style={{ fontSize: "0.75rem", color: "#71717a", display: "block", marginTop: "2px" }}>
                      DeployForge strictly builds using the repository&apos;s root <code>Dockerfile</code>. Any framework or language is packaged into an isolated OCI container.
                    </small>
                  </div>
                </div>
                <CheckIcon size={16} className="text-green" style={{ flexShrink: 0 }} />
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
                onChange={(e) => {
                  setPort(e.target.value);
                  if (portError) setPortError("");
                }}
                placeholder="3000"
                style={{ width: "160px", ...(portError ? { borderColor: "#ef4444" } : {}) }}
              />
              {portError ? (
                <span className="field-error-text">
                  <CloseIcon size={11} />
                  <span>{portError}</span>
                </span>
              ) : (
                <span className="field-hint">The port your application server listens on inside the Docker container.</span>
              )}
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
            <div className="domain-preview-box" style={{ marginTop: "1.25rem", padding: "1rem", borderRadius: "var(--radius-md)", background: "rgba(255, 255, 255, 0.02)", border: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                <span className="preview-label" style={{ fontWeight: 600, color: "var(--text-secondary)", fontSize: "0.8125rem" }}>
                  Public Ingress Route:
                </span>
                <span className="starter-badge ready" style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
                  Active On Deploy
                </span>
              </div>

              {/* Primary Vanity Domain */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", background: "rgba(0, 0, 0, 0.35)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", marginBottom: "6px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden" }}>
                  <span className="status-indicator status-dot green-pulse" style={{ width: "6px", height: "6px", flexShrink: 0 }} />
                  <strong className="preview-url" style={{ color: "var(--accent-emerald, #10b981)", fontFamily: "var(--font-mono)", fontSize: "0.8125rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {publicUrl}
                  </strong>
                </div>
                <button
                  type="button"
                  className="commit-hash-pill"
                  onClick={() => handleCopyUrl(publicUrl, "prod")}
                  title="Copy public URL"
                  style={{ flexShrink: 0 }}
                >
                  <CopyIcon size={11} />
                  <span>{copiedUrl === "prod" ? "Copied" : "Copy"}</span>
                </button>
              </div>

              {/* Local Development Host Route */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", background: "rgba(255, 255, 255, 0.015)", padding: "6px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.75rem", color: "var(--text-secondary)", overflow: "hidden" }}>
                  <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>Local:</span>
                  <code style={{ color: "var(--text-primary)", fontSize: "0.75rem" }}>{localUrl}</code>
                  <span style={{ color: "var(--text-tertiary)" }}>·</span>
                  <code style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>{nipIoUrl}</code>
                </div>
                <button
                  type="button"
                  className="commit-hash-pill"
                  onClick={() => handleCopyUrl(localUrl, "local")}
                  title="Copy local ingress URL"
                  style={{ flexShrink: 0 }}
                >
                  <CopyIcon size={10} />
                  <span>{copiedUrl === "local" ? "Copied" : "Copy"}</span>
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
                disabled={isDeploying}
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
                <strong>Root Dockerfile build</strong>
                <p>Validates root <code>Dockerfile</code> and packages dependencies into an isolated OCI container image.</p>
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
