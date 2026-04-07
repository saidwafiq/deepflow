import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

export interface LineKey {
  dataKey: string;
  name?: string;
  color: string;
}

interface LineChartProps {
  data: Record<string, unknown>[];
  lines: LineKey[];
  xKey?: string;
  xTickFormatter?: (v: unknown) => string;
  yTickFormatter?: (v: unknown) => string;
  tooltipFormatter?: (value: unknown, name: string) => [string, string];
  referenceLines?: { y: number; label?: string; color?: string }[];
  height?: number;
  yDomain?: [number | 'auto', number | 'auto'];
}

export function LineChart({
  data,
  lines,
  xKey = 'day',
  xTickFormatter,
  yTickFormatter,
  tooltipFormatter,
  referenceLines,
  height = 260,
  yDomain,
}: LineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsLineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
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
          domain={yDomain}
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
          formatter={tooltipFormatter as (value: number, name: string) => [string, string]}
        />
        {referenceLines?.map((r) => (
          <ReferenceLine
            key={r.y}
            y={r.y}
            stroke={r.color ?? 'var(--text-secondary)'}
            strokeDasharray="4 2"
            label={{ value: r.label, fill: 'var(--text-secondary)', fontSize: 10 }}
          />
        ))}
        {lines.map((l) => (
          <Line
            key={l.dataKey}
            type="monotone"
            dataKey={l.dataKey}
            name={l.name ?? l.dataKey}
            stroke={l.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--bg-card)', fill: l.color }}
            connectNulls={false}
          />
        ))}
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
