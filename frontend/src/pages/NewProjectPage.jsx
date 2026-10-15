import { useState, useEffect } from "react";
import { createProject } from "../services/projectService.js";
import TextInput from "../components/common/TextInput.jsx";
import FormMessage from "../components/common/FormMessage.jsx";
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

const POSIX_ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseEnvString(rawText) {
  const lines = rawText.split(/\r?\n/);
  const parsed = [];
  const seenKeys = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!POSIX_ENV_KEY_REGEX.test(key)) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    parsed.push({
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      key,
      value: val,
      isSecret: true,
      show: false,
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
    { id: "1", key: "NODE_ENV", value: "production", isSecret: true, show: false },
    { id: "2", key: "DATABASE_URL", value: "postgres://user:secret@db.deployforge.internal:5432/app", isSecret: true, show: false },
  ]);
  const [bulkEnvText, setBulkEnvText] = useState(
    "NODE_ENV=production\nDATABASE_URL=postgres://user:secret@db.deployforge.internal:5432/app"
  );
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [showNewVal, setShowNewVal] = useState(false);
  const [envKeyError, setEnvKeyError] = useState("");

  const handleKeyPaste = (e) => {
    const text = e.clipboardData?.getData("text");
    if (text && (text.includes("\n") || text.includes("="))) {
      e.preventDefault();
      const parsed = parseEnvString(text);
      if (parsed.length > 0) {
        if (parsed.length === 1 && !text.includes("\n")) {
          setNewKey(parsed[0].key);
          setNewVal(parsed[0].value);
          setEnvKeyError("");
          return;
        }

        const existingKeys = new Set(envVars.map((v) => v.key));
        const newItems = parsed.filter((p) => !existingKeys.has(p.key));
        const updated = [...envVars, ...newItems];
        setEnvVars(updated);
        setBulkEnvText(serializeEnvVars(updated));
        setNewKey("");
        setNewVal("");
        setEnvKeyError("");
      }
    }
  };

  const handleAddEnv = (e) => {
    if (e) e.preventDefault();
    setEnvKeyError("");
    const cleanKey = newKey.trim();
    if (!cleanKey) return;

    if (!POSIX_ENV_KEY_REGEX.test(cleanKey)) {
      setEnvKeyError("Key must follow POSIX format (letters, digits, underscores, starting with letter or underscore).");
      return;
    }

    if (envVars.some((v) => v.key === cleanKey)) {
      setEnvKeyError(`Variable "${cleanKey}" already exists.`);
      return;
    }

    const updated = [
      ...envVars,
      {
        id: Date.now().toString(),
        key: cleanKey,
        value: newVal.trim(),
        isSecret: true,
        show: false,
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
            <FormMessage
              message={errorMessage}
              type="error"
              style={{ margin: "1rem 0" }}
            />
          )}

          <form onSubmit={handleDeploy} className="setup-main-form">
            {/* Repo Field */}
            <TextInput
              id="repo-url"
              label="GitHub repository URL"
              required
              monospace
              prefixIcon={GitHubIcon}
              value={repoUrl}
              onChange={(e) => handleRepoUrlChange(e.target.value)}
              onBlur={handleRepoUrlBlur}
              placeholder="https://github.com/organization/repository"
              error={repoUrlError}
              helperText="Public repository. Cloned securely into isolated deployment workspace."
              className="form-field-block"
            />

            {/* Two-Column: Project Name & Branch */}
            <div className="form-two-col">
              <TextInput
                id="project-name"
                label="Project name"
                required
                value={projectName}
                onChange={(e) => handleProjectNameChange(e.target.value)}
                placeholder="my-app"
                error={nameError}
                className="form-field-block"
              />

              <TextInput
                id="branch"
                label="Production branch"
                required
                prefixIcon={GitBranchIcon}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="form-field-block"
              />
            </div>

            {/* Build Engine: Strict Dockerfile */}
            <div className="form-field-block">
              <label>Build Engine & Runtime</label>
              <div className="runtime-docker-badge-card">
                <div className="runtime-info-left">
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
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="runtime-title-row">
                      <strong style={{ fontSize: "0.875rem", color: "#f4f4f5" }}>Root Dockerfile Engine</strong>
                      <span className="starter-badge ready" style={{ fontSize: "0.65rem" }}>Strict Dockerfile</span>
                    </div>
                    <small className="runtime-text-desc">
                      DeployForge strictly builds using the repository&apos;s root <code>Dockerfile</code>. Any framework or language is packaged into an isolated OCI container.
                    </small>
                  </div>
                </div>
                <CheckIcon size={16} className="text-green" style={{ flexShrink: 0 }} />
              </div>
            </div>

            {/* Container Port */}
            <TextInput
              id="port"
              label="Internal Container Port"
              required
              type="number"
              monospace
              value={port}
              onChange={(e) => {
                setPort(e.target.value);
                if (portError) setPortError("");
              }}
              placeholder="3000"
              error={portError}
              helperText="The port your application server listens on inside the Docker container."
              style={{ maxWidth: "240px" }}
              className="form-field-block"
            />

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
                            <span>{!item.show ? "••••••••••••••••" : item.value}</span>
                            <button
                              type="button"
                              className="env-mask-btn"
                              onClick={() => handleToggleSecret(item.id)}
                              aria-label={item.show ? `Hide value for variable ${item.key}` : `Reveal value for variable ${item.key}`}
                            >
                              {item.show ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                            </button>
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

                  {envKeyError && (
                    <div style={{ color: "#ef4444", fontSize: "11px", marginBottom: "6px" }}>
                      {envKeyError}
                    </div>
                  )}

                  <div className="env-add-inline">
                    <input
                      value={newKey}
                      onChange={(e) => {
                        setNewKey(e.target.value);
                        if (envKeyError) setEnvKeyError("");
                      }}
                      onPaste={handleKeyPaste}
                      placeholder="KEY (e.g. API_KEY)"
                      className="env-inline-input key"
                      style={envKeyError ? { borderColor: "#ef4444" } : {}}
                    />
                    <div style={{ position: "relative", flex: 1, minWidth: "120px", display: "flex", alignItems: "center" }}>
                      <input
                        type={showNewVal ? "text" : "password"}
                        value={newVal}
                        onChange={(e) => setNewVal(e.target.value)}
                        placeholder="VALUE"
                        className="env-inline-input val"
                        style={{ width: "100%", paddingRight: "30px" }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewVal(!showNewVal)}
                        style={{
                          position: "absolute",
                          right: "8px",
                          background: "none",
                          border: "none",
                          color: "var(--text-tertiary)",
                          cursor: "pointer",
                          padding: "2px",
                        }}
                        aria-label={showNewVal ? "Hide new variable value" : "Reveal new variable value"}
                      >
                        {showNewVal ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                      </button>
                    </div>
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
              <div className="domain-preview-header" style={{ marginBottom: "0.5rem" }}>
                <span className="preview-label" style={{ fontWeight: 600, color: "var(--text-secondary)", fontSize: "0.8125rem" }}>
                  Public Ingress Route:
                </span>
                <span className="starter-badge ready" style={{ fontSize: "0.65rem", padding: "1px 6px" }}>
                  Active On Deploy
                </span>
              </div>

              {/* Primary Vanity Domain */}
              <div className="domain-preview-route-row primary" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", background: "rgba(0, 0, 0, 0.35)", padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", marginBottom: "6px", minWidth: 0, width: "100%", boxSizing: "border-box" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", overflow: "hidden", minWidth: 0, flex: 1 }}>
                  <span className="status-indicator status-dot green-pulse" style={{ width: "6px", height: "6px", flexShrink: 0 }} />
                  <strong className="preview-url" style={{ color: "var(--accent-emerald, #10b981)", fontFamily: "var(--font-mono)", fontSize: "0.8125rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}>
                    {publicUrl}
                  </strong>
                </div>
                <button
                  type="button"
                  className="commit-hash-pill"
                  onClick={() => handleCopyUrl(publicUrl, "prod")}
                  title="Copy public URL"
                  aria-label={copiedUrl === "prod" ? "Copied public URL" : "Copy public URL"}
                  style={{ flexShrink: 0 }}
                >
                  <CopyIcon size={11} aria-hidden="true" />
                  <span>{copiedUrl === "prod" ? "Copied" : "Copy"}</span>
                </button>
              </div>

              {/* Local Development Host Route */}
              <div className="domain-preview-route-row local" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", background: "rgba(255, 255, 255, 0.015)", padding: "6px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)", minWidth: 0, width: "100%", boxSizing: "border-box" }}>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", fontSize: "0.75rem", color: "var(--text-secondary)", minWidth: 0, flex: 1, overflow: "hidden" }}>
                  <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>Local:</span>
                  <code style={{ color: "var(--text-primary)", fontSize: "0.75rem", wordBreak: "break-all" }}>{localUrl}</code>
                  <span style={{ color: "var(--text-tertiary)" }}>·</span>
                  <code style={{ color: "var(--text-secondary)", fontSize: "0.7rem", wordBreak: "break-all" }}>{nipIoUrl}</code>
                </div>
                <button
                  type="button"
                  className="commit-hash-pill"
                  onClick={() => handleCopyUrl(localUrl, "local")}
                  title="Copy local ingress URL"
                  aria-label={copiedUrl === "local" ? "Copied local ingress URL" : "Copy local ingress URL"}
                  style={{ flexShrink: 0 }}
                >
                  <CopyIcon size={10} aria-hidden="true" />
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
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px", flexWrap: "wrap", minWidth: 0 }}>
              <ContainerIcon size={14} className="text-green" style={{ flexShrink: 0 }} />
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
