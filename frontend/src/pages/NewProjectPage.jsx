import { useState } from "react";
import { createProject } from "../services/projectService.js";
import {
  GitHubIcon,
  GitBranchIcon,
  NodeIcon,
  PythonIcon,
  GoIcon,
  DockerIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeOffIcon,
  CheckIcon,
  SpinnerIcon,
  ExternalLinkIcon,
} from "../components/common/TechIcons.jsx";

const runtimeOptions = [
  { id: "node", label: "Node.js", defaultPort: "3000", Icon: NodeIcon, desc: "Express, Fastify, Next.js, or Nest" },
  { id: "python", label: "Python", defaultPort: "8000", Icon: PythonIcon, desc: "FastAPI, Flask, or Django" },
  { id: "go", label: "Go", defaultPort: "8080", Icon: GoIcon, desc: "Gin, Fiber, or net/http" },
  { id: "docker", label: "Dockerfile", defaultPort: "3000", Icon: DockerIcon, desc: "Custom multi-stage container build" },
];

export default function NewProjectPage({ navigate }) {
  const [repoUrl, setRepoUrl] = useState("https://github.com/acme/web-app");
  const [projectName, setProjectName] = useState("web-app");
  const [branch, setBranch] = useState("main");
  const [selectedRuntime, setSelectedRuntime] = useState("node");
  const [port, setPort] = useState("3000");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deploySuccess, setDeploySuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const [envVars, setEnvVars] = useState([
    { id: "1", key: "NODE_ENV", value: "production", isSecret: false, show: true },
    { id: "2", key: "DATABASE_URL", value: "postgres://user:secret@db.deployforge.internal:5432/app", isSecret: true, show: false },
  ]);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const handleRuntimeSelect = (rt) => {
    setSelectedRuntime(rt.id);
    setPort(rt.defaultPort);
  };

  const handleAddEnv = (e) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    setEnvVars([
      ...envVars,
      {
        id: Date.now().toString(),
        key: newKey.trim().toUpperCase(),
        value: newVal.trim(),
        isSecret: false,
        show: true,
      },
    ]);
    setNewKey("");
    setNewVal("");
  };

  const handleToggleSecret = (id) => {
    setEnvVars(
      envVars.map((v) => (v.id === id ? { ...v, show: !v.show } : v))
    );
  };

  const handleRemoveEnv = (id) => {
    setEnvVars(envVars.filter((v) => v.id !== id));
  };

  const handleDeploy = async (e) => {
    e.preventDefault();
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
          Paste a public GitHub repository link. DeployForge builds, health-checks, and exposes it for you.
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
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/organization/repository"
                />
              </div>
              <span className="field-hint">Public repository. Private repos can be connected via GitHub App.</span>
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
                {runtimeOptions.map((rt) => {
                  const isSelected = selectedRuntime === rt.id;
                  const IconComp = rt.Icon;
                  return (
                    <div
                      key={rt.id}
                      className={`runtime-card-option ${isSelected ? "selected" : ""}`}
                      onClick={() => handleRuntimeSelect(rt)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="runtime-card-top">
                        <IconComp size={20} className="runtime-card-icon" />
                        {isSelected && <CheckIcon size={14} className="runtime-selected-check" />}
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
              <span className="field-hint">The port your HTTP server listens on inside the container.</span>
            </div>

            {/* Environment Variables Editor */}
            <div className="form-field-block">
              <div className="env-header-row">
                <label>Environment Variables</label>
                <span className="env-sub-note">Encrypted at rest · Injected on container launch</span>
              </div>

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
            </div>

            {/* Auto Deploy Toggle */}
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

            {/* Generated Domain Preview */}
            <div className="domain-preview-box">
              <span className="preview-label">Public Domain Preview:</span>
              <strong className="preview-url">https://{cleanSlug}.deployforge.app</strong>
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
                    <SpinnerIcon size={14} />
                    <span>Dispatching deployment...</span>
                  </>
                ) : deploySuccess ? (
                  <>
                    <CheckIcon size={14} />
                    <span>Deployed! Redirecting...</span>
                  </>
                ) : (
                  <span>Deploy Project →</span>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Right Guidance Sidebar */}
        <aside className="new-project-guide-card">
          <h2 className="guide-title">What happens next?</h2>
          <p className="guide-subtitle">
            DeployForge’s automated lifecycle handles build orchestration and container isolation:
          </p>

          <ol className="guide-steps-list">
            <li className="guide-step-item">
              <span className="step-bullet">1</span>
              <div>
                <strong>Clone repository</strong>
                <p>The C++ worker shallow-clones the <code>{branch}</code> branch from GitHub.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">2</span>
              <div>
                <strong>Dockerfile detection & build</strong>
                <p>Constructs an optimized container layer with cached dependencies.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">3</span>
              <div>
                <strong>Container instantiation</strong>
                <p>Docker Engine spawns the isolated container with resource bounds.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">4</span>
              <div>
                <strong>Health probe on port :{port}</strong>
                <p>Runs internal HTTP verification before switching active traffic.</p>
              </div>
            </li>
            <li className="guide-step-item">
              <span className="step-bullet">5</span>
              <div>
                <strong>Nginx upstream promotion</strong>
                <p>Binds the public route and issues zero-downtime routing with SSL.</p>
              </div>
            </li>
          </ol>

          <div className="guide-tip-box">
            <strong>Architecture Note</strong>
            <p>
              Your deployment request is recorded in PostgreSQL and dispatched through Redis Streams
              directly to an isolated worker thread.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
