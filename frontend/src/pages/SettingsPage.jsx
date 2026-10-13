import { useState, useEffect } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import { fetchProjects } from "../services/projectService.js";
import { getCurrentUser } from "../services/authService.js";
import { fetchEnvVars, saveEnvVars, deleteEnvVar } from "../services/envService.js";
import {
  GitHubIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeOffIcon,
  CheckIcon,
  ExternalLinkIcon,
  SpinnerIcon,
} from "../components/common/TechIcons.jsx";

function timeAgo(dateString) {
  if (!dateString) return "just now";
  const past = new Date(dateString);
  if (Number.isNaN(past.getTime())) return "just now";
  const diffSec = Math.max(0, Math.floor((Date.now() - past.getTime()) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export default function SettingsPage() {
  const [displayName, setDisplayName] = useState("Developer");
  const [email, setEmail] = useState("developer@deployforge.dev");
  const [githubConnected, setGithubConnected] = useState(true);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [envLoading, setEnvLoading] = useState(false);

  // Environment variables state
  const [envVars, setEnvVars] = useState([]);
  const [isAddingVar, setIsAddingVar] = useState(false);
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarVal, setNewVarVal] = useState("");
  const [isNewSecret, setIsNewSecret] = useState(true);
  const [revealedIds, setRevealedIds] = useState(new Set());
  const [unmaskedValues, setUnmaskedValues] = useState({});

  // Domains state
  const [domains, setDomains] = useState([
    { domain: "web-app.deployforge.app", status: "Active", isDefault: true },
  ]);
  const [newDomain, setNewDomain] = useState("");
  const [isAddingDomain, setIsAddingDomain] = useState(false);

  // Notifications
  const [notifyFailures, setNotifyFailures] = useState(true);
  const [notifyWeekly, setNotifyWeekly] = useState(false);

  // 1. Load user profile & projects
  useEffect(() => {
    getCurrentUser()
      .then((user) => {
        if (user) {
          setDisplayName(user.user_name || "Developer");
          setEmail(user.email || "developer@deployforge.dev");
        }
      })
      .catch(() => {});

    fetchProjects()
      .then((data) => {
        setProjects(data);
        if (data.length > 0) {
          setSelectedProjectId(data[0].id);
        }
      })
      .catch((err) => console.warn("Failed to load projects:", err));
  }, []);

  // 2. Load environment variables for selected project
  useEffect(() => {
    if (!selectedProjectId) return;
    setEnvLoading(true);
    fetchEnvVars(selectedProjectId)
      .then((vars) => {
        setEnvVars(vars);
      })
      .catch((err) => console.warn("Could not load env vars:", err.message))
      .finally(() => setEnvLoading(false));
  }, [selectedProjectId]);

  const handleSaveProfile = (e) => {
    e.preventDefault();
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleAddVariable = async (e) => {
    e.preventDefault();
    if (!newVarKey.trim() || !selectedProjectId) return;

    try {
      await saveEnvVars(selectedProjectId, [
        {
          key: newVarKey.trim().toUpperCase(),
          value: newVarVal.trim(),
          is_secret: isNewSecret,
        },
      ]);
      const updated = await fetchEnvVars(selectedProjectId);
      setEnvVars(updated);
      setNewVarKey("");
      setNewVarVal("");
      setIsAddingVar(false);
    } catch (err) {
      alert(`Could not save secret: ${err.message}`);
    }
  };

  const handleDeleteVariable = async (key, id) => {
    if (!selectedProjectId) return;
    try {
      await deleteEnvVar(selectedProjectId, key || id);
      setEnvVars((prev) => prev.filter((v) => (v.key !== key && v.id !== id)));
    } catch (err) {
      alert(`Failed to delete variable: ${err.message}`);
    }
  };

  const handleToggleSecret = async (id, key) => {
    const nextRevealed = new Set(revealedIds);
    if (nextRevealed.has(id)) {
      nextRevealed.delete(id);
      setRevealedIds(nextRevealed);
    } else {
      nextRevealed.add(id);
      setRevealedIds(nextRevealed);
      // Fetch decrypted value if not yet cached
      if (!unmaskedValues[id] && selectedProjectId) {
        try {
          const revealedList = await fetchEnvVars(selectedProjectId, { reveal: true });
          const match = revealedList.find((v) => v.id === id || v.key === key);
          if (match) {
            setUnmaskedValues((prev) => ({ ...prev, [id]: match.value }));
          }
        } catch (err) {
          console.warn("Could not decrypt secret:", err.message);
        }
      }
    }
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

  const activeProject = projects.find((p) => p.id === selectedProjectId);

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

      <div className="settings-sections-stack">
        {/* Section 1: User Profile & Connected Accounts */}
        <section className="settings-section-card" aria-label="Profile settings">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Personal Profile</h2>
            <p className="section-col-desc">
              Your name and email address for platform notifications and team access.
            </p>
          </div>

          <form onSubmit={handleSaveProfile} className="settings-form-col">
            <div className="form-group-block">
              <label htmlFor="display-name">Full name</label>
              <input
                id="display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="figma-text-input"
                required
              />
            </div>

            <div className="form-group-block">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="figma-text-input"
                required
              />
            </div>

            <div className="connected-accounts-block">
              <h3 className="sub-section-title">Connected Accounts</h3>
              <div className="account-row-item">
                <div className="acct-brand">
                  <GitHubIcon size={18} className="octo-svg" />
                  <div>
                    <strong className="acct-name">GitHub Integration</strong>
                    <span className="sub-handle">Connected for automated continuous deployment</span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`btn-secondary btn-sm ${githubConnected ? "connected" : ""}`}
                  onClick={() => setGithubConnected(!githubConnected)}
                >
                  {githubConnected ? "Connected" : "Connect"}
                </button>
              </div>
            </div>

            <div className="save-action-row">
              {saveSuccess && (
                <span className="save-feedback-pill">
                  <CheckIcon size={12} />
                  <span>Profile updated</span>
                </span>
              )}
              <button type="submit" className="btn-primary">
                Save Changes
              </button>
            </div>
          </form>
        </section>

        {/* Section 2: Environment Variables (AES-256 Encrypted Secrets Vault) */}
        <section className="settings-section-card" aria-label="Environment variables">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Environment Variables</h2>
            <p className="section-col-desc">
              Variables are encrypted at rest with AES-256-GCM and injected into container instances at launch.
            </p>
          </div>

          <div className="settings-form-col">
            <div className="env-toolbar-row">
              <select
                className="figma-select select-w-200"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                aria-label="Select project for environment variables"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setIsAddingVar(!isAddingVar)}
              >
                <PlusIcon size={12} />
                <span>{isAddingVar ? "Close" : "Add Secret"}</span>
              </button>
            </div>

            {isAddingVar && (
              <form onSubmit={handleAddVariable} className="add-variable-drawer">
                <input
                  required
                  placeholder="KEY (e.g. DATABASE_URL)"
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
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <label style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "4px" }}>
                    <input
                      type="checkbox"
                      checked={isNewSecret}
                      onChange={(e) => setIsNewSecret(e.target.checked)}
                    />
                    <span>Encrypt as secret</span>
                  </label>
                </div>
                <div className="add-var-btns">
                  <button type="submit" className="btn-primary btn-sm">
                    Save to Vault
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
                {envLoading ? (
                  <div className="table-empty-row">
                    <SpinnerIcon size={16} className="spin" />
                    <span>Loading vault variables...</span>
                  </div>
                ) : envVars.length > 0 ? (
                  envVars.map((v) => {
                    const isRevealed = revealedIds.has(v.id);
                    const displayValue = isRevealed
                      ? unmaskedValues[v.id] || v.value
                      : v.is_secret || v.isSecret
                      ? "••••••••••••••••"
                      : v.value;

                    return (
                      <div key={v.id || v.key} className="env-table-row">
                        <div className="col-env-key">
                          <code>{v.key}</code>
                        </div>
                        <div className="col-env-val">
                          <span>{displayValue}</span>
                          {(v.is_secret || v.isSecret) && (
                            <button
                              type="button"
                              className="reveal-btn"
                              onClick={() => handleToggleSecret(v.id, v.key)}
                              aria-label={isRevealed ? "Mask value" : "Reveal value"}
                            >
                              {isRevealed ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                            </button>
                          )}
                        </div>
                        <div className="col-env-time">
                          <span>{timeAgo(v.updated_at || v.created_at)}</span>
                        </div>
                        <div className="col-env-act">
                          <button
                            type="button"
                            className="tbl-action-btn delete"
                            onClick={() => handleDeleteVariable(v.key, v.id)}
                            aria-label={`Delete ${v.key}`}
                            title="Delete secret"
                          >
                            <TrashIcon size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="table-empty-row">
                    <p>No environment variables saved for {activeProject?.name || "this project"}.</p>
                  </div>
                )}
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
                    <strong className="domain-txt">{d.domain}</strong>
                    {d.isDefault && <span className="default-pill">System Default</span>}
                  </div>
                  <div className="domain-status-block">
                    <StatusBadge value={d.status} size="sm" />
                    <a
                      href={`https://${d.domain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="tbl-action-btn"
                      aria-label={`Open https://${d.domain}`}
                    >
                      <ExternalLinkIcon size={13} />
                    </a>
                  </div>
                </div>
              ))}
            </div>

            {isAddingDomain ? (
              <form onSubmit={handleAddDomain} className="add-domain-inline-form">
                <input
                  required
                  placeholder="app.yourdomain.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="figma-text-input"
                />
                <div className="add-domain-btns">
                  <button type="submit" className="btn-primary btn-sm">
                    Add CNAME
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => setIsAddingDomain(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn-secondary btn-sm add-domain-btn"
                onClick={() => setIsAddingDomain(true)}
              >
                <PlusIcon size={13} />
                <span>Add Domain</span>
              </button>
            )}
          </div>
        </section>

        {/* Section 4: Notifications & Alert Preferences */}
        <section className="settings-section-card" aria-label="Notification settings">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Alert Preferences</h2>
            <p className="section-col-desc">
              Decide when DeployForge sends build alerts and weekly summary metrics to your email.
            </p>
          </div>

          <div className="settings-form-col">
            <div className="notify-toggle-row">
              <div className="toggle-info">
                <strong>Deployment failure alerts</strong>
                <p>Send an immediate email alert if a container build fails or health check fails.</p>
              </div>
              <label className="switch-toggle" aria-label="Toggle failure alerts">
                <input
                  type="checkbox"
                  checked={notifyFailures}
                  onChange={(e) => setNotifyFailures(e.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>

            <div className="notify-toggle-row">
              <div className="toggle-info">
                <strong>Weekly digest report</strong>
                <p>Receive weekly summary reports of total deployments, uptime, and request bandwidth.</p>
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
        </section>
      </div>
    </div>
  );
}
