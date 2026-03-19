import React, { useCallback, useContext, useEffect, useState } from 'react';
import { QuotaGauge } from '../components/QuotaGauge';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/quota ---- */
interface QuotaEntry {
  window_type: string;
  used: number;
  limit_val: number;
  utilization_pct: number;
  reset_at: string | null;
  /** Present in team mode */
  user?: string;
}

interface QuotaResponse {
  data: QuotaEntry[];
}

/* ---- Helpers ---- */

/** Human-friendly label for window_type keys */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-Hour Window',
  seven_day: '7-Day Window',
  seven_day_sonnet: '7-Day (Sonnet)',
  extra_usage: 'Extra Usage',
};

function label(windowType: string): string {
  return WINDOW_LABELS[windowType] ?? windowType;
}

/* ---- Component ---- */
export function QuotaStatus() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey, mode } = useContext(DashboardContext);
  const [data, setData] = useState<QuotaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quota');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as QuotaResponse;
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

  const quota = data.data;

  // In team mode entries may carry a user field — group by user, then window.
  if (mode === 'team') {
    const byUser = new Map<string, QuotaEntry[]>();
    for (const entry of quota) {
      const u = entry.user ?? 'unknown';
      if (!byUser.has(u)) byUser.set(u, []);
      byUser.get(u)!.push(entry);
    }

    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Quota Status</h1>
        {Array.from(byUser.entries()).map(([user, entries]) => (
          <div key={user} className="space-y-3">
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{user}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {entries.map((e) => (
                <QuotaGauge
                  key={`${user}-${e.window_type}`}
                  label={label(e.window_type)}
                  pct={e.utilization_pct}
                  reset_at={e.reset_at}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Local mode — flat grid of gauges.
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Quota Status</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {quota.map((e) => (
          <QuotaGauge
            key={e.window_type}
            label={label(e.window_type)}
            pct={e.utilization_pct}
            reset_at={e.reset_at}
          />
        ))}
      </div>
    </div>
  );
}
