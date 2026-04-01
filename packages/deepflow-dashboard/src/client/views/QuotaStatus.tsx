import React, { useCallback, useContext, useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/quota/windows ---- */
interface WindowRow {
  startedAt: string;
  endsAt: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  seven_day_sonnet_pct: number | null;
  extra_usage_pct: number | null;
  isActive: boolean;
}

interface WindowsResponse {
  data: WindowRow[];
}

/* ---- Helpers ---- */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function clamp(v: number | null): number {
  if (v === null || v === undefined) return 0;
  return Math.max(0, Math.min(100, v));
}

/* ---- InlineBar ---- */
interface InlineBarProps {
  label: string;
  pct: number | null;
  color: string;
}

function InlineBar({ label, pct, color }: InlineBarProps) {
  const val = clamp(pct);
  const display = pct === null ? '–' : `${Math.round(val)}%`;

  return (
    <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
      <span
        className="text-xs font-medium shrink-0"
        style={{ color: 'var(--text-secondary)', width: '3.5rem' }}
      >
        {label}
      </span>
      <div
        className="relative rounded-sm overflow-hidden shrink-0"
        style={{ width: 64, height: 8, background: 'var(--bg-secondary)' }}
      >
        <div
          style={{
            width: `${val}%`,
            height: '100%',
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        className="text-xs tabular-nums shrink-0"
        style={{ color: 'var(--text-secondary)', width: '2.5rem' }}
      >
        {display}
      </span>
    </div>
  );
}

/* ---- Component ---- */
export function QuotaStatus() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<WindowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quota/windows');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as WindowsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load quota data: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</p>;
  }

  const rows = data.data;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Quota Windows</h1>

      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={`${row.startedAt}-${row.endsAt}`}
            className="rounded-xl p-3"
            style={{
              background: row.isActive ? 'var(--bg-card)' : 'var(--bg-secondary)',
              border: row.isActive
                ? '1px solid var(--accent)'
                : '1px solid var(--border)',
            }}
          >
            {/* Period label */}
            <div className="flex items-center gap-2 mb-2">
              {row.isActive && (
                <span
                  className="text-xs font-semibold px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--accent)', color: '#fff', lineHeight: 1.4 }}
                >
                  active
                </span>
              )}
              <span
                className="text-xs font-mono"
                style={{ color: row.isActive ? 'var(--text)' : 'var(--text-secondary)' }}
              >
                {fmtDate(row.startedAt)} → {fmtDate(row.endsAt)}
              </span>
            </div>

            {/* 4 inline bars */}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <InlineBar label="5h" pct={row.five_hour_pct} color="#6366f1" />
              <InlineBar label="7d" pct={row.seven_day_pct} color="#22c55e" />
              <InlineBar label="Sonnet" pct={row.seven_day_sonnet_pct} color="#f59e0b" />
              <InlineBar label="Extra" pct={row.extra_usage_pct} color="#ef4444" />
            </div>
          </div>
        ))}

        {rows.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No quota window data available.</p>
        )}
      </div>
    </div>
  );
}
