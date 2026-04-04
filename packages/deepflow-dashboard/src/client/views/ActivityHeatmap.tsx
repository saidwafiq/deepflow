import React, { useCallback, useContext, useEffect, useState } from 'react';
import { HeatmapGrid, type HeatmapDay } from '../components/charts/HeatmapGrid';
import { MetricCard } from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

interface ActivityRow {
  day: string;
  session_count: number;
  total_cost: number;
  total_messages: number;
}

interface ActivityResponse {
  data: ActivityRow[];
  weeks: number;
  days: number;
}

export function ActivityHeatmap() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey, mode, selectedUser } = useContext(DashboardContext);
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ weeks: '52' });
      if (mode === 'team' && selectedUser) params.set('user', selectedUser);
      const res = await apiFetch(`/api/activity?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ActivityResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch, mode, selectedUser]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load activity data: {error}</p>;
  }

  if (!data) {
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const rows = data.data;
  const totalSessions = rows.reduce((s, r) => s + r.session_count, 0);
  const totalMessages = rows.reduce((s, r) => s + r.total_messages, 0);
  const activeDays = rows.filter((r) => r.session_count > 0).length;
  const maxDay = rows.reduce((m, r) => (r.session_count > m.session_count ? r : m), rows[0] ?? { session_count: 0, day: '—' });

  const heatmapData: HeatmapDay[] = rows.map((r) => ({ day: r.day, count: r.session_count }));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text)]">Activity Heatmap</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Total Sessions" value={totalSessions} />
        <MetricCard label="Active Days" value={activeDays} sub={`of ${data.days} days`} />
        <MetricCard label="Total Messages" value={totalMessages.toLocaleString()} />
        <MetricCard
          label="Busiest Day"
          value={maxDay?.session_count ?? 0}
          sub={maxDay?.day ?? '—'}
        />
      </div>

      <div
        className="rounded-xl p-4 bg-[var(--bg-card)] border border-[var(--border)]"
      >
        <p className="mb-3 text-sm font-medium text-[var(--text-secondary)]">
          Session activity — last 52 weeks
        </p>
        <HeatmapGrid data={heatmapData} weeks={52} countLabel="sessions" />
      </div>
    </div>
  );
}
