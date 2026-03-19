import { useCallback, useContext } from 'react';
import { DashboardContext } from '../context/DashboardContext';

/**
 * Returns a fetch wrapper that automatically appends ?user=<selectedUser>
 * when in team mode and a user is selected.
 */
export function useApi() {
  const { mode, selectedUser } = useContext(DashboardContext);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      let url = path;
      if (mode === 'team' && selectedUser) {
        const separator = path.includes('?') ? '&' : '?';
        url = `${path}${separator}user=${encodeURIComponent(selectedUser)}`;
      }
      return fetch(url, init);
    },
    [mode, selectedUser],
  );

  return apiFetch;
}
