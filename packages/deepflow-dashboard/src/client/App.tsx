import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { UserFilter } from './components/UserFilter';
import { DashboardProvider, type DashboardMode } from './context/DashboardContext';
import { useTheme } from './hooks/useTheme';
import { CostOverview } from './views/CostOverview';
import { SessionList } from './views/SessionList';
import { CacheEfficiency } from './views/CacheEfficiency';
import { ActivityHeatmap } from './views/ActivityHeatmap';
import { ModelDonut } from './views/ModelDonut';
import { CostStacked } from './views/CostStacked';
import { PeakHours } from './views/PeakHours';

/* ---------------------------------------------------------------------------
 * Placeholder for views not yet implemented (T17-T18).
 * --------------------------------------------------------------------------- */
function PlaceholderView({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center text-2xl font-light" style={{ color: 'var(--text-secondary)' }}>
      {name}
    </div>
  );
}

const OverviewView = () => <PlaceholderView name="Overview" />;
const TasksView = () => <PlaceholderView name="Tasks" />;

/* ---------------------------------------------------------------------------
 * Layout — sidebar + header + main content
 * --------------------------------------------------------------------------- */
function Layout() {
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header
          className="flex h-12 shrink-0 items-center justify-end gap-4 border-b px-4"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}
        >
          <UserFilter />
        </header>
        {/* Main */}
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route path="/" element={<OverviewView />} />
            <Route path="/sessions" element={<SessionList />} />
            <Route path="/tasks" element={<TasksView />} />
            <Route path="/costs" element={<CostOverview />} />
            <Route path="/cache" element={<CacheEfficiency />} />
            <Route path="/activity" element={<ActivityHeatmap />} />
            <Route path="/models" element={<ModelDonut />} />
            <Route path="/cost-stacked" element={<CostStacked />} />
            <Route path="/peak-hours" element={<PeakHours />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * App root — reads mode from window.__DASHBOARD_MODE__ injected by the server.
 * --------------------------------------------------------------------------- */
declare global {
  interface Window {
    __DASHBOARD_MODE__?: DashboardMode;
  }
}

export function App() {
  useTheme();

  const mode: DashboardMode =
    typeof window !== 'undefined' && window.__DASHBOARD_MODE__ === 'team'
      ? 'team'
      : 'local';

  return (
    <DashboardProvider mode={mode}>
      <BrowserRouter>
        <Layout />
      </BrowserRouter>
    </DashboardProvider>
  );
}
