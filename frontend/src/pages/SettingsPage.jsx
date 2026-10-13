import { useState, useEffect } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import { fetchProjects } from "../services/projectService.js";
import { fetchEnvVars, saveEnvVars, deleteEnvVar } from "../services/envService.js";
import {
  fetchSettings,
  updateProfile,
  updatePassword,
  updateNotificationPreferences,
  addDomain as apiAddDomain,
  deleteDomain as apiDeleteDomain,
} from "../services/settingsService.js";
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
  const [githubConnected, setGithubConnected] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [envLoading, setEnvLoading] = useState(false);

  // Password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");

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
  const [domainError, setDomainError] = useState("");
  const [domainLoading, setDomainLoading] = useState(false);

  // Notifications
  const [notifyFailures, setNotifyFailures] = useState(true);
  const [notifyWeekly, setNotifyWeekly] = useState(false);

  // 1. Load user profile, settings & projects
  useEffect(() => {
    fetchSettings()
      .then((data) => {
        if (data.user) {
          setDisplayName(data.user.user_name || "Developer");
          setEmail(data.user.email || "developer@deployforge.dev");
          setGithubConnected(Boolean(data.user.github_connected));
          if (data.user.notification_preferences) {
            setNotifyFailures(Boolean(data.user.notification_preferences.notify_failures));
            setNotifyWeekly(Boolean(data.user.notification_preferences.notify_weekly));
          }
        }
        if (data.domains && data.domains.length > 0) {
          setDomains(data.domains);
        }
      })
      .catch((err) => console.warn("Failed to load settings:", err));

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

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setProfileError("");
    setProfileSaving(true);
    try {
      await updateProfile({
        name: displayName,
        email,
        github_connected: githubConnected,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setProfileError(err.message || "Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleToggleGithub = async () => {
    const nextState = !githubConnected;
    setGithubConnected(nextState);
    try {
      await updateProfile({ github_connected: nextState });
    } catch (err) {
      setGithubConnected(!nextState);
      alert(`Could not update GitHub connection: ${err.message}`);
    }
  };

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess(false);

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters long.");
      return;
    }

    setPasswordLoading(true);
    try {
      await updatePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setTimeout(() => setPasswordSuccess(false), 3000);
    } catch (err) {
      setPasswordError(err.message || "Failed to update password");
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleToggleFailureAlerts = async (checked) => {
    setNotifyFailures(checked);
    try {
      await updateNotificationPreferences({ notify_failures: checked, notify_weekly: notifyWeekly });
    } catch (err) {
      console.warn("Could not save alert preferences:", err);
    }
  };

  const handleToggleWeeklyAlerts = async (checked) => {
    setNotifyWeekly(checked);
    try {
      await updateNotificationPreferences({ notify_failures: notifyFailures, notify_weekly: checked });
    } catch (err) {
      console.warn("Could not save alert preferences:", err);
    }
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
      setEnvVars((prev) => prev.filter((v) => v.key !== key && v.id !== id));
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

  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setDomainError("");
    setDomainLoading(true);
    try {
      const added = await apiAddDomain(newDomain.trim().toLowerCase(), selectedProjectId || null);
      setDomains((prev) => [...prev, added]);
      setNewDomain("");
      setIsAddingDomain(false);
    } catch (err) {
      setDomainError(err.message || "Failed to add domain");
    } finally {
      setDomainLoading(false);
    }
  };

  const handleDeleteDomain = async (domainId, domainName) => {
    try {
      await apiDeleteDomain(domainId || domainName);
      setDomains((prev) => prev.filter((d) => d.id !== domainId && d.domain !== domainName));
    } catch (err) {
      alert(`Could not remove domain: ${err.message}`);
    }
  };

  const activeProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="settings-page reveal">
      {/* Page Heading */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Settings</h1>
          <p className="figma-page-subtitle">
            Manage your personal profile, account security, encrypted environment variables, domains, and alert preferences.
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
            {profileError && (
              <div style={{ color: "#ef4444", fontSize: "13px", marginBottom: "0.75rem" }}>
                {profileError}
              </div>
            )}

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
                  onClick={handleToggleGithub}
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
              <button type="submit" className="btn-primary" disabled={profileSaving}>
                {profileSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>
        </section>

        {/* Section 2: Account Security & Password */}
        <section className="settings-section-card" aria-label="Account security">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Account Security</h2>
            <p className="section-col-desc">
              Update your account password to keep your workspaces and deployments protected.
            </p>
          </div>

          <form onSubmit={handleUpdatePassword} className="settings-form-col">
            {passwordError && (
              <div style={{ color: "#ef4444", fontSize: "13px", marginBottom: "0.75rem" }}>
                {passwordError}
              </div>
            )}

            <div className="form-group-block">
              <label htmlFor="current-pass">Current password</label>
              <input
                id="current-pass"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="figma-text-input"
                required
                placeholder="••••••••••••"
              />
            </div>

            <div className="form-group-block">
              <label htmlFor="new-pass">New password (minimum 8 characters)</label>
              <input
                id="new-pass"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="figma-text-input"
                required
                minLength={8}
                placeholder="••••••••••••"
              />
            </div>

            <div className="save-action-row">
              {passwordSuccess && (
                <span className="save-feedback-pill">
                  <CheckIcon size={12} />
                  <span>Password updated successfully</span>
                </span>
              )}
              <button type="submit" className="btn-primary" disabled={passwordLoading}>
                {passwordLoading ? "Updating..." : "Update Password"}
              </button>
            </div>
          </form>
        </section>

        {/* Section 3: Environment Variables (AES-256 Encrypted Secrets Vault) */}
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

        {/* Section 4: Custom Domains */}
        <section className="settings-section-card" aria-label="Custom domains">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Custom Domains</h2>
            <p className="section-col-desc">
              Point your domain to DeployForge using a CNAME record to route public traffic through Nginx.
            </p>
          </div>

          <div className="settings-form-col">
            {domainError && (
              <div style={{ color: "#ef4444", fontSize: "13px", marginBottom: "0.75rem" }}>
                {domainError}
              </div>
            )}

            <div className="domains-table-card">
              {domains.map((d) => (
                <div key={d.id || d.domain} className="domain-row-item">
                  <div className="domain-name-block">
                    <strong className="domain-txt">{d.domain}</strong>
                    {d.is_default || d.isDefault ? (
                      <span className="default-pill">System Default</span>
                    ) : null}
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
                    {!(d.is_default || d.isDefault) && (
                      <button
                        type="button"
                        className="tbl-action-btn delete"
                        onClick={() => handleDeleteDomain(d.id, d.domain)}
                        aria-label={`Remove domain ${d.domain}`}
                        title="Remove domain"
                      >
                        <TrashIcon size={13} />
                      </button>
                    )}
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
                  <button type="submit" className="btn-primary btn-sm" disabled={domainLoading}>
                    {domainLoading ? "Adding..." : "Add CNAME"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setIsAddingDomain(false);
                      setDomainError("");
                    }}
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

        {/* Section 5: Notifications & Alert Preferences */}
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
                  onChange={(e) => handleToggleFailureAlerts(e.target.checked)}
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
                  onChange={(e) => handleToggleWeeklyAlerts(e.target.checked)}
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
