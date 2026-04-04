import React, { useCallback, useContext, useEffect, useState } from 'react';
import { DonutChart, type DonutSlice } from '../components/charts/DonutChart';
import { MetricCard } from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';
import { cn } from '../lib/utils';

interface ModelCost {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost: number;
}

interface CostsResponse {
  models: ModelCost[];
  daily: unknown[];
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

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function ModelDonut() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<CostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');

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

  const { models } = data;
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  const totalTokens = models.reduce((s, m) => s + m.input_tokens + m.output_tokens, 0);

  const slices: DonutSlice[] = models.map((m) => ({
    name: m.model,
    value: metric === 'cost' ? m.cost : m.input_tokens + m.output_tokens,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--text)]">Model Distribution</h1>
        {/* Toggle cost vs tokens */}
        <div className="flex gap-1 rounded-lg p-1 bg-[var(--bg-secondary)] border border-[var(--border)]">
          {(['cost', 'tokens'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors capitalize',
                metric === m
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-transparent text-[var(--text-secondary)]',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Total Cost" value={fmtDollars(totalCost)} />
        <MetricCard label="Total Tokens" value={fmtTokens(totalTokens)} />
        <MetricCard label="Models" value={models.length} />
        <MetricCard
          label="Top Model"
          value={models[0]?.model ?? '—'}
          sub={models[0] ? fmtDollars(models[0].cost) : undefined}
        />
      </div>

      {slices.length > 0 && (
        <div
          className="rounded-xl p-4 bg-[var(--bg-card)] border border-[var(--border)]"
        >
          <p className="mb-3 text-sm font-medium text-[var(--text-secondary)]">
            {metric === 'cost' ? 'Cost' : 'Token'} distribution by model
          </p>
          <DonutChart
            data={slices}
            colors={MODEL_COLORS}
            tooltipFormatter={(v) =>
              metric === 'cost' ? fmtDollars(v) : fmtTokens(v)
            }
          />
        </div>
      )}

      {/* Per-model table */}
      {models.length > 0 && (
        <div
          className="rounded-xl overflow-hidden border border-[var(--border)]"
        >
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-secondary)]">
              <tr>
                {['Model', 'Input Tokens', 'Output Tokens', 'Cache Read', 'Cache Creation', 'Cost'].map((h) => (
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
              {models.map((m, i) => (
                <tr
                  key={m.model}
                  className={i % 2 === 0 ? 'bg-[var(--bg)]' : 'bg-[var(--bg-secondary)]'}
                >
                  <td className="px-4 py-2 font-mono text-xs text-[var(--text)]">{m.model}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(m.input_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(m.output_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(m.cache_read_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text)]">{fmtTokens(m.cache_creation_tokens)}</td>
                  <td className="px-4 py-2 tabular-nums font-medium text-[var(--text)]">{fmtDollars(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
