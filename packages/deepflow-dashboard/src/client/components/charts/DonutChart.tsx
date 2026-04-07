import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

export interface DonutSlice {
  name: string;
  value: number;
}

interface DonutChartProps {
  data: DonutSlice[];
  colors: string[];
  /** Format the tooltip value */
  tooltipFormatter?: (value: number) => string;
  height?: number;
}

export function DonutChart({ data, colors, tooltipFormatter, height = 260 }: DonutChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
          dataKey="value"
        >
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i % colors.length]} />
          ))}
        </Pie>
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
          formatter={(value: number, name: string) => [
            tooltipFormatter ? tooltipFormatter(value) : value,
            name,
          ]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }}
          iconType="circle"
          iconSize={10}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
