import { useCallback, useContext, useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { ChartCard } from '../components/ChartCard';
import { MetricCard } from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

interface ModelCost {
  model: string;
  cost: number;
}

interface DailyRow {
  day: string;
  model: string;
  cost: number;
}

interface CostsResponse {
  models: ModelCost[];
  daily: DailyRow[];
  projects: unknown[];
}

const MODEL_COLORS = [
  'var(--accent)',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
];

function fmtDollars(n: number) {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function pivotDailySeries(daily: DailyRow[], models: string[]): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of daily) {
    if (!map.has(row.day)) {
      const entry: Record<string, unknown> = { day: row.day };
      for (const m of models) entry[m] = 0;
      map.set(row.day, entry);
    }
    const entry = map.get(row.day)!;
    entry[row.model] = ((entry[row.model] as number) ?? 0) + row.cost;
  }
  return Array.from(map.values()).sort((a, b) => (a.day as string).localeCompare(b.day as string));
}

export function CostStacked() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<CostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/costs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CostsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load cost data: {error}</p>;
  }

  if (!data) {
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const models = data.models.map((m) => m.model);
  const chartData = pivotDailySeries(data.daily, models);
  const totalCost = data.models.reduce((s, m) => s + m.cost, 0);

  // 7-day window for metric card
  const last7 = chartData.slice(-7);
  const cost7d = last7.reduce((s, row) => {
    return s + models.reduce((ms, m) => ms + ((row[m] as number) ?? 0), 0);
  }, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text)]">Daily Cost by Model</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total Cost (all time)"
          value={fmtDollars(totalCost)}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        <MetricCard
          label="Last 7 days"
          value={fmtDollars(cost7d)}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>}
        />
        <MetricCard
          label="Models"
          value={models.length}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" /></svg>}
        />
        <MetricCard
          label="Days tracked"
          value={chartData.length}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
        />
      </div>

      {chartData.length > 0 && (
        <ChartCard title="Daily cost stacked by model (90 days)">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) => v.slice(5)} /* MM-DD */
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmtDollars(v)}
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
                formatter={(value: number, name: string) => [fmtDollars(value), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
              {models.map((m, i) => (
                <Bar
                  key={m}
                  dataKey={m}
                  stackId="cost"
                  fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                  radius={i === models.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}
