import { useCallback, useContext, useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import { ChartCard } from '../components/ChartCard';
import { MetricCard } from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

interface SessionRow {
  started_at: string; // ISO datetime
  [key: string]: unknown;
}

interface SessionsResponse {
  data: SessionRow[];
  total: number;
}

interface HourBucket {
  hour: number;
  label: string;
  count: number;
}

function buildHourlyBuckets(sessions: SessionRow[]): HourBucket[] {
  const counts = Array.from({ length: 24 }, () => 0);
  for (const s of sessions) {
    const d = new Date(s.started_at);
    if (!isNaN(d.getTime())) {
      counts[d.getHours()]++;
    }
  }
  return counts.map((count, hour) => ({
    hour,
    label: `${hour.toString().padStart(2, '0')}:00`,
    count,
  }));
}

const ACCENT = 'var(--accent)';
const DIM = '#374151';

export function PeakHours() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey, mode, selectedUser } = useContext(DashboardContext);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Fetch only started_at for up to 500 sessions — sufficient for hour distribution
      const params = new URLSearchParams({ limit: '500', fields: 'started_at' });
      if (mode === 'team' && selectedUser) params.set('user', selectedUser);
      const res = await apiFetch(`/api/sessions?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SessionsResponse;
      setSessions(json.data);
      setTotal(json.total);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch, mode, selectedUser]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load session data: {error}</p>;
  }

  if (!sessions.length && total === 0) {
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const buckets = buildHourlyBuckets(sessions);
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const peakBucket = buckets.reduce((p, b) => (b.count > p.count ? b : p), buckets[0]);
  const activeBuckets = buckets.filter((b) => b.count > 0).length;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text)]">Peak Hours</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Sessions Analyzed"
          value={sessions.length}
          sub={total > sessions.length ? `of ${total} total` : undefined}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
        />
        <MetricCard
          label="Peak Hour"
          value={peakBucket?.label ?? '—'}
          sub={`${peakBucket?.count ?? 0} sessions`}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        <MetricCard
          label="Active Hours"
          value={activeBuckets}
          sub="hours with activity"
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
        />
        <MetricCard
          label="Avg per hour"
          value={sessions.length > 0 ? (sessions.length / 24).toFixed(1) : '0'}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
        />
      </div>

      <ChartCard title="Session count by hour of day (local time)">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={buckets} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
              tickLine={false}
              axisLine={false}
              interval={2}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                color: 'var(--text)',
                fontSize: 12,
                boxShadow: '0px 8px 13px -3px rgba(0, 0, 0, 0.07)',
                padding: '8px 12px',
              }}
              formatter={(value: number) => [`${value} sessions`, 'Count']}
              labelFormatter={(label: string) => `Hour: ${label}`}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {buckets.map((b) => (
                <Cell
                  key={b.hour}
                  fill={b.count === maxCount && b.count > 0 ? ACCENT : DIM}
                  fillOpacity={b.count > 0 ? 0.7 + (b.count / maxCount) * 0.3 : 0.3}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Highlighted bar = peak hour. Based on last {sessions.length} sessions.
        </p>
      </ChartCard>
    </div>
  );
}
