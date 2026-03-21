import React, { useCallback, useContext, useEffect, useState } from 'react';
import { QuotaGauge } from '../components/QuotaGauge';
import { StackedAreaChart } from '../components/charts/StackedAreaChart';
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
  captured_at: string | null;
  /** Present in team mode */
  user?: string;
}

interface QuotaResponse {
  data: QuotaEntry[];
}

/* ---- Types from GET /api/quota/history ---- */
interface QuotaHistoryEntry {
  captured_at: string;
  window_type: string;
  used: number;
  limit_val: number;
  utilization_pct: number | null;
}

interface QuotaHistoryResponse {
  data: QuotaHistoryEntry[];
}

/** Palette for distinct window_type series */
const WINDOW_COLORS: Record<string, string> = {
  five_hour: '#6366f1',
  seven_day: '#22c55e',
  seven_day_sonnet: '#f59e0b',
  extra_usage: '#ef4444',
};

function windowColor(windowType: string, idx: number): string {
  return WINDOW_COLORS[windowType] ?? ['#8b5cf6', '#14b8a6', '#f97316', '#ec4899'][idx % 4];
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
  const [history, setHistory] = useState<QuotaHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, histRes] = await Promise.all([
        apiFetch('/api/quota'),
        apiFetch('/api/quota/history?days=7'),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!histRes.ok) throw new Error(`HTTP ${histRes.status}`);
      const json = (await res.json()) as QuotaResponse;
      const histJson = (await histRes.json()) as QuotaHistoryResponse;
      setData(json);
      setHistory(histJson);
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

  /* ---- Build trend chart data ---- */
  // Pivot history rows: [{captured_at, five_hour_pct, seven_day_pct, ...}]
  const trendSection = (() => {
    if (!history || history.data.length === 0) return null;

    // Collect unique window types in order of first appearance
    const windowTypes: string[] = [];
    const seenWindowTypes = new Set<string>();
    for (const row of history.data) {
      if (!seenWindowTypes.has(row.window_type)) {
        seenWindowTypes.add(row.window_type);
        windowTypes.push(row.window_type);
      }
    }

    // Group by captured_at timestamp
    const byTs = new Map<string, Record<string, number | null>>();
    for (const row of history.data) {
      const ts = row.captured_at;
      if (!byTs.has(ts)) byTs.set(ts, { captured_at: ts as unknown as number });
      byTs.get(ts)![row.window_type] = row.utilization_pct;
    }

    // Sort chronologically and format x-axis label
    const chartData = Array.from(byTs.values()).sort((a, b) =>
      String(a.captured_at) < String(b.captured_at) ? -1 : 1
    );

    const areas = windowTypes.map((wt, idx) => ({
      dataKey: wt,
      name: label(wt),
      color: windowColor(wt, idx),
    }));

    const xFmt = (v: unknown) => {
      const d = new Date(String(v));
      return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };
    const yFmt = (v: unknown) => `${v}%`;

    return (
      <div className="space-y-2">
        <h2 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          Utilization Trend — last 7 days
        </h2>
        <StackedAreaChart
          data={chartData as Record<string, unknown>[]}
          areas={areas}
          xKey="captured_at"
          xTickFormatter={xFmt}
          yTickFormatter={yFmt}
          tooltipFormatter={(value, name) => [`${value}%`, name]}
          height={220}
        />
      </div>
    );
  })();

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
                  capturedAt={e.captured_at}
                />
              ))}
            </div>
          </div>
        ))}
        {trendSection}
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
            capturedAt={e.captured_at}
          />
        ))}
      </div>
      {trendSection}
    </div>
  );
}
