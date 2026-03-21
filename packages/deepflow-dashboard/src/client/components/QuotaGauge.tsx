import React, { useEffect, useState } from 'react';

interface QuotaGaugeProps {
  label: string;
  /** 0–100 utilization percentage */
  pct: number;
  /** ISO timestamp when the quota window resets */
  reset_at: string | null;
  /** ISO timestamp when the snapshot was captured */
  capturedAt?: string | null;
  /** Optional sub-label (e.g. user name in team mode) */
  sub?: string;
}

/** Returns a human-readable countdown string from now until `target`. */
function useCountdown(target: string | null): string {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!target) {
      setLabel('—');
      return;
    }

    function calc() {
      const ms = new Date(target!).getTime() - Date.now();
      if (ms <= 0) {
        setLabel('now');
        return;
      }
      const totalSecs = Math.floor(ms / 1000);
      const days = Math.floor(totalSecs / 86400);
      const hrs = Math.floor((totalSecs % 86400) / 3600);
      const mins = Math.floor((totalSecs % 3600) / 60);
      const secs = totalSecs % 60;
      if (days > 0) setLabel(`${days}d ${hrs}h`);
      else if (hrs > 0) setLabel(`${hrs}h ${mins}m`);
      else setLabel(`${mins}m ${secs}s`);
    }

    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [target]);

  return label;
}

/** Returns a human-friendly "Updated X min ago" string from an ISO timestamp. */
function relativeUpdated(capturedAt: string | null | undefined): string {
  if (!capturedAt) return '';
  const diffMs = Date.now() - new Date(capturedAt).getTime();
  if (diffMs < 0) return 'Updated just now';
  const totalSecs = Math.floor(diffMs / 1000);
  if (totalSecs < 60) return 'Updated just now';
  const mins = Math.floor(totalSecs / 60);
  if (mins < 60) return `Updated ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `Updated ${days}d ago`;
}

/** Color based on utilization — green → yellow → red */
function gaugeColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return 'var(--accent)';
}

export function QuotaGauge({ label, pct, reset_at, capturedAt, sub }: QuotaGaugeProps) {
  const countdown = useCountdown(reset_at);
  const clampedPct = Math.min(100, Math.max(0, pct));
  const color = gaugeColor(clampedPct);

  return (
    <div
      className="rounded-xl p-4 space-y-2"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
        {sub && (
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{sub}</span>
        )}
      </div>

      {/* Percentage */}
      <p className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--text)' }}>
        {clampedPct.toFixed(1)}%
      </p>

      {/* Progress bar */}
      <div
        className="h-2 w-full rounded-full overflow-hidden"
        style={{ background: 'var(--border)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${clampedPct}%`, background: color }}
        />
      </div>

      {/* Reset countdown */}
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        Resets in <span className="tabular-nums font-medium" style={{ color: 'var(--text)' }}>{countdown}</span>
      </p>

      {/* Captured-at timestamp */}
      {capturedAt && (
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {relativeUpdated(capturedAt)}
        </p>
      )}
    </div>
  );
}
