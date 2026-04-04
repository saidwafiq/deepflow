import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, subtitle, children, className }: ChartCardProps) {
  return (
    <div
      className={cn(
        'rounded-2xl shadow-card bg-[var(--bg-card)] border border-[var(--border)] px-6 py-5',
        className
      )}
    >
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-[var(--text)]">{title}</h3>
        {subtitle && (
          <span className="text-sm text-[var(--text-secondary)]">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}
