import { useCallback, useContext, useEffect, useState } from 'react';
import { MetricCard } from '../components/MetricCard';
import { ChartCard } from '../components/ChartCard';
import { LineChart } from '../components/charts/LineChart';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/cache ---- */
interface CacheSummary {
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  hit_ratio: number; // percentage, 2 decimal places
}

interface CacheDaily {
  day: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface CacheResponse {
  summary: CacheSummary;
  daily: CacheDaily[];
}

/* ---- Helpers ---- */
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const HIT_RATIO_LINE = [{ dataKey: 'hit_ratio', name: 'Cache Hit Ratio', color: '#10b981' }];

/* ---- Component ---- */
export function CacheEfficiency() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<CacheResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/cache');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CacheResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load cache data: {error}</p>;
  }

  if (!data) {
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const { summary, daily } = data;
  const totalTokens = summary.total_input + summary.total_output + summary.total_cache_read + summary.total_cache_creation;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text)]">Cache Efficiency</h1>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Hit Ratio"
          value={`${summary.hit_ratio.toFixed(2)}%`}
          sub="cache_read / (input + cache_read + cache_creation)"
          trend={summary.hit_ratio > 0 ? 1 : 0}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
        />
        <MetricCard
          label="Cache Read"
          value={fmtTokens(summary.total_cache_read)}
          sub="tokens served from cache"
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>}
        />
        <MetricCard
          label="Cache Creation"
          value={fmtTokens(summary.total_cache_creation)}
          sub="tokens written to cache"
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>}
        />
        <MetricCard
          label="Total Tokens"
          value={fmtTokens(totalTokens)}
          sub={`${fmtTokens(summary.total_input)} input / ${fmtTokens(summary.total_output)} output`}
          icon={<svg className="w-5 h-5 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>}
        />
      </div>

      {/* Daily trend — stacked area of input / cache_read / cache_creation */}
      {daily.length > 0 && (
        <ChartCard title="Daily token breakdown (30 days)">
          <LineChart
            data={daily as unknown as Record<string, unknown>[]}
            lines={HIT_RATIO_LINE}
            xKey="day"
            xTickFormatter={(v) => String(v).slice(5)}
            yTickFormatter={(v) => `${v}%`}
            tooltipFormatter={(value, name) => [`${value}%`, String(name)]}
            yDomain={[0, 100]}
            referenceLines={[{ y: 80, label: '80%', color: '#f59e0b' }]}
          />
        </ChartCard>
      )}

      {/* Cache read vs creation ratio bar */}
      {(summary.total_cache_read > 0 || summary.total_cache_creation > 0) && (() => {
        const total = summary.total_cache_read + summary.total_cache_creation;
        const readPct = total > 0 ? (summary.total_cache_read / total) * 100 : 0;
        return (
          <div
            className="rounded-xl p-4 space-y-2 bg-[var(--bg-card)] border border-[var(--border)]"
          >
            <p className="text-sm font-medium text-[var(--text-secondary)]">
              Cache read vs creation split
            </p>
            <div className="flex h-4 overflow-hidden rounded-full bg-[var(--bg-secondary)]">
              <div
                style={{ width: `${readPct}%`, background: '#10b981', transition: 'width 0.4s ease' }}
              />
              <div
                style={{ width: `${100 - readPct}%`, background: '#f59e0b', transition: 'width 0.4s ease' }}
              />
            </div>
            <div className="flex justify-between text-xs text-[var(--text-secondary)]">
              <span style={{ color: '#10b981' }}>Read {readPct.toFixed(1)}%</span>
              <span style={{ color: '#f59e0b' }}>Creation {(100 - readPct).toFixed(1)}%</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
