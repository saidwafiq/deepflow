import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { usePolling } from '../hooks/usePolling';
import { DashboardContext } from '../context/DashboardContext';

/* ---- Types ---- */
interface WindowRow {
  startedAt: string;
  endsAt: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  seven_day_sonnet_pct: number | null;
  extra_usage_pct: number | null;
  isActive: boolean;
  sevenDayEndsAt: string | null;
  cost: number;
}

interface WindowsResponse {
  data: WindowRow[];
}

interface SevenDayGroup {
  sevenDayEndsAt: string;
  startedAt: string;
  windows: WindowRow[];
  seven_day_pct: number | null;
  seven_day_sonnet_pct: number | null;
  extra_usage_pct: number | null;
  totalCost: number;
  isActive: boolean;
}

/* ---- Helpers ---- */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtCost(cost: number): string {
  if (!cost || cost < 0.001) return null as unknown as string;
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function clamp(v: number | null): number {
  if (v === null || v === undefined) return 0;
  return Math.max(0, Math.min(100, v));
}

/* ---- InlineBar ---- */
interface InlineBarProps {
  label: string;
  pct: number | null;
  color: string;
}

function InlineBar({ label, pct, color }: InlineBarProps) {
  const val = clamp(pct);
  const display = pct === null ? '–' : `${Math.round(val)}%`;

  return (
    <div className="flex items-center gap-1" style={{ minWidth: 0 }}>
      <span
        className="text-xs font-medium shrink-0 w-14 text-[var(--text-secondary)]"
      >
        {label}
      </span>
      <div
        className="relative rounded-full overflow-hidden shrink-0"
        style={{
          width: 64,
          height: 6,
          background: 'var(--bg)',
        }}
      >
        <div
          style={{
            width: `${val}%`,
            height: '100%',
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        className="text-xs tabular-nums shrink-0 w-10 text-[var(--text-secondary)]"
      >
        {display}
      </span>
    </div>
  );
}

/* ---- FiveHourCard ---- */
function FiveHourCard({ row }: { row: WindowRow }) {
  const cost = fmtCost(row.cost);
  return (
    <div
      className={`rounded-xl p-3 border ${row.isActive ? 'bg-[var(--bg-card)] border-[var(--accent)]' : 'bg-[var(--bg-secondary)] border-[var(--border)]'}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          {row.isActive && (
            <span
              className="text-xs font-semibold px-1.5 py-0.5 rounded bg-[var(--accent)] text-white leading-snug"
            >
              active
            </span>
          )}
          <span
            className={`text-xs font-mono ${row.isActive ? 'text-[var(--text)]' : 'text-[var(--text-secondary)]'}`}
          >
            {fmtDate(row.startedAt)} → {fmtDate(row.endsAt)}
          </span>
        </div>
        {cost && (
          <span className="text-xs font-mono tabular-nums text-[var(--text-secondary)]">
            {cost}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <InlineBar label="5h" pct={row.five_hour_pct} color="#6366f1" />
        <InlineBar label="7d" pct={row.seven_day_pct} color="#22c55e" />
        <InlineBar label="Sonnet" pct={row.seven_day_sonnet_pct} color="#f59e0b" />
        <InlineBar label="Extra" pct={row.extra_usage_pct} color="#ef4444" />
      </div>
    </div>
  );
}

/* ---- SevenDayCard ---- */
function SevenDayCard({ group }: { group: SevenDayGroup }) {
  const [expanded, setExpanded] = useState(group.isActive);
  const cost = fmtCost(group.totalCost);

  return (
    <div
      className={`rounded-xl p-3 border ${group.isActive ? 'bg-[var(--bg-card)] border-[var(--accent)]' : 'bg-[var(--bg-secondary)] border-[var(--border)]'}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          {group.isActive && (
            <span
              className="text-xs font-semibold px-1.5 py-0.5 rounded bg-[var(--accent)] text-white leading-snug"
            >
              active
            </span>
          )}
          <span
            className={`text-xs font-mono ${group.isActive ? 'text-[var(--text)]' : 'text-[var(--text-secondary)]'}`}
          >
            {fmtDate(group.startedAt)} → {fmtDate(group.sevenDayEndsAt)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {cost && (
            <span className="text-xs font-mono tabular-nums text-[var(--text-secondary)]">
              {cost}
            </span>
          )}
          <button
            className="text-xs text-[var(--text-secondary)]"
            onClick={() => setExpanded((v) => !v)}
          >
            {group.windows.length} × 5h {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <InlineBar label="7d" pct={group.seven_day_pct} color="#22c55e" />
        <InlineBar label="Sonnet" pct={group.seven_day_sonnet_pct} color="#f59e0b" />
        <InlineBar label="Extra" pct={group.extra_usage_pct} color="#ef4444" />
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {group.windows.map((w) => (
            <div
              key={w.startedAt}
              className="rounded-lg px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)]"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-[var(--text-secondary)]">
                  {fmtDate(w.startedAt)} → {fmtDate(w.endsAt)}
                </span>
                {fmtCost(w.cost) && (
                  <span className="text-xs tabular-nums text-[var(--text-secondary)]">
                    {fmtCost(w.cost)}
                  </span>
                )}
              </div>
              <InlineBar label="5h" pct={w.five_hour_pct} color="#6366f1" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Component ---- */
export function QuotaStatus() {
  const apiFetch = useApi();
  const { refreshInterval, refreshKey } = useContext(DashboardContext);
  const [data, setData] = useState<WindowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'5h' | '7d'>('5h');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quota/windows');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as WindowsResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiFetch]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  usePolling(load, refreshInterval);

  const sevenDayGroups = useMemo<SevenDayGroup[]>(() => {
    if (!data) return [];
    const map = new Map<string, WindowRow[]>();
    for (const row of data.data) {
      const key = row.sevenDayEndsAt ?? 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([key, windows]) => ({
        sevenDayEndsAt: key,
        startedAt: windows[windows.length - 1]?.startedAt ?? key,
        windows,
        seven_day_pct: windows[0]?.seven_day_pct ?? null,
        seven_day_sonnet_pct: windows[0]?.seven_day_sonnet_pct ?? null,
        extra_usage_pct: windows[0]?.extra_usage_pct ?? null,
        totalCost: windows.reduce((s, w) => s + w.cost, 0),
        isActive: windows.some((w) => w.isActive),
      }));
  }, [data]);

  if (error) {
    return <p className="text-sm" style={{ color: '#ef4444' }}>Failed to load quota data: {error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-[var(--text-secondary)]">Loading…</p>;
  }

  const rows = data.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--text)]">Quota Windows</h1>
        <div
          className="flex rounded-lg overflow-hidden border border-[var(--border)]"
        >
          {(['5h', '7d'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 text-sm font-medium cursor-pointer border-none ${view === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {view === '5h' && (
          <>
            {rows.map((row) => <FiveHourCard key={row.startedAt} row={row} />)}
            {rows.length === 0 && (
              <p className="text-sm text-[var(--text-secondary)]">No quota window data available.</p>
            )}
          </>
        )}

        {view === '7d' && (
          <>
            {sevenDayGroups.map((group) => (
              <SevenDayCard key={group.sevenDayEndsAt} group={group} />
            ))}
            {sevenDayGroups.length === 0 && (
              <p className="text-sm text-[var(--text-secondary)]">No quota window data available.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
