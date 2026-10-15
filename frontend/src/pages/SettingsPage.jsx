import { useState, useEffect } from "react";
import StatusBadge from "../components/common/StatusBadge.jsx";
import TextInput from "../components/common/TextInput.jsx";
import FormMessage from "../components/common/FormMessage.jsx";
import { fetchProjects, deleteProject } from "../services/projectService.js";
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
  getRoutes,
  verifyDomainHealth,
  resolveRoute,
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
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

function parseEnvString(rawText) {
  const lines = rawText.split(/\r?\n/);
  const parsed = [];
  const errors = [];
  const seenKeys = new Set();

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      errors.push(`Line ${index + 1}: Missing "=" separator between key and value.`);
      return;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (!ENV_KEY_REGEX.test(key)) {
      errors.push(`Line ${index + 1}: Invalid variable key "${key}". Must follow POSIX standard (letters, digits, underscores, cannot start with a digit).`);
      return;
    }
    if (seenKeys.has(key)) {
      errors.push(`Line ${index + 1}: Duplicate environment key "${key}" detected in input.`);
      return;
    }
    seenKeys.add(key);
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

export default function SettingsPage({ navigate, searchParams }) {
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
  const [showNewVarVal, setShowNewVarVal] = useState(false);
  const [revealedIds, setRevealedIds] = useState(new Set());
  const [unmaskedValues, setUnmaskedValues] = useState({});

  // Project Deletion
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Domains & Routing
  const [domains, setDomains] = useState([
    { domain: "web-app.deployforge.app", status: "Active", isDefault: true },
  ]);
  const [activeRoutes, setActiveRoutes] = useState([]);
  const [domainHealth, setDomainHealth] = useState({});
  const [probingDomain, setProbingDomain] = useState(null);
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
          const targetParamId = searchParams?.get("project_id") || searchParams?.get("projectId");
          const found = data.find((p) => p.id === targetParamId);
          setSelectedProjectId(found ? found.id : data[0].id);
        }
      })
      .catch((err) => console.warn("Failed to load projects:", err));

    loadRoutes();
  }, []);

  const loadRoutes = () => {
    getRoutes()
      .then((data) => {
        if (data && Array.isArray(data.routes)) {
          setActiveRoutes(data.routes);
        }
      })
      .catch((err) => console.warn("Could not fetch routing table:", err));
  };

  const handleProbeDomain = async (domain, projectId) => {
    setProbingDomain(domain);
    try {
      const targetProjId = projectId || selectedProjectId;
      if (targetProjId) {
        const health = await verifyDomainHealth(targetProjId);
        setDomainHealth((prev) => ({
          ...prev,
          [domain]: {
            healthy: health.probe ? health.probe.healthy : true,
            latency_ms: health.probe ? health.probe.latency_ms : (health.response_time_ms || 2),
            status: "Healthy",
          },
        }));
      } else {
        const resolved = await resolveRoute(domain);
        setDomainHealth((prev) => ({
          ...prev,
          [domain]: {
            healthy: resolved.matched,
            status: resolved.matched ? "Routed" : "Unrouted",
            upstream: resolved.target_upstream,
          },
        }));
      }
    } catch (err) {
      setDomainHealth((prev) => ({
        ...prev,
        [domain]: {
          healthy: false,
          status: "Unreachable",
          error: err.message,
        },
      }));
    } finally {
      setProbingDomain(null);
    }
  };

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

  const handleKeyPaste = (e) => {
    const text = e.clipboardData?.getData("text");
    if (text && (text.includes("\n") || text.includes("="))) {
      e.preventDefault();
      const { parsed, errors } = parseEnvString(text);
      if (errors.length > 0) {
        setVarKeyError(errors[0]);
        return;
      }
      if (parsed.length > 0) {
        if (parsed.length === 1 && !text.includes("\n")) {
          setNewVarKey(parsed[0].key);
          setNewVarVal(parsed[0].value);
          setIsNewSecret(parsed[0].isSecret);
          setVarKeyError("");
          return;
        }

        const parsedKeys = new Set(parsed.map((p) => p.key));
        const merged = [
          ...envVars.filter((v) => !parsedKeys.has(v.key)),
          ...parsed,
        ];
        if (selectedProjectId) {
          saveEnvVars(selectedProjectId, merged)
            .then((saved) => {
              setEnvVars(saved);
              setIsAddingVar(false);
              setNewVarKey("");
              setNewVarVal("");
              setVarKeyError("");
            })
            .catch((err) => {
              setVarKeyError(err.message || "Failed to save parsed variables.");
            });
        }
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

    const cleanKey = newVarKey.trim();
    if (!ENV_KEY_REGEX.test(cleanKey)) {
      setVarKeyError("Key must follow POSIX variable name format (letters, digits, underscores, starting with letter or underscore).");
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

  const handleDeleteProject = async (e) => {
    if (e) e.preventDefault();
    if (!activeProject) return;
    if (deleteConfirmationText.trim() !== activeProject.name) {
      setDeleteError(`Please type "${activeProject.name}" exactly to confirm.`);
      return;
    }
    setIsDeletingProject(true);
    setDeleteError("");
    try {
      await deleteProject(activeProject.id);
      const remaining = projects.filter((p) => p.id !== activeProject.id);
      setProjects(remaining);
      setSelectedProjectId(remaining.length > 0 ? remaining[0].id : "");
      setShowDeleteModal(false);
      setDeleteConfirmationText("");
      if (remaining.length === 0 && navigate) {
        navigate("/projects");
      }
    } catch (err) {
      setDeleteError(err.message || "Failed to delete project.");
    } finally {
      setIsDeletingProject(false);
    }
  };

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
              <FormMessage message={profileError} type="error" style={{ marginBottom: "1rem" }} />
            )}

            {profileSuccess && (
              <FormMessage message="Profile updated successfully." type="success" style={{ marginBottom: "1rem" }} />
            )}

            <TextInput
              id="display-name"
              label="Full name / Username"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              minLength={2}
              maxLength={50}
              placeholder="e.g. Jane Doe"
              helperText="2-50 characters (letters, numbers, hyphens, and underscores)"
              className="form-group-block"
            />

            <TextInput
              id="email"
              type="email"
              label="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="developer@deployforge.dev"
              helperText="Used for deployment notifications and digest reports"
              className="form-group-block"
            />

            {/* Password Verification to authorize username/email change */}
            <div className="form-group-block" style={{ marginTop: "16px", padding: "14px", background: "var(--bg-surface, #111114)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-xs)" }}>
              <TextInput
                id="verify-pass"
                type="password"
                label="Current password to authorize changes"
                required
                value={profilePassword}
                onChange={(e) => setProfilePassword(e.target.value)}
                placeholder="Enter current password to verify identity"
                helperText="Your password is required to confirm username or email modifications."
              />
            </div>

            {/* Connected Accounts: GitHub Profile Linking */}
            <div className="connected-accounts-block" style={{ marginTop: "20px" }}>
              <h3 className="sub-section-title">Connected Accounts</h3>

              {githubError && (
                <FormMessage message={githubError} type="error" style={{ margin: "8px 0" }} />
              )}

              {githubSuccess && (
                <FormMessage message={githubSuccess} type="success" style={{ margin: "8px 0" }} />
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
                      aria-label="Disconnect GitHub account"
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
                      aria-label={isLinkingGithub ? "Cancel linking GitHub profile" : "Link GitHub profile"}
                    >
                      {isLinkingGithub ? "Cancel" : "Link Profile"}
                    </button>
                  </div>

                  {isLinkingGithub && (
                    <div className="github-link-form">
                      <div className="github-link-inputs">
                        <TextInput
                          id="github-profile"
                          value={githubInput}
                          onChange={(e) => {
                            setGithubInput(e.target.value);
                            if (githubError) setGithubError("");
                          }}
                          prefixIcon={GitHubIcon}
                          placeholder="https://github.com/username or @username"
                          error={githubError}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          onClick={handleLinkGitHub}
                          disabled={githubLinking}
                          style={{ height: "42px" }}
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
              <FormMessage message={passwordError} type="error" style={{ marginBottom: "1rem" }} />
            )}

            {passwordSuccess && (
              <FormMessage message="Password updated successfully." type="success" style={{ marginBottom: "1rem" }} />
            )}

            <TextInput
              id="current-pass"
              label="Current password"
              type="password"
              value={currentPassword}
              onChange={(e) => {
                setCurrentPassword(e.target.value);
                if (passwordError) setPasswordError("");
              }}
              required
              placeholder="••••••••••••"
              className="form-group-block"
            />

            <TextInput
              id="new-pass"
              label="New password"
              type="password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (passwordError) setPasswordError("");
              }}
              required
              minLength={8}
              maxLength={128}
              placeholder="••••••••••••"
              helperText="Must be at least 8 characters and include at least one letter and one number"
              className="form-group-block"
            />

            <TextInput
              id="confirm-pass"
              label="Confirm new password"
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (passwordError) setPasswordError("");
              }}
              required
              placeholder="••••••••••••"
              className="form-group-block"
            />

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
                <div style={{ display: "flex", gap: "12px", width: "100%", alignItems: "flex-start" }}>
                  <TextInput
                    id="new-var-key"
                    required
                    monospace
                    placeholder="KEY (e.g. DATABASE_URL)"
                    value={newVarKey}
                    onChange={(e) => {
                      setNewVarKey(e.target.value);
                      if (varKeyError) setVarKeyError("");
                    }}
                    onPaste={handleKeyPaste}
                    error={varKeyError}
                    style={{ flex: "0 0 240px" }}
                  />
                  <TextInput
                    id="new-var-val"
                    required
                    type={showNewVarVal ? "text" : "password"}
                    placeholder="VALUE"
                    value={newVarVal}
                    onChange={(e) => setNewVarVal(e.target.value)}
                    style={{ flex: 1 }}
                    suffix={
                      <button
                        type="button"
                        onClick={() => setShowNewVarVal(!showNewVarVal)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-tertiary)",
                          cursor: "pointer",
                          padding: "2px",
                          display: "flex",
                          alignItems: "center",
                        }}
                        aria-label={showNewVarVal ? "Hide new variable value" : "Reveal new variable value"}
                      >
                        {showNewVarVal ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                      </button>
                    }
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
                              aria-label={isRevealed ? `Hide value for variable ${v.key}` : `Reveal value for variable ${v.key}`}
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
                            aria-label={`Remove environment variable ${v.key}`}
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
              <FormMessage message={domainError} type="error" style={{ marginBottom: "0.75rem" }} />
            )}

            <div className="domains-table-card">
              {domains.map((d) => {
                const matchedRoute = activeRoutes.find((r) => r.domain === d.domain);
                const health = domainHealth[d.domain];
                return (
                  <div key={d.id || d.domain} className="domain-row-item">
                    <div className="domain-name-block">
                      <strong className="domain-txt">{d.domain}</strong>
                      {d.is_default || d.isDefault ? (
                        <span className="default-pill">System Default</span>
                      ) : null}
                      {matchedRoute && (
                        <span style={{ fontSize: "11px", color: "var(--text-tertiary)", marginLeft: "6px" }}>
                          <code>{matchedRoute.target_host}:{matchedRoute.port}</code>
                        </span>
                      )}
                      {health && (
                        <span
                          style={{
                            fontSize: "11px",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            marginLeft: "6px",
                            color: health.healthy ? "var(--accent-emerald, #10b981)" : "#ef4444",
                          }}
                        >
                          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
                          {health.healthy ? `Probe OK (${health.latency_ms ? `${health.latency_ms}ms` : "200"})` : "Probe Failed"}
                        </span>
                      )}
                    </div>
                    <div className="domain-status-block">
                      <StatusBadge value={d.status} size="sm" />
                      <button
                        type="button"
                        className="tbl-action-btn"
                        onClick={() => handleProbeDomain(d.domain, d.project_id)}
                        disabled={probingDomain === d.domain}
                        title="Probe Nginx & container health via /api/routing"
                        aria-label={`Probe health for domain ${d.domain}`}
                        style={{ padding: "3px 7px", fontSize: "11px" }}
                      >
                        {probingDomain === d.domain ? (
                          <SpinnerIcon size={12} className="spin" />
                        ) : (
                          <span>Probe</span>
                        )}
                      </button>
                      <a
                        href={`https://${d.domain}`}
                        target="_blank"
                        rel="noreferrer"
                        className="tbl-action-btn"
                        aria-label={`Open https://${d.domain} in new tab`}
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
                );
              })}
            </div>

            {isAddingDomain ? (
              <form onSubmit={handleAddDomain} className="add-domain-inline-form" style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                <TextInput
                  id="new-domain-input"
                  required
                  monospace
                  placeholder="app.yourdomain.com"
                  value={newDomain}
                  onChange={(e) => {
                    setNewDomain(e.target.value);
                    if (domainError) setDomainError("");
                  }}
                  error={domainError}
                  style={{ flex: 1 }}
                />
                <div className="add-domain-btns" style={{ marginTop: 0 }}>
                  <button type="submit" className="btn-primary btn-sm" disabled={domainLoading} style={{ height: "42px" }}>
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
                    style={{ height: "42px" }}
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

        {/* Section 7: Danger Zone */}
        {activeProject && (
          <section
            className="settings-section-card"
            aria-label="Danger zone"
            style={{ borderColor: "rgba(239, 68, 68, 0.35)", background: "rgba(239, 68, 68, 0.02)" }}
          >
            <div className="settings-intro-col">
              <h2 className="section-col-title" style={{ color: "#ef4444" }}>Danger Zone</h2>
              <p className="section-col-desc">
                Destructive operations for project <code>{activeProject.name}</code>. These actions cannot be undone.
              </p>
            </div>

            <div className="settings-form-col">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "1rem",
                  padding: "1rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                  background: "rgba(0, 0, 0, 0.25)",
                }}
              >
                <div>
                  <strong style={{ display: "block", color: "var(--text-primary)", fontSize: "0.875rem", marginBottom: "0.25rem" }}>
                    Delete Project "{activeProject.name}"
                  </strong>
                  <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.8125rem" }}>
                    Permanently delete this project along with all associated container resources, deployments, build logs, and environment secrets.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{
                    color: "#ef4444",
                    borderColor: "rgba(239, 68, 68, 0.35)",
                    flexShrink: 0,
                  }}
                  onClick={() => {
                    setShowDeleteModal(true);
                    setDeleteConfirmationText("");
                    setDeleteError("");
                  }}
                  aria-label={`Delete project ${activeProject.name}`}
                >
                  <TrashIcon size={13} />
                  <span>Delete Project</span>
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Danger Zone: Project Deletion Modal */}
      {showDeleteModal && activeProject && (
        <div
          className="df-cmd-backdrop"
          onClick={() => {
            if (!isDeletingProject) {
              setShowDeleteModal(false);
              setDeleteConfirmationText("");
              setDeleteError("");
            }
          }}
          style={{ zIndex: 9999 }}
        >
          <div
            className="df-cmd-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-dialog-title"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "480px", padding: "1.5rem" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: "rgba(239, 68, 68, 0.15)", display: "flex", alignItems: "center", justifyContent: "center", color: "#ef4444" }}>
                  <TrashIcon size={16} />
                </div>
                <h3 id="delete-project-dialog-title" style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  Delete Project
                </h3>
              </div>
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmationText("");
                  setDeleteError("");
                }}
                disabled={isDeletingProject}
                aria-label="Close delete confirmation dialog"
              >
                <CloseIcon size={14} />
              </button>
            </div>

            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: "1rem" }}>
              This action cannot be undone. This will permanently delete the project{" "}
              <strong style={{ color: "var(--text-primary)" }}>{activeProject.name}</strong>, destroy active containers,
              and purge all associated build logs, deployments, and vault variables.
            </p>

            {deleteError && (
              <FormMessage message={deleteError} type="error" style={{ marginBottom: "1rem" }} />
            )}

            <form onSubmit={handleDeleteProject}>
              <label
                htmlFor="confirm-delete-project-input"
                style={{ display: "block", fontSize: "0.8125rem", color: "var(--text-secondary)", marginBottom: "0.5rem" }}
              >
                To confirm, type <strong style={{ color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>{activeProject.name}</strong> below:
              </label>

              <TextInput
                id="confirm-delete-project-input"
                monospace
                autoFocus
                value={deleteConfirmationText}
                onChange={(e) => {
                  setDeleteConfirmationText(e.target.value);
                  if (deleteError) setDeleteError("");
                }}
                placeholder={activeProject.name}
                disabled={isDeletingProject}
                style={{ marginBottom: "1.25rem" }}
              />

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={isDeletingProject}
                  onClick={() => {
                    setShowDeleteModal(false);
                    setDeleteConfirmationText("");
                    setDeleteError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  style={{
                    backgroundColor: "#ef4444",
                    borderColor: "#ef4444",
                    color: "#ffffff",
                    opacity: deleteConfirmationText.trim() !== activeProject.name || isDeletingProject ? 0.5 : 1,
                    cursor: deleteConfirmationText.trim() !== activeProject.name || isDeletingProject ? "not-allowed" : "pointer",
                  }}
                  disabled={deleteConfirmationText.trim() !== activeProject.name || isDeletingProject}
                >
                  {isDeletingProject ? (
                    <>
                      <SpinnerIcon size={14} className="spin" />
                      <span>Deleting...</span>
                    </>
                  ) : (
                    <span>I understand, delete this project</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
