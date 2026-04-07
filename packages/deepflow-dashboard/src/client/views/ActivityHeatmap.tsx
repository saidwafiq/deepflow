import { useCallback, useContext, useEffect, useState } from 'react';
import { HeatmapGrid, type HeatmapDay } from '../components/charts/HeatmapGrid';
import { ChartCard } from '../components/ChartCard';
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

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total Sessions"
          value={totalSessions}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>}
        />
        <MetricCard
          label="Active Days"
          value={activeDays}
          sub={`of ${data.days} days`}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        <MetricCard
          label="Total Messages"
          value={totalMessages.toLocaleString()}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>}
        />
        <MetricCard
          label="Busiest Day"
          value={maxDay?.session_count ?? 0}
          sub={maxDay?.day ?? '—'}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>}
        />
      </div>

      <ChartCard title="Session activity — last 52 weeks">
        <HeatmapGrid data={heatmapData} weeks={52} countLabel="sessions" />
      </ChartCard>
    </div>
  );
}
