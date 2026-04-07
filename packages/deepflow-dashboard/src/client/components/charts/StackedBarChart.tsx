import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

export interface BarKey {
  dataKey: string;
  name?: string;
  color: string;
}

interface StackedBarChartProps {
  data: Record<string, unknown>[];
  bars: BarKey[];
  xKey?: string;
  xTickFormatter?: (v: unknown) => string;
  yTickFormatter?: (v: unknown) => string;
  tooltipFormatter?: (value: unknown, name: string) => [string, string];
  height?: number;
}

export function StackedBarChart({
  data,
  bars,
  xKey = 'day',
  xTickFormatter,
  yTickFormatter,
  tooltipFormatter,
  height = 260,
}: StackedBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
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
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--text)',
            fontSize: 12,
            boxShadow: '0px 8px 13px -3px rgba(0, 0, 0, 0.07)',
            padding: '8px 12px',
          }}
          cursor={{ fill: 'var(--border)', opacity: 0.4 }}
          formatter={tooltipFormatter as (value: number, name: string) => [string, string]}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
        {bars.map((b, i) => (
          <Bar
            key={b.dataKey}
            dataKey={b.dataKey}
            name={b.name ?? b.dataKey}
            stackId="1"
            fill={b.color}
            radius={i === bars.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
