import { useCallback, useContext, useEffect, useState } from 'react';
import { MetricCard } from '../components/MetricCard';
import { StackedBarChart, type BarKey } from '../components/charts/StackedBarChart';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/costs ---- */
interface ModelCost {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost: number;
}

interface DailyRow {
  day: string;
  model: string;
  cost: number;
}

interface ProjectRow {
  project: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  sessions: number;
}

interface AgentRoleRow {
  agent_role: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface AgentRoleModelRow {
  agent_role: string;
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface CostsResponse {
  models: ModelCost[];
  daily: DailyRow[];
  projects: ProjectRow[];
  by_agent_role: AgentRoleRow[];
  by_agent_role_model: AgentRoleModelRow[];
}

/* ---- Helpers ---- */
const MODEL_COLORS = [
  'var(--accent)',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
];

function fmt$$(n: number) {
  return `$${n.toFixed(4)}`;
}

function fmtDollars(n: number) {
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Pivot daily rows into {day, [model]: cost, …}[] for the chart */
function pivotDailySeries(daily: DailyRow[], models: string[]): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of daily) {
    if (!map.has(row.day)) {
      const entry: Record<string, unknown> = { day: row.day };
      for (const m of models) entry[m] = 0;
      map.set(row.day, entry);
    }
    const entry = map.get(row.day)!;
    entry[row.model] = (entry[row.model] as number ?? 0) + row.cost;
  }
  return Array.from(map.values()).sort((a, b) => (a.day as string).localeCompare(b.day as string));
}

/* ---- Component ---- */
export function CostOverview() {
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

  // Initial + refreshKey-triggered load
  useEffect(() => { void load(); }, [load, refreshKey]);
  // Interval polling
  usePolling(load, refreshInterval);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load cost data: {error}</p>;
  }

  if (!data) {
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const totalCost = data.models.reduce((s, m) => s + m.cost, 0);
  const totalTokens = data.models.reduce((s, m) => s + m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens, 0);
  const models = data.models.map((m) => m.model);
  const bars: BarKey[] = models.map((m, i) => ({
    dataKey: m,
    name: m,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));
  const chartData = pivotDailySeries(data.daily, models);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text)]">Cost Overview</h1>

      {/* Per-model metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Total Cost"
          value={fmtDollars(totalCost)}
          sub={`${fmtTokens(totalTokens)} tokens`}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        {data.models.map((m) => (
          <MetricCard
            key={m.model}
            label={m.model}
            value={fmtDollars(m.cost)}
            sub={`${fmtTokens(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens)} tokens`}
            icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" /></svg>}
          />
        ))}
      </div>

      {/* Stacked bar chart — daily cost per model */}
      {chartData.length > 0 && (
        <div
          className="rounded-xl p-4 bg-[var(--bg-card)] border border-[var(--border)]"
        >
          <p className="mb-3 text-sm font-medium text-[var(--text-secondary)]">
            Daily cost by model (90 days)
          </p>
          <StackedBarChart
            data={chartData}
            bars={bars}
            xTickFormatter={(v) => String(v).slice(5)}
            yTickFormatter={(v) => fmt$$(v as number)}
            tooltipFormatter={(value, name) => [fmtDollars(value as number), String(name)]}
          />
        </div>
      )}

      {/* Agent role cost breakdown — MetricCards */}
      {data.by_agent_role && data.by_agent_role.length > 0 && (
        <div>
          <p className="mb-3 text-sm font-medium text-[var(--text-secondary)]">
            Cost by agent role
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {data.by_agent_role.map((r) => (
              <MetricCard
                key={r.agent_role}
                label={r.agent_role}
                value={fmtDollars(r.cost)}
                sub={`${fmtTokens(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens)} tokens`}
                icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}
              />
            ))}
          </div>
        </div>
      )}

      {/* Agent role × model breakdown table */}
      {data.by_agent_role_model && data.by_agent_role_model.length > 0 && (
        <div
          className="rounded-xl overflow-hidden border border-[var(--border)]"
        >
          <p
            className="px-4 py-2 text-sm font-medium bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-b border-[var(--border)]"
          >
            Cost by agent role × model
          </p>
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-secondary)]">
              <tr>
                {['Agent Role', 'Model', 'Cost', 'Tokens In', 'Tokens Out', 'Cache Read', 'Cache Creation'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left font-medium text-[var(--text-secondary)] border-b border-[var(--border)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.by_agent_role_model.map((r, i) => (
                <tr
                  key={`${r.agent_role}|${r.model}`}
                  className={i % 2 === 0 ? 'bg-[var(--bg)]' : 'bg-[var(--bg-secondary)]'}
                >
                  <td className="px-4 py-2 font-mono text-xs text-[var(--text)]">{r.agent_role}</td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--text)]">{r.model}</td>
                  <td className="px-4 py-2 tabular-nums font-medium text-[var(--text)]">{fmtDollars(r.cost)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(r.input_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(r.output_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(r.cache_read_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(r.cache_creation_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-project breakdown table */}
      {data.projects.length > 0 && (
        <div
          className="rounded-xl overflow-hidden border border-[var(--border)]"
        >
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-secondary)]">
              <tr>
                {['Project', 'Sessions', 'Tokens In', 'Tokens Out', 'Cache Read', 'Cache Creation', 'Cost'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left font-medium text-[var(--text-secondary)] border-b border-[var(--border)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p, i) => (
                <tr
                  key={p.project}
                  className={i % 2 === 0 ? 'bg-[var(--bg)]' : 'bg-[var(--bg-secondary)]'}
                >
                  <td className="px-4 py-2 font-mono text-xs text-[var(--text)]">{p.project}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{p.sessions}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(p.tokens_in)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(p.tokens_out)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(p.cache_read_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(p.cache_creation_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums font-medium text-[var(--text)]">{fmtDollars(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
