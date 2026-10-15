// frontend/src/components/common/StatusBadge.jsx
import React from 'react';

const STATUS_MAP = {
  READY: { label: 'Ready', tone: 'success', pulse: false },
  RUNNING: { label: 'Running', tone: 'success', pulse: true },
  LIVE: { label: 'Live', tone: 'success', pulse: true },
  HEALTHY: { label: 'Healthy', tone: 'success', pulse: true },
  CLONING: { label: 'Cloning', tone: 'warning', pulse: true },
  BUILDING: { label: 'Building', tone: 'warning', pulse: true },
  STARTING: { label: 'Starting', tone: 'warning', pulse: true },
  DEPLOYING: { label: 'Deploying', tone: 'warning', pulse: true },
  QUEUED: { label: 'Queued', tone: 'neutral', pulse: true },
  INITIATED: { label: 'Initiated', tone: 'neutral', pulse: true },
  PENDING: { label: 'Pending', tone: 'neutral', pulse: true },
  FAILED: { label: 'Failed', tone: 'danger', pulse: false },
  ERROR: { label: 'Error', tone: 'danger', pulse: false },
  UNHEALTHY: { label: 'Unhealthy', tone: 'danger', pulse: false },
  STOPPED: { label: 'Stopped', tone: 'neutral', pulse: false },
  CANCELED: { label: 'Canceled', tone: 'neutral', pulse: false },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', pulse: false },
};

export default function StatusBadge({ status, value, size = 'md', className = '' }) {
  const targetStatus = status !== undefined ? status : (value !== undefined ? value : 'QUEUED');
  const key = String(targetStatus).toUpperCase().trim();
  const config = STATUS_MAP[key] || {
    label: targetStatus || 'Unknown',
    tone: 'neutral',
    pulse: false,
  };

  return (
    <span
      className={`df-status-badge df-status-badge--${config.tone} df-status-badge--${size} status-badge status-${config.tone} status-size-${size} ${className}`.trim()}
      role="status"
      aria-label={`Status: ${config.label}`}
    >
      <span
        className={`df-status-badge__dot ${config.pulse ? 'df-status-badge__dot--pulse' : ''}`.trim()}
        aria-hidden="true"
      />
      <span className="df-status-badge__label">{config.label}</span>
    </span>
  );
}
