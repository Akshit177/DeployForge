export default function StatusBadge({ value, size = "md", className = "" }) {
  const raw = value || "";
  const norm = raw.toLowerCase().trim();

  let label = raw;
  let icon = null;
  let statusClass = "stopped";

  if (norm === "running" || norm === "live" || norm === "active") {
    label = "Running";
    statusClass = "running";
    icon = <span className="status-indicator status-dot green-pulse" />;
  } else if (norm === "succeeded") {
    label = "Succeeded";
    statusClass = "succeeded";
    icon = (
      <svg className="status-svg" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M13.5 4.5L6.5 11.5L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  } else if (norm === "starting") {
    label = "Starting";
    statusClass = "starting";
    icon = (
      <svg className="status-svg spin" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10"/>
      </svg>
    );
  } else if (norm === "building") {
    label = "Building";
    statusClass = "building";
    icon = (
      <svg className="status-svg spin" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10"/>
      </svg>
    );
  } else if (norm === "cloning") {
    label = "Cloning";
    statusClass = "cloning";
    icon = (
      <svg className="status-svg spin" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="10"/>
      </svg>
    );
  } else if (norm === "queued") {
    label = "Queued";
    statusClass = "queued";
    icon = (
      <svg className="status-svg" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M8 5V8L10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    );
  } else if (norm === "initiated") {
    label = "Initiated";
    statusClass = "initiated";
    icon = (
      <svg className="status-svg" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    );
  } else if (norm === "failed") {
    label = "Failed";
    statusClass = "failed";
    icon = (
      <svg className="status-svg" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    );
  } else if (norm === "cancelled") {
    label = "Cancelled";
    statusClass = "cancelled";
    icon = (
      <svg className="status-svg" width="12" height="12" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M5 8H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    );
  } else {
    label = "Stopped";
    statusClass = "stopped";
    icon = <span className="status-indicator status-dot gray" />;
  }

  return (
    <span className={`status-badge status-${statusClass} status-size-${size} ${className}`}>
      {icon}
      <span className="status-label">{label}</span>
    </span>
  );
}
