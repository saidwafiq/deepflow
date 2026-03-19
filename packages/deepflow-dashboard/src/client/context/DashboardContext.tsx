import React, { createContext, useState, useCallback, type ReactNode } from 'react';

export type DashboardMode = 'local' | 'team';

export interface DashboardContextValue {
  mode: DashboardMode;
  selectedUser: string | null;
  setSelectedUser: (user: string | null) => void;
  /** Auto-refresh interval in milliseconds. 0 = disabled. */
  refreshInterval: number;
  setRefreshInterval: (ms: number) => void;
  /** Trigger a manual refresh; listeners call usePolling which handles timing. */
  refreshKey: number;
  refresh: () => void;
}

export const DashboardContext = createContext<DashboardContextValue>({
  mode: 'local',
  selectedUser: null,
  setSelectedUser: () => {},
  refreshInterval: 30_000,
  setRefreshInterval: () => {},
  refreshKey: 0,
  refresh: () => {},
});

interface DashboardProviderProps {
  mode: DashboardMode;
  children: ReactNode;
}

export function DashboardProvider({ mode, children }: DashboardProviderProps) {
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(30_000);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <DashboardContext.Provider
      value={{
        mode,
        selectedUser,
        setSelectedUser,
        refreshInterval,
        setRefreshInterval,
        refreshKey,
        refresh,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}
