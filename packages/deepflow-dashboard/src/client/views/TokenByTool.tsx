import { useCallback, useContext, useEffect, useState } from 'react';
import { BarChart } from '../components/charts/BarChart';
import { ChartCard } from '../components/ChartCard';
import { DataTable, tableHeaderClass, tableHeaderCellClass, tableCellClass, tableRowClass } from '../components/DataTable';
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
  data: ToolRow[];
}

/* ---- Helpers ---- */
type SortKey = keyof ToolRow;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function Arrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span className="text-[var(--border)]"> ↕</span>;
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
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const tools = data.data;

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
      <h1 className="text-xl font-semibold text-[var(--text)]">Tokens by Tool</h1>

      {/* Bar chart */}
      {chartData.length > 0 && (
        <ChartCard title="Total tokens per tool (top 15)">
          <BarChart
            data={chartData}
            categoryKey="name"
            valueKey="value"
            height={Math.max(200, chartData.length * 28)}
            yTickFormatter={(v) => fmtTokens(v as number)}
            tooltipFormatter={(v) => [fmtTokens(v as number), 'Tokens']}
          />
        </ChartCard>
      )}

      {/* Sortable table */}
      {sorted.length > 0 && (
        <DataTable>
          <thead className={tableHeaderClass}>
            <tr>
              {headers.map(({ key, label }) => (
                <th
                  key={key}
                  className={tableHeaderCellClass + ' cursor-pointer select-none'}
                  onClick={() => handleSort(key)}
                >
                  {label}
                  <Arrow active={sortKey === key} dir={sortDir} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.tool_name} className={tableRowClass}>
                <td className={tableCellClass + ' font-mono text-xs'}>{t.tool_name}</td>
                <td className={tableCellClass}>{t.call_count.toLocaleString()}</td>
                <td className={tableCellClass}>{fmtTokens(t.total_tokens)}</td>
                <td className={tableCellClass}>{fmtTokens(t.avg_tokens)}</td>
                <td className={tableCellClass}>{t.pct_of_total.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
