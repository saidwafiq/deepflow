import React, { useCallback, useContext, useEffect, useState } from 'react';
import { MetricCard } from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types ---- */
interface TaskSummary {
  task_id: string;
  attempt_count: number;
  latest_status: string | null;
  total_cost: number;
  total_tokens: number;
  last_run_at: string | null;
}

interface SpecGroup {
  spec: string | null;
  total_cost: number;
  task_count: number;
  latest_status: string | null;
  last_run_at: string | null;
  tasks: TaskSummary[];
}

interface TasksResponse {
  data: SpecGroup[];
  total: number;
}

interface AttemptRow {
  id: number;
  task_id: string;
  spec: string | null;
  session_id: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cost: number;
  started_at: string | null;
  ended_at: string | null;
}

interface AttemptsResponse {
  data: AttemptRow[];
  total: number;
}

/* ---- Helpers ---- */
function fmtDollars(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_COLOR: Record<string, string> = {
  done: '#10b981',
  pass: '#10b981',
  doing: 'var(--accent)',
  failed: '#ef4444',
  fail: '#ef4444',
  planned: 'var(--text-secondary)',
};

function StatusBadge({ status }: { status: string | null }) {
  const s = status ?? 'unknown';
  return (
    <span
      className="rounded px-2 py-0.5 text-xs font-medium"
      style={{
        color: STATUS_COLOR[s] ?? 'var(--text-secondary)',
        background: 'var(--bg-card)',
        border: `1px solid ${STATUS_COLOR[s] ?? 'var(--border)'}`,
      }}
    >
      {s}
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        transition: 'transform 0.15s',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        color: 'var(--text-secondary)',
        fontSize: '0.75rem',
        marginRight: '0.4rem',
      }}
    >
      ▶
    </span>
  );
}

/* ---- Attempt list (lazy-loaded) ---- */
function AttemptList({ taskId }: { taskId: string }) {
  const apiFetch = useApi();
  const [data, setData] = useState<AttemptsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/attempts`)
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setData(json as AttemptsResponse); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [apiFetch, taskId]);

  if (error) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-2 text-xs" style={{ color: '#ef4444' }}>
          Failed to load attempts: {error}
        </td>
      </tr>
    );
  }
  if (!data) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Loading attempts…
        </td>
      </tr>
    );
  }

  if (data.data.length === 0) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          No attempts recorded.
        </td>
      </tr>
    );
  }

  return (
    <>
      {data.data.map((a) => (
        <tr
          key={a.id}
          style={{ background: 'var(--bg)' }}
        >
          {/* indent spacer */}
          <td className="px-4 py-1.5" style={{ width: '2.5rem' }} />
          <td className="px-4 py-1.5" style={{ width: '2.5rem' }} />
          <td className="px-4 py-1.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
            {fmtTime(a.ended_at ?? a.started_at)}
          </td>
          <td className="px-4 py-1.5">
            <StatusBadge status={a.status} />
          </td>
          <td className="px-4 py-1.5 tabular-nums text-xs" style={{ color: 'var(--text)' }}>
            {fmtTokens((a.tokens_in ?? 0) + (a.tokens_out ?? 0) + (a.cache_read ?? 0))}
          </td>
          <td className="px-4 py-1.5 tabular-nums text-xs font-medium" style={{ color: 'var(--text)' }}>
            {fmtDollars(a.cost ?? 0)}
          </td>
        </tr>
      ))}
    </>
  );
}

/* ---- Task row (expandable to attempts) ---- */
function TaskRow({ task }: { task: TaskSummary }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'var(--bg-secondary)',
          cursor: 'pointer',
        }}
        className="hover-row"
      >
        {/* indent spacer */}
        <td className="px-4 py-2" style={{ width: '2.5rem' }} />
        <td className="px-4 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <ChevronIcon open={open} />
          <span className="font-mono text-xs">{task.task_id}</span>
        </td>
        <td className="px-4 py-2 tabular-nums text-xs" style={{ color: 'var(--text-secondary)' }}>
          {fmtTime(task.last_run_at)}
        </td>
        <td className="px-4 py-2">
          <StatusBadge status={task.latest_status} />
        </td>
        <td className="px-4 py-2 tabular-nums text-xs" style={{ color: 'var(--text)' }}>
          {fmtTokens(task.total_tokens ?? 0)}
          <span style={{ color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>
            · {task.attempt_count} run{task.attempt_count !== 1 ? 's' : ''}
          </span>
        </td>
        <td className="px-4 py-2 tabular-nums text-xs font-medium" style={{ color: 'var(--text)' }}>
          {fmtDollars(task.total_cost ?? 0)}
        </td>
      </tr>
      {open && <AttemptList taskId={task.task_id} />}
    </>
  );
}

/* ---- Spec row (expandable to tasks) ---- */
function SpecRow({ group }: { group: SpecGroup }) {
  const [open, setOpen] = useState(false);
  const specLabel = group.spec ?? '(no spec)';

  return (
    <>
      <tr
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'var(--bg-card)',
          cursor: 'pointer',
          borderTop: '1px solid var(--border)',
        }}
        className="hover-row"
      >
        <td className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--text)' }}>
          <ChevronIcon open={open} />
          {specLabel}
        </td>
        <td className="px-4 py-2.5 tabular-nums text-xs" style={{ color: 'var(--text-secondary)' }}>
          {group.task_count} task{group.task_count !== 1 ? 's' : ''}
        </td>
        <td className="px-4 py-2.5 tabular-nums text-xs" style={{ color: 'var(--text-secondary)' }}>
          {fmtTime(group.last_run_at)}
        </td>
        <td className="px-4 py-2.5">
          <StatusBadge status={group.latest_status} />
        </td>
        <td className="px-4 py-2.5" />
        <td className="px-4 py-2.5 tabular-nums text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {fmtDollars(group.total_cost ?? 0)}
        </td>
      </tr>
      {open && group.tasks.map((t) => <TaskRow key={t.task_id} task={t} />)}
    </>
  );
}

/* ---- Main component ---- */
export function TaskTracking() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load tasks: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</p>;
  }

  const specs = data.data;
  const totalCost = specs.reduce((s, g) => s + (g.total_cost ?? 0), 0);
  const totalTasks = specs.reduce((s, g) => s + g.task_count, 0);
  const doneTasks = specs.reduce(
    (s, g) => s + g.tasks.filter((t) => t.latest_status === 'done' || t.latest_status === 'pass').length,
    0,
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Task Tracking</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Specs" value={specs.length} />
        <MetricCard label="Total Tasks" value={totalTasks} />
        <MetricCard label="Completed" value={doneTasks} />
        <MetricCard label="Total Cost" value={fmtDollars(totalCost)} />
      </div>

      {/* Accordion table */}
      {specs.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--bg-secondary)' }}>
              <tr>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
                >
                  Spec / Task
                </th>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
                >
                  Tasks / Runs
                </th>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
                >
                  Last Run
                </th>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
                >
                  Status
                </th>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
                >
                  Tokens
                </th>
                <th
                  className="px-4 py-2 text-left font-medium"
                  style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
                >
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {specs.map((g) => (
                <SpecRow key={g.spec ?? '__null__'} group={g} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {specs.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>No tasks recorded yet.</p>
      )}
    </div>
  );
}
