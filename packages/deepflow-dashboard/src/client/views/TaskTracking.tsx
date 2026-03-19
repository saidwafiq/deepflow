import React, { useCallback, useContext, useEffect, useState } from 'react';
import { MetricCard } from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/tasks ---- */
interface TaskRow {
  task_id: string;
  spec: string | null;
  status: string;
  cost: number;
  execution_count: number;
}

interface TasksResponse {
  tasks: TaskRow[];
}

/* ---- Helpers ---- */
type SortKey = keyof TaskRow;

function fmtDollars(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** Sort indicator arrow */
function Arrow({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (!active) return <span style={{ color: 'var(--border)' }}> ↕</span>;
  return <span>{dir === 'asc' ? ' ▲' : ' ▼'}</span>;
}

const STATUS_COLOR: Record<string, string> = {
  done: '#10b981',
  doing: 'var(--accent)',
  failed: '#ef4444',
  planned: 'var(--text-secondary)',
};

/* ---- Component ---- */
export function TaskTracking() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('cost');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/tasks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TasksResponse;
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
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load tasks: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</p>;
  }

  const tasks = data.tasks;
  const totalCost = tasks.reduce((s, t) => s + t.cost, 0);
  const totalExecutions = tasks.reduce((s, t) => s + t.execution_count, 0);
  const doneTasks = tasks.filter((t) => t.status === 'done').length;

  const sorted = [...tasks].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const headers: { key: SortKey; label: string }[] = [
    { key: 'task_id', label: 'Task ID' },
    { key: 'spec', label: 'Spec' },
    { key: 'status', label: 'Status' },
    { key: 'execution_count', label: 'Executions' },
    { key: 'cost', label: 'Cost' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Task Tracking</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Total Tasks" value={tasks.length} />
        <MetricCard label="Completed" value={doneTasks} />
        <MetricCard label="Total Executions" value={totalExecutions} />
        <MetricCard label="Total Cost" value={fmtDollars(totalCost)} />
      </div>

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
                  key={t.task_id}
                  style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg-secondary)' }}
                >
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--text)' }}>
                    {t.task_id}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {t.spec ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className="rounded px-2 py-0.5 text-xs font-medium"
                      style={{
                        color: STATUS_COLOR[t.status] ?? 'var(--text-secondary)',
                        background: 'var(--bg-card)',
                        border: `1px solid ${STATUS_COLOR[t.status] ?? 'var(--border)'}`,
                      }}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 tabular-nums" style={{ color: 'var(--text)' }}>
                    {t.execution_count}
                  </td>
                  <td className="px-4 py-2 tabular-nums font-medium" style={{ color: 'var(--text)' }}>
                    {fmtDollars(t.cost)}
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
