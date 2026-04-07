import type { ReactNode } from 'react';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';

interface MetricCardProps {
  label: string;
  value: string | number;
  /** Optional sub-label shown below the value */
  sub?: string;
  /** Trend: positive = green, negative = red, 0/undefined = neutral */
  trend?: number;
  /** Optional icon element rendered in a 40x40 container */
  icon?: ReactNode;
  /** Optional sparkline data (array of numbers) rendered as a tiny AreaChart */
  sparkData?: number[];
}

export function MetricCard({ label, value, sub, trend, icon, sparkData }: MetricCardProps) {
  const trendBadge = (() => {
    if (trend === undefined) return null;
    if (trend > 0) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-success/10 text-success">
          ▲ {trend}%
        </span>
      );
    }
    if (trend < 0) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-danger/10 text-danger">
          ▼ {Math.abs(trend)}%
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-500">
        — 0%
      </span>
    );
  })();

  const chartData = sparkData?.map((v, i) => ({ i, v }));

  return (
    <div
      className="rounded-2xl p-6 shadow-card border border-[var(--border)] relative overflow-hidden bg-[var(--bg-card)]"
    >
      {/* Top row: icon left, trend badge right */}
      <div className="flex justify-between items-start">
        {icon ? (
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)' }}>
            {icon}
          </div>
        ) : (
          <div />
        )}
        {trendBadge}
      </div>

      {/* Value */}
      <p className="mt-3 text-3xl font-bold tabular-nums text-[var(--text)]">
        {value}
      </p>

      {/* Label */}
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        {label}
      </p>

      {/* Sub text */}
      {sub && (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {sub}
        </p>
      )}

      {/* Sparkline */}
      {chartData && chartData.length > 0 && (
        <div className="absolute bottom-0 right-0 w-20 h-8 pointer-events-none">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="sparkGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.1} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--accent)"
                strokeWidth={1.5}
                fill="url(#sparkGradient)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
