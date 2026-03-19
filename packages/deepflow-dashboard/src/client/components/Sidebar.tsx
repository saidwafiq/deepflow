import React from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../lib/utils';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', exact: true },
  { to: '/sessions', label: 'Sessions' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/quota', label: 'Quota' },
  { to: '/tools', label: 'Tokens by Tool' },
  { to: '/costs', label: 'Costs' },
  { to: '/cache', label: 'Cache' },
  { to: '/activity', label: 'Activity' },
  { to: '/models', label: 'Models' },
  { to: '/cost-stacked', label: 'Cost by Day' },
  { to: '/peak-hours', label: 'Peak Hours' },
];

export function Sidebar() {
  return (
    <aside
      className="flex h-full w-52 shrink-0 flex-col border-r"
      style={{
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
      }}
    >
      <div
        className="px-4 py-4 text-base font-semibold tracking-tight"
        style={{ color: 'var(--text)' }}
      >
        Deepflow
      </div>
      <nav className="flex flex-col gap-1 px-2">
        {NAV_ITEMS.map(({ to, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              cn(
                'rounded px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card)] hover:text-[var(--text)]',
              )
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
