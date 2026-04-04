import { useRef, useState } from 'react';

export interface HeatmapDay {
  day: string;        // ISO date YYYY-MM-DD
  count: number;      // session_count or any numeric intensity
}

interface HeatmapGridProps {
  data: HeatmapDay[];
  weeks?: number;
  /** Label shown in tooltip alongside count */
  countLabel?: string;
}

/* Map count → intensity bucket 0-4 */
function intensity(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0 || max === 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.15) return 1;
  if (ratio <= 0.40) return 2;
  if (ratio <= 0.70) return 3;
  return 4;
}

const LEVEL_COLORS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'var(--bg-secondary)',
  1: '#0e4429',
  2: '#006d32',
  3: '#26a641',
  4: '#39d353',
};

/** Build a 52×7 grid anchored to today */
function buildGrid(data: HeatmapDay[], weeks: number): { day: string | null; count: number }[][] {
  const today = new Date();
  // Align to end of week (Sunday = 0)
  const endOffset = today.getDay(); // days since last Sunday
  const end = new Date(today);
  end.setDate(end.getDate() - endOffset + 6); // end on coming Saturday

  // Build lookup
  const lookup = new Map<string, number>();
  for (const d of data) lookup.set(d.day, d.count);

  // cols = weeks (Sunday→Saturday), rows = day-of-week (0=Sun … 6=Sat)
  const cols: { day: string | null; count: number }[][] = [];

  for (let w = weeks - 1; w >= 0; w--) {
    const col: { day: string | null; count: number }[] = [];
    for (let dow = 0; dow <= 6; dow++) {
      const d = new Date(end);
      d.setDate(end.getDate() - w * 7 - (6 - dow));
      const iso = d.toISOString().slice(0, 10);
      // Only show days up to today
      if (d > today) {
        col.push({ day: null, count: 0 });
      } else {
        col.push({ day: iso, count: lookup.get(iso) ?? 0 });
      }
    }
    cols.push(col);
  }
  return cols;
}

/** Month labels for x-axis: find first col of each new month */
function monthLabels(cols: { day: string | null; count: number }[][]): { col: number; label: string }[] {
  const labels: { col: number; label: string }[] = [];
  let lastMonth = '';
  cols.forEach((col, ci) => {
    const day = col.find((c) => c.day)?.day;
    if (!day) return;
    const m = day.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      const [, month] = day.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      labels.push({ col: ci, label: months[parseInt(month, 10) - 1] });
    }
  });
  return labels;
}

const CELL = 12; // px per cell
const GAP = 2;   // px gap

export function HeatmapGrid({ data, weeks = 52, countLabel = 'sessions' }: HeatmapGridProps) {
  const max = data.reduce((m, d) => Math.max(m, d.count), 0);
  const cols = buildGrid(data, weeks);
  const labels = monthLabels(cols);

  const [tooltip, setTooltip] = useState<{ x: number; y: number; day: string; count: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const gridWidth = cols.length * (CELL + GAP);
  const gridHeight = 7 * (CELL + GAP);

  return (
    <div ref={containerRef} className="relative select-none overflow-x-auto">
      {/* Month labels */}
      <div className="relative mb-1" style={{ height: 14, width: gridWidth }}>
        {labels.map(({ col, label }) => (
          <span
            key={`${col}-${label}`}
            className="absolute text-xs text-[var(--text-secondary)]"
            style={{ left: col * (CELL + GAP), fontSize: 10 }}
          >
            {label}
          </span>
        ))}
      </div>

      {/* Grid */}
      <div style={{ display: 'flex', gap: GAP, width: gridWidth, height: gridHeight }}>
        {cols.map((col, ci) => (
          <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
            {col.map((cell, ri) => {
              const level = cell.day ? intensity(cell.count, max) : 0;
              return (
                <div
                  key={ri}
                  style={{
                    width: CELL,
                    height: CELL,
                    borderRadius: 2,
                    background: cell.day ? LEVEL_COLORS[level] : 'transparent',
                    cursor: cell.day ? 'pointer' : 'default',
                    transition: 'opacity 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    if (!cell.day) return;
                    const rect = (e.target as HTMLElement).getBoundingClientRect();
                    const parent = containerRef.current?.getBoundingClientRect();
                    setTooltip({
                      x: rect.left - (parent?.left ?? 0) + CELL / 2,
                      y: rect.top - (parent?.top ?? 0) - 8,
                      day: cell.day,
                      count: cell.count,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded px-2 py-1 text-xs shadow bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text)] whitespace-nowrap"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <span className="text-[var(--text-secondary)]">{tooltip.day}</span>
          {' — '}
          <strong>{tooltip.count}</strong> {countLabel}
        </div>
      )}

      {/* Legend */}
      <div className="mt-2 flex items-center gap-1">
        <span className="text-xs mr-1 text-[var(--text-secondary)]">Less</span>
        {([0, 1, 2, 3, 4] as const).map((l) => (
          <div
            key={l}
            style={{ width: CELL, height: CELL, borderRadius: 2, background: LEVEL_COLORS[l] }}
          />
        ))}
        <span className="text-xs ml-1 text-[var(--text-secondary)]">More</span>
      </div>
    </div>
  );
}
