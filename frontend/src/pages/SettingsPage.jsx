import { useState } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import {
  GitHubIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeOffIcon,
  CheckIcon,
  ExternalLinkIcon,
} from "../components/common/TechIcons.jsx";

export default function SettingsPage() {
  const [displayName, setDisplayName] = useState("Anurag");
  const [email, setEmail] = useState("anurag@deployforge.dev");
  const [githubConnected, setGithubConnected] = useState(true);
  const [selectedProject, setSelectedProject] = useState("web-app");
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Environment variables state
  const [envVars, setEnvVars] = useState([
    { id: "1", key: "NODE_ENV", value: "production", updated: "2d ago", isSecret: false, show: true },
    { id: "2", key: "PORT", value: "3000", updated: "2d ago", isSecret: false, show: true },
    { id: "3", key: "DATABASE_URL", value: "postgres://user:secret@db.deployforge.internal:5432/app", updated: "5d ago", isSecret: true, show: false },
    { id: "4", key: "REDIS_URL", value: "redis://default:token@redis.deployforge.internal:6379", updated: "5d ago", isSecret: true, show: false },
  ]);

  const [isAddingVar, setIsAddingVar] = useState(false);
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarVal, setNewVarVal] = useState("");

  // Domains state
  const [domains, setDomains] = useState([
    { domain: "web-app.deployforge.app", status: "Active", isDefault: true },
  ]);
  const [newDomain, setNewDomain] = useState("");
  const [isAddingDomain, setIsAddingDomain] = useState(false);

  // Notifications
  const [notifyFailures, setNotifyFailures] = useState(true);
  const [notifyWeekly, setNotifyWeekly] = useState(false);

  const handleSaveProfile = (e) => {
    e.preventDefault();
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleAddVariable = (e) => {
    e.preventDefault();
    if (!newVarKey.trim()) return;
    setEnvVars([
      ...envVars,
      {
        id: Date.now().toString(),
        key: newVarKey.trim().toUpperCase(),
        value: newVarVal.trim(),
        updated: "Just now",
        isSecret: true,
        show: false,
      },
    ]);
    setNewVarKey("");
    setNewVarVal("");
    setIsAddingVar(false);
  };

  const handleDeleteVariable = (id) => {
    setEnvVars(envVars.filter((v) => v.id !== id));
  };

  const handleToggleSecret = (id) => {
    setEnvVars(
      envVars.map((v) => (v.id === id ? { ...v, show: !v.show } : v))
    );
  };

  const handleAddDomain = (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setDomains([
      ...domains,
      { domain: newDomain.trim().toLowerCase(), status: "Active", isDefault: false },
    ]);
    setNewDomain("");
    setIsAddingDomain(false);
  };

  return (
    <div className="settings-page reveal">
      {/* Page Heading */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Settings</h1>
          <p className="figma-page-subtitle">
            Manage your personal profile, encrypted environment variables, domains, and alert preferences.
          </p>
        </div>
      </div>

      <div className="settings-sections-list">
        {/* Section 1: Profile */}
        <section className="settings-section-card" aria-label="Profile settings">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Profile</h2>
            <p className="section-col-desc">
              Your personal workspace details and linked GitHub identity.
            </p>
          </div>

          <form onSubmit={handleSaveProfile} className="settings-form-col">
            <div className="avatar-config-row">
              <div className="avatar-preview-circle">
                <span>{displayName.charAt(0).toUpperCase()}</span>
              </div>
              <div className="avatar-actions-block">
                <strong className="avatar-name">{displayName}</strong>
                <span className="avatar-specs-note">Managed personal account</span>
              </div>
            </div>

            <div className="form-field-group">
              <label htmlFor="settings-name">Display Name</label>
              <input
                id="settings-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>

            <div className="form-field-group">
              <label htmlFor="settings-email">Email Address</label>
              <input
                id="settings-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="form-field-group">
              <label>Connected Accounts</label>
              <div className="linked-account-card">
                <div className="account-handle-wrap">
                  <GitHubIcon size={18} className="gh-icon-svg" />
                  <div>
                    <strong>GitHub</strong>
                    <span className="sub-handle">anuragksingh</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`btn-secondary btn-sm ${githubConnected ? "connected" : ""}`}
                  onClick={() => setGithubConnected(!githubConnected)}
                >
                  {githubConnected ? "Disconnect" : "Connect"}
                </button>
              </div>
            </div>

            <div className="save-action-row">
              {saveSuccess && (
                <span className="save-feedback-pill">
                  <CheckIcon size={12} />
                  <span>Settings saved</span>
                </span>
              )}
              <button type="submit" className="btn-primary">
                Save Changes
              </button>
            </div>
          </form>
        </section>

        {/* Section 2: Environment Variables */}
        <section className="settings-section-card" aria-label="Environment variables">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Environment Variables</h2>
            <p className="section-col-desc">
              Variables are encrypted at rest and injected into container instances at runtime.
            </p>
          </div>

          <div className="settings-form-col">
            <div className="env-toolbar-row">
              <select
                className="figma-select select-w-200"
                value={selectedProject}
                onChange={(e) => setSelectedProject(e.target.value)}
                aria-label="Select project for environment variables"
              >
                <option value="web-app">web-app</option>
                <option value="api-gateway">api-gateway</option>
                <option value="blog-engine">blog-engine</option>
                <option value="docs-portal">docs-portal</option>
              </select>

              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setIsAddingVar(!isAddingVar)}
              >
                <PlusIcon size={12} />
                <span>{isAddingVar ? "Close" : "Add Variable"}</span>
              </button>
            </div>

            {isAddingVar && (
              <form onSubmit={handleAddVariable} className="add-variable-drawer">
                <input
                  required
                  placeholder="KEY"
                  value={newVarKey}
                  onChange={(e) => setNewVarKey(e.target.value)}
                  className="add-var-key"
                />
                <input
                  required
                  placeholder="VALUE"
                  value={newVarVal}
                  onChange={(e) => setNewVarVal(e.target.value)}
                  className="add-var-val"
                />
                <div className="add-var-btns">
                  <button type="submit" className="btn-primary btn-sm">
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => setIsAddingVar(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="env-table-card">
              <div className="env-table-header">
                <span>Key</span>
                <span>Value</span>
                <span>Updated</span>
                <span>Actions</span>
              </div>
              <div className="env-table-body">
                {envVars.map((v) => (
                  <div key={v.id} className="env-table-row">
                    <div className="col-env-key">
                      <code>{v.key}</code>
                    </div>
                    <div className="col-env-val">
                      <span>{v.isSecret && !v.show ? "••••••••••••••••" : v.value}</span>
                      {v.isSecret && (
                        <button
                          type="button"
                          className="reveal-btn"
                          onClick={() => handleToggleSecret(v.id)}
                          aria-label={v.show ? "Mask value" : "Reveal value"}
                        >
                          {v.show ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                        </button>
                      )}
                    </div>
                    <div className="col-env-time">
                      <span>{v.updated}</span>
                    </div>
                    <div className="col-env-act">
                      <button
                        type="button"
                        className="tbl-action-btn delete"
                        onClick={() => handleDeleteVariable(v.id)}
                        aria-label={`Delete ${v.key}`}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: Custom Domains */}
        <section className="settings-section-card" aria-label="Custom domains">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Custom Domains</h2>
            <p className="section-col-desc">
              Point your domain to DeployForge using a CNAME record to route public traffic through Nginx.
            </p>
          </div>

          <div className="settings-form-col">
            <div className="domains-table-card">
              {domains.map((d) => (
                <div key={d.domain} className="domain-row-item">
                  <div className="domain-name-block">
                    <strong>{d.domain}</strong>
                    {d.isDefault && <span className="default-pill">Default</span>}
                  </div>
                  <div className="domain-badges">
                    <StatusBadge value={d.status} size="sm" />
                    <a
                      href={`https://${d.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="domain-ext-link"
                    >
                      <ExternalLinkIcon size={13} />
                    </a>
                  </div>
                </div>
              ))}
            </div>

            {isAddingDomain ? (
              <form onSubmit={handleAddDomain} className="add-domain-form">
                <input
                  required
                  placeholder="app.yourdomain.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                />
                <button type="submit" className="btn-primary btn-sm">
                  Add Domain
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setIsAddingDomain(false)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="btn-secondary btn-sm add-domain-trigger"
                onClick={() => setIsAddingDomain(true)}
              >
                <PlusIcon size={12} />
                <span>Add Custom Domain</span>
              </button>
            )}
          </div>
        </section>

        {/* Section 4: Notifications */}
        <section className="settings-section-card" aria-label="Notification preferences">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Notifications</h2>
            <p className="section-col-desc">
              Configure deployment and build failure alert thresholds.
            </p>
          </div>

          <div className="settings-form-col">
            <div className="notifications-list">
              <div className="toggle-setting-row">
                <div className="toggle-text">
                  <strong>Deployment failure alerts</strong>
                  <p>Send an immediate email whenever a build fails or health check fails.</p>
                </div>
                <label className="switch-toggle" aria-label="Toggle deployment failure alerts">
                  <input
                    type="checkbox"
                    checked={notifyFailures}
                    onChange={(e) => setNotifyFailures(e.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              <div className="toggle-setting-row">
                <div className="toggle-text">
                  <strong>Weekly digest</strong>
                  <p>A summary of release volume, container uptime, and performance metrics.</p>
                </div>
                <label className="switch-toggle" aria-label="Toggle weekly digest">
                  <input
                    type="checkbox"
                    checked={notifyWeekly}
                    onChange={(e) => setNotifyWeekly(e.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
