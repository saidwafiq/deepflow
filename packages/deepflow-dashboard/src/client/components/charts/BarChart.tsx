import React from 'react';
import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

interface BarChartProps {
  data: Record<string, unknown>[];
  /** Key for the category axis (horizontal bar labels) */
  categoryKey?: string;
  /** Key for the value axis */
  valueKey?: string;
  /** Bar fill color — defaults to var(--accent) */
  color?: string;
  height?: number;
  /** Format value-axis tick labels */
  yTickFormatter?: (v: unknown) => string;
  /** Format tooltip values */
  tooltipFormatter?: (value: unknown) => [string, string];
  /** Highlight index (renders slightly lighter) */
  highlightIndex?: number;
}

export function BarChart({
  data,
  categoryKey = 'name',
  valueKey = 'value',
  color = 'var(--accent)',
  height = 260,
  yTickFormatter,
  tooltipFormatter,
}: BarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 24, left: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={yTickFormatter as ((v: unknown) => string) | undefined}
        />
        <YAxis
          type="category"
          dataKey={categoryKey}
          tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
          tickLine={false}
          axisLine={false}
          width={120}
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
          cursor={{ fill: 'var(--border)', opacity: 0.3 }}
        />
        <Bar dataKey={valueKey} radius={[0, 4, 4, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={color} fillOpacity={0.85} />
          ))}
        </Bar>
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
