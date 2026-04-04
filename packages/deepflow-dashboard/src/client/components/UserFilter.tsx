import React, { useContext, useEffect, useState } from 'react';
import { DashboardContext } from '../context/DashboardContext';
import { cn } from '../lib/utils';

/**
 * Dropdown for filtering by user in team mode.
 * Fetches the user list from GET /api/users and renders a <select>.
 * Hidden in local mode.
 */
export function UserFilter() {
  const { mode, selectedUser, setSelectedUser } = useContext(DashboardContext);
  const [users, setUsers] = useState<string[]>([]);

  useEffect(() => {
    if (mode !== 'team') return;
    fetch('/api/users')
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setUsers(data as string[]);
      })
      .catch(() => {});
  }, [mode]);

  if (mode !== 'team') return null;

  return (
    <div className={cn('flex items-center gap-2')}>
      <label
        htmlFor="user-filter"
        className="text-sm font-medium text-[var(--text-secondary)]"
      >
        User
      </label>
      <select
        id="user-filter"
        value={selectedUser ?? ''}
        onChange={(e) => setSelectedUser(e.target.value || null)}
        className={cn(
          'rounded border px-2 py-1 text-sm',
          'bg-[var(--bg-card)] text-[var(--text)] border-[var(--border)]',
          'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
        )}
      >
        <option value="">All users</option>
        {users.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </div>
  );
}
