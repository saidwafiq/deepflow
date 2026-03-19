import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

export interface AreaKey {
  dataKey: string;
  /** Display name shown in legend/tooltip */
  name?: string;
  color: string;
}

interface StackedAreaChartProps {
  data: Record<string, unknown>[];
  areas: AreaKey[];
  xKey?: string;
  /** Format tick labels on the x-axis */
  xTickFormatter?: (v: unknown) => string;
  /** Format y-axis tick labels */
  yTickFormatter?: (v: unknown) => string;
  /** Format tooltip values */
  tooltipFormatter?: (value: unknown, name: string) => [string, string];
  height?: number;
}

export function StackedAreaChart({
  data,
  areas,
  xKey = 'day',
  xTickFormatter,
  yTickFormatter,
  tooltipFormatter,
  height = 260,
}: StackedAreaChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <defs>
          {areas.map((a) => (
            <linearGradient key={a.dataKey} id={`grad-${a.dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={a.color} stopOpacity={0.35} />
              <stop offset="95%" stopColor={a.color} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey={xKey}
          tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={xTickFormatter as ((v: unknown) => string) | undefined}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={yTickFormatter as ((v: unknown) => string) | undefined}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--text)',
            fontSize: 12,
          }}
          formatter={tooltipFormatter as ((...args: unknown[]) => unknown) | undefined}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
        {areas.map((a) => (
          <Area
            key={a.dataKey}
            type="monotone"
            dataKey={a.dataKey}
            name={a.name ?? a.dataKey}
            stackId="1"
            stroke={a.color}
            fill={`url(#grad-${a.dataKey})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
