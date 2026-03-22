import React, { useCallback, useContext, useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types from GET /api/sessions ---- */
interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  project: string | null;
  model: string;
  agent_role: string | null;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration_ms: number;
  cache_hit_ratio: number | null;
}

interface SessionsResponse {
  data: Session[];
  total: number;
  limit: number;
  offset: number;
}

type SortKey = 'started_at' | 'cost' | 'duration_ms' | 'tokens_in';

/* ---- Helpers ---- */
function fmtDollars(n: number) {
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtDuration(ms: number) {
  if (!ms) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

const PAGE_SIZE = 50;

/* ---- Component ---- */
export function SessionList() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortKey>('started_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(async () => {
    try {
      const offset = page * PAGE_SIZE;
      const res = await apiFetch(
        `/api/sessions?limit=${PAGE_SIZE}&offset=${offset}&sort=${sort}&order=${order}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SessionsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch, page, sort, order]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  const handleSort = (key: SortKey) => {
    if (key === sort) {
      setOrder((o) => (o === 'desc' ? 'asc' : 'desc'));
    } else {
      setSort(key);
      setOrder('desc');
    }
    setPage(0);
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (k !== sort) return <span style={{ opacity: 0.3 }}>↕</span>;
    return <span>{order === 'desc' ? '↓' : '↑'}</span>;
  };

  const ColHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      className="px-4 py-2 text-left font-medium cursor-pointer select-none whitespace-nowrap"
      style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
      onClick={() => handleSort(k)}
    >
      {label} <SortIcon k={k} />
    </th>
  );

  const StaticHeader = ({ label }: { label: string }) => (
    <th
      className="px-4 py-2 text-left font-medium whitespace-nowrap"
      style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}
    >
      {label}
    </th>
  );

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load sessions: {error}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>Sessions</h1>
        {data && (
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {data.total} total
          </span>
        )}
      </div>

      {!data ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Loading…</p>
      ) : (
        <>
          <div className="rounded-xl overflow-x-auto" style={{ border: '1px solid var(--border)' }}>
            <table className="w-full text-sm">
              <thead style={{ background: 'var(--bg-secondary)' }}>
                <tr>
                  <ColHeader label="Started" k="started_at" />
                  <StaticHeader label="Project" />
                  <StaticHeader label="Model" />
                  <StaticHeader label="Agent Role" />
                  <StaticHeader label="Cache Hit %" />
                  <ColHeader label="Duration" k="duration_ms" />
                  <ColHeader label="Total Tokens" k="tokens_in" />
                  <ColHeader label="Cost" k="cost" />
                </tr>
              </thead>
              <tbody>
                {data.data.map((s, i) => (
                  <tr
                    key={s.id}
                    style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--bg-secondary)' }}
                  >
                    <td className="px-4 py-2 whitespace-nowrap tabular-nums text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {fmtDate(s.started_at)}
                    </td>
                    <td className="px-4 py-2 max-w-[160px] truncate font-mono text-xs" style={{ color: 'var(--text)' }}>
                      {s.project ?? '—'}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs" style={{ color: 'var(--text)' }}>
                      {s.model}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs" style={{ color: 'var(--text)' }}>
                      {s.agent_role ?? '—'}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-center text-xs" style={{ color: 'var(--text)' }}>
                      {s.cache_hit_ratio != null ? `${(s.cache_hit_ratio * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-xs" style={{ color: 'var(--text)' }}>
                      {fmtDuration(s.duration_ms)}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-xs" style={{ color: 'var(--text)' }}>
                      {fmtTokens(s.tokens_in + s.tokens_out)}
                    </td>
                    <td className="px-4 py-2 tabular-nums font-medium text-xs" style={{ color: 'var(--text)' }}>
                      {fmtDollars(s.cost)}
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
                      No sessions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded px-3 py-1 disabled:opacity-40"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                >
                  ← Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded px-3 py-1 disabled:opacity-40"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
