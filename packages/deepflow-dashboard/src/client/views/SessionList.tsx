import { useCallback, useContext, useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';

/* ---- Types ---- */
interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  project: string | null;
  model: string;
  agent_role: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_creation: number;
  cost: number;
  total_cost: number;
  duration_ms: number;
  cache_hit_ratio: number | null;
  subagent_count: number;
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

/* ---- Column layout (shared between header, rows, and sub-rows) ---- */
const COL_CLS = [
  'w-36 shrink-0',        // Started
  'flex-1 min-w-0',       // Project
  'w-32 shrink-0',        // Model
  'w-24 shrink-0',        // Agent Role
  'w-20 shrink-0 text-center', // Cache Hit %
  'w-20 shrink-0 text-right',  // Duration
  'w-20 shrink-0 text-right',  // Tokens
  'w-20 shrink-0 text-right',  // Cost
];

function ColVal({ idx, children }: { idx: number; children: React.ReactNode }) {
  return <span className={`${COL_CLS[idx]} text-xs`}>{children}</span>;
}

/* ---- Subagent rows (lazy loaded) ---- */
function SubagentRows({ parentId, apiFetch }: { parentId: string; apiFetch: ReturnType<typeof useApi> }) {
  const [rows, setRows] = useState<Session[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/sessions/${encodeURIComponent(parentId)}/subagents`)
      .then((r) => r.json())
      .then((j: { data: Session[] }) => { setRows(j.data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [parentId, apiFetch]);

  if (loading) {
    return (
      <div className="px-8 py-2 text-xs text-[var(--text-secondary)]">Loading subagents…</div>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="px-8 py-2 text-xs text-[var(--text-secondary)]">No subagents found.</div>
    );
  }

  return (
    <div className="pl-8 pr-2 pb-2 bg-[var(--bg-secondary)]">
      <div
        className="rounded-lg overflow-hidden border border-[var(--border)]"
      >
        {/* Sub-header */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-[var(--bg-card)] border-b border-[var(--border)] text-[var(--text-secondary)]"
        >
          <span className={COL_CLS[0]}>Started</span>
          <span className={COL_CLS[2]}>Model</span>
          <span className={COL_CLS[3]}>Role</span>
          <span className={COL_CLS[5]}>Duration</span>
          <span className={COL_CLS[6]}>Tokens</span>
          <span className={COL_CLS[7]}>Cost</span>
        </div>
        {rows.map((s, i) => (
          <div
            key={s.id}
            className={`flex items-center gap-2 px-3 py-1.5 ${i % 2 === 0 ? 'bg-[var(--bg)]' : 'bg-[var(--bg-secondary)]'} ${i < rows.length - 1 ? 'border-b border-[var(--border)]' : ''}`}
          >
            <span className={`${COL_CLS[0]} text-xs tabular-nums text-[var(--text-secondary)]`}>
              {fmtDate(s.started_at)}
            </span>
            <span className={`${COL_CLS[2]} text-xs text-[var(--text)]`}>
              {s.model}
            </span>
            <span className={`${COL_CLS[3]} text-xs text-[var(--text)]`}>
              {s.agent_role ?? '—'}
            </span>
            <span className={`${COL_CLS[5]} text-xs tabular-nums text-[var(--text)]`}>
              {fmtDuration(s.duration_ms)}
            </span>
            <span className={`${COL_CLS[6]} text-xs tabular-nums text-[var(--text)]`}>
              {fmtTokens(s.tokens_in + s.tokens_out + (s.cache_read ?? 0) + (s.cache_creation ?? 0))}
            </span>
            <span className={`${COL_CLS[7]} text-xs tabular-nums font-medium text-[var(--text)]`}>
              {fmtDollars(s.cost)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- Single session row with optional accordion ---- */
function SessionRow({ session, apiFetch, stripe }: { session: Session; apiFetch: ReturnType<typeof useApi>; stripe: boolean }) {
  const hasSubagents = session.subagent_count > 0;

  const rowContent = (
    <div
      className={`flex items-center gap-2 px-4 py-2 w-full text-left ${stripe ? 'bg-[var(--bg-secondary)]' : 'bg-[var(--bg)]'}`}
    >
      <ColVal idx={0}>
        <span className="tabular-nums text-[var(--text-secondary)]">{fmtDate(session.started_at)}</span>
      </ColVal>
      <ColVal idx={1}>
        <span className="truncate block font-mono text-[var(--text)]">{session.project ?? '—'}</span>
      </ColVal>
      <ColVal idx={2}>
        <span className="text-[var(--text)]">{session.model}</span>
      </ColVal>
      <ColVal idx={3}>
        <span className="text-[var(--text)]">{session.agent_role ?? '—'}</span>
      </ColVal>
      <ColVal idx={4}>
        <span className="text-[var(--text)]">
          {session.cache_hit_ratio != null ? `${(session.cache_hit_ratio * 100).toFixed(1)}%` : '—'}
        </span>
      </ColVal>
      <ColVal idx={5}>
        <span className="tabular-nums text-[var(--text)]">{fmtDuration(session.duration_ms)}</span>
      </ColVal>
      <ColVal idx={6}>
        <span className="tabular-nums text-[var(--text)]">
          {fmtTokens(session.tokens_in + session.tokens_out + (session.cache_read ?? 0) + (session.cache_creation ?? 0))}
        </span>
      </ColVal>
      <ColVal idx={7}>
        <span
          className="tabular-nums font-medium text-[var(--text)]"
          title={session.subagent_count > 0 ? `Session: ${fmtDollars(session.cost)} + subagents: ${fmtDollars(session.total_cost - session.cost)}` : undefined}
        >
          {fmtDollars(session.total_cost)}
        </span>
      </ColVal>
      {hasSubagents && (
        <span
          className="ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0 bg-[var(--accent)] text-white"
        >
          {session.subagent_count}
        </span>
      )}
    </div>
  );

  if (!hasSubagents) {
    return (
      <div className="border-b border-[var(--border)]">
        {rowContent}
      </div>
    );
  }

  return (
    <AccordionItem value={session.id} className="border-0 border-b border-[var(--border)]">
      <AccordionTrigger className="hover:no-underline p-0">
        {rowContent}
      </AccordionTrigger>
      <AccordionContent>
        <SubagentRows parentId={session.id} apiFetch={apiFetch} />
      </AccordionContent>
    </AccordionItem>
  );
}

/* ---- Main component ---- */
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

  const ColHeader = ({ label, k, cls }: { label: string; k: SortKey; cls?: string }) => (
    <span
      className={`${cls ?? ''} text-xs font-medium cursor-pointer select-none whitespace-nowrap text-[var(--text-secondary)]`}
      onClick={() => handleSort(k)}
    >
      {label} <SortIcon k={k} />
    </span>
  );

  const StaticColHeader = ({ label, cls }: { label: string; cls?: string }) => (
    <span className={`${cls ?? ''} text-xs font-medium whitespace-nowrap text-[var(--text-secondary)]`}>
      {label}
    </span>
  );

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load sessions: {error}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--text)]">Sessions</h1>
        {data && (
          <span className="text-sm text-[var(--text-secondary)]">
            {data.total} total
          </span>
        )}
      </div>

      {!data ? (
        <p className="text-sm text-[var(--text-secondary)]">Loading…</p>
      ) : (
        <>
          <div className="rounded-xl overflow-hidden border border-[var(--border)]">
            {/* Header */}
            <div
              className="flex items-center gap-2 px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border)]"
            >
              <ColHeader label="Started" k="started_at" cls={COL_CLS[0]} />
              <StaticColHeader label="Project" cls={COL_CLS[1]} />
              <StaticColHeader label="Model" cls={COL_CLS[2]} />
              <StaticColHeader label="Agent Role" cls={COL_CLS[3]} />
              <StaticColHeader label="Cache Hit %" cls={COL_CLS[4]} />
              <ColHeader label="Duration" k="duration_ms" cls={COL_CLS[5]} />
              <ColHeader label="Tokens" k="tokens_in" cls={COL_CLS[6]} />
              <ColHeader label="Cost" k="cost" cls={COL_CLS[7]} />
            </div>

            {/* Rows */}
            <Accordion type="multiple">
              {data.data.map((s, i) => (
                <SessionRow key={s.id} session={s} apiFetch={apiFetch} stripe={i % 2 !== 0} />
              ))}
              {data.data.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
                  No sessions found.
                </div>
              )}
            </Accordion>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
              <span>Page {page + 1} of {totalPages}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded px-3 py-1 disabled:opacity-40 bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text)]"
                >
                  ← Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded px-3 py-1 disabled:opacity-40 bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text)]"
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
