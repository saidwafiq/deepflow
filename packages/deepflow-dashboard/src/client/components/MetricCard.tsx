import React from 'react';

interface MetricCardProps {
  label: string;
  value: string | number;
  /** Optional sub-label shown below the value */
  sub?: string;
  /** Trend: positive = green, negative = red, 0/undefined = neutral */
  trend?: number;
}

export function MetricCard({ label, value, sub, trend }: MetricCardProps) {
  const trendColor =
    trend === undefined
      ? undefined
      : trend > 0
        ? 'var(--accent)'
        : trend < 0
          ? '#ef4444'
          : 'var(--text-secondary)';

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
    >
      <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--text)' }}>
        {value}
      </p>
      {(sub || trend !== undefined) && (
        <p className="mt-0.5 text-xs" style={{ color: trendColor ?? 'var(--text-secondary)' }}>
          {sub}
          {trend !== undefined && (
            <span>{trend > 0 ? ' ▲' : trend < 0 ? ' ▼' : ' —'}</span>
          )}
        </p>
      )}
    </div>
  );
}
