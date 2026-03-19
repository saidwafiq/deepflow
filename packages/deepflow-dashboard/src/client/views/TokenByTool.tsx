import React, { useCallback, useContext, useEffect, useState } from 'react';
import { BarChart } from '../components/charts/BarChart';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/tools ---- */
interface ToolRow {
  tool_name: string;
  call_count: number;
  total_tokens: number;
  avg_tokens: number;
  pct_of_total: number;
}

interface ToolsResponse {
  tools: ToolRow[];
}

/* ---- Helpers ---- */
type SortKey = keyof ToolRow;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function Arrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span style={{ color: 'var(--border)' }}> ↕</span>;
  return <span>{dir === 'asc' ? ' ▲' : ' ▼'}</span>;
}

/* ---- Component ---- */
export function TokenByTool() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('total_tokens');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/tools');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ToolsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load tool data: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</p>;
  }

  const tools = data.tools;

  const sorted = [...tools].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  // Build chart data sorted by total_tokens desc (top 15 for readability).
  const chartData = [...tools]
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 15)
    .map((t) => ({ name: t.tool_name, value: t.total_tokens }));

  const headers: { key: SortKey; label: string }[] = [
    { key: 'tool_name', label: 'Tool' },
    { key: 'call_count', label: 'Calls' },
    { key: 'total_tokens', label: 'Total Tokens' },
    { key: 'avg_tokens', label: 'Avg Tokens' },
    { key: 'pct_of_total', label: '% of Total' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Tokens by Tool</h1>

      {/* Bar chart */}
      {chartData.length > 0 && (
        <div
          className="rounded-xl p-4"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
        >
          <p className="mb-3 text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Total tokens per tool (top 15)
          </p>
          <BarChart
            data={chartData}
            categoryKey="name"
            valueKey="value"
            height={Math.max(200, chartData.length * 28)}
            yTickFormatter={(v) => fmtTokens(v as number)}
            tooltipFormatter={(v) => [fmtTokens(v as number), 'Tokens']}
          />
        </div>
      )}

      {/* Sortable table */}
      {sorted.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--bg-secondary)' }}>
              <tr>
                {headers.map(({ key, label }) => (
                  <th
                    key={key}
                    className="px-4 py-2 text-left font-medium cursor-pointer select-none"
                    style={{
                      color: 'var(--text-secondary)',
                      borderBottom: '1px solid var(--border)',
                    }}
                    onClick={() => handleSort(key)}
                  >
                    {label}
                    <Arrow active={sortKey === key} dir={sortDir} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => (
                <tr
                  key={t.tool_name}
                  style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg-secondary)' }}
                >
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--text)' }}>
                    {t.tool_name}
                  </td>
                  <td className="px-4 py-2 tabular-nums" style={{ color: 'var(--text)' }}>
                    {t.call_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2 tabular-nums" style={{ color: 'var(--text)' }}>
                    {fmtTokens(t.total_tokens)}
                  </td>
                  <td className="px-4 py-2 tabular-nums" style={{ color: 'var(--text)' }}>
                    {fmtTokens(t.avg_tokens)}
                  </td>
                  <td className="px-4 py-2 tabular-nums" style={{ color: 'var(--text)' }}>
                    {t.pct_of_total.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
