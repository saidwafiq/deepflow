import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

// Class constants for consumers to apply to their own thead/tr/th/td elements
export const tableHeaderClass =
  'sticky top-0 z-10 bg-gray-50 dark:bg-gray-800/50 text-xs uppercase tracking-wider text-[var(--text-secondary)]';

export const tableHeaderCellClass = 'px-6 py-3 font-medium';

export const tableCellClass = 'px-6 py-3 text-sm text-[var(--text)] tabular-nums';

export const tableRowClass =
  'border-t border-[var(--border)] hover:bg-[var(--bg-secondary)] transition-colors';

interface DataTableProps {
  children: ReactNode;
  className?: string;
}

export function DataTable({ children, className }: DataTableProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-card overflow-hidden',
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full">{children}</table>
      </div>
    </div>
  );
}
