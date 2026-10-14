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
  validateGitHubProfile,
  verifyGitHubProfileExists,
} from "../services/settingsService.js";
import {
  GitHubIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  EyeOffIcon,
  CheckIcon,
  CloseIcon,
  ExternalLinkIcon,
  SpinnerIcon,
  CopyIcon,
  ContainerIcon,
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

const USERNAME_REGEX = /^[a-zA-Z0-9_\-\s]{2,50}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

function parseEnvString(rawText) {
  const lines = rawText.split("\n");
  const parsed = [];
  const errors = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      errors.push(`Line ${index + 1}: Missing "=" separator between key and value.`);
      return;
    }
    const key = trimmed.slice(0, eqIdx).trim().toUpperCase();
    if (!ENV_KEY_REGEX.test(key)) {
      errors.push(`Line ${index + 1}: Invalid variable key "${key}". Must contain only uppercase letters, numbers, and underscores.`);
      return;
    }
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val.length > 10000) {
      errors.push(`Line ${index + 1}: Value for "${key}" exceeds 10,000 characters limit.`);
      return;
    }
    const isSecret = /SECRET|KEY|PASSWORD|PASS|TOKEN|CREDENTIAL|PRIVATE/i.test(key);
    parsed.push({
      key,
      value: val,
      isSecret,
      is_secret: isSecret,
    });
  });

  return { parsed, errors };
}

export default function SettingsPage() {
  // Personal Profile
  const [displayName, setDisplayName] = useState("Developer");
  const [email, setEmail] = useState("developer@deployforge.dev");
  const [profilePassword, setProfilePassword] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileSuccess, setProfileSuccess] = useState(false);

  // GitHub Account Linking
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubUsername, setGithubUsername] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [githubLinking, setGithubLinking] = useState(false);
  const [githubError, setGithubError] = useState("");
  const [githubSuccess, setGithubSuccess] = useState("");
  const [isLinkingGithub, setIsLinkingGithub] = useState(false);

  // Password Rotation
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");

  // Projects & Env Vars
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [envLoading, setEnvLoading] = useState(false);
  const [envVars, setEnvVars] = useState([]);
  const [isAddingVar, setIsAddingVar] = useState(false);
  const [isBulkImporting, setIsBulkImporting] = useState(false);
  const [bulkImportText, setBulkImportText] = useState("");
  const [bulkImportErrors, setBulkImportErrors] = useState([]);
  const [bulkImportSuccess, setBulkImportSuccess] = useState(false);
  const [exportedCopied, setExportedCopied] = useState(false);
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarVal, setNewVarVal] = useState("");
  const [varKeyError, setVarKeyError] = useState("");
  const [isNewSecret, setIsNewSecret] = useState(true);
  const [revealedIds, setRevealedIds] = useState(new Set());
  const [unmaskedValues, setUnmaskedValues] = useState({});

  // Domains
  const [domains, setDomains] = useState([
    { domain: "web-app.deployforge.app", status: "Active", isDefault: true },
  ]);
  const [newDomain, setNewDomain] = useState("");
  const [isAddingDomain, setIsAddingDomain] = useState(false);
  const [showDnsGuide, setShowDnsGuide] = useState(true);
  const [domainError, setDomainError] = useState("");
  const [domainLoading, setDomainLoading] = useState(false);

  // Notifications
  const [notifyFailures, setNotifyFailures] = useState(true);
  const [notifyWeekly, setNotifyWeekly] = useState(false);

  // 1. Load user profile, settings & projects on mount
  useEffect(() => {
    fetchSettings()
      .then((data) => {
        if (data.user) {
          setDisplayName(data.user.user_name || "Developer");
          setEmail(data.user.email || "developer@deployforge.dev");
          setGithubConnected(Boolean(data.user.github_connected));
          setGithubUsername(data.user.github_username || "");
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

  // 2. Load environment variables when project changes
  useEffect(() => {
    if (!selectedProjectId) {
      setEnvVars([]);
      return;
    }

    setEnvLoading(true);
    setRevealedIds(new Set());
    setUnmaskedValues({});

    fetchEnvVars(selectedProjectId)
      .then((vars) => {
        setEnvVars(vars);
      })
      .catch((err) => {
        console.warn("Could not load env vars:", err.message);
      })
      .finally(() => {
        setEnvLoading(false);
      });
  }, [selectedProjectId]);

  // Handle Profile Update with Password Verification & Constraints
  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    setProfileError("");
    setProfileSuccess(false);

    const cleanName = displayName.trim();
    const cleanEmail = email.trim().toLowerCase();

    // Constraint: Name length and characters
    if (cleanName.length < 2 || cleanName.length > 50) {
      setProfileError("Full name / username must be between 2 and 50 characters long.");
      return;
    }
    if (!USERNAME_REGEX.test(cleanName)) {
      setProfileError("Username may only contain letters, numbers, spaces, hyphens, and underscores.");
      return;
    }

    // Constraint: Email format
    if (!EMAIL_REGEX.test(cleanEmail)) {
      setProfileError("Please enter a valid email address (e.g. user@domain.com).");
      return;
    }

    // Constraint: Password Verification Required
    if (!profilePassword) {
      setProfileError("Current password is required to verify your identity before saving profile changes.");
      return;
    }

    setProfileSaving(true);
    try {
      await updateProfile({
        name: cleanName,
        email: cleanEmail,
        current_password: profilePassword,
      });
      setProfileSuccess(true);
      setProfilePassword("");
      setTimeout(() => setProfileSuccess(false), 3000);
    } catch (err) {
      setProfileError(err.message || "Could not update profile. Please verify your current password.");
    } finally {
      setProfileSaving(false);
    }
  };

  // Handle GitHub Profile Linking with Verification
  const handleLinkGitHub = async (e) => {
    e.preventDefault();
    setGithubError("");
    setGithubSuccess("");

    if (!githubInput.trim()) {
      setGithubError("Please enter a GitHub profile link or username.");
      return;
    }

    // Validate format
    const validation = validateGitHubProfile(githubInput);
    if (!validation.valid) {
      setGithubError(validation.error);
      return;
    }

    setGithubLinking(true);
    try {
      // Verify with GitHub public API
      const check = await verifyGitHubProfileExists(validation.username);
      if (!check.exists) {
        setGithubError(check.error || "GitHub account could not be found.");
        setGithubLinking(false);
        return;
      }

      // Persist to backend
      await updateProfile({
        github_connected: true,
        github_username: validation.username,
      });

      setGithubConnected(true);
      setGithubUsername(validation.username);
      setGithubInput("");
      setIsLinkingGithub(false);
      setGithubSuccess(`GitHub profile @${validation.username} linked successfully!`);
      setTimeout(() => setGithubSuccess(""), 4000);
    } catch (err) {
      setGithubError(err.message || "Failed to link GitHub profile.");
    } finally {
      setGithubLinking(false);
    }
  };

  const handleDisconnectGitHub = async () => {
    if (!window.confirm("Are you sure you want to disconnect your GitHub profile?")) {
      return;
    }
    setGithubError("");
    setGithubSuccess("");
    try {
      await updateProfile({
        github_connected: false,
        github_username: null,
      });
      setGithubConnected(false);
      setGithubUsername("");
      setGithubSuccess("GitHub profile disconnected.");
      setTimeout(() => setGithubSuccess(""), 3000);
    } catch (err) {
      setGithubError(err.message || "Failed to disconnect GitHub profile.");
    }
  };

  // Handle Password Update with Constraints
  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess(false);

    if (!currentPassword) {
      setPasswordError("Please enter your current password.");
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters long.");
      return;
    }

    if (newPassword.length > 128) {
      setPasswordError("New password cannot exceed 128 characters.");
      return;
    }

    // Constraint: at least one letter and at least one number
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setPasswordError("New password must contain at least one letter and at least one number.");
      return;
    }

    if (newPassword === currentPassword) {
      setPasswordError("New password must be different from your current password.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }

    setPasswordLoading(true);
    try {
      await updatePassword({ current_password: currentPassword, new_password: newPassword });
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordSuccess(false), 3000);
    } catch (err) {
      setPasswordError(err.message || "Failed to update password.");
    } finally {
      setPasswordLoading(false);
    }
  };

  // Notification Preferences
  const handleToggleFailureAlerts = async (checked) => {
    setNotifyFailures(checked);
    try {
      await updateNotificationPreferences({
        notify_failures: checked,
        notify_weekly: notifyWeekly,
      });
    } catch (err) {
      console.warn("Failed to update notification prefs:", err.message);
    }
  };

  const handleToggleWeeklyAlerts = async (checked) => {
    setNotifyWeekly(checked);
    try {
      await updateNotificationPreferences({
        notify_failures: notifyFailures,
        notify_weekly: checked,
      });
    } catch (err) {
      console.warn("Failed to update notification prefs:", err.message);
    }
  };

  // Secret Masking & Unmasking
  const handleToggleSecret = async (id, key) => {
    const nextRevealed = new Set(revealedIds);
    if (nextRevealed.has(id)) {
      nextRevealed.delete(id);
      setRevealedIds(nextRevealed);
    } else {
      if (!unmaskedValues[id]) {
        try {
          const revealedList = await fetchEnvVars(selectedProjectId, { reveal: true });
          const matched = revealedList.find((v) => v.id === id || v.key === key);
          if (matched) {
            setUnmaskedValues((prev) => ({ ...prev, [id]: matched.value }));
          }
        } catch (err) {
          console.warn("Could not unmask secret:", err);
        }
      }
      nextRevealed.add(id);
      setRevealedIds(nextRevealed);
    }
  };

  const handleToggleRevealAll = async () => {
    if (revealedIds.size > 0) {
      setRevealedIds(new Set());
    } else {
      try {
        const revealedList = await fetchEnvVars(selectedProjectId, { reveal: true });
        const map = {};
        const allIds = new Set();
        revealedList.forEach((v) => {
          map[v.id] = v.value;
          allIds.add(v.id);
        });
        setUnmaskedValues(map);
        setRevealedIds(allIds);
      } catch (err) {
        console.warn("Could not reveal all secrets:", err);
      }
    }
  };

  // Add Variable with Constraints
  const handleAddVariable = async (e) => {
    e.preventDefault();
    setVarKeyError("");

    if (!selectedProjectId) {
      alert("Please select a project first.");
      return;
    }

    const cleanKey = newVarKey.trim().toUpperCase();
    if (!ENV_KEY_REGEX.test(cleanKey)) {
      setVarKeyError("Key must start with a letter/underscore and contain only uppercase letters, numbers, and underscores (e.g., API_KEY).");
      return;
    }

    if (cleanKey.length > 100) {
      setVarKeyError("Variable key cannot exceed 100 characters.");
      return;
    }

    if (newVarVal.length > 10000) {
      alert("Variable value cannot exceed 10,000 characters.");
      return;
    }

    // Check if key already exists
    const exists = envVars.some((v) => v.key === cleanKey);
    if (exists && !window.confirm(`Variable "${cleanKey}" already exists. Do you want to overwrite it?`)) {
      return;
    }

    const updated = [
      ...envVars.filter((v) => v.key !== cleanKey),
      {
        key: cleanKey,
        value: newVarVal,
        isSecret: isNewSecret,
      },
    ];

    try {
      const saved = await saveEnvVars(selectedProjectId, updated);
      setEnvVars(saved);
      setNewVarKey("");
      setNewVarVal("");
      setIsAddingVar(false);
    } catch (err) {
      alert(`Failed to save variable: ${err.message}`);
    }
  };

  // Bulk Import with Constraints
  const handleBulkImport = async (e) => {
    e.preventDefault();
    setBulkImportErrors([]);

    if (!selectedProjectId) {
      alert("Please select a project first.");
      return;
    }

    if (!bulkImportText.trim()) {
      setBulkImportErrors(["Please paste at least one KEY=VALUE line."]);
      return;
    }

    const { parsed, errors } = parseEnvString(bulkImportText);
    if (errors.length > 0) {
      setBulkImportErrors(errors);
      return;
    }

    if (parsed.length === 0) {
      setBulkImportErrors(["No valid KEY=VALUE pairs found."]);
      return;
    }

    const existingKeys = new Set(parsed.map((p) => p.key));
    const merged = [
      ...envVars.filter((v) => !existingKeys.has(v.key)),
      ...parsed,
    ];

    try {
      const saved = await saveEnvVars(selectedProjectId, merged);
      setEnvVars(saved);
      setBulkImportText("");
      setBulkImportSuccess(true);
      setTimeout(() => {
        setBulkImportSuccess(false);
        setIsBulkImporting(false);
      }, 1500);
    } catch (err) {
      setBulkImportErrors([err.message || "Bulk import failed."]);
    }
  };

  const handleExportEnv = () => {
    if (envVars.length === 0) return;
    const content = envVars
      .map((v) => `${v.key}=${unmaskedValues[v.id] || v.value || ""}`)
      .join("\n");
    navigator.clipboard?.writeText(content);
    setExportedCopied(true);
    setTimeout(() => setExportedCopied(false), 2000);
  };

  const handleDeleteVariable = async (key, id) => {
    if (!window.confirm(`Are you sure you want to delete secret "${key}"?`)) return;
    try {
      await deleteEnvVar(selectedProjectId, key || id);
      setEnvVars((prev) => prev.filter((v) => v.key !== key && v.id !== id));
    } catch (err) {
      alert(`Failed to delete variable: ${err.message}`);
    }
  };

  // Add Domain with Constraints
  const handleAddDomain = async (e) => {
    e.preventDefault();
    setDomainError("");

    let cleanDomain = newDomain.trim().toLowerCase();
    // Strip protocol and path if entered
    cleanDomain = cleanDomain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim();

    if (!DOMAIN_REGEX.test(cleanDomain)) {
      setDomainError("Please enter a valid domain name (e.g. app.yourdomain.com or mycompany.io). Protocol and paths must be omitted.");
      return;
    }

    if (cleanDomain.length > 253) {
      setDomainError("Domain name cannot exceed 253 characters.");
      return;
    }

    if (cleanDomain.includes("localhost") || cleanDomain.startsWith("127.")) {
      setDomainError("Localhost and loopback addresses cannot be registered as public custom domains.");
      return;
    }

    setDomainLoading(true);
    try {
      const added = await apiAddDomain(cleanDomain, selectedProjectId || null);
      setDomains((prev) => [...prev, added]);
      setNewDomain("");
      setIsAddingDomain(false);
    } catch (err) {
      setDomainError(err.message || "Failed to register custom domain.");
    } finally {
      setDomainLoading(false);
    }
  };

  const handleDeleteDomain = async (id, name) => {
    if (!window.confirm(`Delete custom domain "${name}"?`)) return;
    try {
      await apiDeleteDomain(id || name);
      setDomains((prev) => prev.filter((d) => d.id !== id && d.domain !== name));
    } catch (err) {
      alert(`Failed to delete domain: ${err.message}`);
    }
  };

  const activeProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="settings-page reveal">
      {/* Page Heading */}
      <div className="figma-page-header">
        <div>
          <h1 className="figma-page-title">Workspace Settings</h1>
          <p className="figma-page-subtitle">
            Configure profile credentials, environment secrets, custom domains, and platform telemetry.
          </p>
        </div>
      </div>

      <div className="settings-sections-list">
        {/* Section 1: User Profile & Identity */}
        <section className="settings-section-card" aria-label="Profile settings">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Personal Profile</h2>
            <p className="section-col-desc">
              Your name and primary notification email address. Password verification is required to authorize changes.
            </p>
          </div>

          <form onSubmit={handleUpdateProfile} className="settings-form-col">
            {profileError && (
              <div className="auth-message-block error" style={{ marginBottom: "1rem" }}>
                <CloseIcon size={13} />
                <span>{profileError}</span>
              </div>
            )}

            {profileSuccess && (
              <div className="auth-message-block success" style={{ marginBottom: "1rem" }}>
                <CheckIcon size={13} />
                <span>Profile updated successfully.</span>
              </div>
            )}

            <div className="form-group-block">
              <label htmlFor="display-name">Full name / Username</label>
              <input
                id="display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="figma-text-input"
                required
                minLength={2}
                maxLength={50}
                placeholder="e.g. Jane Doe"
              />
              <span className="field-constraint-hint">2-50 characters (letters, numbers, hyphens, and underscores)</span>
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
                placeholder="developer@deployforge.dev"
              />
              <span className="field-constraint-hint">Used for deployment notifications and digest reports</span>
            </div>

            {/* Password Verification to authorize username/email change */}
            <div className="form-group-block" style={{ marginTop: "16px", padding: "14px", background: "#111114", border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)" }}>
              <label htmlFor="verify-pass" style={{ color: "#ffffff", fontWeight: "600" }}>
                Current password to authorize changes
              </label>
              <input
                id="verify-pass"
                type="password"
                required
                value={profilePassword}
                onChange={(e) => setProfilePassword(e.target.value)}
                className="figma-text-input"
                placeholder="Enter current password to verify identity"
                style={{ marginTop: "6px" }}
              />
              <span className="field-constraint-hint">Your password is required to confirm username or email modifications.</span>
            </div>

            {/* Connected Accounts: GitHub Profile Linking */}
            <div className="connected-accounts-block" style={{ marginTop: "20px" }}>
              <h3 className="sub-section-title">Connected Accounts</h3>

              {githubError && (
                <div className="auth-message-block error" style={{ margin: "8px 0" }}>
                  <CloseIcon size={12} />
                  <span>{githubError}</span>
                </div>
              )}

              {githubSuccess && (
                <div className="auth-message-block success" style={{ margin: "8px 0" }}>
                  <CheckIcon size={12} />
                  <span>{githubSuccess}</span>
                </div>
              )}

              {githubConnected ? (
                <div className="github-connected-card">
                  <div className="github-connected-info">
                    <GitHubIcon size={20} className="text-green" />
                    <div>
                      <strong style={{ display: "block", fontSize: "13px", color: "#ffffff" }}>
                        GitHub Profile Connected
                      </strong>
                      <a
                        href={`https://github.com/${githubUsername}`}
                        target="_blank"
                        rel="noreferrer"
                        className="github-handle-link"
                      >
                        <span>@{githubUsername || "connected"}</span>
                        <ExternalLinkIcon size={11} />
                      </a>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="starter-badge ready">Linked</span>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={handleDisconnectGitHub}
                      title="Disconnect GitHub account"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <div className="account-row-item" style={{ flexDirection: "column", alignItems: "stretch", gap: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div className="acct-brand">
                      <GitHubIcon size={18} className="octo-svg" />
                      <div>
                        <strong className="acct-name">GitHub Profile Linking</strong>
                        <span className="sub-handle">Connect your GitHub profile for commit tracking and verified builds</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setIsLinkingGithub(!isLinkingGithub)}
                    >
                      {isLinkingGithub ? "Cancel" : "Link Profile"}
                    </button>
                  </div>

                  {isLinkingGithub && (
                    <div className="github-link-form">
                      <div className="github-link-inputs">
                        <input
                          type="text"
                          value={githubInput}
                          onChange={(e) => {
                            setGithubInput(e.target.value);
                            if (githubError) setGithubError("");
                          }}
                          placeholder="https://github.com/username or @username"
                          className="figma-text-input"
                          style={githubError ? { borderColor: "#ef4444" } : {}}
                        />
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          onClick={handleLinkGitHub}
                          disabled={githubLinking}
                        >
                          {githubLinking ? (
                            <>
                              <SpinnerIcon size={12} className="spin" />
                              <span>Verifying...</span>
                            </>
                          ) : (
                            <span>Verify & Link</span>
                          )}
                        </button>
                      </div>
                      <span className="field-constraint-hint">
                        Enter a valid public GitHub profile URL or your GitHub handle. Invalid links are strictly validated.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="save-action-row">
              <button type="submit" className="btn-primary" disabled={profileSaving}>
                {profileSaving ? (
                  <>
                    <SpinnerIcon size={12} className="spin" />
                    <span>Verifying & Saving...</span>
                  </>
                ) : (
                  <span>Save Changes</span>
                )}
              </button>
            </div>
          </form>
        </section>

        {/* Section 2: Account Security & Password */}
        <section className="settings-section-card" aria-label="Account security">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Account Security</h2>
            <p className="section-col-desc">
              Update your account password with strict complexity requirements to keep your workspace protected.
            </p>
          </div>

          <form onSubmit={handleUpdatePassword} className="settings-form-col">
            {passwordError && (
              <div className="auth-message-block error" style={{ marginBottom: "1rem" }}>
                <CloseIcon size={13} />
                <span>{passwordError}</span>
              </div>
            )}

            {passwordSuccess && (
              <div className="auth-message-block success" style={{ marginBottom: "1rem" }}>
                <CheckIcon size={13} />
                <span>Password updated successfully.</span>
              </div>
            )}

            <div className="form-group-block">
              <label htmlFor="current-pass">Current password</label>
              <input
                id="current-pass"
                type="password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  if (passwordError) setPasswordError("");
                }}
                className="figma-text-input"
                required
                placeholder="••••••••••••"
              />
            </div>

            <div className="form-group-block">
              <label htmlFor="new-pass">New password</label>
              <input
                id="new-pass"
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (passwordError) setPasswordError("");
                }}
                className="figma-text-input"
                required
                minLength={8}
                maxLength={128}
                placeholder="••••••••••••"
              />
              <span className="field-constraint-hint">Must be at least 8 characters and include at least one letter and one number</span>
            </div>

            <div className="form-group-block">
              <label htmlFor="confirm-pass">Confirm new password</label>
              <input
                id="confirm-pass"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (passwordError) setPasswordError("");
                }}
                className="figma-text-input"
                required
                placeholder="••••••••••••"
              />
            </div>

            <div className="save-action-row">
              <button type="submit" className="btn-primary" disabled={passwordLoading}>
                {passwordLoading ? (
                  <>
                    <SpinnerIcon size={12} className="spin" />
                    <span>Updating Password...</span>
                  </>
                ) : (
                  <span>Update Password</span>
                )}
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

              <div style={{ display: "flex", gap: "6px", marginLeft: "auto" }}>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handleToggleRevealAll}
                  title="Toggle mask on all secrets"
                >
                  {revealedIds.size > 0 ? <EyeOffIcon size={12} /> : <EyeIcon size={12} />}
                  <span>{revealedIds.size > 0 ? "Mask All" : "Reveal All"}</span>
                </button>

                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handleExportEnv}
                  title="Copy variables to clipboard"
                >
                  <CopyIcon size={12} />
                  <span>{exportedCopied ? "Copied!" : "Export .env"}</span>
                </button>

                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setIsBulkImporting(!isBulkImporting);
                    setBulkImportErrors([]);
                  }}
                >
                  <span>{isBulkImporting ? "Close Bulk" : "Bulk Import"}</span>
                </button>

                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setIsAddingVar(!isAddingVar);
                    setVarKeyError("");
                  }}
                >
                  <PlusIcon size={12} />
                  <span>{isAddingVar ? "Close" : "Add Secret"}</span>
                </button>
              </div>
            </div>

            {/* Bulk Import Drawer with Strict Constraints */}
            {isBulkImporting && (
              <form onSubmit={handleBulkImport} className="add-variable-drawer" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)", fontWeight: "600" }}>
                  Paste .env variables (one KEY=VALUE per line)
                </span>
                {bulkImportErrors.length > 0 && (
                  <div className="auth-message-block error">
                    <ul style={{ margin: 0, paddingLeft: "16px", fontSize: "12px" }}>
                      {bulkImportErrors.map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <textarea
                  className="env-bulk-textarea"
                  value={bulkImportText}
                  onChange={(e) => {
                    setBulkImportText(e.target.value);
                    if (bulkImportErrors.length > 0) setBulkImportErrors([]);
                  }}
                  placeholder="DATABASE_URL=postgres://user:pass@host:5432/app&#10;JWT_SECRET=sk_live_987654321&#10;CACHE_TTL=3600"
                  required
                />
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <button type="submit" className="btn-primary btn-sm">
                    Save to Vault
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setIsBulkImporting(false);
                      setBulkImportErrors([]);
                    }}
                  >
                    Cancel
                  </button>
                  {bulkImportSuccess && (
                    <span className="save-feedback-pill" style={{ marginLeft: "auto" }}>
                      <CheckIcon size={12} />
                      <span>Variables imported!</span>
                    </span>
                  )}
                </div>
              </form>
            )}

            {/* Single Var Add Drawer with Key Constraints */}
            {isAddingVar && (
              <form onSubmit={handleAddVariable} className="add-variable-drawer" style={{ flexDirection: "column", gap: "10px" }}>
                {varKeyError && (
                  <span className="field-error-text">
                    <CloseIcon size={11} />
                    <span>{varKeyError}</span>
                  </span>
                )}
                <div style={{ display: "flex", gap: "12px" }}>
                  <input
                    required
                    placeholder="KEY (e.g. DATABASE_URL)"
                    value={newVarKey}
                    onChange={(e) => {
                      setNewVarKey(e.target.value.toUpperCase());
                      if (varKeyError) setVarKeyError("");
                    }}
                    className="add-var-key"
                    style={varKeyError ? { borderColor: "#ef4444" } : {}}
                  />
                  <input
                    required
                    placeholder="VALUE"
                    value={newVarVal}
                    onChange={(e) => setNewVarVal(e.target.value)}
                    className="add-var-val"
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "6px" }}>
                    <input
                      type="checkbox"
                      checked={isNewSecret}
                      onChange={(e) => setIsNewSecret(e.target.checked)}
                    />
                    <span>Encrypt as secret in vault</span>
                  </label>
                  <div className="add-var-btns">
                    <button type="submit" className="btn-primary btn-sm">
                      Save to Vault
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => {
                        setIsAddingVar(false);
                        setVarKeyError("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
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

        {/* Section 4: Custom Domains & DNS Routing */}
        <section className="settings-section-card" aria-label="Custom domains">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Custom Domains & DNS</h2>
            <p className="section-col-desc">
              Point your domain to DeployForge using a CNAME record to route public traffic through Nginx.
            </p>
          </div>

          <div className="settings-form-col">
            {domainError && (
              <div className="auth-message-block error" style={{ marginBottom: "0.75rem" }}>
                <CloseIcon size={13} />
                <span>{domainError}</span>
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
                  onChange={(e) => {
                    setNewDomain(e.target.value);
                    if (domainError) setDomainError("");
                  }}
                  className="figma-text-input"
                  style={domainError ? { borderColor: "#ef4444" } : {}}
                />
                <div className="add-domain-btns">
                  <button type="submit" className="btn-primary btn-sm" disabled={domainLoading}>
                    {domainLoading ? (
                      <>
                        <SpinnerIcon size={12} className="spin" />
                        <span>Validating...</span>
                      </>
                    ) : (
                      <span>Add CNAME</span>
                    )}
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
                onClick={() => {
                  setIsAddingDomain(true);
                  setDomainError("");
                }}
              >
                <PlusIcon size={13} />
                <span>Add Domain</span>
              </button>
            )}

            {/* DNS CNAME Configuration Guide */}
            {showDnsGuide && (
              <div className="dns-guide-box">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <strong style={{ fontSize: "12px", color: "#ffffff" }}>DNS CNAME Record Guide</strong>
                  <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>Automatic TLS Provisioning</span>
                </div>
                <table className="dns-records-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Name / Host</th>
                      <th>Target Value</th>
                      <th>TTL</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>CNAME</code></td>
                      <td><code>app</code> or <code>@</code></td>
                      <td><code>ingress.deployforge.app</code></td>
                      <td>300s (Auto)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Section 5: Platform Architecture & Diagnostics Widget */}
        <section className="settings-section-card" aria-label="Platform telemetry">
          <div className="settings-intro-col">
            <h2 className="section-col-title">Platform Architecture</h2>
            <p className="section-col-desc">
              Live telemetry and orchestration status across the platform core engine components.
            </p>
          </div>

          <div className="settings-form-col">
            <div className="diagnostics-grid">
              <div className="diag-item-card">
                <div className="diag-info-left">
                  <span className="diag-title">PostgreSQL Database</span>
                  <span className="diag-desc">Connection Pool & Outbox Events</span>
                </div>
                <span className="diag-status-pill">Connected</span>
              </div>

              <div className="diag-item-card">
                <div className="diag-info-left">
                  <span className="diag-title">Redis Streams Broker</span>
                  <span className="diag-desc">stream:deployment_events (PEL active)</span>
                </div>
                <span className="diag-status-pill">Healthy</span>
              </div>

              <div className="diag-item-card">
                <div className="diag-info-left">
                  <span className="diag-title">Docker Engine API</span>
                  <span className="diag-desc">Dual-Mode Client (/var/run/docker.sock)</span>
                </div>
                <span className="diag-status-pill">Active</span>
              </div>

              <div className="diag-item-card">
                <div className="diag-info-left">
                  <span className="diag-title">Nginx Alpine Data Plane</span>
                  <span className="diag-desc">deployforge-apps Network (Zero-Downtime)</span>
                </div>
                <span className="diag-status-pill">Operational</span>
              </div>
            </div>
          </div>
        </section>

        {/* Section 6: Notifications & Alert Preferences */}
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
